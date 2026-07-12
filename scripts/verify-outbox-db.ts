import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { verifyOutboxProcessFaultRecovery } from "../apps/worker/test-fixtures/outbox-process-fault-harness.js";

import {
  claimNextOutboxEvent,
  completeOutboxEvent,
  createDatabase,
  failOutboxEvent,
  releaseOutboxEvent,
  renewOutboxEventLease,
  type ClaimedOutboxEvent,
  type DatabaseConnection,
} from "../packages/database/src/index.js";

const sourceDatabaseUrl =
  process.env.DATABASE_URL ?? "postgres://schedule:schedule@127.0.0.1:5432/schedule";
const verificationDatabase = `schedule_outbox_verify_${randomUUID().replaceAll("-", "")}`;
const verificationDatabasePattern = /^schedule_outbox_verify_[a-f0-9]{32}$/;
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

const adminConnection = createDatabase(databaseUrlFor("postgres"), 1);
const disposableDatabaseUrl = databaseUrlFor(verificationDatabase);
let databaseCreated = false;
let firstWorker: DatabaseConnection | null = null;
let secondWorker: DatabaseConnection | null = null;

const claimOptions = {
  leaseDurationMs: 1_000,
  maxAttempts: 3,
  deadLetterRecoveryLimit: 10,
} as const;

async function insertPendingEvent(
  connection: DatabaseConnection,
  id: string,
  topic: string,
): Promise<void> {
  await connection.sql`
    insert into outbox_events (id, topic, payload, available_at, created_at)
    values (
      ${id},
      ${topic},
      ${JSON.stringify({ verification: true })}::jsonb,
      '-infinity'::timestamptz,
      '-infinity'::timestamptz
    )
  `;
}

async function claimExpected(
  connection: DatabaseConnection,
  expectedId: string,
): Promise<ClaimedOutboxEvent> {
  const result = await claimNextOutboxEvent(connection, claimOptions);
  if (!result.event || result.event.id !== expectedId) {
    throw new Error(`Expected disposable outbox event ${expectedId} to be claimed`);
  }
  return result.event;
}

async function insertProcessingEvent(
  connection: DatabaseConnection,
  id: string,
  topic: string,
  attempts: number,
): Promise<ClaimedOutboxEvent> {
  const [row] = await connection.sql<
    { workspace_id: string | null; payload: Record<string, unknown>; locked_at: string }[]
  >`
    insert into outbox_events (
      id, topic, payload, status, attempts, available_at, locked_at, created_at
    )
    values (
      ${id},
      ${topic},
      ${JSON.stringify({ verification: true })}::jsonb,
      'processing',
      ${attempts},
      '-infinity'::timestamptz,
      clock_timestamp(),
      '-infinity'::timestamptz
    )
    returning workspace_id, payload, locked_at::text as locked_at
  `;
  if (!row) throw new Error("The processing verification row was not inserted");
  return {
    id,
    workspaceId: row.workspace_id,
    topic,
    payload: row.payload,
    attempts,
    lockedAt: row.locked_at,
  };
}

async function closeIfOpen(connection: DatabaseConnection | null): Promise<void> {
  if (connection) await connection.close().catch(() => undefined);
}

async function applyCurrentMigrations(): Promise<void> {
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
      env: { ...process.env, DATABASE_URL: disposableDatabaseUrl, NODE_ENV: "test" },
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
        .replaceAll(disposableDatabaseUrl, "[DISPOSABLE_DATABASE_URL]")
        .trim();
      reject(
        new Error(
          `Disposable database migration failed with exit code ${String(code)}${diagnostic === "" ? "" : `: ${diagnostic}`}`,
        ),
      );
    });
  });
}

try {
  await adminConnection.sql.unsafe(`create database ${quotedVerificationDatabase()}`);
  databaseCreated = true;

  await applyCurrentMigrations();
  await verifyOutboxProcessFaultRecovery({
    databaseUrl: disposableDatabaseUrl,
    repositoryRoot,
  });

  firstWorker = createDatabase(disposableDatabaseUrl, 1);
  secondWorker = createDatabase(disposableDatabaseUrl, 1);

  // Two workers racing for one row must never receive the same claim.
  const exclusionId = randomUUID();
  await insertPendingEvent(firstWorker, exclusionId, "verification.outbox.claim-exclusion");
  const [firstResult, secondResult] = await Promise.all([
    claimNextOutboxEvent(firstWorker, claimOptions),
    claimNextOutboxEvent(secondWorker, claimOptions),
  ]);
  const matchingClaims = [firstResult.event, secondResult.event].filter(
    (event): event is ClaimedOutboxEvent => event?.id === exclusionId,
  );
  assert.equal(matchingClaims.length, 1, "exactly one worker must receive the contested event");
  assert.equal(
    [firstResult.event, secondResult.event].filter(Boolean).length,
    1,
    "the losing worker must not receive another pre-leased event",
  );
  const exclusionClaim = matchingClaims[0];
  if (!exclusionClaim) throw new Error("The contested outbox event was not claimed");
  assert.equal(exclusionClaim.attempts, 1);
  assert.equal(await completeOutboxEvent(firstWorker, exclusionClaim), "applied");

  // Renewal rotates the token; the superseded token must be fenced out.
  const renewalId = randomUUID();
  await insertPendingEvent(firstWorker, renewalId, "verification.outbox.renewal");
  const originalClaim = await claimExpected(firstWorker, renewalId);
  const renewal = await renewOutboxEventLease(firstWorker, originalClaim);
  if (renewal.status !== "renewed") throw new Error("The active lease could not be renewed");
  assert.notEqual(renewal.event.lockedAt, originalClaim.lockedAt);
  assert.equal(await completeOutboxEvent(secondWorker, originalClaim), "stale");
  assert.equal(await completeOutboxEvent(firstWorker, renewal.event), "applied");

  // Handler failures use fenced retry scheduling, then reach dead letter at
  // the exact configured attempt ceiling. The retry cap is 60 seconds.
  const retryId = randomUUID();
  await insertPendingEvent(firstWorker, retryId, "verification.outbox.retry");
  const retryClaim = await claimExpected(firstWorker, retryId);
  const retryFailureStartedAt = Date.now();
  assert.equal(
    await failOutboxEvent(firstWorker, retryClaim, "temporary verification failure", 3),
    "retry_scheduled",
  );
  const retryFailureFinishedAt = Date.now();
  const [retryState] = await firstWorker.sql<
    {
      status: string;
      attempts: number;
      locked_at: string | null;
      last_error: string | null;
      available_at_ms: number;
    }[]
  >`
    select
      status::text as status,
      attempts,
      locked_at::text as locked_at,
      last_error,
      extract(epoch from available_at) * 1000 as available_at_ms
    from outbox_events
    where id = ${retryId}
  `;
  assert.equal(retryState?.status, "pending");
  assert.equal(retryState?.attempts, 1);
  assert.equal(retryState?.locked_at, null);
  assert.equal(retryState?.last_error, "temporary verification failure");
  const retryAvailableAt = Number(retryState?.available_at_ms);
  assert.ok(
    retryAvailableAt >= retryFailureStartedAt + 1_900 &&
      retryAvailableAt <= retryFailureFinishedAt + 2_100,
    "attempt one must persist a two-second retry delay from the failure transition",
  );

  const cappedRetryId = randomUUID();
  const cappedRetryClaim = await insertProcessingEvent(
    firstWorker,
    cappedRetryId,
    "verification.outbox.retry-cap",
    6,
  );
  const cappedFailureStartedAt = Date.now();
  assert.equal(
    await failOutboxEvent(firstWorker, cappedRetryClaim, "capped retry", 8),
    "retry_scheduled",
  );
  const cappedFailureFinishedAt = Date.now();
  const [cappedRetryState] = await firstWorker.sql<{ available_at_ms: number }[]>`
    select extract(epoch from available_at) * 1000 as available_at_ms
    from outbox_events
    where id = ${cappedRetryId}
  `;
  const cappedAvailableAt = Number(cappedRetryState?.available_at_ms);
  assert.ok(
    cappedAvailableAt >= cappedFailureStartedAt + 59_900 &&
      cappedAvailableAt <= cappedFailureFinishedAt + 60_100,
    "retry delay must persist the sixty-second cap from the failure transition",
  );

  const terminalFailureId = randomUUID();
  const terminalFailureClaim = await insertProcessingEvent(
    firstWorker,
    terminalFailureId,
    "verification.outbox.terminal-failure",
    claimOptions.maxAttempts,
  );
  assert.equal(
    await failOutboxEvent(
      firstWorker,
      terminalFailureClaim,
      "terminal verification failure",
      claimOptions.maxAttempts,
    ),
    "dead_lettered",
  );
  const [terminalFailureState] = await firstWorker.sql<
    { status: string; attempts: number; locked_at: string | null; last_error: string | null }[]
  >`
    select status::text as status, attempts, locked_at::text as locked_at, last_error
    from outbox_events
    where id = ${terminalFailureId}
  `;
  assert.deepEqual(terminalFailureState, {
    status: "dead_letter",
    attempts: claimOptions.maxAttempts,
    locked_at: null,
    last_error: "terminal verification failure",
  });

  // A crashed worker's expired lease is reclaimable below the attempt ceiling.
  const expiredId = randomUUID();
  const [expiredRow] = await firstWorker.sql<{ locked_at: string }[]>`
    insert into outbox_events (
      id,
      topic,
      payload,
      status,
      attempts,
      available_at,
      locked_at,
      created_at
    )
    values (
      ${expiredId},
      'verification.outbox.expired-reclaim',
      ${JSON.stringify({ verification: true })}::jsonb,
      'processing',
      1,
      '-infinity'::timestamptz,
      '-infinity'::timestamptz,
      '-infinity'::timestamptz
    )
    returning locked_at::text as locked_at
  `;
  if (!expiredRow) throw new Error("The expired verification row was not inserted");
  const expiredClaim: ClaimedOutboxEvent = {
    id: expiredId,
    workspaceId: null,
    topic: "verification.outbox.expired-reclaim",
    payload: { verification: true },
    attempts: 1,
    lockedAt: expiredRow.locked_at,
  };
  const reclaimed = await claimExpected(secondWorker, expiredId);
  assert.equal(reclaimed.attempts, 2);
  assert.notEqual(reclaimed.lockedAt, expiredClaim.lockedAt);
  assert.equal(await completeOutboxEvent(firstWorker, expiredClaim), "stale");
  assert.equal(await completeOutboxEvent(secondWorker, reclaimed), "applied");

  // Repeated crashes stop at maxAttempts and become observable dead letters.
  const exhaustedId = randomUUID();
  await firstWorker.sql`
    insert into outbox_events (
      id,
      topic,
      payload,
      status,
      attempts,
      available_at,
      locked_at,
      created_at
    )
    values (
      ${exhaustedId},
      'verification.outbox.crash-exhausted',
      ${JSON.stringify({ verification: true })}::jsonb,
      'processing',
      ${claimOptions.maxAttempts},
      '-infinity'::timestamptz,
      '-infinity'::timestamptz,
      '-infinity'::timestamptz
    )
  `;
  const exhaustionResult = await claimNextOutboxEvent(firstWorker, claimOptions);
  assert.equal(exhaustionResult.event, null);
  assert.equal(
    exhaustionResult.deadLettered.some((event) => event.id === exhaustedId),
    true,
    "an expired claim at maxAttempts must be reported as dead-lettered",
  );
  const [exhaustedState] = await firstWorker.sql<
    { status: string; attempts: number; locked_at: string | null }[]
  >`
    select status::text as status, attempts, locked_at::text as locked_at
    from outbox_events
    where id = ${exhaustedId}
  `;
  assert.deepEqual(exhaustedState, {
    status: "dead_letter",
    attempts: claimOptions.maxAttempts,
    locked_at: null,
  });

  // Graceful release restores an unstarted claim without consuming an attempt.
  const releaseId = randomUUID();
  await insertPendingEvent(firstWorker, releaseId, "verification.outbox.release");
  const releasable = await claimExpected(firstWorker, releaseId);
  assert.equal(releasable.attempts, 1);
  assert.equal(await releaseOutboxEvent(firstWorker, releasable), "applied");
  const [releasedState] = await firstWorker.sql<
    { status: string; attempts: number; locked_at: string | null }[]
  >`
    select status::text as status, attempts, locked_at::text as locked_at
    from outbox_events
    where id = ${releaseId}
  `;
  assert.deepEqual(releasedState, { status: "pending", attempts: 0, locked_at: null });
  const reclaimedAfterRelease = await claimExpected(secondWorker, releaseId);
  assert.equal(reclaimedAfterRelease.attempts, 1);
  assert.equal(await completeOutboxEvent(secondWorker, reclaimedAfterRelease), "applied");

  process.stdout.write(
    `outbox database verification passed claim, fencing, process-crash recovery, retry, and cleanup in ${verificationDatabase}\n`,
  );
} finally {
  await Promise.all([closeIfOpen(firstWorker), closeIfOpen(secondWorker)]);
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
      "the disposable outbox verification database must be removed",
    );
  }
  await adminConnection.close();
}
