# Dormant hosted request authorization seam

Schedule contains a centralized, provider-neutral request boundary for future hosted workspace
routes. The boundary is implemented and tested, but deliberately has no production registration:
`buildApp` and the server do not install it, no browser route is reachable, and the local and
machine-integration trust boundaries are unchanged.

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
headers fail closed. These adapters and serializers are implemented and unit tested, but no login,
callback, session, logout, or workspace route currently calls them.

## Revocation and transaction limit

The read-side membership decision uses one exact indexed statement at `read committed`. A committed
revocation fences subsequent requests. If authorization races a revocation, the request may
linearize immediately before the revocation; the revocation cannot retroactively cancel an
already-authorized in-flight request.

This preflight boundary is therefore not transaction authority for a hosted mutation. Before any
existing product mutation is exposed, its hosted adapter must reauthorize inside the same database
transaction as the product write (with a documented common lock order), or provide an equivalent
database-enforced tenant boundary. The current separate identity and local-product units of work do
not make that stronger claim.

## Deliberately absent

There is still no OIDC discovery or callback, identity-provider verification, route that issues or
clears these cookies, hosted configuration flag, public workspace route, hosted CORS policy,
account-management API, role model, synchronization protocol, or cloud deployment. Integration
credentials remain a separate machine boundary and cannot authenticate a browser principal. Product
routes must remain closed until provider validation and transaction-coupled mutation authorization
have their own negative isolation tests.

## Verification

`pnpm check` covers bounded and duplicate-safe cookie parsing, exact Origin and double-submit CSRF
proof, cookie issue/clear attributes, request isolation, verification-before-authentication ordering,
single authentication, spoof resistance, generic negative responses, response and log redaction,
non-overridable private caching, inconsistent adapter rejection, scoped-route registration, dormant
HTTP closure across safe and unsafe methods, and active/revoked application membership decisions.
`pnpm verify:hosted-identity` drives the production PostgreSQL adapter through active authorization
plus concurrent authorization/revocation (where either valid linearization is allowed) and proves
the committed revocation fences the next decision.
