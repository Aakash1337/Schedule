import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildApp } from "../apps/api/src/app.js";
import { createIntegrationServices } from "../apps/api/src/integration-services.js";
import { createProductServices } from "../apps/api/src/product-services.js";
import {
  ProvisionIntegrationCredential,
  type IntegrationCredentialScope,
} from "../packages/application/src/index.js";
import {
  createDatabase,
  PostgresIntegrationUnitOfWork,
  PostgresUnitOfWork,
  type DatabaseConnection,
} from "../packages/database/src/index.js";
import { workspaceId } from "../packages/domain/src/index.js";
import {
  generateIntegrationCredentialSecret,
  hashIntegrationCredentialSecret,
} from "./integration-credentials.js";

const VERSION = "schedule.integration/v1" as const;
const sourceDatabaseUrl =
  process.env.DATABASE_URL ?? "postgres://schedule:schedule@127.0.0.1:5432/schedule";
const verificationDatabase = `schedule_nd_verify_${randomUUID().replaceAll("-", "")}`;
const verificationDatabasePattern = /^schedule_nd_verify_[a-f0-9]{32}$/;
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pepper = "notification-delivery-verification-pepper-32-characters";

function databaseUrlFor(databaseName: string): string {
  const url = new URL(sourceDatabaseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quotedVerificationDatabase(): string {
  if (!verificationDatabasePattern.test(verificationDatabase)) {
    throw new Error("Unsafe notification-delivery verification database identifier.");
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
          `Notification-delivery migration failed with exit code ${String(code)}${diagnostic === "" ? "" : `: ${diagnostic}`}`,
        ),
      );
    });
  });
}

interface CredentialFixture {
  readonly id: string;
  readonly token: string;
}

interface DeliveryCommand {
  readonly deliveryId: string;
  readonly intentId: string;
  readonly dedupeKey: string;
  readonly kind: string;
  readonly targetType: string;
  readonly title: string | null;
  readonly scheduledFor: string;
  readonly localDate: string;
  readonly priority: number;
  readonly attempt: number;
  readonly claimToken: string;
  readonly leaseExpiresAt: string;
}

interface ClaimEnvelope {
  readonly version: typeof VERSION;
  readonly requestId: string;
  readonly data: { readonly command: DeliveryCommand | null };
}

interface ReceiptEnvelope {
  readonly version: typeof VERSION;
  readonly requestId: string;
  readonly data: {
    readonly deliveryId: string;
    readonly status: "delivered" | "retry_scheduled" | "dead_lettered" | "invalidated";
  };
}

interface ErrorEnvelope {
  readonly error: { readonly code: string };
}

function authorization(token: string) {
  return { authorization: `Bearer ${token}` };
}

const adminConnection = createDatabase(databaseUrlFor("postgres"), 1);
const disposableDatabaseUrl = databaseUrlFor(verificationDatabase);
let connection: DatabaseConnection | null = null;
let app: Awaited<ReturnType<typeof buildApp>> | null = null;
let databaseCreated = false;
let failure: unknown;

try {
  await adminConnection.sql.unsafe(`create database ${quotedVerificationDatabase()}`);
  databaseCreated = true;
  await applyCurrentMigrations(disposableDatabaseUrl);

  const activeConnection = createDatabase(disposableDatabaseUrl, 6);
  connection = activeConnection;
  const productUnitOfWork = new PostgresUnitOfWork(activeConnection);
  const integrationUnitOfWork = new PostgresIntegrationUnitOfWork(activeConnection);
  const [databaseClock] = await activeConnection.sql<{ value: string }[]>`
    select clock_timestamp()::text as value
  `;
  assert.ok(databaseClock !== undefined);
  const now = new Date(databaseClock.value);
  const clock = { now: () => new Date(now) };
  app = await buildApp({
    productServices: createProductServices(productUnitOfWork, clock),
    productApiAccess: { mode: "local_unauthenticated" },
    integrationServices: createIntegrationServices(integrationUnitOfWork, clock, pepper, 600, {
      leaseDurationMilliseconds: 2_000,
      maxAttempts: 5,
    }),
    integrationApiLimits: { requestsPerMinute: 1_000 },
  });

  const createWorkspace = async (name: string): Promise<string> => {
    const response = await app!.inject({
      method: "POST",
      url: "/v1/workspaces",
      payload: { name },
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json<{ readonly id: string }>().id;
  };
  const primaryWorkspaceId = await createWorkspace("Notification delivery verification");
  const isolatedWorkspaceId = await createWorkspace("Notification delivery isolation");
  const revocationWorkspaceId = await createWorkspace("Notification delivery revocation race");
  const lowerMaxWorkspaceId = await createWorkspace("Notification delivery lower max");

  const profile = await app.inject({
    method: "PUT",
    url: `/v1/workspaces/${primaryWorkspaceId}/notification-profile`,
    payload: {
      expectedVersion: null,
      timeZone: "UTC",
      quietHoursStartMinute: null,
      quietHoursEndMinute: null,
      quietHoursPolicy: "next_allowed",
      catchUpWindowMinutes: 60,
      dailyIntentLimit: 100,
    },
  });
  assert.equal(profile.statusCode, 200, profile.body);
  const revocationProfile = await app.inject({
    method: "PUT",
    url: `/v1/workspaces/${revocationWorkspaceId}/notification-profile`,
    payload: {
      expectedVersion: null,
      timeZone: "UTC",
      quietHoursStartMinute: null,
      quietHoursEndMinute: null,
      quietHoursPolicy: "next_allowed",
      catchUpWindowMinutes: 60,
      dailyIntentLimit: 100,
    },
  });
  assert.equal(revocationProfile.statusCode, 200, revocationProfile.body);

  const [recoveryIndex] = await activeConnection.sql<{ indexdef: string }[]>`
    select indexdef from pg_indexes
    where schemaname = 'public' and indexname = 'notification_delivery_commands_recovery_idx'
  `;
  assert.ok(recoveryIndex !== undefined, "the expired-lease recovery index must be installed");
  const recoveryIndexDefinition = recoveryIndex.indexdef.toLowerCase().replaceAll('"', "");
  assert.ok(
    recoveryIndexDefinition.includes("using btree (workspace_id, lease_expires_at, id)"),
    "the recovery index must preserve workspace/expiry/id key order",
  );
  for (const fragment of ["processing", "invalidated"]) {
    assert.ok(
      recoveryIndexDefinition.includes(fragment),
      `the recovery index must include ${fragment}`,
    );
  }
  const [historyIndex] = await activeConnection.sql<{ indexdef: string }[]>`
    select indexdef from pg_indexes
    where schemaname = 'public'
      and indexname = 'notification_delivery_commands_workspace_schedule_idx'
  `;
  assert.ok(historyIndex !== undefined, "the product delivery-history index must be installed");
  assert.ok(
    historyIndex.indexdef
      .toLowerCase()
      .replaceAll('"', "")
      .includes("using btree (workspace_id, scheduled_for, id)"),
    "the history index must preserve workspace/schedule/id key order",
  );

  const provision = async (
    targetWorkspaceId: string,
    name: string,
    scopes: readonly IntegrationCredentialScope[],
  ): Promise<CredentialFixture> => {
    const secret = generateIntegrationCredentialSecret();
    const result = await new ProvisionIntegrationCredential(integrationUnitOfWork, clock).execute({
      workspaceId: workspaceId(targetWorkspaceId),
      name,
      scopes,
      secretHash: hashIntegrationCredentialSecret(secret, pepper),
    });
    return { id: result.id, token: `${result.id}.${secret}` };
  };
  const deliveryCredential = await provision(primaryWorkspaceId, "Delivery adapter", [
    "schedule:delivery",
  ]);
  const readCredential = await provision(primaryWorkspaceId, "Read-only adapter", [
    "schedule:read",
  ]);
  const isolatedDeliveryCredential = await provision(isolatedWorkspaceId, "Isolated delivery", [
    "schedule:delivery",
  ]);
  const revocationCredential = await provision(revocationWorkspaceId, "Revocation race delivery", [
    "schedule:delivery",
  ]);

  const createOneOff = async (
    title: string,
  ): Promise<{ readonly id: string; readonly version: number }> => {
    const response = await app!.inject({
      method: "POST",
      url: `/v1/workspaces/${primaryWorkspaceId}/one-off-reminders`,
      payload: { title, scheduledFor: now.toISOString() },
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json<{ readonly id: string; readonly version: number }>();
  };
  const materialize = async (): Promise<void> => {
    const response = await app!.inject({
      method: "POST",
      url: `/v1/workspaces/${primaryWorkspaceId}/notification-intents/materializations`,
      payload: {
        from: new Date(now.getTime() - 60 * 60_000).toISOString(),
        through: new Date(now.getTime() + 60 * 60_000).toISOString(),
      },
    });
    assert.equal(response.statusCode, 200, response.body);
  };
  const claim = async (
    token: string,
    idempotencyKey: string,
  ): Promise<{
    readonly statusCode: number;
    readonly body: string;
    readonly envelope: ClaimEnvelope;
  }> => {
    const response = await app!.inject({
      method: "POST",
      url: "/v1/integrations/reminder-deliveries/claim",
      headers: { ...authorization(token), "idempotency-key": idempotencyKey },
      payload: { version: VERSION },
    });
    return {
      statusCode: response.statusCode,
      body: response.body,
      envelope: response.json<ClaimEnvelope>(),
    };
  };
  const receipt = async (
    token: string,
    idempotencyKey: string,
    payload: Readonly<Record<string, unknown>>,
  ) =>
    app!.inject({
      method: "POST",
      url: "/v1/integrations/reminder-deliveries/receipt",
      headers: { ...authorization(token), "idempotency-key": idempotencyKey },
      payload: { version: VERSION, ...payload },
    });
  const redrive = async (workspaceId: string, deliveryId: string) =>
    app!.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceId}/notification-deliveries/${deliveryId}/redrives`,
    });
  const wait = (milliseconds: number) =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, milliseconds);
    });

  // EVIDENCE: notification-delivery-revocation-linearization
  // Final revalidation waits on the credential row and observes a revocation that wins the lock.
  const revocationReminder = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${revocationWorkspaceId}/one-off-reminders`,
    payload: { title: "Must not be claimed after revocation", scheduledFor: now.toISOString() },
  });
  assert.equal(revocationReminder.statusCode, 201, revocationReminder.body);
  const revocationMaterialization = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${revocationWorkspaceId}/notification-intents/materializations`,
    payload: {
      from: new Date(now.getTime() - 60 * 60_000).toISOString(),
      through: new Date(now.getTime() + 60 * 60_000).toISOString(),
    },
  });
  assert.equal(revocationMaterialization.statusCode, 200, revocationMaterialization.body);

  let releaseRevocation = (): void => undefined;
  let markRevocationReady = (): void => undefined;
  const revocationReady = new Promise<void>((resolve) => {
    markRevocationReady = resolve;
  });
  const releaseRevocationSignal = new Promise<void>((resolve) => {
    releaseRevocation = resolve;
  });
  const revocationTransaction = activeConnection.sql.begin(async (transaction) => {
    await transaction`
      select id from integration_credentials
      where id = ${revocationCredential.id}
      for update
    `;
    await transaction`
      update integration_credentials
      set active = false,
          revoked_at = clock_timestamp(),
          updated_at = clock_timestamp(),
          version = version + 1
      where id = ${revocationCredential.id}
    `;
    markRevocationReady();
    await releaseRevocationSignal;
  });
  await revocationReady;
  let revocationClaimSettled = false;
  const pendingRevokedClaim = claim(
    revocationCredential.token,
    "claim-revocation-linearization",
  ).finally(() => {
    revocationClaimSettled = true;
  });
  try {
    await wait(100);
    assert.equal(
      revocationClaimSettled,
      false,
      "the final credential check must wait for the revocation row lock",
    );
  } finally {
    releaseRevocation();
  }
  await revocationTransaction;
  const [committedRevocation] = await activeConnection.sql<
    { active: boolean; revoked_at: string | null }[]
  >`
    select active, revoked_at::text from integration_credentials
    where id = ${revocationCredential.id}
  `;
  assert.ok(committedRevocation !== undefined);
  assert.equal(committedRevocation.active, false);
  assert.notEqual(committedRevocation.revoked_at, null);
  const revokedClaim = await pendingRevokedClaim;
  assert.equal(revokedClaim.statusCode, 401, revokedClaim.body);
  assert.equal(
    (JSON.parse(revokedClaim.body) as ErrorEnvelope).error.code,
    "integration.authentication_failed",
  );
  const [revocationState] = await activeConnection.sql<
    { commands: number; attempts: number; requests: number; audits: number }[]
  >`
    select
      (select count(*)::int from notification_delivery_commands where workspace_id = ${revocationWorkspaceId}) as commands,
      (select count(*)::int from notification_delivery_attempts where credential_id = ${revocationCredential.id}) as attempts,
      (select count(*)::int from notification_delivery_requests where credential_id = ${revocationCredential.id}) as requests,
      (
        select count(*)::int from audit_events
        where workspace_id = ${revocationWorkspaceId}
          and action in ('notification_delivery.claimed', 'notification_delivery.receipt_recorded')
      ) as audits
  `;
  assert.deepEqual(revocationState, { commands: 0, attempts: 0, requests: 0, audits: 0 });

  await createOneOff("Retry and deliver");
  await materialize();
  const denied = await claim(readCredential.token, "scope-denied");
  assert.equal(denied.statusCode, 403, denied.body);
  assert.equal((JSON.parse(denied.body) as ErrorEnvelope).error.code, "integration.scope_denied");

  // EVIDENCE: notification-delivery-claim-idempotency-and-fresh-lease
  // Concurrent lost-response retries expose one command, and the database starts its lease only
  // after a deliberately long wait for the workspace lock.
  let releaseWorkspaceLock = (): void => undefined;
  let markWorkspaceLockHeld = (): void => undefined;
  const workspaceLockHeld = new Promise<void>((resolve) => {
    markWorkspaceLockHeld = resolve;
  });
  const releaseWorkspaceLockSignal = new Promise<void>((resolve) => {
    releaseWorkspaceLock = resolve;
  });
  const blockingTransaction = activeConnection.sql.begin(async (transaction) => {
    await transaction`
      select pg_advisory_xact_lock(
        hashtextextended(${`${primaryWorkspaceId.toLowerCase()}:notifications`}, 0)
      )
    `;
    markWorkspaceLockHeld();
    await releaseWorkspaceLockSignal;
  });
  await workspaceLockHeld;
  const pendingConcurrentClaims = Promise.all(
    Array.from({ length: 4 }, () => claim(deliveryCredential.token, "claim-retry-and-deliver")),
  );
  await wait(2_200);
  releaseWorkspaceLock();
  await blockingTransaction;
  const concurrentClaims = await pendingConcurrentClaims;
  for (const response of concurrentClaims) assert.equal(response.statusCode, 200, response.body);
  const firstCommand = concurrentClaims[0]?.envelope.data.command;
  assert.ok(firstCommand !== null && firstCommand !== undefined);
  for (const response of concurrentClaims.slice(1)) {
    assert.deepEqual(response.envelope.data.command, firstCommand);
  }
  assert.equal(firstCommand.deliveryId, firstCommand.intentId);
  assert.equal(firstCommand.dedupeKey, firstCommand.deliveryId);
  assert.equal(firstCommand.attempt, 1);
  const [clockAfterClaim] = await activeConnection.sql<{ value: string }[]>`
    select clock_timestamp()::text as value
  `;
  assert.ok(clockAfterClaim !== undefined);
  assert.ok(
    new Date(firstCommand.leaseExpiresAt).getTime() - new Date(clockAfterClaim.value).getTime() >
      1_500,
    "the lease must begin after the workspace lock is acquired",
  );
  assert.equal("provider" in firstCommand, false);
  assert.equal("recipient" in firstCommand, false);
  assert.equal("conversation" in firstCommand, false);

  const reusedClaimKey = await receipt(deliveryCredential.token, "claim-retry-and-deliver", {
    deliveryId: firstCommand.deliveryId,
    claimToken: firstCommand.claimToken,
    outcome: "delivered",
  });
  assert.equal(reusedClaimKey.statusCode, 409, reusedClaimKey.body);
  assert.equal(
    reusedClaimKey.json<ErrorEnvelope>().error.code,
    "notification_delivery.request_conflict",
  );

  const crossTenantReceipt = await receipt(
    isolatedDeliveryCredential.token,
    "cross-tenant-receipt",
    {
      deliveryId: firstCommand.deliveryId,
      claimToken: firstCommand.claimToken,
      outcome: "delivered",
    },
  );
  assert.equal(crossTenantReceipt.statusCode, 404, crossTenantReceipt.body);
  assert.equal(
    crossTenantReceipt.json<ErrorEnvelope>().error.code,
    "notification_delivery.command_not_found",
  );

  const retryPayload = {
    deliveryId: firstCommand.deliveryId,
    claimToken: firstCommand.claimToken,
    outcome: "retryable_failure",
    failureCode: "transport.unavailable",
    retryAfterSeconds: 0,
  } as const;
  const firstRetry = await receipt(
    deliveryCredential.token,
    "receipt-retry-and-deliver-1",
    retryPayload,
  );
  const replayedRetry = await receipt(
    deliveryCredential.token,
    "receipt-retry-and-deliver-1",
    retryPayload,
  );
  assert.equal(firstRetry.statusCode, 200, firstRetry.body);
  assert.deepEqual(
    replayedRetry.json<ReceiptEnvelope>().data,
    firstRetry.json<ReceiptEnvelope>().data,
  );
  assert.equal(firstRetry.json<ReceiptEnvelope>().data.status, "retry_scheduled");

  const secondClaim = await claim(deliveryCredential.token, "claim-retry-and-deliver-2");
  assert.equal(secondClaim.statusCode, 200, secondClaim.body);
  const secondCommand = secondClaim.envelope.data.command;
  assert.ok(secondCommand !== null);
  assert.equal(secondCommand.deliveryId, firstCommand.deliveryId);
  assert.equal(secondCommand.dedupeKey, firstCommand.dedupeKey);
  assert.equal(secondCommand.attempt, 2);
  assert.notEqual(secondCommand.claimToken, firstCommand.claimToken);

  const staleReceipt = await receipt(deliveryCredential.token, "stale-receipt", {
    deliveryId: firstCommand.deliveryId,
    claimToken: firstCommand.claimToken,
    outcome: "delivered",
  });
  assert.equal(staleReceipt.statusCode, 409, staleReceipt.body);
  assert.equal(staleReceipt.json<ErrorEnvelope>().error.code, "notification_delivery.claim_stale");
  const delivered = await receipt(deliveryCredential.token, "receipt-retry-and-deliver-2", {
    deliveryId: secondCommand.deliveryId,
    claimToken: secondCommand.claimToken,
    outcome: "delivered",
  });
  assert.equal(delivered.statusCode, 200, delivered.body);
  assert.equal(delivered.json<ReceiptEnvelope>().data.status, "delivered");

  // EVIDENCE: notification-delivery-lease-recovery
  // A crash after an external effect re-exposes the same dedupe key with a new fence.
  await createOneOff("Lease recovery");
  await materialize();
  const leaseClaim = await claim(deliveryCredential.token, "claim-lease-1");
  const leaseCommand = leaseClaim.envelope.data.command;
  assert.ok(leaseCommand !== null);
  await wait(2_100);
  const expiredBeforeReclaim = await receipt(
    deliveryCredential.token,
    "receipt-expired-before-reclaim",
    {
      deliveryId: leaseCommand.deliveryId,
      claimToken: leaseCommand.claimToken,
      outcome: "delivered",
    },
  );
  assert.equal(expiredBeforeReclaim.statusCode, 409, expiredBeforeReclaim.body);
  assert.equal(
    expiredBeforeReclaim.json<ErrorEnvelope>().error.code,
    "notification_delivery.claim_stale",
  );
  const recoveredClaim = await claim(deliveryCredential.token, "claim-lease-2");
  const recoveredCommand = recoveredClaim.envelope.data.command;
  assert.ok(recoveredCommand !== null);
  assert.equal(recoveredCommand.deliveryId, leaseCommand.deliveryId);
  assert.equal(recoveredCommand.dedupeKey, leaseCommand.dedupeKey);
  assert.equal(recoveredCommand.attempt, 2);
  assert.notEqual(recoveredCommand.claimToken, leaseCommand.claimToken);
  const oldLeaseReceipt = await receipt(deliveryCredential.token, "receipt-old-lease", {
    deliveryId: leaseCommand.deliveryId,
    claimToken: leaseCommand.claimToken,
    outcome: "delivered",
  });
  assert.equal(oldLeaseReceipt.statusCode, 409, oldLeaseReceipt.body);
  const recoveredDelivered = await receipt(deliveryCredential.token, "receipt-recovered-lease", {
    deliveryId: recoveredCommand.deliveryId,
    claimToken: recoveredCommand.claimToken,
    outcome: "delivered",
  });
  assert.equal(recoveredDelivered.statusCode, 200, recoveredDelivered.body);

  // EVIDENCE: notification-delivery-invalidation-cutoff
  // Source changes after claim retain the command, reject retries, and still record a late outcome.
  const invalidatedReminder = await createOneOff("Invalidate after claim");
  await materialize();
  const invalidatedClaim = await claim(deliveryCredential.token, "claim-invalidated");
  const invalidatedCommand = invalidatedClaim.envelope.data.command;
  assert.ok(invalidatedCommand !== null);
  const cancellation = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${primaryWorkspaceId}/one-off-reminders/${invalidatedReminder.id}/cancellations`,
    payload: { expectedVersion: invalidatedReminder.version },
  });
  assert.equal(cancellation.statusCode, 200, cancellation.body);
  const afterInvalidation = await claim(deliveryCredential.token, "claim-after-invalidation");
  assert.equal(afterInvalidation.statusCode, 200, afterInvalidation.body);
  assert.equal(afterInvalidation.envelope.data.command, null);
  const invalidatedReceipt = await receipt(deliveryCredential.token, "receipt-invalidated", {
    deliveryId: invalidatedCommand.deliveryId,
    claimToken: invalidatedCommand.claimToken,
    outcome: "delivered",
  });
  assert.equal(invalidatedReceipt.statusCode, 200, invalidatedReceipt.body);
  assert.equal(invalidatedReceipt.json<ReceiptEnvelope>().data.status, "invalidated");

  // An invalidated command whose adapter disappears is closed after its original lease.
  const abandonedReminder = await createOneOff("Invalidate and abandon");
  await materialize();
  const abandonedClaim = await claim(deliveryCredential.token, "claim-abandoned");
  const abandonedCommand = abandonedClaim.envelope.data.command;
  assert.ok(abandonedCommand !== null);
  const abandonedCancellation = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${primaryWorkspaceId}/one-off-reminders/${abandonedReminder.id}/cancellations`,
    payload: { expectedVersion: abandonedReminder.version },
  });
  assert.equal(abandonedCancellation.statusCode, 200, abandonedCancellation.body);
  await wait(2_100);
  const sweepInvalidated = await claim(deliveryCredential.token, "claim-sweep-invalidated");
  assert.equal(sweepInvalidated.statusCode, 200, sweepInvalidated.body);
  assert.equal(sweepInvalidated.envelope.data.command, null);
  const [abandonedState] = await activeConnection.sql<
    { current_claim_token: string | null; attempt_outcome: string | null }[]
  >`
    select
      command.current_claim_token::text,
      attempt.outcome::text as attempt_outcome
    from notification_delivery_commands command
    join notification_delivery_attempts attempt
      on attempt.workspace_id = command.workspace_id and attempt.delivery_id = command.id
    where command.workspace_id = ${primaryWorkspaceId} and command.id = ${abandonedCommand.deliveryId}
  `;
  assert.deepEqual(abandonedState, {
    current_claim_token: null,
    attempt_outcome: "lease_expired",
  });
  const abandonedLateReceipt = await receipt(deliveryCredential.token, "receipt-abandoned-late", {
    deliveryId: abandonedCommand.deliveryId,
    claimToken: abandonedCommand.claimToken,
    outcome: "delivered",
  });
  assert.equal(abandonedLateReceipt.statusCode, 409, abandonedLateReceipt.body);

  await createOneOff("Permanent failure");
  await materialize();
  const permanentClaim = await claim(deliveryCredential.token, "claim-permanent");
  const firstPermanentCommand = permanentClaim.envelope.data.command;
  assert.ok(firstPermanentCommand !== null);
  let permanentCommand = firstPermanentCommand;
  for (let attempt = 1; attempt < 5; attempt += 1) {
    assert.equal(permanentCommand.attempt, attempt);
    const retry = await receipt(
      deliveryCredential.token,
      `receipt-permanent-retry-${String(attempt)}`,
      {
        deliveryId: permanentCommand.deliveryId,
        claimToken: permanentCommand.claimToken,
        outcome: "retryable_failure",
        failureCode: "transport.retryable",
        retryAfterSeconds: 0,
      },
    );
    assert.equal(retry.statusCode, 200, retry.body);
    assert.equal(retry.json<ReceiptEnvelope>().data.status, "retry_scheduled");
    const nextClaim = await claim(
      deliveryCredential.token,
      `claim-permanent-${String(attempt + 1)}`,
    );
    const nextCommand = nextClaim.envelope.data.command;
    assert.ok(nextCommand !== null);
    assert.equal(nextCommand.deliveryId, firstPermanentCommand.deliveryId);
    assert.equal(nextCommand.dedupeKey, firstPermanentCommand.dedupeKey);
    permanentCommand = nextCommand;
  }
  assert.equal(permanentCommand.attempt, 5);
  const permanentReceipt = await receipt(deliveryCredential.token, "receipt-permanent", {
    deliveryId: permanentCommand.deliveryId,
    claimToken: permanentCommand.claimToken,
    outcome: "permanent_failure",
    failureCode: "transport.rejected",
  });
  assert.equal(permanentReceipt.statusCode, 200, permanentReceipt.body);
  assert.equal(permanentReceipt.json<ReceiptEnvelope>().data.status, "dead_lettered");

  // EVIDENCE: notification-delivery-dead-letter-redrive
  // Redrive changes only the existing terminal command. Its identity, cumulative attempts and
  // immutable historic attempts survive; exactly one concurrent redrive wins and is audited.
  const [beforeRedrive] = await activeConnection.sql<
    {
      id: string;
      intent_id: string;
      attempts: number;
      last_failure_code: string | null;
      attempt_rows: number;
      completed_attempt_rows: number;
    }[]
  >`
    select
      command.id::text,
      command.intent_id::text,
      command.attempts,
      command.last_failure_code,
      (select count(*)::int from notification_delivery_attempts attempt
       where attempt.workspace_id = command.workspace_id and attempt.delivery_id = command.id) as attempt_rows,
      (select count(*)::int from notification_delivery_attempts attempt
       where attempt.workspace_id = command.workspace_id and attempt.delivery_id = command.id
         and attempt.outcome = 'permanent_failure') as completed_attempt_rows
    from notification_delivery_commands command
    where command.workspace_id = ${primaryWorkspaceId} and command.id = ${permanentCommand.deliveryId}
  `;
  assert.ok(beforeRedrive !== undefined);
  assert.equal(beforeRedrive.attempts, 5);
  assert.equal(beforeRedrive.last_failure_code, "transport.rejected");

  const rejectedCrossTenantRedrive = await redrive(
    isolatedWorkspaceId,
    permanentCommand.deliveryId,
  );
  assert.equal(rejectedCrossTenantRedrive.statusCode, 404, rejectedCrossTenantRedrive.body);
  assert.equal(
    rejectedCrossTenantRedrive.json<ErrorEnvelope>().error.code,
    "notification_delivery.command_not_found",
  );

  const concurrentRedrives = await Promise.all(
    Array.from({ length: 2 }, () => redrive(primaryWorkspaceId, permanentCommand.deliveryId)),
  );
  assert.deepEqual(
    concurrentRedrives.map((response) => response.statusCode).sort(),
    [200, 409],
    "only one dead-letter redrive may transition the existing command",
  );
  const redriveSuccess = concurrentRedrives.find((response) => response.statusCode === 200);
  assert.ok(redriveSuccess !== undefined);
  const redriven = redriveSuccess.json<{
    readonly deliveryId: string;
    readonly intentId: string;
    readonly status: string;
    readonly attempts: number;
    readonly lastFailureCode: string | null;
    readonly completedAt: string | null;
  }>();
  assert.equal(redriven.deliveryId, beforeRedrive.id);
  assert.equal(redriven.intentId, beforeRedrive.intent_id);
  assert.equal(redriven.status, "pending");
  assert.equal(redriven.attempts, beforeRedrive.attempts);
  assert.equal(redriven.lastFailureCode, beforeRedrive.last_failure_code);
  assert.equal(redriven.completedAt, null);

  const [redriveAudit] = await activeConnection.sql<
    { count: number; occurred_at: string; updated_at: string }[]
  >`
    select
      count(*)::int as count,
      max(audit.occurred_at)::text as occurred_at,
      max(command.updated_at)::text as updated_at
    from notification_delivery_commands command
    join audit_events audit
      on audit.workspace_id = command.workspace_id
     and audit.entity_id = command.id
     and audit.action = 'notification_delivery.redriven'
    where command.workspace_id = ${primaryWorkspaceId} and command.id = ${permanentCommand.deliveryId}
    group by command.updated_at
  `;
  assert.ok(redriveAudit !== undefined);
  assert.equal(redriveAudit.count, 1);
  assert.equal(
    new Date(redriveAudit.occurred_at).getTime(),
    new Date(redriveAudit.updated_at).getTime(),
    "redrive audit must share the persisted transition timestamp",
  );

  const redrivenClaim = await claim(deliveryCredential.token, "claim-redriven-dead-letter");
  const redrivenCommand = redrivenClaim.envelope.data.command;
  assert.ok(redrivenCommand !== null);
  assert.equal(redrivenCommand.deliveryId, permanentCommand.deliveryId);
  assert.equal(redrivenCommand.intentId, permanentCommand.intentId);
  assert.equal(redrivenCommand.dedupeKey, permanentCommand.dedupeKey);
  assert.equal(redrivenCommand.attempt, beforeRedrive.attempts + 1);
  const [consumedRedriveAuthorization] = await activeConnection.sql<
    { redrive_requested_at: string | null }[]
  >`
    select redrive_requested_at::text
    from notification_delivery_commands
    where workspace_id = ${primaryWorkspaceId} and id = ${permanentCommand.deliveryId}
  `;
  assert.ok(consumedRedriveAuthorization !== undefined);
  assert.equal(consumedRedriveAuthorization.redrive_requested_at, null);
  const redrivenReceipt = await receipt(deliveryCredential.token, "receipt-redriven-dead-letter", {
    deliveryId: redrivenCommand.deliveryId,
    claimToken: redrivenCommand.claimToken,
    outcome: "permanent_failure",
    failureCode: "transport.rejected_again",
  });
  assert.equal(redrivenReceipt.statusCode, 200, redrivenReceipt.body);
  assert.equal(redrivenReceipt.json<ReceiptEnvelope>().data.status, "dead_lettered");
  const [afterRedrive] = await activeConnection.sql<
    { attempts: number; attempt_rows: number; old_attempt_rows: number }[]
  >`
    select
      command.attempts,
      (select count(*)::int from notification_delivery_attempts attempt
       where attempt.workspace_id = command.workspace_id and attempt.delivery_id = command.id) as attempt_rows,
      (select count(*)::int from notification_delivery_attempts attempt
       where attempt.workspace_id = command.workspace_id and attempt.delivery_id = command.id
         and attempt.outcome = 'permanent_failure' and attempt.failure_code = 'transport.rejected') as old_attempt_rows
    from notification_delivery_commands command
    where command.workspace_id = ${primaryWorkspaceId} and command.id = ${permanentCommand.deliveryId}
  `;
  assert.ok(afterRedrive !== undefined);
  assert.equal(afterRedrive.attempts, beforeRedrive.attempts + 1);
  assert.equal(afterRedrive.attempt_rows, beforeRedrive.attempt_rows + 1);
  assert.equal(afterRedrive.old_attempt_rows, beforeRedrive.completed_attempt_rows);

  // EVIDENCE: notification-delivery-redrive-authorization-one-use
  // A pending command at a stricter adapter's max is not a redrive merely because it is pending.
  // Only the durable authorization written by dead_letter -> pending can permit that extra claim.
  const lowerMaxDeliveryId = randomUUID();
  await activeConnection.sql`
    insert into notification_delivery_commands (
      id, workspace_id, intent_id, occurrence_key, kind, target_type, title_snapshot,
      scheduled_for, local_date, priority, status, attempts, available_at,
      created_at, updated_at
    ) values (
      ${lowerMaxDeliveryId}::uuid, ${lowerMaxWorkspaceId}::uuid, ${randomUUID()}::uuid,
      'lower-max-without-redrive', 'one_off', 'one_off', 'Lower max without redrive',
      clock_timestamp(), current_date, 100, 'pending', 1, clock_timestamp(),
      clock_timestamp(), clock_timestamp()
    )
  `;
  const lowerMaxClaim = await integrationUnitOfWork.run((context) =>
    context.notificationDeliveries.claimNext({
      workspaceId: workspaceId(lowerMaxWorkspaceId),
      credentialId: revocationCredential.id,
      leaseDurationMilliseconds: 2_000,
      maxAttempts: 1,
    }),
  );
  assert.equal(lowerMaxClaim, null);
  const [lowerMaxState] = await activeConnection.sql<
    {
      status: string;
      attempts: number;
      redrive_requested_at: string | null;
      attempt_rows: number;
    }[]
  >`
    select
      command.status::text,
      command.attempts,
      command.redrive_requested_at::text,
      (select count(*)::int from notification_delivery_attempts attempt
       where attempt.workspace_id = command.workspace_id and attempt.delivery_id = command.id) as attempt_rows
    from notification_delivery_commands command
    where command.workspace_id = ${lowerMaxWorkspaceId} and command.id = ${lowerMaxDeliveryId}
  `;
  assert.deepEqual(lowerMaxState, {
    status: "pending",
    attempts: 1,
    redrive_requested_at: null,
    attempt_rows: 0,
  });

  // EVIDENCE: notification-delivery-source-invalidation-terminal-cutoff
  // Cancelling a source invalidates its existing dead-letter command too. It stays the same
  // delivery/audit record, but can neither be redriven nor selected for another provider call.
  const terminalSourceReminder = await createOneOff("Invalidate dead letter source");
  await materialize();
  const terminalSourceClaim = await claim(deliveryCredential.token, "claim-terminal-source");
  const terminalSourceCommand = terminalSourceClaim.envelope.data.command;
  assert.ok(terminalSourceCommand !== null);
  const terminalSourceFailure = await receipt(deliveryCredential.token, "receipt-terminal-source", {
    deliveryId: terminalSourceCommand.deliveryId,
    claimToken: terminalSourceCommand.claimToken,
    outcome: "permanent_failure",
    failureCode: "transport.source_terminal",
  });
  assert.equal(terminalSourceFailure.statusCode, 200, terminalSourceFailure.body);
  assert.equal(terminalSourceFailure.json<ReceiptEnvelope>().data.status, "dead_lettered");
  const [terminalSourceCancellation, terminalSourceRedrive] = await Promise.all([
    app.inject({
      method: "POST",
      url: `/v1/workspaces/${primaryWorkspaceId}/one-off-reminders/${terminalSourceReminder.id}/cancellations`,
      payload: { expectedVersion: terminalSourceReminder.version },
    }),
    redrive(primaryWorkspaceId, terminalSourceCommand.deliveryId),
  ]);
  assert.equal(terminalSourceCancellation.statusCode, 200, terminalSourceCancellation.body);
  assert.ok(
    terminalSourceRedrive.statusCode === 200 || terminalSourceRedrive.statusCode === 409,
    terminalSourceRedrive.body,
  );
  if (terminalSourceRedrive.statusCode === 409) {
    assert.equal(
      terminalSourceRedrive.json<ErrorEnvelope>().error.code,
      "notification_delivery.redrive_conflict",
    );
  }
  const terminalSourceClaimAfterCancellation = await claim(
    deliveryCredential.token,
    "claim-terminal-source-after-cancellation",
  );
  assert.equal(
    terminalSourceClaimAfterCancellation.envelope.data.command,
    null,
    "a source-invalidated dead letter must never be claimed again",
  );
  const [terminalSourceState] = await activeConnection.sql<
    { status: string; attempts: number; last_failure_code: string | null; attempt_rows: number }[]
  >`
    select
      command.status::text,
      command.attempts,
      command.last_failure_code,
      (select count(*)::int from notification_delivery_attempts attempt
       where attempt.workspace_id = command.workspace_id and attempt.delivery_id = command.id) as attempt_rows
    from notification_delivery_commands command
    where command.workspace_id = ${primaryWorkspaceId} and command.id = ${terminalSourceCommand.deliveryId}
  `;
  assert.deepEqual(terminalSourceState, {
    status: "invalidated",
    attempts: 1,
    last_failure_code: "transport.source_terminal",
    attempt_rows: 1,
  });

  // EVIDENCE: notification-delivery-null-claim-replay
  // An empty claim is a durable point-in-time result and cannot later lease a different command.
  const emptyClaim = await claim(deliveryCredential.token, "claim-empty");
  assert.equal(emptyClaim.statusCode, 200, emptyClaim.body);
  assert.equal(emptyClaim.envelope.data.command, null);
  await createOneOff("Created after empty claim");
  await materialize();
  const replayedEmptyClaim = await claim(deliveryCredential.token, "claim-empty");
  assert.equal(replayedEmptyClaim.envelope.data.command, null);
  const laterClaim = await claim(deliveryCredential.token, "claim-after-empty");
  assert.ok(laterClaim.envelope.data.command !== null);
  await receipt(deliveryCredential.token, "receipt-after-empty", {
    deliveryId: laterClaim.envelope.data.command.deliveryId,
    claimToken: laterClaim.envelope.data.command.claimToken,
    outcome: "delivered",
  });

  const [state] = await activeConnection.sql<
    {
      delivered: number;
      dead_letter: number;
      invalidated: number;
      lease_expired_attempts: number;
      duplicate_occurrences: number;
      raw_receipt_fields: number;
    }[]
  >`
    select
      count(*) filter (where status = 'delivered')::int as delivered,
      count(*) filter (where status = 'dead_letter')::int as dead_letter,
      count(*) filter (where status = 'invalidated')::int as invalidated,
      (select count(*)::int from notification_delivery_attempts where outcome = 'lease_expired') as lease_expired_attempts,
      (
        select count(*)::int
        from (
          select workspace_id, occurrence_key
          from notification_delivery_commands
          group by workspace_id, occurrence_key
          having count(*) > 1
        ) duplicates
      ) as duplicate_occurrences,
      (
        select count(*)::int
        from notification_delivery_requests
        where result::text ~* '(provider|recipient|conversation|phone|whatsapp)'
      ) as raw_receipt_fields
    from notification_delivery_commands
    where workspace_id = ${primaryWorkspaceId}
  `;
  assert.ok(state !== undefined);
  assert.equal(state.delivered, 3);
  assert.equal(state.dead_letter, 1);
  assert.equal(state.invalidated, 3);
  assert.equal(state.lease_expired_attempts, 2);
  assert.equal(state.duplicate_occurrences, 0);
  assert.equal(state.raw_receipt_fields, 0);

  const historyFrom = new Date(now.getTime() - 60 * 60_000).toISOString();
  const historyTo = new Date(now.getTime() + 60 * 60_000).toISOString();
  const historyQuery = `from=${encodeURIComponent(historyFrom)}&to=${encodeURIComponent(
    historyTo,
  )}&limit=100&offset=0`;
  const historyResponse = await app.inject({
    method: "GET",
    url: `/v1/workspaces/${primaryWorkspaceId}/notification-deliveries?${historyQuery}`,
  });
  assert.equal(historyResponse.statusCode, 200, historyResponse.body);
  const history = historyResponse.json<{
    readonly items: readonly Readonly<Record<string, unknown>>[];
    readonly page: { readonly limit: number; readonly offset: number };
  }>();
  assert.deepEqual(history.page, { limit: 100, offset: 0 });
  assert.equal(history.items.length, 7);
  assert.deepEqual(history.items.map((item) => item.status).sort(), [
    "dead_letter",
    "delivered",
    "delivered",
    "delivered",
    "invalidated",
    "invalidated",
    "invalidated",
  ]);
  for (const item of history.items) {
    assert.deepEqual(
      Object.keys(item).sort(),
      [
        "attempts",
        "availableAt",
        "completedAt",
        "createdAt",
        "deliveryId",
        "intentId",
        "kind",
        "lastFailureCode",
        "localDate",
        "priority",
        "scheduledFor",
        "status",
        "targetType",
        "title",
        "updatedAt",
      ],
      "product history must expose only the safe delivery projection",
    );
  }

  const isolatedHistoryResponse = await app.inject({
    method: "GET",
    url: `/v1/workspaces/${isolatedWorkspaceId}/notification-deliveries?${historyQuery}`,
  });
  assert.equal(isolatedHistoryResponse.statusCode, 200, isolatedHistoryResponse.body);
  assert.deepEqual(
    isolatedHistoryResponse.json<{ readonly items: readonly unknown[] }>().items,
    [],
    "product history must not expose another workspace's delivery commands",
  );

  const reversedHistoryResponse = await app.inject({
    method: "GET",
    url: `/v1/workspaces/${primaryWorkspaceId}/notification-deliveries?from=${encodeURIComponent(
      historyTo,
    )}&to=${encodeURIComponent(historyFrom)}&limit=100&offset=0`,
  });
  assert.equal(reversedHistoryResponse.statusCode, 422, reversedHistoryResponse.body);
  assert.equal(
    reversedHistoryResponse.json<{ readonly error: { readonly code: string } }>().error.code,
    "notification_delivery.range_invalid",
  );

  const oversizedHistoryResponse = await app.inject({
    method: "GET",
    url: `/v1/workspaces/${primaryWorkspaceId}/notification-deliveries?from=${encodeURIComponent(
      historyFrom,
    )}&to=${encodeURIComponent(
      new Date(new Date(historyFrom).getTime() + 32 * 24 * 60 * 60_000).toISOString(),
    )}&limit=100&offset=0`,
  });
  assert.equal(oversizedHistoryResponse.statusCode, 422, oversizedHistoryResponse.body);
  assert.equal(
    oversizedHistoryResponse.json<{ readonly error: { readonly code: string } }>().error.code,
    "notification_delivery.range_too_large",
  );

  const invalidPaginationResponse = await app.inject({
    method: "GET",
    url: `/v1/workspaces/${primaryWorkspaceId}/notification-deliveries?from=${encodeURIComponent(
      historyFrom,
    )}&to=${encodeURIComponent(historyTo)}&limit=501&offset=1000001`,
  });
  assert.equal(invalidPaginationResponse.statusCode, 400, invalidPaginationResponse.body);
  assert.equal(
    invalidPaginationResponse.json<{ readonly error: { readonly code: string } }>().error.code,
    "request.validation_failed",
  );

  const [auditState] = await activeConnection.sql<
    { claim_audits: number; receipt_audits: number; request_count: number }[]
  >`
    select
      count(*) filter (where action = 'notification_delivery.claimed')::int as claim_audits,
      count(*) filter (where action = 'notification_delivery.receipt_recorded')::int as receipt_audits,
      (select count(*)::int from notification_delivery_requests) as request_count
    from audit_events
    where workspace_id = ${primaryWorkspaceId}
  `;
  assert.ok(auditState !== undefined);
  assert.equal(auditState.claim_audits, 14);
  assert.equal(auditState.receipt_audits, 12);
  assert.equal(auditState.request_count, 30);
} catch (error) {
  failure = error;
} finally {
  if (app !== null) await app.close().catch(() => undefined);
  if (connection !== null) await connection.close().catch(() => undefined);
  if (databaseCreated) {
    await adminConnection.sql`
      select pg_terminate_backend(pid)
      from pg_stat_activity
      where datname = ${verificationDatabase} and pid <> pg_backend_pid()
    `.catch(() => undefined);
    await adminConnection.sql
      .unsafe(`drop database if exists ${quotedVerificationDatabase()}`)
      .catch(() => undefined);
  }
  await adminConnection.close().catch(() => undefined);
}

if (failure !== undefined) throw failure;
process.stdout.write("notification delivery verification passed\n");
