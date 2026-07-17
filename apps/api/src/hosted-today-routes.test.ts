import type { CurrentDailyPlan } from "@schedule/application";
import {
  browserSessionId,
  dailyPlanId,
  DomainError,
  localDate,
  planItemId,
  userId,
  workspaceId,
} from "@schedule/domain";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
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
    { getToday, recordActivity },
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
        type: "completed",
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
      type: "completed",
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
      { url: todayActivityPath(), payload: { ...valid, type: "skipped" }, key: "action-1" },
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
