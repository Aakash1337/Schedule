import { afterEach, describe, expect, it } from "vitest";

import { buildApp, isAllowedLocalProductHost } from "./app.js";

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
          ...(method === "GET" || method === "HEAD"
            ? {}
            : { payload: { proof: "unreachable-provider-proof" } }),
        });
        expect(response.statusCode, `${method} ${url}`).toBe(404);
      }
    }

    const callbackResponse = await app.inject({ method: "GET", url: "/v1/auth/callback" });
    expect(callbackResponse.statusCode).toBe(404);
    const hostedProbeResponse = await app.inject({
      method: "GET",
      url: "/v1/hosted/workspaces/00000000-0000-4000-8000-000000000001/probe",
    });
    expect(hostedProbeResponse.statusCode).toBe(404);

    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      const response = await app.inject({
        method,
        url: "/v1/hosted/workspaces/00000000-0000-4000-8000-000000000001/probe",
        headers: {
          origin: "https://hosted.schedule.test",
          cookie:
            "__Host-schedule_session=00000000-0000-4000-8000-000000000201.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA; __Host-schedule_csrf=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
          "x-schedule-csrf": "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        },
      });
      expect(response.statusCode, method).toBe(404);
    }
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
