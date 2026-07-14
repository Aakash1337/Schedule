# Hosted identity persistence foundation

Schedule contains a dormant, provider-neutral persistence foundation for future hosted browser
authentication. It establishes identity, session, and workspace-membership invariants without
opening an HTTP route, setting a cookie, selecting an identity provider, or changing the local
product's trust boundary.

This is deliberately not a claim that hosted authentication is complete. Production remains closed
until a later slice adds one centralized request-authentication seam, provider verification,
session-cookie and CSRF policy, route authorization, and deployment configuration.

## Persisted model

Four tables are introduced by migration `0031`:

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

Identity deletion cascades through external identities, sessions, and memberships. It does not
delete a workspace or any task, plan, reminder, or audit data in that workspace. Workspace lifecycle
must remain an explicit product action rather than an authentication side effect.

## Provisioning and concurrency

`PostgresIdentityUnitOfWork` is separate from the local product and machine-integration transaction
contexts. Future hosted callers must use this boundary rather than widening every local repository
operation with optional identity state.

External identity provisioning runs at `read committed`, obtains a transaction-scoped advisory lock
for an injective serialization of the exact issuer/subject pair, then re-reads the binding. Concurrent
first login therefore creates one user and one identity. The database's exact unique index remains
the durable final constraint; a hash collision can only serialize unrelated provisioning attempts.

Hosted workspace provisioning writes the workspace and first membership atomically. It deliberately
does not use the local installation's 20-workspace operational cap, which belongs to the single-user
materialization worker rather than hosted account authorization.

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

This foundation has no login, callback, logout, refresh, password, OIDC discovery, email-link,
cookie, CSRF, browser principal, or public membership route. It does not read identity claims, bind a
WhatsApp account, replace integration credentials, or enable synchronization. No environment flag
can accidentally expose it.

The next hosted slice should add a centralized request-authentication and workspace-authorization
seam while keeping all production product routes closed by default. Provider and browser-session
transport should follow only after that seam has negative isolation tests.

## Verification

Run:

```powershell
pnpm verify:hosted-identity
pnpm verify:hosted-identity-migrations
```

The first command migrates a nonce database and drives the production application and PostgreSQL
adapters through concurrent exact provisioning, digest-only issuance, rotation replay resistance,
disable/resolve/rotation lock races, membership isolation, 21 hosted workspace provisions, user
disablement, and deletion preservation.
The second upgrades a populated pre-`0031` database, validates exact binding uniqueness and cascade
direction, and proves legacy workspace/work-item data survives. Both commands drop their disposable
databases and are included in `pnpm verify:database`.
