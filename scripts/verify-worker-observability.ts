import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  collectOperationalDatabaseSnapshot,
  runWorkerObservabilityServer,
  WorkerTelemetry,
} from "../apps/worker/src/observability.js";
import { createDatabase, type DatabaseConnection } from "../packages/database/src/index.js";

const sourceDatabaseUrl =
  process.env.DATABASE_URL ?? "postgres://schedule:schedule@127.0.0.1:5432/schedule";
const verificationDatabase = `schedule_observability_verify_${randomUUID().replaceAll("-", "")}`;
const verificationDatabasePattern = /^schedule_observability_verify_[a-f0-9]{32}$/;
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const privateEventId = randomUUID();
const privateTopic = "private.person.reminder";
const privatePayload = "person@example.com/private-title";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function databaseUrlFor(databaseName: string): string {
  const url = new URL(sourceDatabaseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quotedVerificationDatabase(): string {
  if (!verificationDatabasePattern.test(verificationDatabase)) {
    throw new Error("Unsafe worker-observability verification database identifier.");
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
          `Worker-observability migration failed with exit code ${String(code)}${diagnostic === "" ? "" : `: ${diagnostic}`}`,
        ),
      );
    });
  });
}

const adminConnection = createDatabase(databaseUrlFor("postgres"), 1);
const disposableDatabaseUrl = databaseUrlFor(verificationDatabase);
let databaseCreated = false;
let writerConnection: DatabaseConnection | null = null;
let observabilityConnection: DatabaseConnection | null = null;
let controller: AbortController | null = null;
let serverStopped: Promise<void> | null = null;

try {
  await adminConnection.sql.unsafe(`create database ${quotedVerificationDatabase()}`);
  databaseCreated = true;
  await applyCurrentMigrations(disposableDatabaseUrl);
  writerConnection = createDatabase(disposableDatabaseUrl, 2);
  observabilityConnection = createDatabase(disposableDatabaseUrl, 1, {
    readOnly: true,
    statementTimeoutMs: 5_000,
    applicationName: "schedule-worker-observability-verifier",
  });

  await writerConnection.sql`
    insert into outbox_events (id, topic, payload, status, available_at, created_at)
    values
      (
        ${privateEventId},
        ${privateTopic},
        ${JSON.stringify({ privatePayload })}::jsonb,
        'pending',
        clock_timestamp() - interval '1 minute',
        clock_timestamp() - interval '2 minutes'
      ),
      (
        ${randomUUID()},
        'verification.excluded',
        '{}'::jsonb,
        'pending',
        clock_timestamp() - interval '1 minute',
        clock_timestamp() - interval '2 minutes'
      ),
      (
        ${randomUUID()},
        'verification.processing',
        '{}'::jsonb,
        'processing',
        clock_timestamp() - interval '1 minute',
        clock_timestamp() - interval '2 minutes'
      ),
      (
        ${randomUUID()},
        'verification.dead-letter',
        '{}'::jsonb,
        'dead_letter',
        clock_timestamp() - interval '1 minute',
        clock_timestamp() - interval '2 minutes'
      )
  `;

  const retentionWorkspaceId = randomUUID();
  const retentionCredentialId = randomUUID();
  const retentionDeliveryId = randomUUID();
  await writerConnection.sql.begin(async (transaction) => {
    await transaction`
      insert into workspaces (id, name)
      values (${retentionWorkspaceId}, 'Observability retention semantics')
    `;
    await transaction`
      insert into integration_credentials (
        id, workspace_id, name, secret_digest, scopes
      ) values (
        ${retentionCredentialId},
        ${retentionWorkspaceId},
        'Observability verifier adapter',
        ${"0".repeat(64)},
        array['schedule:delivery']::text[]
      )
    `;
    await transaction`
      insert into notification_delivery_commands (
        id, workspace_id, intent_id, occurrence_key, kind, target_type,
        scheduled_for, local_date, priority, status, attempts, available_at,
        completed_at, created_at, updated_at
      ) values (
        ${retentionDeliveryId},
        ${retentionWorkspaceId},
        ${randomUUID()},
        'observability-retention-occurrence',
        'one_off',
        'one_off',
        clock_timestamp() - interval '2 minutes',
        current_date,
        50,
        'delivered',
        1,
        clock_timestamp() - interval '2 minutes',
        clock_timestamp(),
        clock_timestamp() - interval '2 minutes',
        clock_timestamp()
      )
    `;
    await transaction`
      insert into notification_delivery_attempts (
        id, workspace_id, delivery_id, credential_id, attempt_number,
        claimed_at, lease_expires_at, outcome, completed_at
      ) values (
        ${randomUUID()},
        ${retentionWorkspaceId},
        ${retentionDeliveryId},
        ${retentionCredentialId},
        1,
        clock_timestamp() - interval '1 minute',
        clock_timestamp() + interval '1 minute',
        'delivered',
        clock_timestamp()
      )
    `;
  });
  const retainedAttempts = await collectOperationalDatabaseSnapshot(observabilityConnection);
  assert.equal(retainedAttempts.notificationDeliveryAttempts, 1);
  assert.equal(retainedAttempts.notificationDeliveryDelivered, 1);
  await writerConnection.sql`delete from workspaces where id = ${retentionWorkspaceId}`;
  const deletedAttempts = await collectOperationalDatabaseSnapshot(observabilityConnection);
  assert.equal(deletedAttempts.notificationDeliveryAttempts, 0);
  assert.equal(deletedAttempts.notificationDeliveryDelivered, 0);

  const intentWorkspaceId = randomUUID();
  const fencedReminderId = randomUUID();
  const readyReminderId = randomUUID();
  const fencedIntentId = randomUUID();
  const readyIntentId = randomUUID();
  const fencedOccurrence = "observability-fenced-occurrence";
  await writerConnection.sql.begin(async (transaction) => {
    await transaction`
      insert into workspaces (id, name)
      values (${intentWorkspaceId}, 'Observability occurrence fencing')
    `;
    await transaction`
      insert into one_off_reminders (id, workspace_id, title, scheduled_for)
      values
        (${fencedReminderId}, ${intentWorkspaceId}, 'Fenced reminder', clock_timestamp() - interval '2 minutes'),
        (${readyReminderId}, ${intentWorkspaceId}, 'Ready reminder', clock_timestamp() - interval '2 minutes')
    `;
    await transaction`
      insert into notification_intents (
        id, workspace_id, one_off_reminder_id, kind, occurrence_key, target_type,
        scheduled_for, local_date, priority, policy_snapshot, local_time_resolution
      ) values
        (
          ${fencedIntentId}, ${intentWorkspaceId}, ${fencedReminderId}, 'one_off',
          ${fencedOccurrence}, 'one_off', clock_timestamp() - interval '2 minutes',
          current_date, 50, '{}'::jsonb, 'exact'
        ),
        (
          ${readyIntentId}, ${intentWorkspaceId}, ${readyReminderId}, 'one_off',
          'observability-ready-occurrence', 'one_off', clock_timestamp() - interval '2 minutes',
          current_date, 50, '{}'::jsonb, 'exact'
        )
    `;
    await transaction`
      insert into notification_delivery_commands (
        id, workspace_id, intent_id, occurrence_key, kind, target_type,
        scheduled_for, local_date, priority, status, attempts, available_at
      ) values (
        ${randomUUID()}, ${intentWorkspaceId}, ${randomUUID()}, ${fencedOccurrence},
        'one_off', 'one_off', clock_timestamp() - interval '2 minutes', current_date,
        50, 'pending', 0, clock_timestamp() - interval '2 minutes'
      )
    `;
  });
  const occurrenceAwareSnapshot = await collectOperationalDatabaseSnapshot(observabilityConnection);
  assert.equal(occurrenceAwareSnapshot.notificationIntentsReady, 1);

  await assert.rejects(
    observabilityConnection.sql`
      insert into workspaces (id, name)
      values (${randomUUID()}, 'Read-only pool must reject this write')
    `,
  );

  const telemetry = new WorkerTelemetry(() => new Date("2026-07-14T20:00:00.000Z"));
  telemetry.recordOutboxClaimed();
  telemetry.recordOutboxCompleted();
  telemetry.recordNotificationMaterializationCycle({
    selectedWorkspaces: 1,
    attemptedWorkspaces: 1,
    skippedWorkspaces: 0,
    failedWorkspaces: 0,
    createdIntents: 2,
    existingIntents: 0,
    suppressedCandidates: 0,
    workspaceListFailed: false,
    workspaceLimitExceeded: false,
    aborted: false,
  });
  telemetry.recordHostedSyncCleanupCycle({
    batches: 1,
    deletedChanges: 250,
    workspacesTouched: 1,
    failed: false,
    contended: false,
    limitReached: false,
    aborted: false,
  });

  controller = new AbortController();
  let resolveAddress: ((address: AddressInfo) => void) | undefined;
  const address = new Promise<AddressInfo>((resolve) => {
    resolveAddress = resolve;
  });
  serverStopped = runWorkerObservabilityServer(
    {
      port: 0,
      database: observabilityConnection,
      telemetry,
      excludedOutboxTopics: ["verification.excluded"],
      onListening: (bound) => resolveAddress?.(bound),
    },
    controller.signal,
  );
  const bound = await address;
  assert.equal(bound.address, "127.0.0.1");
  const baseUrl = `http://127.0.0.1:${bound.port}`;

  const live = await fetch(`${baseUrl}/health/live`);
  assert.equal(live.status, 200);
  assert.deepEqual(await live.json(), { status: "alive" });
  assert.equal(live.headers.get("cache-control"), "no-store");
  assert.equal(live.headers.has("access-control-allow-origin"), false);

  const ready = await fetch(`${baseUrl}/health/ready`);
  assert.equal(ready.status, 200);
  assert.deepEqual(await ready.json(), { status: "ready" });

  const metricsResponse = await fetch(`${baseUrl}/metrics`);
  assert.equal(metricsResponse.status, 200);
  const metrics = await metricsResponse.text();
  assert.match(metrics, /schedule_worker_database_up 1\n/);
  assert.match(metrics, /schedule_outbox_ready 1\n/);
  assert.match(metrics, /schedule_outbox_processing 1\n/);
  assert.match(metrics, /schedule_outbox_dead_letter 1\n/);
  assert.match(metrics, /schedule_outbox_claimed_total 1\n/);
  assert.match(metrics, /schedule_notification_materialization_created_intents_total 2\n/);
  assert.match(metrics, /schedule_hosted_sync_cleanup_cycles_total 1\n/);
  assert.match(metrics, /schedule_hosted_sync_cleanup_deleted_changes_total 250\n/);
  assert.match(metrics, /schedule_hosted_sync_cleanup_contention_total 0\n/);
  assert.match(metrics, /schedule_notification_intents_ready 1\n/);
  assert.match(metrics, /# TYPE schedule_notification_delivery_attempt_records gauge\n/);
  assert.match(metrics, /schedule_notification_delivery_attempt_records 0\n/);
  assert.doesNotMatch(metrics, new RegExp(escapeRegExp(privateEventId), "u"));
  assert.doesNotMatch(metrics, new RegExp(escapeRegExp(privateTopic), "u"));
  assert.doesNotMatch(metrics, new RegExp(escapeRegExp(privatePayload), "u"));
  assert.doesNotMatch(metrics, /\{[^\n]*\}/u, "metrics must not contain dynamic labels");

  await observabilityConnection.close();
  observabilityConnection = null;
  const unavailableReady = await fetch(`${baseUrl}/health/ready`);
  assert.equal(unavailableReady.status, 503);
  assert.deepEqual(await unavailableReady.json(), { status: "not_ready" });
  const unavailableMetrics = await (await fetch(`${baseUrl}/metrics`)).text();
  assert.match(unavailableMetrics, /schedule_worker_database_up 0\n/);
  assert.match(unavailableMetrics, /schedule_outbox_ready NaN\n/);
  assert.match(unavailableMetrics, /schedule_worker_database_collection_failures_total 1\n/);
  assert.doesNotMatch(unavailableMetrics, /person@example\.com|private-title|postgres:/u);

  controller.abort("verification complete");
  await serverStopped;
  controller = null;
  serverStopped = null;

  process.stdout.write(
    `Worker observability verification passed loopback binding, dedicated read-only database isolation, bounded health semantics, database queue gauges, retention-aware attempt gauges, fixed-cardinality metrics, redaction, database-failure signaling, and shutdown in ${verificationDatabase}\n`,
  );
} finally {
  controller?.abort("verification cleanup");
  if (serverStopped !== null) await serverStopped.catch(() => undefined);
  if (observabilityConnection !== null)
    await observabilityConnection.close().catch(() => undefined);
  if (writerConnection !== null) await writerConnection.close().catch(() => undefined);
  if (databaseCreated) {
    await adminConnection.sql.unsafe(
      `drop database if exists ${quotedVerificationDatabase()} with (force)`,
    );
    const [remaining] = await adminConnection.sql<{ exists: boolean }[]>`
      select exists(select 1 from pg_database where datname = ${verificationDatabase}) as exists
    `;
    assert.equal(
      remaining?.exists,
      false,
      "the disposable worker-observability verification database must be removed",
    );
  }
  await adminConnection.close();
}
