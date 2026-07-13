import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  SCHEDULE_CHANGED_WEBHOOK_EVENT_TYPE,
  WEBHOOK_DELIVERY_TOPIC,
  activatePendingWebhookSecret,
  claimNextOutboxEvent,
  createDatabase,
  createWebhookEndpoint,
  enqueueWebhookTestDelivery,
  failOutboxEvent,
  getWebhookEventSubscriptions,
  listWebhookDeadLetters,
  listWebhookEndpoints,
  listWebhookEventSubscriptions,
  loadWebhookDispatchRecord,
  prepareWebhookSecretRotation,
  redriveWebhookDelivery,
  replaceWebhookEventSubscriptions,
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

interface AutomaticDeliveryRow {
  readonly id: string;
  readonly endpoint_id: string;
  readonly secret_id: string;
  readonly event_id: string;
  readonly event_type: string;
  readonly occurred_time: string;
  readonly delivery_created_time: string;
  readonly raw_body: string;
  readonly body_sha256: string;
  readonly outbox_event_id: string;
  readonly outbox_payload: unknown;
  readonly outbox_available_time: string;
  readonly outbox_created_time: string;
  readonly audit_occurred_time: string;
}

function assertAutomaticDeliveryTimestamps(row: AutomaticDeliveryRow): void {
  for (const persistedTime of [
    row.delivery_created_time,
    row.outbox_available_time,
    row.outbox_created_time,
    row.audit_occurred_time,
  ]) {
    assert.equal(
      persistedTime,
      row.occurred_time,
      "delivery, outbox, audit, and body times must share the trigger occurrence instant",
    );
  }
}

async function insertDailyPlan(
  database: DatabaseConnection,
  input: {
    readonly workspaceId: string;
    readonly planId: string;
    readonly date: string;
    readonly requestRevision: number;
  },
): Promise<void> {
  await database.sql`
    insert into daily_plans (
      id, workspace_id, local_date, time_zone, status, request_revision,
      algorithm_version, config_version, prng_version, seed, input_hash,
      input_snapshot, total_minutes, fitness, generated_at
    ) values (
      ${input.planId}::uuid, ${input.workspaceId}::uuid, ${input.date}::date,
      'UTC', 'generated', ${input.requestRevision}, 'verification-v1',
      'verification-v1', 'verification-v1', 'verification-seed',
      ${"0".repeat(64)}, '{}'::jsonb, 0, 0, '2026-07-13T12:00:00.000Z'::timestamptz
    )
  `;
}

async function insertDailyPlanHead(
  database: DatabaseConnection,
  input: {
    readonly workspaceId: string;
    readonly planId: string;
    readonly headId: string;
    readonly date: string;
    readonly requestRevision: number;
  },
): Promise<void> {
  await insertDailyPlan(database, input);
  await database.sql`
    insert into daily_plan_heads (
      id, workspace_id, local_date, current_plan_id, version,
      created_at, updated_at
    ) values (
      ${input.headId}::uuid, ${input.workspaceId}::uuid, ${input.date}::date,
      ${input.planId}::uuid, 1,
      '2026-07-13T12:00:00.000Z'::timestamptz,
      '2026-07-13T12:00:00.000Z'::timestamptz
    )
  `;
}

function scheduleChangedEventId(workspaceId: string, date: string, headVersion: number): string {
  return `${SCHEDULE_CHANGED_WEBHOOK_EVENT_TYPE}:${workspaceId}:${date}:${String(headVersion)}`;
}

function scheduleChangedBody(
  workspaceId: string,
  date: string,
  headVersion: number,
  eventId: string,
  occurredTime: string,
): string {
  return (
    `{"specversion":"1.0","id":${JSON.stringify(eventId)},` +
    `"type":"${SCHEDULE_CHANGED_WEBHOOK_EVENT_TYPE}","time":${JSON.stringify(occurredTime)},` +
    `"data":{"workspaceId":${JSON.stringify(workspaceId)},` +
    `"date":${JSON.stringify(date)},"headVersion":${String(headVersion)}}}`
  );
}

function assertPrivacyThinScheduleChangedBody(
  raw: string,
  input: {
    readonly workspaceId: string;
    readonly date: string;
    readonly headVersion: number;
    readonly eventId: string;
    readonly occurredTime: string;
  },
): void {
  assert.deepEqual(JSON.parse(raw), {
    specversion: "1.0",
    id: input.eventId,
    type: SCHEDULE_CHANGED_WEBHOOK_EVENT_TYPE,
    time: input.occurredTime,
    data: {
      workspaceId: input.workspaceId,
      date: input.date,
      headVersion: input.headVersion,
    },
  });
  for (const forbiddenKey of [
    "plan",
    "planId",
    "currentPlanId",
    "item",
    "items",
    "title",
    "reason",
    "metadata",
    "duration",
    "durationMinutes",
  ]) {
    assert.equal(raw.includes(`"${forbiddenKey}"`), false, `${forbiddenKey} must not be emitted`);
  }
}

function matchesSubscriptionAudit(
  data: unknown,
  previousEventTypes: readonly string[],
  eventTypes: readonly string[],
): boolean {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return false;
  const record = data as Record<string, unknown>;
  return (
    Object.keys(record).length === 2 &&
    JSON.stringify(record.previousEventTypes) === JSON.stringify(previousEventTypes) &&
    JSON.stringify(record.eventTypes) === JSON.stringify(eventTypes)
  );
}

async function loadAutomaticDeliveries(
  database: DatabaseConnection,
  workspaceId: string,
  eventId: string,
): Promise<readonly AutomaticDeliveryRow[]> {
  return database.sql<AutomaticDeliveryRow[]>`
    select
      delivery.id,
      delivery.endpoint_id,
      delivery.secret_id,
      delivery.event_id,
      delivery.event_type,
      to_char(
        delivery.event_occurred_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ) as occurred_time,
      to_char(
        delivery.created_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ) as delivery_created_time,
      delivery.raw_body,
      delivery.body_sha256,
      outbox.id as outbox_event_id,
      outbox.payload as outbox_payload,
      to_char(
        outbox.available_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ) as outbox_available_time,
      to_char(
        outbox.created_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ) as outbox_created_time,
      to_char(
        audit.occurred_at at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
      ) as audit_occurred_time
    from webhook_deliveries as delivery
    join outbox_events as outbox
      on outbox.workspace_id = delivery.workspace_id
      and outbox.webhook_delivery_id = delivery.id
      and outbox.topic = ${WEBHOOK_DELIVERY_TOPIC}
    join audit_events as audit
      on audit.workspace_id = delivery.workspace_id
      and audit.entity_type = 'webhook_delivery'
      and audit.entity_id = delivery.id
      and audit.action = 'webhook.delivery.enqueued'
    where delivery.workspace_id = ${workspaceId}::uuid
      and delivery.event_type = ${SCHEDULE_CHANGED_WEBHOOK_EVENT_TYPE}
      and delivery.event_id = ${eventId}
    order by delivery.endpoint_id
  `;
}

async function loadHeadEventArtifactState(
  database: DatabaseConnection,
  input: { readonly workspaceId: string; readonly headId: string },
): Promise<{
  readonly current_plan_id: string;
  readonly head_version: number;
  readonly deliveries: number;
  readonly outbox: number;
  readonly audits: number;
}> {
  const [state] = await database.sql<
    {
      current_plan_id: string;
      head_version: number;
      deliveries: number;
      outbox: number;
      audits: number;
    }[]
  >`
    select
      (select current_plan_id from daily_plan_heads where id = ${input.headId}::uuid) as current_plan_id,
      (select version from daily_plan_heads where id = ${input.headId}::uuid) as head_version,
      (
        select count(*)::int from webhook_deliveries
        where workspace_id = ${input.workspaceId}::uuid
          and event_type = ${SCHEDULE_CHANGED_WEBHOOK_EVENT_TYPE}
      ) as deliveries,
      (
        select count(*)::int from outbox_events as outbox
        join webhook_deliveries as delivery
          on delivery.workspace_id = outbox.workspace_id
          and delivery.id = outbox.webhook_delivery_id
        where delivery.workspace_id = ${input.workspaceId}::uuid
          and delivery.event_type = ${SCHEDULE_CHANGED_WEBHOOK_EVENT_TYPE}
      ) as outbox,
      (
        select count(*)::int from audit_events
        where workspace_id = ${input.workspaceId}::uuid
          and action = 'webhook.delivery.enqueued'
          and data->>'eventType' = ${SCHEDULE_CHANGED_WEBHOOK_EVENT_TYPE}
      ) as audits
  `;
  if (!state) throw new Error("Daily plan head event state was not returned");
  return state;
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

  stage = "verify default automatic subscription state";
  assert.deepEqual(
    await getWebhookEventSubscriptions(connection, {
      workspaceId: primaryWorkspace,
      endpointId,
    }),
    [],
    "an endpoint created before opt-in must not receive automatic events",
  );

  const secondEndpointId = randomUUID();
  const secondSecretId = randomUUID();
  await createWebhookEndpoint(connection, {
    workspaceId: primaryWorkspace,
    endpointId: secondEndpointId,
    secretId: secondSecretId,
    name: "Second automatic verification endpoint",
    url: "https://secondary.integration.example.org/schedule",
    secretEnvelope: envelope("secondary"),
    actorId,
  });
  const isolatedEndpointId = randomUUID();
  const isolatedSecretId = randomUUID();
  await createWebhookEndpoint(connection, {
    workspaceId: isolatedWorkspace,
    endpointId: isolatedEndpointId,
    secretId: isolatedSecretId,
    name: "Isolated automatic verification endpoint",
    url: "https://isolated.integration.example.org/schedule",
    secretEnvelope: envelope("isolated"),
    actorId,
  });
  assert.deepEqual(
    await getWebhookEventSubscriptions(connection, {
      workspaceId: primaryWorkspace,
      endpointId: secondEndpointId,
    }),
    [],
  );
  assert.deepEqual(await listWebhookEventSubscriptions(connection, primaryWorkspace), [
    ...[endpointId, secondEndpointId].sort().map((candidateEndpointId) => ({
      workspaceId: primaryWorkspace,
      endpointId: candidateEndpointId,
      eventTypes: [],
    })),
  ]);

  stage = "reject foreign and revoked automatic subscription replacement";
  assert.equal(
    await replaceWebhookEventSubscriptions(connection, {
      workspaceId: isolatedWorkspace,
      endpointId,
      eventTypes: [SCHEDULE_CHANGED_WEBHOOK_EVENT_TYPE],
      actorId,
    }),
    null,
    "a foreign workspace must not replace subscriptions",
  );
  const revokedSubscriptionEndpointId = randomUUID();
  await createWebhookEndpoint(connection, {
    workspaceId: primaryWorkspace,
    endpointId: revokedSubscriptionEndpointId,
    secretId: randomUUID(),
    name: "Revoked subscription verification endpoint",
    url: "https://revoked.integration.example.org/schedule",
    secretEnvelope: envelope("revoked"),
    actorId,
  });
  assert.equal(
    await revokeWebhookEndpoint(connection, {
      workspaceId: primaryWorkspace,
      endpointId: revokedSubscriptionEndpointId,
      actorId,
    }),
    true,
  );
  assert.equal(
    await replaceWebhookEventSubscriptions(connection, {
      workspaceId: primaryWorkspace,
      endpointId: revokedSubscriptionEndpointId,
      eventTypes: [SCHEDULE_CHANGED_WEBHOOK_EVENT_TYPE],
      actorId,
    }),
    null,
    "a revoked endpoint must not be resubscribed",
  );
  assert.equal(
    await getWebhookEventSubscriptions(connection, {
      workspaceId: primaryWorkspace,
      endpointId: revokedSubscriptionEndpointId,
    }),
    null,
  );

  stage = "verify no automatic event before opt-in";
  await insertDailyPlanHead(connection, {
    workspaceId: primaryWorkspace,
    planId: randomUUID(),
    headId: randomUUID(),
    date: "2026-07-14",
    requestRevision: 1,
  });
  const [beforeOptIn] = await connection.sql<{ deliveries: number; outbox: number }[]>`
    select
      (
        select count(*)::int from webhook_deliveries
        where workspace_id = ${primaryWorkspace}::uuid
          and event_type = ${SCHEDULE_CHANGED_WEBHOOK_EVENT_TYPE}
      ) as deliveries,
      (
        select count(*)::int
        from outbox_events as outbox
        join webhook_deliveries as delivery
          on delivery.workspace_id = outbox.workspace_id
          and delivery.id = outbox.webhook_delivery_id
        where delivery.workspace_id = ${primaryWorkspace}::uuid
          and delivery.event_type = ${SCHEDULE_CHANGED_WEBHOOK_EVENT_TYPE}
      ) as outbox
  `;
  assert.deepEqual(beforeOptIn, { deliveries: 0, outbox: 0 });

  stage = "enable and audit automatic subscriptions";
  const enabled = await replaceWebhookEventSubscriptions(connection, {
    workspaceId: primaryWorkspace,
    endpointId,
    eventTypes: [SCHEDULE_CHANGED_WEBHOOK_EVENT_TYPE],
    actorId,
  });
  stage = "verify enabled automatic subscription result";
  assert.deepEqual(enabled, {
    workspaceId: primaryWorkspace,
    endpointId,
    previousEventTypes: [],
    eventTypes: [SCHEDULE_CHANGED_WEBHOOK_EVENT_TYPE],
    changed: true,
  });
  stage = "read enabled automatic subscription";
  assert.deepEqual(
    await getWebhookEventSubscriptions(connection, { workspaceId: primaryWorkspace, endpointId }),
    [SCHEDULE_CHANGED_WEBHOOK_EVENT_TYPE],
  );
  stage = "repeat unchanged automatic subscription";
  const enabledAgain = await replaceWebhookEventSubscriptions(connection, {
    workspaceId: primaryWorkspace,
    endpointId,
    eventTypes: [SCHEDULE_CHANGED_WEBHOOK_EVENT_TYPE],
    actorId,
  });
  stage = "verify unchanged automatic subscription result";
  assert.deepEqual(enabledAgain, {
    workspaceId: primaryWorkspace,
    endpointId,
    previousEventTypes: [SCHEDULE_CHANGED_WEBHOOK_EVENT_TYPE],
    eventTypes: [SCHEDULE_CHANGED_WEBHOOK_EVENT_TYPE],
    changed: false,
  });
  stage = "read automatic subscription audit";
  const enabledAudits = await connection.sql<{ actor_id: string; data: unknown }[]>`
    select actor_id, data
    from audit_events
    where workspace_id = ${primaryWorkspace}::uuid
      and action = 'webhook.subscriptions.replaced'
      and entity_type = 'webhook_endpoint'
      and entity_id = ${endpointId}::uuid
    order by occurred_at, id
  `;
  stage = "verify automatic subscription audit count";
  assert.equal(enabledAudits.length, 1);
  stage = "verify automatic subscription audit actor";
  assert.equal(enabledAudits[0]?.actor_id, actorId);
  stage = "verify automatic subscription audit data";
  assert.deepEqual(enabledAudits[0]?.data, {
    previousEventTypes: [],
    eventTypes: [SCHEDULE_CHANGED_WEBHOOK_EVENT_TYPE],
  });

  for (const [workspaceId, targetEndpointId] of [
    [primaryWorkspace, secondEndpointId],
    [isolatedWorkspace, isolatedEndpointId],
  ] as const) {
    const replacement = await replaceWebhookEventSubscriptions(connection, {
      workspaceId,
      endpointId: targetEndpointId,
      eventTypes: [SCHEDULE_CHANGED_WEBHOOK_EVENT_TYPE],
      actorId,
    });
    assert.equal(replacement?.changed, true);
    assert.deepEqual(replacement?.previousEventTypes, []);
    assert.deepEqual(replacement?.eventTypes, [SCHEDULE_CHANGED_WEBHOOK_EVENT_TYPE]);
  }
  assert.deepEqual(await listWebhookEventSubscriptions(connection, primaryWorkspace), [
    ...[endpointId, secondEndpointId].sort().map((candidateEndpointId) => ({
      workspaceId: primaryWorkspace,
      endpointId: candidateEndpointId,
      eventTypes: [SCHEDULE_CHANGED_WEBHOOK_EVENT_TYPE],
    })),
  ]);

  stage = "fan out initial automatic schedule change";
  const automaticDate = "2026-07-15";
  const automaticPlanId = randomUUID();
  const automaticHeadId = randomUUID();
  await insertDailyPlanHead(connection, {
    workspaceId: primaryWorkspace,
    planId: automaticPlanId,
    headId: automaticHeadId,
    date: automaticDate,
    requestRevision: 1,
  });
  const initialAutomaticEventId = scheduleChangedEventId(primaryWorkspace, automaticDate, 1);
  const initialAutomaticDeliveries = await loadAutomaticDeliveries(
    connection,
    primaryWorkspace,
    initialAutomaticEventId,
  );
  assert.equal(initialAutomaticDeliveries.length, 2);
  assert.deepEqual(
    initialAutomaticDeliveries.map((row) => row.endpoint_id).sort(),
    [endpointId, secondEndpointId].sort(),
  );
  assert.equal(new Set(initialAutomaticDeliveries.map((row) => row.id)).size, 2);
  assert.equal(new Set(initialAutomaticDeliveries.map((row) => row.outbox_event_id)).size, 2);
  assert.equal(new Set(initialAutomaticDeliveries.map((row) => row.event_id)).size, 1);
  assert.equal(new Set(initialAutomaticDeliveries.map((row) => row.occurred_time)).size, 1);
  assert.equal(new Set(initialAutomaticDeliveries.map((row) => row.raw_body)).size, 1);
  for (const automaticDelivery of initialAutomaticDeliveries) {
    const expectedBody = scheduleChangedBody(
      primaryWorkspace,
      automaticDate,
      1,
      initialAutomaticEventId,
      automaticDelivery.occurred_time,
    );
    assert.equal(automaticDelivery.event_type, SCHEDULE_CHANGED_WEBHOOK_EVENT_TYPE);
    assertAutomaticDeliveryTimestamps(automaticDelivery);
    assert.equal(automaticDelivery.raw_body, expectedBody);
    assert.equal(
      automaticDelivery.body_sha256,
      createHash("sha256").update(expectedBody, "utf8").digest("hex"),
    );
    assert.deepEqual(automaticDelivery.outbox_payload, { deliveryId: automaticDelivery.id });
    assertPrivacyThinScheduleChangedBody(expectedBody, {
      workspaceId: primaryWorkspace,
      date: automaticDate,
      headVersion: 1,
      eventId: initialAutomaticEventId,
      occurredTime: automaticDelivery.occurred_time,
    });
    const automaticDispatch = await loadWebhookDispatchRecord(connection, {
      workspaceId: primaryWorkspace,
      outboxEventId: automaticDelivery.outbox_event_id,
      deliveryId: automaticDelivery.id,
    });
    assert.equal(automaticDispatch?.delivery.rawBody, expectedBody);
    assert.equal(automaticDispatch?.delivery.endpointId, automaticDelivery.endpoint_id);
  }
  const [initialAutomaticAuditState] = await connection.sql<
    {
      delivery_audits: number;
      outbox_count: number;
    }[]
  >`
    select
      (
        select count(*)::int from audit_events
        where workspace_id = ${primaryWorkspace}::uuid
          and action = 'webhook.delivery.enqueued'
          and data->>'eventId' = ${initialAutomaticEventId}
          and data->>'eventType' = ${SCHEDULE_CHANGED_WEBHOOK_EVENT_TYPE}
      ) as delivery_audits,
      (
        select count(*)::int
        from outbox_events as outbox
        join webhook_deliveries as delivery
          on delivery.workspace_id = outbox.workspace_id
          and delivery.id = outbox.webhook_delivery_id
        where delivery.workspace_id = ${primaryWorkspace}::uuid
          and delivery.event_id = ${initialAutomaticEventId}
      ) as outbox_count
  `;
  assert.deepEqual(initialAutomaticAuditState, { delivery_audits: 2, outbox_count: 2 });

  stage = "deduplicate unchanged head version";
  await connection.sql`
    update daily_plan_heads
    set version = version, current_plan_id = current_plan_id, updated_at = updated_at
    where workspace_id = ${primaryWorkspace}::uuid
      and id = ${automaticHeadId}::uuid
  `;
  assert.equal(
    (await loadAutomaticDeliveries(connection, primaryWorkspace, initialAutomaticEventId)).length,
    2,
    "the same committed head version must not create another delivery or outbox row",
  );
  const [unchangedAutomaticState] = await connection.sql<
    { deliveries: number; outbox: number; audits: number }[]
  >`
    select
      (
        select count(*)::int from webhook_deliveries
        where workspace_id = ${primaryWorkspace}::uuid
          and event_id = ${initialAutomaticEventId}
      ) as deliveries,
      (
        select count(*)::int from outbox_events as outbox
        join webhook_deliveries as delivery
          on delivery.workspace_id = outbox.workspace_id
          and delivery.id = outbox.webhook_delivery_id
        where delivery.workspace_id = ${primaryWorkspace}::uuid
          and delivery.event_id = ${initialAutomaticEventId}
      ) as outbox,
      (
        select count(*)::int from audit_events
        where workspace_id = ${primaryWorkspace}::uuid
          and action = 'webhook.delivery.enqueued'
          and data->>'eventId' = ${initialAutomaticEventId}
      ) as audits
  `;
  assert.deepEqual(unchangedAutomaticState, { deliveries: 2, outbox: 2, audits: 2 });

  stage = "enforce daily plan head event version contract";
  const alternateAutomaticPlanId = randomUUID();
  await insertDailyPlan(connection, {
    workspaceId: primaryWorkspace,
    planId: alternateAutomaticPlanId,
    date: automaticDate,
    requestRevision: 2,
  });
  const headGuardBaseline = await loadHeadEventArtifactState(connection, {
    workspaceId: primaryWorkspace,
    headId: automaticHeadId,
  });
  await expectRejected(
    () =>
      connection!.sql`
        update daily_plan_heads
        set current_plan_id = ${alternateAutomaticPlanId}::uuid
        where workspace_id = ${primaryWorkspace}::uuid
          and id = ${automaticHeadId}::uuid
          and version = 1
    `,
    "a current-plan change without a head-version advance must reject",
  );
  assert.deepEqual(
    await loadHeadEventArtifactState(connection, {
      workspaceId: primaryWorkspace,
      headId: automaticHeadId,
    }),
    headGuardBaseline,
    "same-version current-plan rejection must not leak head, delivery, outbox, or audit state",
  );
  await expectRejected(
    () =>
      connection!.sql`
        update daily_plan_heads
        set version = 0
        where workspace_id = ${primaryWorkspace}::uuid
          and id = ${automaticHeadId}::uuid
          and version = 1
    `,
    "a daily plan head version decrease must reject",
  );
  assert.deepEqual(
    await loadHeadEventArtifactState(connection, {
      workspaceId: primaryWorkspace,
      headId: automaticHeadId,
    }),
    headGuardBaseline,
    "version-decrease rejection must not leak head, delivery, outbox, or audit state",
  );
  assert.deepEqual(headGuardBaseline, {
    current_plan_id: automaticPlanId,
    head_version: 1,
    deliveries: 2,
    outbox: 2,
    audits: 2,
  });

  stage = "fan out committed head version advance";
  await connection.sql`
    update daily_plan_heads
    set version = 2, updated_at = clock_timestamp()
    where workspace_id = ${primaryWorkspace}::uuid
      and id = ${automaticHeadId}::uuid
      and version = 1
  `;
  const advancedEventId = scheduleChangedEventId(primaryWorkspace, automaticDate, 2);
  const advancedDeliveries = await loadAutomaticDeliveries(
    connection,
    primaryWorkspace,
    advancedEventId,
  );
  assert.equal(advancedDeliveries.length, 2);
  assert.deepEqual(
    advancedDeliveries.map((row) => row.endpoint_id).sort(),
    [endpointId, secondEndpointId].sort(),
  );
  for (const advancedDelivery of advancedDeliveries) {
    const expectedBody = scheduleChangedBody(
      primaryWorkspace,
      automaticDate,
      2,
      advancedEventId,
      advancedDelivery.occurred_time,
    );
    assertAutomaticDeliveryTimestamps(advancedDelivery);
    assert.equal(advancedDelivery.raw_body, expectedBody);
    assert.equal(
      advancedDelivery.body_sha256,
      createHash("sha256").update(expectedBody, "utf8").digest("hex"),
    );
  }

  stage = "verify automatic event tenant isolation";
  const isolatedAutomaticDate = "2026-07-15";
  const isolatedAutomaticHeadId = randomUUID();
  await insertDailyPlanHead(connection, {
    workspaceId: isolatedWorkspace,
    planId: randomUUID(),
    headId: isolatedAutomaticHeadId,
    date: isolatedAutomaticDate,
    requestRevision: 1,
  });
  const isolatedAutomaticEventId = scheduleChangedEventId(
    isolatedWorkspace,
    isolatedAutomaticDate,
    1,
  );
  const isolatedDeliveries = await loadAutomaticDeliveries(
    connection,
    isolatedWorkspace,
    isolatedAutomaticEventId,
  );
  assert.equal(isolatedDeliveries.length, 1);
  assert.equal(isolatedDeliveries[0]?.endpoint_id, isolatedEndpointId);
  assert.equal(
    (await loadAutomaticDeliveries(connection, primaryWorkspace, isolatedAutomaticEventId)).length,
    0,
  );
  assert.equal(
    (await loadAutomaticDeliveries(connection, isolatedWorkspace, initialAutomaticEventId)).length,
    0,
  );

  stage = "serialize concurrent subscription replacement and head advance";
  let signalHeadAdvanced!: () => void;
  let rejectHeadAdvanced!: (error: unknown) => void;
  const headAdvanced = new Promise<void>((resolve, reject) => {
    signalHeadAdvanced = resolve;
    rejectHeadAdvanced = reject;
  });
  let releaseHeadTransaction!: () => void;
  const holdHeadTransaction = new Promise<void>((resolve) => {
    releaseHeadTransaction = resolve;
  });
  const concurrentHeadAdvance = connection.sql.begin(async (transaction) => {
    try {
      await transaction`
        update daily_plan_heads
        set version = 2, updated_at = clock_timestamp()
        where workspace_id = ${isolatedWorkspace}::uuid
          and id = ${isolatedAutomaticHeadId}::uuid
          and version = 1
      `;
      signalHeadAdvanced();
      await holdHeadTransaction;
    } catch (error) {
      rejectHeadAdvanced(error);
      throw error;
    }
  });
  await headAdvanced;
  let replacementSettled = false;
  const concurrentReplacement = replaceWebhookEventSubscriptions(connection, {
    workspaceId: isolatedWorkspace,
    endpointId: isolatedEndpointId,
    eventTypes: [],
    actorId,
  }).finally(() => {
    replacementSettled = true;
  });
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 25);
  });
  const replacementSettledBeforeHeadCommit = replacementSettled;
  releaseHeadTransaction();
  const [, concurrentReplacementResult] = await Promise.all([
    concurrentHeadAdvance,
    concurrentReplacement,
  ]);
  assert.equal(
    replacementSettledBeforeHeadCommit,
    false,
    "subscription replacement must wait for the in-flight head fanout transaction",
  );
  assert.equal(concurrentReplacementResult?.changed, true);
  assert.deepEqual(concurrentReplacementResult?.previousEventTypes, [
    SCHEDULE_CHANGED_WEBHOOK_EVENT_TYPE,
  ]);
  assert.deepEqual(concurrentReplacementResult?.eventTypes, []);
  const concurrentAdvanceEventId = scheduleChangedEventId(
    isolatedWorkspace,
    isolatedAutomaticDate,
    2,
  );
  const concurrentAdvanceDeliveries = await loadAutomaticDeliveries(
    connection,
    isolatedWorkspace,
    concurrentAdvanceEventId,
  );
  assert.equal(concurrentAdvanceDeliveries.length, 1);
  assert.equal(concurrentAdvanceDeliveries[0]?.endpoint_id, isolatedEndpointId);
  await connection.sql`
    update daily_plan_heads
    set version = 3, updated_at = clock_timestamp()
    where workspace_id = ${isolatedWorkspace}::uuid
      and id = ${isolatedAutomaticHeadId}::uuid
      and version = 2
  `;
  assert.equal(
    (
      await loadAutomaticDeliveries(
        connection,
        isolatedWorkspace,
        scheduleChangedEventId(isolatedWorkspace, isolatedAutomaticDate, 3),
      )
    ).length,
    0,
  );

  stage = "disable automatic subscription and suppress later fanout";
  const disabled = await replaceWebhookEventSubscriptions(connection, {
    workspaceId: primaryWorkspace,
    endpointId: secondEndpointId,
    eventTypes: [],
    actorId,
  });
  stage = "verify disabled automatic subscription result";
  assert.deepEqual(disabled, {
    workspaceId: primaryWorkspace,
    endpointId: secondEndpointId,
    previousEventTypes: [SCHEDULE_CHANGED_WEBHOOK_EVENT_TYPE],
    eventTypes: [],
    changed: true,
  });
  stage = "read disabled automatic subscription";
  assert.deepEqual(
    await getWebhookEventSubscriptions(connection, {
      workspaceId: primaryWorkspace,
      endpointId: secondEndpointId,
    }),
    [],
  );
  stage = "read disabled automatic subscription audits";
  const secondEndpointSubscriptionAudits = await connection.sql<{ data: unknown }[]>`
    select data
    from audit_events
    where workspace_id = ${primaryWorkspace}::uuid
      and action = 'webhook.subscriptions.replaced'
      and entity_type = 'webhook_endpoint'
      and entity_id = ${secondEndpointId}::uuid
    order by occurred_at, id
  `;
  stage = "verify disabled automatic subscription audit count";
  assert.equal(secondEndpointSubscriptionAudits.length, 2);
  const secondEndpointAuditData = secondEndpointSubscriptionAudits.map((row) => row.data);
  stage = "verify enabled automatic subscription audit before disable";
  assert.equal(
    secondEndpointAuditData.some((data) =>
      matchesSubscriptionAudit(data, [], [SCHEDULE_CHANGED_WEBHOOK_EVENT_TYPE]),
    ),
    true,
  );
  stage = "verify disabled automatic subscription audit";
  assert.equal(
    secondEndpointAuditData.some((data) =>
      matchesSubscriptionAudit(data, [SCHEDULE_CHANGED_WEBHOOK_EVENT_TYPE], []),
    ),
    true,
  );
  stage = "advance head after automatic unsubscribe";
  await connection.sql`
    update daily_plan_heads
    set version = 3, updated_at = clock_timestamp()
    where workspace_id = ${primaryWorkspace}::uuid
      and id = ${automaticHeadId}::uuid
      and version = 2
  `;
  const afterUnsubscribeEventId = scheduleChangedEventId(primaryWorkspace, automaticDate, 3);
  const afterUnsubscribeDeliveries = await loadAutomaticDeliveries(
    connection,
    primaryWorkspace,
    afterUnsubscribeEventId,
  );
  assert.equal(afterUnsubscribeDeliveries.length, 1);
  assert.equal(afterUnsubscribeDeliveries[0]?.endpoint_id, endpointId);

  stage = "verify automatic event transaction rollback";
  const [automaticRollbackBefore] = await connection.sql<
    {
      head_version: number;
      deliveries: number;
      outbox: number;
      audits: number;
    }[]
  >`
    select
      (select version from daily_plan_heads where id = ${automaticHeadId}::uuid) as head_version,
      (
        select count(*)::int from webhook_deliveries
        where workspace_id = ${primaryWorkspace}::uuid
          and event_type = ${SCHEDULE_CHANGED_WEBHOOK_EVENT_TYPE}
      ) as deliveries,
      (
        select count(*)::int from outbox_events as outbox
        join webhook_deliveries as delivery
          on delivery.workspace_id = outbox.workspace_id
          and delivery.id = outbox.webhook_delivery_id
        where delivery.workspace_id = ${primaryWorkspace}::uuid
          and delivery.event_type = ${SCHEDULE_CHANGED_WEBHOOK_EVENT_TYPE}
      ) as outbox,
      (
        select count(*)::int from audit_events
        where workspace_id = ${primaryWorkspace}::uuid
      ) as audits
  `;
  await expectRejected(
    () =>
      connection!.sql.begin(async (transaction) => {
        await transaction`
          update daily_plan_heads
          set version = 4, updated_at = clock_timestamp()
          where workspace_id = ${primaryWorkspace}::uuid
            and id = ${automaticHeadId}::uuid
            and version = 3
        `;
        await transaction`
          insert into webhook_event_subscriptions (workspace_id, endpoint_id, event_type)
          values (
            ${primaryWorkspace}::uuid,
            ${endpointId}::uuid,
            ${SCHEDULE_CHANGED_WEBHOOK_EVENT_TYPE}
          )
        `;
      }),
    "a later transaction failure must roll back the head and automatic delivery fanout",
  );
  const [automaticRollbackAfter] = await connection.sql<
    {
      head_version: number;
      deliveries: number;
      outbox: number;
      audits: number;
    }[]
  >`
    select
      (select version from daily_plan_heads where id = ${automaticHeadId}::uuid) as head_version,
      (
        select count(*)::int from webhook_deliveries
        where workspace_id = ${primaryWorkspace}::uuid
          and event_type = ${SCHEDULE_CHANGED_WEBHOOK_EVENT_TYPE}
      ) as deliveries,
      (
        select count(*)::int from outbox_events as outbox
        join webhook_deliveries as delivery
          on delivery.workspace_id = outbox.workspace_id
          and delivery.id = outbox.webhook_delivery_id
        where delivery.workspace_id = ${primaryWorkspace}::uuid
          and delivery.event_type = ${SCHEDULE_CHANGED_WEBHOOK_EVENT_TYPE}
      ) as outbox,
      (
        select count(*)::int from audit_events
        where workspace_id = ${primaryWorkspace}::uuid
      ) as audits
  `;
  assert.deepEqual(automaticRollbackAfter, automaticRollbackBefore);

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
    await getWebhookEventSubscriptions(connection, { workspaceId: primaryWorkspace, endpointId }),
    null,
    "revoked endpoint subscriptions must no longer be readable",
  );
  await connection.sql`
    update daily_plan_heads
    set version = 4, updated_at = clock_timestamp()
    where workspace_id = ${primaryWorkspace}::uuid
      and id = ${automaticHeadId}::uuid
      and version = 3
  `;
  assert.equal(
    (
      await loadAutomaticDeliveries(
        connection,
        primaryWorkspace,
        scheduleChangedEventId(primaryWorkspace, automaticDate, 4),
      )
    ).length,
    0,
    "revocation and prior unsubscribe must suppress later automatic fanout",
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
