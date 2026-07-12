import { loadWorkerConfig } from "@schedule/config";
import { createDatabase } from "@schedule/database";

import { OutboxDispatcher } from "./dispatcher.js";
import { runWorkerRuntime } from "./runtime.js";
import { runOutboxWorker } from "./worker.js";

const config = loadWorkerConfig();
const database = createDatabase(config.DATABASE_URL, 4);
const dispatcher = new OutboxDispatcher();
const controller = new AbortController();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => controller.abort(signal));
}

await runWorkerRuntime({
  run: () => runOutboxWorker(config, database, dispatcher, controller.signal),
  close: () => database.close(),
});
