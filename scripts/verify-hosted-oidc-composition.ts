import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

import { createDatabase } from "../packages/database/src/index.js";
import {
  exportJWK,
  Fastify,
  generateKeyPair,
  SignJWT,
  type JWK,
} from "../apps/api/test-support/hosted-oidc-runtime.js";

import {
  createDormantHostedOidcComposition,
  type HostedOidcCompositionTransport,
} from "../apps/api/src/dormant-hosted-oidc-composition.js";
import {
  HOSTED_CSRF_COOKIE_NAME,
  HOSTED_CSRF_HEADER_NAME,
  HOSTED_SESSION_COOKIE_NAME,
} from "../apps/api/src/hosted-browser-session.js";
import {
  HOSTED_CALLBACK_ROUTE,
  HOSTED_LOGIN_ROUTE,
  HOSTED_LOGOUT_ROUTE,
  HOSTED_SESSION_ROUTE,
  registerHostedAuthLifecycle,
} from "../apps/api/src/hosted-auth-lifecycle.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://schedule:schedule@127.0.0.1:5432/schedule";
const nonce = randomUUID().replaceAll("-", "");
const origin = "https://schedule.example.com";
const issuer = `https://login.example.com/${nonce}`;
const clientId = `schedule-composition-${nonce}`;
const redirectUri = `${origin}${HOSTED_CALLBACK_ROUTE}`;
const discoveryUrl = `${issuer}/.well-known/openid-configuration`;
const authorizationEndpoint = `https://login.example.com/${nonce}/authorize`;
const tokenEndpoint = `https://login.example.com/${nonce}/token`;
const jwksUri = `https://login.example.com/${nonce}/jwks`;
const subject = `subject-${nonce}`;
const keyId = `key-${nonce}`;
const clientSecret = `composition-client-secret-${nonce}`;
const loginPepper = `composition-login-pepper-${nonce}`;
const sessionPepper = `composition-session-pepper-${nonce}`;

class ExactUrlResponse extends Response {
  constructor(url: string, body: string, init: ResponseInit) {
    super(body, init);
    Object.defineProperty(this, "url", { value: url });
  }
}

function jsonResponse(
  url: string,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return new ExactUrlResponse(url, JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

function setCookieHeaders(value: string | string[] | undefined): string[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function cookiePair(value: string): string {
  return value.split(";", 1)[0] ?? "";
}

const keyPair = await generateKeyPair("RS256", { extractable: true });
const publicJwk: JWK = {
  ...(await exportJWK(keyPair.publicKey)),
  alg: "RS256",
  kid: keyId,
  use: "sig",
};
let providerNonce = "";
let providerCodeChallenge = "";
let tokenRequestValidated = false;
const requestCounts = { discovery: 0, token: 0, jwks: 0 };

const transport = (async (resource: string, options: RequestInit) => {
  if (resource === discoveryUrl && options.method === "GET") {
    requestCounts.discovery += 1;
    return jsonResponse(resource, {
      issuer,
      authorization_endpoint: authorizationEndpoint,
      token_endpoint: tokenEndpoint,
      jwks_uri: jwksUri,
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      scopes_supported: ["openid"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_basic"],
    });
  }
  if (resource === tokenEndpoint && options.method === "POST") {
    requestCounts.token += 1;
    assert.notEqual(providerNonce, "");
    const headers = new Headers(options.headers);
    assert.equal(
      headers.get("authorization"),
      `Basic ${Buffer.from(`${clientId}:${clientSecret}`, "utf8").toString("base64")}`,
    );
    assert.equal(headers.get("content-type"), "application/x-www-form-urlencoded");
    const form = new URLSearchParams(String(options.body));
    assert.equal(form.get("grant_type"), "authorization_code");
    assert.equal(form.get("code"), "verified-code");
    assert.equal(form.get("redirect_uri"), redirectUri);
    assert.equal(form.get("client_id"), null);
    assert.equal(form.get("client_secret"), null);
    const verifier = form.get("code_verifier");
    assert.match(verifier ?? "", /^[A-Za-z0-9_-]{43}$/u);
    assert.equal(
      createHash("sha256").update(verifier!, "ascii").digest("base64url"),
      providerCodeChallenge,
    );
    tokenRequestValidated = true;
    const now = Math.floor(Date.now() / 1_000);
    const idToken = await new SignJWT({ nonce: providerNonce })
      .setProtectedHeader({ alg: "RS256", kid: keyId, typ: "JWT" })
      .setIssuer(issuer)
      .setAudience(clientId)
      .setSubject(subject)
      .setIssuedAt(now)
      .setExpirationTime(now + 300)
      .sign(keyPair.privateKey);
    return jsonResponse(
      resource,
      { access_token: "opaque-access", token_type: "Bearer", id_token: idToken },
      { "cache-control": "no-store", pragma: "no-cache" },
    );
  }
  if (resource === jwksUri && options.method === "GET") {
    requestCounts.jwks += 1;
    return jsonResponse(resource, { keys: [publicJwk] });
  }
  throw new Error("Unexpected in-process OIDC provider request.");
}) as HostedOidcCompositionTransport;

const database = createDatabase(databaseUrl, 4, {
  applicationName: "schedule-hosted-oidc-composition-verifier",
});
const app = Fastify({ logger: false });
let verificationError: unknown;
let cleanupFailed = false;

try {
  const dependencies = await createDormantHostedOidcComposition({
    database,
    registration: { publicOrigin: origin, issuer, clientId, redirectUri },
    loginTransactionPepper: loginPepper,
    browserSessionPepper: sessionPepper,
    pkceKeyRing: {
      primaryKeyId: "verification",
      keys: { verification: Buffer.alloc(32, 17).toString("base64url") },
    },
    tokenEndpointAuthentication: { method: "client_secret_basic", clientSecret },
    transport,
  });
  await registerHostedAuthLifecycle(app, dependencies);
  await app.ready();

  const login = await app.inject({ method: "GET", url: HOSTED_LOGIN_ROUTE });
  assert.equal(login.statusCode, 303);
  const authorization = new URL(login.headers.location ?? "");
  assert.equal(`${authorization.origin}${authorization.pathname}`, authorizationEndpoint);
  assert.equal(authorization.searchParams.get("client_id"), clientId);
  assert.equal(authorization.searchParams.get("redirect_uri"), redirectUri);
  assert.equal(authorization.searchParams.get("scope"), "openid");
  assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
  const state = authorization.searchParams.get("state");
  providerNonce = authorization.searchParams.get("nonce") ?? "";
  providerCodeChallenge = authorization.searchParams.get("code_challenge") ?? "";
  assert.match(state ?? "", /^[A-Za-z0-9_-]{43}$/u);
  assert.match(providerNonce, /^[A-Za-z0-9_-]{43}$/u);
  assert.match(providerCodeChallenge, /^[A-Za-z0-9_-]{43}$/u);
  const loginCookie = setCookieHeaders(login.headers["set-cookie"])[0];
  assert.ok(loginCookie);

  const callback = await app.inject({
    method: "GET",
    url: `${HOSTED_CALLBACK_ROUTE}?code=verified-code&state=${state}`,
    headers: { cookie: cookiePair(loginCookie) },
  });
  assert.equal(callback.statusCode, 303, callback.body);
  assert.equal(callback.headers.location, `${origin}/`);
  const callbackCookies = setCookieHeaders(callback.headers["set-cookie"]);
  const sessionCookie = callbackCookies.find((value) =>
    value.startsWith(`${HOSTED_SESSION_COOKIE_NAME}=`),
  );
  const csrfCookie = callbackCookies.find((value) =>
    value.startsWith(`${HOSTED_CSRF_COOKIE_NAME}=`),
  );
  assert.ok(sessionCookie);
  assert.ok(csrfCookie);

  const replay = await app.inject({
    method: "GET",
    url: `${HOSTED_CALLBACK_ROUTE}?code=verified-code&state=${state}`,
    headers: { cookie: cookiePair(loginCookie) },
  });
  assert.equal(replay.statusCode, 401);
  assert.equal(requestCounts.token, 1);

  const authenticated = await app.inject({
    method: "GET",
    url: HOSTED_SESSION_ROUTE,
    headers: { cookie: cookiePair(sessionCookie) },
  });
  assert.equal(authenticated.statusCode, 200);
  assert.deepEqual(authenticated.json(), { authenticated: true });

  const [persisted] = await database.sql<
    { users: number; identities: number; sessions: number; consumed: number }[]
  >`
    select
      (select count(*)::integer from users as u
        join external_identities as i on i.user_id = u.id
        where i.issuer = ${issuer} and i.subject = ${subject}) as users,
      (select count(*)::integer from external_identities
        where issuer = ${issuer} and subject = ${subject}) as identities,
      (select count(*)::integer from browser_sessions as s
        join external_identities as i on i.user_id = s.user_id
        where i.issuer = ${issuer} and i.subject = ${subject} and s.revoked_at is null) as sessions,
      (select count(*)::integer from hosted_login_transactions
        where issuer = ${issuer} and client_id = ${clientId} and consumed_at is not null) as consumed
  `;
  assert.deepEqual(persisted, { users: 1, identities: 1, sessions: 1, consumed: 1 });

  const csrfToken = cookiePair(csrfCookie).split("=", 2)[1];
  assert.match(csrfToken ?? "", /^[A-Za-z0-9_-]{43}$/u);
  const deniedLogout = await app.inject({
    method: "POST",
    url: HOSTED_LOGOUT_ROUTE,
    headers: {
      origin: "https://attacker.example.com",
      cookie: `${cookiePair(sessionCookie)}; ${cookiePair(csrfCookie)}`,
      [HOSTED_CSRF_HEADER_NAME]: csrfToken!,
    },
  });
  assert.equal(deniedLogout.statusCode, 403);
  const mismatchedCsrfToken = "A".repeat(43);
  assert.notEqual(mismatchedCsrfToken, csrfToken);
  const deniedCsrf = await app.inject({
    method: "POST",
    url: HOSTED_LOGOUT_ROUTE,
    headers: {
      origin,
      cookie: `${cookiePair(sessionCookie)}; ${cookiePair(csrfCookie)}`,
      [HOSTED_CSRF_HEADER_NAME]: mismatchedCsrfToken,
    },
  });
  assert.equal(deniedCsrf.statusCode, 403);
  const stillAuthenticated = await app.inject({
    method: "GET",
    url: HOSTED_SESSION_ROUTE,
    headers: { cookie: cookiePair(sessionCookie) },
  });
  assert.deepEqual(stillAuthenticated.json(), { authenticated: true });

  const logout = await app.inject({
    method: "POST",
    url: HOSTED_LOGOUT_ROUTE,
    headers: {
      origin,
      cookie: `${cookiePair(sessionCookie)}; ${cookiePair(csrfCookie)}`,
      [HOSTED_CSRF_HEADER_NAME]: csrfToken!,
    },
  });
  assert.equal(logout.statusCode, 204);

  const signedOut = await app.inject({
    method: "GET",
    url: HOSTED_SESSION_ROUTE,
    headers: { cookie: cookiePair(sessionCookie) },
  });
  assert.deepEqual(signedOut.json(), { authenticated: false });
  const [revoked] = await database.sql<{ count: number }[]>`
    select count(*)::integer as count
    from browser_sessions as s
    join external_identities as i on i.user_id = s.user_id
    where i.issuer = ${issuer} and i.subject = ${subject}
      and s.revoked_at is not null and s.revocation_reason = 'signed_out'
  `;
  assert.deepEqual(revoked, { count: 1 });
  assert.equal(tokenRequestValidated, true);
  assert.deepEqual(requestCounts, { discovery: 1, token: 1, jwks: 1 });

  console.log(
    "Hosted OIDC composition verification passed one provider snapshot, persisted login, verified callback, session bootstrap, and CSRF-protected logout.",
  );
} catch (error) {
  verificationError = error;
} finally {
  try {
    await app.close();
  } catch {
    cleanupFailed = true;
  }
  let users: { userId: string }[] = [];
  try {
    users = await database.sql<{ userId: string }[]>`
      select user_id as "userId" from external_identities
      where issuer = ${issuer} and subject = ${subject}
    `;
  } catch {
    cleanupFailed = true;
  }
  for (const { userId } of users) {
    for (const operation of [
      () => database.sql`delete from browser_sessions where user_id = ${userId}`,
      () => database.sql`delete from external_identities where user_id = ${userId}`,
      () => database.sql`
        delete from users where id = ${userId}
          and not exists (select 1 from external_identities where user_id = ${userId})
      `,
    ]) {
      try {
        await operation();
      } catch {
        cleanupFailed = true;
      }
    }
    try {
      const [remainingUser] = await database.sql<{ sessions: number; users: number }[]>`
        select
          (select count(*)::integer from browser_sessions where user_id = ${userId}) as sessions,
          (select count(*)::integer from users where id = ${userId}) as users
      `;
      if (remainingUser?.sessions !== 0 || remainingUser.users !== 0) cleanupFailed = true;
    } catch {
      cleanupFailed = true;
    }
  }
  try {
    await database.sql`
      delete from hosted_login_transactions where issuer = ${issuer} and client_id = ${clientId}
    `;
    const [remaining] = await database.sql<{ identities: number; transactions: number }[]>`
      select
        (select count(*)::integer from external_identities
          where issuer = ${issuer} and subject = ${subject}) as identities,
        (select count(*)::integer from hosted_login_transactions
          where issuer = ${issuer} and client_id = ${clientId}) as transactions
    `;
    if (remaining?.identities !== 0 || remaining.transactions !== 0) cleanupFailed = true;
  } catch {
    cleanupFailed = true;
  }
  try {
    await database.close();
  } catch {
    cleanupFailed = true;
  }
}

if (verificationError !== undefined) throw verificationError;
if (cleanupFailed) throw new Error("Hosted OIDC composition verification cleanup failed.");
