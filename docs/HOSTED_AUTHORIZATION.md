# Dormant hosted request authorization seam

Schedule contains a centralized, provider-neutral request boundary for future hosted workspace
routes, a provider-neutral browser authentication lifecycle registrar, and one transaction-coupled
hosted work-item-create registrar. A separate pre-authentication foundation now coordinates bounded
state, browser binding, nonce, and PKCE material. All are implemented and tested, but deliberately
have no production registration: `buildApp` and the server do not install them, no browser route is
reachable, and the local and machine-integration trust boundaries are unchanged.

## Disabled runtime configuration gate

`HOSTED_API_MODE` defaults to and accepts only `disabled`. While it is disabled, configuration
rejects every non-empty companion `HOSTED_*` environment value before API startup without echoing a
variable name or value that may contain credentials. Empty placeholders are inert. This flag cannot
register the login lifecycle, workspace boundary, or work-item route; `buildApp` has no hosted
runtime input and `/v1/system/info` always reports `hostedEndpointsEnabled: false`.

This gate records an explicit production posture, not an enabling mechanism. A later provider slice
must add its own complete proof flow, bounded secret and lifetime policy, exact HTTPS origin, and
intentional route composition before the accepted mode can be widened.

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

## Dormant login transaction foundation

`StartHostedLoginTransaction` and `ConsumeHostedLoginTransaction` establish the server-side
transaction that a future authorization-code flow must use. They are application services only:
there is no start route, callback route, browser-binding cookie serializer, provider adapter, or
runtime configuration that can call them.

Starting a transaction generates four independent 256-bit base64url values:

- authorization `state`, sent to and returned by the identity provider;
- a browser-binding bearer value intended for a future host-only, secure, HttpOnly, SameSite cookie;
- the OIDC nonce that a future ID-token verifier must match exactly; and
- a PKCE verifier whose SHA-256 challenge is the only verifier-derived value sent to the provider.

Migration `0036` adds `hosted_login_transactions`. It persists purpose-separated peppered
HMAC-SHA-256 digests of state and browser binding, never either plaintext value. It stores the nonce
and S256 challenge, plus an AES-256-GCM-protected PKCE verifier whose authenticated additional data
binds it to the transaction UUID. The protector includes a non-secret key identifier so a key ring
can decrypt in-flight transactions across rotation while new transactions use only the selected
primary key. Exact issuer, client ID, redirect URI, and bounded local return path are immutable
transaction fields. No provider token, authorization code, user, email, or profile claim is stored.

PostgreSQL `clock_timestamp()` is authoritative. TTL is restricted to 60–900 seconds. Consumption
HMACs the presented state, locks the one matching row `FOR UPDATE`, compares the independent browser
binding in constant time, rejects the exact expiry boundary, decrypts and re-derives the stored PKCE
challenge, then records consumption with an optimistic version in the same serializable transaction.
Malformed, missing, wrong-binding, expired, and replayed presentations all return the same `null`.
Concurrent valid presentations therefore have exactly one winner. Corrupt or wrongly bound
ciphertext fails before consumption and rolls back. Cleanup deletes only expired rows, ordered by
expiry and UUID, with `FOR UPDATE SKIP LOCKED` and a caller limit of at most 1,000.

Successful consumption returns a short-lived in-process continuation containing the exact provider
and redirect bindings, `expectedNonce`, and recovered PKCE verifier. A future callback must consume
this transaction before code exchange and must pass `expectedNonce` into a verifier contract that
cannot omit nonce validation. An exchange or verification failure starts a new login; a consumed
transaction is never reopened. The current opaque-proof lifecycle is not wired to this continuation
and must not be described as an authorization-code implementation.

## Dormant OIDC ID-token verifier

`JoseOidcIdTokenVerifier` is the concrete, still-unwired verifier for an ID token returned by that
future authorization-code callback. Its input requires one compact signed token plus the exact
issuer, client identifier, and 256-bit nonce recovered from the consumed login transaction. The
caller cannot use a convenience overload that omits nonce verification. The token is bounded to 16
KiB before JOSE parsing.

Every verifier instance requires an explicit subset of asymmetric `RS*`, `PS*`, `ES*`, or `EdDSA`
algorithms. Symmetric `HS*` and unsecured tokens are not available. The protected header requires a
bounded `kid`; it rejects token-controlled `jku`, `x5u`, `jwk`, and `x5c` key material or locations,
critical or unencoded-payload extensions, and unrelated `typ` values before calling the injected
key resolver. The resolver itself has a hard 100–10,000 ms deadline, defaulting to five seconds.

After signature verification, the adapter requires exact issuer and audience matching, `sub`,
`exp`, `iat`, and `nonce`, validates optional `nbf`, caps accepted token age at the login-transaction
TTL, and applies at most two minutes of explicitly configured clock tolerance. An `azp` claim, when
present, must equal the exact client identifier; it is mandatory when `aud` contains more than one
unique bounded value. The nonce comparison uses fixed-length digests and constant-time equality.
Only a printable ASCII subject of at most 255 characters whose combined issuer/subject UTF-8 key
fits the persistence bound can become `{ issuer, subject }`; email, name, and all other claims are
discarded.

Malformed, expired, mismatched, wrongly signed, unknown-key, and ambiguous-key credentials return
the same `null`. Resolver failures, deadlines, invalid trusted continuation metadata, clock failure,
and invalid verifier policy throw one stable operational error with no cause, token, claim, key,
endpoint, or provider error text. A future route must preserve that distinction as generic `401`
versus redacted `503` behavior.

The injected resolver is trusted deployment composition, not discovery logic. Future wiring must
derive its HTTPS JWKS location from the exact configured issuer and validated provider metadata,
apply SSRF and redirect policy, cache bounded keys across rotation, and avoid logging private token
data. The verifier does not import into `buildApp`, `server.ts`, configuration, or a route; it cannot
make the dormant hosted surface reachable.

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

There is still no OIDC discovery or remote-JWKS composition, authorization endpoint, callback or
code exchange, production-registered authentication route, browser-binding cookie, enabling hosted
configuration, public workspace route, hosted CORS policy, account-management API, role model,
synchronization protocol, or cloud deployment.
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
`pnpm verify:hosted-runtime-gate` launches the real API entry point twice: premature companion
configuration must fail before listening without disclosing its value, while the explicit disabled
mode must report hosted capabilities off and keep representative authentication and workspace
routes at `404`.
`pnpm verify:hosted-login-transactions` migrates a disposable database and proves digest-only state
and browser binding, authenticated PKCE recovery, exact provider/redirect binding, twelve-way
single-use consumption, database-clock expiry, corruption rollback and redaction, and bounded
cleanup through the production PostgreSQL adapter.
`pnpm verify:oidc-id-token` runs the focused generated-key suite for exact transaction binding,
signature and asymmetric-algorithm policy, OIDC claim/time validation, hostile protected headers,
key selection, malformed and oversized tokens, operational deadlines, and error redaction. The same
suite is part of `pnpm check`; the existing runtime gate proves the module remains unreachable.
