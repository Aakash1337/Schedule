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
    for (const url of [
      "/v1/hosted/workspaces/00000000-0000-4000-8000-000000000001/probe",
      "/v1/hosted/workspaces/00000000-0000-4000-8000-000000000001/work-items",
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
      workItems: { createWorkItem: vi.fn() },
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
