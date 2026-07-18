import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

import { loadApiConfig } from "../packages/config/src/index.js";
import { createDatabase } from "../packages/database/src/index.js";
import {
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWK,
} from "../apps/api/test-support/hosted-oidc-runtime.js";

import {
  createDormantHostedOidcComposition,
  type HostedOidcCompositionTransport,
} from "../apps/api/src/dormant-hosted-oidc-composition.js";
import { prepareHostedApiApp } from "../apps/api/src/hosted-api-runtime.js";
import { HOSTED_TODAY_ACTIVITY_ROUTE } from "../apps/api/src/hosted-today-routes.js";
import { HOSTED_WORKSPACE_LIST_ROUTE } from "../apps/api/src/hosted-workspace-routes.js";
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
} from "../apps/api/src/hosted-auth-lifecycle.js";
import type { HostedWebShell } from "../apps/api/src/hosted-web-shell.js";

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
const pkceKey = Buffer.alloc(32, 17).toString("base64url");
const config = loadApiConfig({
  NODE_ENV: "test",
  DATABASE_URL: databaseUrl,
  HOSTED_API_MODE: "oidc",
  HOSTED_PUBLIC_ORIGIN: origin,
  HOSTED_OIDC_ISSUER: issuer,
  HOSTED_OIDC_CLIENT_ID: clientId,
  HOSTED_OIDC_PREFLIGHT_MODE: "enabled",
  HOSTED_OIDC_TOKEN_AUTH_METHOD: "client_secret_basic",
  HOSTED_OIDC_CLIENT_SECRET: clientSecret,
  HOSTED_LOGIN_TRANSACTION_PEPPER: loginPepper,
  HOSTED_SESSION_PEPPER: sessionPepper,
  HOSTED_LOGIN_PKCE_PRIMARY_KEY_ID: "verification",
  HOSTED_LOGIN_PKCE_KEYS: `verification:${pkceKey}`,
});
const hostedWebShell: HostedWebShell = Object.freeze({
  html: '<!doctype html><div id="root"></div><script src="/assets/hosted-test.js"></script>',
  icon: Buffer.from("<svg></svg>"),
  assets: new Map([
    [
      "hosted-test.js",
      { body: Buffer.from("globalThis.hosted = true;"), contentType: "text/javascript" },
    ],
  ]),
});

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
let app: Awaited<ReturnType<typeof prepareHostedApiApp>>["app"] | null = null;
let verificationError: unknown;
let cleanupFailed = false;

try {
  const prepared = await prepareHostedApiApp(
    config,
    database,
    { logger: false },
    (options) => createDormantHostedOidcComposition({ ...options, transport }),
    async () => hostedWebShell,
  );
  app = prepared.app;
  await app.ready();

  const systemInfo = await app.inject({ method: "GET", url: "/v1/system/info" });
  assert.deepEqual(systemInfo.json(), {
    service: "schedule-api",
    version: "0.1.0",
    architecture: "modular-monolith",
    productEndpointsEnabled: false,
    integrationEndpointsEnabled: false,
    hostedEndpointsEnabled: true,
  });
  assert.equal((await app.inject({ method: "GET", url: "/v1/workspaces" })).statusCode, 404);
  const shell = await app.inject({ method: "GET", url: "/" });
  assert.equal(shell.statusCode, 200);
  assert.equal(shell.headers["cache-control"], "no-store");
  assert.match(shell.headers["content-security-policy"] ?? "", /default-src 'none'/u);
  const shellAsset = await app.inject({ method: "GET", url: "/assets/hosted-test.js" });
  assert.equal(shellAsset.statusCode, 200);
  assert.equal(shellAsset.headers["cache-control"], "public, max-age=31536000, immutable");

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

  const workspaceList = await app.inject({
    method: "GET",
    url: HOSTED_WORKSPACE_LIST_ROUTE,
    headers: { cookie: cookiePair(sessionCookie) },
  });
  assert.equal(workspaceList.statusCode, 200, workspaceList.body);
  assert.equal(workspaceList.headers["cache-control"], "no-store");
  const discovered = workspaceList.json<{
    items: { id: string; name: string }[];
    limit: number;
    offset: number;
  }>();
  assert.deepEqual(
    {
      names: discovered.items.map(({ name }) => name),
      limit: discovered.limit,
      offset: discovered.offset,
    },
    { names: ["My Schedule"], limit: 20, offset: 0 },
  );
  const discoveredWorkspaceId = discovered.items[0]?.id;
  assert.ok(discoveredWorkspaceId);

  const [hostedAccount] = await database.sql<
    { userId: string; workspaceId: string; workspaceName: string; membershipStatus: string }[]
  >`
    select
      identity.user_id as "userId",
      membership.workspace_id as "workspaceId",
      workspace.name as "workspaceName",
      membership.status::text as "membershipStatus"
    from external_identities as identity
    join workspace_memberships as membership on membership.user_id = identity.user_id
    join workspaces as workspace on workspace.id = membership.workspace_id
    where identity.issuer = ${issuer} and identity.subject = ${subject}
  `;
  assert.ok(hostedAccount);
  assert.equal(hostedAccount.workspaceId, discoveredWorkspaceId);
  assert.deepEqual(
    {
      workspaceName: hostedAccount.workspaceName,
      membershipStatus: hostedAccount.membershipStatus,
    },
    {
      workspaceName: "My Schedule",
      membershipStatus: "active",
    },
  );

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

  const csrfToken = cookiePair(csrfCookie).split("=", 2)[1];
  assert.match(csrfToken ?? "", /^[A-Za-z0-9_-]{43}$/u);
  const createdWorkspace = await app.inject({
    method: "POST",
    url: HOSTED_WORKSPACE_LIST_ROUTE,
    headers: {
      origin,
      cookie: `${cookiePair(sessionCookie)}; ${cookiePair(csrfCookie)}`,
      [HOSTED_CSRF_HEADER_NAME]: csrfToken!,
    },
    payload: { name: "Projects" },
  });
  assert.equal(createdWorkspace.statusCode, 201, createdWorkspace.body);
  const createdWorkspaceBody = createdWorkspace.json<{
    id: string;
    name: string;
    createdAt: string;
    updatedAt: string;
  }>();
  assert.deepEqual(Object.keys(createdWorkspaceBody).sort(), [
    "createdAt",
    "id",
    "name",
    "updatedAt",
  ]);
  assert.equal(createdWorkspaceBody.name, "Projects");
  assert.match(
    createdWorkspaceBody.id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
  );
  assert.equal(createdWorkspaceBody.createdAt, createdWorkspaceBody.updatedAt);

  const refreshedWorkspaceList = await app.inject({
    method: "GET",
    url: HOSTED_WORKSPACE_LIST_ROUTE,
    headers: { cookie: cookiePair(sessionCookie) },
  });
  assert.equal(refreshedWorkspaceList.statusCode, 200, refreshedWorkspaceList.body);
  assert.deepEqual(
    refreshedWorkspaceList
      .json<{ items: { id: string; name: string }[] }>()
      .items.map(({ id, name }) => ({ id, name }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    [
      { id: discoveredWorkspaceId, name: "My Schedule" },
      { id: createdWorkspaceBody.id, name: "Projects" },
    ],
  );

  const createdWorkItem = await app.inject({
    method: "POST",
    url: `/v1/hosted/workspaces/${createdWorkspaceBody.id}/work-items`,
    headers: {
      origin,
      cookie: `${cookiePair(sessionCookie)}; ${cookiePair(csrfCookie)}`,
      [HOSTED_CSRF_HEADER_NAME]: csrfToken!,
    },
    payload: { title: "Verified hosted work item" },
  });
  assert.equal(createdWorkItem.statusCode, 201, createdWorkItem.body);
  assert.equal(createdWorkItem.json().workspaceId, createdWorkspaceBody.id);
  const listedWorkItems = await app.inject({
    method: "GET",
    url: `/v1/hosted/workspaces/${createdWorkspaceBody.id}/work-items`,
    headers: { cookie: cookiePair(sessionCookie) },
  });
  assert.equal(listedWorkItems.statusCode, 200, listedWorkItems.body);
  assert.equal(listedWorkItems.headers["cache-control"], "no-store");
  assert.deepEqual(listedWorkItems.json(), {
    items: [
      {
        id: createdWorkItem.json().id,
        title: "Verified hosted work item",
        version: createdWorkItem.json().version,
      },
    ],
    limit: 20,
    offset: 0,
  });
  const listedToday = await app.inject({
    method: "GET",
    url: `/v1/hosted/workspaces/${createdWorkspaceBody.id}/today?date=2026-07-16`,
    headers: { cookie: cookiePair(sessionCookie) },
  });
  assert.equal(listedToday.statusCode, 200, listedToday.body);
  assert.equal(listedToday.headers["cache-control"], "no-store");
  assert.deepEqual(listedToday.json(), {
    date: "2026-07-16",
    planId: null,
    headVersion: null,
    items: [],
    totalMinutes: 0,
  });
  const plannedWorkItem = await app.inject({
    method: "POST",
    url: `/v1/hosted/workspaces/${createdWorkspaceBody.id}/work-items`,
    headers: {
      origin,
      cookie: `${cookiePair(sessionCookie)}; ${cookiePair(csrfCookie)}`,
      [HOSTED_CSRF_HEADER_NAME]: csrfToken!,
    },
    payload: { title: "Verified hosted Today item" },
  });
  assert.equal(plannedWorkItem.statusCode, 201, plannedWorkItem.body);
  const plannedWorkItemBody = plannedWorkItem.json<{ id: string; version: number }>();
  const planId = randomUUID();
  const planItemId = randomUUID();
  const planHeadId = randomUUID();
  await database.sql`
    insert into daily_plans (
      id, workspace_id, local_date, time_zone, status, request_revision,
      algorithm_version, config_version, prng_version, seed, input_hash,
      input_snapshot, total_minutes, fitness, generated_at
    ) values (
      ${planId}::uuid, ${createdWorkspaceBody.id}::uuid, '2026-07-16'::date,
      'America/La_Paz', 'generated', 1, 'hosted-verifier-v1', 'hosted-verifier-v1',
      'hosted-verifier-v1', 'hosted-verifier-seed', ${"0".repeat(64)},
      '{}'::jsonb, 45, 0, '2026-07-16T09:00:00.000Z'::timestamptz
    )
  `;
  await database.sql`
    insert into daily_plan_items (
      id, workspace_id, plan_id, source_type, work_item_id, title_snapshot,
      position, window_index, scheduled_minutes, partial_session, score,
      score_components
    ) values (
      ${planItemId}::uuid, ${createdWorkspaceBody.id}::uuid, ${planId}::uuid,
      'work_item', ${plannedWorkItemBody.id}::uuid, 'Verified hosted Today item',
      0, 0, 45, false, 0, '{}'::jsonb
    )
  `;
  await database.sql`
    insert into daily_plan_heads (
      id, workspace_id, local_date, current_plan_id, version
    ) values (
      ${planHeadId}::uuid, ${createdWorkspaceBody.id}::uuid,
      '2026-07-16'::date, ${planId}::uuid, 1
    )
  `;
  const plannedToday = await app.inject({
    method: "GET",
    url: `/v1/hosted/workspaces/${createdWorkspaceBody.id}/today?date=2026-07-16`,
    headers: { cookie: cookiePair(sessionCookie) },
  });
  assert.equal(plannedToday.statusCode, 200, plannedToday.body);
  assert.deepEqual(plannedToday.json(), {
    date: "2026-07-16",
    planId,
    headVersion: 1,
    items: [
      {
        id: planItemId,
        title: "Verified hosted Today item",
        scheduledMinutes: 45,
        activityState: "pending",
      },
    ],
    totalMinutes: 45,
  });
  const activityRoute = `${HOSTED_TODAY_ACTIVITY_ROUTE.replace(":workspaceId", createdWorkspaceBody.id).replace(":itemId", planItemId)}?date=2026-07-16`;
  const activityHeaders = {
    origin,
    cookie: `${cookiePair(sessionCookie)}; ${cookiePair(csrfCookie)}`,
    [HOSTED_CSRF_HEADER_NAME]: csrfToken!,
    "idempotency-key": "hosted-oidc-today-completion",
  };
  const activityPayload = {
    expectedPlanId: planId,
    expectedHeadVersion: 1,
    type: "completed",
    occurredAt: "2026-07-16T09:30:00.000Z",
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const completionResponse: Awaited<ReturnType<typeof prepared.app.inject>> = await app.inject({
      method: "POST",
      url: activityRoute,
      headers: activityHeaders,
      payload: activityPayload,
    });
    assert.equal(completionResponse.statusCode, 204, completionResponse.body);
    assert.equal(completionResponse.body, "");
    assert.equal(completionResponse.headers["cache-control"], "no-store");
  }
  const staleToday = await app.inject({
    method: "POST",
    url: activityRoute,
    headers: { ...activityHeaders, "idempotency-key": "hosted-oidc-today-stale" },
    payload: { ...activityPayload, type: "started" },
  });
  assert.equal(staleToday.statusCode, 409, staleToday.body);
  assert.equal(staleToday.json<{ error: { code: string } }>().error.code, "planning.head_conflict");
  const completedTodayRead = await app.inject({
    method: "GET",
    url: `/v1/hosted/workspaces/${createdWorkspaceBody.id}/today?date=2026-07-16`,
    headers: { cookie: cookiePair(sessionCookie) },
  });
  assert.deepEqual(completedTodayRead.json(), {
    date: "2026-07-16",
    planId,
    headVersion: 2,
    items: [
      {
        id: planItemId,
        title: "Verified hosted Today item",
        scheduledMinutes: 45,
        activityState: "completed",
      },
    ],
    totalMinutes: 45,
  });
  const completedWorkItem = await app.inject({
    method: "PATCH",
    url: `/v1/hosted/workspaces/${createdWorkspaceBody.id}/work-items/${createdWorkItem.json().id}`,
    headers: {
      origin,
      cookie: `${cookiePair(sessionCookie)}; ${cookiePair(csrfCookie)}`,
      [HOSTED_CSRF_HEADER_NAME]: csrfToken!,
    },
    payload: { expectedVersion: createdWorkItem.json().version, status: "done" },
  });
  assert.equal(completedWorkItem.statusCode, 204, completedWorkItem.body);
  const emptyBacklog = await app.inject({
    method: "GET",
    url: `/v1/hosted/workspaces/${createdWorkspaceBody.id}/work-items`,
    headers: { cookie: cookiePair(sessionCookie) },
  });
  assert.deepEqual(emptyBacklog.json(), { items: [], limit: 20, offset: 0 });

  const [persisted] = await database.sql<
    {
      users: number;
      identities: number;
      sessions: number;
      workspaces: number;
      memberships: number;
      workItems: number;
      doneWorkItems: number;
      activityEvents: number;
      planInteractions: number;
      completedPlanItems: number;
      headVersion: number;
      plannedWorkVersion: number;
      activityTimeZone: string;
      activityLocalDate: string;
      consumed: number;
    }[]
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
      (select count(*)::integer from workspaces
        where id in (${hostedAccount.workspaceId}, ${createdWorkspaceBody.id})) as workspaces,
      (select count(*)::integer from workspace_memberships
        where user_id = ${hostedAccount.userId}
          and workspace_id in (${hostedAccount.workspaceId}, ${createdWorkspaceBody.id})
          and status = 'active') as memberships,
      (select count(*)::integer from work_items
        where workspace_id = ${createdWorkspaceBody.id}) as "workItems",
      (select count(*)::integer from work_items
        where workspace_id = ${createdWorkspaceBody.id} and status = 'done') as "doneWorkItems",
      (select count(*)::integer from activity_events
        where workspace_id = ${createdWorkspaceBody.id}
          and plan_id = ${planId}::uuid and plan_item_id = ${planItemId}::uuid) as "activityEvents",
      (select count(*)::integer from plan_interaction_events
        where workspace_id = ${createdWorkspaceBody.id}
          and plan_id = ${planId}::uuid and item_id = ${planItemId}::uuid) as "planInteractions",
      (select count(*)::integer from daily_plan_item_states
        where workspace_id = ${createdWorkspaceBody.id}
          and plan_id = ${planId}::uuid and activity_state = 'completed') as "completedPlanItems",
      (select version from daily_plan_heads
        where workspace_id = ${createdWorkspaceBody.id}
          and current_plan_id = ${planId}::uuid) as "headVersion",
      (select version from work_items
        where workspace_id = ${createdWorkspaceBody.id}
          and id = ${plannedWorkItemBody.id}::uuid and status = 'done') as "plannedWorkVersion",
      (select time_zone from activity_events
        where workspace_id = ${createdWorkspaceBody.id}
          and plan_id = ${planId}::uuid and plan_item_id = ${planItemId}::uuid
          and type = 'completed' and idempotency_key = 'hosted-oidc-today-completion'
          and occurred_at = '2026-07-16T09:30:00.000Z'::timestamptz) as "activityTimeZone",
      (select local_date::text from activity_events
        where workspace_id = ${createdWorkspaceBody.id}
          and plan_id = ${planId}::uuid and plan_item_id = ${planItemId}::uuid
          and idempotency_key = 'hosted-oidc-today-completion') as "activityLocalDate",
      (select count(*)::integer from hosted_login_transactions
        where issuer = ${issuer} and client_id = ${clientId} and consumed_at is not null) as consumed
  `;
  assert.deepEqual(persisted, {
    users: 1,
    identities: 1,
    sessions: 1,
    workspaces: 2,
    memberships: 2,
    workItems: 2,
    doneWorkItems: 2,
    activityEvents: 1,
    planInteractions: 1,
    completedPlanItems: 1,
    headVersion: 2,
    plannedWorkVersion: 2,
    activityTimeZone: "America/La_Paz",
    activityLocalDate: "2026-07-16",
    consumed: 1,
  });
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
    "Hosted OIDC activation verification passed enabled config, hardened same-origin shell, first-login workspace discovery, transaction-authorized work creation, and CSRF-protected logout, plus bounded backlog read and empty Today read and a transaction-authorized status update, plus principal-bound workspace creation. Hosted Today completion also proved exact idempotent replay, one activity append, one head advance, and atomic source completion, while a stale head left no residue and the plan time zone remained authoritative.",
  );
} catch (error) {
  verificationError = error;
} finally {
  try {
    await app?.close();
  } catch {
    cleanupFailed = true;
  }
  let accounts: { userId: string; workspaceId: string | null }[] = [];
  try {
    accounts = await database.sql<{ userId: string; workspaceId: string | null }[]>`
      select identity.user_id as "userId", membership.workspace_id as "workspaceId"
      from external_identities as identity
      left join workspace_memberships as membership on membership.user_id = identity.user_id
      where identity.issuer = ${issuer} and identity.subject = ${subject}
    `;
  } catch {
    cleanupFailed = true;
  }
  for (const userId of new Set(accounts.map((account) => account.userId))) {
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
  for (const workspaceId of new Set(accounts.flatMap(({ workspaceId }) => workspaceId ?? []))) {
    try {
      await database.sql.begin(async (sql) => {
        await sql`select set_config('schedule.allow_activity_event_mutation', 'on', true)`;
        await sql`select set_config('schedule.allow_audit_event_mutation', 'on', true)`;
        await sql`select set_config('schedule.allow_plan_interaction_event_mutation', 'on', true)`;
        await sql`select set_config('schedule.allow_plan_mutation_change', 'on', true)`;
        await sql`delete from workspaces where id = ${workspaceId}`;
      });
    } catch {
      cleanupFailed = true;
    }
  }
  try {
    await database.sql`
      delete from hosted_login_transactions where issuer = ${issuer} and client_id = ${clientId}
    `;
    const [remaining] = await database.sql<
      { identities: number; transactions: number; workspaces: number; workItems: number }[]
    >`
      select
        (select count(*)::integer from external_identities
          where issuer = ${issuer} and subject = ${subject}) as identities,
        (select count(*)::integer from hosted_login_transactions
          where issuer = ${issuer} and client_id = ${clientId}) as transactions,
        (select count(*)::integer from workspaces
          where id = any(${accounts.flatMap(({ workspaceId }) => workspaceId ?? [])}::uuid[])) as workspaces,
        (select count(*)::integer from work_items
          where workspace_id = any(${accounts.flatMap(({ workspaceId }) => workspaceId ?? [])}::uuid[])) as "workItems"
    `;
    if (
      remaining?.identities !== 0 ||
      remaining.transactions !== 0 ||
      remaining.workspaces !== 0 ||
      remaining.workItems !== 0
    ) {
      cleanupFailed = true;
    }
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
