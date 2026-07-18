import { describe, expect, it, vi } from "vitest";

import {
  cleanupHostedWorkItemSync,
  hostedWorkItemSyncCleanupBounds,
  hostedWorkItemSyncCleanupDefaults,
  parseHostedWorkItemSyncCleanupArguments,
} from "./cleanup-hosted-work-item-sync.js";

describe("hosted work-item sync cleanup", () => {
  it("parses conservative defaults, inclusive bounds, and split or inline options", () => {
    expect(parseHostedWorkItemSyncCleanupArguments([])).toEqual(hostedWorkItemSyncCleanupDefaults);
    expect(
      parseHostedWorkItemSyncCleanupArguments([
        "--",
        `--retention-days=${String(hostedWorkItemSyncCleanupBounds.retentionDays.minimum)}`,
        "--batch-size",
        String(hostedWorkItemSyncCleanupBounds.batchSize.maximum),
        "--max-batches=8",
      ]),
    ).toEqual({ retentionDays: 30, batchSize: 1_000, maxBatches: 8 });
  });

  it.each([
    ["unexpected"],
    ["--unknown=1"],
    ["--retention-days"],
    ["--retention-days=029"],
    ["--retention-days=29"],
    ["--retention-days=3651"],
    ["--batch-size=0"],
    ["--batch-size=1001"],
    ["--max-batches=0"],
    ["--batch-size=1", "--batch-size=2"],
  ])("rejects malformed or unsafe arguments", (...arguments_) => {
    expect(() => parseHostedWorkItemSyncCleanupArguments(arguments_)).toThrow(/Usage:/u);
  });

  it("purges bounded batches to empty and reports aggregate counts only", async () => {
    const close = vi.fn(async () => undefined);
    const now = new Date("2026-07-18T12:00:00.000Z");
    const purgeBatch = vi
      .fn()
      .mockResolvedValueOnce({ workspaceId: "workspace-a", minimumCursor: "2", deletedChanges: 2 })
      .mockResolvedValueOnce({ workspaceId: "workspace-b", minimumCursor: "1", deletedChanges: 1 })
      .mockResolvedValueOnce({ workspaceId: null, minimumCursor: null, deletedChanges: 0 });

    await expect(
      cleanupHostedWorkItemSync(
        { retentionDays: 90, batchSize: 250, maxBatches: 100 },
        { connection: { close }, now: () => now, purgeBatch },
      ),
    ).resolves.toEqual({
      batches: 2,
      deletedChanges: 3,
      workspacesTouched: 2,
      limitReached: false,
    });
    expect(purgeBatch).toHaveBeenCalledTimes(3);
    expect(purgeBatch).toHaveBeenCalledWith(expect.anything(), {
      now,
      minimumRetentionMs: 90 * 86_400_000,
      batchSize: 250,
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes on failure and rejects malformed purge state", async () => {
    const close = vi.fn(async () => undefined);
    await expect(
      cleanupHostedWorkItemSync(
        { retentionDays: 90, batchSize: 1, maxBatches: 1 },
        {
          connection: { close },
          now: () => new Date(),
          purgeBatch: async () => ({
            workspaceId: null,
            minimumCursor: null,
            deletedChanges: 1,
          }),
        },
      ),
    ).rejects.toThrow("invalid purge result");
    expect(close).toHaveBeenCalledOnce();
  });

  it("rejects a positive deletion with a partial cursor identity", async () => {
    const close = vi.fn(async () => undefined);
    await expect(
      cleanupHostedWorkItemSync(
        { retentionDays: 90, batchSize: 1, maxBatches: 1 },
        {
          connection: { close },
          now: () => new Date(),
          purgeBatch: async () => ({
            workspaceId: "workspace-a",
            minimumCursor: null,
            deletedChanges: 1,
          }),
        },
      ),
    ).rejects.toThrow("invalid purge result");
    expect(close).toHaveBeenCalledOnce();
  });

  it("closes before purge when programmatic options or the clock are invalid", async () => {
    for (const fixture of [
      { options: { retentionDays: 90, batchSize: 1, maxBatches: 1_001 }, now: () => new Date() },
      {
        options: { retentionDays: 90, batchSize: 1, maxBatches: 1 },
        now: () => new Date(Number.NaN),
      },
    ]) {
      const close = vi.fn(async () => undefined);
      const purgeBatch = vi.fn();
      await expect(
        cleanupHostedWorkItemSync(fixture.options, {
          connection: { close },
          now: fixture.now,
          purgeBatch,
        }),
      ).rejects.toThrow(/invalid maxBatches|valid clock/u);
      expect(purgeBatch).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledOnce();
    }
  });

  it("preserves simultaneous purge and close failures", async () => {
    const purgeFailure = new Error("purge failed");
    const closeFailure = new Error("close failed");
    const failure = await cleanupHostedWorkItemSync(
      { retentionDays: 90, batchSize: 1, maxBatches: 1 },
      {
        connection: { close: async () => Promise.reject(closeFailure) },
        now: () => new Date(),
        purgeBatch: async () => Promise.reject(purgeFailure),
      },
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([purgeFailure, closeFailure]);
  });
});
