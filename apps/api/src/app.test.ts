import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("API infrastructure", () => {
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
    expect(response.json()).toMatchObject({ productEndpointsEnabled: false });
  });
});
