import { loadWorkerConfig } from "@schedule/config";
import { createDatabase } from "@schedule/database";

import { OutboxDispatcher } from "./dispatcher.js";
import { runOutboxWorker } from "./worker.js";

const config = loadWorkerConfig();
const database = createDatabase(config.DATABASE_URL, 4);
const dispatcher = new OutboxDispatcher();
const controller = new AbortController();

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => controller.abort(signal));
}

try {
  await runOutboxWorker(config, database, dispatcher, controller.signal);
} catch (error) {
  console.error(
    JSON.stringify({
      level: "error",
      message: "worker stopped unexpectedly",
      error: String(error),
    }),
  );
  process.exitCode = 1;
} finally {
  await database.close();
}
