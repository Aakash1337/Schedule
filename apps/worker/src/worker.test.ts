import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkerConfig } from "@schedule/config";
import type {
  ClaimedOutboxEvent,
  DatabaseConnection,
  DeadLetteredOutboxEvent,
} from "@schedule/database";

import type { OutboxDispatcher } from "./dispatcher.js";
import { OutboxHandlerFailure } from "./dispatcher.js";

const databaseMocks = vi.hoisted(() => ({
  DEFAULT_OUTBOX_LEASE_DURATION_MS: 300_000,
  claimNextOutboxEvent: vi.fn(),
  completeOutboxEvent: vi.fn(),
  failOutboxEvent: vi.fn(),
  releaseOutboxEvent: vi.fn(),
  renewOutboxEventLease: vi.fn(),
}));

vi.mock("@schedule/database", () => databaseMocks);

import { runOutboxWorker } from "./worker.js";

const config: WorkerConfig = {
  NODE_ENV: "test",
  LOG_LEVEL: "silent",
  DATABASE_URL: "postgres://unused",
  OUTBOX_POLL_INTERVAL_MS: 1_000,
  OUTBOX_BATCH_SIZE: 25,
  OUTBOX_MAX_ATTEMPTS: 3,
  NOTIFICATION_MATERIALIZATION_MODE: "disabled",
  NOTIFICATION_MATERIALIZATION_INTERVAL_MS: 60_000,
  NOTIFICATION_MATERIALIZATION_LOOKAHEAD_MS: 300_000,
};

const database = {} as DatabaseConnection;
const firstEvent: ClaimedOutboxEvent = {
  id: "00000000-0000-0000-0000-000000000001",
  workspaceId: null,
  topic: "test.created",
  payload: { value: 1 },
  attempts: 1,
  lockedAt: "2026-07-12 12:00:00+00",
};
const secondEvent: ClaimedOutboxEvent = {
  ...firstEvent,
  id: "00000000-0000-0000-0000-000000000002",
  lockedAt: "2026-07-12 12:00:01+00",
};

const emptyClaim = { event: null, deadLettered: [] } as const;
const claim = (event: ClaimedOutboxEvent) => ({ event, deadLettered: [] as const });
const dispatcherWith = (dispatch: OutboxDispatcher["dispatch"]): OutboxDispatcher =>
  ({ dispatch }) as OutboxDispatcher;
const parsedLogs = (spy: ReturnType<typeof vi.spyOn>): Record<string, unknown>[] =>
  spy.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);

describe("outbox worker", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    databaseMocks.completeOutboxEvent.mockResolvedValue("applied");
    databaseMocks.failOutboxEvent.mockResolvedValue("retry_scheduled");
    databaseMocks.releaseOutboxEvent.mockResolvedValue("applied");
    databaseMocks.renewOutboxEventLease.mockImplementation(
      async (_database: DatabaseConnection, event: ClaimedOutboxEvent) => ({
        status: "renewed",
        event,
      }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("claims one event immediately before dispatch and acknowledges its fencing token", async () => {
    const controller = new AbortController();
    databaseMocks.claimNextOutboxEvent.mockResolvedValue(claim(firstEvent));
    const dispatch = vi.fn(async () => {
      expect(databaseMocks.claimNextOutboxEvent).toHaveBeenCalledTimes(1);
      controller.abort("test complete");
      return { handled: true };
    });

    await runOutboxWorker(config, database, dispatcherWith(dispatch), controller.signal);

    expect(dispatch).toHaveBeenCalledWith(firstEvent, expect.any(AbortSignal));
    expect(databaseMocks.claimNextOutboxEvent).toHaveBeenCalledWith(database, {
      leaseDurationMs: 300_000,
      maxAttempts: 3,
      deadLetterRecoveryLimit: 25,
    });
    expect(databaseMocks.claimNextOutboxEvent).toHaveBeenCalledTimes(1);
    expect(databaseMocks.completeOutboxEvent).toHaveBeenCalledWith(database, firstEvent);
  });

  it("forwards excluded topics to every claim without changing other claim options", async () => {
    const controller = new AbortController();
    databaseMocks.claimNextOutboxEvent.mockImplementationOnce(async () => {
      controller.abort("test complete");
      return emptyClaim;
    });

    await runOutboxWorker(config, database, dispatcherWith(vi.fn()), controller.signal, {
      excludedTopics: ["webhook.delivery.v1"],
    });

    expect(databaseMocks.claimNextOutboxEvent).toHaveBeenCalledWith(database, {
      leaseDurationMs: 300_000,
      maxAttempts: 3,
      deadLetterRecoveryLimit: 25,
      excludedTopics: ["webhook.delivery.v1"],
    });
  });

  it("does not pre-lease a later event while the current handler is running", async () => {
    const controller = new AbortController();
    databaseMocks.claimNextOutboxEvent
      .mockResolvedValueOnce(claim(firstEvent))
      .mockResolvedValueOnce(claim(secondEvent));
    let finish: ((result: { handled: boolean }) => void) | undefined;
    const dispatch = vi.fn(
      async () =>
        new Promise<{ handled: boolean }>((resolve) => {
          finish = resolve;
        }),
    );

    const worker = runOutboxWorker(config, database, dispatcherWith(dispatch), controller.signal);
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));

    expect(databaseMocks.claimNextOutboxEvent).toHaveBeenCalledTimes(1);
    controller.abort("SIGTERM");
    finish?.({ handled: true });
    await worker;
    expect(databaseMocks.claimNextOutboxEvent).toHaveBeenCalledTimes(1);
  });

  it("retries a handler failure without acknowledging the event", async () => {
    const controller = new AbortController();
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const privateFailure =
      "request to postgres://private-user:private-password@db.internal failed for person@example.com";
    databaseMocks.claimNextOutboxEvent.mockResolvedValue(claim(firstEvent));
    const dispatch = vi.fn(async () => {
      controller.abort("test complete");
      throw new Error(privateFailure);
    });

    await runOutboxWorker(config, database, dispatcherWith(dispatch), controller.signal);

    expect(databaseMocks.failOutboxEvent).toHaveBeenCalledWith(
      database,
      firstEvent,
      "Outbox handler execution failed",
      3,
    );
    expect(databaseMocks.failOutboxEvent.mock.calls.flat().join(" ")).not.toContain(
      "private-password",
    );
    expect(databaseMocks.failOutboxEvent.mock.calls.flat().join(" ")).not.toContain(
      "person@example.com",
    );
    expect(databaseMocks.completeOutboxEvent).not.toHaveBeenCalled();
    expect(parsedLogs(consoleWarn)).toContainEqual(
      expect.objectContaining({
        level: "warn",
        failureClass: "handler_error",
        message: "outbox delivery failed; retry scheduled",
      }),
    );
    expect(consoleWarn.mock.calls.flat().join(" ")).not.toContain("private-password");
    expect(consoleWarn.mock.calls.flat().join(" ")).not.toContain("person@example.com");
  });

  it("persists typed terminal and retryable handler classifications without raw errors", async () => {
    const controller = new AbortController();
    databaseMocks.claimNextOutboxEvent.mockResolvedValue(claim(firstEvent));
    const dispatch = vi.fn(async () => {
      controller.abort("test complete");
      throw new OutboxHandlerFailure({ code: "webhook_response_permanent", retryable: false });
    });
    await runOutboxWorker(config, database, dispatcherWith(dispatch), controller.signal);
    expect(databaseMocks.failOutboxEvent).toHaveBeenCalledWith(
      database,
      firstEvent,
      "webhook_response_permanent",
      3,
      { permanent: true },
    );
  });

  it("logs an unhandled topic warning and routes it through retry handling", async () => {
    const controller = new AbortController();
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    databaseMocks.claimNextOutboxEvent.mockResolvedValue(claim(firstEvent));
    const dispatch = vi.fn(async () => {
      controller.abort("test complete");
      return { handled: false };
    });

    await runOutboxWorker(config, database, dispatcherWith(dispatch), controller.signal);

    expect(databaseMocks.failOutboxEvent).toHaveBeenCalledWith(
      database,
      firstEvent,
      "No outbox handler is registered for this topic",
      3,
    );
    expect(parsedLogs(consoleWarn)).toContainEqual(
      expect.objectContaining({
        level: "warn",
        topic: "test.created",
        message: "unhandled outbox topic",
      }),
    );
    expect(databaseMocks.completeOutboxEvent).not.toHaveBeenCalled();
  });

  it("logs a structured error when delivery reaches the dead letter state", async () => {
    const controller = new AbortController();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    databaseMocks.claimNextOutboxEvent.mockResolvedValue(claim(firstEvent));
    databaseMocks.failOutboxEvent.mockResolvedValue("dead_lettered");
    const dispatch = vi.fn(async () => {
      controller.abort("test complete");
      throw new Error("https://private-user:private-password@example.com/customer/42");
    });

    await runOutboxWorker(config, database, dispatcherWith(dispatch), controller.signal);

    expect(databaseMocks.failOutboxEvent).toHaveBeenCalledWith(
      database,
      firstEvent,
      "Outbox handler execution failed",
      3,
    );
    expect(databaseMocks.failOutboxEvent.mock.calls.flat().join(" ")).not.toContain(
      "private-password",
    );
    expect(databaseMocks.failOutboxEvent.mock.calls.flat().join(" ")).not.toContain("customer/42");
    expect(parsedLogs(consoleError)).toContainEqual(
      expect.objectContaining({
        level: "error",
        failureClass: "handler_error",
        message: "outbox event dead-lettered",
      }),
    );
    expect(consoleError.mock.calls.flat().join(" ")).not.toContain("private-password");
    expect(consoleError.mock.calls.flat().join(" ")).not.toContain("customer/42");
  });

  it("logs crash-exhausted claims that recovery dead-letters", async () => {
    const controller = new AbortController();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exhausted: DeadLetteredOutboxEvent = {
      id: firstEvent.id,
      workspaceId: null,
      topic: firstEvent.topic,
      attempts: 3,
      lastError: "postgres://private-user:private-password@db.internal/customer/42",
    };
    databaseMocks.claimNextOutboxEvent
      .mockResolvedValueOnce({ event: null, deadLettered: [exhausted] })
      .mockImplementationOnce(async () => {
        controller.abort("test complete");
        return emptyClaim;
      });

    await runOutboxWorker(config, database, dispatcherWith(vi.fn()), controller.signal);

    expect(parsedLogs(consoleError)).toContainEqual(
      expect.objectContaining({
        level: "error",
        failureClass: "expired_claim_recovery",
        attempts: 3,
        message: "outbox event dead-lettered",
      }),
    );
    expect(consoleError.mock.calls.flat().join(" ")).not.toContain("private-password");
    expect(consoleError.mock.calls.flat().join(" ")).not.toContain("customer/42");
  });

  it("renews a delayed handler lease, including during graceful shutdown", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const renewedOnce = { ...firstEvent, lockedAt: "2026-07-12 12:00:00.100001+00" };
    const renewedTwice = { ...firstEvent, lockedAt: "2026-07-12 12:00:00.200001+00" };
    databaseMocks.claimNextOutboxEvent.mockResolvedValue(claim(firstEvent));
    databaseMocks.renewOutboxEventLease
      .mockResolvedValueOnce({ status: "renewed", event: renewedOnce })
      .mockResolvedValueOnce({ status: "renewed", event: renewedTwice });
    let finish: ((result: { handled: boolean }) => void) | undefined;
    let handlerSignal: AbortSignal | undefined;
    const dispatch = vi.fn(
      async (_event: ClaimedOutboxEvent, signal: AbortSignal) =>
        new Promise<{ handled: boolean }>((resolve) => {
          handlerSignal = signal;
          finish = resolve;
        }),
    );

    const worker = runOutboxWorker(config, database, dispatcherWith(dispatch), controller.signal, {
      leaseDurationMs: 300,
      heartbeatIntervalMs: 100,
      shutdownGracePeriodMs: 250,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(dispatch).toHaveBeenCalledTimes(1);

    controller.abort("SIGTERM");
    expect(handlerSignal?.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(databaseMocks.renewOutboxEventLease).toHaveBeenNthCalledWith(1, database, firstEvent);
    await vi.advanceTimersByTimeAsync(100);
    expect(databaseMocks.renewOutboxEventLease).toHaveBeenNthCalledWith(2, database, renewedOnce);

    finish?.({ handled: true });
    await vi.advanceTimersByTimeAsync(0);
    await worker;
    expect(databaseMocks.completeOutboxEvent).toHaveBeenCalledWith(database, renewedTwice);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(databaseMocks.renewOutboxEventLease).toHaveBeenCalledTimes(2);
  });

  it("gives cooperative handlers an abort signal and acknowledges work finished during grace", async () => {
    const controller = new AbortController();
    databaseMocks.claimNextOutboxEvent.mockResolvedValue(claim(firstEvent));
    let handlerSignal: AbortSignal | undefined;
    const dispatch = vi.fn(
      async (_event: ClaimedOutboxEvent, signal: AbortSignal) =>
        new Promise<{ handled: boolean }>((resolve) => {
          handlerSignal = signal;
          signal.addEventListener("abort", () => resolve({ handled: true }), { once: true });
        }),
    );

    const worker = runOutboxWorker(config, database, dispatcherWith(dispatch), controller.signal, {
      shutdownGracePeriodMs: 250,
    });
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    controller.abort("SIGTERM");
    await worker;

    expect(handlerSignal?.aborted).toBe(true);
    expect(databaseMocks.completeOutboxEvent).toHaveBeenCalledWith(database, firstEvent);
    expect(databaseMocks.failOutboxEvent).not.toHaveBeenCalled();
  });

  it("stops at the shutdown deadline without acknowledging a hung handler", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    databaseMocks.claimNextOutboxEvent.mockResolvedValue(claim(firstEvent));
    let handlerSignal: AbortSignal | undefined;
    const dispatch = vi.fn(
      async (_event: ClaimedOutboxEvent, signal: AbortSignal) =>
        new Promise<{ handled: boolean }>(() => {
          handlerSignal = signal;
        }),
    );

    const worker = runOutboxWorker(config, database, dispatcherWith(dispatch), controller.signal, {
      leaseDurationMs: 600,
      heartbeatIntervalMs: 100,
      shutdownGracePeriodMs: 250,
    });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort("SIGTERM");
    await vi.advanceTimersByTimeAsync(250);
    await worker;

    expect(handlerSignal?.aborted).toBe(true);
    expect(databaseMocks.renewOutboxEventLease).toHaveBeenCalledTimes(2);
    expect(databaseMocks.completeOutboxEvent).not.toHaveBeenCalled();
    expect(databaseMocks.failOutboxEvent).not.toHaveBeenCalled();
    expect(databaseMocks.releaseOutboxEvent).not.toHaveBeenCalled();
    expect(parsedLogs(consoleWarn)).toContainEqual(
      expect.objectContaining({ failureClass: "shutdown_deadline_exceeded" }),
    );

    await vi.advanceTimersByTimeAsync(1_000);
    expect(databaseMocks.renewOutboxEventLease).toHaveBeenCalledTimes(2);
  });

  it("rejects heartbeat intervals that leave no safe renewal margin", async () => {
    const controller = new AbortController();

    await expect(
      runOutboxWorker(config, database, dispatcherWith(vi.fn()), controller.signal, {
        leaseDurationMs: 300,
        heartbeatIntervalMs: 151,
      }),
    ).rejects.toThrow("no greater than half the lease");
  });

  it("accepts the minimum lease with its derived one-millisecond heartbeat", async () => {
    const controller = new AbortController();
    controller.abort("test complete");

    await expect(
      runOutboxWorker(config, database, dispatcherWith(vi.fn()), controller.signal, {
        leaseDurationMs: 2,
      }),
    ).resolves.toBeUndefined();
  });

  it("classifies lease renewal failures without logging raw database errors", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    databaseMocks.claimNextOutboxEvent.mockResolvedValue(claim(firstEvent));
    databaseMocks.renewOutboxEventLease.mockRejectedValueOnce(
      new Error("postgres://private-user:private-password@db.internal/customer/42"),
    );
    let finish: ((result: { handled: boolean }) => void) | undefined;
    const dispatch = vi.fn(
      async () =>
        new Promise<{ handled: boolean }>((resolve) => {
          finish = resolve;
        }),
    );

    const worker = runOutboxWorker(config, database, dispatcherWith(dispatch), controller.signal, {
      leaseDurationMs: 300,
      heartbeatIntervalMs: 100,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(dispatch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    controller.abort("test complete");
    finish?.({ handled: true });
    await vi.advanceTimersByTimeAsync(0);
    await worker;

    expect(parsedLogs(consoleError)).toContainEqual(
      expect.objectContaining({
        operation: "renew",
        failureClass: "lease_renewal_error",
      }),
    );
    expect(consoleError.mock.calls.flat().join(" ")).not.toContain("private-password");
    expect(consoleError.mock.calls.flat().join(" ")).not.toContain("customer/42");
  });

  it("aborts a handler on stale lease renewal and never persists a completion", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    databaseMocks.claimNextOutboxEvent.mockResolvedValue(claim(firstEvent));
    databaseMocks.renewOutboxEventLease.mockResolvedValue({ status: "stale" });
    let handlerSignal: AbortSignal | undefined;
    const dispatch = vi.fn(
      async (_event: ClaimedOutboxEvent, signal: AbortSignal) =>
        new Promise<{ handled: boolean }>(() => {
          handlerSignal = signal;
        }),
    );

    const worker = runOutboxWorker(config, database, dispatcherWith(dispatch), controller.signal, {
      leaseDurationMs: 300,
      heartbeatIntervalMs: 100,
    });
    const workerFailure = expect(worker).rejects.toThrow(
      "outbox lease lost; worker restart required",
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(dispatch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(databaseMocks.renewOutboxEventLease).toHaveBeenCalledWith(database, firstEvent);
    await workerFailure;

    expect(handlerSignal?.aborted).toBe(true);
    expect(parsedLogs(consoleError)).toContainEqual(
      expect.objectContaining({ operation: "renew" }),
    );
    expect(databaseMocks.completeOutboxEvent).not.toHaveBeenCalled();
    expect(databaseMocks.failOutboxEvent).not.toHaveBeenCalled();
    expect(databaseMocks.releaseOutboxEvent).not.toHaveBeenCalled();
    expect(databaseMocks.claimNextOutboxEvent).toHaveBeenCalledTimes(1);
  });

  it("propagates a failure to persist a handler retry without acknowledging the event", async () => {
    const controller = new AbortController();
    databaseMocks.claimNextOutboxEvent.mockResolvedValue(claim(firstEvent));
    databaseMocks.failOutboxEvent.mockRejectedValueOnce(new Error("database unavailable"));
    const dispatch = vi.fn(async () => {
      controller.abort("test complete");
      throw new Error("handler failed");
    });

    await expect(
      runOutboxWorker(config, database, dispatcherWith(dispatch), controller.signal),
    ).rejects.toThrow("database unavailable");

    expect(databaseMocks.completeOutboxEvent).not.toHaveBeenCalled();
  });

  it("propagates a failure to persist completion without retrying a completed handler", async () => {
    const controller = new AbortController();
    databaseMocks.claimNextOutboxEvent.mockResolvedValue(claim(firstEvent));
    databaseMocks.completeOutboxEvent.mockRejectedValueOnce(new Error("database unavailable"));
    const dispatch = vi.fn(async () => {
      controller.abort("test complete");
      return { handled: true };
    });

    await expect(
      runOutboxWorker(config, database, dispatcherWith(dispatch), controller.signal),
    ).rejects.toThrow("database unavailable");

    expect(databaseMocks.failOutboxEvent).not.toHaveBeenCalled();
  });

  it("releases a claim acquired concurrently with shutdown before dispatch", async () => {
    const controller = new AbortController();
    databaseMocks.claimNextOutboxEvent.mockImplementationOnce(async () => {
      controller.abort("SIGTERM");
      return claim(firstEvent);
    });
    const dispatch = vi.fn();

    await runOutboxWorker(config, database, dispatcherWith(dispatch), controller.signal);

    expect(dispatch).not.toHaveBeenCalled();
    expect(databaseMocks.releaseOutboxEvent).toHaveBeenCalledWith(database, firstEvent);
  });

  it("does not claim work after shutdown has already begun", async () => {
    const controller = new AbortController();
    controller.abort("SIGTERM");

    await runOutboxWorker(config, database, dispatcherWith(vi.fn()), controller.signal);

    expect(databaseMocks.claimNextOutboxEvent).not.toHaveBeenCalled();
  });
});
