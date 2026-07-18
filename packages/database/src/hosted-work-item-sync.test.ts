import { readFileSync } from "node:fs";

import { workItemId, workspaceId } from "@schedule/domain";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

import type { DatabaseConnection } from "./database.js";
import {
  DEFAULT_HOSTED_WORK_ITEM_SYNC_MINIMUM_RETENTION_MS,
  MAX_HOSTED_WORK_ITEM_SYNC_MINIMUM_RETENTION_MS,
  MAX_HOSTED_WORK_ITEM_SYNC_PURGE_BATCH_SIZE,
  MIN_HOSTED_WORK_ITEM_SYNC_MINIMUM_RETENTION_MS,
  PostgresHostedWorkItemSyncStore,
  enableHostedWorkItemSyncCapture,
  purgeHostedWorkItemSyncChanges,
} from "./hosted-work-item-sync.js";
import {
  hostedWorkItemSyncChangeKind,
  hostedWorkItemSyncCapability,
  hostedWorkItemSyncChanges,
  hostedWorkItemSyncStates,
  workItems,
} from "./schema.js";

interface CapturedQuery {
  readonly text: string;
  readonly parameters: readonly unknown[];
}

type Query = <Result extends readonly unknown[]>(
  strings: TemplateStringsArray,
  ...parameters: readonly unknown[]
) => Promise<Result>;
type TransactionOperation = (transaction: Query) => Promise<unknown>;

function database(results: readonly (readonly unknown[])[]): {
  readonly connection: DatabaseConnection;
  readonly begin: ReturnType<typeof vi.fn>;
  readonly queries: CapturedQuery[];
  readonly transactionOptions: (string | null)[];
} {
  let resultIndex = 0;
  const queries: CapturedQuery[] = [];
  const transactionOptions: (string | null)[] = [];
  const transaction = (<Result extends readonly unknown[]>(
    strings: TemplateStringsArray,
    ...parameters: readonly unknown[]
  ): Promise<Result> => {
    queries.push({ text: strings.join("?"), parameters });
    const result = results[resultIndex] ?? [];
    resultIndex += 1;
    return Promise.resolve(result as Result);
  }) as Query;
  const begin = vi.fn(
    async (
      optionsOrOperation: string | TransactionOperation,
      operation?: TransactionOperation,
    ): Promise<unknown> => {
      transactionOptions.push(typeof optionsOrOperation === "string" ? optionsOrOperation : null);
      const activeOperation =
        typeof optionsOrOperation === "string" ? operation : optionsOrOperation;
      if (activeOperation === undefined) throw new Error("Missing transaction operation.");
      return activeOperation(transaction);
    },
  );
  return {
    connection: { sql: { begin } } as unknown as DatabaseConnection,
    begin,
    queries,
    transactionOptions,
  };
}

const workspace = workspaceId("11111111-1111-4111-8111-111111111111");
const firstId = workItemId("22222222-2222-4222-8222-222222222221");
const secondId = workItemId("22222222-2222-4222-8222-222222222222");
const thirdId = workItemId("22222222-2222-4222-8222-222222222223");

function itemRow(id: string) {
  return {
    id,
    parentWorkItemId: null,
    title: `Task ${id.at(-1)}`,
    description: "Focused work",
    status: "backlog" as const,
    priority: "medium" as const,
    planningDurationMinutes: 45,
    dueOn: "2026-07-20",
    version: 1,
    createdAt: "2026-07-18T10:00:00.000Z",
    updatedAt: "2026-07-18T10:05:00.000Z",
  };
}

function deleteRow(cursor: string, id: string) {
  return {
    cursor,
    kind: "delete",
    id,
    parentWorkItemId: null,
    title: null,
    description: null,
    status: null,
    priority: null,
    planningDurationMinutes: null,
    dueOn: null,
    version: null,
    createdAt: null,
    updatedAt: null,
  };
}

async function expectReason(operation: () => Promise<unknown>, reason: string): Promise<void> {
  let failure: unknown;
  try {
    await operation();
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({
    name: "HostedWorkItemSyncStoreError",
    reason,
  });
}

describe("PostgresHostedWorkItemSyncStore", () => {
  it("captures a fenced keyset bootstrap checkpoint in a repeatable-read transaction", async () => {
    const { connection, queries, transactionOptions } = database([
      [{ captureEnabled: true }],
      [{ headCursor: "7", minimumCursor: "2" }],
      [itemRow(firstId), itemRow(secondId), itemRow(thirdId)],
    ]);
    const store = new PostgresHostedWorkItemSyncStore(connection);

    await expect(store.bootstrap(workspace, { limit: 2 })).resolves.toMatchObject({
      checkpoint: "7",
      nextAfterId: secondId,
      items: [{ id: firstId }, { id: secondId }],
    });

    expect(transactionOptions).toEqual(["isolation level repeatable read read only"]);
    expect(queries[2]?.text).toContain("item.hosted_sync_cursor <= ?::bigint");
    expect(queries[2]?.text).toContain("order by item.id");
    expect(queries[2]?.parameters).toEqual([workspace, "7", null, null, 3]);
  });

  it("pins contiguous delta pages and maps upserts plus identity-minimal tombstones", async () => {
    const { connection, queries, transactionOptions } = database([
      [{ captureEnabled: true }],
      [{ headCursor: "13", minimumCursor: "9" }],
      [
        { cursor: "10", kind: "upsert", ...itemRow(firstId) },
        deleteRow("11", secondId),
        { cursor: "12", kind: "upsert", ...itemRow(thirdId) },
      ],
    ]);
    const store = new PostgresHostedWorkItemSyncStore(connection);

    await expect(
      store.listChanges(workspace, { afterCursor: "9", throughCursor: "13", limit: 2 }),
    ).resolves.toEqual({
      changes: [
        { type: "upsert", cursor: "10", item: expect.objectContaining({ id: firstId }) },
        { type: "delete", cursor: "11", workItemId: secondId },
      ],
      throughCursor: "13",
      nextAfterCursor: "11",
    });

    expect(transactionOptions).toEqual(["isolation level repeatable read read only"]);
    expect(queries[2]?.text).toContain("change.cursor > ?::bigint");
    expect(queries[2]?.text).toContain("change.cursor <= ?::bigint");
    expect(queries[2]?.text).toContain("order by change.cursor");
    expect(queries[2]?.parameters).toEqual([workspace, "9", "13", 3]);
  });

  it("distinguishes invalid, expired, and corrupt positions", async () => {
    const invalid = database([]);
    await expectReason(
      () =>
        new PostgresHostedWorkItemSyncStore(invalid.connection).listChanges(workspace, {
          afterCursor: "01",
          limit: 10,
        }),
      "invalid",
    );
    expect(invalid.begin).not.toHaveBeenCalled();

    const reversed = database([]);
    await expectReason(
      () =>
        new PostgresHostedWorkItemSyncStore(reversed.connection).listChanges(workspace, {
          afterCursor: "5",
          throughCursor: "4",
          limit: 10,
        }),
      "invalid",
    );
    expect(reversed.begin).not.toHaveBeenCalled();

    const missingCapability = database([[]]);
    await expectReason(
      () =>
        new PostgresHostedWorkItemSyncStore(missingCapability.connection).bootstrap(workspace, {
          limit: 10,
        }),
      "corrupt",
    );

    const disabled = database([[{ captureEnabled: false }]]);
    await expectReason(
      () =>
        new PostgresHostedWorkItemSyncStore(disabled.connection).bootstrap(workspace, {
          limit: 10,
        }),
      "corrupt",
    );

    const missingState = database([[{ captureEnabled: true }], []]);
    await expectReason(
      () =>
        new PostgresHostedWorkItemSyncStore(missingState.connection).bootstrap(workspace, {
          limit: 10,
        }),
      "corrupt",
    );

    const expired = database([
      [{ captureEnabled: true }],
      [{ headCursor: "8", minimumCursor: "3" }],
    ]);
    await expectReason(
      () =>
        new PostgresHostedWorkItemSyncStore(expired.connection).listChanges(workspace, {
          afterCursor: "2",
          limit: 10,
        }),
      "expired",
    );

    for (const operation of [
      (store: PostgresHostedWorkItemSyncStore) =>
        store.bootstrap(workspace, { checkpoint: "9", limit: 10 }),
      (store: PostgresHostedWorkItemSyncStore) =>
        store.listChanges(workspace, { afterCursor: "9", limit: 10 }),
      (store: PostgresHostedWorkItemSyncStore) =>
        store.listChanges(workspace, { afterCursor: "2", throughCursor: "9", limit: 10 }),
    ]) {
      const restored = database([
        [{ captureEnabled: true }],
        [{ headCursor: "8", minimumCursor: "1" }],
      ]);
      await expectReason(
        () => operation(new PostgresHostedWorkItemSyncStore(restored.connection)),
        "expired",
      );
    }

    const corrupt = database([
      [{ captureEnabled: true }],
      [{ headCursor: "3", minimumCursor: "0" }],
      [{ cursor: "1", kind: "upsert", ...itemRow(firstId) }, deleteRow("3", secondId)],
    ]);
    await expectReason(
      () =>
        new PostgresHostedWorkItemSyncStore(corrupt.connection).listChanges(workspace, {
          afterCursor: "0",
          throughCursor: "3",
          limit: 3,
        }),
      "corrupt",
    );
  });
});

describe("enableHostedWorkItemSyncCapture", () => {
  it("enables capture once under a row lock and is idempotent", async () => {
    const disabled = database([[{ captureEnabled: false }], [{ captureEnabled: true }]]);

    await expect(enableHostedWorkItemSyncCapture(disabled.connection)).resolves.toBeUndefined();
    expect(disabled.queries).toHaveLength(2);
    expect(disabled.queries[0]?.text).toContain("for update");
    expect(disabled.queries[1]?.text).toContain("set capture_enabled = true");

    const enabled = database([[{ captureEnabled: true }]]);
    await expect(enableHostedWorkItemSyncCapture(enabled.connection)).resolves.toBeUndefined();
    expect(enabled.queries).toHaveLength(1);
  });

  it("fails closed when the singleton is missing", async () => {
    const missing = database([[]]);

    await expectReason(() => enableHostedWorkItemSyncCapture(missing.connection), "corrupt");
  });
});

describe("purgeHostedWorkItemSyncChanges", () => {
  it("advances the floor before deleting one bounded contiguous expired prefix", async () => {
    const now = new Date("2026-07-18T12:00:00.000Z");
    const cutoff = new Date(now.getTime() - DEFAULT_HOSTED_WORK_ITEM_SYNC_MINIMUM_RETENTION_MS);
    const { connection, queries } = database([
      [{ workspaceId: workspace, headCursor: "5", minimumCursor: "1" }],
      [
        { cursor: "2", recordedAt: new Date(cutoff.getTime() - 2_000) },
        { cursor: "3", recordedAt: new Date(cutoff.getTime() - 1_000) },
        { cursor: "4", recordedAt: cutoff },
      ],
      [{ minimumCursor: "3" }],
      [{ cursor: "2" }, { cursor: "3" }],
    ]);

    await expect(purgeHostedWorkItemSyncChanges(connection, { now })).resolves.toEqual({
      cutoff,
      workspaceId: workspace,
      deletedChanges: 2,
      minimumCursor: "3",
    });

    expect(queries).toHaveLength(4);
    expect(queries[0]?.text).toContain("for update of state skip locked");
    expect(queries[0]?.text).toContain("order by state.updated_at, state.workspace_id");
    expect(queries[1]?.text).toContain("order by change.cursor");
    expect(queries[2]?.text).toContain("update hosted_work_item_sync_states");
    expect(queries[3]?.text).toContain("delete from hosted_work_item_sync_changes");
  });

  it.each([
    ["invalid date", { now: new Date(Number.NaN) }],
    [
      "retention below its safety floor",
      { now: new Date(), minimumRetentionMs: MIN_HOSTED_WORK_ITEM_SYNC_MINIMUM_RETENTION_MS - 1 },
    ],
    [
      "retention above its ceiling",
      { now: new Date(), minimumRetentionMs: MAX_HOSTED_WORK_ITEM_SYNC_MINIMUM_RETENTION_MS + 1 },
    ],
    ["an empty batch", { now: new Date(), batchSize: 0 }],
    [
      "an oversized batch",
      { now: new Date(), batchSize: MAX_HOSTED_WORK_ITEM_SYNC_PURGE_BATCH_SIZE + 1 },
    ],
  ])("rejects %s before opening a transaction", async (_name, options) => {
    const { connection, begin } = database([]);

    await expect(purgeHostedWorkItemSyncChanges(connection, options)).rejects.toBeInstanceOf(
      RangeError,
    );
    expect(begin).not.toHaveBeenCalled();
  });
});

describe("hosted work-item sync schema", () => {
  it("defines transactional state and immutable typed changes without redundant indexes", () => {
    expect(hostedWorkItemSyncChangeKind.enumValues).toEqual(["upsert", "delete"]);
    expect(getTableConfig(hostedWorkItemSyncCapability).checks.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "hosted_work_item_sync_capability_singleton",
        "hosted_work_item_sync_capability_lifecycle",
      ]),
    );
    expect(getTableConfig(hostedWorkItemSyncStates).checks.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "hosted_work_item_sync_states_head_nonnegative",
        "hosted_work_item_sync_states_minimum_nonnegative",
        "hosted_work_item_sync_states_range_valid",
      ]),
    );
    const changes = getTableConfig(hostedWorkItemSyncChanges);
    expect(changes.primaryKeys.map((key) => key.getName())).toContain(
      "hosted_work_item_sync_changes_pk",
    );
    expect(changes.indexes).toHaveLength(0);
    expect(changes.checks.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "hosted_work_item_sync_changes_cursor_positive",
        "hosted_work_item_sync_changes_planning_duration_positive",
        "hosted_work_item_sync_changes_shape_valid",
      ]),
    );
    expect(getTableConfig(workItems).checks.map(({ name }) => name)).toContain(
      "work_items_hosted_sync_cursor_nonnegative",
    );
  });

  it("migrates cursor capture, guarded retention, and zero-history backfill", () => {
    const migration = readFileSync(
      new URL("../drizzle/0041_hosted_work_item_sync.sql", import.meta.url),
      "utf8",
    );

    expect(migration).toContain("SELECT id, 0, 0, pg_catalog.clock_timestamp()");
    expect(migration).toContain("VALUES (true, false, NULL)");
    expect(migration).toContain("hosted_work_item_sync_capability_guard");
    expect(migration).toContain("FOR SHARE");
    expect(migration).toContain("CREATE FUNCTION public.capture_hosted_work_item_sync_change()");
    expect(migration).toContain("AFTER INSERT OR UPDATE OR DELETE ON public.work_items");
    expect(migration).toContain("SET hosted_sync_cursor = v_cursor");
    expect(migration).toContain("unexpected nested work item sync mutation");
    expect(migration).toContain("IF NEW IS NOT DISTINCT FROM OLD");
    expect(migration).toContain("work_items_hosted_sync_identity_immutable");
    expect(migration).toContain("hosted_work_item_sync_changes_append_only");
    expect(migration).toContain(
      "BEFORE INSERT OR UPDATE OR DELETE ON public.hosted_work_item_sync_changes",
    );
    expect(migration).toContain("minimum_cursor >= OLD.cursor");
    expect(migration).toContain("hosted_work_item_sync_states_write_guard");
    expect(migration).toContain("workspaces_initialize_hosted_sync_state");
    expect(migration).toContain("VALUES (NEW.id, 0, 0, pg_catalog.clock_timestamp())");
    expect(migration).toContain("NEW.head_cursor = OLD.head_cursor + 1");
    expect(migration).toContain("NEW.minimum_cursor > OLD.minimum_cursor");
    expect(migration).toContain("pg_catalog.clock_timestamp() - INTERVAL '30 days'");
    expect(migration).toContain("pg_catalog.pg_trigger_depth() > 1");
    expect(migration).toContain("hosted_work_item_sync_states_delete_guard");
    expect(migration.match(/SECURITY INVOKER/gu)).toHaveLength(6);
    expect(migration.match(/SET search_path = pg_catalog/gu)).toHaveLength(6);
    expect(migration).not.toContain('CREATE INDEX "hosted_work_item_sync_changes_');
    expect(migration).not.toMatch(
      /INSERT INTO public\.hosted_work_item_sync_changes[\s\S]*SELECT[\s\S]*FROM public\.work_items/u,
    );
  });
});
