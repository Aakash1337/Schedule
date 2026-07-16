import type {
  ConsumedHostedLoginTransaction,
  IssuedHostedLoginTransaction,
} from "@schedule/application";
import {
  browserSessionId,
  externalIdentityId,
  hostedLoginTransactionId,
  userId,
  type HostedUser,
} from "@schedule/domain";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  HOSTED_CALLBACK_ROUTE,
  HOSTED_LOGIN_ROUTE,
  HOSTED_LOGOUT_ROUTE,
  HOSTED_SESSION_ROUTE,
  registerHostedAuthLifecycle,
  type HostedAuthLifecycleDependencies,
  type VerifiedHostedIdentity,
} from "./hosted-auth-lifecycle.js";
import {
  HostedBrowserCsrfGuard,
  HOSTED_CSRF_COOKIE_NAME,
  HOSTED_CSRF_HEADER_NAME,
  HOSTED_LOGIN_BINDING_COOKIE_NAME,
  HOSTED_SESSION_COOKIE_NAME,
} from "./hosted-browser-session.js";

const ORIGIN = "https://hosted.schedule.test";
const ISSUER = "https://issuer.schedule.test/tenant";
const CLIENT_ID = "schedule-hosted-client";
const REDIRECT_URI = `${ORIGIN}${HOSTED_CALLBACK_ROUTE}`;
const RETURN_TO_PATH = "/today";
const STATE = "S".repeat(43);
const LOGIN_BINDING = "L".repeat(43);
const NONCE = "N".repeat(43);
const PKCE_CHALLENGE = "C".repeat(43);
const PKCE_VERIFIER = "P".repeat(43);
const AUTHORIZATION_CODE = "provider-code_123-ABC";
const ID_TOKEN = "header.payload.signature";
const AUTHORIZATION_URL = `https://login.schedule.test/oauth/authorize?state=${STATE}`;
const SELECTOR = "a0000000-0000-4000-8000-000000000201";
const SECRET = "A".repeat(43);
const CSRF_TOKEN = "B".repeat(43);
const USER_ID = userId("00000000-0000-4000-8000-000000000101");
const NOW = new Date("2026-07-15T00:00:00.000Z");
const SESSION_COOKIE = `${HOSTED_SESSION_COOKIE_NAME}=${SELECTOR}.${SECRET}`;
const CSRF_COOKIE = `${HOSTED_CSRF_COOKIE_NAME}=${CSRF_TOKEN}`;
const LOGIN_COOKIE = `${HOSTED_LOGIN_BINDING_COOKIE_NAME}=${LOGIN_BINDING}`;
const CALLBACK_URL = `${HOSTED_CALLBACK_ROUTE}?code=${AUTHORIZATION_CODE}&state=${STATE}`;
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

const ISSUED_TRANSACTION: IssuedHostedLoginTransaction = Object.freeze({
  issuer: ISSUER,
  clientId: CLIENT_ID,
  redirectUri: REDIRECT_URI,
  state: STATE,
  browserBinding: LOGIN_BINDING,
  nonce: NONCE,
  pkceChallenge: PKCE_CHALLENGE,
  pkceMethod: "S256",
  expiresAt: new Date("2026-07-15T00:05:00.000Z"),
});

const CONSUMED_TRANSACTION: ConsumedHostedLoginTransaction = Object.freeze({
  id: hostedLoginTransactionId("00000000-0000-4000-8000-000000000401"),
  issuer: ISSUER,
  clientId: CLIENT_ID,
  redirectUri: REDIRECT_URI,
  returnToPath: RETURN_TO_PATH,
  expectedNonce: NONCE,
  pkceVerifier: PKCE_VERIFIER,
  consumedAt: NOW,
});

const VERIFIED_IDENTITY: VerifiedHostedIdentity = Object.freeze({
  issuer: ISSUER,
  subject: "provider-subject-1",
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
  return { origin: ORIGIN, cookie, [HOSTED_CSRF_HEADER_NAME]: CSRF_TOKEN };
}

function createDependencies() {
  const authenticate = vi.fn(async () => null);
  const startLogin = vi.fn(async (): Promise<IssuedHostedLoginTransaction> => ISSUED_TRANSACTION);
  const buildAuthorization = vi.fn(() => ({ url: AUTHORIZATION_URL }));
  const consumeLogin = vi.fn(
    async (): Promise<ConsumedHostedLoginTransaction | null> => CONSUMED_TRANSACTION,
  );
  const exchangeCode = vi.fn(async (): Promise<{ readonly idToken: string } | null> => ({
    idToken: ID_TOKEN,
  }));
  const verifyIdentity = vi.fn(
    async (): Promise<VerifiedHostedIdentity | null> => VERIFIED_IDENTITY,
  );
  const provisionIdentity = vi.fn(async (identity: VerifiedHostedIdentity) => ({
    user: ACTIVE_USER,
    identity: {
      id: externalIdentityId("00000000-0000-4000-8000-000000000301"),
      userId: USER_ID,
      ...identity,
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
    loginTransactionStarter: { execute: startLogin },
    loginTransactionConsumer: { execute: consumeLogin },
    authorizationRequestBuilder: { build: buildAuthorization },
    tokenExchanger: { exchange: exchangeCode },
    identityVerifier: { verify: verifyIdentity },
    identityProvisioner: { execute: provisionIdentity },
    sessionIssuer: { execute: issueSession },
    sessionRevoker: { execute: revokeSession },
    sessionPolicy: SESSION_POLICY,
    loginPolicy: {
      hostedOrigin: ORIGIN,
      issuer: ISSUER,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      returnToPath: RETURN_TO_PATH,
      ttlSeconds: 300,
    },
  };
  return {
    dependencies,
    authenticate,
    startLogin,
    buildAuthorization,
    consumeLogin,
    exchangeCode,
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

describe("dormant hosted OIDC authentication lifecycle", () => {
  it.each([
    ["HTTP origin", { hostedOrigin: "http://hosted.schedule.test" }],
    ["mismatched callback", { redirectUri: `${ORIGIN}/other-callback` }],
    ["external return", { returnToPath: "//evil.test" }],
    ["short transaction TTL", { ttlSeconds: 59 }],
  ])("rejects a login policy with a %s during registration", async (_label, override) => {
    const fixture = createDependencies();
    const app = Fastify({ logger: false });
    apps.push(app);
    await expect(
      registerHostedAuthLifecycle(app, {
        ...fixture.dependencies,
        loginPolicy: { ...fixture.dependencies.loginPolicy, ...override },
      }),
    ).rejects.toThrow("hosted OIDC login policy is invalid");
  });

  it.each([
    ["absent", null, false],
    ["active", PRINCIPAL, true],
  ] as const)(
    "reports an %s session without exposing identity",
    async (_label, principal, expected) => {
      const fixture = createDependencies();
      fixture.authenticate.mockResolvedValueOnce(principal);
      const response = await (
        await createApp(fixture.dependencies)
      ).inject({
        method: "GET",
        url: HOSTED_SESSION_ROUTE,
      });

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

  it("redacts session resolver failures", async () => {
    const fixture = createDependencies();
    fixture.authenticate.mockRejectedValueOnce(new Error("private database diagnostic"));
    const response = await (
      await createApp(fixture.dependencies)
    ).inject({
      method: "GET",
      url: HOSTED_SESSION_ROUTE,
    });

    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain("database");
    expect(setCookieHeaders(response)).toHaveLength(1);
  });

  it("starts one exact transaction and redirects with one hardened browser binding", async () => {
    const fixture = createDependencies();
    const response = await (
      await createApp(fixture.dependencies)
    ).inject({
      method: "GET",
      url: HOSTED_LOGIN_ROUTE,
    });

    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe(AUTHORIZATION_URL);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(fixture.startLogin).toHaveBeenCalledWith({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      returnToPath: RETURN_TO_PATH,
      ttlSeconds: 300,
    });
    expect(fixture.buildAuthorization).toHaveBeenCalledWith(ISSUED_TRANSACTION);
    expect(setCookieHeaders(response)).toEqual([
      `${LOGIN_COOKIE}; Path=/; Secure; HttpOnly; SameSite=Lax`,
    ]);
  });

  it("rejects login query input before creating a transaction", async () => {
    const fixture = createDependencies();
    const response = await (
      await createApp(fixture.dependencies)
    ).inject({
      method: "GET",
      url: `${HOSTED_LOGIN_ROUTE}?returnTo=https://evil.test`,
    });

    expect(response.statusCode).toBe(401);
    expect(fixture.startLogin).not.toHaveBeenCalled();
    expect(setCookieHeaders(response)).toHaveLength(0);
  });

  it.each(["transaction", "authorization", "authorization output"] as const)(
    "redacts an internal %s start failure without setting a binding",
    async (stage) => {
      const fixture = createDependencies();
      if (stage === "transaction") {
        fixture.startLogin.mockRejectedValueOnce(new Error("private transaction diagnostic"));
      } else if (stage === "authorization") {
        fixture.buildAuthorization.mockImplementationOnce(() => {
          throw new Error("private builder diagnostic");
        });
      } else {
        fixture.buildAuthorization.mockReturnValueOnce({ url: "javascript:alert(1)" });
      }
      const response = await (
        await createApp(fixture.dependencies)
      ).inject({
        method: "GET",
        url: HOSTED_LOGIN_ROUTE,
      });

      expect(response.statusCode).toBe(503);
      expect(response.body).not.toContain("private");
      expect(setCookieHeaders(response)).toHaveLength(0);
    },
  );

  it("consumes, exchanges, verifies, provisions, and redirects exactly once", async () => {
    const fixture = createDependencies();
    const response = await (
      await createApp(fixture.dependencies)
    ).inject({
      method: "GET",
      url: CALLBACK_URL,
      headers: { cookie: LOGIN_COOKIE },
    });

    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe(`${ORIGIN}${RETURN_TO_PATH}`);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(fixture.consumeLogin).toHaveBeenCalledOnce();
    expect(fixture.consumeLogin).toHaveBeenCalledWith({
      state: STATE,
      browserBinding: LOGIN_BINDING,
    });
    expect(fixture.exchangeCode).toHaveBeenCalledWith({
      code: AUTHORIZATION_CODE,
      transaction: CONSUMED_TRANSACTION,
    });
    expect(fixture.verifyIdentity).toHaveBeenCalledWith({
      idToken: ID_TOKEN,
      issuer: ISSUER,
      clientId: CLIENT_ID,
      expectedNonce: NONCE,
    });
    expect(fixture.provisionIdentity).toHaveBeenCalledWith(VERIFIED_IDENTITY);
    expect(fixture.issueSession).toHaveBeenCalledWith({ userId: USER_ID, ...SESSION_POLICY });
    const cookies = setCookieHeaders(response);
    expect(cookies).toHaveLength(3);
    expect(cookies[0]).toBe(`${SESSION_COOKIE}; Path=/; Secure; HttpOnly; SameSite=Lax`);
    expect(cookies[1]).toMatch(
      new RegExp(
        `^${HOSTED_CSRF_COOKIE_NAME}=[A-Za-z0-9_-]{43}; Path=/; Secure; SameSite=Lax$`,
        "u",
      ),
    );
    expect(cookies[2]).toContain(`${HOSTED_LOGIN_BINDING_COOKIE_NAME}=; Path=/; Secure; HttpOnly`);
  });

  it.each([
    ["missing code", `${HOSTED_CALLBACK_ROUTE}?state=${STATE}`, LOGIN_COOKIE],
    ["duplicate code", `${CALLBACK_URL}&code=again`, LOGIN_COOKIE],
    ["duplicate state", `${CALLBACK_URL}&state=${STATE}`, LOGIN_COOKIE],
    ["unexpected parameter", `${CALLBACK_URL}&scope=openid`, LOGIN_COOKIE],
    ["provider error", `${HOSTED_CALLBACK_ROUTE}?error=access_denied&state=${STATE}`, LOGIN_COOKIE],
    ["malformed code", `${HOSTED_CALLBACK_ROUTE}?code=bad%0Acode&state=${STATE}`, LOGIN_COOKIE],
    [
      "malformed state",
      `${HOSTED_CALLBACK_ROUTE}?code=${AUTHORIZATION_CODE}&state=short`,
      LOGIN_COOKIE,
    ],
    ["missing binding", CALLBACK_URL, "theme=dark"],
    ["duplicate binding", CALLBACK_URL, `${LOGIN_COOKIE}; ${LOGIN_COOKIE}`],
  ])("rejects %s before consuming the transaction", async (_label, url, cookie) => {
    const fixture = createDependencies();
    const response = await (
      await createApp(fixture.dependencies)
    ).inject({
      method: "GET",
      url,
      headers: { cookie },
    });

    expect(response.statusCode).toBe(401);
    expect(fixture.consumeLogin).not.toHaveBeenCalled();
    expect(fixture.exchangeCode).not.toHaveBeenCalled();
    expect(setCookieHeaders(response)).toEqual([
      expect.stringContaining(`${HOSTED_LOGIN_BINDING_COOKIE_NAME}=;`),
    ]);
  });

  it.each(["consume", "exchange", "verify"] as const)(
    "maps a deterministic %s rejection to one generic 401 without session issuance",
    async (stage) => {
      const fixture = createDependencies();
      if (stage === "consume") fixture.consumeLogin.mockResolvedValueOnce(null);
      if (stage === "exchange") fixture.exchangeCode.mockResolvedValueOnce(null);
      if (stage === "verify") fixture.verifyIdentity.mockResolvedValueOnce(null);
      const response = await (
        await createApp(fixture.dependencies)
      ).inject({
        method: "GET",
        url: CALLBACK_URL,
        headers: { cookie: LOGIN_COOKIE },
      });

      expect(response.statusCode).toBe(401);
      expect(fixture.consumeLogin).toHaveBeenCalledTimes(1);
      expect(fixture.exchangeCode).toHaveBeenCalledTimes(stage === "consume" ? 0 : 1);
      expect(fixture.verifyIdentity).toHaveBeenCalledTimes(stage === "verify" ? 1 : 0);
      expect(fixture.provisionIdentity).not.toHaveBeenCalled();
      expect(fixture.issueSession).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["issuer", { issuer: "https://other-issuer.test" }],
    ["client", { clientId: "other-client" }],
    ["redirect", { redirectUri: `${ORIGIN}/wrong-callback` }],
    ["return path", { returnToPath: "//evil.test" }],
  ])("rejects an inconsistent consumed %s before code exchange", async (_label, override) => {
    const fixture = createDependencies();
    fixture.consumeLogin.mockResolvedValueOnce({ ...CONSUMED_TRANSACTION, ...override });
    const response = await (
      await createApp(fixture.dependencies)
    ).inject({
      method: "GET",
      url: CALLBACK_URL,
      headers: { cookie: LOGIN_COOKIE },
    });

    expect(response.statusCode).toBe(503);
    expect(fixture.exchangeCode).not.toHaveBeenCalled();
    expect(fixture.issueSession).not.toHaveBeenCalled();
  });

  it("rejects a disabled provisioned user without issuing a session", async () => {
    const fixture = createDependencies();
    fixture.provisionIdentity.mockResolvedValueOnce({
      user: { ...ACTIVE_USER, status: "disabled", disabledAt: NOW },
      identity: {
        id: externalIdentityId("00000000-0000-4000-8000-000000000301"),
        userId: USER_ID,
        ...VERIFIED_IDENTITY,
        createdAt: NOW,
      },
      created: false,
    });
    const response = await (
      await createApp(fixture.dependencies)
    ).inject({
      method: "GET",
      url: CALLBACK_URL,
      headers: { cookie: LOGIN_COOKIE },
    });

    expect(response.statusCode).toBe(401);
    expect(fixture.issueSession).not.toHaveBeenCalled();
  });

  it.each([
    ["malformed", { issuer: "", subject: "provider-subject-1" }],
    ["wrong-issuer", { issuer: "https://other-issuer.example", subject: "provider-subject-1" }],
  ])("rejects a %s verified identity before provisioning", async (_label, identity) => {
    const fixture = createDependencies();
    fixture.verifyIdentity.mockResolvedValueOnce(identity);
    const response = await (
      await createApp(fixture.dependencies)
    ).inject({
      method: "GET",
      url: CALLBACK_URL,
      headers: { cookie: LOGIN_COOKIE },
    });

    expect(response.statusCode).toBe(503);
    expect(fixture.provisionIdentity).not.toHaveBeenCalled();
    expect(fixture.issueSession).not.toHaveBeenCalled();
  });

  it.each([
    ["issuer", { issuer: "https://other-issuer.example" }],
    ["subject", { subject: "other-provider-subject" }],
    ["user", { userId: userId("00000000-0000-4000-8000-000000000102") }],
  ])("rejects a provisioned identity with a mismatched %s", async (_label, override) => {
    const fixture = createDependencies();
    fixture.provisionIdentity.mockResolvedValueOnce({
      user: ACTIVE_USER,
      identity: {
        id: externalIdentityId("00000000-0000-4000-8000-000000000301"),
        userId: USER_ID,
        ...VERIFIED_IDENTITY,
        ...override,
        createdAt: NOW,
      },
      created: false,
    });
    const response = await (
      await createApp(fixture.dependencies)
    ).inject({
      method: "GET",
      url: CALLBACK_URL,
      headers: { cookie: LOGIN_COOKIE },
    });

    expect(response.statusCode).toBe(503);
    expect(fixture.issueSession).not.toHaveBeenCalled();
  });

  it.each(["consume", "exchange", "verification", "provision", "session"] as const)(
    "redacts an internal %s callback failure and clears the binding",
    async (stage) => {
      const fixture = createDependencies();
      const failure = new Error("private provider or database diagnostic");
      if (stage === "consume") fixture.consumeLogin.mockRejectedValueOnce(failure);
      if (stage === "exchange") fixture.exchangeCode.mockRejectedValueOnce(failure);
      if (stage === "verification") fixture.verifyIdentity.mockRejectedValueOnce(failure);
      if (stage === "provision") fixture.provisionIdentity.mockRejectedValueOnce(failure);
      if (stage === "session") fixture.issueSession.mockRejectedValueOnce(failure);
      const response = await (
        await createApp(fixture.dependencies)
      ).inject({
        method: "GET",
        url: CALLBACK_URL,
        headers: { cookie: LOGIN_COOKIE },
      });

      expect(response.statusCode).toBe(503);
      expect(response.body).not.toContain("private");
      expect(setCookieHeaders(response)).toEqual([
        expect.stringContaining(`${HOSTED_LOGIN_BINDING_COOKIE_NAME}=;`),
      ]);
    },
  );

  it("revokes the exact presented session and clears both browser cookies", async () => {
    const fixture = createDependencies();
    const response = await (
      await createApp(fixture.dependencies)
    ).inject({
      method: "POST",
      url: HOSTED_LOGOUT_ROUTE,
      headers: csrfHeaders(`${SESSION_COOKIE}; ${CSRF_COOKIE}`),
    });

    expect(response.statusCode).toBe(204);
    expect(fixture.revokeSession).toHaveBeenCalledWith(
      { selector: SELECTOR, secret: SECRET },
      "signed_out",
    );
    expect(setCookieHeaders(response)).toHaveLength(2);
  });

  it.each([
    ["missing", CSRF_COOKIE],
    ["malformed", `${HOSTED_SESSION_COOKIE_NAME}=malformed; ${CSRF_COOKIE}`],
  ])("makes %s logout sessions idempotent", async (_label, cookie) => {
    const fixture = createDependencies();
    const response = await (
      await createApp(fixture.dependencies)
    ).inject({
      method: "POST",
      url: HOSTED_LOGOUT_ROUTE,
      headers: csrfHeaders(cookie),
    });

    expect(response.statusCode).toBe(204);
    expect(fixture.revokeSession).not.toHaveBeenCalled();
    expect(setCookieHeaders(response)).toHaveLength(2);
  });

  it("rejects logout before revocation work when CSRF fails", async () => {
    const fixture = createDependencies();
    const response = await (
      await createApp(fixture.dependencies)
    ).inject({
      method: "POST",
      url: HOSTED_LOGOUT_ROUTE,
    });

    expect(response.statusCode).toBe(403);
    expect(fixture.revokeSession).not.toHaveBeenCalled();
  });

  it("clears local cookies and redacts a revocation outage", async () => {
    const fixture = createDependencies();
    fixture.revokeSession.mockRejectedValueOnce(new Error("private revocation diagnostic"));
    const response = await (
      await createApp(fixture.dependencies)
    ).inject({
      method: "POST",
      url: HOSTED_LOGOUT_ROUTE,
      headers: csrfHeaders(`${SESSION_COOKIE}; ${CSRF_COOKIE}`),
    });

    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain("revocation");
    expect(setCookieHeaders(response)).toHaveLength(2);
  });
});
