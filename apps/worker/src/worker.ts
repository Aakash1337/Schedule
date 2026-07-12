import type { WorkerConfig } from "@schedule/config";
import {
  claimOutboxBatch,
  completeOutboxEvent,
  failOutboxEvent,
  type DatabaseConnection,
} from "@schedule/database";

import type { OutboxDispatcher } from "./dispatcher.js";

const sleep = (milliseconds: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

export async function runOutboxWorker(
  config: WorkerConfig,
  database: DatabaseConnection,
  dispatcher: OutboxDispatcher,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    const events = await claimOutboxBatch(database, config.OUTBOX_BATCH_SIZE);
    if (events.length === 0) {
      await sleep(config.OUTBOX_POLL_INTERVAL_MS, signal);
      continue;
    }

    for (const event of events) {
      if (signal.aborted) return;
      try {
        const result = await dispatcher.dispatch(event);
        if (!result.handled) {
          console.warn(
            JSON.stringify({
              level: "warn",
              eventId: event.id,
              topic: event.topic,
              message: "unhandled outbox topic",
            }),
          );
        }
        await completeOutboxEvent(database, event.id);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await failOutboxEvent(database, event, message, config.OUTBOX_MAX_ATTEMPTS);
      }
    }
  }
}
