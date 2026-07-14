# Dormant hosted request authorization seam

Schedule contains a centralized, provider-neutral request boundary for future hosted workspace
routes. The boundary is implemented and tested, but deliberately has no production registration:
`buildApp` and the server do not install it, no browser route is reachable, and the local and
machine-integration trust boundaries are unchanged.

## Boundary contract

Every route registered inside `registerHostedWorkspaceBoundary` must contain a `:workspaceId`
parameter. For each request, the boundary performs this sequence:

1. An injected transport adapter authenticates the request and returns a resolved browser-session
   principal. The boundary never accepts user or workspace identity from arbitrary headers, the
   request body, or provider claims.
2. The principal is validated and cached in a request-keyed `WeakMap`, so the eventual session
   adapter is invoked at most once for that request and no principal can leak to another request.
3. The exact route workspace is checked through `AuthorizeHostedWorkspace`, which reads the binary
   membership keyed by user and workspace.
4. Only an immutable `{ userId, sessionId, workspaceId }` authorization context is exposed to the
   hosted handler. The boundary rejects an adapter result that does not exactly match the
   authenticated principal and requested workspace.

Authentication failures are one generic `401` without prematurely selecting a browser cookie or
Bearer challenge. Invalid workspace identifiers, missing workspaces, cross-user access, and revoked
memberships are the same generic `404`; this prevents the boundary from becoming a workspace or
membership enumeration oracle. Internal adapter failures and inconsistent contexts are logged but
redacted behind one `503`. Every response crossing this seam receives `Cache-Control: no-store`.

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

There is still no OIDC discovery or callback, identity-provider verification, browser cookie,
logout/refresh route, CSRF policy, hosted configuration flag, public workspace route, CORS policy,
account-management API, role model, synchronization protocol, or cloud deployment. Integration
credentials remain a separate machine boundary and cannot authenticate a browser principal.

The next hosted slice may implement provider and cookie transport behind the existing authenticator
port, but it must keep product routes closed until provider validation, CSRF/cookie policy, and
transactional mutation authorization have their own negative isolation tests.

## Verification

`pnpm check` covers request isolation, single authentication, spoof resistance, generic negative
responses, response and log redaction, non-overridable private caching, inconsistent adapter
rejection, scoped-route registration, dormant HTTP closure, and active/revoked application
membership decisions. `pnpm verify:hosted-identity` drives the production PostgreSQL adapter through
active authorization plus concurrent authorization/revocation (where either valid linearization is
allowed) and proves the committed revocation fences the next decision.
