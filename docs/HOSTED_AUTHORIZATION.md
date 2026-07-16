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
this transaction before invoking the dormant exchanger below and must pass `expectedNonce` into a
verifier contract that cannot omit nonce validation. An exchange or verification failure starts a
new login; a consumed transaction is never reopened or retried. The current opaque-proof lifecycle
is not wired to this continuation and must not be described as an authorization-code route.

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

The injected resolver is trusted deployment composition, not discovery logic. The dormant pinned
resolver and provider-metadata loader below now supply bounded implementations, but future wiring
must still bind them to the same exact configured issuer and provide a connection-safe transport.
The verifier does not import into `buildApp`, `server.ts`, configuration, or a route; it cannot make
the dormant hosted surface reachable.

## Dormant pinned remote-JWKS resolver

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

This is not by itself a production SSRF boundary. The mandatory transport must disable or explicitly
govern proxies, resolve and vet every connected address, reject local/private/reserved destinations,
resist DNS rebinding, and preserve TLS hostname and certificate verification. No such production
transport, discovery composition, configuration, route, callback, or server registration exists in
this slice.

## Dormant trusted OIDC discovery/provider metadata

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

This adapter is still dormant. Its required transport has no production DNS/IP/proxy/TLS
implementation, and the snapshot is not registered with the authorization builder, token exchanger,
JWKS resolver, ID-token verifier, runtime configuration, routes, callback, or server.

## Dormant OIDC authorization-request builder

`StrictOidcAuthorizationRequestBuilder` converts one freshly issued login transaction into a
deterministic authorization-code URL without performing network I/O. The application transaction
result now carries the exact validated issuer, client identifier, and redirect URI copied from its
persisted record, alongside state, browser binding, nonce, S256 challenge, method, and expiry. These
provider bindings are in-process coordination values; a future route must never serialize the raw
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
does not import into `buildApp`, `server.ts`, configuration, or a route. The separate provider
metadata snapshot and token exchanger are not composed with it; request-time endpoint extensions,
browser-binding cookie transport, redirects, callback processing, and session issuance remain
separate work.

## Dormant OIDC authorization-code token exchange

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
nonce-bound verifier is the sole path from that value to `{ issuer, subject }`. A bounded OAuth `400`
is a generic rejected credential (`null`); outages, malformed responses, redirects, ambiguous
timeouts, and client-authentication failures become one stable redacted availability error.

This exchanger remains dormant. It has no production connection-safe transport, runtime/client
secret configuration, authorization-start route, callback parser, browser-binding cookie, session
issuance, account provisioning, server registration, or retry facility. The provider metadata
integration test composes discovery, authorization request, exchange, JWKS resolution, and ID-token
verification only through injected transports; it does not expose HTTP.

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

There is still no WebFinger issuer discovery, production metadata/JWKS/token transport or
composition, hosted authorization-start endpoint or callback, production-registered authentication
route, browser-binding cookie, enabling hosted configuration, public workspace route, hosted CORS
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
`pnpm verify:oidc-authorization-request` rebuilds the core packages, proves exact provider bindings
leave the transaction service, and runs the builder's canonical encoding, injection, scope,
configuration, transaction-integrity, size, and redaction cases. It performs no external requests;
the same tests and dormant-route evidence run in `pnpm check`.
`pnpm verify:oidc-remote-jwks` rebuilds the core packages and runs the generated-key resolver and
ID-token suites. Injected transports prove exact request shape, bounded streaming and parsing,
redirect and malformed-response denial, cache reuse, unknown-key cooldown, rotation refresh,
concurrent single-flight behavior, error redaction, and rejection of token-controlled key URLs. The
command performs no external network request; the same evidence runs in `pnpm check`.
`pnpm verify:oidc-provider-metadata` rebuilds the core packages and runs provider discovery plus its
authorization-request and remote-JWKS compatibility suites. Injected transports prove the official
root/path discovery URL, exact issuer equality, required metadata and local S256 policy, immutable
successful snapshots, shared cold requests, retry after failure, hard timeout, bounded JSON,
endpoint/query compatibility, and redacted failure. It performs no external request; dormant-route
and runtime-gate evidence remains part of `pnpm check`.
`pnpm verify:oidc-token-exchange` rebuilds the core packages and runs the exchanger, shared bounded
JSON, provider-metadata composition, and generated-key ID-token suites. It proves the exact POST and
form/authentication-method matrix, parameter-injection and endpoint-query collision denial,
transaction binding, no retry, abort/deadline behavior across transport and body, response/header/
cache bounds, OAuth rejection classification, secret/token redaction, and mandatory verifier
handoff. It performs no external request; the runtime gate continues to prove HTTP closure.
