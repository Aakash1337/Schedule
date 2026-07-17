import { browserSessionId, DomainError, userId, workspaceId } from "@schedule/domain";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  HostedPrincipalBoundaryDependencies,
  HostedRequestAuthenticator,
} from "./hosted-auth-boundary.js";
import {
  HOSTED_WORKSPACE_LIST_ROUTE,
  registerHostedWorkspaceRoutes,
  type HostedWorkspaceServices,
} from "./hosted-workspace-routes.js";
import { installErrorHandler } from "./http-errors.js";

const USER_ID = userId("00000000-0000-4000-8000-000000000101");
const SESSION_ID = browserSessionId("00000000-0000-4000-8000-000000000201");
const WORKSPACE_ID = workspaceId("00000000-0000-4000-8000-000000000301");
const principal = {
  userId: USER_ID,
  sessionId: SESSION_ID,
  idleExpiresAt: new Date("2026-07-15T01:00:00.000Z"),
  absoluteExpiresAt: new Date("2026-07-16T00:00:00.000Z"),
};
const workspace = {
  id: WORKSPACE_ID,
  name: "My Schedule",
  createdAt: new Date("2026-07-15T00:00:00.000Z"),
  updatedAt: new Date("2026-07-15T00:00:00.000Z"),
};
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function createApp(
  authenticator: HostedRequestAuthenticator,
  services: HostedWorkspaceServices,
  csrfGuard: HostedPrincipalBoundaryDependencies["csrfGuard"] = { verify: () => true },
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  apps.push(app);
  installErrorHandler(app);
  await registerHostedWorkspaceRoutes(app, { authenticator, csrfGuard }, services);
  await app.ready();
  return app;
}

describe("hosted workspace discovery", () => {
  it("lists only the authenticated principal's bounded workspace page", async () => {
    const listWorkspaces = vi.fn(async () => ({ items: [workspace], limit: 1, offset: 2 }));
    const app = await createApp(
      { authenticate: async () => principal },
      { listWorkspaces, createWorkspace: vi.fn() },
    );

    const response = await app.inject({
      method: "GET",
      url: `${HOSTED_WORKSPACE_LIST_ROUTE}?limit=1&offset=2`,
      headers: { "x-user-id": "00000000-0000-4000-8000-000000000999" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({
      items: [
        {
          ...workspace,
          createdAt: workspace.createdAt.toISOString(),
          updatedAt: workspace.updatedAt.toISOString(),
        },
      ],
      limit: 1,
      offset: 2,
    });
    expect(listWorkspaces).toHaveBeenCalledWith({ userId: USER_ID, limit: 1, offset: 2 });
  });

  it("creates one name-only workspace for the authenticated session", async () => {
    const createWorkspace = vi.fn(async () => workspace);
    const app = await createApp(
      { authenticate: async () => principal },
      { listWorkspaces: vi.fn(), createWorkspace },
    );

    const response = await app.inject({
      method: "POST",
      url: HOSTED_WORKSPACE_LIST_ROUTE,
      headers: {
        "x-user-id": "00000000-0000-4000-8000-000000000999",
        "x-session-id": "00000000-0000-4000-8000-000000000999",
      },
      payload: { name: "  Projects  " },
    });

    expect(response.statusCode).toBe(201);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({
      ...workspace,
      createdAt: workspace.createdAt.toISOString(),
      updatedAt: workspace.updatedAt.toISOString(),
    });
    expect(createWorkspace).toHaveBeenCalledWith({
      userId: USER_ID,
      sessionId: SESSION_ID,
      name: "Projects",
    });
  });

  it("rejects unauthenticated and malformed requests before workspace services", async () => {
    const listWorkspaces = vi.fn();
    const createWorkspace = vi.fn();
    const services = { listWorkspaces, createWorkspace };
    const unauthenticated = await createApp({ authenticate: async () => null }, services);
    expect(
      (await unauthenticated.inject({ method: "GET", url: HOSTED_WORKSPACE_LIST_ROUTE }))
        .statusCode,
    ).toBe(401);

    const authenticated = await createApp({ authenticate: async () => principal }, services);
    const malformed = await authenticated.inject({
      method: "GET",
      url: `${HOSTED_WORKSPACE_LIST_ROUTE}?offset=1001&unexpected=true`,
    });
    expect(malformed.statusCode).toBe(400);
    expect(listWorkspaces).not.toHaveBeenCalled();

    const malformedCreate = await authenticated.inject({
      method: "POST",
      url: HOSTED_WORKSPACE_LIST_ROUTE,
      payload: { name: "Projects", unexpected: true },
    });
    expect(malformedCreate.statusCode).toBe(400);

    const unverified = await createApp({ authenticate: async () => principal }, services, {
      verify: () => false,
    });
    expect(
      (
        await unverified.inject({
          method: "POST",
          url: HOSTED_WORKSPACE_LIST_ROUTE,
          payload: { name: "Projects" },
        })
      ).statusCode,
    ).toBe(403);
    expect(createWorkspace).not.toHaveBeenCalled();
  });

  it("redacts workspace repository failures", async () => {
    const secret = "private database diagnostic";
    const app = await createApp(
      { authenticate: async () => principal },
      {
        listWorkspaces: async () => {
          throw new Error(secret);
        },
        createWorkspace: vi.fn(),
      },
    );

    const response = await app.inject({ method: "GET", url: HOSTED_WORKSPACE_LIST_ROUTE });
    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain(secret);
  });

  it("redacts transaction authentication details from workspace creation", async () => {
    const secret = "private session state";
    const app = await createApp(
      { authenticate: async () => principal },
      {
        listWorkspaces: vi.fn(),
        createWorkspace: async () => {
          throw new DomainError("hosted.authentication_failed", secret);
        },
      },
    );

    const response = await app.inject({
      method: "POST",
      url: HOSTED_WORKSPACE_LIST_ROUTE,
      payload: { name: "Projects" },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      error: { code: "hosted.authentication_failed", message: "Authentication failed." },
    });
    expect(response.body).not.toContain(secret);
  });
});
