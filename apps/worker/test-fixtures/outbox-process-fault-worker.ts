import { loadWorkerConfig } from "../../../packages/config/src/index.js";
import { createDatabase, type ClaimedOutboxEvent } from "../../../packages/database/src/index.js";
import { OutboxDispatcher } from "../src/dispatcher.js";
import { runOutboxWorker } from "../src/worker.js";

type FaultPhase = "before_side_effect" | "after_side_effect" | "recovery";

const databaseUrl = process.env.OUTBOX_FAULT_DATABASE_URL;
const expectedEventId = process.env.OUTBOX_FAULT_EVENT_ID;
const expectedTopic = process.env.OUTBOX_FAULT_TOPIC;
const phase = process.env.OUTBOX_FAULT_PHASE as FaultPhase | undefined;
const leaseDurationMs = Number(process.env.OUTBOX_FAULT_LEASE_DURATION_MS);

if (
  !databaseUrl ||
  !expectedEventId ||
  !expectedTopic ||
  !phase ||
  !["before_side_effect", "after_side_effect", "recovery"].includes(phase) ||
  !Number.isSafeInteger(leaseDurationMs) ||
  leaseDurationMs < 1_000 ||
  !process.send
) {
  throw new Error("Outbox process-fault fixture requires its guarded IPC environment.");
}

const database = createDatabase(databaseUrl, 1);
const controller = new AbortController();
let continueRecovery: (() => void) | undefined;
const recoveryContinuation = new Promise<void>((resolve) => {
  continueRecovery = resolve;
});

process.on("message", (message: unknown) => {
  if (typeof message !== "object" || message === null || !("type" in message)) return;
  if (message.type === "continue") continueRecovery?.();
  if (message.type === "stop") controller.abort("parent requested fixture shutdown");
});
process.once("disconnect", () => controller.abort("parent IPC disconnected"));

function sendBarrier(event: ClaimedOutboxEvent): void {
  process.send?.({
    type: "barrier",
    phase,
    event: {
      id: event.id,
      attempts: event.attempts,
      lockedAt: event.lockedAt,
      topic: event.topic,
    },
  });
}

const dispatcher = new OutboxDispatcher(
  new Map([
    [
      expectedTopic,
      async (event: ClaimedOutboxEvent): Promise<void> => {
        if (event.id !== expectedEventId) {
          throw new Error(`Fixture claimed unexpected outbox event ${event.id}.`);
        }

        if (phase === "before_side_effect") {
          sendBarrier(event);
          await new Promise<never>(() => undefined);
        }

        await database.sql`
          insert into outbox_process_fault_effects (event_id)
          values (${event.id}::uuid)
          on conflict (event_id) do nothing
        `;

        sendBarrier(event);
        if (phase === "after_side_effect") {
          await new Promise<never>(() => undefined);
        }
        await recoveryContinuation;
      },
    ],
  ]),
);

const config = loadWorkerConfig({
  NODE_ENV: "test",
  LOG_LEVEL: "silent",
  DATABASE_URL: databaseUrl,
  OUTBOX_POLL_INTERVAL_MS: "100",
  OUTBOX_BATCH_SIZE: "1",
  OUTBOX_MAX_ATTEMPTS: "3",
});

try {
  await runOutboxWorker(config, database, dispatcher, controller.signal, {
    leaseDurationMs,
    heartbeatIntervalMs: Math.floor(leaseDurationMs / 2),
    shutdownGracePeriodMs: 1_000,
  });
} catch (error) {
  process.send?.({
    type: "fatal",
    message: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
} finally {
  await database.close().catch(() => undefined);
  process.disconnect?.();
}
