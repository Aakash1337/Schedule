import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  config: {
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    DATABASE_URL: "postgres://unused",
    OUTBOX_POLL_INTERVAL_MS: 1_000,
    OUTBOX_BATCH_SIZE: 25,
    OUTBOX_MAX_ATTEMPTS: 3,
    WEBHOOK_DELIVERY_MODE: "disabled",
    WEBHOOK_MASTER_KEYS_BY_ID: new Map(),
    WEBHOOK_CONNECT_TIMEOUT_MS: 1_000,
    WEBHOOK_REQUEST_TIMEOUT_MS: 2_000,
    WEBHOOK_MAX_RESPONSE_BYTES: 1_024,
    WEBHOOK_MAX_RETRY_AFTER_MS: 0,
    WEBHOOK_MAX_DELIVERY_AGE_MS: 60_000,
  },
  database: { close: vi.fn(async () => undefined) },
  runOutboxWorker: vi.fn(async () => undefined),
}));

vi.mock("@schedule/config", () => ({ loadWorkerConfig: () => mocks.config }));
vi.mock("@schedule/database", () => ({ createDatabase: () => mocks.database }));
vi.mock("./worker.js", () => ({ runOutboxWorker: mocks.runOutboxWorker }));

describe("worker entrypoint", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    mocks.config.WEBHOOK_DELIVERY_MODE = "disabled";
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
    });
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
    expect(mocks.runOutboxWorker.mock.calls.at(-1)?.[4]).toEqual({ excludedTopics: [] });
  });
});
