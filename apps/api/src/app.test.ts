import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";

import { buildApp, isAllowedLocalProductHost, type HostedApiOptions } from "./app.js";
import { installErrorHandler } from "./http-errors.js";
import { installIpRateLimit } from "./product-routes.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("API infrastructure", () => {
  it("accepts only well-formed loopback authorities for the local product API", () => {
    for (const host of [
      "localhost",
      "LOCALHOST:5173",
      "127.0.0.1",
      "127.42.7.9:4000",
      "[::1]",
      "[0:0:0:0:0:0:0:1]:5173",
    ]) {
      expect(isAllowedLocalProductHost(host), host).toBe(true);
    }

    for (const host of [
      undefined,
      "",
      " localhost",
      "localhost.",
      "localhost:0",
      "localhost:65536",
      "localhost:invalid",
      "localhost.attacker.example",
      "127.0.0.1.attacker.example",
      "2130706433",
      "::1",
      "[::1",
      "[::1].attacker.example",
      "[::ffff:127.0.0.1]",
    ]) {
      expect(isAllowedLocalProductHost(host), String(host)).toBe(false);
    }
  });

  it("reports process liveness", async () => {
    const app = await buildApp();
    apps.push(app);
    const response = await app.inject({ method: "GET", url: "/health/live" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "alive" });
  });

  it("reports failed database readiness without exposing details", async () => {
    const app = await buildApp({
      readinessCheck: async () => {
        throw new Error("database password must not leak");
      },
    });
    apps.push(app);
    const response = await app.inject({ method: "GET", url: "/health/ready" });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({ status: "not_ready" });
    expect(response.body).not.toContain("password");
  });

  it("exposes only infrastructure capabilities for now", async () => {
    const app = await buildApp();
    apps.push(app);
    const response = await app.inject({ method: "GET", url: "/v1/system/info" });
    expect(response.json()).toMatchObject({
      productEndpointsEnabled: false,
      integrationEndpointsEnabled: false,
      hostedEndpointsEnabled: false,
    });
    const integrationResponse = await app.inject({
      method: "GET",
      url: "/v1/integrations/today?date=2026-07-13",
    });
    expect(integrationResponse.statusCode).toBe(404);
  });

  it("keeps the dormant hosted identity foundation unreachable over HTTP", async () => {
    const app = await buildApp();
    apps.push(app);

    const browserHeaders = {
      origin: "https://hosted.schedule.test",
      cookie:
        "__Host-schedule_session=00000000-0000-4000-8000-000000000201.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA; __Host-schedule_csrf=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      "x-schedule-csrf": "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    };
    for (const url of ["/v1/auth/login", "/v1/auth/session", "/v1/auth/logout"]) {
      for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const) {
        const response = await app.inject({
          method,
          url,
          headers: browserHeaders,
          ...(method === "GET" || method === "HEAD" ? {} : { payload: {} }),
        });
        expect(response.statusCode, `${method} ${url}`).toBe(404);
      }
    }

    const callbackResponse = await app.inject({ method: "GET", url: "/v1/auth/callback" });
    expect(callbackResponse.statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/" })).statusCode).toBe(404);
    for (const url of [
      "/v1/hosted/workspaces",
      "/v1/hosted/workspaces/00000000-0000-4000-8000-000000000001/probe",
      "/v1/hosted/workspaces/00000000-0000-4000-8000-000000000001/work-items",
      "/v1/hosted/workspaces/00000000-0000-4000-8000-000000000001/today/00000000-0000-4000-8000-000000000002/activity-events?date=2026-07-16",
    ]) {
      for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"] as const) {
        const response = await app.inject({
          method,
          url,
          headers: browserHeaders,
          ...(method === "GET" || method === "HEAD"
            ? {}
            : { payload: { title: "Unreachable hosted work item" } }),
        });
        expect(response.statusCode, `${method} ${url}`).toBe(404);
      }
    }
  });

  it("registers the hosted lifecycle and protected workspace surface only when supplied", async () => {
    const authenticator = { authenticate: vi.fn(async () => null) };
    const csrfGuard = { verify: vi.fn(() => true) };
    const hostedApi = {
      auth: {
        authenticator,
        csrfGuard,
        loginTransactionStarter: {},
        loginTransactionConsumer: {},
        authorizationRequestBuilder: {},
        tokenExchanger: {},
        identityVerifier: {},
        identityProvisioner: {},
        sessionIssuer: {},
        sessionRevoker: {},
        sessionPolicy: { idleTimeoutSeconds: 3_600, absoluteTtlSeconds: 86_400 },
        loginPolicy: {
          hostedOrigin: "https://hosted.schedule.test",
          issuer: "https://identity.schedule.test",
          clientId: "schedule-browser",
          redirectUri: "https://hosted.schedule.test/v1/auth/callback",
          returnToPath: "/",
          ttlSeconds: 300,
        },
      },
      boundary: {
        authenticator,
        csrfGuard,
        authorizer: { execute: vi.fn(async () => null) },
      },
      workspaces: { listWorkspaces: vi.fn(), createWorkspace: vi.fn() },
      workItems: {
        createWorkItem: vi.fn(),
        listWorkItems: vi.fn(),
        updateWorkItemStatus: vi.fn(),
      },
      today: {
        getToday: vi.fn(),
        getDailyPlanFitInsight: vi.fn(),
        getDailyPlanFitEffectiveness: vi.fn(),
        dismissDailyPlanFitInsight: vi.fn(),
        resetDailyPlanFitInsightDismissal: vi.fn(),
        generateToday: vi.fn(),
        recordActivity: vi.fn(),
      },
      webShell: {
        html: '<!doctype html><div id="root"></div><script src="/assets/hosted.js"></script>',
        icon: Buffer.from("<svg></svg>"),
        assets: new Map([
          [
            "hosted.js",
            { body: Buffer.from("globalThis.hosted = true;"), contentType: "text/javascript" },
          ],
        ]),
      },
      requestsPerMinute: 2,
    } as unknown as HostedApiOptions;
    const app = await buildApp({ hostedApi });
    apps.push(app);

    const systemInfo = await app.inject({ method: "GET", url: "/v1/system/info" });
    expect(systemInfo.json()).toMatchObject({ hostedEndpointsEnabled: true });
    const session = await app.inject({ method: "GET", url: "/v1/auth/session" });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toEqual({ authenticated: false });
    expect(session.headers["cache-control"]).toBe("no-store");
    expect(session.headers["set-cookie"]).toContain("__Host-schedule_csrf=");

    expect((await app.inject({ method: "GET", url: "/v1/auth/session" })).statusCode).toBe(200);
    const throttled = await app.inject({ method: "GET", url: "/v1/auth/session" });
    expect(throttled.statusCode).toBe(429);
    expect(throttled.headers["retry-after"]).toBeDefined();
    const shell = await app.inject({ method: "GET", url: "/" });
    expect(shell.statusCode).toBe(200);
    expect(shell.headers["content-security-policy"]).toContain("default-src 'none'");
    expect((await app.inject({ method: "GET", url: "/assets/hosted.js" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/favicon.svg" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/health/live" })).statusCode).toBe(200);

    const protectedApp = await buildApp({
      hostedApi: { ...hostedApi, requestsPerMinute: 120 },
    });
    apps.push(protectedApp);
    const protectedMutation = await protectedApp.inject({
      method: "POST",
      url: "/v1/hosted/workspaces/00000000-0000-4000-8000-000000000001/work-items",
      payload: { title: "Protected hosted work" },
    });
    expect(protectedMutation.statusCode).toBe(401);
    expect(hostedApi.workItems.createWorkItem).not.toHaveBeenCalled();
    const protectedWorkList = await protectedApp.inject({
      method: "GET",
      url: "/v1/hosted/workspaces/00000000-0000-4000-8000-000000000001/work-items",
    });
    expect(protectedWorkList.statusCode).toBe(401);
    expect(hostedApi.workItems.listWorkItems).not.toHaveBeenCalled();
    const protectedWorkUpdate = await protectedApp.inject({
      method: "PATCH",
      url: "/v1/hosted/workspaces/00000000-0000-4000-8000-000000000001/work-items/00000000-0000-4000-8000-000000000002",
      payload: { expectedVersion: 1, status: "done" },
    });
    expect(protectedWorkUpdate.statusCode).toBe(401);
    expect(hostedApi.workItems.updateWorkItemStatus).not.toHaveBeenCalled();
    const protectedToday = await protectedApp.inject({
      method: "GET",
      url: "/v1/hosted/workspaces/00000000-0000-4000-8000-000000000001/today?date=2026-07-16",
    });
    expect(protectedToday.statusCode).toBe(401);
    expect(hostedApi.today.getToday).not.toHaveBeenCalled();
    const protectedPlanFit = await protectedApp.inject({
      method: "GET",
      url: "/v1/hosted/workspaces/00000000-0000-4000-8000-000000000001/daily-plan-fit-insight?forDate=2026-07-16",
    });
    expect(protectedPlanFit.statusCode).toBe(401);
    expect(hostedApi.today.getDailyPlanFitInsight).not.toHaveBeenCalled();
    const protectedPlanFitEffectiveness = await protectedApp.inject({
      method: "GET",
      url: "/v1/hosted/workspaces/00000000-0000-4000-8000-000000000001/daily-plan-fit-insight/effectiveness",
    });
    expect(protectedPlanFitEffectiveness.statusCode).toBe(401);
    expect(hostedApi.today.getDailyPlanFitEffectiveness).not.toHaveBeenCalled();
    for (const [suffix, service] of [
      ["dismissals", hostedApi.today.dismissDailyPlanFitInsight],
      ["dismissal-resets", hostedApi.today.resetDailyPlanFitInsightDismissal],
    ] as const) {
      const response = await protectedApp.inject({
        method: "POST",
        url: `/v1/hosted/workspaces/00000000-0000-4000-8000-000000000001/daily-plan-fit-insight/${suffix}`,
        headers: { "idempotency-key": `protected-${suffix}` },
        payload: { forDate: "2026-07-16", insightKey: "a".repeat(64) },
      });
      expect(response.statusCode).toBe(401);
      expect(service).not.toHaveBeenCalled();
    }
    const protectedTodayActivity = await protectedApp.inject({
      method: "POST",
      url: "/v1/hosted/workspaces/00000000-0000-4000-8000-000000000001/today/00000000-0000-4000-8000-000000000002/activity-events?date=2026-07-16",
      headers: { "idempotency-key": "protected-today-action" },
      payload: {
        expectedPlanId: "00000000-0000-4000-8000-000000000003",
        expectedHeadVersion: 1,
        type: "completed",
        occurredAt: "2026-07-16T09:30:00.000Z",
      },
    });
    expect(protectedTodayActivity.statusCode).toBe(401);
    expect(hostedApi.today.recordActivity).not.toHaveBeenCalled();
    const protectedWorkspaceList = await protectedApp.inject({
      method: "GET",
      url: "/v1/hosted/workspaces",
    });
    expect(protectedWorkspaceList.statusCode).toBe(401);
    expect(hostedApi.workspaces.listWorkspaces).not.toHaveBeenCalled();
    const protectedWorkspaceCreate = await protectedApp.inject({
      method: "POST",
      url: "/v1/hosted/workspaces",
      payload: { name: "Protected workspace" },
    });
    expect(protectedWorkspaceCreate.statusCode).toBe(401);
    expect(hostedApi.workspaces.createWorkspace).not.toHaveBeenCalled();
  });

  it("bounds rate-limit client tracking under source churn", async () => {
    const boundedApp = Fastify({ logger: false });
    apps.push(boundedApp);
    installErrorHandler(boundedApp);
    installIpRateLimit(boundedApp, 1, 2);
    boundedApp.get("/probe", async () => ({ ok: true }));
    const probeFrom = (remoteAddress: string) =>
      boundedApp.inject({ method: "GET", url: "/probe", remoteAddress });
    expect((await probeFrom("192.0.2.1")).statusCode).toBe(200);
    expect((await probeFrom("192.0.2.1")).statusCode).toBe(429);
    expect((await probeFrom("192.0.2.2")).statusCode).toBe(200);
    expect((await probeFrom("192.0.2.3")).statusCode).toBe(200);
    expect((await probeFrom("192.0.2.1")).statusCode).toBe(200);
  });

  it("keeps health endpoints independent from the product Host guard", async () => {
    const app = await buildApp();
    apps.push(app);
    const response = await app.inject({
      method: "GET",
      url: "/health/live",
      headers: { host: "attacker.example" },
    });
    expect(response.statusCode).toBe(200);
  });
});
