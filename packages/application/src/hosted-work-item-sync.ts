import {
  isValidLocalDate,
  maximumWorkItemVersion,
  workItemPriorities,
  workItemStatuses,
  type WorkItem,
  type WorkItemId,
  type WorkspaceId,
} from "@schedule/domain";

export type HostedWorkItemSyncCursor = string;

export const defaultHostedWorkItemSyncPageSize = 100;
export const maximumHostedWorkItemSyncPageSize = 200;
export const maximumHostedWorkItemSyncCursor = "9223372036854775807";

export type HostedWorkItemSyncStoreErrorReason = "invalid" | "expired" | "corrupt";

const storeErrorMessages: Readonly<Record<HostedWorkItemSyncStoreErrorReason, string>> = {
  invalid: "The hosted work-item sync position is invalid.",
  expired: "The hosted work-item sync position has expired.",
  corrupt: "The hosted work-item sync page could not be verified.",
};

/** Stable failure vocabulary shared by sync stores and their callers. */
export class HostedWorkItemSyncStoreError extends Error {
  constructor(
    readonly reason: HostedWorkItemSyncStoreErrorReason,
    options?: ErrorOptions,
  ) {
    super(storeErrorMessages[reason], options);
    this.name = "HostedWorkItemSyncStoreError";
  }
}

export interface HostedWorkItemSyncBootstrapOptions {
  readonly checkpoint?: HostedWorkItemSyncCursor;
  readonly afterId?: WorkItemId;
  readonly limit: number;
}

export interface HostedWorkItemSyncBootstrapPage {
  readonly items: readonly WorkItem[];
  readonly checkpoint: HostedWorkItemSyncCursor;
  readonly nextAfterId: WorkItemId | null;
}

export type HostedWorkItemSyncChange =
  | {
      readonly type: "upsert";
      readonly cursor: HostedWorkItemSyncCursor;
      readonly item: WorkItem;
    }
  | {
      readonly type: "delete";
      readonly cursor: HostedWorkItemSyncCursor;
      readonly workItemId: WorkItemId;
    };

export interface HostedWorkItemSyncChangeOptions {
  readonly afterCursor: HostedWorkItemSyncCursor;
  readonly throughCursor?: HostedWorkItemSyncCursor;
  readonly limit: number;
}

export interface HostedWorkItemSyncChangePage {
  readonly changes: readonly HostedWorkItemSyncChange[];
  readonly throughCursor: HostedWorkItemSyncCursor;
  readonly nextAfterCursor: HostedWorkItemSyncCursor | null;
}

export interface HostedWorkItemSyncStore {
  bootstrap(
    workspaceId: WorkspaceId,
    options: HostedWorkItemSyncBootstrapOptions,
  ): Promise<HostedWorkItemSyncBootstrapPage>;
  listChanges(
    workspaceId: WorkspaceId,
    options: HostedWorkItemSyncChangeOptions,
  ): Promise<HostedWorkItemSyncChangePage>;
}

export interface BootstrapHostedWorkItemsQuery {
  readonly workspaceId: WorkspaceId;
  readonly checkpoint?: HostedWorkItemSyncCursor;
  readonly afterId?: WorkItemId;
  readonly limit?: number;
}

export interface ListHostedWorkItemChangesQuery {
  readonly workspaceId: WorkspaceId;
  readonly afterCursor: HostedWorkItemSyncCursor;
  readonly throughCursor?: HostedWorkItemSyncCursor;
  readonly limit?: number;
}

export function isCanonicalHostedWorkItemSyncCursor(
  value: unknown,
): value is HostedWorkItemSyncCursor {
  return (
    typeof value === "string" &&
    /^(0|[1-9]\d{0,18})$/u.test(value) &&
    (value.length < maximumHostedWorkItemSyncCursor.length ||
      value <= maximumHostedWorkItemSyncCursor)
  );
}

function compareCursors(left: HostedWorkItemSyncCursor, right: HostedWorkItemSyncCursor): number {
  return left.length === right.length ? left.localeCompare(right) : left.length - right.length;
}

function storeError(reason: HostedWorkItemSyncStoreErrorReason, cause?: unknown): never {
  throw new HostedWorkItemSyncStoreError(reason, cause === undefined ? undefined : { cause });
}

function validatedLimit(value: number | undefined): number {
  const limit = value ?? defaultHostedWorkItemSyncPageSize;
  if (!Number.isInteger(limit) || limit < 1 || limit > maximumHostedWorkItemSyncPageSize) {
    storeError("invalid");
  }
  return limit;
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

const workItemKeys = [
  "id",
  "workspaceId",
  "parentWorkItemId",
  "title",
  "description",
  "status",
  "priority",
  "dueOn",
  "planningDurationMinutes",
  "version",
  "createdAt",
  "updatedAt",
] as const;

function isValidWorkItem(value: unknown, workspaceId: WorkspaceId): value is WorkItem {
  if (!isRecord(value) || !hasExactKeys(value, workItemKeys)) return false;
  const createdAt = value.createdAt;
  const updatedAt = value.updatedAt;
  return (
    validId(value.id) &&
    value.workspaceId === workspaceId &&
    (value.parentWorkItemId === null || validId(value.parentWorkItemId)) &&
    (value.parentWorkItemId === null ||
      value.parentWorkItemId.toLowerCase() !== value.id.toLowerCase()) &&
    typeof value.title === "string" &&
    value.title.length > 0 &&
    value.title.length <= 240 &&
    value.title === value.title.trim() &&
    (value.description === null ||
      (typeof value.description === "string" &&
        value.description.length > 0 &&
        value.description.length <= 4_000 &&
        value.description === value.description.trim())) &&
    workItemStatuses.some((status) => status === value.status) &&
    workItemPriorities.some((priority) => priority === value.priority) &&
    (value.dueOn === null || (typeof value.dueOn === "string" && isValidLocalDate(value.dueOn))) &&
    (value.planningDurationMinutes === null ||
      (Number.isInteger(value.planningDurationMinutes) &&
        (value.planningDurationMinutes as number) > 0)) &&
    Number.isInteger(value.version) &&
    (value.version as number) >= 1 &&
    (value.version as number) <= maximumWorkItemVersion &&
    createdAt instanceof Date &&
    Number.isFinite(createdAt.getTime()) &&
    updatedAt instanceof Date &&
    Number.isFinite(updatedAt.getTime())
  );
}

async function callStore<Result>(operation: () => Promise<Result>): Promise<Result> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof HostedWorkItemSyncStoreError) throw error;
    storeError("corrupt", error);
  }
}

function validateBootstrapPage(
  value: unknown,
  query: BootstrapHostedWorkItemsQuery,
  limit: number,
): asserts value is HostedWorkItemSyncBootstrapPage {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["items", "checkpoint", "nextAfterId"]) ||
    !Array.isArray(value.items) ||
    value.items.length > limit ||
    !isCanonicalHostedWorkItemSyncCursor(value.checkpoint) ||
    (query.checkpoint !== undefined && value.checkpoint !== query.checkpoint) ||
    (value.nextAfterId !== null && !validId(value.nextAfterId))
  ) {
    storeError("corrupt");
  }

  let previousId = query.afterId;
  for (const item of value.items) {
    if (
      !isValidWorkItem(item, query.workspaceId) ||
      (previousId !== undefined && item.id <= previousId)
    ) {
      storeError("corrupt");
    }
    previousId = item.id;
  }

  if (
    value.nextAfterId !== null &&
    (value.items.length === 0 || value.nextAfterId !== value.items.at(-1)?.id)
  ) {
    storeError("corrupt");
  }
}

function isValidChange(
  value: unknown,
  workspaceId: WorkspaceId,
): value is HostedWorkItemSyncChange {
  if (!isRecord(value) || !isCanonicalHostedWorkItemSyncCursor(value.cursor)) return false;
  if (value.type === "upsert") {
    return (
      hasExactKeys(value, ["type", "cursor", "item"]) && isValidWorkItem(value.item, workspaceId)
    );
  }
  return (
    value.type === "delete" &&
    hasExactKeys(value, ["type", "cursor", "workItemId"]) &&
    validId(value.workItemId)
  );
}

function validateChangePage(
  value: unknown,
  query: ListHostedWorkItemChangesQuery,
  limit: number,
): asserts value is HostedWorkItemSyncChangePage {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["changes", "throughCursor", "nextAfterCursor"]) ||
    !Array.isArray(value.changes) ||
    value.changes.length > limit ||
    !isCanonicalHostedWorkItemSyncCursor(value.throughCursor) ||
    compareCursors(value.throughCursor, query.afterCursor) < 0 ||
    (query.throughCursor !== undefined && value.throughCursor !== query.throughCursor) ||
    (value.nextAfterCursor !== null && !isCanonicalHostedWorkItemSyncCursor(value.nextAfterCursor))
  ) {
    storeError("corrupt");
  }

  let previousCursor = query.afterCursor;
  for (const change of value.changes) {
    if (
      !isValidChange(change, query.workspaceId) ||
      change.cursor !== (BigInt(previousCursor) + 1n).toString() ||
      compareCursors(change.cursor, value.throughCursor) > 0
    ) {
      storeError("corrupt");
    }
    previousCursor = change.cursor;
  }

  if (
    value.nextAfterCursor === null
      ? previousCursor !== value.throughCursor
      : value.changes.length === 0 ||
        value.nextAfterCursor !== previousCursor ||
        compareCursors(value.nextAfterCursor, value.throughCursor) >= 0
  ) {
    storeError("corrupt");
  }
}

export class BootstrapHostedWorkItems {
  constructor(private readonly store: HostedWorkItemSyncStore) {}

  async execute(query: BootstrapHostedWorkItemsQuery): Promise<HostedWorkItemSyncBootstrapPage> {
    const limit = validatedLimit(query.limit);
    if (
      (query.checkpoint !== undefined && !isCanonicalHostedWorkItemSyncCursor(query.checkpoint)) ||
      (query.afterId !== undefined && !validId(query.afterId)) ||
      (query.afterId !== undefined && query.checkpoint === undefined)
    ) {
      storeError("invalid");
    }

    const page: unknown = await callStore(() =>
      this.store.bootstrap(query.workspaceId, {
        ...(query.checkpoint === undefined ? {} : { checkpoint: query.checkpoint }),
        ...(query.afterId === undefined ? {} : { afterId: query.afterId }),
        limit,
      }),
    );
    validateBootstrapPage(page, query, limit);
    return page;
  }
}

export class ListHostedWorkItemChanges {
  constructor(private readonly store: HostedWorkItemSyncStore) {}

  async execute(query: ListHostedWorkItemChangesQuery): Promise<HostedWorkItemSyncChangePage> {
    const limit = validatedLimit(query.limit);
    if (
      !isCanonicalHostedWorkItemSyncCursor(query.afterCursor) ||
      (query.throughCursor !== undefined &&
        (!isCanonicalHostedWorkItemSyncCursor(query.throughCursor) ||
          compareCursors(query.throughCursor, query.afterCursor) < 0))
    ) {
      storeError("invalid");
    }

    const page: unknown = await callStore(() =>
      this.store.listChanges(query.workspaceId, {
        afterCursor: query.afterCursor,
        ...(query.throughCursor === undefined ? {} : { throughCursor: query.throughCursor }),
        limit,
      }),
    );
    validateChangePage(page, query, limit);
    return page;
  }
}
