import { afterEach, describe, expect, it, vi } from "vitest";

import { api, ApiError } from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
});

function pageResponse(items: readonly unknown[], offset: number): Response {
  return new Response(JSON.stringify({ items, page: { limit: 200, offset } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("web API client", () => {
  it("creates or updates reminder policy through the versioned PUT boundary", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ workspaceId: "workspace-1", version: 2 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const input = {
      expectedVersion: 1,
      enabled: true,
      timeZone: "America/La_Paz",
      quietHoursStartMinute: 1_320,
      quietHoursEndMinute: 420,
      quietHoursPolicy: "next_allowed" as const,
      catchUpWindowMinutes: 90,
      dailyIntentLimit: 20,
    };
    await api.configureNotificationProfile("workspace-1", input);

    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/workspaces/workspace-1/notification-profile",
      expect.objectContaining({ method: "PUT", body: JSON.stringify(input) }),
    );
  });

  it("keeps delivery history on the product-safe paginated read route", async () => {
    const firstPage = Array.from({ length: 200 }, (_, index) => ({
      deliveryId: `delivery-${index}`,
    }));
    let requestNumber = 0;
    const fetchMock = vi.fn(async () => {
      const response =
        requestNumber % 2 === 0
          ? pageResponse(firstPage, 0)
          : pageResponse([{ deliveryId: "delivery-200" }], 200);
      requestNumber += 1;
      return response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await api.listNotificationDeliveries(
      "workspace-1",
      "2026-07-01T00:00:00.000Z",
      "2026-07-15T00:00:00.000Z",
    );

    expect(result.items).toHaveLength(201);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/v1/workspaces/workspace-1/notification-deliveries?from=2026-07-01T00%3A00%3A00.000Z&to=2026-07-15T00%3A00%3A00.000Z&limit=200&offset=0",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/v1/workspaces/workspace-1/notification-deliveries?from=2026-07-01T00%3A00%3A00.000Z&to=2026-07-15T00%3A00%3A00.000Z&limit=200&offset=200",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

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

  it("creates, lists, reparents, and detaches subtasks through hierarchy routes", async () => {
    const child = { id: "child-1", parentWorkItemId: "parent/1" };
    let requestNumber = 0;
    const fetchMock = vi.fn(async () => {
      const response =
        requestNumber === 1
          ? pageResponse([child], 0)
          : new Response(JSON.stringify(child), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            });
      requestNumber += 1;
      return response;
    });
    vi.stubGlobal("fetch", fetchMock);

    await api.createSubtask("workspace-1", "parent/1", {
      title: "Write notes",
      description: null,
      status: "backlog",
      priority: "none",
      dueOn: null,
      planningDurationMinutes: 30,
    });
    await api.listWorkItemChildren("workspace-1", "parent/1");
    await api.updateWorkItem("workspace-1", "child-1", {
      expectedVersion: 1,
      parentWorkItemId: "parent-2",
    });
    await api.updateWorkItem("workspace-1", "child-1", {
      expectedVersion: 2,
      parentWorkItemId: null,
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/v1/workspaces/workspace-1/work-items/parent%2F1/subtasks",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          title: "Write notes",
          description: null,
          status: "backlog",
          priority: "none",
          dueOn: null,
          planningDurationMinutes: 30,
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/v1/workspaces/workspace-1/work-items/parent%2F1/subtasks?limit=200&offset=0",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/v1/workspaces/workspace-1/work-items/child-1",
      expect.objectContaining({
        body: JSON.stringify({ expectedVersion: 1, parentWorkItemId: "parent-2" }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "/v1/workspaces/workspace-1/work-items/child-1",
      expect.objectContaining({
        body: JSON.stringify({ expectedVersion: 2, parentWorkItemId: null }),
      }),
    );
  });

  it("aggregates offset-paginated work-item dependency edges", async () => {
    const firstPage = Array.from({ length: 200 }, (_, index) => ({
      workspaceId: "workspace-1",
      prerequisiteWorkItemId: `prerequisite-${index}`,
      dependentWorkItemId: "dependent-1",
      createdAt: "2026-07-14T09:00:00.000Z",
    }));
    const finalEdge = {
      workspaceId: "workspace-1",
      prerequisiteWorkItemId: "prerequisite-200",
      dependentWorkItemId: "dependent-1",
      createdAt: "2026-07-14T09:01:00.000Z",
    };
    let requestNumber = 0;
    const fetchMock = vi.fn(async () => {
      const response =
        requestNumber % 2 === 0 ? pageResponse(firstPage, 0) : pageResponse([finalEdge], 200);
      requestNumber += 1;
      return response;
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.listWorkItemDependencies("workspace-1")).resolves.toMatchObject({
      items: expect.arrayContaining([finalEdge]),
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/v1/workspaces/workspace-1/work-item-dependencies?limit=200&offset=0",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/v1/workspaces/workspace-1/work-item-dependencies?limit=200&offset=200",
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("posts an exact prerequisite replay without inventing an idempotency header", async () => {
    const dependency = {
      workspaceId: "workspace-1",
      prerequisiteWorkItemId: "item-prerequisite",
      dependentWorkItemId: "item-dependent",
      createdAt: "2026-07-14T09:00:00.000Z",
    };
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).has("Idempotency-Key")).toBe(false);
      return new Response(JSON.stringify(dependency), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      api.addWorkItemPrerequisite("workspace-1", "item-dependent", "item-prerequisite"),
    ).resolves.toEqual(dependency);
    await expect(
      api.addWorkItemPrerequisite("workspace-1", "item-dependent", "item-prerequisite"),
    ).resolves.toEqual(dependency);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/v1/workspaces/workspace-1/work-items/item-dependent/prerequisites",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ prerequisiteWorkItemId: "item-prerequisite" }),
      }),
    );
  });

  it("removes a prerequisite through the replay-safe delete route", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      api.removeWorkItemPrerequisite("workspace-1", "item-dependent", "item-prerequisite"),
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/workspaces/workspace-1/work-items/item-dependent/prerequisites/item-prerequisite",
      expect.objectContaining({ method: "DELETE" }),
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

  it("retrieves a Daily Plan Fit insight for an explicit local date", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ status: "insufficient_history", forDate: "2026-07-14" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await api.getDailyPlanFitInsight("workspace-1", "2026-07-14", controller.signal);

    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/workspaces/workspace-1/daily-plan-fit-insight?forDate=2026-07-14",
      expect.objectContaining({ method: "GET", signal: controller.signal }),
    );
  });

  it("retrieves bounded Plan Fit usage outcomes", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await api.listDailyPlanFitUsageOutcomes("workspace-1", 5, controller.signal);

    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/workspaces/workspace-1/daily-plan-fit-insight/usages?limit=5",
      expect.objectContaining({ method: "GET", signal: controller.signal }),
    );
  });

  it("retrieves a bounded Plan Fit effectiveness summary", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ usesConsidered: 0 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await api.getDailyPlanFitEffectiveness("workspace-1", 28, controller.signal);

    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/workspaces/workspace-1/daily-plan-fit-insight/effectiveness?limit=28",
      expect.objectContaining({ method: "GET", signal: controller.signal }),
    );
  });

  it("retrieves planning outcomes for the dates before one local date", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ plansConsidered: 0 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await api.getPlanningOutcomes("workspace-1", "2026-07-16", controller.signal);

    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/workspaces/workspace-1/planning-outcomes?forDate=2026-07-16",
      expect.objectContaining({ method: "GET", signal: controller.signal }),
    );
  });

  it("previews daily-plan alternatives with an exact cancellable head fence", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ sourcePlanId: "plan-1", alternatives: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const request = {
      timeZone: "UTC",
      availableWindows: [],
      targetMinutes: 60,
      targetTaskCount: 2,
      fitPreference: "balanced" as const,
      energy: null,
      availableContexts: [],
      seed: "compare-1",
    };
    const input = { expectedPlanId: "plan-1", expectedHeadVersion: 3, request };

    await api.previewDailyPlanAlternatives("workspace-1", "2026-07-14", input, controller.signal);

    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/workspaces/workspace-1/plans/2026-07-14/alternative-previews",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(input),
        signal: controller.signal,
      }),
    );
  });

  it("selects a daily-plan alternative with the same request and an idempotency key", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _options?: RequestInit) =>
        new Response(JSON.stringify({ id: "plan-2", headVersion: 4 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const input = {
      expectedPlanId: "plan-1",
      expectedHeadVersion: 3,
      candidateKey: "a".repeat(64),
      request: {
        timeZone: "UTC",
        availableWindows: [],
        targetMinutes: 60,
        targetTaskCount: 2,
        fitPreference: "balanced" as const,
        energy: null,
        availableContexts: [],
        seed: "compare-1",
      },
    };

    await api.selectDailyPlanAlternative(
      "workspace-1",
      "2026-07-14",
      input,
      "select-alternative-1",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/workspaces/workspace-1/plans/2026-07-14/alternative-selections",
      expect.objectContaining({ method: "POST", body: JSON.stringify(input) }),
    );
    const options = fetchMock.mock.calls[0]?.[1];
    expect((options?.headers as Headers).get("Idempotency-Key")).toBe("select-alternative-1");
  });

  it.each([
    ["dismiss", "/daily-plan-fit-insight/dismissals", "dismissDailyPlanFitInsight"],
    ["reset", "/daily-plan-fit-insight/dismissal-resets", "resetDailyPlanFitInsightDismissal"],
  ] as const)("records an idempotent Plan Fit %s", async (_kind, path, method) => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _options?: RequestInit) =>
        new Response(JSON.stringify({ id: "feedback-1" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const input = { forDate: "2026-07-14", insightKey: "a".repeat(64) };

    await api[method]("workspace-1", input, "plan-fit-command-1");

    expect(fetchMock).toHaveBeenCalledWith(
      `/v1/workspaces/workspace-1${path}`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(input),
        headers: expect.any(Headers),
      }),
    );
    const options = fetchMock.mock.calls[0]?.[1];
    expect((options?.headers as Headers).get("Idempotency-Key")).toBe("plan-fit-command-1");
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

  it("retrieves a routine selection preference in the browser's explicit time zone", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            routineId: "routine-1",
            feedbackVersion: 0,
            activeEventCount: 0,
            score: 0,
            reason: null,
            updatedAt: null,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await api.getRoutineSelectionPreference(
      "workspace-1",
      "routine-1",
      "America/La_Paz",
      controller.signal,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/workspaces/workspace-1/routines/routine-1/selection-preference?timeZone=America%2FLa_Paz",
      expect.objectContaining({ method: "GET", signal: controller.signal }),
    );
  });

  it("records an idempotent routine selection preference with its optimistic version", async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _options?: RequestInit) =>
        new Response(
          JSON.stringify({
            routineId: "routine-1",
            feedbackVersion: 4,
            activeEventCount: 1,
            score: -100,
            reason: "You asked to see this routine less often (-100).",
            updatedAt: "2026-07-14T10:00:00.000Z",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const input = {
      kind: "less_often" as const,
      expectedFeedbackVersion: 3,
      timeZone: "America/La_Paz",
      sourcePlanId: "plan-1",
      sourcePlanItemId: "plan-item-1",
    };

    await api.recordRoutineSelectionPreference(
      "workspace-1",
      "routine-1",
      input,
      "selection-preference-attempt-1",
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/workspaces/workspace-1/routines/routine-1/selection-preference",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify(input),
        headers: expect.any(Headers),
      }),
    );
    const options = fetchMock.mock.calls[0]?.[1];
    expect((options?.headers as Headers).get("Idempotency-Key")).toBe(
      "selection-preference-attempt-1",
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

  it("requests read-only local advice with a generated UUID and cancellation signal", async () => {
    const requestId = "2f0f423e-b13a-4e4c-a34c-34ab0ee8e68c";
    const randomUUID = vi.fn(() => requestId);
    vi.stubGlobal("crypto", { randomUUID });
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ version: "schedule.advisor/v1", requestId }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    const result = await api.getSchedulingAdvice(
      "workspace-1",
      {
        date: "2026-07-13",
        expectedPlanId: "plan-1",
        expectedHeadVersion: 4,
      },
      controller.signal,
    );

    expect(randomUUID).toHaveBeenCalledOnce();
    expect(result.requestId).toBe(requestId);
    expect(fetchMock).toHaveBeenCalledWith(
      "/v1/workspaces/workspace-1/advisor/advice",
      expect.objectContaining({
        method: "POST",
        signal: controller.signal,
        body: JSON.stringify({
          version: "schedule.advisor/v1",
          requestId,
          date: "2026-07-13",
          focus: "both",
          expectedPlanId: "plan-1",
          expectedHeadVersion: 4,
        }),
      }),
    );
  });

  it("keeps the natural-language proposal lifecycle explicit, abortable, and idempotent", async () => {
    const requestId = "2f0f423e-b13a-4e4c-a34c-34ab0ee8e68c";
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            id: "proposal-1",
            version: "schedule.natural-language/v4",
            requestId,
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const generateInput = {
      version: "schedule.natural-language/v4" as const,
      requestId,
      prompt: "Prepare the launch checklist",
      referenceDate: "2026-07-16",
      timeZone: "America/La_Paz",
    };

    await api.generateNaturalLanguageProposal("workspace/one", generateInput, controller.signal);
    await api.updateNaturalLanguageProposal(
      "workspace/one",
      "proposal/one",
      {
        expectedVersion: 1,
        command: { type: "work_item.create", title: "Prepare the launch checklist" },
        userSelection: {
          priority: "medium",
          dueOn: "2026-07-20",
          planningDurationMinutes: 45,
        },
      },
      controller.signal,
    );
    await api.cancelNaturalLanguageProposal("workspace/one", "proposal/one", 2, controller.signal);
    await api.confirmNaturalLanguageProposal(
      "workspace/one",
      "proposal/one",
      2,
      "proposal-confirm-attempt-1",
      controller.signal,
    );

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/v1/workspaces/workspace%2Fone/natural-language/proposals",
      expect.objectContaining({
        method: "POST",
        signal: controller.signal,
        body: JSON.stringify(generateInput),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/v1/workspaces/workspace%2Fone/natural-language/proposals/proposal%2Fone",
      expect.objectContaining({
        method: "PATCH",
        signal: controller.signal,
        body: JSON.stringify({
          expectedVersion: 1,
          command: { type: "work_item.create", title: "Prepare the launch checklist" },
          userSelection: {
            priority: "medium",
            dueOn: "2026-07-20",
            planningDurationMinutes: 45,
          },
        }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/v1/workspaces/workspace%2Fone/natural-language/proposals/proposal%2Fone/cancellations",
      expect.objectContaining({
        method: "POST",
        signal: controller.signal,
        body: JSON.stringify({ expectedVersion: 2 }),
      }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      "/v1/workspaces/workspace%2Fone/natural-language/proposals/proposal%2Fone/confirmations",
      expect.objectContaining({
        method: "POST",
        signal: controller.signal,
        body: JSON.stringify({ expectedVersion: 2 }),
        headers: expect.any(Headers),
      }),
    );
    const confirmationHeaders = new Headers(fetchMock.mock.calls[3]?.[1]?.headers);
    expect(confirmationHeaders.get("Idempotency-Key")).toBe("proposal-confirm-attempt-1");
  });

  it.each([
    ["protocol version", "schedule.natural-language/v1", "2f0f423e-b13a-4e4c-a34c-34ab0ee8e68c"],
    ["request identity", "schedule.natural-language/v4", "97d55328-3527-434b-9e9e-2d22c3a73ddb"],
  ])("rejects a proposal response with a mismatched %s", async (_label, version, requestId) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ version, requestId }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );

    await expect(
      api.generateNaturalLanguageProposal("workspace-1", {
        version: "schedule.natural-language/v4",
        requestId: "2f0f423e-b13a-4e4c-a34c-34ab0ee8e68c",
        prompt: "Prepare the launch checklist",
        referenceDate: "2026-07-16",
        timeZone: "America/La_Paz",
      }),
    ).rejects.toMatchObject({ code: "natural_language.response_mismatch", status: 502 });
  });

  it("rejects a local-advisor response with a different request identity", async () => {
    vi.stubGlobal("crypto", {
      randomUUID: vi.fn(() => "2f0f423e-b13a-4e4c-a34c-34ab0ee8e68c"),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              version: "schedule.advisor/v1",
              requestId: "97d55328-3527-434b-9e9e-2d22c3a73ddb",
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );

    await expect(
      api.getSchedulingAdvice("workspace-1", {
        date: "2026-07-13",
        expectedPlanId: "plan-1",
        expectedHeadVersion: 4,
      }),
    ).rejects.toMatchObject({ code: "advisor.response_mismatch", status: 502 });
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
