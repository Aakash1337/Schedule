export interface HostedWorkspace {
  readonly id: string;
  readonly name: string;
}

interface HostedWorkspacePage {
  readonly items: readonly HostedWorkspace[];
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
  options: Readonly<{ method?: "GET" | "POST"; json?: unknown; csrf?: boolean }> = {},
): Promise<Result> {
  const headers = new Headers({ Accept: "application/json" });
  if (options.json !== undefined) headers.set("content-type", "application/json");
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
  createWorkItem: (workspaceId: string, title: string) =>
    request<{ readonly id: string; readonly title: string }>(
      `/v1/hosted/workspaces/${encodeURIComponent(workspaceId)}/work-items`,
      { method: "POST", json: { title }, csrf: true },
    ),
  logout: () => request<void>("/v1/auth/logout", { method: "POST", csrf: true }),
};
