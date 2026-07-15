# Hermes reminder adapter foundation

Schedule includes a separate, provider-neutral adapter foundation for a future Hermes/WhatsApp
reminder process. It consumes the existing `schedule:delivery` claim/receipt API without adding
provider, destination, recipient, conversation, or account data to Schedule.

This is not yet a running WhatsApp transport. The concrete Hermes send API, human/account binding,
polling supervisor, and provider reconciliation contract still depend on the external Hermes
installation and must be supplied before the adapter can be started.

## Components

`@schedule/hermes-reminders` provides:

- `HttpScheduleDeliveryGateway`, a strict client for the existing claim and receipt endpoints. It
  permits plaintext HTTP only on literal IPv4 or IPv6 loopback addresses, rejects credentials in
  URLs and redirects, bounds streamed response size and total request time, validates exact
  versioned envelopes, and exposes only fixed error classes without response bodies or bearer
  tokens.
- `HermesReminderRunner`, which claims at most one command, checks that the Schedule lease has enough
  provider-call time, the gateway's declared maximum request duration, and an additional receipt
  margin; it reserves the stable `dedupeKey` before transport and persists a delivered dedupe record
  before acknowledging Schedule.
- `ReminderTransport`, the port a concrete Hermes integration must implement. Repeated delivery with
  the same dedupe key must be provider-idempotent or conclusively reconciled. An implementation that
  can only blind-resend ambiguous submissions is not compatible.
- `DeliveryDedupeStore`, the shared persistence port. Multiple adapter replicas must share one
  implementation. Reservations bind the stable command hash and fence updates with an opaque token;
  a mismatched payload fails permanently rather than reusing a dedupe identity for different text.
- `PostgresDeliveryDedupeStore`, a reference shared implementation with atomic reservation takeover,
  database-clock lease-budget checks, bounded database statements, digest-only reservation tokens,
  immutable delivered state, and fenced idempotent delivery/release transitions.

## PostgreSQL reference store

Run `migratePostgresDeliveryDedupeStore(sql)` once with a dedicated adapter migration role before starting
workers. Create a dedicated `NOINHERIT LOGIN` runtime role with no elevated attributes, role
memberships, or ownership of the database or adapter objects and provision it with
`grantPostgresDeliveryDedupeRuntimeRole(sql, roleName)`: this grants `USAGE` on the adapter schema,
`SELECT` on its migration ledger, and `EXECUTE` only on the reserve, mark-delivered, and release
operations. The role receives no read or DML privilege on the dedupe table and no access to the
transition trigger function. The three operations are fixed, `STRICT`, security-definer functions
owned by the migration role with a `pg_catalog`-only search path; each checks the opaque token inside
the database. Construct the runtime store with a client for that role, not the migration owner.
Migration v1 is serialized with a transaction advisory lock and records both a fixed checksum and
the migration owner's PostgreSQL OID in `hermes_adapter.schema_migrations`. Catalog attestation pins
the schema, every relation/index, and every function to that owner while also checking logged-table
durability, exact columns/defaults, constraint definitions, operation and transition function
sources, the enabled trigger, and public-access revocations. It normalizes catalog deparsing under a
`pg_catalog`-only local search path, so a runtime role's configured search path cannot create false
mismatches. Migration also revokes PUBLIC execution from future functions by default. Every runtime
operation repeats the catalog and execute-only role attestation, rejects role memberships in either
direction, and fails closed when the identity, permissions, ownership, or catalog shape does not
match.

The table persists only the stable Schedule dedupe UUID, the command digest, a SHA-256 digest of the
adapter reservation token, bounded state, and timestamps. The Schedule claim token is validated in
memory and never persisted. The table does not store message text, destination, provider payload,
account binding, plaintext bearer material, or receipt content. A reservation expiry is accepted
only when PostgreSQL's clock confirms that the complete configured transport-plus-receipt budget
still remains and that the lease is inside the maximum horizon (15 minutes by default, at most one
hour). Every runtime transaction also sets local lock and statement deadlines (two seconds by
default); a timed-out reservation reports `busy` without stealing the existing fence.

One atomic upsert wins an absent, explicitly released, or expired same-payload key and rotates the
reservation token on every reacquisition. Concurrent owners observe `busy`; a different command
digest observes `payload_conflict`; and delivered records are immutable under a database transition
trigger. Direct runtime-role table reads and writes are denied entirely.
`markDelivered` requires the current unexpired reservation token. `release` is idempotent for the
same token but cannot clear a later owner's reservation. Delivered rows must be retained for at least
as long as Schedule can replay the corresponding delivery identity. Schedule does not yet expose an
authoritative replay-retention watermark, so automatic deletion is intentionally disabled: the table
can grow until that contract and a bounded, audited cleanup job are implemented. Guessing a window
here could delete a tombstone and allow a duplicate external send.

## Outcome and crash semantics

A known accepted transport result is marked delivered in the dedupe store before the Schedule
receipt. If the receipt response is lost, a later Schedule claim carries the same `dedupeKey`; the
adapter returns the already-delivered result without another external send.

A known-not-accepted retryable or permanent provider result releases the reservation before its
bounded Schedule receipt. If transport throws, times out, or is otherwise ambiguous, the adapter
keeps the reservation and records no Schedule failure receipt. The current claim is allowed to
expire; a later reservation owner may proceed only through the transport's idempotent send or
reconciliation contract. Likewise, an active reservation owned by another adapter records no
failure receipt. These rules prevent adapter contention or ambiguity from burning Schedule's bounded
delivery attempts before the external state is known.

`delivered` means the adapter obtained a known accepted/idempotently reconciled provider result. It
does not mean a handset displayed the message. Provider delivery-status callbacks remain
adapter-side and cannot rewrite Schedule receipts.

## Security boundary

Use a separate delivery-only Schedule credential for each workspace adapter. Conversational
read/write automation needs a different credential and process. The adapter's public callback
ingress, if any, must hold no Schedule bearer credential.

Account binding belongs outside Schedule and must be established through a trusted local control or
authenticated hosted control plane with explicit consent. Never choose a Schedule workspace or
credential from a callback phone number, display name, message body, or unverified provider claim.
Keep Schedule credentials, provider secrets, callback verification material, binding data, and
encryption keys separate. Do not log authorization headers, message bodies, destinations, provider
payloads, or raw exceptions.

## Remaining integration work

Before enabling a real process, provide and verify:

1. the exact Hermes/WhatsApp send and reconciliation contract;
2. an explicit human/account binding lifecycle;
3. provider authentication, secret rotation, circuit breaking, and an operator kill switch;
4. a bounded polling supervisor with shutdown and health behavior;
5. an opt-in live smoke test using a non-production recipient.

Inbound messages, natural-language interpretation, command confirmation, provider callbacks, and
hosted binding UI are separate follow-on slices. Schedule's existing structured prepare/confirm
gateway remains authoritative for any future conversational mutation.

## Verification

The package's normal tests cover successful ordering, empty claims, delivered replay without a
second send, lease-budget refusal, reservation contention, payload conflict, known failure release,
ambiguous-send preservation, malformed transport results, exact HTTP request contracts, strict
streaming response limits and hard timeout, outbound receipt validation, URL safety, and fixed HTTP
failure classification. The HTTP tests use a real ephemeral loopback server and no provider
network. `pnpm verify:hermes-dedupe-store` additionally creates a nonce PostgreSQL database and proves
atomic multi-replica exclusion, payload binding before and after delivery, digest-only token storage,
idempotent delivery and release, expired-reservation takeover, stale-owner fencing, database-clock
budget and horizon rejection, bounded row-lock waits, checksum/catalog migration attestation,
search-path-stable deparsing, schema/relation/function owner drift, same-name definition,
function-source, trigger-enable, and logged-table tamper detection, bidirectional role-membership
rejection, default-private future functions, rejection of unexpected schema helpers and privilege
drift, successful operation through execute-only security-definer functions, denial of runtime table
reads/DML and DDL, restart durability, and exact cleanup of the nonce database and roles.
