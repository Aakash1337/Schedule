import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  config: {
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    DATABASE_URL: "postgres://unused",
    OUTBOX_POLL_INTERVAL_MS: 1_000,
    OUTBOX_BATCH_SIZE: 25,
    OUTBOX_MAX_ATTEMPTS: 3,
    WORKER_OBSERVABILITY_MODE: "disabled" as "disabled" | "loopback",
    WORKER_OBSERVABILITY_PORT: 9_464,
    WORKER_DEPLOYMENT_HEALTH_MODE: "disabled" as "disabled" | "railway",
    PORT: undefined as number | undefined,
    NOTIFICATION_MATERIALIZATION_MODE: "disabled" as "disabled" | "enabled",
    NOTIFICATION_MATERIALIZATION_INTERVAL_MS: 60_000,
    NOTIFICATION_MATERIALIZATION_LOOKAHEAD_MS: 300_000,
    WEBHOOK_DELIVERY_MODE: "disabled",
    WEBHOOK_MASTER_KEYS_BY_ID: new Map(),
    WEBHOOK_CONNECT_TIMEOUT_MS: 1_000,
    WEBHOOK_REQUEST_TIMEOUT_MS: 2_000,
    WEBHOOK_MAX_RESPONSE_BYTES: 1_024,
    WEBHOOK_MAX_RETRY_AFTER_MS: 0,
    WEBHOOK_MAX_DELIVERY_AGE_MS: 60_000,
  },
  database: { close: vi.fn(async () => undefined) },
  observabilityDatabase: { close: vi.fn(async () => undefined) },
  deploymentHealthDatabase: { close: vi.fn(async () => undefined) },
  createDatabase: vi.fn(
    (
      _databaseUrl: string,
      maxConnections: number,
      options?: { readonly applicationName?: string },
    ) =>
      maxConnections !== 1
        ? mocks.database
        : options?.applicationName === "schedule-worker-deployment-health"
          ? mocks.deploymentHealthDatabase
          : mocks.observabilityDatabase,
  ),
  unitOfWork: {},
  PostgresUnitOfWork: vi.fn(function () {
    return mocks.unitOfWork;
  }),
  notificationDependencies: {},
  createNotificationMaterializationDependencies: vi.fn(() => mocks.notificationDependencies),
  runNotificationMaterializationWorker: vi.fn(async () => undefined),
  telemetry: {},
  WorkerTelemetry: vi.fn(function () {
    return mocks.telemetry;
  }),
  runWorkerObservabilityServer: vi.fn(async () => undefined),
  runWorkerDeploymentHealthServer: vi.fn(async () => undefined),
  runNonCriticalWorkerService: vi.fn(
    async (service: (signal: AbortSignal) => Promise<void>, signal: AbortSignal) => {
      try {
        await service(signal);
      } catch {
        // Mirrors the production helper's non-fatal boundary.
      }
    },
  ),
  runOutboxWorker: vi.fn(async () => undefined),
  runWorkerServices: vi.fn(
    async (services: readonly ((signal: AbortSignal) => Promise<void>)[]) => {
      const signal = new AbortController().signal;
      await Promise.all(services.map(async (service) => await service(signal)));
    },
  ),
  runWorkerRuntime: vi.fn(
    async (options: { readonly run: () => Promise<void>; readonly close: () => Promise<void> }) => {
      await options.run();
      await options.close();
    },
  ),
}));

vi.mock("@schedule/config", () => ({ loadWorkerConfig: () => mocks.config }));
vi.mock("@schedule/database", () => ({
  createDatabase: mocks.createDatabase,
  PostgresUnitOfWork: mocks.PostgresUnitOfWork,
}));
vi.mock("./notification-materializer.js", () => ({
  createNotificationMaterializationDependencies:
    mocks.createNotificationMaterializationDependencies,
  runNotificationMaterializationWorker: mocks.runNotificationMaterializationWorker,
}));
vi.mock("./observability.js", () => ({
  WorkerTelemetry: mocks.WorkerTelemetry,
  runWorkerDeploymentHealthServer: mocks.runWorkerDeploymentHealthServer,
  runWorkerObservabilityServer: mocks.runWorkerObservabilityServer,
}));
vi.mock("./runtime.js", () => ({
  runNonCriticalWorkerService: mocks.runNonCriticalWorkerService,
  runWorkerRuntime: mocks.runWorkerRuntime,
  runWorkerServices: mocks.runWorkerServices,
}));
vi.mock("./worker.js", () => ({ runOutboxWorker: mocks.runOutboxWorker }));

describe("worker entrypoint", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.resetModules();
    mocks.config.WEBHOOK_DELIVERY_MODE = "disabled";
    mocks.config.NOTIFICATION_MATERIALIZATION_MODE = "disabled";
    mocks.config.WORKER_OBSERVABILITY_MODE = "disabled";
    mocks.config.WORKER_DEPLOYMENT_HEALTH_MODE = "disabled";
    mocks.config.PORT = undefined;
  });

  it("wires signals, runs the worker, and closes its database", async () => {
    const processOnce = vi.spyOn(process, "once").mockReturnValue(process);

    await import("./index.js");

    expect(processOnce).toHaveBeenCalledWith("SIGINT", expect.any(Function));
    expect(processOnce).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
    expect(mocks.runOutboxWorker).toHaveBeenCalledTimes(1);
    expect(mocks.runOutboxWorker.mock.calls[0]?.[3]).toBeInstanceOf(AbortSignal);
    const dispatcher = mocks.runOutboxWorker.mock.calls[0]?.[2] as unknown as {
      handlers: ReadonlyMap<string, unknown>;
    };
    expect(dispatcher.handlers.has("webhook.delivery.v1")).toBe(false);
    expect(mocks.runOutboxWorker.mock.calls[0]?.[4]).toEqual({
      excludedTopics: ["webhook.delivery.v1"],
      telemetry: mocks.telemetry,
    });
    expect(mocks.database.close).toHaveBeenCalledTimes(1);
    expect(mocks.createNotificationMaterializationDependencies).not.toHaveBeenCalled();
    expect(mocks.runNotificationMaterializationWorker).not.toHaveBeenCalled();
    expect(mocks.runWorkerObservabilityServer).not.toHaveBeenCalled();
    expect(mocks.runWorkerDeploymentHealthServer).not.toHaveBeenCalled();
  });

  it("starts automatic materialization only when explicitly enabled", async () => {
    mocks.config.NOTIFICATION_MATERIALIZATION_MODE = "enabled";

    await import("./index.js");

    expect(mocks.PostgresUnitOfWork).toHaveBeenCalledWith(mocks.database);
    expect(mocks.createNotificationMaterializationDependencies).toHaveBeenCalledWith(
      mocks.unitOfWork,
    );
    expect(mocks.runNotificationMaterializationWorker).toHaveBeenCalledWith(
      mocks.config,
      mocks.notificationDependencies,
      expect.any(AbortSignal),
      undefined,
      mocks.telemetry,
    );
    expect(mocks.runOutboxWorker).toHaveBeenCalledTimes(1);
    expect(mocks.database.close).toHaveBeenCalledTimes(1);
  });

  it("registers the webhook handler only when delivery is enabled", async () => {
    mocks.config.WEBHOOK_DELIVERY_MODE = "enabled";
    mocks.config.WEBHOOK_MASTER_KEYS_BY_ID = new Map([
      ["primary", { id: "primary", material: Buffer.alloc(32, 1).toString("base64url") }],
    ]);
    await import("./index.js");
    const dispatcher = mocks.runOutboxWorker.mock.calls.at(-1)?.[2] as unknown as {
      handlers: ReadonlyMap<string, unknown>;
    };
    expect(dispatcher.handlers.has("webhook.delivery.v1")).toBe(true);
    expect(mocks.runOutboxWorker.mock.calls.at(-1)?.[4]).toEqual({
      excludedTopics: [],
      telemetry: mocks.telemetry,
    });
  });

  it("starts loopback observability only when explicitly enabled", async () => {
    mocks.config.WORKER_OBSERVABILITY_MODE = "loopback";
    mocks.config.WORKER_OBSERVABILITY_PORT = 10_001;

    await import("./index.js");

    expect(mocks.createDatabase).toHaveBeenCalledWith("postgres://unused", 1, {
      readOnly: true,
      statementTimeoutMs: 5_000,
      applicationName: "schedule-worker-observability",
    });
    expect(mocks.runWorkerObservabilityServer).toHaveBeenCalledWith(
      {
        port: 10_001,
        database: mocks.observabilityDatabase,
        telemetry: mocks.telemetry,
        databaseOperationTimeoutMs: 5_000,
        excludedOutboxTopics: ["webhook.delivery.v1"],
      },
      expect.any(AbortSignal),
    );
    expect(mocks.observabilityDatabase.close).toHaveBeenCalledTimes(1);
  });

  it("runs Railway deployment readiness as a critical worker service", async () => {
    mocks.config.WORKER_DEPLOYMENT_HEALTH_MODE = "railway";
    mocks.config.PORT = 10_002;

    await import("./index.js");

    expect(mocks.createDatabase).toHaveBeenCalledWith("postgres://unused", 1, {
      readOnly: true,
      statementTimeoutMs: 5_000,
      applicationName: "schedule-worker-deployment-health",
    });
    expect(mocks.runWorkerDeploymentHealthServer).toHaveBeenCalledWith(
      {
        port: 10_002,
        database: mocks.deploymentHealthDatabase,
        databaseOperationTimeoutMs: 5_000,
      },
      expect.any(AbortSignal),
    );
    expect(mocks.runNonCriticalWorkerService).not.toHaveBeenCalled();
    expect(mocks.runWorkerServices.mock.calls[0]?.[0]).toHaveLength(2);
    expect(mocks.deploymentHealthDatabase.close).toHaveBeenCalledTimes(1);
  });

  it("keeps primary processing alive when optional observability fails", async () => {
    mocks.config.WORKER_OBSERVABILITY_MODE = "loopback";
    mocks.runWorkerObservabilityServer.mockRejectedValueOnce(
      new Error("private observability bind failure"),
    );

    await import("./index.js");

    expect(mocks.runOutboxWorker).toHaveBeenCalledTimes(1);
    expect(mocks.runNonCriticalWorkerService).toHaveBeenCalledTimes(1);
    expect(mocks.database.close).toHaveBeenCalledTimes(1);
    expect(mocks.observabilityDatabase.close).toHaveBeenCalledTimes(1);
  });
});
