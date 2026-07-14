import type {
  ActivityPage,
  CurrentDailyPlan,
  DailyPlan,
  DailyPlanFitInsight,
  DailyPlanFitInsightFeedback,
  GeneratePlanInput,
  NaturalLanguageConfirmationResult,
  NaturalLanguageProposal,
  NaturalLanguageProposalResult,
  NotificationDeliveryHistoryItem,
  NotificationIntent,
  NotificationMaterializationResult,
  NotificationProfile,
  NotificationRule,
  NotificationRuleKind,
  OneOffReminder,
  Page,
  PlanItemActivityState,
  PlanSettings,
  Routine,
  RoutineDurationInsight,
  RoutineDurationInsightFeedback,
  RoutinePlanningFeedbackSuppressionKind,
  RoutineStatus,
  ScheduleBlock,
  SchedulingAdviceResult,
  WorkItem,
  WorkItemDependency,
  WorkItemPriority,
  WorkItemStatus,
  Workspace,
} from "./types";

interface RequestOptions {
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
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

async function readOffsetPass<Item>(
  path: string,
  values: Readonly<Record<string, string | number | undefined>>,
  itemKey: (item: Item) => string,
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
    const pageSignature = JSON.stringify(page.items.map(itemKey));
    const repeatedPage = seenPages.has(pageSignature);
    seenPages.add(pageSignature);

    let newItemCount = 0;
    for (const item of page.items) {
      const key = itemKey(item);
      if (seenIds.has(key)) continue;
      seenIds.add(key);
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

function sameItemOrder<Item>(
  first: readonly Item[],
  second: readonly Item[],
  itemKey: (item: Item) => string,
): boolean {
  return (
    first.length === second.length &&
    first.every((item, index) => {
      const secondItem = second[index];
      return secondItem !== undefined && itemKey(item) === itemKey(secondItem);
    })
  );
}

async function listAllOffsetPagesBy<Item>(
  path: string,
  values: Readonly<Record<string, string | number | undefined>>,
  itemKey: (item: Item) => string,
  signal?: AbortSignal,
): Promise<Page<Item>> {
  const first = await readOffsetPass<Item>(path, values, itemKey, signal);
  if (first.pagesRead === 1) {
    return { items: first.items, page: { limit: OFFSET_PAGE_LIMIT, offset: 0 } };
  }

  // Offset pagination has no server snapshot. Require two identical traversals
  // before treating a multi-page collection as authoritative.
  const confirmed = await readOffsetPass<Item>(path, values, itemKey, signal);
  if (!sameItemOrder(first.items, confirmed.items, itemKey)) {
    throw new Error(PAGINATION_CHANGED_MESSAGE);
  }
  return { items: confirmed.items, page: { limit: OFFSET_PAGE_LIMIT, offset: 0 } };
}

async function listAllOffsetPages<Item extends { readonly id: string }>(
  path: string,
  values: Readonly<Record<string, string | number | undefined>>,
  signal?: AbortSignal,
): Promise<Page<Item>> {
  return listAllOffsetPagesBy(path, values, (item) => item.id, signal);
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
      parentWorkItemId?: string | null;
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

  createSubtask: (
    workspaceId: string,
    parentWorkItemId: string,
    input: {
      title: string;
      description: string | null;
      status: WorkItemStatus;
      priority: WorkItemPriority;
      dueOn: string | null;
      planningDurationMinutes: number | null;
    },
  ) =>
    request<WorkItem>(
      workspacePath(workspaceId, `/work-items/${encodeURIComponent(parentWorkItemId)}/subtasks`),
      { method: "POST", json: input },
    ),

  listWorkItemChildren: (workspaceId: string, parentWorkItemId: string, signal?: AbortSignal) =>
    listAllOffsetPages<WorkItem>(
      workspacePath(workspaceId, `/work-items/${encodeURIComponent(parentWorkItemId)}/subtasks`),
      {},
      signal,
    ),

  generateNaturalLanguageProposal: async (
    workspaceId: string,
    input: {
      readonly version: "schedule.natural-language/v1";
      readonly requestId: string;
      readonly prompt: string;
    },
    signal?: AbortSignal,
  ) => {
    const result = await request<NaturalLanguageProposalResult>(
      workspacePath(workspaceId, "/natural-language/proposals"),
      {
        method: "POST",
        json: input,
        ...(signal === undefined ? {} : { signal }),
      },
    );
    if (result.version !== "schedule.natural-language/v1" || result.requestId !== input.requestId) {
      throw new ApiError(
        502,
        "natural_language.response_mismatch",
        "The local model returned a mismatched proposal response.",
        null,
      );
    }
    return result;
  },

  updateNaturalLanguageProposal: (
    workspaceId: string,
    proposalId: string,
    input: { readonly expectedVersion: number; readonly title: string },
    signal?: AbortSignal,
  ) =>
    request<NaturalLanguageProposal>(
      workspacePath(workspaceId, `/natural-language/proposals/${encodeURIComponent(proposalId)}`),
      { method: "PATCH", json: input, ...(signal === undefined ? {} : { signal }) },
    ),

  cancelNaturalLanguageProposal: (
    workspaceId: string,
    proposalId: string,
    expectedVersion: number,
    signal?: AbortSignal,
  ) =>
    request<NaturalLanguageProposal>(
      workspacePath(
        workspaceId,
        `/natural-language/proposals/${encodeURIComponent(proposalId)}/cancellations`,
      ),
      {
        method: "POST",
        json: { expectedVersion },
        ...(signal === undefined ? {} : { signal }),
      },
    ),

  confirmNaturalLanguageProposal: (
    workspaceId: string,
    proposalId: string,
    expectedVersion: number,
    idempotencyKey: string,
    signal?: AbortSignal,
  ) =>
    request<NaturalLanguageConfirmationResult>(
      workspacePath(
        workspaceId,
        `/natural-language/proposals/${encodeURIComponent(proposalId)}/confirmations`,
      ),
      {
        method: "POST",
        json: { expectedVersion },
        idempotencyKey,
        ...(signal === undefined ? {} : { signal }),
      },
    ),

  updateWorkItem: (
    workspaceId: string,
    itemId: string,
    input: {
      expectedVersion: number;
      parentWorkItemId?: string | null;
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

  listWorkItemDependencies: (workspaceId: string, signal?: AbortSignal) =>
    listAllOffsetPagesBy<WorkItemDependency>(
      workspacePath(workspaceId, "/work-item-dependencies"),
      {},
      (dependency) => `${dependency.dependentWorkItemId}:${dependency.prerequisiteWorkItemId}`,
      signal,
    ),

  addWorkItemPrerequisite: (
    workspaceId: string,
    dependentWorkItemId: string,
    prerequisiteWorkItemId: string,
  ) =>
    request<WorkItemDependency>(
      workspacePath(
        workspaceId,
        `/work-items/${encodeURIComponent(dependentWorkItemId)}/prerequisites`,
      ),
      { method: "POST", json: { prerequisiteWorkItemId } },
    ),

  removeWorkItemPrerequisite: (
    workspaceId: string,
    dependentWorkItemId: string,
    prerequisiteWorkItemId: string,
  ) =>
    request<void>(
      workspacePath(
        workspaceId,
        `/work-items/${encodeURIComponent(dependentWorkItemId)}/prerequisites/${encodeURIComponent(prerequisiteWorkItemId)}`,
      ),
      { method: "DELETE" },
    ),

  listRoutines: (workspaceId: string, status?: RoutineStatus, signal?: AbortSignal) =>
    listAllOffsetPages<Routine>(workspacePath(workspaceId, "/routines"), { status }, signal),

  getRoutine: (workspaceId: string, routineId: string, signal?: AbortSignal) =>
    request<Routine>(
      workspacePath(workspaceId, `/routines/${encodeURIComponent(routineId)}`),
      signal === undefined ? {} : { signal },
    ),

  getDailyPlanFitInsight: (workspaceId: string, forDate: string, signal?: AbortSignal) =>
    request<DailyPlanFitInsight>(
      queryPath(workspacePath(workspaceId, "/daily-plan-fit-insight"), { forDate }),
      signal === undefined ? {} : { signal },
    ),

  dismissDailyPlanFitInsight: (
    workspaceId: string,
    input: { readonly forDate: string; readonly insightKey: string },
    idempotencyKey: string,
    signal?: AbortSignal,
  ) =>
    request<DailyPlanFitInsightFeedback>(
      workspacePath(workspaceId, "/daily-plan-fit-insight/dismissals"),
      {
        method: "POST",
        json: input,
        idempotencyKey,
        ...(signal === undefined ? {} : { signal }),
      },
    ),

  resetDailyPlanFitInsightDismissal: (
    workspaceId: string,
    input: { readonly forDate: string; readonly insightKey: string },
    idempotencyKey: string,
    signal?: AbortSignal,
  ) =>
    request<DailyPlanFitInsightFeedback>(
      workspacePath(workspaceId, "/daily-plan-fit-insight/dismissal-resets"),
      {
        method: "POST",
        json: input,
        idempotencyKey,
        ...(signal === undefined ? {} : { signal }),
      },
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

  dismissRoutineDurationInsight: (
    workspaceId: string,
    routineId: string,
    input: { readonly expectedVersion: number; readonly insightKey: string },
    idempotencyKey: string,
  ) =>
    request<RoutineDurationInsightFeedback>(
      workspacePath(
        workspaceId,
        `/routines/${encodeURIComponent(routineId)}/duration-insight/dismissals`,
      ),
      { method: "POST", json: input, idempotencyKey },
    ),

  resetRoutineDurationInsightDismissal: (
    workspaceId: string,
    routineId: string,
    input: { readonly expectedVersion: number; readonly insightKey: string },
    idempotencyKey: string,
  ) =>
    request<RoutineDurationInsightFeedback>(
      workspacePath(
        workspaceId,
        `/routines/${encodeURIComponent(routineId)}/duration-insight/dismissal-resets`,
      ),
      { method: "POST", json: input, idempotencyKey },
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

  getNotificationProfile: (workspaceId: string, signal?: AbortSignal) =>
    request<NotificationProfile>(
      workspacePath(workspaceId, "/notification-profile"),
      signal === undefined ? {} : { signal },
    ),

  configureNotificationProfile: (
    workspaceId: string,
    input: {
      expectedVersion: number | null;
      enabled: boolean;
      timeZone: string;
      quietHoursStartMinute: number | null;
      quietHoursEndMinute: number | null;
      quietHoursPolicy: "skip" | "next_allowed";
      catchUpWindowMinutes: number;
      dailyIntentLimit: number;
    },
  ) =>
    request<NotificationProfile>(workspacePath(workspaceId, "/notification-profile"), {
      method: "PUT",
      json: input,
    }),

  listNotificationRules: (workspaceId: string, signal?: AbortSignal) =>
    request<{ readonly items: readonly NotificationRule[] }>(
      workspacePath(workspaceId, "/notification-rules"),
      signal === undefined ? {} : { signal },
    ),

  createNotificationRule: (
    workspaceId: string,
    input: {
      kind: NotificationRuleKind;
      enabled: boolean;
      localMinute: number | null;
      leadMinutes: number | null;
      cooldownMinutes: number;
      priority: number;
    },
  ) =>
    request<NotificationRule>(workspacePath(workspaceId, "/notification-rules"), {
      method: "POST",
      json: input,
    }),

  updateNotificationRule: (
    workspaceId: string,
    ruleId: string,
    input: {
      expectedVersion: number;
      enabled?: boolean;
      localMinute?: number | null;
      leadMinutes?: number | null;
      cooldownMinutes?: number;
      priority?: number;
    },
  ) =>
    request<NotificationRule>(
      workspacePath(workspaceId, `/notification-rules/${encodeURIComponent(ruleId)}`),
      { method: "PATCH", json: input },
    ),

  listOneOffReminders: (workspaceId: string, from: string, to: string, signal?: AbortSignal) =>
    request<{ readonly items: readonly OneOffReminder[] }>(
      queryPath(workspacePath(workspaceId, "/one-off-reminders"), { from, to }),
      signal === undefined ? {} : { signal },
    ),

  createOneOffReminder: (
    workspaceId: string,
    input: { readonly title: string; readonly scheduledFor: string },
  ) =>
    request<OneOffReminder>(workspacePath(workspaceId, "/one-off-reminders"), {
      method: "POST",
      json: input,
    }),

  updateOneOffReminder: (
    workspaceId: string,
    reminderId: string,
    input: {
      readonly expectedVersion: number;
      readonly title?: string;
      readonly scheduledFor?: string;
    },
  ) =>
    request<OneOffReminder>(
      workspacePath(workspaceId, `/one-off-reminders/${encodeURIComponent(reminderId)}`),
      { method: "PATCH", json: input },
    ),

  cancelOneOffReminder: (workspaceId: string, reminderId: string, expectedVersion: number) =>
    request<OneOffReminder>(
      workspacePath(
        workspaceId,
        `/one-off-reminders/${encodeURIComponent(reminderId)}/cancellations`,
      ),
      { method: "POST", json: { expectedVersion } },
    ),

  listNotificationIntents: (workspaceId: string, from: string, to: string, signal?: AbortSignal) =>
    listAllOffsetPages<NotificationIntent>(
      workspacePath(workspaceId, "/notification-intents"),
      { from, to },
      signal,
    ),

  materializeNotificationIntents: (workspaceId: string, from: string, through: string) =>
    request<NotificationMaterializationResult>(
      workspacePath(workspaceId, "/notification-intents/materializations"),
      { method: "POST", json: { from, through } },
    ),

  listNotificationDeliveries: (
    workspaceId: string,
    from: string,
    to: string,
    signal?: AbortSignal,
  ) =>
    listAllOffsetPagesBy<NotificationDeliveryHistoryItem>(
      workspacePath(workspaceId, "/notification-deliveries"),
      { from, to },
      (item) => item.deliveryId,
      signal,
    ),

  getCurrentPlan: (workspaceId: string, date: string, signal?: AbortSignal) =>
    request<CurrentDailyPlan>(
      workspacePath(workspaceId, `/plans/${date}/current`),
      signal === undefined ? {} : { signal },
    ),

  getSchedulingAdvice: async (
    workspaceId: string,
    input: {
      readonly date: string;
      readonly expectedPlanId: string;
      readonly expectedHeadVersion: number;
    },
    signal?: AbortSignal,
  ) => {
    const requestId = globalThis.crypto.randomUUID();
    const result = await request<SchedulingAdviceResult>(
      workspacePath(workspaceId, "/advisor/advice"),
      {
        method: "POST",
        json: {
          version: "schedule.advisor/v1",
          requestId,
          date: input.date,
          focus: "both",
          expectedPlanId: input.expectedPlanId,
          expectedHeadVersion: input.expectedHeadVersion,
        },
        ...(signal === undefined ? {} : { signal }),
      },
    );
    if (result.version !== "schedule.advisor/v1" || result.requestId !== requestId) {
      throw new ApiError(
        502,
        "advisor.response_mismatch",
        "The local advisor returned a mismatched response.",
        null,
      );
    }
    return result;
  },

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
