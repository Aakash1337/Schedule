import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildApp } from "../apps/api/src/app.js";
import { createProductServices } from "../apps/api/src/product-services.js";
import {
  createNotificationMaterializationDependencies,
  runNotificationMaterializationCycle,
  type NotificationMaterializationLogger,
} from "../apps/worker/src/notification-materializer.js";
import {
  createDatabase,
  PostgresUnitOfWork,
  type DatabaseConnection,
} from "../packages/database/src/index.js";

const sourceDatabaseUrl =
  process.env.DATABASE_URL ?? "postgres://schedule:schedule@127.0.0.1:5432/schedule";
const verificationDatabase = `schedule_nm_verify_${randomUUID().replaceAll("-", "")}`;
const verificationDatabasePattern = /^schedule_nm_verify_[a-f0-9]{32}$/;
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixedNow = new Date("2026-07-20T08:00:00.000Z");

function databaseUrlFor(databaseName: string): string {
  const url = new URL(sourceDatabaseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quotedVerificationDatabase(): string {
  if (!verificationDatabasePattern.test(verificationDatabase)) {
    throw new Error("Unsafe notification-materializer verification database identifier.");
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
          `Notification-materializer migration failed with exit code ${String(code)}${diagnostic === "" ? "" : `: ${diagnostic}`}`,
        ),
      );
    });
  });
}

async function closeIfOpen(connection: DatabaseConnection | null): Promise<void> {
  if (connection !== null) await connection.close();
}

const adminConnection = createDatabase(databaseUrlFor("postgres"), 1);
const disposableDatabaseUrl = databaseUrlFor(verificationDatabase);
let databaseCreated = false;
let apiConnection: DatabaseConnection | null = null;
let firstWorker: DatabaseConnection | null = null;
let secondWorker: DatabaseConnection | null = null;
let app: Awaited<ReturnType<typeof buildApp>> | null = null;

try {
  await adminConnection.sql.unsafe(`create database ${quotedVerificationDatabase()}`);
  databaseCreated = true;
  await applyCurrentMigrations(disposableDatabaseUrl);

  apiConnection = createDatabase(disposableDatabaseUrl, 4);
  app = await buildApp({
    productServices: createProductServices(new PostgresUnitOfWork(apiConnection), {
      now: () => new Date(fixedNow),
    }),
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

  const workspaceId = await createWorkspace("Automatic reminder verification");
  const zeroCatchUpWorkspaceId = await createWorkspace("Automatic reminder zero catch-up");
  await createWorkspace("Automatic reminder unconfigured skip");

  const configureProfile = async (targetWorkspaceId: string, catchUpWindowMinutes: number) => {
    const response = await app!.inject({
      method: "PUT",
      url: `/v1/workspaces/${targetWorkspaceId}/notification-profile`,
      payload: {
        expectedVersion: null,
        timeZone: "UTC",
        quietHoursStartMinute: 1320,
        quietHoursEndMinute: 420,
        quietHoursPolicy: "next_allowed",
        catchUpWindowMinutes,
        dailyIntentLimit: 20,
      },
    });
    assert.equal(response.statusCode, 200, response.body);
  };
  await configureProfile(workspaceId, 5);
  await configureProfile(zeroCatchUpWorkspaceId, 0);

  const rule = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${workspaceId}/notification-rules`,
    payload: { kind: "daily_digest", localMinute: 484 },
  });
  assert.equal(rule.statusCode, 201, rule.body);

  const oneOff = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${workspaceId}/one-off-reminders`,
    payload: {
      title: "Private automatic verifier one-off",
      scheduledFor: "2026-07-20T08:03:00.000Z",
    },
  });
  assert.equal(oneOff.statusCode, 201, oneOff.body);

  const caughtUpOneOff = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${workspaceId}/one-off-reminders`,
    payload: {
      title: "Private automatic catch-up one-off",
      scheduledFor: "2026-07-20T07:58:00.000Z",
    },
  });
  assert.equal(caughtUpOneOff.statusCode, 201, caughtUpOneOff.body);

  const staleOneOff = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${workspaceId}/one-off-reminders`,
    payload: {
      title: "Private automatic stale one-off",
      scheduledFor: "2026-07-20T07:50:00.000Z",
    },
  });
  assert.equal(staleOneOff.statusCode, 201, staleOneOff.body);

  const zeroCatchUpOneOff = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${zeroCatchUpWorkspaceId}/one-off-reminders`,
    payload: {
      title: "Private automatic zero catch-up one-off",
      scheduledFor: "2026-07-20T07:59:00.000Z",
    },
  });
  assert.equal(zeroCatchUpOneOff.statusCode, 201, zeroCatchUpOneOff.body);

  const [outboxBefore] = await apiConnection.sql<{ count: number }[]>`
    select count(*)::integer as count from outbox_events
  `;
  const [deliveryBefore] = await apiConnection.sql<{ count: number }[]>`
    select count(*)::integer as count from notification_delivery_commands
  `;
  assert.ok(outboxBefore !== undefined && deliveryBefore !== undefined);

  firstWorker = createDatabase(disposableDatabaseUrl, 2);
  secondWorker = createDatabase(disposableDatabaseUrl, 2);
  const clock = { now: () => new Date(fixedNow) };
  const firstDependencies = createNotificationMaterializationDependencies(
    new PostgresUnitOfWork(firstWorker),
    clock,
  );
  const secondDependencies = createNotificationMaterializationDependencies(
    new PostgresUnitOfWork(secondWorker),
    clock,
  );
  const infoLogs: Record<string, string | number | boolean>[] = [];
  const errorLogs: Record<string, string | number | boolean>[] = [];
  const logger: NotificationMaterializationLogger = {
    info: (entry) => infoLogs.push({ ...entry }),
    error: (entry) => errorLogs.push({ ...entry }),
  };
  const config = {
    NOTIFICATION_MATERIALIZATION_MODE: "enabled" as const,
    NOTIFICATION_MATERIALIZATION_INTERVAL_MS: 60_000,
    NOTIFICATION_MATERIALIZATION_LOOKAHEAD_MS: 300_000,
  };

  const [first, second] = await Promise.all([
    runNotificationMaterializationCycle(
      config,
      firstDependencies,
      new AbortController().signal,
      logger,
    ),
    runNotificationMaterializationCycle(
      config,
      secondDependencies,
      new AbortController().signal,
      logger,
    ),
  ]);

  assert.equal(first.selectedWorkspaces, 3);
  assert.equal(second.selectedWorkspaces, 3);
  assert.equal(first.skippedWorkspaces, 1);
  assert.equal(second.skippedWorkspaces, 1);
  assert.equal(first.failedWorkspaces + second.failedWorkspaces, 0);
  assert.equal(first.createdIntents + second.createdIntents, 3);
  assert.equal(first.existingIntents + second.existingIntents, 3);

  await firstWorker.close();
  firstWorker = null;
  firstWorker = createDatabase(disposableDatabaseUrl, 2);
  const restartedDependencies = createNotificationMaterializationDependencies(
    new PostgresUnitOfWork(firstWorker),
    clock,
  );
  const restarted = await runNotificationMaterializationCycle(
    config,
    restartedDependencies,
    new AbortController().signal,
    logger,
  );
  assert.equal(restarted.createdIntents, 0);
  assert.equal(restarted.existingIntents, 3);
  assert.equal(restarted.skippedWorkspaces, 1);

  const [intentState] = await apiConnection.sql<{ count: number; occurrence_count: number }[]>`
    select
      count(*)::integer as count,
      count(distinct occurrence_key)::integer as occurrence_count
    from notification_intents
    where workspace_id = ${workspaceId}
  `;
  assert.deepEqual(intentState, { count: 3, occurrence_count: 3 });

  const [catchUpState] = await apiConnection.sql<
    { caught_up: number; stale: number; zero_catch_up: number }[]
  >`
    select
      count(*) filter (where workspace_id = ${workspaceId} and caught_up)::integer as caught_up,
      count(*) filter (
        where workspace_id = ${workspaceId}
          and title_snapshot = 'Private automatic stale one-off'
      )::integer as stale,
      count(*) filter (where workspace_id = ${zeroCatchUpWorkspaceId})::integer as zero_catch_up
    from notification_intents
  `;
  assert.deepEqual(catchUpState, { caught_up: 1, stale: 0, zero_catch_up: 0 });

  const [outboxAfter] = await apiConnection.sql<{ count: number }[]>`
    select count(*)::integer as count from outbox_events
  `;
  const [deliveryAfter] = await apiConnection.sql<{ count: number }[]>`
    select count(*)::integer as count from notification_delivery_commands
  `;
  assert.deepEqual(outboxAfter, outboxBefore);
  assert.deepEqual(deliveryAfter, deliveryBefore);
  assert.equal(errorLogs.length, 0);
  assert.equal(infoLogs.length, 3);
  assert.doesNotMatch(JSON.stringify({ infoLogs, errorLogs }), /Private automatic/);

  process.stdout.write(
    `Notification materializer verification passed bounded automatic discovery, catch-up boundaries, concurrent exact-once replay, unconfigured skips, restart replay, and no delivery/outbox side effects in ${verificationDatabase}\n`,
  );
} finally {
  if (app !== null) await app.close();
  await Promise.all([
    closeIfOpen(apiConnection),
    closeIfOpen(firstWorker),
    closeIfOpen(secondWorker),
  ]);
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
      "the disposable notification-materializer verification database must be removed",
    );
  }
  await adminConnection.close();
}
