# Hosted identity persistence foundation

Schedule contains a dormant, provider-neutral persistence foundation for future hosted browser
authentication. It establishes identity, session, and workspace-membership invariants without
opening an HTTP route, selecting an identity provider, or changing the local product's trust
boundary. A separate dormant transport can serialize the session into a hardened cookie, but no
runtime currently calls it.

This is deliberately not a claim that hosted authentication is complete. Production remains closed
until later slices add provider verification, route-level login/session lifecycle, transaction-
coupled product authorization, and deployment configuration. The centralized request seam and
cookie/CSRF policy are implemented but unreachable.

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
explicit. See [HOSTED_AUTHORIZATION.md](./HOSTED_AUTHORIZATION.md#dormant-login-transaction-foundation).

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
browser principal route, or public membership route. It does not read identity claims, bind a
WhatsApp account, replace integration credentials, or enable synchronization. No environment flag
can expose it: `HOSTED_API_MODE` accepts only `disabled`, and non-empty companion `HOSTED_*`
configuration fails startup without disclosing the configured value. Strict session-cookie
serialization/parsing and double-submit CSRF transport now exist behind the centralized request
seam, but no production route issues or consumes them.

The centralized request-authentication and workspace-authorization seam now exists but is not wired
into `buildApp`; see [HOSTED_AUTHORIZATION.md](./HOSTED_AUTHORIZATION.md). The dormant browser-session
and CSRF transport, a replay-safe login-transaction foundation, a nonce-bound OIDC ID-token
verifier, and one transaction-coupled hosted work-item create now sit behind that seam. Provider
discovery and key-resolver composition, authorization-code transport, and the broader hosted product
surface remain absent while production routes stay closed by default.

## Verification

Run:

```powershell
pnpm verify:hosted-identity
pnpm verify:hosted-identity-migrations
pnpm verify:hosted-login-transactions
pnpm verify:oidc-id-token
```

The first command migrates a nonce database and drives the production application and PostgreSQL
adapters through concurrent exact provisioning, digest-only issuance, rotation replay resistance,
disable/resolve/rotation lock races, membership isolation, 21 hosted workspace provisions, user
disablement, and deletion preservation.
The second upgrades a populated pre-`0031` database, validates exact binding uniqueness and cascade
direction, and proves legacy workspace/work-item data survives. The third independently exercises
the pre-authentication unit of work through concurrent exactly-once consumption, protected PKCE
recovery, expiry, rollback, and cleanup. Those three database commands drop their disposable
databases and are included in `pnpm verify:database`. The final command independently verifies the
dormant ID-token adapter with generated signing keys and no network access; it is included in
`pnpm check`.
