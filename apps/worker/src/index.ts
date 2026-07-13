import { loadWorkerConfig } from "@schedule/config";
import { createDatabase } from "@schedule/database";

import { OutboxDispatcher } from "./dispatcher.js";
import { runWorkerRuntime } from "./runtime.js";
import {
  createDatabaseWebhookDeliveryHandler,
  WEBHOOK_DELIVERY_TOPIC,
} from "./webhook-delivery.js";
import { runOutboxWorker } from "./worker.js";

const config = loadWorkerConfig();
const database = createDatabase(config.DATABASE_URL, 4);
const dispatcher = new OutboxDispatcher(
  config.WEBHOOK_DELIVERY_MODE === "enabled"
    ? new Map([
        [
          WEBHOOK_DELIVERY_TOPIC,
          createDatabaseWebhookDeliveryHandler(database, {
            keyring: { get: (id) => config.WEBHOOK_MASTER_KEYS_BY_ID.get(id)?.material },
            connectTimeoutMs: config.WEBHOOK_CONNECT_TIMEOUT_MS,
            requestTimeoutMs: config.WEBHOOK_REQUEST_TIMEOUT_MS,
            maxResponseBytes: config.WEBHOOK_MAX_RESPONSE_BYTES,
            maxRetryAfterMs: config.WEBHOOK_MAX_RETRY_AFTER_MS,
            maxDeliveryAgeMs: config.WEBHOOK_MAX_DELIVERY_AGE_MS,
          }),
        ],
      ])
    : new Map(),
);
const controller = new AbortController();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => controller.abort(signal));
}

await runWorkerRuntime({
  run: () =>
    runOutboxWorker(config, database, dispatcher, controller.signal, {
      excludedTopics: config.WEBHOOK_DELIVERY_MODE === "disabled" ? [WEBHOOK_DELIVERY_TOPIC] : [],
    }),
  close: () => database.close(),
});
