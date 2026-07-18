# Hosted identity persistence foundation

Schedule has a provider-neutral identity, browser-session, and workspace-membership model. The
surface is closed by default. With complete `HOSTED_API_MODE=oidc` configuration, the production API
uses it for login, session, logout, first-login workspace bootstrap, and one transaction-authorized
work-item create route plus authenticated name-only workspace creation. The local unauthenticated
product boundary remains separate.

This is a narrow hosted foundation, not a complete hosted product. It can list and create a signed-in
user's workspaces through a small same-origin shell, but has no workspace rename/delete or membership
administration, broad product route set, synchronization protocol, or verified public deployment.

## Persisted model

Four identity tables are introduced by migration `0031`:

- `users` stores only a generated principal ID, active/disabled lifecycle, optimistic version, and
  timestamps. It does not store a name, email, avatar, provider claim, password, or role.
- `external_identities` binds a user to the exact provider `issuer` and `subject`. The pair uses a
  `C`-collated unique index; application lookup and provisioning preserve case, whitespace, and
  Unicode bytes rather than merging through email or display claims. The exact pair is capped at
  2,000 UTF-8 bytes in both the domain and database so every accepted value remains safely
  indexable by PostgreSQL's B-tree implementation.
- `browser_sessions` stores a public UUID selector and a peppered HMAC-SHA-256 digest. The 256-bit
  bearer secret exists only in the issued token and is never persisted. Idle and absolute expiry,
  revocation reason, and optimistic version are explicit.
- `workspace_memberships` is a binary active/revoked authorization relationship. It has no role or
  implicit ownership semantics.

Migration `0036` separately adds `hosted_login_transactions` for unauthenticated authorization-code
coordination. It has no user or workspace foreign key. State and browser-binding bearer values are
represented only by purpose-separated HMAC digests; the PKCE verifier is authenticated ciphertext;
exact issuer, client ID, redirect URI, nonce, S256 challenge, expiry, and one-time consumption are
explicit. See [HOSTED_AUTHORIZATION.md](./HOSTED_AUTHORIZATION.md#login-transaction-foundation).
Migration `0037` adds only the user/status/workspace membership index used by bounded hosted
discovery; it changes no identity or workspace data.

Identity deletion cascades through external identities, sessions, and memberships. It does not
delete a workspace or any task, plan, reminder, or audit data in that workspace. Workspace lifecycle
must remain an explicit product action rather than an authentication side effect.

## Provisioning and concurrency

`PostgresIdentityUnitOfWork` is separate from the local product and machine-integration transaction
contexts. Hosted callers use this boundary rather than widening every local repository operation
with optional identity state.

External identity provisioning runs at `read committed`, obtains a transaction-scoped advisory lock
for an injective serialization of the exact issuer/subject pair, then re-reads the binding. Concurrent
first login therefore creates exactly one user, one identity, one `My Schedule` workspace, and one
active membership in the same transaction. Replay returns the existing binding without creating
another workspace. The database's exact unique index remains the durable final constraint; a hash
collision can only serialize unrelated provisioning attempts.

Additional hosted workspace provisioning writes a workspace and membership atomically. The public
command first locks the active user and exact browser session in the global order, rechecks session
ownership and both expiries at PostgreSQL time, and performs both inserts in that transaction. A
rotation, logout, expiry, or disablement that wins first leaves no workspace residue. Trusted
internal provisioning and the public command deliberately do not use the local installation's
20-workspace operational cap, which belongs to the single-user materialization worker rather than
hosted account authorization.

## Session contract

`HmacBrowserSessionTokenCodec` emits a UUID selector plus a 32-byte random base64url secret. The
digest binds a token version, selector, secret, and deployment-supplied pepper. The pepper must be at
least 32 bytes and must come from a secret manager in a hosted deployment.

PostgreSQL time is authoritative for issuance, idle refresh, absolute expiry, rotation, and
revocation. Validation performs a non-locking ownership probe, then uses one global user-before-session
row-lock order and constant-time digest comparison. This avoids a disable-versus-rotation deadlock
without weakening the user lock that fences new session issuance. Malformed, unknown,
expired, revoked, and disabled-user sessions all resolve to the same `null` result. Rotation revokes
the old selector and inserts a new digest in one transaction without extending the original absolute
lifetime or providing a replay grace period. Disabling a user revokes every still-active global
session. Revoking one workspace membership does not revoke sessions for the user's other
workspaces.

## Deliberately absent

The activated slice has no refresh token, password, WebFinger issuer discovery, email-link,
identity/profile response, workspace rename/delete or membership administration, collaboration
roles, or account management. The workspace list exposes only active memberships. It does not bind a WhatsApp account,
replace integration credentials, or enable synchronization. `HOSTED_API_MODE=disabled` keeps every
hosted route closed; `oidc` is accepted only with complete secret-manager-fed configuration and
leaves the local product routes disabled. See
[HOSTED_AUTHORIZATION.md](./HOSTED_AUTHORIZATION.md) for the exact gate and route contract.

## Verification

Run:

```powershell
pnpm verify:hosted-identity
pnpm verify:hosted-identity-migrations
pnpm verify:hosted-login-transactions
pnpm verify:oidc-id-token
pnpm verify:oidc-authorization-request
pnpm verify:oidc-remote-jwks
pnpm verify:oidc-provider-metadata
pnpm verify:oidc-token-exchange
pnpm verify:hosted-oidc-lifecycle
pnpm verify:hosted-oidc-composition-db
```

The first command migrates a nonce database and drives the production application and PostgreSQL
adapters through concurrent exact provisioning with one default workspace, digest-only issuance,
active membership discovery, rotation replay resistance, disable/resolve/rotation lock races,
membership isolation, principal-bound creation with post-rotation denial, 21 further trusted hosted
workspace provisions, forced membership-insert rollback without workspace residue, user disablement,
and deletion preservation.
The second upgrades a populated pre-`0031` database, validates exact binding uniqueness and cascade
direction, and proves legacy workspace/work-item data survives. The third independently exercises
the pre-authentication unit of work through concurrent exactly-once consumption, protected PKCE
recovery, expiry, rollback, and cleanup. Those three database commands drop their disposable
databases and are included in `pnpm verify:database`. The ID-token command independently verifies
the verifier with generated signing keys and no network access; it is included in
`pnpm check`. The authorization-request command proves exact issued provider bindings and canonical,
injection-safe authorization URL construction. The remote-JWKS command composes the verifier with a
mandatory fake transport to prove bounded retrieval, caching, rotation, and failure classification.
The provider-metadata command proves official issuer-path derivation, exact response binding,
required code-flow capabilities, immutable snapshots, hard retrieval bounds, and compatibility with
the authorization and key boundaries. The token-exchange command proves exact transaction-bound
PKCE redemption, all supported client-authentication methods, no retry, strict token-response
bounds, access/refresh-token discard, and handoff to the nonce-bound verifier. The composition
command then parses enabled configuration and drives the production route assembly against a strict
in-process provider plus PostgreSQL, including first-login workspace bootstrap and an authenticated
workspace create whose new membership immediately authorizes an authenticated work-item create.
None performs an external network request.
