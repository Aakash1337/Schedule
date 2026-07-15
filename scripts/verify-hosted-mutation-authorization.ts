import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CreateHostedWorkItem,
  DisableHostedUser,
  FindOrProvisionHostedUser,
  HmacBrowserSessionTokenCodec,
  IssueBrowserSession,
  ProvisionHostedWorkspace,
  ReactivateWorkspaceMembership,
  RevokeBrowserSession,
  RevokeWorkspaceMembership,
  type HostedMutationTransactionContext,
  type HostedMutationUnitOfWork,
  type IdentityTransactionContext,
  type IdentityUnitOfWork,
  type WorkspaceMembershipRepository,
} from "../packages/application/src/index.js";
import {
  createDatabase,
  PostgresHostedMutationUnitOfWork,
  PostgresIdentityUnitOfWork,
  type DatabaseConnection,
} from "../packages/database/src/index.js";
import { browserSessionId, workItemId } from "../packages/domain/src/index.js";

const sourceDatabaseUrl =
  process.env.DATABASE_URL ?? "postgres://schedule:schedule@127.0.0.1:5432/schedule";
const verificationDatabase = `schedule_host_mut_verify_${randomUUID().replaceAll("-", "")}`;
const verificationDatabasePattern = /^schedule_host_mut_verify_[a-f0-9]{32}$/u;
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function databaseUrlFor(databaseName: string): string {
  const url = new URL(sourceDatabaseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quotedVerificationDatabase(): string {
  if (!verificationDatabasePattern.test(verificationDatabase)) {
    throw new Error("Unsafe hosted-mutation verification database identifier.");
  }
  return `"${verificationDatabase}"`;
}

async function applyCurrentMigrations(databaseUrl: string): Promise<void> {
  const executable =
    process.platform === "win32"
      ? (process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe")
      : "pnpm";
  const args =
    process.platform === "win32"
      ? ["/d", "/s", "/c", "pnpm.cmd", "--filter", "@schedule/database", "run", "db:migrate"]
      : ["--filter", "@schedule/database", "run", "db:migrate"];
  await new Promise<void>((resolve, reject) => {
    const output: Buffer[] = [];
    const child = spawn(executable, args, {
      cwd: repositoryRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl, NODE_ENV: "test" },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => output.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) return resolve();
      const diagnostic = Buffer.concat(output)
        .toString("utf8")
        .replaceAll(databaseUrl, "[DISPOSABLE_DATABASE_URL]")
        .trim();
      reject(
        new Error(
          `Hosted-mutation migration failed with exit code ${String(code)}${diagnostic === "" ? "" : `: ${diagnostic}`}`,
        ),
      );
    });
  });
}

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

async function remainsPending(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 100);
  });
  return !settled;
}

async function settlesWithin<Value>(
  promise: Promise<Value>,
  timeoutMilliseconds: number,
  failureMessage: string,
): Promise<Value> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(failureMessage)), timeoutMilliseconds);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function rejectsWithCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(
    promise,
    (error: unknown) =>
      typeof error === "object" && error !== null && "code" in error && error.code === code,
  );
}

function pausingAuthorizedUnitOfWork(
  delegate: HostedMutationUnitOfWork,
  acquired: Deferred,
  release: Deferred,
): HostedMutationUnitOfWork {
  let paused = false;
  return {
    run: (operation, options) =>
      delegate.run(async (context) => {
        const guardedContext: HostedMutationTransactionContext = {
          ...context,
          hostedMutationAuthorization: {
            reauthorizeForUpdate: async (authorization) => {
              const decision =
                await context.hostedMutationAuthorization.reauthorizeForUpdate(authorization);
              if (decision === "authorized" && !paused) {
                paused = true;
                acquired.resolve();
                await release.promise;
              }
              return decision;
            },
          },
        };
        return operation(guardedContext);
      }, options),
  };
}

function pausingMembershipUnitOfWork(
  delegate: IdentityUnitOfWork,
  acquired: Deferred,
  release: Deferred,
): IdentityUnitOfWork {
  let paused = false;
  return {
    run: (operation, options) =>
      delegate.run(async (context) => {
        const memberships: WorkspaceMembershipRepository = {
          findByUserAndWorkspace: (user, workspace) =>
            context.memberships.findByUserAndWorkspace(user, workspace),
          findByUserAndWorkspaceForUpdate: async (user, workspace) => {
            const membership = await context.memberships.findByUserAndWorkspaceForUpdate(
              user,
              workspace,
            );
            if (!paused) {
              paused = true;
              acquired.resolve();
              await release.promise;
            }
            return membership;
          },
          insert: (membership) => context.memberships.insert(membership),
          save: (membership, expectedVersion) =>
            context.memberships.save(membership, expectedVersion),
        };
        const guardedContext: IdentityTransactionContext = { ...context, memberships };
        return operation(guardedContext);
      }, options),
  };
}

const adminConnection = createDatabase(databaseUrlFor("postgres"), 1);
const disposableDatabaseUrl = databaseUrlFor(verificationDatabase);
let databaseCreated = false;
let connection: DatabaseConnection | null = null;

try {
  await adminConnection.sql.unsafe(`create database ${quotedVerificationDatabase()}`);
  databaseCreated = true;
  await applyCurrentMigrations(disposableDatabaseUrl);
  connection = createDatabase(disposableDatabaseUrl, 12, {
    applicationName: "schedule-hosted-mutation-verifier",
  });

  const identityUnitOfWork = new PostgresIdentityUnitOfWork(connection);
  const hostedMutationUnitOfWork = new PostgresHostedMutationUnitOfWork(connection);
  const tokenCodec = new HmacBrowserSessionTokenCodec(
    "hosted-mutation-verifier-pepper-material-32-bytes",
  );
  const findOrProvision = new FindOrProvisionHostedUser(identityUnitOfWork);
  const provisionWorkspace = new ProvisionHostedWorkspace(identityUnitOfWork);
  const issueSession = new IssueBrowserSession(identityUnitOfWork, tokenCodec);
  const revokeMembership = new RevokeWorkspaceMembership(identityUnitOfWork);
  const reactivateMembership = new ReactivateWorkspaceMembership(identityUnitOfWork);
  const createHostedWorkItem = new CreateHostedWorkItem(hostedMutationUnitOfWork, {
    now: () => new Date(),
  });

  const primary = await findOrProvision.execute({
    issuer: "https://identity.example/hosted-mutation",
    subject: "primary-user",
  });
  const primaryWorkspace = await provisionWorkspace.execute({
    userId: primary.user.id,
    name: "Primary hosted workspace",
  });
  const primarySession = await issueSession.execute({
    userId: primary.user.id,
    idleTimeoutSeconds: 3_600,
    absoluteTtlSeconds: 86_400,
  });
  const primaryAuthorization = Object.freeze({
    userId: primary.user.id,
    sessionId: browserSessionId(primarySession.token.selector),
    workspaceId: primaryWorkspace.workspace.id,
  });

  const first = await createHostedWorkItem.execute(primaryAuthorization, {
    title: "Transaction-authorized work item",
    priority: "high",
    planningDurationMinutes: 45,
  });
  assert.equal(first.workspaceId, primaryWorkspace.workspace.id);

  const secondary = await findOrProvision.execute({
    issuer: "https://identity.example/hosted-mutation",
    subject: "secondary-user",
  });
  const secondaryWorkspace = await provisionWorkspace.execute({
    userId: secondary.user.id,
    name: "Secondary hosted workspace",
  });
  const secondarySession = await issueSession.execute({
    userId: secondary.user.id,
    idleTimeoutSeconds: 3_600,
    absoluteTtlSeconds: 86_400,
  });
  await rejectsWithCode(
    createHostedWorkItem.execute(
      { ...primaryAuthorization, workspaceId: secondaryWorkspace.workspace.id },
      { title: "Cross-workspace primary" },
    ),
    "workspace.not_found",
  );
  await rejectsWithCode(
    createHostedWorkItem.execute(
      {
        userId: secondary.user.id,
        sessionId: browserSessionId(secondarySession.token.selector),
        workspaceId: primaryWorkspace.workspace.id,
      },
      { title: "Cross-workspace secondary" },
    ),
    "workspace.not_found",
  );
  await rejectsWithCode(
    createHostedWorkItem.execute(
      {
        ...primaryAuthorization,
        sessionId: browserSessionId(secondarySession.token.selector),
      },
      { title: "Mismatched session owner" },
    ),
    "hosted.authentication_failed",
  );

  await revokeMembership.execute(primary.user.id, primaryWorkspace.workspace.id);
  await rejectsWithCode(
    createHostedWorkItem.execute(primaryAuthorization, { title: "Revoked membership" }),
    "workspace.not_found",
  );
  await reactivateMembership.execute(primary.user.id, primaryWorkspace.workspace.id);

  const signedOutSession = await issueSession.execute({
    userId: primary.user.id,
    idleTimeoutSeconds: 3_600,
    absoluteTtlSeconds: 86_400,
  });
  const signedOutAuthorization = {
    ...primaryAuthorization,
    sessionId: browserSessionId(signedOutSession.token.selector),
  };
  await new RevokeBrowserSession(identityUnitOfWork, tokenCodec).execute(signedOutSession.token);
  await rejectsWithCode(
    createHostedWorkItem.execute(signedOutAuthorization, { title: "Signed-out session" }),
    "hosted.authentication_failed",
  );

  const disabled = await findOrProvision.execute({
    issuer: "https://identity.example/hosted-mutation",
    subject: "disabled-user",
  });
  const disabledWorkspace = await provisionWorkspace.execute({
    userId: disabled.user.id,
    name: "Disabled user workspace",
  });
  const disabledSession = await issueSession.execute({
    userId: disabled.user.id,
    idleTimeoutSeconds: 3_600,
    absoluteTtlSeconds: 86_400,
  });
  await new DisableHostedUser(identityUnitOfWork).execute(disabled.user.id);
  await rejectsWithCode(
    createHostedWorkItem.execute(
      {
        userId: disabled.user.id,
        sessionId: browserSessionId(disabledSession.token.selector),
        workspaceId: disabledWorkspace.workspace.id,
      },
      { title: "Disabled user" },
    ),
    "hosted.authentication_failed",
  );

  const expiredSession = await issueSession.execute({
    userId: primary.user.id,
    idleTimeoutSeconds: 3_600,
    absoluteTtlSeconds: 86_400,
  });
  await connection.sql`
    update browser_sessions
    set issued_at = clock_timestamp() - interval '5 hours',
        last_seen_at = clock_timestamp() - interval '4 hours',
        idle_expires_at = clock_timestamp() - interval '3 hours',
        absolute_expires_at = clock_timestamp() - interval '2 hours'
    where id = ${expiredSession.token.selector}
  `;
  await rejectsWithCode(
    createHostedWorkItem.execute(
      { ...primaryAuthorization, sessionId: browserSessionId(expiredSession.token.selector) },
      { title: "Expired session" },
    ),
    "hosted.authentication_failed",
  );

  const raceSession = await issueSession.execute({
    userId: primary.user.id,
    idleTimeoutSeconds: 3_600,
    absoluteTtlSeconds: 86_400,
  });
  const raceAuthorization = {
    ...primaryAuthorization,
    sessionId: browserSessionId(raceSession.token.selector),
  };
  const createAcquired = deferred();
  const releaseCreate = deferred();
  const firstRaceCreate = new CreateHostedWorkItem(
    pausingAuthorizedUnitOfWork(hostedMutationUnitOfWork, createAcquired, releaseCreate),
    { now: () => new Date() },
  ).execute(raceAuthorization, { title: "Create linearizes first" });
  await createAcquired.promise;
  const blockedRevocation = revokeMembership.execute(
    primary.user.id,
    primaryWorkspace.workspace.id,
  );
  assert.equal(await remainsPending(blockedRevocation), true);
  releaseCreate.resolve();
  const [raceCreated, raceRevoked] = await Promise.all([firstRaceCreate, blockedRevocation]);
  assert.equal(raceCreated.title, "Create linearizes first");
  assert.equal(raceRevoked.status, "revoked");

  await reactivateMembership.execute(primary.user.id, primaryWorkspace.workspace.id);
  const revocationAcquired = deferred();
  const releaseRevocation = deferred();
  const revocationFirst = new RevokeWorkspaceMembership(
    pausingMembershipUnitOfWork(identityUnitOfWork, revocationAcquired, releaseRevocation),
  ).execute(primary.user.id, primaryWorkspace.workspace.id);
  await revocationAcquired.promise;
  const deniedRaceCreate = createHostedWorkItem.execute(raceAuthorization, {
    title: "Revocation linearizes first",
  });
  assert.equal(await remainsPending(deniedRaceCreate), true);
  releaseRevocation.resolve();
  await revocationFirst;
  await rejectsWithCode(deniedRaceCreate, "workspace.not_found");

  await reactivateMembership.execute(primary.user.id, primaryWorkspace.workspace.id);
  const beforeRollback = await connection.sql<{ workItems: number; audits: number }[]>`
    select
      (select count(*)::integer from work_items where workspace_id = ${primaryWorkspace.workspace.id}) as "workItems",
      (select count(*)::integer from audit_events where workspace_id = ${primaryWorkspace.workspace.id}) as audits
  `;
  await rejectsWithCode(
    createHostedWorkItem.execute(raceAuthorization, {
      parentWorkItemId: workItemId(randomUUID()),
      title: "Rollback invalid parent",
    }),
    "work_item.not_found",
  );
  const afterRollback = await connection.sql<{ workItems: number; audits: number }[]>`
    select
      (select count(*)::integer from work_items where workspace_id = ${primaryWorkspace.workspace.id}) as "workItems",
      (select count(*)::integer from audit_events where workspace_id = ${primaryWorkspace.workspace.id}) as audits
  `;
  assert.deepEqual(afterRollback[0], beforeRollback[0]);
  const postRollbackRevocation = await settlesWithin(
    revokeMembership.execute(primary.user.id, primaryWorkspace.workspace.id),
    5_000,
    "The rolled-back hosted mutation did not release its authorization locks.",
  );
  assert.equal(postRollbackRevocation.status, "revoked");

  const crossTenantWrites = await connection.sql<{ count: number }[]>`
    select count(*)::integer as count
    from work_items
    where title in (
      'Cross-workspace primary',
      'Cross-workspace secondary',
      'Mismatched session owner',
      'Revoked membership',
      'Signed-out session',
      'Disabled user',
      'Expired session',
      'Revocation linearizes first',
      'Rollback invalid parent'
    )
  `;
  assert.equal(crossTenantWrites[0]?.count, 0);

  console.log(
    `Hosted mutation verification passed exact user/session/workspace/membership locking, cross-tenant denial, logout/disable/expiry fencing, both revocation linearizations, and rollback isolation in ${verificationDatabase}`,
  );
} finally {
  await connection?.close().catch(() => undefined);
  if (databaseCreated) {
    await adminConnection.sql`
      select pg_terminate_backend(pid)
      from pg_stat_activity
      where datname = ${verificationDatabase} and pid <> pg_backend_pid()
    `.catch(() => undefined);
    await adminConnection.sql.unsafe(`drop database if exists ${quotedVerificationDatabase()}`);
  }
  await adminConnection.close();
}
