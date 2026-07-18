import {
  HostedWorkItemSyncStoreError,
  type HostedWorkItemSyncBootstrapPage,
  type HostedWorkItemSyncChange,
  type HostedWorkItemSyncChangePage,
  type HostedWorkItemSyncStore,
} from "@schedule/application";
import {
  localDate,
  maximumWorkItemVersion,
  workItemId,
  workspaceId,
  workItemPriorities,
  workItemStatuses,
  type WorkItem,
  type WorkItemId,
  type WorkspaceId,
} from "@schedule/domain";

import type { DatabaseConnection } from "./database.js";

const CURSOR_MAX = 9_223_372_036_854_775_807n;
const cursorPattern = /^(0|[1-9]\d{0,18})$/u;
const canonicalUuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const DAY_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_HOSTED_WORK_ITEM_SYNC_MINIMUM_RETENTION_MS = 90 * DAY_MS;
export const MIN_HOSTED_WORK_ITEM_SYNC_MINIMUM_RETENTION_MS = 30 * DAY_MS;
export const MAX_HOSTED_WORK_ITEM_SYNC_MINIMUM_RETENTION_MS = 3_650 * DAY_MS;
export const DEFAULT_HOSTED_WORK_ITEM_SYNC_PURGE_BATCH_SIZE = 250;
export const MAX_HOSTED_WORK_ITEM_SYNC_PURGE_BATCH_SIZE = 1_000;

interface SyncStateRow {
  readonly headCursor: string;
  readonly minimumCursor: string;
}

interface SyncCapabilityRow {
  readonly captureEnabled: boolean;
}

interface WorkItemRow {
  readonly id: string;
  readonly parentWorkItemId: string | null;
  readonly title: string;
  readonly description: string | null;
  readonly status: WorkItem["status"];
  readonly priority: WorkItem["priority"];
  readonly planningDurationMinutes: number | null;
  readonly dueOn: string | null;
  readonly version: number;
  readonly createdAt: string | Date;
  readonly updatedAt: string | Date;
}

interface SyncChangeRow {
  readonly cursor: string;
  readonly kind: string;
  readonly id: string;
  readonly parentWorkItemId: string | null;
  readonly title: string | null;
  readonly description: string | null;
  readonly status: WorkItem["status"] | null;
  readonly priority: WorkItem["priority"] | null;
  readonly planningDurationMinutes: number | null;
  readonly dueOn: string | null;
  readonly version: number | null;
  readonly createdAt: string | Date | null;
  readonly updatedAt: string | Date | null;
}

function syncError(reason: "invalid" | "expired" | "corrupt"): HostedWorkItemSyncStoreError {
  return new HostedWorkItemSyncStoreError(reason);
}

function parseInputCursor(value: string): bigint {
  if (!cursorPattern.test(value)) throw syncError("invalid");
  const parsed = BigInt(value);
  if (parsed > CURSOR_MAX) throw syncError("invalid");
  return parsed;
}

function parseStoredCursor(value: string): bigint {
  try {
    if (!cursorPattern.test(value)) throw new Error();
    const parsed = BigInt(value);
    if (parsed > CURSOR_MAX) throw new Error();
    return parsed;
  } catch {
    throw syncError("corrupt");
  }
}

function requireLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw syncError("invalid");
}

function requireCanonicalWorkItemId(value: WorkItemId): void {
  if (!canonicalUuidPattern.test(value)) throw syncError("invalid");
}

function validDate(value: string | Date): Date | null {
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function mapWorkItem(row: WorkItemRow, workspace: WorkspaceId): WorkItem {
  const createdAt = validDate(row.createdAt);
  const updatedAt = validDate(row.updatedAt);
  if (
    !canonicalUuidPattern.test(row.id) ||
    (row.parentWorkItemId !== null && !canonicalUuidPattern.test(row.parentWorkItemId)) ||
    (row.parentWorkItemId !== null && row.parentWorkItemId === row.id) ||
    typeof row.title !== "string" ||
    row.title.length < 1 ||
    row.title.length > 240 ||
    row.title !== row.title.trim() ||
    (row.description !== null &&
      (typeof row.description !== "string" ||
        row.description.length < 1 ||
        row.description.length > 4_000 ||
        row.description !== row.description.trim())) ||
    !workItemStatuses.includes(row.status) ||
    !workItemPriorities.includes(row.priority) ||
    (row.planningDurationMinutes !== null &&
      (!Number.isSafeInteger(row.planningDurationMinutes) || row.planningDurationMinutes < 1)) ||
    !Number.isSafeInteger(row.version) ||
    row.version < 1 ||
    row.version > maximumWorkItemVersion ||
    createdAt === null ||
    updatedAt === null
  ) {
    throw syncError("corrupt");
  }
  let dueOn: WorkItem["dueOn"];
  try {
    dueOn = row.dueOn === null ? null : localDate(row.dueOn);
  } catch {
    throw syncError("corrupt");
  }
  return {
    id: workItemId(row.id),
    workspaceId: workspaceId(workspace),
    parentWorkItemId: row.parentWorkItemId === null ? null : workItemId(row.parentWorkItemId),
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    planningDurationMinutes: row.planningDurationMinutes,
    dueOn,
    version: row.version,
    createdAt,
    updatedAt,
  };
}

function mapUpsert(row: SyncChangeRow, workspace: WorkspaceId): WorkItem {
  if (
    row.title === null ||
    row.status === null ||
    row.priority === null ||
    row.version === null ||
    row.createdAt === null ||
    row.updatedAt === null
  ) {
    throw syncError("corrupt");
  }
  return mapWorkItem(
    {
      ...row,
      title: row.title,
      status: row.status,
      priority: row.priority,
      version: row.version,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
    workspace,
  );
}

function stateCursors(row: SyncStateRow | undefined): {
  readonly head: bigint;
  readonly minimum: bigint;
} {
  if (row === undefined) throw syncError("corrupt");
  const head = parseStoredCursor(row.headCursor);
  const minimum = parseStoredCursor(row.minimumCursor);
  if (minimum > head) throw syncError("corrupt");
  return { head, minimum };
}

function requireCaptureEnabled(row: SyncCapabilityRow | undefined): void {
  if (row?.captureEnabled !== true) throw syncError("corrupt");
}

/** Irreversibly enables capture after fencing all pre-enrollment work-item mutations. */
export async function enableHostedWorkItemSyncCapture(
  connection: DatabaseConnection,
): Promise<void> {
  await connection.sql.begin(async (transaction) => {
    const [capability] = await transaction<SyncCapabilityRow[]>`
      select capture_enabled as "captureEnabled"
      from hosted_work_item_sync_capability
      where singleton
      for update
    `;
    if (capability === undefined || typeof capability.captureEnabled !== "boolean") {
      throw syncError("corrupt");
    }
    if (capability.captureEnabled) return;
    const updated = await transaction<SyncCapabilityRow[]>`
      update hosted_work_item_sync_capability
      set capture_enabled = true, enabled_at = clock_timestamp()
      where singleton and not capture_enabled
      returning capture_enabled as "captureEnabled"
    `;
    if (updated.length !== 1 || updated[0]?.captureEnabled !== true) throw syncError("corrupt");
  });
}

/** PostgreSQL-backed current-state bootstrap and immutable delta pages. */
export class PostgresHostedWorkItemSyncStore implements HostedWorkItemSyncStore {
  constructor(private readonly connection: DatabaseConnection) {}

  bootstrap(
    workspace: WorkspaceId,
    input: { readonly checkpoint?: string; readonly afterId?: WorkItemId; readonly limit: number },
  ): Promise<HostedWorkItemSyncBootstrapPage> {
    requireLimit(input.limit);
    const requestedCheckpoint =
      input.checkpoint === undefined ? undefined : parseInputCursor(input.checkpoint);
    if (input.afterId !== undefined) {
      requireCanonicalWorkItemId(input.afterId);
      if (input.checkpoint === undefined) throw syncError("invalid");
    }
    return this.connection.sql.begin(
      "isolation level repeatable read read only",
      async (transaction) => {
        const [capability] = await transaction<SyncCapabilityRow[]>`
        select capture_enabled as "captureEnabled"
        from hosted_work_item_sync_capability
        where singleton
      `;
        requireCaptureEnabled(capability);
        const [state] = await transaction<SyncStateRow[]>`
        select head_cursor::text as "headCursor", minimum_cursor::text as "minimumCursor"
        from hosted_work_item_sync_states
        where workspace_id = ${workspace}
      `;
        const { head, minimum } = stateCursors(state);
        const checkpoint = requestedCheckpoint ?? head;
        if (checkpoint < minimum) throw syncError("expired");
        if (checkpoint > head) throw syncError("expired");

        const rows = await transaction<WorkItemRow[]>`
        select item.id::text, item.parent_work_item_id::text as "parentWorkItemId",
          item.title, item.description, item.status::text, item.priority::text,
          item.planning_duration_minutes as "planningDurationMinutes",
          item.due_on::text as "dueOn", item.version,
          item.created_at as "createdAt", item.updated_at as "updatedAt"
        from work_items as item
        where item.workspace_id = ${workspace}
          and item.hosted_sync_cursor <= ${checkpoint.toString()}::bigint
          and (${input.afterId ?? null}::uuid is null or item.id > ${input.afterId ?? null}::uuid)
        order by item.id
        limit ${input.limit + 1}
      `;
        const pageRows = rows.slice(0, input.limit);
        const items = pageRows.map((row) => mapWorkItem(row, workspace));
        return {
          items,
          checkpoint: checkpoint.toString(),
          nextAfterId: rows.length > input.limit ? (items.at(-1)?.id ?? null) : null,
        };
      },
    );
  }

  listChanges(
    workspace: WorkspaceId,
    input: {
      readonly afterCursor: string;
      readonly throughCursor?: string;
      readonly limit: number;
    },
  ): Promise<HostedWorkItemSyncChangePage> {
    requireLimit(input.limit);
    const after = parseInputCursor(input.afterCursor);
    const requestedThrough =
      input.throughCursor === undefined ? undefined : parseInputCursor(input.throughCursor);
    if (requestedThrough !== undefined && requestedThrough < after) throw syncError("invalid");
    return this.connection.sql.begin(
      "isolation level repeatable read read only",
      async (transaction) => {
        const [capability] = await transaction<SyncCapabilityRow[]>`
        select capture_enabled as "captureEnabled"
        from hosted_work_item_sync_capability
        where singleton
      `;
        requireCaptureEnabled(capability);
        const [state] = await transaction<SyncStateRow[]>`
        select head_cursor::text as "headCursor", minimum_cursor::text as "minimumCursor"
        from hosted_work_item_sync_states
        where workspace_id = ${workspace}
      `;
        const { head, minimum } = stateCursors(state);
        if (after < minimum) throw syncError("expired");
        if (after > head) throw syncError("expired");
        const through = requestedThrough ?? head;
        if (through > head) throw syncError("expired");

        const rows = await transaction<SyncChangeRow[]>`
        select cursor::text, kind::text, work_item_id::text as id,
          parent_work_item_id::text as "parentWorkItemId", title, description,
          status::text, priority::text,
          planning_duration_minutes as "planningDurationMinutes", due_on::text as "dueOn",
          version, item_created_at as "createdAt", item_updated_at as "updatedAt"
        from hosted_work_item_sync_changes as change
        where change.workspace_id = ${workspace}
          and change.cursor > ${after.toString()}::bigint
          and change.cursor <= ${through.toString()}::bigint
        order by change.cursor
        limit ${input.limit + 1}
      `;

        let expected = after + 1n;
        const changes: HostedWorkItemSyncChange[] = [];
        for (const row of rows) {
          const cursor = parseStoredCursor(row.cursor);
          if (cursor !== expected) throw syncError("corrupt");
          expected += 1n;
          if (changes.length === input.limit) continue;
          if (row.kind === "delete") {
            if (
              row.parentWorkItemId !== null ||
              row.title !== null ||
              row.description !== null ||
              row.status !== null ||
              row.priority !== null ||
              row.planningDurationMinutes !== null ||
              row.dueOn !== null ||
              row.version !== null ||
              row.createdAt !== null ||
              row.updatedAt !== null ||
              !canonicalUuidPattern.test(row.id)
            ) {
              throw syncError("corrupt");
            }
            changes.push({ type: "delete", cursor: row.cursor, workItemId: workItemId(row.id) });
          } else if (row.kind === "upsert") {
            changes.push({ type: "upsert", cursor: row.cursor, item: mapUpsert(row, workspace) });
          } else {
            throw syncError("corrupt");
          }
        }
        const lastStoredCursor = rows.length === 0 ? after : parseStoredCursor(rows.at(-1)!.cursor);
        if (rows.length <= input.limit && lastStoredCursor !== through) throw syncError("corrupt");
        return {
          changes,
          throughCursor: through.toString(),
          nextAfterCursor: rows.length > input.limit ? (changes.at(-1)?.cursor ?? null) : null,
        };
      },
    );
  }
}

export interface PurgeHostedWorkItemSyncChangesOptions {
  readonly now: Date;
  readonly minimumRetentionMs?: number;
  readonly batchSize?: number;
}

export interface PurgeHostedWorkItemSyncChangesResult {
  readonly cutoff: Date;
  readonly workspaceId: string | null;
  readonly deletedChanges: number;
  readonly minimumCursor: string | null;
}

function boundedInteger(value: number, minimum: number, maximum: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
}

/** Deletes one bounded, contiguous expired prefix and advances its workspace floor atomically. */
export async function purgeHostedWorkItemSyncChanges(
  connection: DatabaseConnection,
  options: PurgeHostedWorkItemSyncChangesOptions,
): Promise<PurgeHostedWorkItemSyncChangesResult> {
  if (!(options.now instanceof Date) || !Number.isFinite(options.now.getTime())) {
    throw new RangeError("now must be a valid Date.");
  }
  const minimumRetentionMs =
    options.minimumRetentionMs ?? DEFAULT_HOSTED_WORK_ITEM_SYNC_MINIMUM_RETENTION_MS;
  const batchSize = options.batchSize ?? DEFAULT_HOSTED_WORK_ITEM_SYNC_PURGE_BATCH_SIZE;
  boundedInteger(
    minimumRetentionMs,
    MIN_HOSTED_WORK_ITEM_SYNC_MINIMUM_RETENTION_MS,
    MAX_HOSTED_WORK_ITEM_SYNC_MINIMUM_RETENTION_MS,
    "minimumRetentionMs",
  );
  boundedInteger(batchSize, 1, MAX_HOSTED_WORK_ITEM_SYNC_PURGE_BATCH_SIZE, "batchSize");
  const cutoff = new Date(options.now.getTime() - minimumRetentionMs);
  if (!Number.isFinite(cutoff.getTime())) throw new RangeError("Retention cutoff is invalid.");

  return connection.sql.begin(async (transaction) => {
    const [state] = await transaction<
      { workspaceId: string; headCursor: string; minimumCursor: string }[]
    >`
      select state.workspace_id::text as "workspaceId", state.head_cursor::text as "headCursor",
        state.minimum_cursor::text as "minimumCursor"
      from hosted_work_item_sync_states as state
      where exists (
        select 1 from hosted_work_item_sync_changes as change
        where change.workspace_id = state.workspace_id
          and change.cursor = state.minimum_cursor + 1
          and change.recorded_at < ${cutoff.toISOString()}::timestamptz
      )
      order by state.updated_at, state.workspace_id
      for update of state skip locked
      limit 1
    `;
    if (state === undefined) {
      return { cutoff, workspaceId: null, deletedChanges: 0, minimumCursor: null };
    }
    const head = parseStoredCursor(state.headCursor);
    const minimum = parseStoredCursor(state.minimumCursor);
    if (minimum > head) throw syncError("corrupt");
    const rows = await transaction<{ cursor: string; recordedAt: string | Date }[]>`
      select cursor::text, recorded_at as "recordedAt"
      from hosted_work_item_sync_changes as change
      where change.workspace_id = ${state.workspaceId}
        and change.cursor > ${minimum.toString()}::bigint
      order by change.cursor
      for update
      limit ${batchSize}
    `;
    let expected = minimum + 1n;
    let lastExpired: bigint | null = null;
    for (const row of rows) {
      const cursor = parseStoredCursor(row.cursor);
      if (cursor !== expected) throw syncError("corrupt");
      expected += 1n;
      const recordedAt = validDate(row.recordedAt);
      if (recordedAt === null) throw syncError("corrupt");
      if (recordedAt >= cutoff) break;
      lastExpired = cursor;
    }
    if (lastExpired === null) throw syncError("corrupt");

    const expectedCount = Number(lastExpired - minimum);
    const updated = await transaction<{ minimumCursor: string }[]>`
      update hosted_work_item_sync_states
      set minimum_cursor = ${lastExpired.toString()}::bigint, updated_at = clock_timestamp()
      where workspace_id = ${state.workspaceId}
        and minimum_cursor = ${minimum.toString()}::bigint
        and head_cursor = ${head.toString()}::bigint
      returning minimum_cursor::text as "minimumCursor"
    `;
    if (updated.length !== 1) throw syncError("corrupt");
    const deleted = await transaction<{ cursor: string }[]>`
      delete from hosted_work_item_sync_changes
      where workspace_id = ${state.workspaceId}
        and cursor > ${minimum.toString()}::bigint
        and cursor <= ${lastExpired.toString()}::bigint
      returning cursor::text
    `;
    if (deleted.length !== expectedCount) throw syncError("corrupt");
    return {
      cutoff,
      workspaceId: state.workspaceId,
      deletedChanges: deleted.length,
      minimumCursor: updated[0]!.minimumCursor,
    };
  });
}
