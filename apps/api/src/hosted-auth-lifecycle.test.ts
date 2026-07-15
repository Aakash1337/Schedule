import { browserSessionId, externalIdentityId, userId, type HostedUser } from "@schedule/domain";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  HOSTED_LOGIN_ROUTE,
  HOSTED_LOGOUT_ROUTE,
  HOSTED_SESSION_ROUTE,
  registerHostedAuthLifecycle,
  type HostedAuthLifecycleDependencies,
} from "./hosted-auth-lifecycle.js";
import {
  HostedBrowserCsrfGuard,
  HOSTED_CSRF_COOKIE_NAME,
  HOSTED_CSRF_HEADER_NAME,
  HOSTED_SESSION_COOKIE_NAME,
} from "./hosted-browser-session.js";

const ORIGIN = "https://hosted.schedule.test";
const SELECTOR = "a0000000-0000-4000-8000-000000000201";
const SECRET = "A".repeat(43);
const CSRF_TOKEN = "B".repeat(43);
const USER_ID = userId("00000000-0000-4000-8000-000000000101");
const NOW = new Date("2026-07-15T00:00:00.000Z");
const SESSION_COOKIE = `${HOSTED_SESSION_COOKIE_NAME}=${SELECTOR}.${SECRET}`;
const CSRF_COOKIE = `${HOSTED_CSRF_COOKIE_NAME}=${CSRF_TOKEN}`;
const SESSION_POLICY = Object.freeze({
  idleTimeoutSeconds: 3_600,
  absoluteTtlSeconds: 86_400,
});

const ACTIVE_USER: HostedUser = Object.freeze({
  id: USER_ID,
  status: "active",
  disabledAt: null,
  version: 1,
  createdAt: NOW,
  updatedAt: NOW,
});

const PRINCIPAL = Object.freeze({
  userId: USER_ID,
  sessionId: browserSessionId(SELECTOR),
  idleExpiresAt: new Date("2026-07-15T01:00:00.000Z"),
  absoluteExpiresAt: new Date("2026-07-16T00:00:00.000Z"),
});

const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function setCookieHeaders(response: { readonly headers: Record<string, unknown> }): string[] {
  const value = response.headers["set-cookie"];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return typeof value === "string" ? [value] : [];
}

function csrfHeaders(cookie = CSRF_COOKIE): Record<string, string> {
  return {
    origin: ORIGIN,
    cookie,
    [HOSTED_CSRF_HEADER_NAME]: CSRF_TOKEN,
  };
}

function createDependencies() {
  const authenticate = vi.fn(async () => null);
  const verifyIdentity = vi.fn(async () => ({
    issuer: "https://issuer.example",
    subject: "provider-subject-1",
  }));
  const provisionIdentity = vi.fn(async (input: { issuer: string; subject: string }) => ({
    user: ACTIVE_USER,
    identity: {
      id: externalIdentityId("00000000-0000-4000-8000-000000000301"),
      userId: USER_ID,
      ...input,
      createdAt: NOW,
    },
    created: false,
  }));
  const issueSession = vi.fn(async () => ({
    token: { selector: SELECTOR, secret: SECRET },
    idleExpiresAt: new Date("2026-07-15T01:00:00.000Z"),
    absoluteExpiresAt: new Date("2026-07-16T00:00:00.000Z"),
  }));
  const revokeSession = vi.fn(async () => true);

  const dependencies: HostedAuthLifecycleDependencies = {
    authenticator: { authenticate },
    csrfGuard: new HostedBrowserCsrfGuard(ORIGIN),
    identityVerifier: { verify: verifyIdentity },
    identityProvisioner: { execute: provisionIdentity },
    sessionIssuer: { execute: issueSession },
    sessionRevoker: { execute: revokeSession },
    sessionPolicy: SESSION_POLICY,
  };
  return {
    dependencies,
    authenticate,
    verifyIdentity,
    provisionIdentity,
    issueSession,
    revokeSession,
  };
}

async function createApp(dependencies: HostedAuthLifecycleDependencies): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await registerHostedAuthLifecycle(app, dependencies);
  apps.push(app);
  return app;
}

describe("dormant hosted authentication lifecycle", () => {
  it.each([
    ["absent", null, false],
    ["active", PRINCIPAL, true],
  ] as const)(
    "reports an %s session without exposing identity",
    async (_label, principal, expected) => {
      const fixture = createDependencies();
      fixture.authenticate.mockResolvedValueOnce(principal);
      const app = await createApp(fixture.dependencies);

      const response = await app.inject({ method: "GET", url: HOSTED_SESSION_ROUTE });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ authenticated: expected });
      expect(response.body).not.toContain(USER_ID);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(setCookieHeaders(response)).toEqual([
        expect.stringMatching(
          new RegExp(
            `^${HOSTED_CSRF_COOKIE_NAME}=[A-Za-z0-9_-]{43}; Path=/; Secure; SameSite=Lax$`,
            "u",
          ),
        ),
      ]);
    },
  );

  it("redacts session resolver failures while still bootstrapping fresh CSRF protection", async () => {
    const fixture = createDependencies();
    fixture.authenticate.mockRejectedValueOnce(new Error("private database diagnostic"));
    const app = await createApp(fixture.dependencies);

    const response = await app.inject({ method: "GET", url: HOSTED_SESSION_ROUTE });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: { code: "hosted.authentication_unavailable" },
    });
    expect(response.body).not.toContain("database");
    expect(setCookieHeaders(response)).toHaveLength(1);
  });

  it("provisions an exact verified identity and issues only hardened browser cookies", async () => {
    const fixture = createDependencies();
    const app = await createApp(fixture.dependencies);

    const response = await app.inject({
      method: "POST",
      url: HOSTED_LOGIN_ROUTE,
      headers: csrfHeaders(),
      payload: { proof: "provider-proof" },
    });

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(fixture.verifyIdentity).toHaveBeenCalledWith("provider-proof");
    expect(fixture.provisionIdentity).toHaveBeenCalledWith({
      issuer: "https://issuer.example",
      subject: "provider-subject-1",
    });
    expect(fixture.issueSession).toHaveBeenCalledWith({
      userId: USER_ID,
      ...SESSION_POLICY,
    });
    const cookies = setCookieHeaders(response);
    expect(cookies).toHaveLength(2);
    expect(cookies[0]).toBe(`${SESSION_COOKIE}; Path=/; Secure; HttpOnly; SameSite=Lax`);
    expect(cookies[1]).toMatch(
      new RegExp(
        `^${HOSTED_CSRF_COOKIE_NAME}=[A-Za-z0-9_-]{43}; Path=/; Secure; SameSite=Lax$`,
        "u",
      ),
    );
    expect(cookies.join(";")).not.toContain("Domain=");
    expect(response.body).not.toContain(USER_ID);
  });

  it.each([
    ["missing", undefined],
    ["empty", {}],
    ["wrong type", { proof: 42 }],
    ["empty proof", { proof: "" }],
    ["extra property", { proof: "provider-proof", userId: USER_ID }],
    ["oversized proof", { proof: "A".repeat(12 * 1_024 + 1) }],
  ])("rejects a %s login body before provider or database work", async (_label, payload) => {
    const fixture = createDependencies();
    const app = await createApp(fixture.dependencies);

    const response = await app.inject({
      method: "POST",
      url: HOSTED_LOGIN_ROUTE,
      headers: csrfHeaders(),
      ...(payload === undefined ? {} : { payload }),
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: "hosted.authentication_failed" } });
    expect(fixture.verifyIdentity).not.toHaveBeenCalled();
    expect(fixture.provisionIdentity).not.toHaveBeenCalled();
    expect(fixture.issueSession).not.toHaveBeenCalled();
  });

  it("keeps an invalid provider proof indistinguishable from other credentials", async () => {
    const fixture = createDependencies();
    fixture.verifyIdentity.mockResolvedValueOnce(null);
    const app = await createApp(fixture.dependencies);

    const response = await app.inject({
      method: "POST",
      url: HOSTED_LOGIN_ROUTE,
      headers: csrfHeaders(),
      payload: { proof: "invalid-proof" },
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: { code: "hosted.authentication_failed" } });
    expect(fixture.provisionIdentity).not.toHaveBeenCalled();
    expect(fixture.issueSession).not.toHaveBeenCalled();
  });

  it("rejects a disabled provisioned user without issuing a session", async () => {
    const fixture = createDependencies();
    fixture.provisionIdentity.mockResolvedValueOnce({
      user: { ...ACTIVE_USER, status: "disabled", disabledAt: NOW },
      identity: {
        id: externalIdentityId("00000000-0000-4000-8000-000000000301"),
        userId: USER_ID,
        issuer: "https://issuer.example",
        subject: "provider-subject-1",
        createdAt: NOW,
      },
      created: false,
    });
    const app = await createApp(fixture.dependencies);

    const response = await app.inject({
      method: "POST",
      url: HOSTED_LOGIN_ROUTE,
      headers: csrfHeaders(),
      payload: { proof: "provider-proof" },
    });

    expect(response.statusCode).toBe(401);
    expect(fixture.issueSession).not.toHaveBeenCalled();
  });

  it("treats a malformed verified identity as an internal contract failure", async () => {
    const fixture = createDependencies();
    fixture.verifyIdentity.mockResolvedValueOnce({ issuer: "", subject: "provider-subject-1" });
    const app = await createApp(fixture.dependencies);

    const response = await app.inject({
      method: "POST",
      url: HOSTED_LOGIN_ROUTE,
      headers: csrfHeaders(),
      payload: { proof: "provider-proof" },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: { code: "hosted.authentication_unavailable" },
    });
    expect(fixture.provisionIdentity).not.toHaveBeenCalled();
  });

  it.each([
    ["different issuer", { issuer: "https://other-issuer.example" }],
    ["different subject", { subject: "other-provider-subject" }],
    ["different user", { userId: userId("00000000-0000-4000-8000-000000000102") }],
  ])("rejects a provisioner binding with a %s", async (_label, identityOverride) => {
    const fixture = createDependencies();
    fixture.provisionIdentity.mockResolvedValueOnce({
      user: ACTIVE_USER,
      identity: {
        id: externalIdentityId("00000000-0000-4000-8000-000000000301"),
        userId: USER_ID,
        issuer: "https://issuer.example",
        subject: "provider-subject-1",
        createdAt: NOW,
        ...identityOverride,
      },
      created: false,
    });
    const app = await createApp(fixture.dependencies);

    const response = await app.inject({
      method: "POST",
      url: HOSTED_LOGIN_ROUTE,
      headers: csrfHeaders(),
      payload: { proof: "provider-proof" },
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: { code: "hosted.authentication_unavailable" },
    });
    expect(fixture.issueSession).not.toHaveBeenCalled();
    expect(setCookieHeaders(response)).toHaveLength(0);
  });

  it("enforces the route body limit before provider or database work", async () => {
    const fixture = createDependencies();
    const app = await createApp(fixture.dependencies);

    const response = await app.inject({
      method: "POST",
      url: HOSTED_LOGIN_ROUTE,
      headers: csrfHeaders(),
      payload: { proof: "A".repeat(17 * 1_024) },
    });

    expect(response.statusCode).toBe(413);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(fixture.verifyIdentity).not.toHaveBeenCalled();
    expect(fixture.provisionIdentity).not.toHaveBeenCalled();
    expect(fixture.issueSession).not.toHaveBeenCalled();
    expect(setCookieHeaders(response)).toHaveLength(0);
  });

  it.each(["verification", "provisioning", "issuance"] as const)(
    "redacts internal %s failures",
    async (stage) => {
      const fixture = createDependencies();
      if (stage === "verification") {
        fixture.verifyIdentity.mockRejectedValueOnce(new Error("private verifier diagnostic"));
      } else if (stage === "provisioning") {
        fixture.provisionIdentity.mockRejectedValueOnce(
          new Error("private provisioning diagnostic"),
        );
      } else {
        fixture.issueSession.mockRejectedValueOnce(new Error("private issuance diagnostic"));
      }
      const app = await createApp(fixture.dependencies);

      const response = await app.inject({
        method: "POST",
        url: HOSTED_LOGIN_ROUTE,
        headers: csrfHeaders(),
        payload: { proof: "provider-proof" },
      });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({
        error: { code: "hosted.authentication_unavailable" },
      });
      expect(response.body).not.toContain("private");
      expect(setCookieHeaders(response)).toHaveLength(0);
    },
  );

  it.each([
    [HOSTED_LOGIN_ROUTE, { proof: "provider-proof" }],
    [HOSTED_LOGOUT_ROUTE, undefined],
  ] as const)(
    "rejects %s before credential or revocation work when CSRF fails",
    async (url, payload) => {
      const fixture = createDependencies();
      const app = await createApp(fixture.dependencies);

      const response = await app.inject({
        method: "POST",
        url,
        ...(payload === undefined ? {} : { payload }),
      });

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: { code: "hosted.csrf_failed" } });
      expect(fixture.verifyIdentity).not.toHaveBeenCalled();
      expect(fixture.provisionIdentity).not.toHaveBeenCalled();
      expect(fixture.issueSession).not.toHaveBeenCalled();
      expect(fixture.revokeSession).not.toHaveBeenCalled();
    },
  );

  it("revokes the exact presented session and clears both browser cookies", async () => {
    const fixture = createDependencies();
    const app = await createApp(fixture.dependencies);

    const response = await app.inject({
      method: "POST",
      url: HOSTED_LOGOUT_ROUTE,
      headers: csrfHeaders(`${SESSION_COOKIE}; ${CSRF_COOKIE}`),
    });

    expect(response.statusCode).toBe(204);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(fixture.revokeSession).toHaveBeenCalledWith(
      { selector: SELECTOR, secret: SECRET },
      "signed_out",
    );
    const cookies = setCookieHeaders(response);
    expect(cookies).toHaveLength(2);
    expect(cookies.every((cookie) => cookie.includes("Max-Age=0"))).toBe(true);
    expect(cookies.every((cookie) => !cookie.includes("Domain="))).toBe(true);
  });

  it.each([
    ["missing", CSRF_COOKIE],
    ["malformed", `${HOSTED_SESSION_COOKIE_NAME}=malformed; ${CSRF_COOKIE}`],
  ])("makes %s logout sessions idempotent while still clearing cookies", async (_label, cookie) => {
    const fixture = createDependencies();
    const app = await createApp(fixture.dependencies);

    const response = await app.inject({
      method: "POST",
      url: HOSTED_LOGOUT_ROUTE,
      headers: csrfHeaders(cookie),
    });

    expect(response.statusCode).toBe(204);
    expect(fixture.revokeSession).not.toHaveBeenCalled();
    expect(setCookieHeaders(response)).toHaveLength(2);
  });

  it("clears local cookies and redacts a revocation outage", async () => {
    const fixture = createDependencies();
    fixture.revokeSession.mockRejectedValueOnce(new Error("private revocation diagnostic"));
    const app = await createApp(fixture.dependencies);

    const response = await app.inject({
      method: "POST",
      url: HOSTED_LOGOUT_ROUTE,
      headers: csrfHeaders(`${SESSION_COOKIE}; ${CSRF_COOKIE}`),
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      error: { code: "hosted.authentication_unavailable" },
    });
    expect(response.body).not.toContain("revocation");
    expect(setCookieHeaders(response)).toHaveLength(2);
  });
});
