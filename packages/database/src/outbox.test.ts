import { describe, expect, it } from "vitest";

import type { DatabaseConnection } from "./database.js";
import {
  MAX_EXCLUDED_OUTBOX_TOPICS,
  claimNextOutboxEvent,
  completeOutboxEvent,
  failOutboxEvent,
  releaseOutboxEvent,
  renewOutboxEventLease,
  type ClaimedOutboxEvent,
} from "./outbox.js";

interface CapturedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

type QueryRows = readonly Record<string, unknown>[];
type TaggedQuery = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<QueryRows>;

const captureQuery =
  (captures: CapturedQuery[], rows: QueryRows): TaggedQuery =>
  async (strings, ...values) => {
    captures.push({
      text: strings.join("?").replaceAll(/\s+/g, " ").trim(),
      values,
    });
    return rows;
  };

const createConnection = (options: {
  readonly transactionRows?: readonly QueryRows[];
  readonly directRows?: readonly QueryRows[];
}): { readonly connection: DatabaseConnection; readonly captures: CapturedQuery[] } => {
  const captures: CapturedQuery[] = [];
  const directRows = [...(options.directRows ?? [])];
  const transactionRows = [...(options.transactionRows ?? [])];
  const directQuery = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = captureQuery(captures, directRows.shift() ?? []);
    return query(strings, ...values);
  }) as TaggedQuery;
  const transactionQuery = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = captureQuery(captures, transactionRows.shift() ?? []);
    return query(strings, ...values);
  }) as TaggedQuery;
  const sql = Object.assign(directQuery, {
    begin: async (callback: (transaction: TaggedQuery) => Promise<unknown>) =>
      callback(transactionQuery),
  });

  return {
    connection: {
      db: {},
      sql,
      close: async () => undefined,
    } as unknown as DatabaseConnection,
    captures,
  };
};

const event: ClaimedOutboxEvent = {
  id: "00000000-0000-0000-0000-000000000001",
  workspaceId: null,
  topic: "test.created",
  payload: { value: 1 },
  attempts: 1,
  lockedAt: "2026-07-12 12:00:00+00",
};

describe("outbox claims", () => {
  it("dead-letters exhausted work and atomically claims only one eligible event", async () => {
    const lockedAt = "2026-07-12 12:05:00.123456+00";
    const { connection, captures } = createConnection({
      transactionRows: [
        [
          {
            id: "00000000-0000-0000-0000-000000000099",
            workspace_id: null,
            topic: "test.exhausted",
            attempts: 3,
            last_error: "claim expired",
          },
        ],
        [
          {
            id: event.id,
            workspace_id: null,
            topic: event.topic,
            payload: event.payload,
            attempts: 2,
            locked_at: lockedAt,
          },
        ],
      ],
    });

    await expect(
      claimNextOutboxEvent(connection, {
        leaseDurationMs: 30_000,
        maxAttempts: 3,
        deadLetterRecoveryLimit: 10,
      }),
    ).resolves.toEqual({
      event: { ...event, attempts: 2, lockedAt },
      deadLettered: [
        {
          id: "00000000-0000-0000-0000-000000000099",
          workspaceId: null,
          topic: "test.exhausted",
          attempts: 3,
          lastError: "claim expired",
        },
      ],
    });

    const recovery = captures[0];
    const claim = captures[1];
    expect(recovery?.text).toContain("attempts >= ?");
    expect(recovery?.text).toContain("for update skip locked");
    expect(recovery?.text).toContain("status = 'dead_letter'");
    expect(recovery?.text).toContain("topic <> all(?::text[])");
    expect(recovery?.values.slice(0, 4)).toEqual([3, [], 30_000, 10]);
    expect(claim?.text).toContain("attempts < ?");
    expect(claim?.text).toContain("topic <> all(?::text[])");
    expect(claim?.text).toContain("for update skip locked limit 1");
    expect(claim?.text).toContain("event.locked_at + interval '1 microsecond'");
    expect(claim?.values).toEqual([3, [], 30_000]);
  });

  it("excludes the same bounded topic set from exhausted recovery and new claims", async () => {
    const excludedTopics = ["webhook.delivery.v1", "integration.paused"] as const;
    const { connection, captures } = createConnection({ transactionRows: [[], []] });

    await claimNextOutboxEvent(connection, { maxAttempts: 3, excludedTopics });

    expect(captures).toHaveLength(2);
    expect(captures[0]?.text).toContain("topic <> all(?::text[])");
    expect(captures[1]?.text).toContain("topic <> all(?::text[])");
    expect(captures[0]?.values[1]).toEqual(excludedTopics);
    expect(captures[1]?.values[1]).toEqual(excludedTopics);
  });

  it("turns a max-attempt expired claim into a dead letter instead of reclaiming it", async () => {
    const { connection } = createConnection({
      transactionRows: [
        [
          {
            id: event.id,
            workspace_id: null,
            topic: event.topic,
            attempts: 3,
            last_error: "Maximum delivery attempts exhausted",
          },
        ],
        [],
      ],
    });

    const result = await claimNextOutboxEvent(connection, {
      leaseDurationMs: 1_000,
      maxAttempts: 3,
    });

    expect(result.event).toBeNull();
    expect(result.deadLettered).toHaveLength(1);
    expect(result.deadLettered[0]?.attempts).toBe(3);
  });

  it("rejects invalid lease, attempt, and recovery bounds before querying", async () => {
    const { connection, captures } = createConnection({});

    await expect(
      claimNextOutboxEvent(connection, { leaseDurationMs: 0, maxAttempts: 3 }),
    ).rejects.toThrow("leaseDurationMs");
    await expect(claimNextOutboxEvent(connection, { maxAttempts: 0 })).rejects.toThrow(
      "maxAttempts",
    );
    await expect(
      claimNextOutboxEvent(connection, { maxAttempts: 3, deadLetterRecoveryLimit: 0 }),
    ).rejects.toThrow("deadLetterRecoveryLimit");
    expect(captures).toEqual([]);
  });

  it("rejects invalid excluded topic lists before querying", async () => {
    const { connection, captures } = createConnection({});
    const oversizedList = Array.from(
      { length: MAX_EXCLUDED_OUTBOX_TOPICS + 1 },
      (_, index) => `topic.${index}`,
    );

    await expect(
      claimNextOutboxEvent(connection, { maxAttempts: 3, excludedTopics: [""] }),
    ).rejects.toThrow("non-empty string");
    await expect(
      claimNextOutboxEvent(connection, { maxAttempts: 3, excludedTopics: ["x".repeat(161)] }),
    ).rejects.toThrow("160");
    await expect(
      claimNextOutboxEvent(connection, { maxAttempts: 3, excludedTopics: ["same", "same"] }),
    ).rejects.toThrow("duplicates");
    await expect(
      claimNextOutboxEvent(connection, { maxAttempts: 3, excludedTopics: oversizedList }),
    ).rejects.toThrow(`at most ${MAX_EXCLUDED_OUTBOX_TOPICS}`);
    await expect(
      claimNextOutboxEvent(connection, {
        maxAttempts: 3,
        excludedTopics: "not-an-array" as unknown as readonly string[],
      }),
    ).rejects.toThrow("must be an array");
    expect(captures).toEqual([]);
  });

  it("renews a lease with a fresh fencing token and rejects stale renewal", async () => {
    const renewedAt = "2026-07-12 12:01:00.123456+00";
    const { connection, captures } = createConnection({
      directRows: [[{ locked_at: renewedAt }], []],
    });

    await expect(renewOutboxEventLease(connection, event)).resolves.toEqual({
      status: "renewed",
      event: { ...event, lockedAt: renewedAt },
    });
    await expect(renewOutboxEventLease(connection, event)).resolves.toEqual({ status: "stale" });

    expect(captures[0]?.text).toContain("locked_at + interval '1 microsecond'");
    expect(captures[0]?.text).toContain("and locked_at = ?::timestamptz");
    expect(captures[0]?.values).toEqual([event.id, event.lockedAt]);
  });

  it("completes only the worker holding the current claim token", async () => {
    const { connection, captures } = createConnection({
      directRows: [[{ id: event.id }], []],
    });

    await expect(completeOutboxEvent(connection, event)).resolves.toBe("applied");
    await expect(completeOutboxEvent(connection, event)).resolves.toBe("stale");

    expect(captures[0]?.text).toContain("and status = 'processing'");
    expect(captures[0]?.text).toContain("and locked_at = ?::timestamptz");
    expect(captures[0]?.values).toEqual([event.id, event.lockedAt]);
  });

  it("reports retry, dead-letter, and stale failure outcomes behind the fence", async () => {
    const { connection, captures } = createConnection({
      directRows: [[{ status: "pending" }], [{ status: "dead_letter" }], []],
    });

    await expect(failOutboxEvent(connection, event, "temporary", 3)).resolves.toBe(
      "retry_scheduled",
    );
    await expect(failOutboxEvent(connection, event, "terminal", 3)).resolves.toBe("dead_lettered");
    await expect(failOutboxEvent(connection, event, "stale", 3)).resolves.toBe("stale");

    expect(captures[0]?.text).toContain("attempts >= ?");
    expect(captures[0]?.text).toContain("returning status::text as status");
    expect(captures[0]?.values).toEqual([
      false,
      3,
      false,
      3,
      2_000,
      "temporary",
      event.id,
      event.lockedAt,
    ]);
  });

  it("allows a fenced terminal failure and bounded handler retry delay", async () => {
    const { connection, captures } = createConnection({
      directRows: [[{ status: "dead_letter" }], [{ status: "pending" }]],
    });
    await expect(
      failOutboxEvent(connection, event, "terminal", 99, { permanent: true }),
    ).resolves.toBe("dead_lettered");
    await expect(
      failOutboxEvent(connection, event, "slow", 99, { retryDelayMs: 999_999 }),
    ).resolves.toBe("retry_scheduled");
    expect(captures[0]?.values.slice(0, 5)).toEqual([true, 99, true, 99, 2_000]);
    expect(captures[1]?.values.slice(0, 5)).toEqual([false, 99, false, 99, 60_000]);
    await expect(
      failOutboxEvent(connection, event, "bad", 3, { retryDelayMs: -1 }),
    ).rejects.toThrow("retryDelayMs");
  });

  it("releases only the current unstarted claim during graceful shutdown", async () => {
    const { connection, captures } = createConnection({ directRows: [[]] });

    await expect(releaseOutboxEvent(connection, event)).resolves.toBe("stale");

    expect(captures[0]?.text).toContain(
      "set status = 'pending', locked_at = null, attempts = greatest(attempts - 1, 0)",
    );
    expect(captures[0]?.text).toContain("and locked_at = ?::timestamptz");
    expect(captures[0]?.values).toEqual([event.id, event.lockedAt]);
  });
});
