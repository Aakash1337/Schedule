import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ProvisionIntegrationCredential,
  type ConfirmedIntegrationCommandResult,
  type IntegrationCommand,
  type PreparedIntegrationCommand,
} from "../packages/application/src/index.js";
import {
  createDatabase,
  purgeIntegrationHistory,
  PostgresIntegrationUnitOfWork,
  PostgresUnitOfWork,
  type DatabaseConnection,
} from "../packages/database/src/index.js";
import { workspaceId } from "../packages/domain/src/index.js";

import { buildApp } from "../apps/api/src/app.js";
import { createIntegrationServices } from "../apps/api/src/integration-services.js";
import { createProductServices } from "../apps/api/src/product-services.js";
import {
  generateIntegrationCredentialSecret,
  hashIntegrationCredentialSecret,
} from "./integration-credentials.js";

const VERSION = "schedule.integration/v1" as const;
const PLAN_DATE = "2026-07-15";
const sourceDatabaseUrl =
  process.env.DATABASE_URL ?? "postgres://schedule:schedule@127.0.0.1:5432/schedule";
const verificationDatabase = `schedule_integration_verify_${randomUUID().replaceAll("-", "")}`;
const verificationDatabasePattern = /^schedule_integration_verify_[a-f0-9]{32}$/;
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pepper = "integration-verification-pepper-32-characters-minimum";

function databaseUrlFor(databaseName: string): string {
  const url = new URL(sourceDatabaseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quotedVerificationDatabase(): string {
  if (!verificationDatabasePattern.test(verificationDatabase)) {
    throw new Error(`Unsafe disposable database identifier: ${verificationDatabase}`);
  }
  return `"${verificationDatabase}"`;
}

async function applyCurrentMigrations(databaseUrl: string): Promise<void> {
  const executable =
    process.platform === "win32"
      ? (process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe")
      : "pnpm";
  const commandArgs =
    process.platform === "win32"
      ? ["/d", "/s", "/c", "pnpm.cmd", "--filter", "@schedule/database", "run", "db:migrate"]
      : ["--filter", "@schedule/database", "run", "db:migrate"];

  await new Promise<void>((resolve, reject) => {
    const output: Buffer[] = [];
    const child = spawn(executable, commandArgs, {
      cwd: repositoryRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl, NODE_ENV: "test" },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => output.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const diagnostic = Buffer.concat(output)
        .toString("utf8")
        .replaceAll(databaseUrl, "[DISPOSABLE_DATABASE_URL]")
        .trim();
      reject(
        new Error(
          `Disposable integration database migration failed with exit code ${String(code)}${
            diagnostic === "" ? "" : `: ${diagnostic}`
          }`,
        ),
      );
    });
  });
}

interface CredentialFixture {
  readonly id: string;
  readonly secret: string;
  readonly token: string;
  readonly secretDigest: string;
}

interface PreparedEnvelope {
  readonly version: typeof VERSION;
  readonly requestId: string;
  readonly data: PreparedIntegrationCommand;
}

interface ConfirmedEnvelope {
  readonly version: typeof VERSION;
  readonly requestId: string;
  readonly data: ConfirmedIntegrationCommandResult;
}

interface ErrorEnvelope {
  readonly error: { readonly code: string };
  readonly requestId: string;
}

interface IntegrationWorkItem {
  readonly id: string;
  readonly workspaceId: string;
  readonly parentWorkItemId: string | null;
  readonly title: string;
  readonly description: string | null;
  readonly status: string;
  readonly priority: string;
  readonly planningDurationMinutes: number | null;
  readonly dueOn: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface IntegrationWorkItemListEnvelope {
  readonly version: typeof VERSION;
  readonly requestId: string;
  readonly data: {
    readonly items: readonly IntegrationWorkItem[];
    readonly page: { readonly limit: number; readonly offset: number };
  };
}

function authorization(token: string): { readonly authorization: string } {
  return { authorization: `Bearer ${token}` };
}

function assertError(
  response: { readonly statusCode: number; readonly body: string; json<T>(): T },
  expectedStatus: number,
  expectedCode: string,
): void {
  assert.equal(response.statusCode, expectedStatus, response.body);
  assert.equal(response.json<ErrorEnvelope>().error.code, expectedCode);
}

interface CleanupStep {
  readonly label: string;
  readonly run: () => Promise<unknown>;
}

async function collectCleanupFailures(steps: readonly CleanupStep[]): Promise<readonly string[]> {
  const failures: string[] = [];
  for (const step of steps) {
    try {
      await step.run();
    } catch {
      // Deliberately retain only a fixed label: driver errors can contain database URLs.
      failures.push(step.label);
    }
  }
  return failures;
}

async function verifyCleanupFailureCollection(): Promise<void> {
  let laterStepRan = false;
  const failures = await collectCleanupFailures([
    {
      label: "verification probe",
      run: async () => {
        throw new Error("diagnostic content must not escape");
      },
    },
    {
      label: "later probe",
      run: async () => {
        laterStepRan = true;
      },
    },
  ]);
  assert.deepEqual(failures, ["verification probe"]);
  assert.equal(laterStepRan, true, "cleanup must continue after an earlier close failure");
  assert.equal(failures.join(" ").includes("diagnostic content"), false);
}

const adminConnection = createDatabase(databaseUrlFor("postgres"), 1);
const disposableDatabaseUrl = databaseUrlFor(verificationDatabase);
let connection: DatabaseConnection | null = null;
let app: Awaited<ReturnType<typeof buildApp>> | null = null;
let databaseCreated = false;
let verificationFailed = false;
let verificationFailure: unknown;

try {
  await verifyCleanupFailureCollection();
  await adminConnection.sql.unsafe(`create database ${quotedVerificationDatabase()}`);
  databaseCreated = true;
  await applyCurrentMigrations(disposableDatabaseUrl);

  const activeConnection = createDatabase(disposableDatabaseUrl, 4);
  connection = activeConnection;
  const productUnitOfWork = new PostgresUnitOfWork(activeConnection);
  const integrationUnitOfWork = new PostgresIntegrationUnitOfWork(activeConnection);
  let now = new Date("2026-07-15T07:00:00.000Z");
  const clock = { now: () => new Date(now) };
  app = await buildApp({
    readinessCheck: async () => {
      await activeConnection.sql`select 1`;
    },
    productServices: createProductServices(productUnitOfWork, clock),
    integrationServices: createIntegrationServices(integrationUnitOfWork, clock, pepper, 60),
    integrationApiLimits: { requestsPerMinute: 1_000 },
  });

  const createWorkspace = async (name: string): Promise<string> => {
    const response = await app!.inject({
      method: "POST",
      url: "/v1/workspaces",
      payload: { name },
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json<{ id: string }>().id;
  };

  const primaryWorkspaceId = await createWorkspace("Integration gateway verification");
  const isolatedWorkspaceId = await createWorkspace("Integration gateway isolation verification");

  const notificationProfile = await app.inject({
    method: "PUT",
    url: `/v1/workspaces/${primaryWorkspaceId}/notification-profile`,
    payload: {
      expectedVersion: null,
      timeZone: "UTC",
      quietHoursStartMinute: null,
      quietHoursEndMinute: null,
      quietHoursPolicy: "next_allowed",
      catchUpWindowMinutes: 0,
      dailyIntentLimit: 100,
    },
  });
  assert.equal(notificationProfile.statusCode, 200, notificationProfile.body);
  for (const payload of [
    { kind: "work_item_due", localMinute: 480 },
    { kind: "schedule_block_lead", leadMinutes: 15 },
  ]) {
    const response: { readonly statusCode: number; readonly body: string } = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${primaryWorkspaceId}/notification-rules`,
      payload,
    });
    assert.equal(response.statusCode, 201, response.body);
  }

  const materializeNotifications = async () => {
    const response = await app!.inject({
      method: "POST",
      url: `/v1/workspaces/${primaryWorkspaceId}/notification-intents/materializations`,
      payload: {
        from: "2026-07-15T07:00:00.000Z",
        through: "2026-07-18T00:00:00.000Z",
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    return response;
  };

  const provisionCredential = async (
    targetWorkspaceId: string,
    name: string,
    scopes: readonly ("schedule:read" | "schedule:write")[],
  ): Promise<CredentialFixture> => {
    const secret = generateIntegrationCredentialSecret();
    const secretDigest = hashIntegrationCredentialSecret(secret, pepper);
    const credential = await new ProvisionIntegrationCredential(
      integrationUnitOfWork,
      clock,
    ).execute({
      workspaceId: workspaceId(targetWorkspaceId),
      name,
      scopes,
      secretHash: secretDigest,
    });
    return {
      id: credential.id,
      secret,
      token: `${credential.id}.${secret}`,
      secretDigest,
    };
  };

  const primaryCredential = await provisionCredential(primaryWorkspaceId, "Primary verifier", [
    "schedule:read",
    "schedule:write",
  ]);
  const isolatedCredential = await provisionCredential(isolatedWorkspaceId, "Isolation verifier", [
    "schedule:read",
    "schedule:write",
  ]);
  const readOnlyCredential = await provisionCredential(primaryWorkspaceId, "Read only", [
    "schedule:read",
  ]);
  const writeOnlyCredential = await provisionCredential(primaryWorkspaceId, "Write only", [
    "schedule:write",
  ]);

  // EVIDENCE: integration-gateway-digest-only-credentials
  // The production provisioning path stores only a one-way digest; plaintext never enters a row.
  const [storedCredential] = await connection.sql<{ secret_digest: string; stored: string }[]>`
    select secret_digest, row_to_json(integration_credentials)::text as stored
    from integration_credentials
    where id = ${primaryCredential.id}
  `;
  assert.equal(storedCredential?.secret_digest, primaryCredential.secretDigest);
  assert.equal(storedCredential?.stored.includes(primaryCredential.secret), false);
  assert.equal(storedCredential?.stored.includes(primaryCredential.token), false);

  const missingAuthorization = await app.inject({
    method: "GET",
    url: `/v1/integrations/today?date=${PLAN_DATE}`,
  });
  assertError(missingAuthorization, 401, "integration.authentication_failed");

  const wrongSecret = generateIntegrationCredentialSecret();
  const wrongAuthorization = await app.inject({
    method: "GET",
    url: `/v1/integrations/today?date=${PLAN_DATE}`,
    headers: authorization(`${primaryCredential.id}.${wrongSecret}`),
  });
  assertError(wrongAuthorization, 401, "integration.authentication_failed");
  assert.equal(wrongAuthorization.body.includes(wrongSecret), false);

  const readScopeDenied = await app.inject({
    method: "GET",
    url: `/v1/integrations/today?date=${PLAN_DATE}`,
    headers: authorization(writeOnlyCredential.token),
  });
  assertError(readScopeDenied, 403, "integration.scope_denied");
  const writeScopeDenied = await app.inject({
    method: "POST",
    url: "/v1/integrations/commands/prepare",
    headers: authorization(readOnlyCredential.token),
    payload: {
      version: VERSION,
      requestId: randomUUID(),
      command: { type: "work_item.create", title: "Scope denied" },
    },
  });
  assertError(writeScopeDenied, 403, "integration.scope_denied");

  const prepare = async (
    token: string,
    requestId: string,
    command: IntegrationCommand,
  ): Promise<{ readonly response: PreparedEnvelope; readonly rawBody: string }> => {
    const response = await app!.inject({
      method: "POST",
      url: "/v1/integrations/commands/prepare",
      headers: authorization(token),
      payload: { version: VERSION, requestId, command },
    });
    assert.equal(response.statusCode, 201, response.body);
    return { response: response.json<PreparedEnvelope>(), rawBody: response.body };
  };

  const confirm = async (
    token: string,
    confirmationId: string,
    idempotencyKey: string,
  ): Promise<{ readonly response: ConfirmedEnvelope; readonly rawBody: string }> => {
    const response = await app!.inject({
      method: "POST",
      url: "/v1/integrations/commands/confirm",
      headers: { ...authorization(token), "idempotency-key": idempotencyKey },
      payload: { version: VERSION, confirmationId },
    });
    assert.equal(response.statusCode, 200, response.body);
    return { response: response.json<ConfirmedEnvelope>(), rawBody: response.body };
  };

  const createRequestId = randomUUID();
  const createCommand = {
    type: "work_item.create",
    title: "Gateway-planned work",
    description: "Created through the authenticated integration boundary",
    status: "planned",
    priority: "high",
    planningDurationMinutes: 30,
    dueOn: "2026-07-16",
  } as const satisfies IntegrationCommand;
  // EVIDENCE: integration-gateway-concurrent-prepare-exclusion
  // Same-request preparation races converge on one confirmation and one preparation audit.
  const concurrentPrepares = await Promise.all(
    Array.from({ length: 4 }, () =>
      prepare(primaryCredential.token, createRequestId, createCommand),
    ),
  );
  const preparedCreate = concurrentPrepares[0];
  assert.ok(preparedCreate);
  for (const replayedPrepare of concurrentPrepares.slice(1)) {
    assert.deepEqual(replayedPrepare.response.data, preparedCreate.response.data);
  }
  const [prepareRaceState] = await connection.sql<
    { confirmation_count: number; prepared_audit_count: number }[]
  >`
    select
      (
        select count(*)::int
        from integration_confirmations
        where credential_id = ${primaryCredential.id}
          and request_id = ${createRequestId}
      ) as confirmation_count,
      (
        select count(*)::int
        from audit_events
        where workspace_id = ${primaryWorkspaceId}
          and action = 'integration.command_prepared'
          and data ->> 'requestId' = ${createRequestId}
      ) as prepared_audit_count
  `;
  assert.equal(prepareRaceState?.confirmation_count, 1);
  assert.equal(prepareRaceState?.prepared_audit_count, 1);

  const conflictingPrepare = await app.inject({
    method: "POST",
    url: "/v1/integrations/commands/prepare",
    headers: authorization(primaryCredential.token),
    payload: {
      version: VERSION,
      requestId: createRequestId,
      command: { ...createCommand, title: "Conflicting preparation" },
    },
  });
  assertError(conflictingPrepare, 409, "integration.request_conflict");
  const [workBeforeConfirmation] = await connection.sql<{ count: number }[]>`
    select count(*)::int as count
    from work_items
    where workspace_id = ${primaryWorkspaceId} and title = ${createCommand.title}
  `;
  assert.equal(workBeforeConfirmation?.count, 0, "prepare must not mutate product state");

  const createIdempotencyKey = "verify-work-item-create";
  // EVIDENCE: integration-gateway-concurrent-confirm-exclusion
  // Same-key confirmation races execute once and all callers receive the durable result.
  const concurrentConfirms = await Promise.all(
    Array.from({ length: 4 }, () =>
      confirm(
        primaryCredential.token,
        preparedCreate.response.data.confirmationId,
        createIdempotencyKey,
      ),
    ),
  );
  const confirmedCreate = concurrentConfirms[0];
  assert.ok(confirmedCreate);
  for (const replayedCreate of concurrentConfirms.slice(1)) {
    assert.deepEqual(replayedCreate.response.data, confirmedCreate.response.data);
  }
  assert.equal(confirmedCreate.response.data.outcome.type, "work_item.created");
  assert.equal(confirmedCreate.response.data.receiptVersion, 2);
  const createdWorkItem = confirmedCreate.response.data.outcome.workItem as {
    readonly id: string;
    readonly version: number;
    readonly dueOn: string | null;
  };
  assert.equal(createdWorkItem.dueOn, "2026-07-16");
  await materializeNotifications();
  const [initialDueIntent] = await connection.sql<{ count: number }[]>`
    select count(*)::int as count from notification_intents
    where workspace_id = ${primaryWorkspaceId} and work_item_id = ${createdWorkItem.id}
  `;
  assert.equal(initialDueIntent?.count, 1);
  const [confirmRaceState] = await connection.sql<
    {
      product_count: number;
      succeeded_receipt_count: number;
      consumed_confirmation_count: number;
      confirmed_audit_count: number;
    }[]
  >`
    select
      (
        select count(*)::int
        from work_items
        where workspace_id = ${primaryWorkspaceId}
          and id = ${createdWorkItem.id}
      ) as product_count,
      (
        select count(*)::int
        from integration_requests
        where credential_id = ${primaryCredential.id}
          and idempotency_key = ${createIdempotencyKey}
          and status = 'succeeded'
      ) as succeeded_receipt_count,
      (
        select count(*)::int
        from integration_confirmations
        where credential_id = ${primaryCredential.id}
          and id = ${preparedCreate.response.data.confirmationId}
          and consumed_at is not null
      ) as consumed_confirmation_count,
      (
        select count(*)::int
        from audit_events
        where workspace_id = ${primaryWorkspaceId}
          and action = 'integration.command_confirmed'
          and data ->> 'confirmationId' = ${preparedCreate.response.data.confirmationId}
      ) as confirmed_audit_count
  `;
  assert.equal(confirmRaceState?.product_count, 1);
  assert.equal(confirmRaceState?.succeeded_receipt_count, 1);
  assert.equal(confirmRaceState?.consumed_confirmation_count, 1);
  assert.equal(confirmRaceState?.confirmed_audit_count, 1);

  const updateCommand = {
    type: "work_item.update",
    workItemId: createdWorkItem.id,
    expectedVersion: createdWorkItem.version,
    title: "Gateway-planned work updated",
    status: "in_progress",
    dueOn: "2026-07-17",
  } as const satisfies IntegrationCommand;
  const preparedUpdate = await prepare(primaryCredential.token, randomUUID(), updateCommand);
  const reusedIdempotencyKey = await app.inject({
    method: "POST",
    url: "/v1/integrations/commands/confirm",
    headers: {
      ...authorization(primaryCredential.token),
      "idempotency-key": createIdempotencyKey,
    },
    payload: {
      version: VERSION,
      confirmationId: preparedUpdate.response.data.confirmationId,
    },
  });
  assertError(reusedIdempotencyKey, 409, "integration.receipt_conflict");

  const updateIdempotencyKey = "verify-work-item-update";
  const confirmedUpdate = await confirm(
    primaryCredential.token,
    preparedUpdate.response.data.confirmationId,
    updateIdempotencyKey,
  );
  assert.equal(confirmedUpdate.response.data.outcome.type, "work_item.updated");
  const updatedWorkItem = confirmedUpdate.response.data.outcome.workItem as {
    readonly id: string;
    readonly title: string;
    readonly version: number;
    readonly dueOn: string | null;
  };
  assert.equal(updatedWorkItem.title, "Gateway-planned work updated");
  assert.equal(updatedWorkItem.version, 2);
  assert.equal(updatedWorkItem.dueOn, "2026-07-17");
  const [dueIntentAfterGatewayUpdate] = await connection.sql<{ count: number }[]>`
    select count(*)::int as count from notification_intents
    where workspace_id = ${primaryWorkspaceId} and work_item_id = ${createdWorkItem.id}
  `;
  assert.equal(
    dueIntentAfterGatewayUpdate?.count,
    0,
    "confirmed gateway work-item updates must invalidate pending reminder intents",
  );
  const replayedUpdate = await confirm(
    primaryCredential.token,
    preparedUpdate.response.data.confirmationId,
    updateIdempotencyKey,
  );
  assert.deepEqual(replayedUpdate.response.data, confirmedUpdate.response.data);
  await materializeNotifications();

  // EVIDENCE: integration-gateway-work-item-deadline-clear
  // Confirmed gateway mutations preserve calendar dates and can explicitly clear them.
  const preparedDeadlineClear = await prepare(primaryCredential.token, randomUUID(), {
    type: "work_item.update",
    workItemId: createdWorkItem.id,
    expectedVersion: updatedWorkItem.version,
    dueOn: null,
  });
  const confirmedDeadlineClear = await confirm(
    primaryCredential.token,
    preparedDeadlineClear.response.data.confirmationId,
    "verify-work-item-deadline-clear",
  );
  assert.equal(confirmedDeadlineClear.response.data.outcome.type, "work_item.updated");
  assert.equal(confirmedDeadlineClear.response.data.outcome.workItem.dueOn, null);
  assert.equal(confirmedDeadlineClear.response.data.outcome.workItem.version, 3);
  const [dueIntentAfterGatewayClear] = await connection.sql<{ count: number }[]>`
    select count(*)::int as count from notification_intents
    where workspace_id = ${primaryWorkspaceId} and work_item_id = ${createdWorkItem.id}
  `;
  assert.equal(dueIntentAfterGatewayClear?.count, 0);

  const consumedWithNewKey = await app.inject({
    method: "POST",
    url: "/v1/integrations/commands/confirm",
    headers: {
      ...authorization(primaryCredential.token),
      "idempotency-key": "verify-work-item-update-new-key",
    },
    payload: {
      version: VERSION,
      confirmationId: preparedUpdate.response.data.confirmationId,
    },
  });
  assertError(consumedWithNewKey, 410, "integration.confirmation_consumed");

  const blockCreateCommand = {
    type: "schedule_block.create",
    workItemId: createdWorkItem.id,
    title: "Gateway calendar block",
    startsAt: "2026-07-15T10:00:00.000Z",
    endsAt: "2026-07-15T10:30:00.000Z",
    timeZone: "UTC",
  } as const satisfies IntegrationCommand;
  const preparedBlockCreate = await prepare(
    primaryCredential.token,
    randomUUID(),
    blockCreateCommand,
  );
  const crossCredentialConfirmation = await app.inject({
    method: "POST",
    url: "/v1/integrations/commands/confirm",
    headers: {
      ...authorization(isolatedCredential.token),
      "idempotency-key": "verify-cross-credential-rejected",
    },
    payload: {
      version: VERSION,
      confirmationId: preparedBlockCreate.response.data.confirmationId,
    },
  });
  assertError(crossCredentialConfirmation, 404, "integration.confirmation_not_found");
  const [unconsumedAfterCrossCredential] = await connection.sql<{ consumed_at: string | null }[]>`
    select consumed_at::text as consumed_at
    from integration_confirmations
    where id = ${preparedBlockCreate.response.data.confirmationId}
  `;
  assert.equal(unconsumedAfterCrossCredential?.consumed_at, null);

  const confirmedBlockCreate = await confirm(
    primaryCredential.token,
    preparedBlockCreate.response.data.confirmationId,
    "verify-schedule-block-create",
  );
  assert.equal(confirmedBlockCreate.response.data.outcome.type, "schedule_block.created");
  const createdScheduleBlock = confirmedBlockCreate.response.data.outcome.scheduleBlock as {
    readonly id: string;
    readonly version: number;
  };
  await materializeNotifications();
  const [initialBlockIntent] = await connection.sql<{ count: number }[]>`
    select count(*)::int as count from notification_intents
    where workspace_id = ${primaryWorkspaceId} and schedule_block_id = ${createdScheduleBlock.id}
  `;
  assert.equal(initialBlockIntent?.count, 1);

  const preparedBlockUpdate = await prepare(primaryCredential.token, randomUUID(), {
    type: "schedule_block.update",
    scheduleBlockId: createdScheduleBlock.id,
    expectedVersion: createdScheduleBlock.version,
    title: "Gateway calendar block updated",
    endsAt: "2026-07-15T10:45:00.000Z",
  });
  const confirmedBlockUpdate = await confirm(
    primaryCredential.token,
    preparedBlockUpdate.response.data.confirmationId,
    "verify-schedule-block-update",
  );
  assert.equal(confirmedBlockUpdate.response.data.outcome.type, "schedule_block.updated");
  assert.equal(
    (confirmedBlockUpdate.response.data.outcome.scheduleBlock as { title: string }).title,
    "Gateway calendar block updated",
  );
  const [blockIntentAfterGatewayUpdate] = await connection.sql<{ count: number }[]>`
    select count(*)::int as count from notification_intents
    where workspace_id = ${primaryWorkspaceId} and schedule_block_id = ${createdScheduleBlock.id}
  `;
  assert.equal(
    blockIntentAfterGatewayUpdate?.count,
    0,
    "confirmed gateway schedule-block updates must invalidate pending reminder intents",
  );

  const expiredRequestId = randomUUID();
  const preparedExpired = await prepare(primaryCredential.token, expiredRequestId, {
    type: "work_item.create",
    title: "Expired command must not run",
  });
  now = new Date(now.getTime() + 61_000);
  const expiredConfirmation = await app.inject({
    method: "POST",
    url: "/v1/integrations/commands/confirm",
    headers: {
      ...authorization(primaryCredential.token),
      "idempotency-key": "verify-expired-confirmation",
    },
    payload: {
      version: VERSION,
      confirmationId: preparedExpired.response.data.confirmationId,
    },
  });
  assertError(expiredConfirmation, 410, "integration.confirmation_expired");
  const [expiredState] = await connection.sql<
    { consumed_at: string | null; request_count: number; work_count: number }[]
  >`
    select
      c.consumed_at::text as consumed_at,
      (select count(*)::int from integration_requests where idempotency_key = 'verify-expired-confirmation') as request_count,
      (select count(*)::int from work_items where title = 'Expired command must not run') as work_count
    from integration_confirmations c
    where c.id = ${preparedExpired.response.data.confirmationId}
  `;
  assert.equal(expiredState?.consumed_at, null);
  assert.equal(expiredState?.request_count, 0);
  assert.equal(expiredState?.work_count, 0);

  const preparedStaleUpdate = await prepare(primaryCredential.token, randomUUID(), {
    type: "work_item.update",
    workItemId: createdWorkItem.id,
    expectedVersion: 1,
    title: "A stale update must roll back",
  });
  const staleIdempotencyKey = "verify-stale-update-rollback";
  const staleConfirmation = await app.inject({
    method: "POST",
    url: "/v1/integrations/commands/confirm",
    headers: {
      ...authorization(primaryCredential.token),
      "idempotency-key": staleIdempotencyKey,
    },
    payload: {
      version: VERSION,
      confirmationId: preparedStaleUpdate.response.data.confirmationId,
    },
  });
  assertError(staleConfirmation, 409, "work_item.version_conflict");
  // EVIDENCE: integration-gateway-atomic-confirmation-rollback
  // Reservation, confirmation consumption, product mutation, audit, and result commit atomically.
  const [rollbackState] = await connection.sql<
    {
      title: string;
      version: number;
      consumed_at: string | null;
      request_count: number;
      confirmed_audit_count: number;
    }[]
  >`
    select
      w.title,
      w.version,
      c.consumed_at::text as consumed_at,
      (select count(*)::int from integration_requests where idempotency_key = ${staleIdempotencyKey}) as request_count,
      (
        select count(*)::int
        from audit_events
        where action = 'integration.command_confirmed'
          and data ->> 'confirmationId' = ${preparedStaleUpdate.response.data.confirmationId}
      ) as confirmed_audit_count
    from work_items w
    cross join integration_confirmations c
    where w.id = ${createdWorkItem.id}
      and c.id = ${preparedStaleUpdate.response.data.confirmationId}
  `;
  assert.equal(rollbackState?.title, "Gateway-planned work updated");
  assert.equal(rollbackState?.version, 3);
  assert.equal(rollbackState?.consumed_at, null);
  assert.equal(rollbackState?.request_count, 0);
  assert.equal(rollbackState?.confirmed_audit_count, 0);

  const createIsolatedWorkItem = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${isolatedWorkspaceId}/work-items`,
    payload: {
      title: "Isolated Today candidate",
      status: "planned",
      priority: "medium",
      planningDurationMinutes: 30,
    },
  });
  assert.equal(createIsolatedWorkItem.statusCode, 201, createIsolatedWorkItem.body);

  const createPrimaryDiscoveryCandidate = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${primaryWorkspaceId}/work-items`,
    payload: {
      title: "Gateway discovery candidate",
      description: "Returned by the authenticated discovery endpoint",
      status: "blocked",
      priority: "urgent",
      planningDurationMinutes: 45,
      dueOn: "2026-07-18",
    },
  });
  assert.equal(
    createPrimaryDiscoveryCandidate.statusCode,
    201,
    createPrimaryDiscoveryCandidate.body,
  );
  const primaryDiscoveryCandidate = createPrimaryDiscoveryCandidate.json<{ id: string }>();

  const createPrimaryPaginationCandidate = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${primaryWorkspaceId}/work-items`,
    payload: {
      title: "Gateway pagination candidate",
      status: "cancelled",
      priority: "low",
      planningDurationMinutes: 20,
    },
  });
  assert.equal(
    createPrimaryPaginationCandidate.statusCode,
    201,
    createPrimaryPaginationCandidate.body,
  );
  const primaryPaginationCandidate = createPrimaryPaginationCandidate.json<{ id: string }>();

  interface DiscoveryReadState {
    readonly primary_work_item_count: number;
    readonly isolated_work_item_count: number;
    readonly total_work_item_count: number;
    readonly primary_audit_count: number;
    readonly isolated_audit_count: number;
    readonly total_audit_count: number;
    readonly primary_integration_audit_count: number;
    readonly isolated_integration_audit_count: number;
    readonly total_integration_audit_count: number;
    readonly integration_request_count: number;
    readonly integration_confirmation_count: number;
    readonly work_item_snapshot: string;
    readonly credential_snapshot: string;
    readonly integration_request_snapshot: string;
    readonly integration_confirmation_snapshot: string;
    readonly audit_event_snapshot: string;
    readonly primary_item_version: number;
  }

  const snapshotDiscoveryReadState = async (): Promise<DiscoveryReadState> => {
    const [state] = await connection!.sql<DiscoveryReadState[]>`
      select
        (select count(*)::int from work_items where workspace_id = ${primaryWorkspaceId}) as primary_work_item_count,
        (select count(*)::int from work_items where workspace_id = ${isolatedWorkspaceId}) as isolated_work_item_count,
        (select count(*)::int from work_items) as total_work_item_count,
        (select count(*)::int from audit_events where workspace_id = ${primaryWorkspaceId}) as primary_audit_count,
        (select count(*)::int from audit_events where workspace_id = ${isolatedWorkspaceId}) as isolated_audit_count,
        (select count(*)::int from audit_events) as total_audit_count,
        (select count(*)::int from audit_events where workspace_id = ${primaryWorkspaceId} and action like 'integration.%') as primary_integration_audit_count,
        (select count(*)::int from audit_events where workspace_id = ${isolatedWorkspaceId} and action like 'integration.%') as isolated_integration_audit_count,
        (select count(*)::int from audit_events where action like 'integration.%') as total_integration_audit_count,
        (select count(*)::int from integration_requests) as integration_request_count,
        (select count(*)::int from integration_confirmations) as integration_confirmation_count,
        (
          select coalesce(jsonb_agg(to_jsonb(w) order by w.created_at, w.id)::text, '[]')
          from work_items w
        ) as work_item_snapshot,
        (
          select coalesce(
            jsonb_agg(to_jsonb(c) order by c.id)::text,
            '[]'
          )
          from integration_credentials c
        ) as credential_snapshot,
        (
          select coalesce(jsonb_agg(to_jsonb(r) order by r.created_at, r.id)::text, '[]')
          from integration_requests r
        ) as integration_request_snapshot,
        (
          select coalesce(jsonb_agg(to_jsonb(c) order by c.created_at, c.id)::text, '[]')
          from integration_confirmations c
        ) as integration_confirmation_snapshot,
        (
          select coalesce(jsonb_agg(to_jsonb(a) order by a.occurred_at, a.id)::text, '[]')
          from audit_events a
        ) as audit_event_snapshot,
        (select version from work_items where id = ${createdWorkItem.id}) as primary_item_version
    `;
    assert.ok(state);
    return state;
  };

  const workItemDiscoveryStateBefore = await snapshotDiscoveryReadState();

  const listIntegrationWorkItems = async (
    token: string,
    query = "",
  ): Promise<{ readonly response: IntegrationWorkItemListEnvelope; readonly rawBody: string }> => {
    const response = await app!.inject({
      method: "GET",
      url: `/v1/integrations/work-items${query === "" ? "" : `?${query}`}`,
      headers: authorization(token),
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(response.headers["cache-control"], "no-store");
    return { response: response.json<IntegrationWorkItemListEnvelope>(), rawBody: response.body };
  };

  // EVIDENCE: integration-gateway-work-item-discovery
  // Discovery is read-only and credential-tenant-bound: adapters can enumerate current IDs/versions
  // before preparing optimistic writes, without selecting a workspace themselves.
  const readOnlyDiscovery = await listIntegrationWorkItems(
    readOnlyCredential.token,
    "status=blocked&priority=urgent&limit=10&offset=0",
  );
  assert.equal(readOnlyDiscovery.response.version, VERSION);
  assert.notEqual(readOnlyDiscovery.response.requestId, "");
  assert.deepEqual(readOnlyDiscovery.response.data.page, { limit: 10, offset: 0 });
  assert.equal(readOnlyDiscovery.response.data.items.length, 1);
  const discoveredCandidate = readOnlyDiscovery.response.data.items[0];
  assert.ok(discoveredCandidate);
  assert.equal(discoveredCandidate.id, primaryDiscoveryCandidate.id);
  assert.equal(discoveredCandidate.workspaceId, primaryWorkspaceId);
  assert.equal(discoveredCandidate.status, "blocked");
  assert.equal(discoveredCandidate.priority, "urgent");
  assert.equal(discoveredCandidate.planningDurationMinutes, 45);
  assert.equal(discoveredCandidate.dueOn, "2026-07-18");
  assert.equal(discoveredCandidate.version, 1);
  assert.equal(discoveredCandidate.title, "Gateway discovery candidate");
  assert.equal(discoveredCandidate.description, "Returned by the authenticated discovery endpoint");
  assert.equal(discoveredCandidate.createdAt, now.toISOString());
  assert.equal(discoveredCandidate.updatedAt, now.toISOString());
  assert.equal(
    new Date(discoveredCandidate.createdAt).toISOString(),
    discoveredCandidate.createdAt,
  );
  assert.equal(
    new Date(discoveredCandidate.updatedAt).toISOString(),
    discoveredCandidate.updatedAt,
  );

  const statusOnlyDiscovery = await listIntegrationWorkItems(
    readOnlyCredential.token,
    "status=blocked&limit=10&offset=0",
  );
  assert.deepEqual(
    statusOnlyDiscovery.response.data.items.map((item) => item.id),
    [primaryDiscoveryCandidate.id],
  );
  const priorityOnlyDiscovery = await listIntegrationWorkItems(
    readOnlyCredential.token,
    "priority=urgent&limit=10&offset=0",
  );
  assert.deepEqual(
    priorityOnlyDiscovery.response.data.items.map((item) => item.id),
    [primaryDiscoveryCandidate.id],
  );

  const defaultDiscovery = await listIntegrationWorkItems(readOnlyCredential.token);
  assert.deepEqual(defaultDiscovery.response.data.page, { limit: 100, offset: 0 });

  const workItemDiscoveryScopeDenied = await app.inject({
    method: "GET",
    url: "/v1/integrations/work-items",
    headers: authorization(writeOnlyCredential.token),
  });
  assertError(workItemDiscoveryScopeDenied, 403, "integration.scope_denied");

  const workItemDiscoveryWorkspaceOverride = await app.inject({
    method: "GET",
    url: `/v1/integrations/work-items?workspaceId=${isolatedWorkspaceId}`,
    headers: authorization(primaryCredential.token),
  });
  assertError(workItemDiscoveryWorkspaceOverride, 400, "request.validation_failed");

  const invalidPaginationQueries = ["limit=0", "limit=201", "offset=1000001"];
  for (const field of ["limit", "offset"] as const) {
    for (const invalidValue of ["", "%20", "-1", "%2B1", "1.0", "1e2", "0x1", "01"]) {
      invalidPaginationQueries.push(`${field}=${invalidValue}`);
    }
  }
  for (const invalidPaginationQuery of invalidPaginationQueries) {
    const invalidPagination = await app.inject({
      method: "GET",
      url: `/v1/integrations/work-items?${invalidPaginationQuery}`,
      headers: authorization(primaryCredential.token),
    });
    assertError(invalidPagination, 400, "request.validation_failed");
  }

  const maximumPaging = await listIntegrationWorkItems(
    primaryCredential.token,
    "limit=200&offset=1000000",
  );
  assert.deepEqual(maximumPaging.response.data.page, { limit: 200, offset: 1_000_000 });
  assert.deepEqual(maximumPaging.response.data.items, []);

  const primaryPageZero = await listIntegrationWorkItems(
    primaryCredential.token,
    "limit=1&offset=0",
  );
  const primaryPageZeroReplay = await listIntegrationWorkItems(
    primaryCredential.token,
    "limit=1&offset=0",
  );
  const primaryPageOne = await listIntegrationWorkItems(
    primaryCredential.token,
    "limit=1&offset=1",
  );
  assert.deepEqual(primaryPageZero.response.data.page, { limit: 1, offset: 0 });
  assert.deepEqual(primaryPageOne.response.data.page, { limit: 1, offset: 1 });
  assert.equal(primaryPageZero.response.data.items.length, 1);
  assert.equal(primaryPageOne.response.data.items.length, 1);
  assert.deepEqual(primaryPageZero.response.data.items, primaryPageZeroReplay.response.data.items);
  const expectedPrimaryDiscoveryOrder = [
    createdWorkItem.id,
    ...[primaryDiscoveryCandidate.id, primaryPaginationCandidate.id].sort(),
  ];
  assert.equal(primaryPageZero.response.data.items[0]?.id, expectedPrimaryDiscoveryOrder[0]);
  assert.equal(primaryPageOne.response.data.items[0]?.id, expectedPrimaryDiscoveryOrder[1]);
  assert.equal(
    primaryPageZero.response.data.items.some((item) => item.workspaceId === isolatedWorkspaceId),
    false,
  );
  assert.equal(
    primaryPageOne.response.data.items.some((item) => item.workspaceId === isolatedWorkspaceId),
    false,
  );

  const primaryFullDiscovery = await listIntegrationWorkItems(
    primaryCredential.token,
    "limit=200&offset=0",
  );
  assert.deepEqual(primaryFullDiscovery.response.data.page, { limit: 200, offset: 0 });
  assert.deepEqual(
    primaryFullDiscovery.response.data.items.map((item) => item.id),
    expectedPrimaryDiscoveryOrder,
  );
  assert.equal(
    primaryFullDiscovery.response.data.items.every(
      (item) => item.workspaceId === primaryWorkspaceId,
    ),
    true,
  );
  assert.equal(
    primaryFullDiscovery.response.data.items.some((item) => item.id === createdWorkItem.id),
    true,
  );
  assert.equal(
    primaryFullDiscovery.response.data.items.some(
      (item) => item.id === primaryDiscoveryCandidate.id,
    ),
    true,
  );
  assert.equal(
    primaryFullDiscovery.response.data.items.some(
      (item) => item.id === primaryPaginationCandidate.id,
    ),
    true,
  );

  const isolatedDiscovery = await listIntegrationWorkItems(
    isolatedCredential.token,
    "limit=10&offset=0",
  );
  assert.equal(isolatedDiscovery.response.data.items.length, 1);
  assert.equal(isolatedDiscovery.response.data.items[0]?.workspaceId, isolatedWorkspaceId);
  assert.equal(
    isolatedDiscovery.response.data.items.some((item) => item.id === createdWorkItem.id),
    false,
  );
  assert.equal(
    isolatedDiscovery.response.data.items.some((item) => item.id === primaryDiscoveryCandidate.id),
    false,
  );

  const workItemDiscoveryStateAfter = await snapshotDiscoveryReadState();
  assert.deepEqual(workItemDiscoveryStateAfter, workItemDiscoveryStateBefore);

  const generatePlan = async (targetWorkspaceId: string, seed: string) => {
    const response = await app!.inject({
      method: "POST",
      url: `/v1/workspaces/${targetWorkspaceId}/plans`,
      payload: {
        date: PLAN_DATE,
        timeZone: "UTC",
        availableWindows: [
          {
            startsAt: "2026-07-15T08:00:00.000Z",
            endsAt: "2026-07-15T09:00:00.000Z",
          },
        ],
        targetMinutes: 30,
        targetTaskCount: 1,
        availableContexts: [],
        seed,
        requestRevision: 1,
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json<{
      id: string;
      items: { id: string; workItemId: string | null }[];
    }>();
  };

  const primaryPlan = await generatePlan(primaryWorkspaceId, "integration-primary-plan");
  const isolatedPlan = await generatePlan(isolatedWorkspaceId, "integration-isolated-plan");
  assert.notEqual(primaryPlan.id, isolatedPlan.id);
  assert.equal(primaryPlan.items[0]?.workItemId, createdWorkItem.id);

  // EVIDENCE: integration-gateway-credential-workspace-isolation
  // The caller cannot choose a workspace: Today always uses the authenticated credential tenant.
  const primaryToday = await app.inject({
    method: "GET",
    url: `/v1/integrations/today?date=${PLAN_DATE}`,
    headers: authorization(primaryCredential.token),
  });
  assert.equal(primaryToday.statusCode, 200, primaryToday.body);
  const primaryTodayData = primaryToday.json<{
    data: { workspaceId: string; headVersion: number; plan: { id: string } };
  }>().data;
  assert.equal(primaryTodayData.workspaceId, primaryWorkspaceId);
  assert.equal(primaryTodayData.plan.id, primaryPlan.id);
  assert.equal(primaryTodayData.headVersion, 1);

  const isolatedToday = await app.inject({
    method: "GET",
    url: `/v1/integrations/today?date=${PLAN_DATE}`,
    headers: authorization(isolatedCredential.token),
  });
  assert.equal(isolatedToday.statusCode, 200, isolatedToday.body);
  const isolatedTodayData = isolatedToday.json<{
    data: { workspaceId: string; plan: { id: string } };
  }>().data;
  assert.equal(isolatedTodayData.workspaceId, isolatedWorkspaceId);
  assert.equal(isolatedTodayData.plan.id, isolatedPlan.id);

  const attemptedWorkspaceOverride = await app.inject({
    method: "GET",
    url: `/v1/integrations/today?date=${PLAN_DATE}&workspaceId=${isolatedWorkspaceId}`,
    headers: authorization(primaryCredential.token),
  });
  assertError(attemptedWorkspaceOverride, 400, "request.validation_failed");

  const planItem = primaryPlan.items[0];
  assert.ok(planItem, "the integration verification plan needs one candidate");
  const preparedPlanActivity = await prepare(primaryCredential.token, randomUUID(), {
    type: "plan_item.activity",
    date: PLAN_DATE,
    expectedPlanId: primaryPlan.id,
    itemId: planItem.id,
    expectedHeadVersion: 1,
    activityType: "completed",
    occurredAt: "2026-07-15T08:30:00.000Z",
    timeZone: "UTC",
    durationMinutes: 30,
    metadata: { source: "integration-verifier" },
  });
  const confirmedPlanActivity = await confirm(
    primaryCredential.token,
    preparedPlanActivity.response.data.confirmationId,
    "verify-plan-item-activity",
  );
  assert.equal(confirmedPlanActivity.response.data.outcome.type, "plan_item.activity_recorded");
  const activity = confirmedPlanActivity.response.data.outcome.planItemActivity as {
    readonly itemId: string;
    readonly headVersion: number;
    readonly activityState: string;
  };
  assert.equal(activity.itemId, planItem.id);
  assert.equal(activity.headVersion, 2);
  assert.equal(activity.activityState, "completed");

  // EVIDENCE: integration-gateway-work-item-hierarchy
  // Hermes can discover and safely mutate hierarchy edges through reviewed, durable commands.
  const hierarchyParent = await prepare(primaryCredential.token, randomUUID(), {
    type: "work_item.create",
    title: "Gateway hierarchy alternate parent",
  });
  const confirmedHierarchyParent = await confirm(
    primaryCredential.token,
    hierarchyParent.response.data.confirmationId,
    "verify-hierarchy-parent",
  );
  assert.equal(confirmedHierarchyParent.response.data.outcome.type, "work_item.created");
  const alternateParentId = confirmedHierarchyParent.response.data.outcome.workItem.id;

  const hierarchyChild = await prepare(primaryCredential.token, randomUUID(), {
    type: "work_item.create",
    title: "Gateway hierarchy child",
    parentWorkItemId: createdWorkItem.id,
  });
  assert.equal(hierarchyChild.response.data.command.type, "work_item.create");
  if (hierarchyChild.response.data.command.type !== "work_item.create") {
    throw new Error("unexpected prepared hierarchy command");
  }
  assert.equal(hierarchyChild.response.data.command.parentWorkItemId, createdWorkItem.id);
  const confirmedHierarchyChild = await confirm(
    primaryCredential.token,
    hierarchyChild.response.data.confirmationId,
    "verify-hierarchy-child",
  );
  assert.equal(confirmedHierarchyChild.response.data.outcome.type, "work_item.created");
  const hierarchyChildItem = confirmedHierarchyChild.response.data.outcome.workItem;
  assert.equal(hierarchyChildItem.parentWorkItemId, createdWorkItem.id);

  const hierarchyDiscovery = await listIntegrationWorkItems(primaryCredential.token);
  assert.equal(
    hierarchyDiscovery.response.data.items.find((item) => item.id === hierarchyChildItem.id)
      ?.parentWorkItemId,
    createdWorkItem.id,
  );

  const hierarchyCycle = await prepare(primaryCredential.token, randomUUID(), {
    type: "work_item.update",
    workItemId: createdWorkItem.id,
    expectedVersion: 4,
    parentWorkItemId: hierarchyChildItem.id,
  });
  const rejectedHierarchyCycle = await app.inject({
    method: "POST",
    url: "/v1/integrations/commands/confirm",
    headers: {
      ...authorization(primaryCredential.token),
      "idempotency-key": "verify-hierarchy-cycle",
    },
    payload: {
      version: VERSION,
      confirmationId: hierarchyCycle.response.data.confirmationId,
    },
  });
  assertError(rejectedHierarchyCycle, 409, "work_item_hierarchy.cycle_conflict");

  const hierarchyDetach = await prepare(primaryCredential.token, randomUUID(), {
    type: "work_item.update",
    workItemId: hierarchyChildItem.id,
    expectedVersion: 1,
    parentWorkItemId: null,
  });
  const confirmedHierarchyDetach = await confirm(
    primaryCredential.token,
    hierarchyDetach.response.data.confirmationId,
    "verify-hierarchy-detach",
  );
  assert.equal(confirmedHierarchyDetach.response.data.outcome.type, "work_item.updated");
  assert.equal(confirmedHierarchyDetach.response.data.outcome.workItem.parentWorkItemId, null);
  assert.equal(confirmedHierarchyDetach.response.data.outcome.workItem.version, 2);

  const hierarchyReparent = await prepare(primaryCredential.token, randomUUID(), {
    type: "work_item.update",
    workItemId: hierarchyChildItem.id,
    expectedVersion: 2,
    parentWorkItemId: alternateParentId,
  });
  const confirmedHierarchyReparent = await confirm(
    primaryCredential.token,
    hierarchyReparent.response.data.confirmationId,
    "verify-hierarchy-reparent",
  );
  assert.equal(confirmedHierarchyReparent.response.data.outcome.type, "work_item.updated");
  assert.equal(
    confirmedHierarchyReparent.response.data.outcome.workItem.parentWorkItemId,
    alternateParentId,
  );
  assert.equal(confirmedHierarchyReparent.response.data.outcome.workItem.version, 3);

  const createConcurrentRoot = async (title: string): Promise<{ id: string; version: number }> => {
    const response = await app!.inject({
      method: "POST",
      url: `/v1/workspaces/${primaryWorkspaceId}/work-items`,
      payload: { title },
    });
    assert.equal(response.statusCode, 201, response.body);
    return response.json<{ id: string; version: number }>();
  };
  const productConcurrentChild = await createConcurrentRoot("Product concurrent hierarchy child");
  const integrationConcurrentChild = await createConcurrentRoot(
    "Integration concurrent hierarchy child",
  );
  const concurrentIntegrationReparent = await prepare(primaryCredential.token, randomUUID(), {
    type: "work_item.update",
    workItemId: integrationConcurrentChild.id,
    expectedVersion: integrationConcurrentChild.version,
    parentWorkItemId: alternateParentId,
  });
  // EVIDENCE: integration-gateway-hierarchy-cross-surface-lock-order
  // Product and Hermes hierarchy writes take graph then notification locks, so neither can deadlock.
  const [concurrentProductResponse, concurrentIntegrationResponse] = await Promise.all([
    app.inject({
      method: "PATCH",
      url: `/v1/workspaces/${primaryWorkspaceId}/work-items/${productConcurrentChild.id}`,
      payload: {
        expectedVersion: productConcurrentChild.version,
        parentWorkItemId: createdWorkItem.id,
      },
    }),
    confirm(
      primaryCredential.token,
      concurrentIntegrationReparent.response.data.confirmationId,
      "verify-hierarchy-cross-surface-lock-order",
    ),
  ]);
  assert.equal(concurrentProductResponse.statusCode, 200, concurrentProductResponse.body);
  assert.equal(concurrentIntegrationResponse.response.data.outcome.type, "work_item.updated");
  assert.equal(
    concurrentIntegrationResponse.response.data.outcome.workItem.parentWorkItemId,
    alternateParentId,
  );

  const reciprocalProductItem = await createConcurrentRoot("Reciprocal product hierarchy item");
  const reciprocalIntegrationItem = await createConcurrentRoot(
    "Reciprocal integration hierarchy item",
  );
  const reciprocalIntegrationUpdate = await prepare(primaryCredential.token, randomUUID(), {
    type: "work_item.update",
    workItemId: reciprocalIntegrationItem.id,
    expectedVersion: reciprocalIntegrationItem.version,
    parentWorkItemId: reciprocalProductItem.id,
  });
  let releaseGraphGuard: () => void = () => undefined;
  let markGraphGuardAcquired: () => void = () => undefined;
  const graphGuardAcquired = new Promise<void>((resolve) => {
    markGraphGuardAcquired = resolve;
  });
  const graphGuardRelease = new Promise<void>((resolve) => {
    releaseGraphGuard = resolve;
  });
  const graphLockKey = `${primaryWorkspaceId.toLowerCase()}:work-item-dependencies`;
  const graphGuard = connection.sql.begin(async (transaction) => {
    await transaction`select pg_advisory_xact_lock(hashtextextended(${graphLockKey}, 0))`;
    markGraphGuardAcquired();
    await graphGuardRelease;
  });
  await graphGuardAcquired;

  const waitForBlockedGraphWriters = async (minimum: number): Promise<void> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const [waiters] = await connection!.sql<{ value: number }[]>`
        select count(*)::int as value
        from pg_locks
        where locktype = 'advisory' and not granted
      `;
      if ((waiters?.value ?? 0) >= minimum) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`Timed out waiting for ${String(minimum)} blocked hierarchy writers.`);
  };

  const reciprocalProductResponsePromise = app.inject({
    method: "PATCH",
    url: `/v1/workspaces/${primaryWorkspaceId}/work-items/${reciprocalProductItem.id}`,
    payload: {
      expectedVersion: reciprocalProductItem.version,
      parentWorkItemId: reciprocalIntegrationItem.id,
    },
  });
  try {
    await waitForBlockedGraphWriters(1);
    const reciprocalIntegrationResponsePromise = app.inject({
      method: "POST",
      url: "/v1/integrations/commands/confirm",
      headers: {
        ...authorization(primaryCredential.token),
        "idempotency-key": "verify-hierarchy-reciprocal-snapshot",
      },
      payload: {
        version: VERSION,
        confirmationId: reciprocalIntegrationUpdate.response.data.confirmationId,
      },
    });
    await waitForBlockedGraphWriters(2);
    const blockedGraphLocks = await connection.sql<
      { classid: number; objid: number; objsubid: number; waiter_count: number }[]
    >`
      select classid::int, objid::int, objsubid::int, count(*)::int as waiter_count
      from pg_locks
      where locktype = 'advisory' and not granted
      group by classid, objid, objsubid
    `;
    assert.deepEqual(
      blockedGraphLocks.map((lock) => lock.waiter_count),
      [2],
      `product and integration writers did not queue on the same graph lock: ${JSON.stringify(blockedGraphLocks)}`,
    );
    releaseGraphGuard();
    await graphGuard;
    const [reciprocalProductResponse, reciprocalIntegrationResponse] = await Promise.all([
      reciprocalProductResponsePromise,
      reciprocalIntegrationResponsePromise,
    ]);
    // EVIDENCE: integration-gateway-hierarchy-snapshot-race
    // The product writer commits first. Hermes must validate from a post-lock read-committed
    // snapshot, reject the reciprocal edge, and leave the confirmation reusable instead of
    // creating a cycle.
    assert.equal(reciprocalProductResponse.statusCode, 200, reciprocalProductResponse.body);
    assertError(reciprocalIntegrationResponse, 409, "work_item_hierarchy.cycle_conflict");
    const [reciprocalEvidence] = await connection.sql<
      {
        product_parent_id: string | null;
        integration_parent_id: string | null;
        confirmation_available: boolean;
        request_count: number;
      }[]
    >`
      select
        (select parent_work_item_id::text from work_items where id = ${reciprocalProductItem.id})
          as product_parent_id,
        (select parent_work_item_id::text from work_items where id = ${reciprocalIntegrationItem.id})
          as integration_parent_id,
        (
          select consumed_at is null
          from integration_confirmations
          where id = ${reciprocalIntegrationUpdate.response.data.confirmationId}
        ) as confirmation_available,
        (
          select count(*)::int
          from integration_requests
          where idempotency_key = 'verify-hierarchy-reciprocal-snapshot'
        ) as request_count
    `;
    assert.equal(reciprocalEvidence?.product_parent_id, reciprocalIntegrationItem.id);
    assert.equal(reciprocalEvidence?.integration_parent_id, null);
    assert.equal(reciprocalEvidence?.confirmation_available, true);
    assert.equal(reciprocalEvidence?.request_count, 0);
  } finally {
    releaseGraphGuard();
    await graphGuard;
  }
  const [hierarchyEvidence] = await connection.sql<
    { hierarchy_audit_count: number; rejected_request_count: number }[]
  >`
    select
      (
        select count(*)::int from audit_events
        where workspace_id = ${primaryWorkspaceId}
          and action like 'work_item_hierarchy.%'
          and data ->> 'source' = 'integration'
      ) as hierarchy_audit_count,
      (
        select count(*)::int from integration_requests
        where idempotency_key = 'verify-hierarchy-cycle'
      ) as rejected_request_count
  `;
  assert.equal(hierarchyEvidence?.hierarchy_audit_count, 4);
  assert.equal(hierarchyEvidence?.rejected_request_count, 0);

  // EVIDENCE: integration-gateway-core-five-command-postgres-e2e
  // The five work/block/activity commands are confirmed through Fastify and PostgreSQL adapters.
  const [evidence] = await connection.sql<
    {
      receipt_count: number;
      confirmed_audit_count: number;
      prepared_audit_count: number;
      completed_plan_item_count: number;
      serialized_audits: string;
      serialized_receipts: string;
    }[]
  >`
    select
      (select count(*)::int from integration_requests where credential_id = ${primaryCredential.id}) as receipt_count,
      (
        select count(*)::int
        from audit_events
        where workspace_id = ${primaryWorkspaceId}
          and action = 'integration.command_confirmed'
          and data ->> 'credentialId' = ${primaryCredential.id}
      ) as confirmed_audit_count,
      (
        select count(*)::int
        from audit_events
        where workspace_id = ${primaryWorkspaceId}
          and action = 'integration.command_prepared'
      ) as prepared_audit_count,
      (
        select count(*)::int
        from daily_plan_item_states
        where workspace_id = ${primaryWorkspaceId}
          and plan_id = ${primaryPlan.id}
          and item_id = ${planItem.id}
          and activity_state = 'completed'
      ) as completed_plan_item_count,
      (
        select coalesce(jsonb_agg(data)::text, '[]')
        from audit_events
        where workspace_id = ${primaryWorkspaceId}
          and action like 'integration.%'
      ) as serialized_audits,
      (
        select coalesce(jsonb_agg(result)::text, '[]')
        from integration_requests
        where workspace_id = ${primaryWorkspaceId}
      ) as serialized_receipts
  `;
  assert.equal(evidence?.receipt_count, 11);
  assert.equal(evidence?.confirmed_audit_count, 11);
  assert.ok((evidence?.prepared_audit_count ?? 0) >= 13);
  assert.equal(evidence?.completed_plan_item_count, 1);
  for (const secret of [
    primaryCredential.secret,
    isolatedCredential.secret,
    readOnlyCredential.secret,
    writeOnlyCredential.secret,
  ]) {
    assert.equal(evidence?.serialized_audits.includes(secret), false);
    assert.equal(evidence?.serialized_receipts.includes(secret), false);
  }

  // EVIDENCE: integration-gateway-retention-purge
  // Retention removes only old completed history, preserving fresh pairs, active receipts, and audit.
  const oldConfirmationId = preparedCreate.response.data.confirmationId;
  const freshConfirmationId = preparedPlanActivity.response.data.confirmationId;
  const processingConfirmationId = preparedStaleUpdate.response.data.confirmationId;
  const processingIdempotencyKey = "verify-retention-processing";
  await connection.sql.begin(async (transaction) => {
    await transaction`
      update integration_confirmations
      set
        created_at = '2026-05-01T00:00:00.000Z'::timestamptz,
        consumed_at = '2026-05-01T00:30:00.000Z'::timestamptz,
        expires_at = '2026-05-01T01:00:00.000Z'::timestamptz,
        updated_at = '2026-05-01T00:30:00.000Z'::timestamptz
      where id = ${oldConfirmationId}
    `;
    await transaction`
      update integration_requests
      set
        created_at = '2026-05-01T00:00:00.000Z'::timestamptz,
        completed_at = '2026-05-01T00:30:00.000Z'::timestamptz,
        updated_at = '2026-05-01T00:30:00.000Z'::timestamptz
      where credential_id = ${primaryCredential.id}
        and idempotency_key = ${createIdempotencyKey}
        and status = 'succeeded'
    `;
    await transaction`
      update integration_confirmations
      set
        created_at = '2026-05-01T00:00:00.000Z'::timestamptz,
        consumed_at = null,
        expires_at = '2026-05-01T01:00:00.000Z'::timestamptz,
        updated_at = '2026-05-01T00:00:00.000Z'::timestamptz
      where id = ${processingConfirmationId}
    `;
    await transaction`
      insert into integration_requests (
        id,
        workspace_id,
        credential_id,
        idempotency_key,
        confirmation_id,
        command_hash,
        operation,
        status,
        result,
        created_at,
        completed_at,
        updated_at
      )
      select
        ${randomUUID()},
        workspace_id,
        credential_id,
        ${processingIdempotencyKey},
        id,
        command_hash,
        command_kind,
        'processing',
        null,
        '2026-05-01T00:00:00.000Z'::timestamptz,
        null,
        '2026-05-01T00:00:00.000Z'::timestamptz
      from integration_confirmations
      where id = ${processingConfirmationId}
    `;
  });
  const [retentionBefore] = await connection.sql<{ audit_count: number }[]>`
    select count(*)::int as audit_count
    from audit_events
    where workspace_id = ${primaryWorkspaceId} and action like 'integration.%'
  `;
  const retentionResult = await purgeIntegrationHistory(connection, {
    now: new Date("2026-07-16T06:59:00.000Z"),
    minimumRetentionMs: 30 * 24 * 60 * 60 * 1_000,
    batchSize: 10,
  });
  assert.equal(retentionResult.cutoff.toISOString(), "2026-06-16T06:59:00.000Z");
  assert.equal(retentionResult.deletedRequests, 1);
  assert.equal(retentionResult.deletedConfirmations, 1);
  assert.equal(retentionResult.totalDeleted, 2);
  const [retentionAfter] = await connection.sql<
    {
      old_request_count: number;
      old_confirmation_count: number;
      fresh_request_count: number;
      fresh_confirmation_count: number;
      processing_request_count: number;
      processing_confirmation_count: number;
      audit_count: number;
      old_audit_count: number;
    }[]
  >`
    select
      (
        select count(*)::int
        from integration_requests
        where credential_id = ${primaryCredential.id}
          and idempotency_key = ${createIdempotencyKey}
      ) as old_request_count,
      (
        select count(*)::int
        from integration_confirmations
        where id = ${oldConfirmationId}
      ) as old_confirmation_count,
      (
        select count(*)::int
        from integration_requests
        where credential_id = ${primaryCredential.id}
          and idempotency_key = 'verify-plan-item-activity'
          and confirmation_id = ${freshConfirmationId}
          and status = 'succeeded'
      ) as fresh_request_count,
      (
        select count(*)::int
        from integration_confirmations
        where id = ${freshConfirmationId}
      ) as fresh_confirmation_count,
      (
        select count(*)::int
        from integration_requests
        where credential_id = ${primaryCredential.id}
          and idempotency_key = ${processingIdempotencyKey}
          and confirmation_id = ${processingConfirmationId}
          and status = 'processing'
          and completed_at is null
          and result is null
      ) as processing_request_count,
      (
        select count(*)::int
        from integration_confirmations
        where id = ${processingConfirmationId}
      ) as processing_confirmation_count,
      (
        select count(*)::int
        from audit_events
        where workspace_id = ${primaryWorkspaceId} and action like 'integration.%'
      ) as audit_count,
      (
        select count(*)::int
        from audit_events
        where workspace_id = ${primaryWorkspaceId}
          and data ->> 'confirmationId' = ${oldConfirmationId}
      ) as old_audit_count
  `;
  assert.equal(retentionAfter?.old_request_count, 0);
  assert.equal(retentionAfter?.old_confirmation_count, 0);
  assert.equal(retentionAfter?.fresh_request_count, 1);
  assert.equal(retentionAfter?.fresh_confirmation_count, 1);
  assert.equal(retentionAfter?.processing_request_count, 1);
  assert.equal(retentionAfter?.processing_confirmation_count, 1);
  assert.equal(retentionAfter?.audit_count, retentionBefore?.audit_count);
  assert.ok((retentionAfter?.old_audit_count ?? 0) >= 1);
} catch (error) {
  verificationFailed = true;
  verificationFailure = error;
}

const cleanupSteps: CleanupStep[] = [];
if (app !== null) cleanupSteps.push({ label: "Fastify application", run: () => app!.close() });
if (connection !== null) {
  cleanupSteps.push({ label: "disposable database connection", run: () => connection!.close() });
}
if (databaseCreated) {
  cleanupSteps.push({
    label: "disposable database",
    run: () =>
      adminConnection.sql.unsafe(
        `drop database if exists ${quotedVerificationDatabase()} with (force)`,
      ),
  });
}
cleanupSteps.push({
  label: "administrative database connection",
  run: () => adminConnection.close(),
});
const cleanupFailures = await collectCleanupFailures(cleanupSteps);

if (verificationFailed) throw verificationFailure;
if (cleanupFailures.length > 0) {
  throw new Error(
    `Integration gateway verification cleanup failed for: ${cleanupFailures.join(", ")}.`,
  );
}
process.stdout.write("integration gateway verification passed\n");
