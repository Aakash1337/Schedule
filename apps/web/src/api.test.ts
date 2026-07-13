import { afterEach, describe, expect, it, vi } from "vitest";

import { api, ApiError } from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
});

function pageResponse(items: readonly { readonly id: string }[], offset: number): Response {
  return new Response(JSON.stringify({ items, page: { limit: 200, offset } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("web API client", () => {
  it("uses the same-origin workspace endpoint", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ items: [], page: { limit: 20, offset: 0 } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.listWorkspaces()).resolves.toMatchObject({ items: [] });
    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/workspaces?limit=20&offset=0",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("carries optimistic versions in work-item updates", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "item-1",
            workspaceId: "workspace-1",
            title: "Plan",
            description: null,
            status: "planned",
            priority: "high",
            version: 4,
            createdAt: "2026-07-12T00:00:00.000Z",
            updatedAt: "2026-07-12T00:01:00.000Z",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.updateWorkItem("workspace-1", "item-1", {
      expectedVersion: 3,
      status: "planned",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/workspaces/workspace-1/work-items/item-1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ expectedVersion: 3, status: "planned" }),
      }),
    );
  });

  it("sends local due dates unchanged for work-item create and update commands", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: "item-1", dueOn: "2026-07-20" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.createWorkItem("workspace-1", {
      title: "Prepare release",
      description: null,
      status: "backlog",
      priority: "high",
      dueOn: "2026-07-20",
      planningDurationMinutes: null,
    });
    await api.updateWorkItem("workspace-1", "item-1", {
      expectedVersion: 1,
      dueOn: null,
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/v1/workspaces/workspace-1/work-items",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          title: "Prepare release",
          description: null,
          status: "backlog",
          priority: "high",
          dueOn: "2026-07-20",
          planningDurationMinutes: null,
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/v1/workspaces/workspace-1/work-items/item-1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ expectedVersion: 1, dueOn: null }),
      }),
    );
  });

  it("reads offset-paginated collections through the final page", async () => {
    const firstPage = Array.from({ length: 200 }, (_, index) => ({ id: `item-${index}` }));
    let requestNumber = 0;
    const fetchMock = vi.fn(async () => {
      const response =
        requestNumber % 2 === 0
          ? pageResponse(firstPage, 0)
          : pageResponse([{ id: "item-200" }], 200);
      requestNumber += 1;
      return response;
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.listWorkItems("workspace-1")).resolves.toMatchObject({
      items: expect.arrayContaining([{ id: "item-200" }]),
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/v1/workspaces/workspace-1/work-items?limit=200&offset=0",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/v1/workspaces/workspace-1/work-items?limit=200&offset=200",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("deduplicates entity IDs across offset pages while preserving first-seen order", async () => {
    const firstPage = Array.from({ length: 200 }, (_, index) => ({ id: `item-${index}` }));
    let requestNumber = 0;
    const fetchMock = vi.fn(async () => {
      const response =
        requestNumber % 2 === 0
          ? pageResponse(firstPage, 0)
          : pageResponse([{ id: "item-199" }, { id: "item-200" }], 200);
      requestNumber += 1;
      return response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await api.listWorkItems("workspace-1");

    expect(result.items).toHaveLength(201);
    expect(result.items.map((item) => item.id)).toEqual([
      ...firstPage.map((item) => item.id),
      "item-200",
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("detects an offset shift caused by deletion between pages", async () => {
    const originalFirstPage = Array.from({ length: 200 }, (_, index) => ({ id: `item-${index}` }));
    const currentPage = Array.from({ length: 200 }, (_, index) => ({ id: `item-${index + 1}` }));
    const responses = [
      () => pageResponse(originalFirstPage, 0),
      () => pageResponse([], 200),
      () => pageResponse(currentPage, 0),
      () => pageResponse([], 200),
    ];
    let requestNumber = 0;
    const fetchMock = vi.fn(async () => responses[requestNumber++]!());
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.listWorkItems("workspace-1")).rejects.toThrow(
      "The collection changed while it was loading. Refresh and try again.",
    );
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("reports changing offset pagination instead of returning a silent partial result", async () => {
    const repeatedPage = Array.from({ length: 200 }, (_, index) => ({ id: `item-${index}` }));
    const response = () =>
      new Response(JSON.stringify({ items: repeatedPage, page: { limit: 200, offset: 0 } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    const fetchMock = vi.fn(async () => response());
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.listWorkItems("workspace-1")).rejects.toThrow(
      "The collection changed while it was loading. Refresh and try again.",
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/v1/workspaces/workspace-1/work-items?limit=200&offset=200",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("retrieves one calendar block directly for conflict recovery", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: "block-1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.getScheduleBlock("workspace-1", "block-1");

    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/workspaces/workspace-1/schedule-blocks/block-1",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("retrieves a routine duration insight with a cancellable request", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            routineId: "routine-1",
            routineVersion: 2,
            status: "insufficient_history",
            sampleCount: 1,
            minimumSamples: 3,
            lookbackDays: 90,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await api.getRoutineDurationInsight("workspace-1", "routine-1", controller.signal);

    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/workspaces/workspace-1/routines/routine-1/duration-insight",
      expect.objectContaining({ method: "GET", signal: controller.signal }),
    );
  });

  it("approves a routine duration insight through its atomic command endpoint", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: "routine-1", version: 3 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const duration = {
      minimumMinutes: 15,
      expectedMinutes: 40,
      maximumMinutes: 45,
      splittable: false,
      minimumSessionMinutes: 15,
      overheadMinutes: 0,
    };

    await api.approveRoutineDurationInsight("workspace-1", "routine-1", {
      expectedVersion: 2,
      duration,
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/workspaces/workspace-1/routines/routine-1/duration-insight/approve",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ expectedVersion: 2, duration }),
      }),
    );
  });

  it("dismisses a routine duration insight with an idempotent audited command", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ id: "feedback-1", kind: "dismissed" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const input = { expectedVersion: 2, insightKey: "a".repeat(64) };

    await api.dismissRoutineDurationInsight(
      "workspace-1",
      "routine-1",
      input,
      "duration-dismiss-attempt-1",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/workspaces/workspace-1/routines/routine-1/duration-insight/dismissals",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(input),
        headers: expect.any(Headers),
      }),
    );
    const options = fetchMock.mock.calls[0]?.[1];
    expect(options?.headers).toBeInstanceOf(Headers);
    expect((options?.headers as Headers).get("Idempotency-Key")).toBe("duration-dismiss-attempt-1");
  });

  it("restores a dismissed duration insight with an idempotent audited command", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ id: "feedback-2", kind: "reset" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const input = { expectedVersion: 2, insightKey: "b".repeat(64) };

    await api.resetRoutineDurationInsightDismissal(
      "workspace-1",
      "routine-1",
      input,
      "duration-reset-attempt-1",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/workspaces/workspace-1/routines/routine-1/duration-insight/dismissal-resets",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(input),
        headers: expect.any(Headers),
      }),
    );
    const options = fetchMock.mock.calls[0]?.[1];
    expect(options?.headers).toBeInstanceOf(Headers);
    expect((options?.headers as Headers).get("Idempotency-Key")).toBe("duration-reset-attempt-1");
  });

  it("handles audited 204 deletion responses", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.deleteScheduleBlock("workspace-1", "block-1", 7)).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/workspaces/workspace-1/schedule-blocks/block-1",
      expect.objectContaining({
        method: "DELETE",
        body: JSON.stringify({ expectedVersion: 7 }),
      }),
    );
  });

  it("maps the shared API error envelope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: { code: "work_item.version_conflict", message: "Changed elsewhere." },
              requestId: "req-9",
            }),
            { status: 409, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );

    const error = await api
      .updateWorkItem("workspace-1", "item-1", { expectedVersion: 1, status: "done" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 409,
      code: "work_item.version_conflict",
      requestId: "req-9",
    });
  });
});
