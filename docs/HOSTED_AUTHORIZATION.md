# Dormant hosted request authorization seam

Schedule contains a centralized, provider-neutral request boundary for future hosted workspace
routes, a provider-neutral browser authentication lifecycle registrar, and one transaction-coupled
hosted work-item-create registrar. All are implemented and tested, but deliberately have no
production registration: `buildApp` and the server do not install them, no browser route is
reachable, and the local and machine-integration trust boundaries are unchanged.

## Boundary contract

Every route registered inside `registerHostedWorkspaceBoundary` must contain a `:workspaceId`
parameter. For each request, the boundary performs this sequence:

1. An injected CSRF guard verifies the browser transport. Safe methods pass without a token; every
   unsafe method must satisfy the exact configured Origin and double-submit proof before session or
   membership work begins.
2. An injected transport adapter authenticates the request and returns a resolved browser-session
   principal. The boundary never accepts user or workspace identity from arbitrary headers, the
   request body, or provider claims.
3. The principal is validated and cached in a request-keyed `WeakMap`, so the session adapter is
   invoked at most once for that request and no principal can leak to another request.
4. The exact route workspace is checked through `AuthorizeHostedWorkspace`, which reads the binary
   membership keyed by user and workspace.
5. Only an immutable `{ userId, sessionId, workspaceId }` authorization context is exposed to the
   hosted handler. The boundary rejects an adapter result that does not exactly match the
   authenticated principal and requested workspace.

Authentication failures are one generic `401` without a `WWW-Authenticate` challenge or detailed
credential error. Invalid workspace identifiers, missing workspaces, cross-user access, and revoked
memberships are the same generic `404`; this prevents the boundary from becoming a workspace or
membership enumeration oracle. Invalid Origin or CSRF proof receives one generic `403` before
authentication or authorization. Internal adapter failures and inconsistent contexts are logged
but redacted behind one `503`. Every response crossing this seam receives `Cache-Control: no-store`.

## Dormant browser transport contract

`HostedBrowserSessionAuthenticator` accepts only one bounded raw `Cookie` header and exactly one
canonical `__Host-schedule_session=<selector>.<secret>` pair. The selector is a lowercase UUID and
the secret is the 43-character base64url representation emitted by the application session codec.
Malformed pairs, duplicate cookie fields or names, ambiguous comma-joined input, more than 64 cookie
pairs, and headers larger than 4 KiB fail before PostgreSQL session resolution. Arbitrary identity
headers are ignored. Resolver outages are allowed to reach the central boundary so they remain a
redacted `503` instead of being misreported as an invalid credential.

The session serializer emits `Path=/; Secure; HttpOnly; SameSite=Lax` and no `Domain`, satisfying the
`__Host-` contract. It deliberately creates a browser-session cookie without client `Expires` or
`Max-Age`: PostgreSQL remains authoritative for sliding idle and fixed absolute expiry, so a stale
client timestamp cannot terminate a legitimately refreshed session. The clear helper uses the same
scope plus both `Max-Age=0` and a past `Expires` value.

`HostedBrowserCsrfGuard` requires an exact, canonical HTTPS Origin on every method other than `GET`,
`HEAD`, and `OPTIONS`. It compares one `__Host-schedule_csrf` cookie with one `X-Schedule-CSRF`
header using fixed-length validation and constant-time equality. The 256-bit CSRF token helper emits
a script-readable `Path=/; Secure; SameSite=Lax` host cookie; it intentionally omits `HttpOnly` so a
same-origin browser client can copy the token into the header. Duplicate Origin, Cookie, or proof
headers fail closed.

## Dormant authentication lifecycle contract

`registerHostedAuthLifecycle` composes those transport helpers with injected identity and session
application ports. It is a registrar, not production wiring: no call site in `buildApp`, the server,
configuration, or deployment manifests installs it. Direct registrar tests exercise three routes:

- `GET /v1/auth/session` resolves only the hardened session cookie, returns exactly
  `{ "authenticated": true | false }`, and emits a fresh CSRF cookie even when there is no active
  session. It never returns a user, provider, workspace, or session identifier.
- `POST /v1/auth/login` requires exact Origin and double-submit CSRF proof before body, provider, or
  database work. It accepts one strict `{ "proof": string }` object, bounds the JSON body to 16 KiB
  and the opaque proof to 12 KiB, and passes the unchanged proof to an injected verifier. Only an
  exact, bounded issuer/subject pair returned by that verifier may reach
  `FindOrProvisionHostedUser`; the lifecycle then requires the provisioner to return that same exact
  identity bound to the same active user before a session may be issued under an injected lifetime
  policy. Success is an empty `204` with hardened session and fresh CSRF cookies.
- `POST /v1/auth/logout` applies the same CSRF check first, parses the canonical session token once,
  requests `signed_out` revocation when possible, and clears both host cookies. Missing, malformed,
  unknown, already-revoked, and successful sessions all produce the same empty `204`; an internal
  revocation outage is a redacted `503`, but local cookies are still cleared.

All lifecycle responses receive `Cache-Control: no-store`. Invalid credentials and disabled users
share one generic `401`; CSRF denial is one generic `403`; verifier, persistence, session, and
contract failures are logged without private values and returned as one generic `503`. The verifier
port is intentionally not an identity provider implementation. A future adapter must verify its
protocol completely—including exact issuer allowlisting, signatures and algorithm policy,
audience/authorized-party claims, timestamps, nonce, and the state/redirect/PKCE rules of any code
flow—before returning issuer and subject. Email, display name, or other claims can never substitute
for that exact provider identity.

## Preflight transaction limit

The read-side membership decision uses one exact indexed statement at `read committed`. A committed
revocation fences subsequent requests. If authorization races a revocation, the request may
linearize immediately before the revocation; the revocation cannot retroactively cancel an
already-authorized in-flight request.

This preflight boundary is therefore not transaction authority for a hosted mutation. Every hosted
mutation must reauthorize inside the same database transaction as the product write (with a
documented common lock order), or provide an equivalent database-enforced tenant boundary. It is
never sufficient to call the separate identity and local-product units of work in sequence.

## Dormant transaction-coupled work-item create

`registerHostedWorkItemBoundary` inseparably composes the hosted authentication, CSRF, and workspace
authorization boundary with one route:
`POST /v1/hosted/workspaces/:workspaceId/work-items`. It accepts the same strict work-item body as
the local create route, derives workspace authority only from the immutable hosted boundary context,
ignores identity-shaped headers, rejects identity fields in the body, and returns `201` for a
successful create. A path/context mismatch fails as the same generic `workspace.not_found` response.
The registrar is not installed by `buildApp`, the server, configuration, or deployment manifests.

`CreateHostedWorkItem` adapts a specialized hosted mutation unit of work to the existing product
create use case without nesting transactions. In one PostgreSQL transaction the adapter locks and
checks, in this order:

1. the exact hosted user `FOR UPDATE`, requiring active status;
2. the exact browser session `FOR UPDATE`, requiring the same user, no revocation, and idle plus
   absolute availability at authoritative `clock_timestamp()`;
3. the exact workspace `FOR KEY SHARE`, fencing deletion before the cascading membership child is
   locked;
4. the exact `(user_id, workspace_id)` membership `FOR UPDATE`, requiring active status; and
5. only then, any product graph locks, workspace/parent reads, work-item insert, and hierarchy audit.

This global user-before-session order matches session resolution and user disablement. Locking the
workspace before membership avoids an inverse order with workspace deletion. The membership lock is
the common linearization point with revocation/reactivation, and all locks remain held through the
product commit or rollback. A create that acquires the locks first may commit before a queued
revocation; a revocation that commits first makes the create fail without product or audit residue.
A committed logout, disabled user, expired session, missing workspace, cross-tenant tuple, or revoked
membership likewise denies the write. Authentication loss is a generic `401`; workspace or
membership loss is the same generic `404`; unexpected adapter/database failures remain redacted.

## Deliberately absent

There is still no OIDC discovery or callback, concrete identity-provider verifier, production-
registered authentication route, hosted configuration flag, public workspace route, hosted CORS
policy, account-management API, role model, synchronization protocol, or cloud deployment.
Integration credentials remain a separate machine boundary and cannot authenticate a browser
principal. The dormant work-item create is the only transaction-coupled hosted product mutation;
all other product routes remain local-only and require their own transaction authority before any
future hosted exposure.

## Verification

`pnpm check` covers bounded and duplicate-safe cookie parsing, exact Origin and double-submit CSRF
proof, cookie issue/clear attributes, strict and bounded login input, exact verified-identity
provisioning and binding consistency, session bootstrap without identity disclosure, disabled-user
denial, logout idempotency and revocation, request isolation, verification-before-credential-work
ordering, single authentication, spoof resistance, generic negative responses, response and log
redaction, non-overridable private caching, inconsistent adapter rejection, scoped-route
registration, dormant HTTP closure across safe and unsafe methods, and active/revoked application
membership decisions.
`pnpm verify:hosted-identity` drives the production PostgreSQL adapter through active authorization
plus concurrent authorization/revocation (where either valid linearization is allowed) and proves
the committed revocation fences the next decision.
`pnpm verify:hosted-mutation-authorization` provisions disposable hosted identities, sessions,
workspaces, and memberships, then drives the production hosted/product transaction adapter through
an authorized create, cross-tenant combinations, committed membership/session/user/expiry denial,
both forced create-versus-revocation linearizations, and rollback isolation. It also proves a denied
or failed create leaves no work item or hierarchy audit; a bounded membership write immediately
after the forced rollback probes that its authorization locks were released.
