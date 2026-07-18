export interface HostedWorkspace {
  readonly id: string;
  readonly name: string;
}

interface HostedWorkspacePage {
  readonly items: readonly HostedWorkspace[];
}

export interface HostedWorkItem {
  readonly id: string;
  readonly title: string;
  readonly version: number;
  readonly priority: HostedWorkItemPriority;
  readonly dueOn: string | null;
  readonly planningDurationMinutes: number | null;
}

export type HostedWorkItemStatus =
  "backlog" | "planned" | "in_progress" | "blocked" | "done" | "cancelled";
export type HostedWorkItemPriority = "none" | "low" | "medium" | "high" | "urgent";

export interface HostedWorkItemSnapshot extends HostedWorkItem {
  readonly parentWorkItemId: string | null;
  readonly description: string | null;
  readonly status: HostedWorkItemStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface HostedCreateWorkItem {
  readonly title: string;
  readonly priority?: HostedWorkItemPriority;
  readonly dueOn?: string | null;
  readonly planningDurationMinutes?: number | null;
}

export interface HostedWorkItemPage {
  readonly items: readonly HostedWorkItem[];
  readonly limit: number;
  readonly offset: number;
}

export interface HostedWorkItemSnapshotPage {
  readonly items: readonly HostedWorkItemSnapshot[];
  readonly limit: number;
  readonly offset: number;
}

export interface HostedWorkItemSyncBootstrapPage {
  readonly protocolVersion: 1;
  readonly items: readonly HostedWorkItemSnapshot[];
  readonly checkpoint: string;
  readonly nextCursor: string | null;
}

export type HostedWorkItemSyncChange =
  | { readonly type: "upsert"; readonly item: HostedWorkItemSnapshot }
  | { readonly type: "delete"; readonly workItemId: string };

export interface HostedWorkItemSyncDeltaPage {
  readonly protocolVersion: 1;
  readonly changes: readonly HostedWorkItemSyncChange[];
  readonly checkpoint: string;
  readonly nextCursor: string | null;
}

export type HostedTodayActivityState =
  "pending" | "started" | "completed" | "skipped" | "deferred" | "dismissed";
export type HostedTodayActivityType = "started" | "completed" | "skipped";

export interface HostedToday {
  readonly date: string;
  readonly planId: string | null;
  readonly headVersion: number | null;
  readonly items: readonly {
    readonly id: string;
    readonly title: string;
    readonly scheduledMinutes: number;
    readonly activityState: HostedTodayActivityState;
  }[];
  readonly totalMinutes: number;
}

export interface HostedDailyPlanFitInsight {
  readonly forDate: string;
  readonly status: "insufficient_history" | "aligned" | "suggested";
  readonly disposition: "available" | "dismissed";
  readonly sampleCount: number;
  readonly minimumSamples: number;
  readonly suggestedTargetMinutes: number | null;
  readonly suggestedTargetTaskCount: number | null;
  readonly insightKey: string | null;
}

export interface HostedDailyPlanFitFeedback {
  readonly forDate: string;
  readonly insightKey: string;
  readonly idempotencyKey: string;
}

export interface HostedDailyPlanFitEffectiveness {
  readonly usesConsidered: number;
  readonly eligibleResolvedUseCount: number;
  readonly minimumComparableUses: number;
  readonly pendingUseCount: number;
  readonly revisedUseCount: number;
  readonly notEvaluableUseCount: number;
  readonly exactSuggestionUseCount: number;
  readonly editedSuggestionUseCount: number;
  readonly scheduledMinutesRateBasisPoints: number | null;
  readonly scheduledTasksRateBasisPoints: number | null;
  readonly completionMinutesRateBasisPoints: number | null;
  readonly completionTasksRateBasisPoints: number | null;
}

export interface HostedGenerateToday {
  readonly timeZone: string;
  readonly window: Readonly<{ startsAt: string; endsAt: string }>;
  readonly targetMinutes: number;
  readonly targetTaskCount: number;
  readonly planFitInsightKey: string | null;
  readonly idempotencyKey: string;
}

export class HostedApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HostedApiError";
  }
}

const csrfCookieName = "__Host-schedule_csrf";
const csrfHeaderName = "x-schedule-csrf";
const csrfTokenPattern = /^[A-Za-z0-9_-]{43}$/u;

function csrfToken(cookie: string): string | null {
  for (const pair of cookie.split(";")) {
    const [name, ...valueParts] = pair.trim().split("=");
    if (name !== csrfCookieName) continue;
    const value = valueParts.join("=");
    return csrfTokenPattern.test(value) ? value : null;
  }
  return null;
}

async function request<Result>(
  path: string,
  options: Readonly<{
    method?: "GET" | "POST" | "PATCH";
    json?: unknown;
    csrf?: boolean;
    idempotencyKey?: string;
  }> = {},
): Promise<Result> {
  const headers = new Headers({ Accept: "application/json" });
  if (options.json !== undefined) headers.set("content-type", "application/json");
  if (options.idempotencyKey !== undefined) headers.set("Idempotency-Key", options.idempotencyKey);
  if (options.csrf === true) {
    const token = csrfToken(document.cookie);
    if (token === null)
      throw new HostedApiError(403, "hosted.csrf_missing", "Reload and try again.");
    headers.set(csrfHeaderName, token);
  }
  const response = await fetch(path, {
    method: options.method ?? "GET",
    credentials: "same-origin",
    headers,
    ...(options.json === undefined ? {} : { body: JSON.stringify(options.json) }),
  });
  if (!response.ok) {
    const fallback = {
      error: { code: "request.failed", message: "Schedule could not complete the request." },
    };
    const body = (await response.json().catch(() => fallback)) as {
      error?: { code?: string; message?: string };
    };
    throw new HostedApiError(
      response.status,
      body.error?.code ?? fallback.error.code,
      body.error?.message ?? fallback.error.message,
    );
  }
  if (response.status === 204) return undefined as Result;
  return (await response.json()) as Result;
}

export const hostedApi = {
  signInPath: "/v1/auth/login",
  session: () => request<{ readonly authenticated: boolean }>("/v1/auth/session"),
  listWorkspaces: () => request<HostedWorkspacePage>("/v1/hosted/workspaces?limit=20&offset=0"),
  createWorkspace: (name: string) =>
    request<HostedWorkspace>("/v1/hosted/workspaces", {
      method: "POST",
      json: { name },
      csrf: true,
    }),
  listWorkItems: (workspaceId: string) =>
    request<HostedWorkItemPage>(
      `/v1/hosted/workspaces/${encodeURIComponent(workspaceId)}/work-items`,
    ),
  listWorkItemSnapshot: (
    workspaceId: string,
    pagination: Readonly<{ limit: number; offset: number }>,
  ) =>
    request<HostedWorkItemSnapshotPage>(
      `/v1/hosted/workspaces/${encodeURIComponent(workspaceId)}/work-items/snapshot?limit=${pagination.limit}&offset=${pagination.offset}`,
    ),
  bootstrapWorkItemSync: (workspaceId: string, cursor?: string) =>
    request<HostedWorkItemSyncBootstrapPage>(
      `/v1/hosted/workspaces/${encodeURIComponent(workspaceId)}/work-items/sync/bootstrap?limit=200${cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`}`,
    ),
  listWorkItemSyncChanges: (workspaceId: string, cursor: string) =>
    request<HostedWorkItemSyncDeltaPage>(
      `/v1/hosted/workspaces/${encodeURIComponent(workspaceId)}/work-items/sync/changes?limit=200&cursor=${encodeURIComponent(cursor)}`,
    ),
  getToday: (workspaceId: string, date: string) =>
    request<HostedToday>(
      `/v1/hosted/workspaces/${encodeURIComponent(workspaceId)}/today?date=${encodeURIComponent(date)}`,
    ),
  getDailyPlanFitInsight: (workspaceId: string, forDate: string) =>
    request<HostedDailyPlanFitInsight>(
      `/v1/hosted/workspaces/${encodeURIComponent(workspaceId)}/daily-plan-fit-insight?forDate=${encodeURIComponent(forDate)}`,
    ),
  getDailyPlanFitEffectiveness: (workspaceId: string) =>
    request<HostedDailyPlanFitEffectiveness>(
      `/v1/hosted/workspaces/${encodeURIComponent(workspaceId)}/daily-plan-fit-insight/effectiveness`,
    ),
  dismissDailyPlanFitInsight: (
    workspaceId: string,
    { idempotencyKey, ...feedback }: HostedDailyPlanFitFeedback,
  ) =>
    request<void>(
      `/v1/hosted/workspaces/${encodeURIComponent(workspaceId)}/daily-plan-fit-insight/dismissals`,
      {
        method: "POST",
        json: feedback,
        csrf: true,
        idempotencyKey,
      },
    ),
  resetDailyPlanFitInsightDismissal: (
    workspaceId: string,
    { idempotencyKey, ...feedback }: HostedDailyPlanFitFeedback,
  ) =>
    request<void>(
      `/v1/hosted/workspaces/${encodeURIComponent(workspaceId)}/daily-plan-fit-insight/dismissal-resets`,
      {
        method: "POST",
        json: feedback,
        csrf: true,
        idempotencyKey,
      },
    ),
  generateToday: (workspaceId: string, date: string, command: HostedGenerateToday) =>
    request<void>(
      `/v1/hosted/workspaces/${encodeURIComponent(workspaceId)}/today?date=${encodeURIComponent(date)}`,
      {
        method: "POST",
        json: {
          timeZone: command.timeZone,
          window: command.window,
          targetMinutes: command.targetMinutes,
          targetTaskCount: command.targetTaskCount,
          planFitInsightKey: command.planFitInsightKey,
        },
        csrf: true,
        idempotencyKey: command.idempotencyKey,
      },
    ),
  recordTodayActivity: (
    workspaceId: string,
    date: string,
    itemId: string,
    command: Readonly<{
      expectedPlanId: string;
      expectedHeadVersion: number;
      type: HostedTodayActivityType;
      occurredAt: string;
      idempotencyKey: string;
    }>,
  ) =>
    request<void>(
      `/v1/hosted/workspaces/${encodeURIComponent(workspaceId)}/today/${encodeURIComponent(itemId)}/activity-events?date=${encodeURIComponent(date)}`,
      {
        method: "POST",
        json: {
          expectedPlanId: command.expectedPlanId,
          expectedHeadVersion: command.expectedHeadVersion,
          type: command.type,
          occurredAt: command.occurredAt,
        },
        csrf: true,
        idempotencyKey: command.idempotencyKey,
      },
    ),
  createWorkItem: (workspaceId: string, command: HostedCreateWorkItem) =>
    request<HostedWorkItem>(`/v1/hosted/workspaces/${encodeURIComponent(workspaceId)}/work-items`, {
      method: "POST",
      json: command,
      csrf: true,
    }),
  updateWorkItemStatus: (
    workspaceId: string,
    item: Pick<HostedWorkItem, "id" | "version">,
    status: "in_progress" | "done",
  ) =>
    request<void>(
      `/v1/hosted/workspaces/${encodeURIComponent(workspaceId)}/work-items/${encodeURIComponent(item.id)}`,
      {
        method: "PATCH",
        json: { expectedVersion: item.version, status },
        csrf: true,
      },
    ),
  logout: () => request<void>("/v1/auth/logout", { method: "POST", csrf: true }),
};
