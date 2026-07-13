import { describe, expect, it, vi } from "vitest";

import {
  cleanupIntegrationHistory,
  formatIntegrationHistoryCleanupSummary,
  integrationHistoryCleanupBounds,
  integrationHistoryCleanupDefaults,
  parseIntegrationHistoryCleanupArguments,
  type IntegrationHistoryPurgeResult,
} from "./cleanup-integration-history.js";

interface FakeConnection {
  readonly close: ReturnType<typeof vi.fn<() => Promise<void>>>;
}

function result(
  deletedRequests: number,
  deletedConfirmations: number,
): IntegrationHistoryPurgeResult {
  return {
    deletedRequests,
    deletedConfirmations,
    totalDeleted: deletedRequests + deletedConfirmations,
  };
}

function connection(close: () => Promise<void> = async () => undefined): FakeConnection {
  return { close: vi.fn(close) };
}

describe("integration history cleanup CLI argument parsing", () => {
  it("uses conservative operational defaults", () => {
    expect(parseIntegrationHistoryCleanupArguments([])).toEqual(integrationHistoryCleanupDefaults);
    expect(parseIntegrationHistoryCleanupArguments(["--"])).toEqual(
      integrationHistoryCleanupDefaults,
    );
  });

  it("parses split and inline values", () => {
    expect(
      parseIntegrationHistoryCleanupArguments([
        "--",
        "--retention-days",
        "365",
        "--batch-size=250",
        "--max-batches",
        "8",
      ]),
    ).toEqual({ retentionDays: 365, batchSize: 250, maxBatches: 8 });
  });

  it("accepts every inclusive safety boundary", () => {
    expect(
      parseIntegrationHistoryCleanupArguments([
        `--retention-days=${String(integrationHistoryCleanupBounds.retentionDays.minimum)}`,
        `--batch-size=${String(integrationHistoryCleanupBounds.batchSize.minimum)}`,
        `--max-batches=${String(integrationHistoryCleanupBounds.maxBatches.minimum)}`,
      ]),
    ).toEqual({ retentionDays: 30, batchSize: 1, maxBatches: 1 });
    expect(
      parseIntegrationHistoryCleanupArguments([
        `--retention-days=${String(integrationHistoryCleanupBounds.retentionDays.maximum)}`,
        `--batch-size=${String(integrationHistoryCleanupBounds.batchSize.maximum)}`,
        `--max-batches=${String(integrationHistoryCleanupBounds.maxBatches.maximum)}`,
      ]),
    ).toEqual({ retentionDays: 3_650, batchSize: 1_000, maxBatches: 1_000 });
  });

  const malformedArguments: readonly (readonly string[])[] = [
    ["unexpected"],
    ["--unknown", "1"],
    ["--retention-days"],
    ["--retention-days="],
    ["--retention-days", "29"],
    ["--retention-days", "3651"],
    ["--retention-days", "30.5"],
    ["--retention-days", "+30"],
    ["--batch-size", "0"],
    ["--batch-size", "1001"],
    ["--max-batches", "0"],
    ["--max-batches", "1001"],
    ["--batch-size", "10", "--batch-size", "20"],
  ];

  malformedArguments.forEach((args, index) => {
    it(`rejects malformed or unsafe argument set ${String(index + 1)}`, () => {
      expect(() => parseIntegrationHistoryCleanupArguments(args)).toThrow(/Usage:/);
    });
  });
});

describe("integration history cleanup execution", () => {
  const options = { retentionDays: 90, batchSize: 1_000, maxBatches: 100 } as const;
  const now = new Date("2026-07-13T06:00:00.000Z");

  it("purges bounded batches to empty, aggregates counts, and closes the database", async () => {
    const activeConnection = connection();
    const purgeBatch = vi
      .fn()
      .mockResolvedValueOnce(result(1_000, 400))
      .mockResolvedValueOnce(result(225, 125))
      .mockResolvedValueOnce(result(0, 0));

    await expect(
      cleanupIntegrationHistory(options, {
        connection: activeConnection,
        now: () => now,
        purgeBatch,
      }),
    ).resolves.toEqual({
      batches: 2,
      deletedRequests: 1_225,
      deletedConfirmations: 525,
      totalDeleted: 1_750,
      limitReached: false,
    });

    expect(purgeBatch).toHaveBeenCalledTimes(3);
    expect(purgeBatch).toHaveBeenNthCalledWith(1, activeConnection, {
      now,
      minimumRetentionMs: 90 * 24 * 60 * 60 * 1_000,
      batchSize: 1_000,
    });
    expect(purgeBatch.mock.calls[1]?.[1].now).toBe(now);
    expect(activeConnection.close).toHaveBeenCalledOnce();
  });

  it("stops at max-batches without an unbounded probe", async () => {
    const activeConnection = connection();
    const purgeBatch = vi.fn(async () => result(2, 1));

    await expect(
      cleanupIntegrationHistory(
        { retentionDays: 30, batchSize: 10, maxBatches: 3 },
        { connection: activeConnection, now: () => now, purgeBatch },
      ),
    ).resolves.toEqual({
      batches: 3,
      deletedRequests: 6,
      deletedConfirmations: 3,
      totalDeleted: 9,
      limitReached: true,
    });
    expect(purgeBatch).toHaveBeenCalledTimes(3);
    expect(activeConnection.close).toHaveBeenCalledOnce();
  });

  it("closes and preserves the purge error", async () => {
    const activeConnection = connection();
    const purgeError = new Error("purge unavailable");

    await expect(
      cleanupIntegrationHistory(options, {
        connection: activeConnection,
        now: () => now,
        purgeBatch: async () => {
          throw purgeError;
        },
      }),
    ).rejects.toBe(purgeError);
    expect(activeConnection.close).toHaveBeenCalledOnce();
  });

  it("reports an initially empty history as fully drained", async () => {
    const activeConnection = connection();
    const purgeBatch = vi.fn(async () => result(0, 0));

    await expect(
      cleanupIntegrationHistory(options, {
        connection: activeConnection,
        now: () => now,
        purgeBatch,
      }),
    ).resolves.toEqual({
      batches: 0,
      deletedRequests: 0,
      deletedConfirmations: 0,
      totalDeleted: 0,
      limitReached: false,
    });
    expect(purgeBatch).toHaveBeenCalledOnce();
    expect(activeConnection.close).toHaveBeenCalledOnce();
  });

  it("reports both the operation and close failures", async () => {
    const purgeError = new Error("purge failed");
    const closeError = new Error("close failed");
    const activeConnection = connection(async () => {
      throw closeError;
    });

    const rejected = cleanupIntegrationHistory(options, {
      connection: activeConnection,
      now: () => now,
      purgeBatch: async () => {
        throw purgeError;
      },
    }).catch((error: unknown) => error);

    const error = await rejected;
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([purgeError, closeError]);
    expect(activeConnection.close).toHaveBeenCalledOnce();
  });

  it("closes when validation or returned count invariants fail", async () => {
    const invalidClockConnection = connection();
    await expect(
      cleanupIntegrationHistory(options, {
        connection: invalidClockConnection,
        now: () => new Date(Number.NaN),
        purgeBatch: async () => result(0, 0),
      }),
    ).rejects.toThrow(/valid current time/);
    expect(invalidClockConnection.close).toHaveBeenCalledOnce();

    const invalidCountConnection = connection();
    await expect(
      cleanupIntegrationHistory(options, {
        connection: invalidCountConnection,
        now: () => now,
        purgeBatch: async () => ({
          deletedRequests: 1,
          deletedConfirmations: 1,
          totalDeleted: 1,
        }),
      }),
    ).rejects.toThrow(/inconsistent deletion counts/);
    expect(invalidCountConnection.close).toHaveBeenCalledOnce();
  });

  it("formats a success as an aggregate status without retained data", () => {
    const formatted = formatIntegrationHistoryCleanupSummary({
      batches: 2,
      deletedRequests: 11,
      deletedConfirmations: 7,
      totalDeleted: 18,
      limitReached: false,
    });

    expect(JSON.parse(formatted)).toEqual({
      batches: 2,
      deletedRequests: 11,
      deletedConfirmations: 7,
      totalDeleted: 18,
      limitReached: false,
    });
    expect(formatted).not.toMatch(/cutoff|credential|secret|audit/i);
  });
});
