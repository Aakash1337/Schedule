import type { CurrentDailyPlan } from "@schedule/application";
import {
  browserSessionId,
  dailyPlanId,
  DomainError,
  localDate,
  planItemId,
  userId,
  workspaceId,
  type DailyPlanFitEffectiveness,
  type DailyPlanFitInsight,
} from "@schedule/domain";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  HOSTED_DAILY_PLAN_FIT_EFFECTIVENESS_ROUTE,
  HOSTED_DAILY_PLAN_FIT_DISMISSAL_RESET_ROUTE,
  HOSTED_DAILY_PLAN_FIT_DISMISSAL_ROUTE,
  HOSTED_DAILY_PLAN_FIT_INSIGHT_ROUTE,
  HOSTED_TODAY_ROUTE,
  HOSTED_TODAY_ACTIVITY_ROUTE,
  registerHostedTodayBoundary,
  type HostedTodayServices,
} from "./hosted-today-routes.js";
import { installErrorHandler } from "./http-errors.js";

const USER_ID = userId("00000000-0000-4000-8000-000000000101");
const SESSION_ID = browserSessionId("00000000-0000-4000-8000-000000000201");
const WORKSPACE_ID = workspaceId("00000000-0000-4000-8000-000000000301");
const OTHER_WORKSPACE_ID = workspaceId("00000000-0000-4000-8000-000000000302");
const PLAN_ID = dailyPlanId("00000000-0000-4000-8000-000000000401");
const ITEM_ID = planItemId("00000000-0000-4000-8000-000000000501");
const PLAN_FIT_INSIGHT_KEY = "a".repeat(64);
const principal = {
  userId: USER_ID,
  sessionId: SESSION_ID,
  idleExpiresAt: new Date("2026-07-16T10:00:00.000Z"),
  absoluteExpiresAt: new Date("2026-07-17T00:00:00.000Z"),
};
const authorization = Object.freeze({
  userId: USER_ID,
  sessionId: SESSION_ID,
  workspaceId: WORKSPACE_ID,
});
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

async function createHostedApp(
  getToday: HostedTodayServices["getToday"],
  recordActivity: HostedTodayServices["recordActivity"] = vi.fn(),
  generateToday: HostedTodayServices["generateToday"] = vi.fn(),
  getDailyPlanFitInsight: HostedTodayServices["getDailyPlanFitInsight"] = vi.fn(),
  dismissDailyPlanFitInsight: HostedTodayServices["dismissDailyPlanFitInsight"] = vi.fn(),
  resetDailyPlanFitInsightDismissal: HostedTodayServices["resetDailyPlanFitInsightDismissal"] = vi.fn(),
  getDailyPlanFitEffectiveness: HostedTodayServices["getDailyPlanFitEffectiveness"] = vi.fn(),
): Promise<FastifyInstance> {
  const app = Fastify();
  apps.push(app);
  installErrorHandler(app);
  await registerHostedTodayBoundary(
    app,
    {
      csrfGuard: { verify: () => true },
      authenticator: { authenticate: async () => principal },
      authorizer: {
        execute: async (candidate, requestedWorkspace) =>
          candidate.userId === USER_ID && requestedWorkspace === WORKSPACE_ID
            ? Object.freeze({ ...candidate, workspaceId: requestedWorkspace })
            : null,
      },
    },
    {
      getToday,
      getDailyPlanFitInsight,
      getDailyPlanFitEffectiveness,
      dismissDailyPlanFitInsight,
      resetDailyPlanFitInsightDismissal,
      generateToday,
      recordActivity,
    },
  );
  await app.ready();
  return app;
}

function todayPath(workspace: string = WORKSPACE_ID): string {
  return `${HOSTED_TODAY_ROUTE.replace(":workspaceId", workspace)}?date=2026-07-16`;
}

function todayActivityPath(workspace: string = WORKSPACE_ID, item: string = ITEM_ID): string {
  return `${HOSTED_TODAY_ACTIVITY_ROUTE.replace(":workspaceId", workspace).replace(":itemId", item)}?date=2026-07-16`;
}

function planFitInsightPath(workspace: string = WORKSPACE_ID): string {
  return `${HOSTED_DAILY_PLAN_FIT_INSIGHT_ROUTE.replace(":workspaceId", workspace)}?forDate=2026-07-16`;
}

function planFitEffectivenessPath(workspace: string = WORKSPACE_ID): string {
  return HOSTED_DAILY_PLAN_FIT_EFFECTIVENESS_ROUTE.replace(":workspaceId", workspace);
}

function planFitFeedbackPath(
  action: "dismiss" | "reset",
  workspace: string = WORKSPACE_ID,
): string {
  const route =
    action === "dismiss"
      ? HOSTED_DAILY_PLAN_FIT_DISMISSAL_ROUTE
      : HOSTED_DAILY_PLAN_FIT_DISMISSAL_RESET_ROUTE;
  return route.replace(":workspaceId", workspace);
}

describe("hosted Today route", () => {
  it("returns only the bounded current-plan projection from canonical authority", async () => {
    const getToday = vi.fn(
      async () =>
        ({
          plan: {
            id: PLAN_ID,
            items: [
              {
                id: ITEM_ID,
                title: "Deep work",
                scheduledMinutes: 45,
                activityState: "started",
                reasons: ["private planner reason"],
              },
            ],
            totalMinutes: 45,
            inputSnapshot: { private: true },
          },
          headVersion: 9,
        }) as unknown as CurrentDailyPlan,
    );
    const app = await createHostedApp(getToday);

    const response = await app.inject({
      method: "GET",
      url: todayPath(WORKSPACE_ID.toUpperCase()),
      headers: { "x-user-id": "spoofed", "x-workspace-id": OTHER_WORKSPACE_ID },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({
      date: "2026-07-16",
      planId: PLAN_ID,
      headVersion: 9,
      items: [{ id: ITEM_ID, title: "Deep work", scheduledMinutes: 45, activityState: "started" }],
      totalMinutes: 45,
    });
    expect(response.body).not.toContain("private");
    expect(getToday).toHaveBeenCalledWith({ authorization, date: localDate("2026-07-16") });
  });

  it("returns an empty day when no current plan exists", async () => {
    const getToday = vi
      .fn()
      .mockRejectedValue(new DomainError("planning.current_not_found", "private plan detail"));
    const app = await createHostedApp(getToday);

    const response = await app.inject({ method: "GET", url: todayPath() });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      date: "2026-07-16",
      planId: null,
      headVersion: null,
      items: [],
      totalMinutes: 0,
    });
    expect(response.body).not.toContain("private plan detail");
  });

  it("rejects invalid dates and unknown query fields before reading a plan", async () => {
    const getToday = vi.fn();
    const app = await createHostedApp(getToday);
    const base = HOSTED_TODAY_ROUTE.replace(":workspaceId", WORKSPACE_ID);

    for (const query of ["date=2026-02-30", "date=2026-07-16&limit=20", "date="]) {
      const response = await app.inject({ method: "GET", url: `${base}?${query}` });
      expect(response.statusCode).toBe(400);
    }
    expect(getToday).not.toHaveBeenCalled();
  });

  it("keeps tenant denial and revoked membership details private", async () => {
    const getToday = vi
      .fn()
      .mockRejectedValue(new DomainError("workspace.not_found", "private membership detail"));
    const app = await createHostedApp(getToday);

    const denied = await app.inject({ method: "GET", url: todayPath(OTHER_WORKSPACE_ID) });
    const revoked = await app.inject({ method: "GET", url: todayPath() });

    expect(denied.statusCode).toBe(404);
    expect(revoked.statusCode).toBe(404);
    expect(revoked.json()).toMatchObject({
      error: { code: "workspace.not_found", message: "The requested workspace does not exist." },
    });
    expect(revoked.body).not.toContain("private membership detail");
    expect(getToday).toHaveBeenCalledOnce();
  });

  it("returns only authorized bounded Plan Fit guidance", async () => {
    const getDailyPlanFitInsight = vi.fn(
      async () =>
        ({
          forDate: localDate("2026-07-16"),
          status: "suggested",
          disposition: "available",
          sampleCount: 3,
          minimumSamples: 3,
          suggestedTargetMinutes: 90,
          suggestedTargetTaskCount: 2,
          insightKey: PLAN_FIT_INSIGHT_KEY,
          dismissedAt: null,
          windowStartedOn: localDate("2026-04-17"),
          windowEndedOn: localDate("2026-07-15"),
          lookbackDays: 90,
          maximumSamples: 28,
          evaluatedAt: new Date("2026-07-16T08:00:00.000Z"),
          typicalPlannedMinutes: 180,
          typicalCompletedMinutes: 90,
          materialThresholdMinutes: 45,
          typicalPlannedTaskCount: 4,
          typicalCompletedTaskCount: 2,
          materialThresholdTaskCount: 1,
        }) satisfies DailyPlanFitInsight,
    );
    const app = await createHostedApp(vi.fn(), vi.fn(), vi.fn(), getDailyPlanFitInsight);

    const response = await app.inject({
      method: "GET",
      url: planFitInsightPath(WORKSPACE_ID.toUpperCase()),
      headers: { "x-workspace-id": OTHER_WORKSPACE_ID },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      forDate: "2026-07-16",
      status: "suggested",
      disposition: "available",
      sampleCount: 3,
      minimumSamples: 3,
      suggestedTargetMinutes: 90,
      suggestedTargetTaskCount: 2,
      insightKey: PLAN_FIT_INSIGHT_KEY,
    });
    expect(response.body).not.toContain("typicalPlannedMinutes");
    expect(getDailyPlanFitInsight).toHaveBeenCalledWith({
      authorization,
      forDate: localDate("2026-07-16"),
    });
  });

  it("rejects invalid Plan Fit dates and redacts revoked access", async () => {
    const getDailyPlanFitInsight = vi
      .fn()
      .mockRejectedValue(new DomainError("workspace.not_found", "private membership detail"));
    const app = await createHostedApp(vi.fn(), vi.fn(), vi.fn(), getDailyPlanFitInsight);
    const base = HOSTED_DAILY_PLAN_FIT_INSIGHT_ROUTE.replace(":workspaceId", WORKSPACE_ID);

    for (const query of ["forDate=2026-02-30", "forDate=2026-07-16&limit=20", "forDate="]) {
      expect((await app.inject({ method: "GET", url: `${base}?${query}` })).statusCode).toBe(400);
    }
    const denied = await app.inject({ method: "GET", url: planFitInsightPath(OTHER_WORKSPACE_ID) });
    const revoked = await app.inject({ method: "GET", url: planFitInsightPath() });

    expect(denied.statusCode).toBe(404);
    expect(revoked.statusCode).toBe(404);
    expect(revoked.body).not.toContain("private membership detail");
    expect(getDailyPlanFitInsight).toHaveBeenCalledOnce();
  });

  it("returns only a thresholded aggregate Plan Fit effectiveness projection", async () => {
    const getDailyPlanFitEffectiveness = vi.fn(
      async () =>
        ({
          usesConsidered: 5,
          resolvedUseCount: 4,
          pendingUseCount: 1,
          notEvaluableUseCount: 0,
          revisedUseCount: 1,
          eligibleResolvedUseCount: 3,
          exactSuggestionUseCount: 3,
          editedSuggestionUseCount: 2,
          appliedTargetMinutes: 300,
          scheduledMinutes: 240,
          completedMinutes: 180,
          appliedTargetTaskCount: 12,
          scheduledTaskCount: 9,
          completedTaskCount: 7,
          scheduledMinutesRateBasisPoints: 8_000,
          scheduledTasksRateBasisPoints: 7_500,
          completionMinutesRateBasisPoints: 7_500,
          completionTasksRateBasisPoints: 7_778,
        }) satisfies DailyPlanFitEffectiveness,
    );
    const app = await createHostedApp(
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      getDailyPlanFitEffectiveness,
    );

    const response = await app.inject({
      method: "GET",
      url: planFitEffectivenessPath(WORKSPACE_ID.toUpperCase()),
      headers: { "x-workspace-id": OTHER_WORKSPACE_ID },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({
      usesConsidered: 5,
      eligibleResolvedUseCount: 3,
      minimumComparableUses: 3,
      pendingUseCount: 1,
      revisedUseCount: 1,
      notEvaluableUseCount: 0,
      exactSuggestionUseCount: 3,
      editedSuggestionUseCount: 2,
      scheduledMinutesRateBasisPoints: 8_000,
      scheduledTasksRateBasisPoints: 7_500,
      completionMinutesRateBasisPoints: 7_500,
      completionTasksRateBasisPoints: 7_778,
    });
    expect(response.body).not.toContain("appliedTargetMinutes");
    expect(response.body).not.toContain("resolvedUseCount");
    expect(getDailyPlanFitEffectiveness).toHaveBeenCalledWith({ authorization });
  });

  it("withholds hosted Plan Fit rates below three comparable uses", async () => {
    const getDailyPlanFitEffectiveness = vi.fn(async () => ({
      usesConsidered: 2,
      resolvedUseCount: 2,
      pendingUseCount: 0,
      notEvaluableUseCount: 0,
      revisedUseCount: 0,
      eligibleResolvedUseCount: 2,
      exactSuggestionUseCount: 1,
      editedSuggestionUseCount: 1,
      appliedTargetMinutes: 180,
      scheduledMinutes: 150,
      completedMinutes: 120,
      appliedTargetTaskCount: 6,
      scheduledTaskCount: 5,
      completedTaskCount: 4,
      scheduledMinutesRateBasisPoints: 8_333,
      scheduledTasksRateBasisPoints: 8_333,
      completionMinutesRateBasisPoints: 8_000,
      completionTasksRateBasisPoints: 8_000,
    }));
    const app = await createHostedApp(
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      getDailyPlanFitEffectiveness,
    );

    const response = await app.inject({ method: "GET", url: planFitEffectivenessPath() });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      eligibleResolvedUseCount: 2,
      scheduledMinutesRateBasisPoints: null,
      scheduledTasksRateBasisPoints: null,
      completionMinutesRateBasisPoints: null,
      completionTasksRateBasisPoints: null,
    });
  });

  it("rejects Plan Fit effectiveness query fields and redacts revoked access", async () => {
    const getDailyPlanFitEffectiveness = vi
      .fn()
      .mockRejectedValue(new DomainError("workspace.not_found", "private membership detail"));
    const app = await createHostedApp(
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      getDailyPlanFitEffectiveness,
    );

    expect(
      (await app.inject({ method: "GET", url: `${planFitEffectivenessPath()}?limit=28` }))
        .statusCode,
    ).toBe(400);
    const denied = await app.inject({
      method: "GET",
      url: planFitEffectivenessPath(OTHER_WORKSPACE_ID),
    });
    const revoked = await app.inject({ method: "GET", url: planFitEffectivenessPath() });

    expect(denied.statusCode).toBe(404);
    expect(revoked.statusCode).toBe(404);
    expect(revoked.body).not.toContain("private membership detail");
    expect(getDailyPlanFitEffectiveness).toHaveBeenCalledOnce();
  });

  it("records exact-key Plan Fit dismissal and reset without exposing feedback records", async () => {
    const dismissDailyPlanFitInsight = vi.fn(async () => undefined);
    const resetDailyPlanFitInsightDismissal = vi.fn(async () => undefined);
    const app = await createHostedApp(
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      dismissDailyPlanFitInsight,
      resetDailyPlanFitInsightDismissal,
    );
    const payload = { forDate: "2026-07-16", insightKey: PLAN_FIT_INSIGHT_KEY };

    const dismissed = await app.inject({
      method: "POST",
      url: planFitFeedbackPath("dismiss", WORKSPACE_ID.toUpperCase()),
      headers: { "idempotency-key": "  hosted-fit-dismiss-1  " },
      payload,
    });
    const reset = await app.inject({
      method: "POST",
      url: planFitFeedbackPath("reset", WORKSPACE_ID.toUpperCase()),
      headers: { "idempotency-key": "  hosted-fit-reset-1  " },
      payload,
    });

    expect(dismissed.statusCode).toBe(204);
    expect(dismissed.body).toBe("");
    expect(dismissed.headers["cache-control"]).toBe("no-store");
    expect(reset.statusCode).toBe(204);
    expect(reset.body).toBe("");
    expect(dismissDailyPlanFitInsight).toHaveBeenCalledWith({
      authorization,
      forDate: localDate("2026-07-16"),
      insightKey: PLAN_FIT_INSIGHT_KEY,
      idempotencyKey: "hosted-fit-dismiss-1",
    });
    expect(resetDailyPlanFitInsightDismissal).toHaveBeenCalledWith({
      authorization,
      forDate: localDate("2026-07-16"),
      insightKey: PLAN_FIT_INSIGHT_KEY,
      idempotencyKey: "hosted-fit-reset-1",
    });
  });

  it("rejects malformed Plan Fit feedback before mutation and redacts revoked access", async () => {
    const dismissDailyPlanFitInsight = vi
      .fn()
      .mockRejectedValue(new DomainError("workspace.not_found", "private membership detail"));
    const app = await createHostedApp(
      vi.fn(),
      vi.fn(),
      vi.fn(),
      vi.fn(),
      dismissDailyPlanFitInsight,
    );
    const valid = { forDate: "2026-07-16", insightKey: PLAN_FIT_INSIGHT_KEY };
    const invalidRequests = [
      { headers: {}, payload: valid },
      { headers: { "idempotency-key": "feedback-1" }, payload: { ...valid, extra: true } },
      {
        headers: { "idempotency-key": "feedback-2" },
        payload: { ...valid, forDate: "2026-02-30" },
      },
      {
        headers: { "idempotency-key": "feedback-3" },
        payload: { ...valid, insightKey: "A".repeat(64) },
      },
    ];
    for (const request of invalidRequests) {
      const response = await app.inject({
        method: "POST",
        url: planFitFeedbackPath("dismiss"),
        ...request,
      });
      expect(response.statusCode).toBe(400);
    }
    expect(dismissDailyPlanFitInsight).not.toHaveBeenCalled();

    const denied = await app.inject({
      method: "POST",
      url: planFitFeedbackPath("dismiss", OTHER_WORKSPACE_ID),
      headers: { "idempotency-key": "feedback-4" },
      payload: valid,
    });
    const revoked = await app.inject({
      method: "POST",
      url: planFitFeedbackPath("dismiss"),
      headers: { "idempotency-key": "feedback-5" },
      payload: valid,
    });

    expect(denied.statusCode).toBe(404);
    expect(revoked.statusCode).toBe(404);
    expect(revoked.body).not.toContain("private membership detail");
    expect(dismissDailyPlanFitInsight).toHaveBeenCalledOnce();
  });

  it("generates one bounded first plan with an exact reviewed Plan Fit key", async () => {
    const generateToday = vi.fn(async () => undefined);
    const app = await createHostedApp(vi.fn(), vi.fn(), generateToday);

    const response = await app.inject({
      method: "POST",
      url: todayPath(WORKSPACE_ID.toUpperCase()),
      headers: {
        "idempotency-key": "  hosted-first-plan-1  ",
        "x-user-id": "spoofed",
        "x-workspace-id": OTHER_WORKSPACE_ID,
      },
      payload: {
        timeZone: "America/La_Paz",
        window: {
          startsAt: "2026-07-16T13:00:00.000Z",
          endsAt: "2026-07-16T21:00:00.000Z",
        },
        targetMinutes: 180,
        targetTaskCount: 4,
        planFitInsightKey: PLAN_FIT_INSIGHT_KEY,
      },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toBe("");
    expect(generateToday).toHaveBeenCalledWith({
      authorization,
      date: localDate("2026-07-16"),
      timeZone: "America/La_Paz",
      window: {
        startsAt: new Date("2026-07-16T13:00:00.000Z"),
        endsAt: new Date("2026-07-16T21:00:00.000Z"),
      },
      targetMinutes: 180,
      targetTaskCount: 4,
      planFitInsightKey: PLAN_FIT_INSIGHT_KEY,
      idempotencyKey: "hosted-first-plan-1",
    });
  });

  it("rejects invalid, cross-day, or over-broad hosted plan requests before mutation", async () => {
    const generateToday = vi.fn();
    const app = await createHostedApp(vi.fn(), vi.fn(), generateToday);
    const valid = {
      timeZone: "America/La_Paz",
      window: {
        startsAt: "2026-07-16T13:00:00.000Z",
        endsAt: "2026-07-16T21:00:00.000Z",
      },
      targetMinutes: 180,
      targetTaskCount: 4,
      planFitInsightKey: null,
    };
    const attempts = [
      { payload: { ...valid, timeZone: "Mars/Olympus_Mons" }, key: "plan-1" },
      {
        payload: {
          ...valid,
          window: { ...valid.window, endsAt: "2026-07-16T12:00:00.000Z" },
        },
        key: "plan-2",
      },
      {
        payload: {
          ...valid,
          window: { ...valid.window, startsAt: "2026-07-15T13:00:00.000Z" },
        },
        key: "plan-3",
      },
      { payload: { ...valid, targetMinutes: 0 }, key: "plan-4" },
      { payload: { ...valid, targetMinutes: 1_441 }, key: "plan-5" },
      { payload: { ...valid, targetTaskCount: 65 }, key: "plan-6" },
      { payload: { ...valid, planFitInsightKey: "not-a-key" }, key: "plan-7" },
      { payload: { ...valid, availableContexts: ["private"] }, key: "plan-8" },
      { payload: valid, key: " " },
    ];

    for (const attempt of attempts) {
      const response = await app.inject({
        method: "POST",
        url: todayPath(),
        headers: { "idempotency-key": attempt.key },
        payload: attempt.payload,
      });
      expect(response.statusCode).toBe(400);
    }
    expect(generateToday).not.toHaveBeenCalled();
  });

  it("redacts revoked membership details from hosted plan generation", async () => {
    const generateToday = vi
      .fn()
      .mockRejectedValue(new DomainError("workspace.not_found", "private membership detail"));
    const app = await createHostedApp(vi.fn(), vi.fn(), generateToday);

    const response = await app.inject({
      method: "POST",
      url: todayPath(),
      headers: { "idempotency-key": "revoked-plan" },
      payload: {
        timeZone: "America/La_Paz",
        window: {
          startsAt: "2026-07-16T13:00:00.000Z",
          endsAt: "2026-07-16T21:00:00.000Z",
        },
        targetMinutes: 180,
        targetTaskCount: 4,
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: { code: "workspace.not_found", message: "The requested workspace does not exist." },
    });
    expect(response.body).not.toContain("private membership detail");
  });

  it("records only a bounded Today action with canonical authority and idempotency", async () => {
    const getToday = vi.fn();
    const recordActivity = vi.fn(async () => undefined);
    const app = await createHostedApp(getToday, recordActivity);

    const response = await app.inject({
      method: "POST",
      url: todayActivityPath(WORKSPACE_ID.toUpperCase(), ITEM_ID.toUpperCase()),
      headers: {
        "idempotency-key": "  hosted-today-action-1  ",
        "x-user-id": "spoofed",
        "x-workspace-id": OTHER_WORKSPACE_ID,
      },
      payload: {
        expectedPlanId: PLAN_ID.toUpperCase(),
        expectedHeadVersion: 9,
        type: "skipped",
        occurredAt: "2026-07-16T09:30:00.000Z",
      },
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toBe("");
    expect(recordActivity).toHaveBeenCalledWith({
      authorization,
      date: localDate("2026-07-16"),
      expectedPlanId: PLAN_ID,
      itemId: ITEM_ID,
      expectedHeadVersion: 9,
      type: "skipped",
      occurredAt: new Date("2026-07-16T09:30:00.000Z"),
      idempotencyKey: "hosted-today-action-1",
    });
    expect(getToday).not.toHaveBeenCalled();
  });

  it("rejects unsupported or over-broad Today actions before mutation", async () => {
    const recordActivity = vi.fn();
    const app = await createHostedApp(vi.fn(), recordActivity);
    const valid = {
      expectedPlanId: PLAN_ID,
      expectedHeadVersion: 9,
      type: "started",
      occurredAt: "2026-07-16T09:30:00.000Z",
    };
    const attempts = [
      { url: todayActivityPath(), payload: { ...valid, type: "deferred" }, key: "action-1" },
      { url: todayActivityPath(), payload: { ...valid, reason: "too broad" }, key: "action-2" },
      { url: todayActivityPath(), payload: { ...valid, expectedHeadVersion: 0 }, key: "action-3" },
      {
        url: `${HOSTED_TODAY_ACTIVITY_ROUTE.replace(":workspaceId", WORKSPACE_ID).replace(":itemId", ITEM_ID)}?date=2026-02-30`,
        payload: valid,
        key: "action-4",
      },
      { url: todayActivityPath(), payload: valid, key: " " },
    ];

    for (const attempt of attempts) {
      const response = await app.inject({
        method: "POST",
        url: attempt.url,
        headers: { "idempotency-key": attempt.key },
        payload: attempt.payload,
      });
      expect(response.statusCode).toBe(400);
    }
    expect(recordActivity).not.toHaveBeenCalled();
  });

  it("redacts revoked membership details from Today actions", async () => {
    const recordActivity = vi
      .fn()
      .mockRejectedValue(new DomainError("workspace.not_found", "private membership detail"));
    const app = await createHostedApp(vi.fn(), recordActivity);

    const response = await app.inject({
      method: "POST",
      url: todayActivityPath(),
      headers: { "idempotency-key": "revoked-action" },
      payload: {
        expectedPlanId: PLAN_ID,
        expectedHeadVersion: 9,
        type: "started",
        occurredAt: "2026-07-16T09:30:00.000Z",
      },
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({
      error: { code: "workspace.not_found", message: "The requested workspace does not exist." },
    });
    expect(response.body).not.toContain("private membership detail");
  });
});
