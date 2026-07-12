import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  config: {
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    DATABASE_URL: "postgres://unused",
    OUTBOX_POLL_INTERVAL_MS: 1_000,
    OUTBOX_BATCH_SIZE: 25,
    OUTBOX_MAX_ATTEMPTS: 3,
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
  });

  it("wires signals, runs the worker, and closes its database", async () => {
    const processOnce = vi.spyOn(process, "once").mockReturnValue(process);

    await import("./index.js");

    expect(processOnce).toHaveBeenCalledWith("SIGINT", expect.any(Function));
    expect(processOnce).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
    expect(mocks.runOutboxWorker).toHaveBeenCalledTimes(1);
    expect(mocks.runOutboxWorker.mock.calls[0]?.[3]).toBeInstanceOf(AbortSignal);
    expect(mocks.database.close).toHaveBeenCalledTimes(1);
  });
});
