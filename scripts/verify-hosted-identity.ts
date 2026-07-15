import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  AuthorizeHostedWorkspace,
  DisableHostedUser,
  FindOrProvisionHostedUser,
  HmacBrowserSessionTokenCodec,
  IssueBrowserSession,
  ProvisionHostedWorkspace,
  ReactivateWorkspaceMembership,
  ResolveBrowserSession,
  RevokeWorkspaceMembership,
  RotateBrowserSession,
} from "../packages/application/src/index.js";
import {
  createDatabase,
  PostgresIdentityUnitOfWork,
  type DatabaseConnection,
} from "../packages/database/src/index.js";

const sourceDatabaseUrl =
  process.env.DATABASE_URL ?? "postgres://schedule:schedule@127.0.0.1:5432/schedule";
const verificationDatabase = `schedule_identity_verify_${randomUUID().replaceAll("-", "")}`;
const verificationDatabasePattern = /^schedule_identity_verify_[a-f0-9]{32}$/u;
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function databaseUrlFor(databaseName: string): string {
  const url = new URL(sourceDatabaseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quotedVerificationDatabase(): string {
  if (!verificationDatabasePattern.test(verificationDatabase)) {
    throw new Error("Unsafe hosted-identity verification database identifier.");
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
          `Hosted-identity migration failed with exit code ${String(code)}${diagnostic === "" ? "" : `: ${diagnostic}`}`,
        ),
      );
    });
  });
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
    applicationName: "schedule-hosted-identity-verifier",
  });

  const unitOfWork = new PostgresIdentityUnitOfWork(connection);
  const findOrProvision = new FindOrProvisionHostedUser(unitOfWork);
  const concurrentProvisioning = await Promise.all(
    Array.from({ length: 12 }, async () =>
      findOrProvision.execute({ issuer: "https://identity.example/tenant", subject: "Subject-A" }),
    ),
  );
  const primaryUser = concurrentProvisioning[0]?.user;
  assert.ok(primaryUser);
  assert.equal(new Set(concurrentProvisioning.map((result) => result.user.id)).size, 1);
  assert.equal(new Set(concurrentProvisioning.map((result) => result.identity.id)).size, 1);
  assert.equal(concurrentProvisioning.filter((result) => result.created).length, 1);

  const distinctCase = await findOrProvision.execute({
    issuer: "https://identity.example/tenant",
    subject: "subject-a",
  });
  const distinctIssuer = await findOrProvision.execute({
    issuer: "https://Identity.Example/tenant",
    subject: "Subject-A",
  });
  assert.notEqual(distinctCase.user.id, primaryUser.id);
  assert.notEqual(distinctIssuer.user.id, primaryUser.id);
  await assert.rejects(
    findOrProvision.execute({ issuer: "\u{1f680}".repeat(500), subject: "x" }),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "external_identity.key_too_large",
  );

  const identityCounts = await connection.sql<
    { users: number; identities: number; orphans: number }[]
  >`
    select
      (select count(*)::integer from users) as users,
      (select count(*)::integer from external_identities) as identities,
      (
        select count(*)::integer
        from users as "user"
        where not exists (
          select 1 from external_identities as identity where identity.user_id = "user".id
        )
      ) as orphans
  `;
  assert.deepEqual(identityCounts[0], { users: 3, identities: 3, orphans: 0 });

  const tokenCodec = new HmacBrowserSessionTokenCodec("identity-verifier-pepper-material-32-bytes");
  const issueSession = new IssueBrowserSession(unitOfWork, tokenCodec);
  const resolveSession = new ResolveBrowserSession(unitOfWork, tokenCodec);
  const rotateSession = new RotateBrowserSession(unitOfWork, tokenCodec);
  const issued = await issueSession.execute({
    userId: primaryUser.id,
    idleTimeoutSeconds: 3_600,
    absoluteTtlSeconds: 86_400,
  });
  const persistedSecret = await connection.sql<
    { id: string; secretDigest: string; rowText: string }[]
  >`
    select id::text as id, secret_digest as "secretDigest", row_to_json(session)::text as "rowText"
    from browser_sessions as session
    where id = ${issued.token.selector}
  `;
  assert.equal(persistedSecret[0]?.id, issued.token.selector);
  assert.equal(persistedSecret[0]?.secretDigest.length, 64);
  assert.notEqual(persistedSecret[0]?.secretDigest, issued.token.secret);
  assert.doesNotMatch(persistedSecret[0]?.rowText ?? "", new RegExp(issued.token.secret, "u"));
  assert.equal((await resolveSession.execute(issued.token))?.userId, primaryUser.id);

  const rotations = await Promise.all([
    rotateSession.execute(issued.token),
    rotateSession.execute(issued.token),
  ]);
  const replacement = rotations.find((result) => result !== null);
  assert.ok(replacement);
  assert.equal(rotations.filter((result) => result !== null).length, 1);
  assert.equal(await resolveSession.execute(issued.token), null);
  assert.equal((await resolveSession.execute(replacement.token))?.userId, primaryUser.id);
  assert.equal(replacement.absoluteExpiresAt.getTime(), issued.absoluteExpiresAt.getTime());

  const provisionWorkspace = new ProvisionHostedWorkspace(unitOfWork);
  const hostedWorkspaces = [];
  for (let index = 1; index <= 21; index += 1) {
    hostedWorkspaces.push(
      await provisionWorkspace.execute({
        userId: primaryUser.id,
        name: `Hosted workspace ${index}`,
      }),
    );
  }
  assert.equal(hostedWorkspaces.length, 21);
  const firstWorkspace = hostedWorkspaces[0];
  assert.ok(firstWorkspace);
  await connection.sql`
    insert into work_items (id, workspace_id, title)
    values (${randomUUID()}, ${firstWorkspace.workspace.id}, 'User deletion preservation fixture')
  `;

  const revokeMembership = new RevokeWorkspaceMembership(unitOfWork);
  const reactivateMembership = new ReactivateWorkspaceMembership(unitOfWork);
  const authorizeWorkspace = new AuthorizeHostedWorkspace(unitOfWork);
  const activePrincipal = await resolveSession.execute(replacement.token);
  assert.ok(activePrincipal);
  assert.deepEqual(await authorizeWorkspace.execute(activePrincipal, firstWorkspace.workspace.id), {
    userId: primaryUser.id,
    sessionId: activePrincipal.sessionId,
    workspaceId: firstWorkspace.workspace.id,
  });
  const [authorizationRacingRevocation, revokedMembership] = await Promise.all([
    authorizeWorkspace.execute(activePrincipal, firstWorkspace.workspace.id),
    revokeMembership.execute(primaryUser.id, firstWorkspace.workspace.id),
  ]);
  assert.equal(revokedMembership.status, "revoked");
  assert.ok(
    authorizationRacingRevocation === null ||
      (authorizationRacingRevocation.userId === primaryUser.id &&
        authorizationRacingRevocation.sessionId === activePrincipal.sessionId &&
        authorizationRacingRevocation.workspaceId === firstWorkspace.workspace.id),
  );
  assert.equal(
    await authorizeWorkspace.execute(activePrincipal, firstWorkspace.workspace.id),
    null,
  );
  assert.equal((await resolveSession.execute(replacement.token))?.userId, primaryUser.id);
  assert.equal(
    (await reactivateMembership.execute(primaryUser.id, firstWorkspace.workspace.id)).status,
    "active",
  );
  assert.equal(
    (await authorizeWorkspace.execute(activePrincipal, firstWorkspace.workspace.id))?.workspaceId,
    firstWorkspace.workspace.id,
  );

  const raceUser = await findOrProvision.execute({
    issuer: "https://identity.example/tenant",
    subject: "disable-race-user",
  });
  const raceSession = await issueSession.execute({
    userId: raceUser.user.id,
    idleTimeoutSeconds: 3_600,
    absoluteTtlSeconds: 86_400,
  });
  await Promise.all([
    new DisableHostedUser(unitOfWork).execute(raceUser.user.id),
    ...Array.from({ length: 4 }, async () => resolveSession.execute(raceSession.token)),
    ...Array.from({ length: 4 }, async () => rotateSession.execute(raceSession.token)),
  ]);
  const [raceState] = await connection.sql<{ activeSessions: number; status: string }[]>`
    select
      (select count(*)::integer from browser_sessions where user_id = ${raceUser.user.id} and revoked_at is null) as "activeSessions",
      (select status::text from users where id = ${raceUser.user.id}) as status
  `;
  assert.deepEqual(raceState, { activeSessions: 0, status: "disabled" });

  const secondSession = await issueSession.execute({
    userId: primaryUser.id,
    idleTimeoutSeconds: 3_600,
    absoluteTtlSeconds: 86_400,
  });
  await new DisableHostedUser(unitOfWork).execute(primaryUser.id);
  assert.equal(await resolveSession.execute(replacement.token), null);
  assert.equal(await resolveSession.execute(secondSession.token), null);

  await connection.sql`delete from users where id = ${primaryUser.id}`;
  const preservation = await connection.sql<
    {
      identities: number;
      sessions: number;
      memberships: number;
      workspaces: number;
      workItems: number;
    }[]
  >`
    select
      (select count(*)::integer from external_identities where user_id = ${primaryUser.id}) as identities,
      (select count(*)::integer from browser_sessions where user_id = ${primaryUser.id}) as sessions,
      (select count(*)::integer from workspace_memberships where user_id = ${primaryUser.id}) as memberships,
      (select count(*)::integer from workspaces where id = any(${hostedWorkspaces.map(({ workspace }) => workspace.id)}::uuid[])) as workspaces,
      (select count(*)::integer from work_items where workspace_id = ${firstWorkspace.workspace.id}) as "workItems"
  `;
  assert.deepEqual(preservation[0], {
    identities: 0,
    sessions: 0,
    memberships: 0,
    workspaces: 21,
    workItems: 1,
  });

  console.log(
    `Hosted identity verification passed exact concurrent provisioning, bounded identity keys, digest-only sessions, rotation replay resistance, user-before-session lock ordering, binary membership authorization and post-revocation fencing, hosted workspace provisioning beyond the local cap, disable revocation, and user-deletion preservation in ${verificationDatabase}`,
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
