import type {
  ActivityPage,
  CurrentDailyPlan,
  DailyPlan,
  GeneratePlanInput,
  Page,
  PlanItemActivityState,
  PlanSettings,
  Routine,
  RoutineDurationInsight,
  RoutinePlanningFeedbackSuppressionKind,
  RoutineStatus,
  ScheduleBlock,
  WorkItem,
  WorkItemPriority,
  WorkItemStatus,
  Workspace,
} from "./types";

interface RequestOptions {
  readonly method?: "GET" | "POST" | "PATCH" | "DELETE";
  readonly json?: unknown;
  readonly idempotencyKey?: string;
  readonly signal?: AbortSignal;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId: string | null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<Result>(path: string, options: RequestOptions = {}): Promise<Result> {
  const headers = new Headers({ Accept: "application/json" });
  if (options.json !== undefined) headers.set("Content-Type", "application/json");
  if (options.idempotencyKey !== undefined) {
    headers.set("Idempotency-Key", options.idempotencyKey);
  }
  const response = await fetch(path, {
    method: options.method ?? "GET",
    headers,
    ...(options.json === undefined ? {} : { body: JSON.stringify(options.json) }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (!response.ok) {
    const fallback = {
      error: { code: "request.failed", message: `Request failed with status ${response.status}.` },
      requestId: null,
    };
    const body = (await response.json().catch(() => fallback)) as {
      error?: { code?: string; message?: string };
      requestId?: string | null;
    };
    throw new ApiError(
      response.status,
      body.error?.code ?? fallback.error.code,
      body.error?.message ?? fallback.error.message,
      body.requestId ?? null,
    );
  }
  if (response.status === 204) return undefined as Result;
  return (await response.json()) as Result;
}

function queryPath(
  path: string,
  values: Readonly<Record<string, string | number | undefined>>,
): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) query.set(key, String(value));
  }
  const suffix = query.toString();
  return suffix.length === 0 ? path : `${path}?${suffix}`;
}

function workspacePath(workspaceId: string, suffix: string): string {
  return `/v1/workspaces/${encodeURIComponent(workspaceId)}${suffix}`;
}

const OFFSET_PAGE_LIMIT = 200;
const MAX_OFFSET_PAGES = 1_000;
const PAGINATION_CHANGED_MESSAGE =
  "The collection changed while it was loading. Refresh and try again.";

interface OffsetPass<Item> {
  readonly items: Item[];
  readonly pagesRead: number;
}

async function readOffsetPass<Item extends { readonly id: string }>(
  path: string,
  values: Readonly<Record<string, string | number | undefined>>,
  signal?: AbortSignal,
): Promise<OffsetPass<Item>> {
  const items: Item[] = [];
  const seenIds = new Set<string>();
  const seenPages = new Set<string>();
  let offset = 0;

  for (let pageNumber = 0; pageNumber < MAX_OFFSET_PAGES; pageNumber += 1) {
    const page = await request<Page<Item>>(
      queryPath(path, { ...values, limit: OFFSET_PAGE_LIMIT, offset }),
      signal === undefined ? {} : { signal },
    );
    const pageSignature = JSON.stringify(page.items.map((item) => item.id));
    const repeatedPage = seenPages.has(pageSignature);
    seenPages.add(pageSignature);

    let newItemCount = 0;
    for (const item of page.items) {
      if (seenIds.has(item.id)) continue;
      seenIds.add(item.id);
      items.push(item);
      newItemCount += 1;
    }

    const nextOffset = offset + page.items.length;
    if (page.items.length === 0) return { items, pagesRead: pageNumber + 1 };
    if (repeatedPage || newItemCount === 0 || nextOffset <= offset) {
      throw new Error(PAGINATION_CHANGED_MESSAGE);
    }
    if (page.items.length < page.page.limit) {
      return { items, pagesRead: pageNumber + 1 };
    }
    offset = nextOffset;
  }

  throw new Error("The collection is too large to load safely. Narrow the result and try again.");
}

function sameItemOrder<Item extends { readonly id: string }>(
  first: readonly Item[],
  second: readonly Item[],
): boolean {
  return (
    first.length === second.length && first.every((item, index) => item.id === second[index]?.id)
  );
}

async function listAllOffsetPages<Item extends { readonly id: string }>(
  path: string,
  values: Readonly<Record<string, string | number | undefined>>,
  signal?: AbortSignal,
): Promise<Page<Item>> {
  const first = await readOffsetPass<Item>(path, values, signal);
  if (first.pagesRead === 1) {
    return { items: first.items, page: { limit: OFFSET_PAGE_LIMIT, offset: 0 } };
  }

  // Offset pagination has no server snapshot. Require two identical traversals
  // before treating a multi-page collection as authoritative.
  const confirmed = await readOffsetPass<Item>(path, values, signal);
  if (!sameItemOrder(first.items, confirmed.items)) throw new Error(PAGINATION_CHANGED_MESSAGE);
  return { items: confirmed.items, page: { limit: OFFSET_PAGE_LIMIT, offset: 0 } };
}

export function newIdempotencyKey(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `local-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export const api = {
  listWorkspaces: (signal?: AbortSignal) =>
    request<Page<Workspace>>(
      queryPath("/v1/workspaces", { limit: 20, offset: 0 }),
      signal === undefined ? {} : { signal },
    ),

  createWorkspace: (name: string) =>
    request<Workspace>("/v1/workspaces", { method: "POST", json: { name } }),

  listWorkItems: (
    workspaceId: string,
    filters: { status?: WorkItemStatus; priority?: WorkItemPriority } = {},
    signal?: AbortSignal,
  ) =>
    listAllOffsetPages<WorkItem>(
      workspacePath(workspaceId, "/work-items"),
      { status: filters.status, priority: filters.priority },
      signal,
    ),

  getWorkItem: (workspaceId: string, itemId: string, signal?: AbortSignal) =>
    request<WorkItem>(
      workspacePath(workspaceId, `/work-items/${encodeURIComponent(itemId)}`),
      signal === undefined ? {} : { signal },
    ),

  createWorkItem: (
    workspaceId: string,
    input: {
      title: string;
      description: string | null;
      status: WorkItemStatus;
      priority: WorkItemPriority;
      dueOn: string | null;
      planningDurationMinutes: number | null;
    },
  ) =>
    request<WorkItem>(workspacePath(workspaceId, "/work-items"), {
      method: "POST",
      json: input,
    }),

  updateWorkItem: (
    workspaceId: string,
    itemId: string,
    input: {
      expectedVersion: number;
      title?: string;
      description?: string | null;
      status?: WorkItemStatus;
      priority?: WorkItemPriority;
      dueOn?: string | null;
      planningDurationMinutes?: number | null;
    },
  ) =>
    request<WorkItem>(workspacePath(workspaceId, `/work-items/${encodeURIComponent(itemId)}`), {
      method: "PATCH",
      json: input,
    }),

  listRoutines: (workspaceId: string, status?: RoutineStatus, signal?: AbortSignal) =>
    listAllOffsetPages<Routine>(workspacePath(workspaceId, "/routines"), { status }, signal),

  getRoutine: (workspaceId: string, routineId: string, signal?: AbortSignal) =>
    request<Routine>(
      workspacePath(workspaceId, `/routines/${encodeURIComponent(routineId)}`),
      signal === undefined ? {} : { signal },
    ),

  getRoutineDurationInsight: (workspaceId: string, routineId: string, signal?: AbortSignal) =>
    request<RoutineDurationInsight>(
      workspacePath(workspaceId, `/routines/${encodeURIComponent(routineId)}/duration-insight`),
      signal === undefined ? {} : { signal },
    ),

  approveRoutineDurationInsight: (
    workspaceId: string,
    routineId: string,
    input: { readonly expectedVersion: number; readonly duration: Routine["duration"] },
  ) =>
    request<Routine>(
      workspacePath(
        workspaceId,
        `/routines/${encodeURIComponent(routineId)}/duration-insight/approve`,
      ),
      { method: "POST", json: input },
    ),

  createRoutine: (
    workspaceId: string,
    input: Omit<Routine, "id" | "workspaceId" | "version" | "createdAt" | "updatedAt">,
  ) =>
    request<Routine>(workspacePath(workspaceId, "/routines"), {
      method: "POST",
      json: input,
    }),

  updateRoutine: (
    workspaceId: string,
    routineId: string,
    input: {
      expectedVersion: number;
      title?: string;
      description?: string | null;
      status?: RoutineStatus;
      tags?: Routine["tags"];
      duration?: Routine["duration"];
      cadence?: Routine["cadence"];
    },
  ) =>
    request<Routine>(workspacePath(workspaceId, `/routines/${encodeURIComponent(routineId)}`), {
      method: "PATCH",
      json: input,
    }),

  listRoutineActivity: (
    workspaceId: string,
    routineId: string,
    cursor?: string,
    signal?: AbortSignal,
  ) =>
    request<ActivityPage>(
      queryPath(
        workspacePath(workspaceId, `/routines/${encodeURIComponent(routineId)}/activity-events`),
        { limit: 20, cursor },
      ),
      signal === undefined ? {} : { signal },
    ),

  listScheduleBlocks: (workspaceId: string, from: string, to: string, signal?: AbortSignal) =>
    listAllOffsetPages<ScheduleBlock>(
      workspacePath(workspaceId, "/schedule-blocks"),
      { from, to },
      signal,
    ),

  getScheduleBlock: (workspaceId: string, blockId: string, signal?: AbortSignal) =>
    request<ScheduleBlock>(
      workspacePath(workspaceId, `/schedule-blocks/${encodeURIComponent(blockId)}`),
      signal === undefined ? {} : { signal },
    ),

  createScheduleBlock: (
    workspaceId: string,
    input: {
      workItemId: string | null;
      title: string | null;
      startsAt: string;
      endsAt: string;
      timeZone: string;
    },
  ) =>
    request<ScheduleBlock>(workspacePath(workspaceId, "/schedule-blocks"), {
      method: "POST",
      json: input,
    }),

  updateScheduleBlock: (
    workspaceId: string,
    blockId: string,
    input: {
      expectedVersion: number;
      workItemId?: string | null;
      title?: string | null;
      startsAt?: string;
      endsAt?: string;
      timeZone?: string;
    },
  ) =>
    request<ScheduleBlock>(
      workspacePath(workspaceId, `/schedule-blocks/${encodeURIComponent(blockId)}`),
      { method: "PATCH", json: input },
    ),

  deleteScheduleBlock: (workspaceId: string, blockId: string, expectedVersion: number) =>
    request<void>(workspacePath(workspaceId, `/schedule-blocks/${encodeURIComponent(blockId)}`), {
      method: "DELETE",
      json: { expectedVersion },
    }),

  getCurrentPlan: (workspaceId: string, date: string, signal?: AbortSignal) =>
    request<CurrentDailyPlan>(
      workspacePath(workspaceId, `/plans/${date}/current`),
      signal === undefined ? {} : { signal },
    ),

  generatePlan: (workspaceId: string, input: GeneratePlanInput) =>
    request<DailyPlan>(workspacePath(workspaceId, "/plans"), {
      method: "POST",
      json: input,
    }),

  setPlanItemLock: (
    workspaceId: string,
    date: string,
    itemId: string,
    input: { expectedPlanId: string; expectedHeadVersion: number; locked: boolean },
    idempotencyKey: string,
  ) =>
    request<{ planId: string; itemId: string; locked: boolean; headVersion: number }>(
      workspacePath(workspaceId, `/plans/${date}/items/${encodeURIComponent(itemId)}/lock`),
      { method: "PATCH", json: input, idempotencyKey },
    ),

  recordPlanItemActivity: (
    workspaceId: string,
    date: string,
    itemId: string,
    input: {
      expectedPlanId: string;
      expectedHeadVersion: number;
      type: Exclude<PlanItemActivityState, "pending"> | "completion_reversed";
      occurredAt: string;
      timeZone: string;
      durationMinutes: number | null;
      reason: string | null;
      metadata: Readonly<Record<string, string | number | boolean | null>>;
    },
    idempotencyKey: string,
  ) =>
    request<{
      planId: string;
      itemId: string;
      activityState: PlanItemActivityState;
      headVersion: number;
    }>(
      workspacePath(
        workspaceId,
        `/plans/${date}/items/${encodeURIComponent(itemId)}/activity-events`,
      ),
      { method: "POST", json: input, idempotencyKey },
    ),

  regeneratePlan: (
    workspaceId: string,
    date: string,
    input: { expectedPlanId: string; expectedHeadVersion: number; request: PlanSettings },
    idempotencyKey: string,
  ) =>
    request<CurrentDailyPlan>(workspacePath(workspaceId, `/plans/${date}/regenerations`), {
      method: "POST",
      json: input,
      idempotencyKey,
    }),

  replacePlanItem: (
    workspaceId: string,
    date: string,
    itemId: string,
    input: { expectedPlanId: string; expectedHeadVersion: number; request: PlanSettings },
    idempotencyKey: string,
  ) =>
    request<CurrentDailyPlan>(
      workspacePath(workspaceId, `/plans/${date}/items/${encodeURIComponent(itemId)}/replacement`),
      { method: "POST", json: input, idempotencyKey },
    ),

  applyRoutineFeedback: (
    workspaceId: string,
    date: string,
    itemId: string,
    input: {
      expectedPlanId: string;
      expectedHeadVersion: number;
      kind: RoutinePlanningFeedbackSuppressionKind;
      request: PlanSettings;
    },
    idempotencyKey: string,
  ) =>
    request<CurrentDailyPlan>(
      workspacePath(
        workspaceId,
        `/plans/${date}/items/${encodeURIComponent(itemId)}/routine-feedback`,
      ),
      { method: "POST", json: input, idempotencyKey },
    ),

  resetRoutineFeedback: (
    workspaceId: string,
    date: string,
    routineId: string,
    input: { expectedPlanId: string; expectedHeadVersion: number; request: PlanSettings },
    idempotencyKey: string,
  ) =>
    request<CurrentDailyPlan>(
      workspacePath(
        workspaceId,
        `/plans/${date}/routines/${encodeURIComponent(routineId)}/routine-feedback-resets`,
      ),
      { method: "POST", json: input, idempotencyKey },
    ),
};
