import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  WEBHOOK_DELIVERY_TOPIC,
  activatePendingWebhookSecret,
  claimNextOutboxEvent,
  createDatabase,
  createWebhookEndpoint,
  enqueueWebhookTestDelivery,
  failOutboxEvent,
  listWebhookDeadLetters,
  listWebhookEndpoints,
  loadWebhookDispatchRecord,
  prepareWebhookSecretRotation,
  redriveWebhookDelivery,
  revokeWebhookEndpoint,
  type DatabaseConnection,
  type WebhookSecretEnvelope,
} from "../packages/database/src/index.js";
import { expectedScheduleTables } from "./backup-database.js";

const sourceDatabaseUrl =
  process.env.DATABASE_URL ?? "postgres://schedule:schedule@127.0.0.1:5432/schedule";
const verificationDatabase = `schedule_webhook_verify_${randomUUID().replaceAll("-", "")}`;
const verificationDatabasePattern = /^schedule_webhook_verify_[a-f0-9]{32}$/;
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rawBody = '{"type":"webhook.test","value":1}';
const plaintextMarker = "plaintext-signing-secret-must-never-persist";

function databaseUrlFor(databaseName: string): string {
  const url = new URL(sourceDatabaseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quotedVerificationDatabase(): string {
  if (!verificationDatabasePattern.test(verificationDatabase)) {
    throw new Error("Unsafe disposable database identifier");
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
      if (code === 0) return resolve();
      // Do not propagate command output: connection strings can contain credentials.
      reject(new Error(`Disposable webhook migration failed (exit ${String(code)})`));
    });
  });
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
      // Driver diagnostics can contain the disposable connection URL.
      failures.push(step.label);
    }
  }
  return failures;
}

function envelope(suffix: string): WebhookSecretEnvelope {
  return {
    version: "v1",
    masterKeyId: `key-${suffix}`,
    nonce: "abcdEFGHijklMNOP",
    ciphertext: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopq",
    tag: "abcdefghijklmnopqrstuv",
  };
}

async function expectRejected(operation: () => Promise<unknown>, label: string): Promise<void> {
  try {
    await operation();
  } catch {
    return;
  }
  assert.fail(label);
}

const adminConnection = createDatabase(databaseUrlFor("postgres"), 1);
const disposableDatabaseUrl = databaseUrlFor(verificationDatabase);
let connection: DatabaseConnection | null = null;
let databaseCreated = false;
let verificationFailed = false;
let stage = "setup";
let failureCode = "unknown";

try {
  stage = "create database";
  await adminConnection.sql.unsafe(`create database ${quotedVerificationDatabase()}`);
  databaseCreated = true;
  stage = "migrate database";
  await applyCurrentMigrations(disposableDatabaseUrl);
  connection = createDatabase(disposableDatabaseUrl, 4);

  stage = "verify migration tables";
  const missingBackupTables = (
    await connection.sql<{ table_name: string }[]>`
      select table_name
      from unnest(${[...expectedScheduleTables]}::text[]) as table_name
      where to_regclass('public.' || table_name) is null
    `
  ).map((row) => row.table_name);
  assert.deepEqual(
    missingBackupTables,
    [],
    "migrations must create every backed-up schedule table",
  );

  stage = "create workspaces";
  const [primaryWorkspace, isolatedWorkspace] = await Promise.all(
    ["Webhook verification primary", "Webhook verification isolated"].map(async (name) => {
      const [row] = await connection!.sql<{ id: string }[]>`
        insert into workspaces (name) values (${name}) returning id
      `;
      if (!row) throw new Error("Workspace fixture creation failed");
      return row.id;
    }),
  );
  assert.ok(primaryWorkspace && isolatedWorkspace && primaryWorkspace !== isolatedWorkspace);

  const endpointId = randomUUID();
  const initialSecretId = randomUUID();
  const actorId = randomUUID();
  stage = "create endpoint";
  const endpoint = await createWebhookEndpoint(connection, {
    workspaceId: primaryWorkspace,
    endpointId,
    secretId: initialSecretId,
    name: "Verification endpoint",
    url: "https://hooks.integration.example.org/schedule",
    secretEnvelope: envelope("initial"),
    actorId,
  });
  assert.equal(endpoint.id, endpointId);
  assert.equal(endpoint.status, "active");

  const [createdState] = await connection.sql<
    {
      endpoint_count: number;
      active_secret_count: number;
      audit_count: number;
      persisted: string;
    }[]
  >`
    select
      (select count(*)::int from webhook_endpoints where id = ${endpointId}::uuid) as endpoint_count,
      (select count(*)::int from webhook_endpoint_secrets where endpoint_id = ${endpointId}::uuid and status = 'active') as active_secret_count,
      (select count(*)::int from audit_events where workspace_id = ${primaryWorkspace}::uuid and action = 'webhook.endpoint.created') as audit_count,
      (select secret_envelope::text from webhook_endpoint_secrets where id = ${initialSecretId}::uuid) as persisted
  `;
  assert.equal(createdState?.endpoint_count, 1);
  assert.equal(createdState?.active_secret_count, 1);
  assert.equal(createdState?.audit_count, 1);
  assert.equal(createdState?.persisted.includes(plaintextMarker), false);

  assert.equal((await listWebhookEndpoints(connection, primaryWorkspace)).length, 1);
  assert.deepEqual(await listWebhookEndpoints(connection, isolatedWorkspace), []);

  stage = "rotate secret";
  const pendingSecretId = randomUUID();
  stage = "prepare secret rotation";
  const pending = await prepareWebhookSecretRotation(connection, {
    workspaceId: primaryWorkspace,
    endpointId,
    secretId: pendingSecretId,
    secretEnvelope: envelope("rotated"),
    actorId,
  });
  assert.equal(pending?.version, 2);
  assert.equal(pending?.status, "pending");
  stage = "enforce single pending secret";
  assert.equal(
    await prepareWebhookSecretRotation(connection, {
      workspaceId: primaryWorkspace,
      endpointId,
      secretId: randomUUID(),
      secretEnvelope: envelope("second-pending"),
      actorId,
    }),
    null,
    "there can be only one pending secret",
  );
  const [lifecycleBefore] = await connection.sql<{ active: number; pending: number }[]>`
    select
      count(*) filter (where status = 'active')::int as active,
      count(*) filter (where status = 'pending')::int as pending
    from webhook_endpoint_secrets where workspace_id = ${primaryWorkspace}::uuid and endpoint_id = ${endpointId}::uuid
  `;
  assert.deepEqual(lifecycleBefore, { active: 1, pending: 1 });

  stage = "isolate secret activation";
  assert.equal(
    await activatePendingWebhookSecret(connection, {
      workspaceId: isolatedWorkspace,
      endpointId,
      secretId: pendingSecretId,
      actorId,
    }),
    null,
    "rotation activation must be tenant scoped",
  );
  stage = "activate secret rotation";
  const activated = await activatePendingWebhookSecret(connection, {
    workspaceId: primaryWorkspace,
    endpointId,
    secretId: pendingSecretId,
    actorId,
  });
  assert.equal(activated?.status, "active");
  assert.equal(activated?.version, 2);
  const [lifecycleAfter] = await connection.sql<
    { active: number; pending: number; retired: number }[]
  >`
    select
      count(*) filter (where status = 'active')::int as active,
      count(*) filter (where status = 'pending')::int as pending,
      count(*) filter (where status = 'retired')::int as retired
    from webhook_endpoint_secrets where workspace_id = ${primaryWorkspace}::uuid and endpoint_id = ${endpointId}::uuid
  `;
  assert.deepEqual(lifecycleAfter, { active: 1, pending: 0, retired: 1 });
  stage = "reject retired secret activation";
  assert.equal(
    await activatePendingWebhookSecret(connection, {
      workspaceId: primaryWorkspace,
      endpointId,
      secretId: initialSecretId,
      actorId,
    }),
    null,
  );

  stage = "enqueue delivery";
  const delivery = await enqueueWebhookTestDelivery(connection, {
    workspaceId: primaryWorkspace,
    endpointId,
    eventId: "verification-event-1",
    eventType: "webhook.test",
    eventOccurredAt: new Date("2026-07-13T00:00:00.000Z"),
    rawBody,
    actorId,
  });
  stage = "verify queued delivery";
  if (!delivery) {
    const [targetState] = await connection.sql<{ endpoints: number; active_secrets: number }[]>`
      select
        (select count(*)::int from webhook_endpoints where workspace_id = ${primaryWorkspace}::uuid and id = ${endpointId}::uuid and status = 'active') as endpoints,
        (select count(*)::int from webhook_endpoint_secrets where workspace_id = ${primaryWorkspace}::uuid and endpoint_id = ${endpointId}::uuid and status = 'active') as active_secrets
    `;
    stage = `queue target endpoints-${String(targetState?.endpoints)}-active-secrets-${String(targetState?.active_secrets)}`;
    throw new Error("Active endpoint queue target unavailable");
  }
  assert.equal(delivery.rawBody, rawBody);
  assert.equal(delivery.bodySha256, createHash("sha256").update(rawBody, "utf8").digest("hex"));

  stage = "inspect queued database records";
  const [queuedState] = await connection.sql<
    {
      topic: string;
      payload: unknown;
      audit_count: number;
      persisted_body: string;
    }[]
  >`
    select
      (select topic from outbox_events where id = ${delivery.outboxEventId}::uuid) as topic,
      (select payload from outbox_events where id = ${delivery.outboxEventId}::uuid) as payload,
      (select count(*)::int from audit_events where workspace_id = ${primaryWorkspace}::uuid and action = 'webhook.delivery.enqueued' and entity_id = ${delivery.id}::uuid) as audit_count,
      (select raw_body from webhook_deliveries where id = ${delivery.id}::uuid) as persisted_body
  `;
  assert.equal(queuedState?.topic, WEBHOOK_DELIVERY_TOPIC);
  assert.deepEqual(queuedState?.payload, { deliveryId: delivery.id });
  assert.equal(queuedState?.audit_count, 1);
  assert.equal(queuedState?.persisted_body, rawBody);

  stage = "verify duplicate delivery";
  assert.equal(
    await enqueueWebhookTestDelivery(connection, {
      workspaceId: primaryWorkspace,
      endpointId,
      eventId: "verification-event-1",
      eventType: "webhook.test",
      eventOccurredAt: new Date("2026-07-13T00:00:00.000Z"),
      rawBody,
      actorId,
    }),
    null,
    "the same event ID must be idempotent",
  );
  assert.equal(
    await enqueueWebhookTestDelivery(connection, {
      workspaceId: primaryWorkspace,
      endpointId,
      eventId: "verification-event-1",
      eventType: "webhook.test.conflict",
      eventOccurredAt: new Date("2026-07-13T00:00:00.000Z"),
      rawBody: '{"different":true}',
      actorId,
    }),
    null,
    "a duplicate event ID with conflicting bytes must not replace the immutable delivery",
  );
  const [duplicateState] = await connection.sql<{ count: number; raw_body: string }[]>`
    select count(*)::int as count, min(raw_body) as raw_body
    from webhook_deliveries
    where workspace_id = ${primaryWorkspace}::uuid and endpoint_id = ${endpointId}::uuid and event_id = 'verification-event-1'
  `;
  assert.equal(duplicateState?.count, 1);
  assert.equal(duplicateState?.raw_body, rawBody);

  stage = "load and redrive delivery";
  stage = "load dispatch record";
  const dispatch = await loadWebhookDispatchRecord(connection, {
    workspaceId: primaryWorkspace,
    outboxEventId: delivery.outboxEventId,
    deliveryId: delivery.id,
  });
  assert.equal(dispatch?.delivery.id, delivery.id);
  assert.equal(dispatch?.delivery.rawBody, rawBody);
  assert.equal(dispatch?.secretEnvelope.masterKeyId, envelope("rotated").masterKeyId);
  assert.equal(
    await loadWebhookDispatchRecord(connection, {
      workspaceId: isolatedWorkspace,
      outboxEventId: delivery.outboxEventId,
      deliveryId: delivery.id,
    }),
    null,
  );
  assert.equal(
    await loadWebhookDispatchRecord(connection, {
      workspaceId: primaryWorkspace,
      outboxEventId: randomUUID(),
      deliveryId: delivery.id,
    }),
    null,
  );

  const claimed = await claimNextOutboxEvent(connection, { maxAttempts: 3 });
  assert.equal(claimed.event?.id, delivery.outboxEventId);
  if (!claimed.event) throw new Error("Queued webhook delivery was not claimable");
  assert.equal(
    await failOutboxEvent(connection, claimed.event, "verification permanent failure", 3, {
      permanent: true,
    }),
    "dead_lettered",
  );
  const deadLetters = await listWebhookDeadLetters(connection, { workspaceId: primaryWorkspace });
  assert.equal(deadLetters.length, 1);
  const metadata = JSON.stringify(deadLetters[0]);
  assert.equal(metadata.includes(rawBody), false);
  assert.equal(metadata.includes("hooks.integration.example.org"), false);
  assert.equal(metadata.includes(envelope("rotated").ciphertext), false);
  assert.deepEqual(
    await listWebhookDeadLetters(connection, { workspaceId: isolatedWorkspace }),
    [],
  );
  assert.equal(
    await redriveWebhookDelivery(connection, {
      workspaceId: isolatedWorkspace,
      deliveryId: delivery.id,
      actorId,
    }),
    false,
  );
  assert.equal(
    await redriveWebhookDelivery(connection, {
      workspaceId: primaryWorkspace,
      deliveryId: delivery.id,
      actorId,
    }),
    true,
  );
  const [redriveState] = await connection.sql<
    {
      status: string;
      attempts: number;
      raw_body: string;
      delivery_count: number;
      audit_count: number;
    }[]
  >`
    select
      (select status::text from outbox_events where id = ${delivery.outboxEventId}::uuid) as status,
      (select attempts from outbox_events where id = ${delivery.outboxEventId}::uuid) as attempts,
      (select raw_body from webhook_deliveries where id = ${delivery.id}::uuid) as raw_body,
      (select count(*)::int from webhook_deliveries where id = ${delivery.id}::uuid) as delivery_count,
      (select count(*)::int from audit_events where workspace_id = ${primaryWorkspace}::uuid and action = 'webhook.delivery.redriven' and entity_id = ${delivery.id}::uuid) as audit_count
  `;
  assert.equal(redriveState?.status, "pending");
  assert.equal(redriveState?.attempts, 0);
  assert.equal(redriveState?.raw_body, rawBody);
  assert.equal(redriveState?.delivery_count, 1);
  assert.equal(redriveState?.audit_count, 1);

  stage = "verify immutability guards";
  await expectRejected(
    () =>
      connection!.sql`
        update webhook_deliveries set raw_body = '{"tampered":true}' where id = ${delivery.id}::uuid
      `,
    "delivery rows must be immutable",
  );
  await expectRejected(
    () => connection!.sql`delete from webhook_deliveries where id = ${delivery.id}::uuid`,
    "delivery rows must not be deletable",
  );
  await expectRejected(
    () =>
      connection!.sql`
        update webhook_endpoint_secrets
        set secret_envelope = ${JSON.stringify(envelope("tampered"))}::jsonb
        where id = ${pendingSecretId}::uuid
      `,
    "secret material must be immutable",
  );
  await expectRejected(
    () =>
      connection!.sql`
        update webhook_endpoints set name = 'tampered endpoint' where id = ${endpointId}::uuid
      `,
    "endpoint identity must be immutable",
  );

  stage = "verify constraints";
  await expectRejected(
    () =>
      connection!.sql`
        insert into webhook_endpoint_secrets (id, workspace_id, endpoint_id, version, status, secret_envelope)
        values (${randomUUID()}::uuid, ${isolatedWorkspace}::uuid, ${endpointId}::uuid, 1, 'pending', ${JSON.stringify(envelope("cross-tenant"))}::jsonb)
      `,
    "cross-tenant secret foreign key must reject",
  );
  await expectRejected(
    () =>
      connection!.sql`
        insert into webhook_deliveries (id, workspace_id, endpoint_id, secret_id, event_id, event_type, event_occurred_at, raw_body, body_sha256)
        values (${randomUUID()}::uuid, ${isolatedWorkspace}::uuid, ${endpointId}::uuid, ${pendingSecretId}::uuid, 'cross-tenant', 'webhook.test', clock_timestamp(), '{}', encode(digest('{}', 'sha256'), 'hex'))
      `,
    "cross-tenant delivery foreign key must reject",
  );
  await expectRejected(
    () =>
      connection!.sql`
        update outbox_events
        set payload = ${JSON.stringify({ deliveryId: delivery.id, extra: true })}::jsonb
        where id = ${delivery.outboxEventId}::uuid
      `,
    "thin webhook outbox payload invariant must reject",
  );

  stage = "verify rollback";
  const rollbackEndpointId = randomUUID();
  await expectRejected(
    () =>
      connection!.sql.begin(async (transaction) => {
        await transaction`
          insert into webhook_endpoints (id, workspace_id, name, url)
          values (${rollbackEndpointId}::uuid, ${primaryWorkspace}::uuid, 'rollback verification', 'https://rollback.integration.example.test/hook')
        `;
        await transaction`
          insert into webhook_endpoint_secrets (id, workspace_id, endpoint_id, version, status, secret_envelope, activated_at)
          values (${initialSecretId}::uuid, ${primaryWorkspace}::uuid, ${rollbackEndpointId}::uuid, 1, 'active', ${JSON.stringify(envelope("rollback"))}::jsonb, clock_timestamp())
        `;
      }),
    "transaction failure must abort the prior endpoint insert",
  );
  const [rollbackState] = await connection.sql<{ count: number }[]>`
    select count(*)::int as count from webhook_endpoints where id = ${rollbackEndpointId}::uuid
  `;
  assert.equal(
    rollbackState?.count,
    0,
    "transaction constraint failure must leave no partial endpoint",
  );

  stage = "revoke endpoint";
  assert.equal(
    await revokeWebhookEndpoint(connection, {
      workspaceId: isolatedWorkspace,
      endpointId,
      actorId,
    }),
    false,
  );
  assert.equal(
    await revokeWebhookEndpoint(connection, { workspaceId: primaryWorkspace, endpointId, actorId }),
    true,
  );
  assert.equal(
    await enqueueWebhookTestDelivery(connection, {
      workspaceId: primaryWorkspace,
      endpointId,
      eventId: "after-revocation",
      eventType: "webhook.test",
      eventOccurredAt: new Date("2026-07-13T00:00:00.000Z"),
      rawBody,
      actorId,
    }),
    null,
    "a revoked endpoint must not queue new delivery work",
  );
  assert.equal(
    await loadWebhookDispatchRecord(connection, {
      workspaceId: primaryWorkspace,
      outboxEventId: delivery.outboxEventId,
      deliveryId: delivery.id,
    }),
    null,
    "a revoked endpoint must not be dispatchable",
  );
  await expectRejected(
    () =>
      connection!.sql`
        update webhook_endpoints set status = 'active', revoked_at = null where id = ${endpointId}::uuid
      `,
    "endpoint revocation must be terminal",
  );
} catch (error) {
  verificationFailed = true;
  if (error !== null && typeof error === "object") {
    const candidate = error as { code?: unknown; constraint?: unknown };
    if (typeof candidate.code === "string" && /^[A-Z0-9]{1,12}$/i.test(candidate.code)) {
      failureCode = candidate.code;
    }
    if (
      typeof candidate.constraint === "string" &&
      /^[a-z0-9_]{1,120}$/i.test(candidate.constraint)
    ) {
      failureCode = `${failureCode}-${candidate.constraint}`;
    }
  }
}

const cleanupSteps: CleanupStep[] = [];
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

if (verificationFailed) {
  throw new Error(`Webhook delivery verification failed during ${stage} (${failureCode}).`);
}
if (cleanupFailures.length > 0) {
  throw new Error(
    `Webhook delivery verification cleanup failed for: ${cleanupFailures.join(", ")}.`,
  );
}
process.stdout.write("webhook delivery verification passed\n");
