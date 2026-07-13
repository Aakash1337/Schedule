import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";

import {
  completeOutboxEvent,
  createDatabase,
  type ClaimedOutboxEvent,
  type DatabaseConnection,
} from "../../../packages/database/src/index.js";

type ProcessFaultPhase = "before_side_effect" | "after_side_effect" | "recovery";

interface ProcessFaultBarrier {
  readonly type: "barrier";
  readonly phase: ProcessFaultPhase;
  readonly event: {
    readonly id: string;
    readonly attempts: number;
    readonly lockedAt: string;
    readonly topic: string;
  };
}

interface ProcessFaultEventState {
  readonly status: string;
  readonly attempts: number;
  readonly locked_at: string | null;
}

interface ProcessFaultContext {
  readonly databaseUrl: string;
  readonly repositoryRoot: string;
  readonly connection: DatabaseConnection;
  readonly children: Map<ChildProcess, { readonly stdout: Buffer[]; readonly stderr: Buffer[] }>;
}

const leaseDurationMs = 2_000;
const deadlineMs = 20_000;

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isBarrier(value: unknown): value is ProcessFaultBarrier {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ProcessFaultBarrier>;
  return (
    candidate.type === "barrier" &&
    ["before_side_effect", "after_side_effect", "recovery"].includes(candidate.phase ?? "") &&
    typeof candidate.event?.id === "string" &&
    Number.isSafeInteger(candidate.event.attempts) &&
    typeof candidate.event.lockedAt === "string" &&
    typeof candidate.event.topic === "string"
  );
}

function diagnostic(context: ProcessFaultContext, child: ChildProcess): string {
  const output = context.children.get(child);
  if (!output) return "";
  return Buffer.concat([...output.stdout, ...output.stderr])
    .toString("utf8")
    .replaceAll(context.databaseUrl, "[DISPOSABLE_DATABASE_URL]")
    .trim();
}

function startWorker(
  context: ProcessFaultContext,
  phase: ProcessFaultPhase,
  eventId: string,
  topic: string,
): ChildProcess {
  const fixture = path.join(
    context.repositoryRoot,
    "apps",
    "worker",
    "test-fixtures",
    "outbox-process-fault-worker.ts",
  );
  const child = fork(fixture, [], {
    cwd: context.repositoryRoot,
    env: {
      ...process.env,
      NODE_ENV: "test",
      OUTBOX_FAULT_DATABASE_URL: context.databaseUrl,
      OUTBOX_FAULT_EVENT_ID: eventId,
      OUTBOX_FAULT_TOPIC: topic,
      OUTBOX_FAULT_PHASE: phase,
      OUTBOX_FAULT_LEASE_DURATION_MS: String(leaseDurationMs),
    },
    execArgv: process.execArgv,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  const output = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
  context.children.set(child, output);
  child.stdout?.on("data", (chunk: Buffer) => output.stdout.push(chunk));
  child.stderr?.on("data", (chunk: Buffer) => output.stderr.push(chunk));
  return child;
}

async function waitForBarrier(
  context: ProcessFaultContext,
  child: ChildProcess,
  expectedPhase: ProcessFaultPhase,
  expectedEventId: string,
): Promise<ProcessFaultBarrier> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      const detail = diagnostic(context, child);
      reject(
        new Error(
          `Timed out waiting for ${expectedPhase} worker barrier${detail === "" ? "" : `: ${detail}`}`,
        ),
      );
    }, deadlineMs);
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const onMessage = (message: unknown): void => {
      if (
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "fatal"
      ) {
        cleanup();
        reject(new Error("Outbox process-fault worker reported a fatal error."));
        return;
      }
      if (
        isBarrier(message) &&
        message.phase === expectedPhase &&
        message.event.id === expectedEventId
      ) {
        cleanup();
        resolve(message);
      }
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      const detail = diagnostic(context, child);
      reject(
        new Error(
          `Outbox process-fault worker exited before its barrier (code ${String(code)}, signal ${String(signal)})${detail === "" ? "" : `: ${detail}`}`,
        ),
      );
    };
    child.on("message", onMessage);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

async function waitForExit(child: ChildProcess, timeoutMs = 5_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for outbox process-fault worker to exit."));
    }, timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timeout);
      child.off("exit", onExit);
      child.off("error", onError);
    };
    const onExit = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

async function killWorker(context: ProcessFaultContext, child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null && !child.kill("SIGKILL")) {
    try {
      await waitForExit(child, 1_000);
    } catch (error) {
      throw new Error("Could not terminate outbox process-fault worker.", { cause: error });
    }
  }
  await waitForExit(child);
  context.children.delete(child);
}

async function sendCommand(child: ChildProcess, command: "continue" | "stop"): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    child.send({ type: command }, (error) => (error ? reject(error) : resolve()));
  });
}

async function stopWorker(context: ProcessFaultContext, child: ChildProcess): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    await sendCommand(child, "stop");
    try {
      await waitForExit(child);
    } catch (error) {
      await killWorker(context, child);
      throw error;
    }
  }
  const detail = diagnostic(context, child);
  context.children.delete(child);
  if (child.exitCode !== 0) {
    throw new Error(
      `Recovery worker did not exit cleanly (code ${String(child.exitCode)}, signal ${String(child.signalCode)})${detail === "" ? "" : `: ${detail}`}`,
    );
  }
}

async function readEventState(
  connection: DatabaseConnection,
  eventId: string,
): Promise<ProcessFaultEventState> {
  const [state] = await connection.sql<ProcessFaultEventState[]>`
    select status::text as status, attempts, locked_at::text as locked_at
    from outbox_events
    where id = ${eventId}
  `;
  if (!state) throw new Error(`Process-fault event disappeared: ${eventId}`);
  return state;
}

async function waitForCompletion(
  connection: DatabaseConnection,
  eventId: string,
): Promise<ProcessFaultEventState> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const state = await readEventState(connection, eventId);
    if (state.status === "completed") return state;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for recovered process-fault event ${eventId} to complete.`);
}

async function effectCount(connection: DatabaseConnection, eventId: string): Promise<number> {
  const [row] = await connection.sql<{ count: number }[]>`
    select count(*)::integer as count
    from outbox_process_fault_effects
    where event_id = ${eventId}::uuid
  `;
  return row?.count ?? 0;
}

async function insertPendingEvent(
  connection: DatabaseConnection,
  eventId: string,
  topic: string,
): Promise<void> {
  await connection.sql`
    insert into outbox_events (id, topic, payload, available_at, created_at)
    values (
      ${eventId},
      ${topic},
      ${JSON.stringify({ verification: true })}::jsonb,
      '-infinity'::timestamptz,
      '-infinity'::timestamptz
    )
  `;
}

async function verifyCrashPhase(
  context: ProcessFaultContext,
  phase: Exclude<ProcessFaultPhase, "recovery">,
): Promise<void> {
  const eventId = randomUUID();
  const topic = `verification.outbox.process-fault.${phase}`;
  await insertPendingEvent(context.connection, eventId, topic);

  const crashingWorker = startWorker(context, phase, eventId, topic);
  const firstBarrier = await waitForBarrier(context, crashingWorker, phase, eventId);
  assert.equal(firstBarrier.event.attempts, 1);
  assert.equal(firstBarrier.event.topic, topic);
  const stateAtBarrier = await readEventState(context.connection, eventId);
  assert.equal(stateAtBarrier.status, "processing");
  assert.equal(stateAtBarrier.attempts, 1);
  assert.notEqual(stateAtBarrier.locked_at, null);
  assert.equal(
    await effectCount(context.connection, eventId),
    phase === "before_side_effect" ? 0 : 1,
  );

  await killWorker(context, crashingWorker);
  const crashedState = await readEventState(context.connection, eventId);
  assert.equal(crashedState.status, "processing");
  assert.equal(crashedState.attempts, 1);
  if (crashedState.locked_at === null) {
    throw new Error("Killed worker claim unexpectedly lost its fencing token.");
  }

  const recoveryWorker = startWorker(context, "recovery", eventId, topic);
  const recoveryBarrier = await waitForBarrier(context, recoveryWorker, "recovery", eventId);
  assert.equal(recoveryBarrier.event.attempts, 2);
  assert.notEqual(recoveryBarrier.event.lockedAt, crashedState.locked_at);
  assert.equal(await effectCount(context.connection, eventId), 1);

  const crashedClaim: ClaimedOutboxEvent = {
    id: eventId,
    workspaceId: null,
    topic,
    payload: { verification: true },
    attempts: 1,
    lockedAt: crashedState.locked_at,
  };
  assert.equal(
    await completeOutboxEvent(context.connection, crashedClaim),
    "stale",
    "the killed worker's fencing token must not acknowledge the recovered claim",
  );

  await sendCommand(recoveryWorker, "continue");
  assert.deepEqual(await waitForCompletion(context.connection, eventId), {
    status: "completed",
    attempts: 2,
    locked_at: null,
  });
  assert.equal(
    await effectCount(context.connection, eventId),
    1,
    "redelivery must not duplicate an idempotent side effect",
  );
  await stopWorker(context, recoveryWorker);
}

export async function verifyOutboxProcessFaultRecovery(options: {
  readonly databaseUrl: string;
  readonly repositoryRoot: string;
}): Promise<void> {
  const connection = createDatabase(options.databaseUrl, 1);
  const context: ProcessFaultContext = {
    ...options,
    connection,
    children: new Map(),
  };
  let verificationFailure: unknown;

  try {
    await connection.sql`
      create table outbox_process_fault_effects (
        event_id uuid primary key,
        created_at timestamptz not null default clock_timestamp()
      )
    `;
    await verifyCrashPhase(context, "before_side_effect");
    await verifyCrashPhase(context, "after_side_effect");
  } catch (error) {
    verificationFailure = error;
  }

  const cleanupFailures: Error[] = [];
  const childCleanup = await Promise.allSettled(
    [...context.children.keys()].map((child) => killWorker(context, child)),
  );
  cleanupFailures.push(
    ...childCleanup
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => asError(result.reason)),
  );
  try {
    await connection.close();
  } catch (error) {
    cleanupFailures.push(asError(error));
  }

  if (cleanupFailures.length > 0) {
    throw new AggregateError(
      verificationFailure === undefined
        ? cleanupFailures
        : [verificationFailure, ...cleanupFailures],
      verificationFailure === undefined
        ? "Outbox process-fault cleanup failed."
        : "Outbox process-fault verification and cleanup both failed.",
      verificationFailure === undefined ? undefined : { cause: verificationFailure },
    );
  }
  if (verificationFailure !== undefined) throw verificationFailure;
}
