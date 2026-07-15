import { browserSessionId, userId, workspaceId } from "@schedule/domain";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  registerHostedWorkspaceBoundary,
  type HostedRequestAuthenticator,
  type HostedRequestCsrfGuard,
  type HostedWorkspaceAuthorizer,
} from "./hosted-auth-boundary.js";
import {
  HostedBrowserCsrfGuard,
  HostedBrowserSessionAuthenticator,
  HOSTED_CSRF_COOKIE_NAME,
  HOSTED_CSRF_HEADER_NAME,
  HOSTED_SESSION_COOKIE_NAME,
} from "./hosted-browser-session.js";
import { installErrorHandler } from "./http-errors.js";

const USER_ID = userId("00000000-0000-4000-8000-000000000101");
const OTHER_USER_ID = userId("00000000-0000-4000-8000-000000000102");
const SESSION_ID = browserSessionId("00000000-0000-4000-8000-000000000201");
const WORKSPACE_ID = workspaceId("00000000-0000-4000-8000-000000000301");
const OTHER_WORKSPACE_ID = workspaceId("00000000-0000-4000-8000-000000000302");

const principal = {
  userId: USER_ID,
  sessionId: SESSION_ID,
  idleExpiresAt: new Date("2026-07-15T01:00:00.000Z"),
  absoluteExpiresAt: new Date("2026-07-16T00:00:00.000Z"),
};

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => app.close()));
});

function authorizerFor(allowedWorkspace = WORKSPACE_ID): HostedWorkspaceAuthorizer {
  return {
    execute: vi.fn(async (candidate, requestedWorkspace) =>
      candidate.userId === USER_ID && requestedWorkspace === allowedWorkspace
        ? Object.freeze({ ...candidate, workspaceId: requestedWorkspace })
        : null,
    ),
  };
}

async function createBoundaryApp(
  authenticator: HostedRequestAuthenticator,
  authorizer: HostedWorkspaceAuthorizer = authorizerFor(),
  logLines?: string[],
  csrfGuard: HostedRequestCsrfGuard = { verify: () => true },
): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      logLines === undefined
        ? false
        : {
            level: "error",
            stream: { write: (message: string) => logLines.push(message) },
          },
  });
  apps.push(app);
  installErrorHandler(app);
  await registerHostedWorkspaceBoundary(
    app,
    { authenticator, csrfGuard, authorizer },
    async (hosted, access) => {
      hosted.get(
        "/v1/hosted/workspaces/:workspaceId/probe",
        {
          onSend: async (_request, reply, payload) => {
            reply.header("cache-control", "public, max-age=3600");
            return payload;
          },
        },
        async (request, reply) => {
          reply.header("cache-control", "public, max-age=3600");
          const authorization = access.authorization(request);
          return {
            userId: authorization.userId,
            sessionId: authorization.sessionId,
            workspaceId: authorization.workspaceId,
            frozen: Object.isFrozen(authorization),
          };
        },
      );
      hosted.post("/v1/hosted/workspaces/:workspaceId/probe", async (request) => {
        const authorization = access.authorization(request);
        return {
          userId: authorization.userId,
          sessionId: authorization.sessionId,
          workspaceId: authorization.workspaceId,
          frozen: Object.isFrozen(authorization),
        };
      });
    },
  );
  await app.ready();
  return app;
}

describe("dormant hosted workspace request boundary", () => {
  it("authenticates once and exposes only an immutable authorized context", async () => {
    const authenticate = vi.fn(async () => principal);
    const authorizer = authorizerFor();
    const app = await createBoundaryApp({ authenticate }, authorizer);

    const response = await app.inject({
      method: "GET",
      url: `/v1/hosted/workspaces/${WORKSPACE_ID.toUpperCase()}/probe`,
      headers: { "x-user-id": OTHER_USER_ID, "x-workspace-id": OTHER_WORKSPACE_ID },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toEqual({
      userId: USER_ID,
      sessionId: SESSION_ID,
      workspaceId: WORKSPACE_ID,
      frozen: true,
    });
    expect(authenticate).toHaveBeenCalledTimes(1);
    expect(authorizer.execute).toHaveBeenCalledWith(
      { userId: USER_ID, sessionId: SESSION_ID },
      WORKSPACE_ID,
    );
    expect(Object.isFrozen(vi.mocked(authorizer.execute).mock.calls[0]?.[0])).toBe(true);
  });

  it.each([
    ["missing", null],
    ["malformed", { ...principal, userId: userId("caller-controlled") }],
  ])(
    "returns the same browser-neutral authentication failure for %s principals",
    async (_label, value) => {
      const app = await createBoundaryApp({ authenticate: async () => value });
      const response = await app.inject({
        method: "GET",
        url: `/v1/hosted/workspaces/${WORKSPACE_ID}/probe`,
      });

      expect(response.statusCode).toBe(401);
      expect(response.headers["www-authenticate"]).toBeUndefined();
      expect(response.json()).toMatchObject({
        error: { code: "hosted.authentication_failed", message: "Authentication failed." },
      });
    },
  );

  it("makes malformed and all denied workspace access indistinguishable", async () => {
    const app = await createBoundaryApp({ authenticate: async () => principal }, authorizerFor());
    const responses = await Promise.all(
      ["not-a-uuid", OTHER_WORKSPACE_ID].map(async (candidate) =>
        app.inject({ method: "GET", url: `/v1/hosted/workspaces/${candidate}/probe` }),
      ),
    );

    for (const response of responses) {
      expect(response.statusCode).toBe(404);
      expect(response.json().error).toEqual({
        code: "workspace.not_found",
        message: "The requested workspace does not exist.",
      });
    }
  });

  it.each(["verification", "authentication", "authorization"] as const)(
    "redacts internal %s failures behind one temporary-unavailability response",
    async (failure) => {
      const secret = `${failure}-private-diagnostic`;
      const logLines: string[] = [];
      const app = await createBoundaryApp(
        {
          authenticate: () => {
            if (failure === "authentication") throw new Error(secret);
            return Promise.resolve(principal);
          },
        },
        {
          execute: async () => {
            if (failure === "authorization") throw new Error(secret);
            return { userId: USER_ID, sessionId: SESSION_ID, workspaceId: WORKSPACE_ID };
          },
        },
        logLines,
        {
          verify: () => {
            if (failure === "verification") throw new Error(secret);
            return true;
          },
        },
      );
      const response = await app.inject({
        method: "GET",
        url: `/v1/hosted/workspaces/${WORKSPACE_ID}/probe`,
      });

      expect(response.statusCode).toBe(503);
      expect(response.body).not.toContain(secret);
      expect(logLines.join("\n")).not.toContain(secret);
      expect(response.json()).toMatchObject({
        error: {
          code: "hosted.authorization_unavailable",
          message: "Hosted authorization is temporarily unavailable.",
        },
      });
    },
  );

  it("rejects an inconsistent authorizer result instead of crossing workspace scope", async () => {
    const app = await createBoundaryApp(
      { authenticate: async () => principal },
      {
        execute: async () => ({
          userId: USER_ID,
          sessionId: SESSION_ID,
          workspaceId: OTHER_WORKSPACE_ID,
        }),
      },
    );
    const response = await app.inject({
      method: "GET",
      url: `/v1/hosted/workspaces/${WORKSPACE_ID}/probe`,
    });
    expect(response.statusCode).toBe(503);
  });

  it("rejects unsafe browser requests before authentication and workspace authorization", async () => {
    const authenticate = vi.fn(async () => principal);
    const authorizer = authorizerFor();
    const verify = vi.fn(() => false);
    const app = await createBoundaryApp({ authenticate }, authorizer, undefined, { verify });

    const response = await app.inject({
      method: "POST",
      url: `/v1/hosted/workspaces/${WORKSPACE_ID}/probe`,
    });

    expect(response.statusCode).toBe(403);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["www-authenticate"]).toBeUndefined();
    expect(response.json()).toMatchObject({
      error: { code: "hosted.csrf_failed", message: "Request verification failed." },
    });
    expect(verify).toHaveBeenCalledOnce();
    expect(authenticate).not.toHaveBeenCalled();
    expect(authorizer.execute).not.toHaveBeenCalled();
  });

  it("awaits asynchronous request verification before authentication and authorization", async () => {
    const order: string[] = [];
    const authenticate = vi.fn(async () => {
      order.push("authenticate");
      return principal;
    });
    const authorizer: HostedWorkspaceAuthorizer = {
      execute: vi.fn(async (candidate, requestedWorkspace) => {
        order.push("authorize");
        return { ...candidate, workspaceId: requestedWorkspace };
      }),
    };
    const verify = vi.fn(async () => {
      await Promise.resolve();
      order.push("verify");
      return true;
    });
    const app = await createBoundaryApp({ authenticate }, authorizer, undefined, { verify });

    const response = await app.inject({
      method: "POST",
      url: `/v1/hosted/workspaces/${WORKSPACE_ID}/probe`,
    });

    expect(response.statusCode).toBe(200);
    expect(order).toEqual(["verify", "authenticate", "authorize"]);
  });

  it("crosses the dormant boundary with one real cookie resolution and exact CSRF proof", async () => {
    const secret = "A".repeat(43);
    const csrfToken = "B".repeat(43);
    const execute = vi.fn(async () => principal);
    const authorizer = authorizerFor();
    const app = await createBoundaryApp(
      new HostedBrowserSessionAuthenticator({ execute }),
      authorizer,
      undefined,
      new HostedBrowserCsrfGuard("https://hosted.schedule.test"),
    );

    const response = await app.inject({
      method: "POST",
      url: `/v1/hosted/workspaces/${WORKSPACE_ID}/probe`,
      headers: {
        origin: "https://hosted.schedule.test",
        cookie: `${HOSTED_SESSION_COOKIE_NAME}=${SESSION_ID}.${secret}; ${HOSTED_CSRF_COOKIE_NAME}=${csrfToken}`,
        [HOSTED_CSRF_HEADER_NAME]: csrfToken,
        "x-user-id": OTHER_USER_ID,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.json()).toMatchObject({
      userId: USER_ID,
      sessionId: SESSION_ID,
      workspaceId: WORKSPACE_ID,
      frozen: true,
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith({ selector: SESSION_ID, secret });
    expect(authorizer.execute).toHaveBeenCalledOnce();
  });

  it("keeps concurrent request principals isolated", async () => {
    const principals = new Map<string, typeof principal>();
    const authenticator: HostedRequestAuthenticator = {
      authenticate: async (request: FastifyRequest) => {
        const selected = request.headers["x-fixture-principal"];
        return typeof selected === "string" ? (principals.get(selected) ?? null) : null;
      },
    };
    principals.set("first", principal);
    principals.set("second", {
      ...principal,
      userId: OTHER_USER_ID,
      sessionId: browserSessionId("00000000-0000-4000-8000-000000000202"),
    });
    const app = await createBoundaryApp(authenticator, {
      execute: async (candidate, requestedWorkspace) => ({
        ...candidate,
        workspaceId: requestedWorkspace,
      }),
    });

    const [firstResponse, secondResponse] = await Promise.all([
      app.inject({
        method: "GET",
        url: `/v1/hosted/workspaces/${WORKSPACE_ID}/probe`,
        headers: { "x-fixture-principal": "first" },
      }),
      app.inject({
        method: "GET",
        url: `/v1/hosted/workspaces/${OTHER_WORKSPACE_ID}/probe`,
        headers: { "x-fixture-principal": "second" },
      }),
    ]);
    expect(firstResponse.json()).toMatchObject({ userId: USER_ID, workspaceId: WORKSPACE_ID });
    expect(secondResponse.json()).toMatchObject({
      userId: OTHER_USER_ID,
      workspaceId: OTHER_WORKSPACE_ID,
    });
  });

  it("refuses to register an unscoped route inside the hosted workspace boundary", async () => {
    const app = Fastify({ logger: false });
    apps.push(app);
    await expect(
      registerHostedWorkspaceBoundary(
        app,
        {
          authenticator: { authenticate: async () => principal },
          csrfGuard: { verify: () => true },
          authorizer: authorizerFor(),
        },
        async (hosted) => {
          hosted.get("/v1/hosted/workspaces/:workspaceIdSuffix", async () => []);
        },
      ),
    ).rejects.toThrow("must include a :workspaceId parameter");
  });
});
