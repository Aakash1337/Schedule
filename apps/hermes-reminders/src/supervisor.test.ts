import { describe, expect, it, vi } from "vitest";

import type { HermesReminderRunResult } from "./delivery-runner.js";
import { PostgresDeliveryDedupeStoreError } from "./postgres-dedupe-store.js";
import { ScheduleDeliveryGatewayError } from "./schedule-client.js";
import {
  classifyHermesReminderSupervisorFailure,
  HermesReminderSupervisor,
  HermesReminderSupervisorError,
  hermesReminderRetryDelayMilliseconds,
} from "./supervisor.js";

const idle = { status: "idle" } as const;

function deferred<Result>() {
  let resolve!: (value: Result) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<Result>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("HermesReminderSupervisor configuration", () => {
  const runner = { runOnce: async (): Promise<HermesReminderRunResult> => idle };

  it.each([
    { pollIntervalMilliseconds: 99 },
    { retryBaseMilliseconds: 99 },
    { retryBaseMilliseconds: 2_000, retryCapMilliseconds: 1_999 },
    { retryCapMilliseconds: 300_001 },
    { maximumConsecutiveFailures: 0 },
    { maximumConsecutiveFailures: 101 },
  ])("rejects unsafe bounded polling options: %o", (options) => {
    expect(() => new HermesReminderSupervisor(runner, options)).toThrow(RangeError);
  });

  it("clamps full-jitter samples and caps exponential retry delay", () => {
    expect(hermesReminderRetryDelayMilliseconds(1, 1_000, 64_000, () => -1)).toBe(1);
    expect(hermesReminderRetryDelayMilliseconds(2, 1_000, 64_000, () => 0.5)).toBe(1_000);
    expect(hermesReminderRetryDelayMilliseconds(20, 1_000, 64_000, () => 2)).toBe(64_000);
    expect(hermesReminderRetryDelayMilliseconds(1, 1_000, 64_000, () => Number.NaN)).toBe(1);
  });
});

describe("HermesReminderSupervisor lifecycle", () => {
  it("keeps the default kill switch off and performs no claim", async () => {
    const controller = new AbortController();
    const runner = { runOnce: vi.fn(async (): Promise<HermesReminderRunResult> => idle) };
    let observedState: string | undefined;
    const sleep = vi.fn<(milliseconds: number, signal: AbortSignal) => Promise<void>>();
    const supervisor = new HermesReminderSupervisor(runner, {
      pollIntervalMilliseconds: 100,
      sleep,
    });
    sleep.mockImplementation(async () => {
      observedState = supervisor.health().state;
      controller.abort("test complete");
    });

    await supervisor.run(controller.signal);
    expect(observedState).toBe("disabled");
    expect(runner.runOnce).not.toHaveBeenCalled();
  });

  it("does not claim when shutdown races the operator control check", async () => {
    const controller = new AbortController();
    const runner = { runOnce: vi.fn(async (): Promise<HermesReminderRunResult> => idle) };
    const supervisor = new HermesReminderSupervisor(runner, {
      enabled: () => {
        controller.abort("shutdown during control");
        return true;
      },
    });

    await supervisor.run(controller.signal);
    expect(runner.runOnce).not.toHaveBeenCalled();
    expect(supervisor.health().state).toBe("stopped");
  });

  it("polls sequentially, becomes ready after an idle cycle, and stops on abort", async () => {
    const controller = new AbortController();
    const runner = { runOnce: vi.fn(async (): Promise<HermesReminderRunResult> => idle) };
    const sleep = vi.fn<(milliseconds: number, signal: AbortSignal) => Promise<void>>();
    const supervisor = new HermesReminderSupervisor(runner, {
      pollIntervalMilliseconds: 100,
      enabled: () => true,
      sleep,
      now: () => new Date("2026-07-15T12:00:00.000Z"),
    });
    sleep.mockImplementation(async () => {
      expect(supervisor.health()).toMatchObject({
        ready: true,
        state: "running",
        consecutiveFailures: 0,
        lastCycleStatus: "idle",
      });
      controller.abort("test complete");
    });

    await supervisor.run(controller.signal);

    expect(runner.runOnce).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(100, controller.signal);
    expect(supervisor.health()).toEqual({
      live: true,
      ready: false,
      state: "stopped",
      consecutiveFailures: 0,
      lastCycleStatus: "idle",
      lastFailureClass: null,
      lastFailureAt: null,
      lastSuccessfulPollAt: "2026-07-15T12:00:00.000Z",
    });
  });

  it("treats a reject-on-abort polling sleep as graceful shutdown", async () => {
    const controller = new AbortController();
    const runner = { runOnce: vi.fn(async (): Promise<HermesReminderRunResult> => idle) };
    const sleep = vi.fn(
      async (_milliseconds: number, signal: AbortSignal): Promise<void> =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              const error = new Error("private abort detail");
              error.name = "AbortError";
              reject(error);
            },
            { once: true },
          );
        }),
    );
    const supervisor = new HermesReminderSupervisor(runner, {
      enabled: () => true,
      sleep,
    });
    const running = supervisor.run(controller.signal);
    await vi.waitFor(() => expect(sleep).toHaveBeenCalledTimes(1));

    controller.abort("graceful shutdown");
    await expect(running).resolves.toBeUndefined();
    expect(supervisor.health()).toMatchObject({ state: "stopped", ready: false });
  });

  it("never overlaps an in-flight cycle and rejects a second run", async () => {
    const cycle = deferred<HermesReminderRunResult>();
    const runner = { runOnce: vi.fn(() => cycle.promise) };
    const supervisor = new HermesReminderSupervisor(runner, { enabled: () => true });
    const controller = new AbortController();
    const running = supervisor.run(controller.signal);
    await vi.waitFor(() => expect(runner.runOnce).toHaveBeenCalledTimes(1));

    await expect(supervisor.run(controller.signal)).rejects.toMatchObject({
      name: "HermesReminderSupervisorError",
      code: "already_running",
    });
    controller.abort("shutdown");
    await Promise.resolve();
    let settled = false;
    void running.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    cycle.resolve(idle);
    await running;
    expect(runner.runOnce).toHaveBeenCalledTimes(1);
  });

  it("does not claim while disabled and resumes only after the control enables it", async () => {
    const controller = new AbortController();
    let enabled = false;
    let sleeps = 0;
    const runner = { runOnce: vi.fn(async (): Promise<HermesReminderRunResult> => idle) };
    const sleep = vi.fn<(milliseconds: number, signal: AbortSignal) => Promise<void>>();
    const supervisor = new HermesReminderSupervisor(runner, {
      pollIntervalMilliseconds: 100,
      enabled: () => enabled,
      sleep,
    });
    sleep.mockImplementation(async () => {
      sleeps += 1;
      if (sleeps === 1) {
        expect(supervisor.health()).toMatchObject({ state: "disabled", ready: false });
        expect(runner.runOnce).not.toHaveBeenCalled();
        enabled = true;
      } else {
        controller.abort("test complete");
      }
    });

    await supervisor.run(controller.signal);
    expect(runner.runOnce).toHaveBeenCalledTimes(1);
    expect(sleeps).toBe(2);
  });

  it.each(["busy", "ambiguous", "lease_exhausted"] as const)(
    "treats %s as a successful bounded cycle instead of an infrastructure failure",
    async (status) => {
      const controller = new AbortController();
      const runner = {
        runOnce: vi.fn(async (): Promise<HermesReminderRunResult> => ({
          status,
          deliveryId: "private-delivery-id",
        })),
      };
      const sleep = vi.fn<(milliseconds: number, signal: AbortSignal) => Promise<void>>();
      const supervisor = new HermesReminderSupervisor(runner, {
        pollIntervalMilliseconds: 100,
        enabled: () => true,
        sleep,
      });
      sleep.mockImplementation(async () => {
        expect(supervisor.health()).toMatchObject({
          ready: true,
          consecutiveFailures: 0,
          lastCycleStatus: status,
          lastFailureClass: null,
        });
        expect(JSON.stringify(supervisor.health())).not.toContain("private-delivery-id");
        controller.abort();
      });

      await supervisor.run(controller.signal);
    },
  );

  it("uses deterministic jitter for retryable failures and resets after a successful poll", async () => {
    const controller = new AbortController();
    const runner = {
      runOnce: vi
        .fn<() => Promise<HermesReminderRunResult>>()
        .mockRejectedValueOnce(new ScheduleDeliveryGatewayError("rate_limited", true))
        .mockResolvedValueOnce(idle),
    };
    const delays: number[] = [];
    const sleep = vi.fn<(milliseconds: number, signal: AbortSignal) => Promise<void>>();
    const supervisor = new HermesReminderSupervisor(runner, {
      pollIntervalMilliseconds: 100,
      retryBaseMilliseconds: 1_000,
      retryCapMilliseconds: 8_000,
      maximumConsecutiveFailures: 3,
      enabled: () => true,
      random: () => 0.5,
      sleep,
    });
    sleep.mockImplementation(async (milliseconds) => {
      delays.push(milliseconds);
      if (delays.length === 1) {
        expect(supervisor.health()).toMatchObject({
          state: "backing_off",
          ready: false,
          consecutiveFailures: 1,
          lastFailureClass: "schedule_rate_limited",
        });
      } else {
        expect(supervisor.health()).toMatchObject({
          state: "running",
          ready: true,
          consecutiveFailures: 0,
          lastFailureClass: null,
        });
        controller.abort();
      }
    });

    await supervisor.run(controller.signal);
    expect(delays).toEqual([500, 100]);
    expect(runner.runOnce).toHaveBeenCalledTimes(2);
  });

  it("fails immediately on a non-retryable gateway contract error without exposing details", async () => {
    const privateDetail = "Bearer private-schedule-credential";
    const error = new ScheduleDeliveryGatewayError("authentication_failed", false);
    Object.defineProperty(error, "message", { value: privateDetail });
    const runner = { runOnce: vi.fn(async () => Promise.reject(error)) };
    const supervisor = new HermesReminderSupervisor(runner, {
      enabled: () => true,
      sleep: async () => {
        throw new Error("sleep must not run");
      },
    });

    const failure = await supervisor.run(new AbortController().signal).catch((reason) => reason);
    expect(failure).toBeInstanceOf(HermesReminderSupervisorError);
    expect(failure).toMatchObject({
      code: "fatal_dependency",
      failureClass: "schedule_authentication",
    });
    expect(String(failure)).not.toContain(privateDetail);
    expect(JSON.stringify(supervisor.health())).not.toContain(privateDetail);
    expect(supervisor.health()).toMatchObject({ state: "fatal", ready: false });
  });

  it("retries unknown errors only through the configured consecutive failure budget", async () => {
    const privateDetail = "postgres://person:secret@private.invalid";
    const runner = { runOnce: vi.fn(async () => Promise.reject(new Error(privateDetail))) };
    const sleep = vi.fn(async () => undefined);
    const supervisor = new HermesReminderSupervisor(runner, {
      enabled: () => true,
      maximumConsecutiveFailures: 2,
      retryBaseMilliseconds: 100,
      retryCapMilliseconds: 100,
      random: () => 1,
      sleep,
    });

    const failure = await supervisor.run(new AbortController().signal).catch((reason) => reason);
    expect(failure).toMatchObject({
      code: "failure_budget_exhausted",
      failureClass: "unexpected",
    });
    expect(runner.runOnce).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(String(failure)).not.toContain(privateDetail);
  });

  it("sanitizes control and timer failures", async () => {
    const privateDetail = "private operator path";
    const controlFailure = new HermesReminderSupervisor(
      { runOnce: async (): Promise<HermesReminderRunResult> => idle },
      {
        enabled: () => {
          throw new Error(privateDetail);
        },
      },
    );
    const first = await controlFailure
      .run(new AbortController().signal)
      .catch((reason: unknown) => reason);
    expect(first).toMatchObject({ code: "control_failure", failureClass: "unexpected" });
    expect(String(first)).not.toContain(privateDetail);

    const timerFailure = new HermesReminderSupervisor(
      { runOnce: async (): Promise<HermesReminderRunResult> => idle },
      {
        enabled: () => true,
        sleep: async () => Promise.reject(new Error(privateDetail)),
      },
    );
    const second = await timerFailure
      .run(new AbortController().signal)
      .catch((reason: unknown) => reason);
    expect(second).toMatchObject({ code: "sleep_failure", failureClass: "unexpected" });
    expect(String(second)).not.toContain(privateDetail);
  });

  it("fails closed when injected classification or jitter hooks violate their contract", async () => {
    const privateDetail = "private dependency detail";
    const runner = { runOnce: async () => Promise.reject(new Error(privateDetail)) };
    const invalidClassifier = new HermesReminderSupervisor(runner, {
      enabled: () => true,
      classifyFailure: () => null as never,
    });
    const first = await invalidClassifier
      .run(new AbortController().signal)
      .catch((reason: unknown) => reason);
    expect(first).toMatchObject({ code: "fatal_dependency", failureClass: "unexpected" });
    expect(String(first)).not.toContain(privateDetail);

    const invalidRandom = new HermesReminderSupervisor(runner, {
      enabled: () => true,
      maximumConsecutiveFailures: 2,
      random: () => {
        throw new Error(privateDetail);
      },
    });
    const second = await invalidRandom
      .run(new AbortController().signal)
      .catch((reason: unknown) => reason);
    expect(second).toMatchObject({ code: "fatal_dependency", failureClass: "unexpected" });
    expect(String(second)).not.toContain(privateDetail);
  });
});

describe("Hermes reminder supervisor failure classification", () => {
  it.each([
    [new ScheduleDeliveryGatewayError("server_unavailable", true), "schedule_unavailable", true],
    [
      new ScheduleDeliveryGatewayError("invalid_response", false),
      "schedule_invalid_response",
      false,
    ],
    [new PostgresDeliveryDedupeStoreError("operation_timeout", "private"), "dedupe_timeout", true],
    [new PostgresDeliveryDedupeStoreError("reservation_fenced", "private"), "dedupe_fenced", true],
    [new PostgresDeliveryDedupeStoreError("unsupported_schema", "private"), "dedupe_schema", false],
    [new Error("private"), "unexpected", true],
  ] as const)(
    "maps fixed dependency failures without raw messages",
    (error, failureClass, retryable) => {
      expect(classifyHermesReminderSupervisorFailure(error)).toEqual({ failureClass, retryable });
    },
  );
});
