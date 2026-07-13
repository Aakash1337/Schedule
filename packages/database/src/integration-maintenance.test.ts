import { describe, expect, it, vi } from "vitest";

import type { DatabaseConnection } from "./database.js";
import {
  DEFAULT_INTEGRATION_MINIMUM_RETENTION_MS,
  DEFAULT_INTEGRATION_PURGE_BATCH_SIZE,
  MAX_INTEGRATION_MINIMUM_RETENTION_MS,
  MAX_INTEGRATION_PURGE_BATCH_SIZE,
  MIN_INTEGRATION_MINIMUM_RETENTION_MS,
  purgeIntegrationHistory,
} from "./integration-maintenance.js";

interface CapturedQuery {
  readonly text: string;
  readonly parameters: readonly unknown[];
}

function maintenanceConnection(results: readonly (readonly { readonly id: string }[])[]): {
  readonly connection: DatabaseConnection;
  readonly begin: ReturnType<typeof vi.fn>;
  readonly queries: CapturedQuery[];
} {
  const queries: CapturedQuery[] = [];
  let resultIndex = 0;
  const transaction = (
    strings: TemplateStringsArray,
    ...parameters: readonly unknown[]
  ): Promise<readonly { readonly id: string }[]> => {
    queries.push({ text: strings.join("?"), parameters });
    const result = results[resultIndex] ?? [];
    resultIndex += 1;
    return Promise.resolve(result);
  };
  const begin = vi.fn(async (operation: (transaction: typeof transaction) => Promise<unknown>) =>
    operation(transaction),
  );
  return {
    connection: { sql: { begin } } as unknown as DatabaseConnection,
    begin,
    queries,
  };
}

describe("purgeIntegrationHistory", () => {
  it("deletes succeeded receipts before expired unreferenced confirmations in bounded batches", async () => {
    const { connection, begin, queries } = maintenanceConnection([
      [{ id: "request-1" }, { id: "request-2" }],
      [{ id: "confirmation-1" }],
    ]);
    const now = new Date("2026-07-13T04:00:00.000Z");

    await expect(purgeIntegrationHistory(connection, { now })).resolves.toEqual({
      cutoff: new Date(now.getTime() - DEFAULT_INTEGRATION_MINIMUM_RETENTION_MS),
      deletedRequests: 2,
      deletedConfirmations: 1,
      totalDeleted: 3,
    });

    expect(begin).toHaveBeenCalledTimes(1);
    expect(queries).toHaveLength(2);
    expect(queries[0]?.text).toContain("status = 'succeeded'");
    expect(queries[0]?.text).toContain("completed_at <");
    expect(queries[0]?.text).toContain("for update skip locked");
    expect(queries[0]?.parameters).toEqual([
      new Date(now.getTime() - DEFAULT_INTEGRATION_MINIMUM_RETENTION_MS).toISOString(),
      DEFAULT_INTEGRATION_PURGE_BATCH_SIZE,
    ]);
    expect(queries[1]?.text).toContain("confirmation.expires_at <");
    expect(queries[1]?.text.match(/not exists/g)).toHaveLength(2);
    expect(queries[1]?.text).toContain("from integration_requests as request");
    expect(queries[1]?.text).toContain("for update of confirmation skip locked");
    expect(queries[1]?.parameters).toEqual([
      new Date(now.getTime() - DEFAULT_INTEGRATION_MINIMUM_RETENTION_MS).toISOString(),
      DEFAULT_INTEGRATION_PURGE_BATCH_SIZE,
      new Date(now.getTime() - DEFAULT_INTEGRATION_MINIMUM_RETENTION_MS).toISOString(),
    ]);
  });

  it("honors the configured safe retention and batch limits", async () => {
    const { connection, queries } = maintenanceConnection([[], []]);
    const now = new Date("2026-07-13T04:00:00.000Z");

    const result = await purgeIntegrationHistory(connection, {
      now,
      minimumRetentionMs: MIN_INTEGRATION_MINIMUM_RETENTION_MS,
      batchSize: MAX_INTEGRATION_PURGE_BATCH_SIZE,
    });

    expect(result.cutoff).toEqual(new Date(now.getTime() - MIN_INTEGRATION_MINIMUM_RETENTION_MS));
    expect(result.totalDeleted).toBe(0);
    expect(queries[0]?.parameters.at(-1)).toBe(MAX_INTEGRATION_PURGE_BATCH_SIZE);
    expect(queries[1]?.parameters.at(-2)).toBe(MAX_INTEGRATION_PURGE_BATCH_SIZE);
  });

  it.each([
    ["invalid date", { now: new Date(Number.NaN) }],
    ["cutoff outside the Date range", { now: new Date(-8.64e15) }],
    [
      "retention below the safety floor",
      { now: new Date(), minimumRetentionMs: MIN_INTEGRATION_MINIMUM_RETENTION_MS - 1 },
    ],
    [
      "retention above the supported ceiling",
      { now: new Date(), minimumRetentionMs: MAX_INTEGRATION_MINIMUM_RETENTION_MS + 1 },
    ],
    [
      "fractional retention",
      { now: new Date(), minimumRetentionMs: MIN_INTEGRATION_MINIMUM_RETENTION_MS + 0.5 },
    ],
    ["empty batch", { now: new Date(), batchSize: 0 }],
    ["oversized batch", { now: new Date(), batchSize: MAX_INTEGRATION_PURGE_BATCH_SIZE + 1 }],
    ["fractional batch", { now: new Date(), batchSize: 1.5 }],
  ])("rejects %s before opening a transaction", async (_name, options) => {
    const { connection, begin } = maintenanceConnection([[], []]);

    await expect(purgeIntegrationHistory(connection, options)).rejects.toBeInstanceOf(RangeError);
    expect(begin).not.toHaveBeenCalled();
  });

  it("does not attempt confirmation deletion when receipt deletion fails", async () => {
    const failure = new Error("receipt deletion failed");
    const queries: CapturedQuery[] = [];
    const transaction = (
      strings: TemplateStringsArray,
      ...parameters: readonly unknown[]
    ): Promise<never> => {
      queries.push({ text: strings.join("?"), parameters });
      return Promise.reject(failure);
    };
    const begin = vi.fn(async (operation: (transaction: typeof transaction) => Promise<unknown>) =>
      operation(transaction),
    );
    const connection = { sql: { begin } } as unknown as DatabaseConnection;

    await expect(
      purgeIntegrationHistory(connection, { now: new Date("2026-07-13T04:00:00.000Z") }),
    ).rejects.toBe(failure);
    expect(queries).toHaveLength(1);
  });
});
