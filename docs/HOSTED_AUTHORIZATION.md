# Hosted request authorization and OIDC runtime

Schedule contains a centralized browser authentication lifecycle and workspace-authorization
boundary. It is closed by default. With `HOSTED_API_MODE=oidc`, the server preflights one trusted
provider, installs login/callback/session/logout, and exposes one transaction-authorized work-item
create route plus principal-bound workspace list/create. Local unauthenticated product routes remain
disabled and machine integration credentials remain a separate trust boundary.

## Runtime configuration gate

`HOSTED_API_MODE` defaults to `disabled` and accepts `oidc` only with one complete
non-secret registration made of `HOSTED_PUBLIC_ORIGIN`, `HOSTED_OIDC_ISSUER`, and
`HOSTED_OIDC_CLIENT_ID`. The origin and issuer must be bounded exact canonical default-port HTTPS
values, the client ID is bounded and control-free, and the callback URI is derived rather than
configured. All three absent or empty is inert; a partial set fails startup. The separate
`HOSTED_OIDC_PREFLIGHT_MODE` defaults to `disabled`; its secret companions are accepted only as one
complete set when explicitly `enabled`. Mixed-case aliases and every unknown non-empty `HOSTED_*`
value are rejected without echoing a variable name or value that may contain credentials.

Preflight alone does not expose routes. OIDC mode additionally requires the complete preflight,
forces `PRODUCT_API_MODE=disabled`, installs the hosted surface only after successful discovery, and
reports `hostedEndpointsEnabled: true`. `HOSTED_RATE_LIMIT_PER_MINUTE` bounds the complete hosted
route group per resolved client address. The in-process bucket map is capped at 4,096 least-recently
used addresses so source churn cannot grow memory without bound. Disabled mode keeps capability
reporting false and every hosted route absent even when operators stage and validate the provider
graph.

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

## Browser transport contract

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

## Authentication lifecycle contract

`registerHostedAuthLifecycle` composes those transport helpers with the login-transaction, OIDC,
identity, and session application ports. The production app installs it only after the explicit
runtime gate succeeds. Direct registrar tests exercise four routes:

- `GET /v1/auth/session` resolves only the hardened session cookie, returns exactly
  `{ "authenticated": true | false }`, and emits a fresh CSRF cookie even when there is no active
  session. It never returns a user, provider, workspace, or session identifier.
- `GET /v1/auth/login` accepts no query input. It creates one fixed-policy transaction, builds the
  authorization URL from that exact result, emits the opaque browser binding only in the hardened
  `__Host-schedule_login` cookie, and returns a `303` provider redirect with `no-store` and
  `no-referrer` response policy.
- `GET /v1/auth/callback` accepts exactly one bounded visible-ASCII `code`, one 256-bit `state`, and
  exactly one valid browser-binding cookie. It ignores unknown successful-response extensions as
  OAuth requires; when the provider supplies RFC 9207 `iss`, it accepts one bounded value and binds
  it exactly to the consumed transaction issuer. It consumes the transaction before making one code
  exchange, passes the consumed issuer/client/nonce into the ID-token verifier, accepts only a
  bounded exact issuer/subject identity, provisions that identity, and issues the session. A first
  identity provision atomically creates one `My Schedule` workspace and active membership; a replay
  creates neither again. Success clears the login binding, emits hardened session and fresh CSRF
  cookies, and returns a `303` only to the consumed bounded local path under the fixed hosted origin.
- `POST /v1/auth/logout` applies the same CSRF check first, parses the canonical session token once,
  requests `signed_out` revocation when possible, and clears both host cookies. Missing, malformed,
  unknown, already-revoked, and successful sessions all produce the same empty `204`; an internal
  revocation outage is a redacted `503`, but local cookies are still cleared.

All lifecycle responses receive `Cache-Control: no-store`. Login and callback redirects additionally
receive `Referrer-Policy: no-referrer`. Malformed, missing, duplicate, provider-rejected, replayed,
or wrong-browser callback credentials and disabled users share one generic `401`; CSRF denial is one
generic `403`; verifier, persistence, session, and
contract failures are logged without private values and returned as one generic `503`. A consumed
transaction is never reopened and exchange is never retried. Email, display name, or other claims
can never substitute for the exact provider identity returned by the nonce-bound verifier.

## Login transaction foundation

`StartHostedLoginTransaction` and `ConsumeHostedLoginTransaction` establish the server-side
transaction used by the authorization-code lifecycle. The enabled registrar and binding-cookie
transport call them directly.

Starting a transaction generates four independent 256-bit base64url values:

- authorization `state`, sent to and returned by the identity provider;
- a browser-binding bearer value emitted only in the host-only, secure, HttpOnly, SameSite cookie;
- the OIDC nonce that the callback's ID-token verifier must match exactly; and
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
and redirect bindings, `expectedNonce`, and recovered PKCE verifier. The callback consumes this
transaction before invoking the exchanger below and passes `expectedNonce` into a verifier contract
that cannot omit nonce validation. An exchange or verification failure requires a new login; a
consumed transaction is never reopened or retried.

## OIDC ID-token verifier

`JoseOidcIdTokenVerifier` is the concrete verifier accepted by the callback's structural
port. Its input requires one compact signed token plus the exact
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
endpoint, or provider error text. The lifecycle preserves that distinction as generic `401`
versus redacted `503` behavior.

The injected resolver is trusted deployment composition, not discovery logic. The pinned resolver,
provider-metadata loader, and direct transport below bind it to the exact configured issuer when
OIDC mode is enabled.

## Direct OIDC HTTPS transport

`directOidcHttpsFetch` is the production connection-level transport shared by the future discovery,
remote-JWKS, and token clients. It accepts only the exact canonical default-port HTTPS URLs already
required by those adapters and an ordinary DNS hostname: literal IPs, credentials, fragments,
special-use names, non-default ports, and non-canonical spellings fail before DNS.

Every lookup requests all answers in verbatim order, accepts at most 32, and rejects the complete set
when any IPv4 or IPv6 address is malformed, private, local, reserved, documentation-only,
benchmarking, multicast, or otherwise outside globally routable unicast space. It snapshots the
validated set and pins the first address into the HTTPS request's lookup callback, preventing a
second DNS resolution from changing the destination. The original hostname remains both the HTTP
host and TLS server name, certificate verification stays enabled, the request uses no agent or
ambient proxy, and redirects are surfaced rather than followed.

The transport accepts only the existing bounded GET shape or the one-shot token POST shape. It
rejects caller-controlled framing, hop-by-hop, proxy, forwarding, host, credential, referrer, and
redirect behavior. The caller's abort signal covers DNS and the HTTPS request; failures expose only
one stable availability error. Responses retain the exact requested URL and stream into the existing
bounded OIDC readers, which continue to own status, content type, cache, header, body, and hard-time
limits. The transport adds no retry and no provider/runtime configuration.

The enabled production composition uses this adapter for discovery, JWKS, and token exchange.

## Pinned remote-JWKS resolver

`createOidcRemoteJwksResolver` binds one exact issuer to one deployment-controlled HTTPS JWKS URI
and returns a frozen provider snapshot plus a JOSE signing-key resolver. Configuration is copied
once so later mutation and accessor-backed time-of-check/time-of-use changes cannot retarget the
provider. The issuer and JWKS URI are capped at 2 KiB, use only default-port HTTPS, and reject raw
whitespace, controls, backslashes, credentials, fragments, and silently normalized spellings. The
issuer cannot contain a query. A bounded query may remain in the pinned JWKS URI because it is
trusted provider metadata, never token or request input.

There is deliberately no implicit global `fetch`. Construction requires an injected transport. The
adapter calls it only for the exact canonical JWKS URI with `GET`, manual redirects, an abort signal,
identity encoding, and no authorization, cookie, proxy-authorization, forwarding, or request-derived
headers. Redirects and every status other than `200` fail closed. Only JSON or JWK-set JSON is
accepted. Both declared and streamed decoded bodies are capped at 64 KiB before a fatal UTF-8 decode
and JSON parse; the document must contain between one and 32 plain-object keys. Provider response,
endpoint, and transport exception details are never propagated through the verifier's operational
error contract.

One resolver instance keeps JOSE's in-memory cache and single-flight refresh behavior. Retrieval is
bounded to three seconds, an unknown key cannot trigger another reload for 30 seconds, and a
successful set is refreshed after five minutes. Matching cached keys avoid network access; an
unknown or ambiguous key remains an invalid credential, while transport and malformed-response
failures remain redacted availability failures.

Exact URL binding and response bounds are not by themselves a production SSRF boundary. The direct
OIDC HTTPS transport now supplies the required proxy, DNS-answer, address-pinning, rebinding, and TLS
controls. The complete factory constructs this resolver for its frozen dependency graph before any
enabled callback or workspace route is registered.

## Trusted OIDC discovery/provider metadata

`OidcProviderMetadataDiscovery` starts from one deployment-controlled issuer rather than an
end-user identifier. Following OpenID Connect Discovery 1.0, it removes one terminating issuer
slash and appends `/.well-known/openid-configuration`; root and path issuers therefore produce one
deterministic default-port HTTPS document URL. The original issuer spelling remains the trust key.
The returned metadata `issuer` must match it byte for byte without Unicode normalization, and the
same value must later match the ID token's `iss` claim. WebFinger issuer discovery is not part of
this adapter.

Construction snapshots the exact issuer and mandatory injected transport once. A cold `discover()`
uses the shared bounded OIDC JSON loader for one `GET` with manual redirects, an abort signal,
identity encoding, and no credential or forwarding headers. A separate hard deadline fails even a
transport that ignores cancellation after three seconds. Only `200 application/json` is accepted;
the final response URL must remain exact, and declared plus streamed decoded content is capped at 64
KiB before fatal UTF-8 decoding and JSON parsing. Concurrent cold calls share one request. A failed
request is not cached; the first successful result becomes one immutable process-lifetime snapshot,
so authorization, token, and key endpoints cannot be mixed across metadata versions. A deliberate
configuration reload must construct a new discovery object.

The document must provide the OIDC-required exact issuer, authorization endpoint, token endpoint,
JWKS URI, response types, subject types, and ID-token signing algorithms. Every published endpoint
is a bounded canonical default-port HTTPS URL without credentials or fragments. The authorization
endpoint may retain only the same bounded non-reserved query parameters accepted by the request
builder. Response types must contain `code`; subject types are limited to `public` and `pairwise`;
the provider algorithm list must include the specification-required `RS256`; and the exported
algorithm policy is the deterministic asymmetric subset supported by the ID-token verifier.

For this application's authorization-code policy, advertised grant types, response modes, and
scopes must support `authorization_code`, `query`, and `openid` when present (the specification
defaults are applied when omitted). The provider must explicitly advertise PKCE `S256`. Token
endpoint authentication is reduced to the deterministic supported subset of
`client_secret_basic`, `client_secret_post`, and `none`, with the specification default of
`client_secret_basic` when the field is absent. Extra metadata is ignored and never enters the
trusted snapshot.

The complete factory constructs this frozen snapshot and direct transport with the authorization
builder, token exchanger, JWKS resolver, and ID-token verifier. Enabled routes share that one
process-lifetime snapshot; hot metadata refresh remains absent.

## OIDC authorization-request builder

`StrictOidcAuthorizationRequestBuilder` converts one freshly issued login transaction into a
deterministic authorization-code URL without performing network I/O. The application transaction
result now carries the exact validated issuer, client identifier, and redirect URI copied from its
persisted record, alongside state, browser binding, nonce, S256 challenge, method, and expiry. These
provider bindings are in-process coordination values; the route never serializes the raw
transaction object.

The builder snapshots one trusted provider configuration at construction and requires the issued
transaction's issuer, client identifier, and redirect URI to match it byte for byte. The issuer,
authorization endpoint, and redirect URI are bounded HTTPS URLs without credentials or fragments.
Raw whitespace, controls, and backslashes are rejected. The endpoint may retain at most 16 bounded
trusted query parameters, but none may collide with a protocol parameter. Client identifiers are
bounded and control-free.

The output appends exactly one of each fixed parameter, in a canonical order:
`response_type=code`, `client_id`, `redirect_uri`, `scope`, `state`, `nonce`, `code_challenge`, and
`code_challenge_method=S256`. `URLSearchParams` performs form encoding; values cannot inject another
parameter. Bounded non-reserved parameters already present in the trusted provider endpoint are
preserved; request-time arbitrary provider parameters are not accepted. Scopes follow the OAuth
visible-ASCII token grammar, are unique and bounded, require lowercase `openid` exactly once, and
are emitted as `openid` followed by the remaining tokens in bytewise order. The final encoded URL
is capped at 8 KiB.

Malformed trusted configuration, altered provider bindings, malformed transaction secrets, a
non-S256 method, expiry at the exact trusted clock boundary, invalid clock behavior, hostile runtime
getters, and an oversized final URL all throw one stable redacted configuration error. The builder
is invoked by the lifecycle after transaction creation. Production composition supplies provider
metadata and the connection-safe transport before routes are registered.

## OIDC authorization-code token exchange

`StrictOidcAuthorizationCodeTokenExchanger` redeems one opaque authorization code only after the
server-side login transaction has been consumed. Construction snapshots one validated provider
metadata view, exact client ID and redirect URI, mandatory injected transport, and exactly one
provider-advertised authentication method: `client_secret_basic`, `client_secret_post`, or `none`.
There is no method fallback. Basic credentials follow OAuth form encoding before Base64; post
credentials appear only in the form; a public client sends `client_id` without any credential.
Secrets are bounded and control-free. They never enter returned values, error messages, or log
context; JavaScript strings cannot be reliably zeroed, so their lifetime and scope remain minimal.

`exchange()` accepts the full consumed continuation, snapshots it once, and requires exact issuer,
client ID, redirect URI, 43-character recovered PKCE verifier, nonce, and consumption time before
I/O. A user-supplied authorization code is opaque but bounded to 2 KiB of visible ASCII and is always
encoded with `URLSearchParams`; it cannot add a form field. The endpoint may retain at most 16
bounded trusted query parameters, but none may collide with `grant_type`, `code`, `redirect_uri`,
`code_verifier`, `client_id`, or `client_secret`.

Each invocation makes exactly one `POST` with manual redirects, omitted credentials, no referrer,
identity encoding, and fixed no-cache request headers. The form contains one each of
`grant_type=authorization_code`, `code`, the original `redirect_uri`, and `code_verifier`, plus only
the selected client-auth fields. A hard three-second deadline covers transport, headers, and the
streamed body even when the injected transport ignores cancellation. There is deliberately no
retry: a timeout can happen after the provider consumed the single-use code, so any ambiguous
failure requires a new login.

Only an exact non-redirected final URL with `200`, bounded OAuth `400`, or `401` is read. Response
headers are count/size bounded and must contain exact `Cache-Control: no-store` and `Pragma:
no-cache` directives. JSON media type, declared length, decoded stream, fatal UTF-8, and JSON parsing
are bounded; a success must contain a visible bounded access token, case-insensitive `Bearer` type,
and a compact signed ID token, with bounded optional fields. Access and refresh tokens are validated
then discarded. The only returned value is a frozen still-untrusted `{ idToken }`; the existing
nonce-bound verifier is the sole path from that value to `{ issuer, subject }`. A bounded OAuth
`invalid_grant` is a generic rejected credential (`null`); other `400` errors, outages, malformed
responses, redirects, ambiguous
timeouts, and client-authentication failures become one stable redacted availability error.

The lifecycle invokes the exchanger after consuming the state/browser transaction and before
verification, provisioning, and session issuance. The complete factory constructs it with the
direct transport and configured client authentication. Ambiguous exchange remains non-retryable.

## Preflight transaction limit

The read-side membership decision uses one exact indexed statement at `read committed`. A committed
revocation fences subsequent requests. If authorization races a revocation, the request may
linearize immediately before the revocation; the revocation cannot retroactively cancel an
already-authorized in-flight request.

This preflight boundary is therefore not transaction authority for a hosted mutation. Every hosted
mutation must reauthorize inside the same database transaction as the product write (with a
documented common lock order), or provide an equivalent database-enforced tenant boundary. It is
never sufficient to call the separate identity and local-product units of work in sequence.

## Transaction-coupled work-item create

`registerHostedWorkItemBoundary` inseparably composes the hosted authentication, CSRF, and workspace
authorization boundary with one route:
`POST /v1/hosted/workspaces/:workspaceId/work-items`. Its strict body accepts only a title plus
optional priority, due date, and planning duration. The server fixes parent and description to null
and status to backlog, derives workspace authority only from the immutable hosted boundary context,
rejects every extra field, and returns only the same narrow scheduling projection with `201`. A
path/context mismatch fails as the same generic `workspace.not_found` response.
The registrar is installed only in OIDC mode.

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

## Authenticated workspace discovery and creation

`GET /v1/hosted/workspaces?limit=20&offset=0` crosses the same cookie, CSRF, and principal boundary
without accepting identity from headers or query input. It returns a stable page of workspace
records joined only through the caller's active memberships, ordered by workspace ID. The limit is
1–20 and the offset is 0–1,000; unknown query fields are rejected. The response contains
no user ID, session ID, membership state, role, inactive workspace, or total count and always uses
`Cache-Control: no-store`.

The list join is one `read committed` statement backed by the bounded
`(user_id, status, workspace_id)` access path. A membership revocation committed before that
statement is excluded; a concurrent revocation cannot retract an already-authorized read. The
collection also accepts CSRF-protected `POST /v1/hosted/workspaces` with exactly one trimmed,
bounded `name`. The handler derives the user and session only from the authenticated principal. In
one `read committed` transaction, `CreateHostedWorkspaceForPrincipal` locks that user and then the
exact browser session, uses PostgreSQL time to recheck active ownership, revocation, idle expiry,
and absolute expiry, and only then inserts the workspace and active membership atomically. Any lost
authentication is the same generic `401` and leaves neither row behind.

Creation returns only the workspace record with `201`; it accepts no user, membership, role, or
identity field. The collection cannot retrieve details, rename, delete, invite, change membership,
or grant roles.

## Bounded hosted backlog read

`GET /v1/hosted/workspaces/:workspaceId/work-items` crosses the existing hosted cookie and
workspace-membership preflight and accepts no query fields. It reuses the product work-item list
inside a separate read transaction with fixed `status=backlog`, `limit=20`, and `offset=0`. The
response is the stable first page ordered by creation time and ID and projects only each item's
`id`, `title`, optimistic `version`, priority, due date, and planning duration, plus the fixed page
bounds. It omits descriptions, hierarchy, identity data, and totals and always uses
`Cache-Control: no-store`.

This is a read-side operation under the preflight transaction limit above: a committed revocation
fences the next request but cannot retract an already-authorized in-flight read. Path/context
mismatch, deletion after preflight, and membership denial all remain the same generic `404` without
private repository detail. The endpoint adds no filtering, paging, or synchronization authority;
the version exists only for the strict status mutation below.

## Transaction-coupled hosted status update

`PATCH /v1/hosted/workspaces/:workspaceId/work-items/:workItemId` accepts exactly a positive
`expectedVersion` and either `in_progress` or `done`, then returns `204`. It rejects titles,
descriptions, priority, dates, duration, hierarchy, identity fields, other statuses, and unknown
companions. A stale version returns a fixed `409` and is never retried as a user mutation.
The transaction also requires the persisted source status to remain `backlog`, so learning or
guessing a later version cannot reopen an item after the first accepted transition.

`UpdateHostedWorkItemStatus` adapts the same hosted mutation unit of work used by create to the
existing product update use case. User, session, workspace, and membership are therefore rechecked
and locked in the same PostgreSQL transaction as the versioned status change and pending reminder
intent invalidation. The route cannot reopen, cancel, block, reparent, or otherwise edit work.

## Bounded hosted Today read

`GET /v1/hosted/workspaces/:workspaceId/today?date=YYYY-MM-DD` crosses the same hosted cookie and
workspace-membership preflight. It accepts exactly one real Gregorian local date and reads only an
already-generated current plan; the GET never generates or changes one. A missing plan returns that date
with null plan/head identity, an empty item list, and zero minutes.

The response projects only the current plan ID and head version, ordered item IDs/titles/scheduled
minutes/activity states, and total minutes. Those IDs are optimistic mutation fences, not a general
plan-detail surface. It omits source identity, time zone, scores, reasons, warnings, and input data.
The browser supplies its current local date because
workspaces do not yet own a persisted time zone. Authorization failures use the same generic tenant
denial, `Cache-Control: no-store`, and read-side revocation boundary as the backlog snapshot.

## Bounded hosted Plan Fit guidance

`GET /v1/hosted/workspaces/:workspaceId/daily-plan-fit-insight?forDate=YYYY-MM-DD` accepts exactly
one real Gregorian local date behind the same cookie and active-membership boundary. It reuses the
deterministic 90-day Plan Fit calculation but projects only the requested date, status, disposition,
sample/minimum counts, nullable joint targets, and exact nullable evidence key. It omits historical
plans, item/activity data, typical values, thresholds, feedback timestamps, and outcome history.
Reading or displaying the projection writes no feedback and changes no planning input.

The hosted shell requests guidance only while the selected day has no current plan. A suggestion is
never applied automatically: **Use …** copies both targets and retains its exact key, after which the
user may still edit either target. Insufficient, aligned, or locally dismissed guidance is explained
as read-only status and changes nothing. A failed guidance read leaves manual generation usable and
independently retryable.

## Transaction-coupled hosted first-plan generation

`POST /v1/hosted/workspaces/:workspaceId/today?date=YYYY-MM-DD` accepts one strict body containing
an IANA `timeZone`, one offset-bearing `{ startsAt, endsAt }` window, a positive `targetMinutes`
bounded to 1–1,440, and a positive `targetTaskCount` bounded to 1–64. Both ends must define a
positive window wholly inside the requested date in that zone. Unknown fields, multiple windows,
planner configuration, energy, contexts, source choices, minimums, maximums, revisions, and
arbitrary Plan Fit fields are rejected. The only optional Plan Fit input is a nullable exact
64-character lowercase evidence key. A required 1–160 character `Idempotency-Key` is not persisted
as a separate request receipt; the runtime prefixes it into the existing deterministic planner seed.

The runtime fixes balanced fit, null energy, empty contexts, and revision 1, then invokes the
existing `GenerateDailyPlan` through `TransactionallyAuthorizedHostedUnitOfWork`. The ordinary
planner day lock therefore serializes competing requests while the same transaction rechecks user,
session, workspace, and membership before reading candidates and persisting the plan. An exact
request/key replay returns the existing revision with `204` and no second plan. A different seed or
input after revision 1 exists fails with `409`; the browser retains the exact intent only across an
ambiguous transport failure and otherwise refreshes Today. There is no regeneration, multi-window
calendar exclusion, stored planning profile, or hosted planner-settings surface.

When the optional Plan Fit key is present, `GenerateDailyPlan` locks the workspace feedback stream,
recalculates the bounded evidence, and requires the same available suggestion before inserting the
plan. The exact key, evidence summary, and final user-edited targets are appended as one `used`
receipt in that same authorized transaction. A stale/dismissed key creates neither plan nor receipt;
an exact ambiguous replay requires the matching receipt and creates no duplicate. Hosted mode does
not expose dismissal/reset or outcome-history management.

## Transaction-coupled hosted Today action

`POST /v1/hosted/workspaces/:workspaceId/today/:itemId/activity-events?date=YYYY-MM-DD`
accepts exactly the current `expectedPlanId`, positive `expectedHeadVersion`,
`type=started|completed|skipped`,
one offset-bearing `occurredAt`, and a required 1–160 character `Idempotency-Key`, then returns `204`.
It accepts no time zone, duration, reason, metadata, source identity, or other activity type. The
browser retains the same timestamp and key only for an ambiguous retry; a stale head is a `409` that
must refresh Today instead of replaying against new state.

The runtime resolves the expected plan's immutable time zone server-side and delegates to the
existing plan-activity use case through `TransactionallyAuthorizedHostedUnitOfWork`. User, exact
session, workspace, and membership are therefore rechecked and locked in the same PostgreSQL
transaction as the activity append, item-state projection, single head advance, reminder-intent
invalidation, and conditional source-work-item completion. Exact replay returns the prior result
without a second append or head advance.

## Hosted capture shell

Explicit OIDC mode also serves one same-origin capture page at `/`. The production API loads the
Vite-built document, favicon, and bounded `.js`/`.css` asset set before listening. Missing,
unexpected, empty, individually oversized, or collectively oversized build output fails startup
through one redacted error and closes the shared database connection.

The server exposes only `/`, `/favicon.svg`, and exact known `/assets/:asset` names. It has no
wildcard fallback, so it cannot shadow `/v1`, `/health`, or future product routes. The document is
`no-store` and carries a restrictive same-origin content-security policy, no-referrer policy,
framing denial, and MIME sniffing denial. Fingerprinted assets are immutable for one year. Static
requests sit outside the hosted API's per-source request budget.

The browser reads only `{ authenticated }`, the active workspace page, the first 20 backlog item
IDs/titles/versions plus priority/due-date/planning-duration summaries, the narrow current-day
projection and concurrency fences above, the bounded Plan Fit projection while no plan exists, the
created workspace, and the created work item. It never receives provider tokens, user or session identifiers, membership state, or
roles. A signed-in user may create or choose one active workspace, review Today and the bounded
backlog snapshot, submit one title with optional scheduling fields, move one visible backlog item to started or done, or
explicitly prefill Plan Fit targets and build the missing current-day revision from one editable window and two limits, or
start/complete/skip one actionable Today item. The script
copies the exact host-only CSRF cookie into the existing header for all strict mutations; the server
remains authoritative for identity, membership, defaults, validation, and optimistic versions. The
page cannot regenerate an existing plan, page, filter, generally edit fields, reopen, cancel, synchronize work,
rename/delete a workspace, or administer membership or accounts.

## Deliberately absent

There is still no WebFinger issuer discovery, workspace rename/delete or membership administration,
broader hosted product interface or route set, account-management API, role model, synchronization
protocol, or verified public deployment.
Integration credentials remain a separate machine boundary and cannot authenticate a browser
principal. Name-only workspace creation, narrow scheduling-field work creation, status-only update,
first-plan generation, and start/complete/skip Today action are the only transaction-coupled hosted
mutations. The bounded backlog, current-day, and Plan Fit projections are the only hosted
product-data reads; all other product routes remain local-only and require their own
authority before future hosted exposure.

## Concrete OIDC composition

`createDormantHostedOidcComposition` is one async factory for the complete authentication dependency
graph. It accepts the validated non-secret registration, a database connection, explicit login and
session peppers, a rotating PKCE key ring, the selected provider-advertised token authentication
method, and (only for strict tests) an alternate transport. Production defaults to the direct,
DNS-pinned HTTPS transport.

Before provider I/O, the factory snapshots the registration and client authentication, verifies the
exact derived callback binding, constructs the HMAC codecs and AES-GCM protector, and creates the
PostgreSQL login and identity units of work. It then performs one bounded discovery, freezes that
metadata snapshot, and uses the same issuer, endpoints, signing algorithms, client, redirect, and
transport to build the authorization request, token exchange, remote-JWKS, ID-token verification,
identity provisioning, session issue/resolve/revoke, browser authentication, and CSRF components.
The fixed policy is a five-minute login, one-hour idle session, one-day absolute session,
`openid` scope, and `/` continuation.

The factory returns only a frozen `HostedAuthLifecycleDependencies` object. It never creates a
Fastify app or changes `HOSTED_API_MODE`; enabled server composition owns route registration.

## Production runtime preflight

`HOSTED_OIDC_PREFLIGHT_MODE=enabled` requires the complete non-secret registration plus an explicit
token authentication method, optional method-appropriate client secret, independent login and
session HMAC peppers, a primary PKCE key identifier, and one to sixteen canonical AES-256-GCM keys.
The accepted secret variables are `HOSTED_OIDC_TOKEN_AUTH_METHOD`, `HOSTED_OIDC_CLIENT_SECRET`,
`HOSTED_LOGIN_TRANSACTION_PEPPER`, `HOSTED_SESSION_PEPPER`, `HOSTED_LOGIN_PKCE_PRIMARY_KEY_ID`, and
`HOSTED_LOGIN_PKCE_KEYS` (`key-id:base64url-32-byte-key` entries). Operators must inject these values
through their hosting platform's secret manager; source control and plain deployment manifests are
not acceptable secret stores.

Parsing is bounded, rejects control and Unicode formatting characters, canonicalizes every key,
requires the primary key to exist, and produces one deeply frozen preflight object. The production
server constructs it before building the normal Fastify app. Construction performs one bounded
provider discovery and fails startup through one redacted error; even cleanup failure cannot replace
that error. A preflight or app-construction failure closes the shared database connection before the
error is rethrown. Disabled mode retains the graph without exposure. OIDC mode passes it to
`buildApp`, registers the hosted route group, and reports the capability.

Rotation is restart-based. New PKCE transactions use the primary key; old keys may overlap for at
least the five-minute login lifetime before removal. The current HMAC codecs accept one pepper each:
rotating the login pepper invalidates outstanding logins, while rotating the session pepper
intentionally signs out existing browser sessions. Provider metadata and secrets are not hot-reloaded;
a change requires construction of a new process graph.

## Verification

`pnpm check` covers bounded and duplicate-safe cookie parsing, exact Origin and double-submit CSRF
proof, cookie issue/clear attributes, query-free login start, bounded callback credentials and browser
binding, consume-before-exchange ordering, nonce-bound verification handoff, fixed-origin local
redirects, no retry, exact verified-identity provisioning and binding consistency, session bootstrap
without identity disclosure, disabled-user denial, logout idempotency and revocation, request
isolation, verification-before-credential-work
ordering, single authentication, spoof resistance, generic negative responses, response and log
redaction, non-overridable private caching, inconsistent adapter rejection, scoped-route
registration, disabled-mode HTTP closure across safe and unsafe methods, bounded source tracking,
and active/revoked application membership decisions.
`pnpm verify:hosted-identity` drives the production PostgreSQL adapter through active membership
discovery and authorization plus concurrent authorization/revocation (where either valid
linearization is allowed) and proves the committed revocation fences the next decision and list.
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
`pnpm verify:hosted-oidc-composition-db` parses complete enabled configuration, builds the production
hosted route graph with a strict in-process provider, and drives login, callback, one-time replay
denial, hardened shell delivery, default-workspace discovery, authenticated transaction-coupled
work creation, session bootstrap, CSRF denial, logout, and cleanup against PostgreSQL. It also
proves exact first-plan replay, different-input conflict, one persisted planner revision without
synthetic rows, an authenticated Today completion, exact replay without duplicate activity, one
head advance, atomic source completion, and that the local unauthenticated workspace routes are absent.
`pnpm verify:hosted-web-e2e` builds the isolated hosted browser entry and exercises signed-out and
authenticated capture in Chromium. It verifies workspace selection, optional scheduling-field payloads,
first-plan controls, Today completion, exact CSRF/idempotency forwarding, success feedback,
360-pixel overflow, and mobile action sizing with a strict
in-browser API double. It does not claim external-provider or public-ingress coverage.
`pnpm verify:hosted-login-transactions` migrates a disposable database and proves digest-only state
and browser binding, authenticated PKCE recovery, exact provider/redirect binding, twelve-way
single-use consumption, database-clock expiry, corruption rollback and redaction, and bounded
cleanup through the production PostgreSQL adapter.
`pnpm verify:oidc-id-token` runs the focused generated-key suite for exact transaction binding,
signature and asymmetric-algorithm policy, OIDC claim/time validation, hostile protected headers,
key selection, malformed and oversized tokens, operational deadlines, and error redaction. The same
suite is part of `pnpm check`; the existing runtime gate proves the module remains unreachable.
`pnpm verify:oidc-authorization-request` rebuilds the core packages, proves exact provider bindings
leave the transaction service, and runs the builder's canonical encoding, injection, scope,
configuration, transaction-integrity, size, and redaction cases. It performs no external requests;
the same tests and disabled-route evidence run in `pnpm check`.
`pnpm verify:oidc-remote-jwks` rebuilds the core packages and runs the generated-key resolver and
ID-token suites. Injected transports prove exact request shape, bounded streaming and parsing,
redirect and malformed-response denial, cache reuse, unknown-key cooldown, rotation refresh,
concurrent single-flight behavior, error redaction, and rejection of token-controlled key URLs. The
command performs no external network request; the same evidence runs in `pnpm check`.
`pnpm verify:oidc-provider-metadata` rebuilds the core packages and runs provider discovery plus its
authorization-request and remote-JWKS compatibility suites. Injected transports prove the official
root/path discovery URL, exact issuer equality, required metadata and local S256 policy, immutable
successful snapshots, shared cold requests, retry after failure, hard timeout, bounded JSON,
endpoint/query compatibility, and redacted failure. It performs no external request; disabled-route
and runtime-gate evidence remains part of `pnpm check`.
`pnpm verify:oidc-token-exchange` rebuilds the core packages and runs the exchanger, shared bounded
JSON, provider-metadata composition, and generated-key ID-token suites. It proves the exact POST and
form/authentication-method matrix, parameter-injection and endpoint-query collision denial,
transaction binding, no retry, abort/deadline behavior across transport and body, response/header/
cache bounds, OAuth rejection classification, secret/token redaction, and mandatory verifier
handoff. It performs no external request; the runtime gate continues to prove HTTP closure.
`pnpm verify:oidc-direct-https` rebuilds the core packages and runs the direct transport together
with discovery, remote-JWKS, token-exchange, and bounded-response compatibility suites. Mocked DNS
and HTTPS seams prove all-answer validation, private/mixed-set denial, address pinning, hostname and
certificate preservation, proxy/redirect/framing denial, abort behavior, streamed exact-URL
responses, and redacted failures without making an external request.
`pnpm verify:hosted-oidc-lifecycle` rebuilds the core packages and runs the start/callback,
browser-cookie, authorization-request, token-exchange, and ID-token suites. It proves query-free
start, exact state/code/browser binding, optional issuer binding, consume-before-exchange ordering,
mandatory nonce handoff,
fixed-origin local redirects, hardened cookie transitions, generic failure classification, and no
retry. It performs no external request.
`pnpm verify:hosted-oidc-composition` rebuilds the core packages and runs the concrete factory with
a strict in-process provider transport plus the lifecycle, discovery, direct-HTTPS, token, JWKS, and
verifier compatibility suites. It proves single-snapshot wiring, fixed policy, exact endpoint and
client propagation, secret snapshot isolation, local-failure-before-I/O ordering, and redaction. It
makes no external request.
`pnpm verify:hosted-runtime-preflight` validates the complete immutable secret set, public-client and
confidential-client authentication modes, PKCE rotation overlap, bounds and redaction, stable startup
failure mapping, preflight-before-app ordering, default route closure, enabled registration, and
capability reporting.
It injects the factory in-process and performs no external network request.
`pnpm verify:hosted-oidc-composition-db` uses the migrated configured PostgreSQL database plus a
strict in-process signed OIDC provider, registers the returned graph only in a private Fastify test
instance, and completes login, persisted one-shot callback, JWKS verification, identity provisioning,
session bootstrap, authenticated session lookup, and CSRF-protected logout. It cleans its nonce-bound
rows and makes no external network request.
