import { loadWorkerConfig } from "@schedule/config";
import { createDatabase, PostgresUnitOfWork } from "@schedule/database";

import { OutboxDispatcher } from "./dispatcher.js";
import {
  createHostedSyncCleanupDependencies,
  runHostedSyncCleanupWorker,
} from "./hosted-sync-cleanup.js";
import {
  createNotificationMaterializationDependencies,
  runNotificationMaterializationWorker,
} from "./notification-materializer.js";
import {
  runWorkerDeploymentHealthServer,
  runWorkerObservabilityServer,
  WorkerTelemetry,
} from "./observability.js";
import {
  runNonCriticalWorkerService,
  runWorkerRuntime,
  runWorkerServices,
  type WorkerService,
} from "./runtime.js";
import {
  createDatabaseWebhookDeliveryHandler,
  WEBHOOK_DELIVERY_TOPIC,
} from "./webhook-delivery.js";
import { runOutboxWorker } from "./worker.js";

const config = loadWorkerConfig();
const deploymentHealthPort =
  config.WORKER_DEPLOYMENT_HEALTH_MODE === "railway" ? config.PORT : null;
if (deploymentHealthPort === undefined) {
  throw new Error("Railway worker deployment health is missing the platform port.");
}
const database = createDatabase(config.DATABASE_URL, 4);
const observabilityDatabase =
  config.WORKER_OBSERVABILITY_MODE === "loopback"
    ? createDatabase(config.DATABASE_URL, 1, {
        readOnly: true,
        statementTimeoutMs: 5_000,
        applicationName: "schedule-worker-observability",
      })
    : null;
const deploymentHealthDatabase =
  deploymentHealthPort === null
    ? null
    : createDatabase(config.DATABASE_URL, 1, {
        readOnly: true,
        statementTimeoutMs: 5_000,
        applicationName: "schedule-worker-deployment-health",
      });
const hostedSyncCleanupDatabase =
  config.HOSTED_WORK_ITEM_SYNC_CLEANUP_MODE === "enabled"
    ? createDatabase(config.DATABASE_URL, 1, {
        statementTimeoutMs: 2_000,
        applicationName: "schedule-worker-hosted-sync-cleanup",
      })
    : null;
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
const telemetry = new WorkerTelemetry();
const excludedOutboxTopics =
  config.WEBHOOK_DELIVERY_MODE === "disabled" ? [WEBHOOK_DELIVERY_TOPIC] : [];

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => controller.abort(signal));
}

const services: WorkerService[] = [
  (signal) =>
    runOutboxWorker(config, database, dispatcher, signal, {
      excludedTopics: excludedOutboxTopics,
      telemetry,
    }),
];

if (deploymentHealthPort !== null && deploymentHealthDatabase !== null) {
  services.push((signal) =>
    runWorkerDeploymentHealthServer(
      {
        port: deploymentHealthPort,
        database: deploymentHealthDatabase,
        databaseOperationTimeoutMs: 5_000,
      },
      signal,
    ),
  );
}

if (config.NOTIFICATION_MATERIALIZATION_MODE === "enabled") {
  const dependencies = createNotificationMaterializationDependencies(
    new PostgresUnitOfWork(database),
  );
  services.push((signal) =>
    runNotificationMaterializationWorker(config, dependencies, signal, undefined, telemetry),
  );
}

if (hostedSyncCleanupDatabase !== null) {
  const dependencies = createHostedSyncCleanupDependencies(hostedSyncCleanupDatabase);
  services.push((signal) =>
    runHostedSyncCleanupWorker(config, dependencies, signal, undefined, telemetry),
  );
}

await runWorkerRuntime({
  run: async () => {
    const observability =
      observabilityDatabase === null
        ? Promise.resolve()
        : runNonCriticalWorkerService(
            (signal) =>
              runWorkerObservabilityServer(
                {
                  port: config.WORKER_OBSERVABILITY_PORT,
                  database: observabilityDatabase,
                  telemetry,
                  databaseOperationTimeoutMs: 5_000,
                  excludedOutboxTopics,
                },
                signal,
              ),
            controller.signal,
          );
    try {
      await runWorkerServices(services, controller);
    } finally {
      if (!controller.signal.aborted) controller.abort("primary worker services stopped");
      await observability;
    }
  },
  close: async () => {
    const results = await Promise.allSettled([
      database.close(),
      ...(observabilityDatabase === null ? [] : [observabilityDatabase.close()]),
      ...(deploymentHealthDatabase === null ? [] : [deploymentHealthDatabase.close()]),
      ...(hostedSyncCleanupDatabase === null ? [] : [hostedSyncCleanupDatabase.close()]),
    ]);
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failure !== undefined) throw failure.reason;
  },
});
