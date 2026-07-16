import { afterEach, describe, expect, it, vi } from "vitest";

import { hostedApi } from "./hosted-api";
import type { HostedApiError } from "./hosted-api";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("hosted web API client", () => {
  it("uses only the same-origin session and bounded hosted read routes", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ authenticated: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [], limit: 20, offset: 0 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [], limit: 20, offset: 0 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ date: "2026-07-16", items: [], totalMinutes: 0 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(hostedApi.session()).resolves.toEqual({ authenticated: true });
    await expect(hostedApi.listWorkspaces()).resolves.toMatchObject({ items: [] });
    await expect(hostedApi.listWorkItems("workspace/one")).resolves.toMatchObject({ items: [] });
    await expect(hostedApi.getToday("workspace/one", "2026-07-16")).resolves.toMatchObject({
      date: "2026-07-16",
      items: [],
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/v1/auth/session",
      expect.objectContaining({ method: "GET", credentials: "same-origin" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/v1/hosted/workspaces?limit=20&offset=0",
      expect.objectContaining({ method: "GET", credentials: "same-origin" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/v1/hosted/workspaces/workspace%2Fone/work-items",
      expect.objectContaining({ method: "GET", credentials: "same-origin" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "/v1/hosted/workspaces/workspace%2Fone/today?date=2026-07-16",
      expect.objectContaining({ method: "GET", credentials: "same-origin" }),
    );
  });

  it("copies the exact CSRF cookie into hosted mutations", async () => {
    const token = "a".repeat(43);
    vi.spyOn(document, "cookie", "get").mockReturnValue(
      `other=value; __Host-schedule_csrf=${token}`,
    );
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ id: "item-1", title: "Prepare release" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await hostedApi.createWorkItem("workspace/one", "Prepare release");
    const [, options] = fetchMock.mock.calls[0] ?? [];
    const headers = new Headers(options?.headers);
    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/hosted/workspaces/workspace%2Fone/work-items",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        body: JSON.stringify({ title: "Prepare release" }),
      }),
    );
    expect(headers.get("x-schedule-csrf")).toBe(token);
  });

  it("fails before sending when request verification is absent", async () => {
    vi.spyOn(document, "cookie", "get").mockReturnValue("");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(hostedApi.logout()).rejects.toEqual(
      expect.objectContaining<Partial<HostedApiError>>({
        status: 403,
        code: "hosted.csrf_missing",
      }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("maps non-JSON failures to one bounded error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("proxy failure", { status: 503 })),
    );

    await expect(hostedApi.session()).rejects.toEqual(
      expect.objectContaining<Partial<HostedApiError>>({
        status: 503,
        code: "request.failed",
        message: "Schedule could not complete the request.",
      }),
    );
  });
});
