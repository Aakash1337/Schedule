import type {
  ActivityPage,
  CurrentDailyPlan,
  DailyPlan,
  GeneratePlanInput,
  Page,
  PlanItemActivityState,
  PlanSettings,
  Routine,
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

async function listAllOffsetPages<Item>(
  path: string,
  values: Readonly<Record<string, string | number | undefined>>,
  signal?: AbortSignal,
): Promise<Page<Item>> {
  const items: Item[] = [];
  let offset = 0;

  for (;;) {
    const page = await request<Page<Item>>(
      queryPath(path, { ...values, limit: OFFSET_PAGE_LIMIT, offset }),
      signal === undefined ? {} : { signal },
    );
    items.push(...page.items);

    if (page.items.length < page.page.limit || page.items.length === 0) break;
    offset += page.items.length;
  }

  return { items, page: { limit: OFFSET_PAGE_LIMIT, offset: 0 } };
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
};
