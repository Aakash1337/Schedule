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
        new Response(
          JSON.stringify({
            date: "2026-07-16",
            planId: null,
            headVersion: null,
            items: [],
            totalMinutes: 0,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
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

  it("reads bounded hosted Plan Fit guidance for one explicit date", async () => {
    const insight = {
      forDate: "2026-07-16",
      status: "suggested",
      disposition: "available",
      sampleCount: 3,
      minimumSamples: 3,
      suggestedTargetMinutes: 90,
      suggestedTargetTaskCount: 2,
      insightKey: "a".repeat(64),
    } as const;
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(insight), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(hostedApi.getDailyPlanFitInsight("workspace/one", "2026-07-16")).resolves.toEqual(
      insight,
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/hosted/workspaces/workspace%2Fone/daily-plan-fit-insight?forDate=2026-07-16",
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
        new Response(
          JSON.stringify({
            id: "item-1",
            title: "Prepare release",
            version: 1,
            priority: "high",
            dueOn: "2026-07-20",
            planningDurationMinutes: 75,
          }),
          {
            status: 201,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await hostedApi.createWorkItem("workspace/one", {
      title: "Prepare release",
      priority: "high",
      dueOn: "2026-07-20",
      planningDurationMinutes: 75,
    });
    const [, options] = fetchMock.mock.calls[0] ?? [];
    const headers = new Headers(options?.headers);
    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/hosted/workspaces/workspace%2Fone/work-items",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        body: JSON.stringify({
          title: "Prepare release",
          priority: "high",
          dueOn: "2026-07-20",
          planningDurationMinutes: 75,
        }),
      }),
    );
    expect(headers.get("x-schedule-csrf")).toBe(token);
  });

  it("sends only a workspace name through the verified hosted collection", async () => {
    const token = "d".repeat(43);
    vi.spyOn(document, "cookie", "get").mockReturnValue(`__Host-schedule_csrf=${token}`);
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ id: "workspace-1", name: "Projects" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await hostedApi.createWorkspace("Projects");
    const [, options] = fetchMock.mock.calls[0] ?? [];
    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/hosted/workspaces",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        body: JSON.stringify({ name: "Projects" }),
      }),
    );
    expect(new Headers(options?.headers).get("x-schedule-csrf")).toBe(token);
  });

  it("sends only optimistic status fields for hosted workflow updates", async () => {
    const token = "b".repeat(43);
    vi.spyOn(document, "cookie", "get").mockReturnValue(`__Host-schedule_csrf=${token}`);
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await hostedApi.updateWorkItemStatus(
      "workspace/one",
      { id: "item/one", version: 3 },
      "in_progress",
    );
    const [, options] = fetchMock.mock.calls[0] ?? [];
    const headers = new Headers(options?.headers);
    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/hosted/workspaces/workspace%2Fone/work-items/item%2Fone",
      expect.objectContaining({
        method: "PATCH",
        credentials: "same-origin",
        body: JSON.stringify({ expectedVersion: 3, status: "in_progress" }),
      }),
    );
    expect(headers.get("x-schedule-csrf")).toBe(token);
  });

  it("sends one bounded, idempotent Today action", async () => {
    const token = "c".repeat(43);
    vi.spyOn(document, "cookie", "get").mockReturnValue(`__Host-schedule_csrf=${token}`);
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await hostedApi.recordTodayActivity("workspace/one", "2026-07-16", "item/one", {
      expectedPlanId: "plan-1",
      expectedHeadVersion: 7,
      type: "completed",
      occurredAt: "2026-07-16T09:30:00.000Z",
      idempotencyKey: "today-action-1",
    });
    const [, options] = fetchMock.mock.calls[0] ?? [];
    const headers = new Headers(options?.headers);
    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/hosted/workspaces/workspace%2Fone/today/item%2Fone/activity-events?date=2026-07-16",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        body: JSON.stringify({
          expectedPlanId: "plan-1",
          expectedHeadVersion: 7,
          type: "completed",
          occurredAt: "2026-07-16T09:30:00.000Z",
        }),
      }),
    );
    expect(headers.get("x-schedule-csrf")).toBe(token);
    expect(headers.get("Idempotency-Key")).toBe("today-action-1");
  });

  it("sends one bounded, idempotent first-plan request", async () => {
    const token = "e".repeat(43);
    vi.spyOn(document, "cookie", "get").mockReturnValue(`__Host-schedule_csrf=${token}`);
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await hostedApi.generateToday("workspace/one", "2026-07-16", {
      timeZone: "America/La_Paz",
      window: {
        startsAt: "2026-07-16T13:00:00.000Z",
        endsAt: "2026-07-16T21:00:00.000Z",
      },
      targetMinutes: 180,
      targetTaskCount: 4,
      planFitInsightKey: "f".repeat(64),
      idempotencyKey: "first-plan-1",
    });
    const [, options] = fetchMock.mock.calls[0] ?? [];
    const headers = new Headers(options?.headers);
    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/hosted/workspaces/workspace%2Fone/today?date=2026-07-16",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        body: JSON.stringify({
          timeZone: "America/La_Paz",
          window: {
            startsAt: "2026-07-16T13:00:00.000Z",
            endsAt: "2026-07-16T21:00:00.000Z",
          },
          targetMinutes: 180,
          targetTaskCount: 4,
          planFitInsightKey: "f".repeat(64),
        }),
      }),
    );
    expect(headers.get("x-schedule-csrf")).toBe(token);
    expect(headers.get("Idempotency-Key")).toBe("first-plan-1");
  });

  it("fails before sending when request verification is absent", async () => {
    vi.spyOn(document, "cookie", "get").mockReturnValue("");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(hostedApi.createWorkspace("Projects")).rejects.toEqual(
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
