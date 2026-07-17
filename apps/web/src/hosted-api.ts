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
}

export interface HostedWorkItemPage {
  readonly items: readonly HostedWorkItem[];
  readonly limit: number;
  readonly offset: number;
}

export type HostedTodayActivityState =
  "pending" | "started" | "completed" | "skipped" | "deferred" | "dismissed";

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
  getToday: (workspaceId: string, date: string) =>
    request<HostedToday>(
      `/v1/hosted/workspaces/${encodeURIComponent(workspaceId)}/today?date=${encodeURIComponent(date)}`,
    ),
  recordTodayActivity: (
    workspaceId: string,
    date: string,
    itemId: string,
    command: Readonly<{
      expectedPlanId: string;
      expectedHeadVersion: number;
      type: "started" | "completed";
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
  createWorkItem: (workspaceId: string, title: string) =>
    request<HostedWorkItem>(`/v1/hosted/workspaces/${encodeURIComponent(workspaceId)}/work-items`, {
      method: "POST",
      json: { title },
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
