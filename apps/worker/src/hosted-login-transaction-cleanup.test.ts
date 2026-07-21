import { describe, expect, it, vi } from "vitest";

import type { DatabaseConnection } from "@schedule/database";

import {
  createHostedLoginTransactionCleanupDependencies,
  runHostedLoginTransactionCleanupCycle,
  runHostedLoginTransactionCleanupWorker,
  type HostedLoginTransactionCleanupDependencies,
  type HostedLoginTransactionCleanupLogger,
} from "./hosted-login-transaction-cleanup.js";

const config = {
  HOSTED_LOGIN_TRANSACTION_CLEANUP_MODE: "enabled" as const,
  HOSTED_LOGIN_TRANSACTION_CLEANUP_INTERVAL_MS: 60_000,
  HOSTED_LOGIN_TRANSACTION_CLEANUP_BATCH_SIZE: 1_000,
};

function harness(prune: HostedLoginTransactionCleanupDependencies["prune"]) {
  const logger: HostedLoginTransactionCleanupLogger = { info: vi.fn(), error: vi.fn() };
  const telemetry = { recordHostedLoginTransactionCleanupCycle: vi.fn() };
  return { dependencies: { prune }, logger, telemetry };
}

describe("hosted login transaction cleanup", () => {
  it("wires cleanup to the supplied maintenance database", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([{ value: new Date("2026-01-01T00:00:00.000Z") }])
      .mockResolvedValueOnce([{ id: "expired-login" }]);
    const transaction = vi.fn(
      async (operation: (database: { execute: typeof execute }) => Promise<unknown>) =>
        operation({ execute }),
    );
    const connection = { db: { transaction } } as unknown as DatabaseConnection;

    await expect(
      createHostedLoginTransactionCleanupDependencies(connection).prune(3),
    ).resolves.toBe(1);
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "read committed",
    });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("does no work while disabled and records an enabled cycle interrupted before it starts", async () => {
    const prune = vi.fn();
    const { dependencies, logger, telemetry } = harness(prune);

    await expect(
      runHostedLoginTransactionCleanupCycle(
        { ...config, HOSTED_LOGIN_TRANSACTION_CLEANUP_MODE: "disabled" },
        dependencies,
        new AbortController().signal,
        logger,
        telemetry,
      ),
    ).resolves.toEqual({ deletedTransactions: 0, failed: false, aborted: false });

    const controller = new AbortController();
    controller.abort("shutdown");
    await expect(
      runHostedLoginTransactionCleanupCycle(
        config,
        dependencies,
        controller.signal,
        logger,
        telemetry,
      ),
    ).resolves.toEqual({ deletedTransactions: 0, failed: false, aborted: true });
    expect(prune).not.toHaveBeenCalled();
    expect(telemetry.recordHostedLoginTransactionCleanupCycle).toHaveBeenCalledTimes(1);
  });

  it("runs one bounded batch and emits aggregate-only evidence", async () => {
    const { dependencies, logger, telemetry } = harness(vi.fn(async () => 42));
    const summary = await runHostedLoginTransactionCleanupCycle(
      config,
      dependencies,
      new AbortController().signal,
      logger,
      telemetry,
    );

    expect(summary).toEqual({ deletedTransactions: 42, failed: false, aborted: false });
    expect(dependencies.prune).toHaveBeenCalledWith(1_000);
    expect(telemetry.recordHostedLoginTransactionCleanupCycle).toHaveBeenCalledWith(summary);
    expect(logger.info).toHaveBeenCalledWith({
      event: "hosted_login_transaction_cleanup_cycle_completed",
      deletedTransactions: 42,
      failed: false,
      aborted: false,
    });
  });

  it("redacts failures and rejects an invalid repository count", async () => {
    const privateFailure = "postgres://person:secret@private.internal";
    for (const prune of [
      vi.fn(async () => {
        throw new Error(privateFailure);
      }),
      vi.fn(async () => 1_001),
    ]) {
      const { dependencies, logger, telemetry } = harness(prune);
      const summary = await runHostedLoginTransactionCleanupCycle(
        config,
        dependencies,
        new AbortController().signal,
        logger,
        telemetry,
      );
      expect(summary).toEqual({ deletedTransactions: 0, failed: true, aborted: false });
      expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain(privateFailure);
      expect(telemetry.recordHostedLoginTransactionCleanupCycle).toHaveBeenCalledWith(summary);
    }
  });

  it("waits for the configured interval and retries a failed cycle", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const prune = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary database failure"))
      .mockImplementationOnce(async () => {
        controller.abort("test complete");
        return 0;
      });
    const { dependencies, logger, telemetry } = harness(prune);

    try {
      const running = runHostedLoginTransactionCleanupWorker(
        config,
        dependencies,
        controller.signal,
        logger,
        telemetry,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(prune).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(59_999);
      expect(prune).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await running;
      expect(prune).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("finishes an in-flight batch and then stops during shutdown", async () => {
    const controller = new AbortController();
    const prune = vi.fn(async () => {
      controller.abort("shutdown");
      return 1;
    });
    const { dependencies, logger, telemetry } = harness(prune);

    await expect(
      runHostedLoginTransactionCleanupWorker(
        config,
        dependencies,
        controller.signal,
        logger,
        telemetry,
      ),
    ).resolves.toBeUndefined();
    expect(prune).toHaveBeenCalledTimes(1);
    expect(telemetry.recordHostedLoginTransactionCleanupCycle).toHaveBeenCalledWith({
      deletedTransactions: 1,
      failed: false,
      aborted: true,
    });
  });
});
