import { describe, expect, it, vi } from "vitest";

import {
  runHostedSyncCleanupCycle,
  runHostedSyncCleanupWorker,
  type HostedSyncCleanupDependencies,
  type HostedSyncCleanupLogger,
} from "./hosted-sync-cleanup.js";

const now = new Date("2026-07-18T12:00:00.000Z");
const config = {
  HOSTED_WORK_ITEM_SYNC_CLEANUP_MODE: "enabled" as const,
  HOSTED_WORK_ITEM_SYNC_CLEANUP_INTERVAL_MS: 3_600_000,
  HOSTED_WORK_ITEM_SYNC_CLEANUP_RETENTION_DAYS: 90,
  HOSTED_WORK_ITEM_SYNC_CLEANUP_BATCH_SIZE: 250,
  HOSTED_WORK_ITEM_SYNC_CLEANUP_MAX_BATCHES: 3,
};

function result(
  deletedChanges: number,
  workspaceId: string | null,
  minimumCursor: string | null,
  contended = false,
) {
  return { cutoff: now, deletedChanges, workspaceId, minimumCursor, contended };
}

function harness(purgeBatch: HostedSyncCleanupDependencies["purgeBatch"]) {
  const logger: HostedSyncCleanupLogger = { info: vi.fn(), error: vi.fn() };
  const telemetry = { recordHostedSyncCleanupCycle: vi.fn() };
  return {
    dependencies: { now: () => new Date(now), purgeBatch },
    logger,
    telemetry,
  };
}

describe("hosted sync cleanup", () => {
  it("does no work while disabled and records an enabled cycle interrupted before it starts", async () => {
    const purgeBatch = vi.fn();
    const { dependencies, logger, telemetry } = harness(purgeBatch);

    await expect(
      runHostedSyncCleanupCycle(
        { ...config, HOSTED_WORK_ITEM_SYNC_CLEANUP_MODE: "disabled" },
        dependencies,
        new AbortController().signal,
        logger,
        telemetry,
      ),
    ).resolves.toMatchObject({ batches: 0, aborted: false });

    const controller = new AbortController();
    controller.abort("shutdown");
    await expect(
      runHostedSyncCleanupCycle(config, dependencies, controller.signal, logger, telemetry),
    ).resolves.toMatchObject({ batches: 0, aborted: true });
    expect(purgeBatch).not.toHaveBeenCalled();
    expect(telemetry.recordHostedSyncCleanupCycle).toHaveBeenCalledTimes(1);
  });

  it("uses one clock instant, drains sequential batches, and emits aggregate-only evidence", async () => {
    const workspaceA = "11111111-1111-4111-8111-111111111111";
    const workspaceB = "22222222-2222-4222-8222-222222222222";
    const purgeBatch = vi
      .fn()
      .mockResolvedValueOnce(result(250, workspaceA, "250"))
      .mockResolvedValueOnce(result(25, workspaceB, "25"))
      .mockResolvedValueOnce(result(0, null, null));
    const { dependencies, logger, telemetry } = harness(purgeBatch);

    const summary = await runHostedSyncCleanupCycle(
      config,
      dependencies,
      new AbortController().signal,
      logger,
      telemetry,
    );

    expect(summary).toEqual({
      batches: 2,
      deletedChanges: 275,
      workspacesTouched: 2,
      failed: false,
      contended: false,
      limitReached: false,
      aborted: false,
    });
    expect(purgeBatch).toHaveBeenCalledTimes(3);
    const instants = purgeBatch.mock.calls.map(([options]) => options.now);
    expect(instants.every((instant) => instant === instants[0])).toBe(true);
    expect(purgeBatch.mock.calls[0]?.[0]).toMatchObject({
      minimumRetentionMs: 90 * 86_400_000,
      batchSize: 250,
    });
    expect(telemetry.recordHostedSyncCleanupCycle).toHaveBeenCalledWith(summary);
    const evidence = JSON.stringify({
      info: vi.mocked(logger.info).mock.calls,
      error: vi.mocked(logger.error).mock.calls,
    });
    expect(evidence).not.toContain(workspaceA);
    expect(evidence).not.toContain(workspaceB);
    expect(evidence).not.toContain('"250"');
  });

  it("reports a bounded backlog when every configured batch deletes changes", async () => {
    const purgeBatch = vi.fn(async () => result(1, "11111111-1111-4111-8111-111111111111", "1"));
    const { dependencies, logger, telemetry } = harness(purgeBatch);

    await expect(
      runHostedSyncCleanupCycle(
        { ...config, HOSTED_WORK_ITEM_SYNC_CLEANUP_MAX_BATCHES: 2 },
        dependencies,
        new AbortController().signal,
        logger,
        telemetry,
      ),
    ).resolves.toMatchObject({ batches: 2, deletedChanges: 2, limitReached: true });
    expect(purgeBatch).toHaveBeenCalledTimes(2);
  });

  it("distinguishes another transaction's lock from an empty backlog", async () => {
    const purgeBatch = vi.fn(async () => result(0, null, null, true));
    const { dependencies, logger, telemetry } = harness(purgeBatch);

    const summary = await runHostedSyncCleanupCycle(
      config,
      dependencies,
      new AbortController().signal,
      logger,
      telemetry,
    );

    expect(summary).toMatchObject({
      batches: 0,
      failed: false,
      contended: true,
      limitReached: false,
    });
    expect(telemetry.recordHostedSyncCleanupCycle).toHaveBeenCalledWith(summary);
  });

  it("redacts database failures and returns them for retry telemetry", async () => {
    const privateFailure = "postgres://person:secret@private.internal";
    const purgeBatch = vi.fn(async () => {
      throw new Error(privateFailure);
    });
    const { dependencies, logger, telemetry } = harness(purgeBatch);

    const summary = await runHostedSyncCleanupCycle(
      config,
      dependencies,
      new AbortController().signal,
      logger,
      telemetry,
    );

    expect(summary).toMatchObject({ batches: 0, failed: true });
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain(privateFailure);
    expect(telemetry.recordHostedSyncCleanupCycle).toHaveBeenCalledWith(summary);
  });

  it("waits for the configured interval and retries a failed cycle", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const purgeBatch = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary database failure"))
      .mockImplementationOnce(async () => {
        controller.abort("test complete");
        return result(0, null, null);
      });
    const { dependencies, logger, telemetry } = harness(purgeBatch);

    try {
      const running = runHostedSyncCleanupWorker(
        { ...config, HOSTED_WORK_ITEM_SYNC_CLEANUP_INTERVAL_MS: 60_000 },
        dependencies,
        controller.signal,
        logger,
        telemetry,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(purgeBatch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(59_999);
      expect(purgeBatch).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await running;
      expect(purgeBatch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("finishes an in-flight batch and stops before starting another during shutdown", async () => {
    const controller = new AbortController();
    const purgeBatch = vi.fn(async () => {
      controller.abort("shutdown");
      return result(1, "11111111-1111-4111-8111-111111111111", "1");
    });
    const { dependencies, logger, telemetry } = harness(purgeBatch);

    await expect(
      runHostedSyncCleanupCycle(config, dependencies, controller.signal, logger, telemetry),
    ).resolves.toMatchObject({ batches: 1, aborted: true, limitReached: false });
    expect(purgeBatch).toHaveBeenCalledTimes(1);
  });
});
