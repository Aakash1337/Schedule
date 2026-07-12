import { loadApiConfig } from "@schedule/config";
import { createDatabase, healthCheckDatabase, PostgresUnitOfWork } from "@schedule/database";

import { buildApp } from "./app.js";
import { createProductServices } from "./product-services.js";

const config = loadApiConfig();
const database = createDatabase(config.DATABASE_URL);
const unitOfWork = new PostgresUnitOfWork(database);
const clock = { now: () => new Date() };
const productServices = createProductServices(unitOfWork, clock);
const app = await buildApp({
  logger:
    config.NODE_ENV === "development"
      ? {
          level: config.LOG_LEVEL,
          transport: { target: "pino-pretty", options: { colorize: true } },
        }
      : { level: config.LOG_LEVEL },
  readinessCheck: () => healthCheckDatabase(database),
  ...(config.PRODUCT_API_MODE === "local_unauthenticated" ? { productServices } : {}),
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, "shutting down");
  await app.close();
  await database.close();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown(signal).then(() => process.exit(0));
  });
}

try {
  await app.listen({ host: config.API_HOST, port: config.API_PORT });
} catch (error) {
  app.log.error(error, "failed to start API");
  await database.close();
  process.exit(1);
}
