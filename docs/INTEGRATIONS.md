# Inbound integration gateway

The integration gateway is the authenticated, provider-neutral boundary for trusted automation such
as a future Hermes agent. Schedule remains the source of truth: an adapter reads Schedule through
this API and submits structured commands through the same application rules used by the local
product. An adapter must never write Schedule's PostgreSQL tables directly.

This first gateway is deliberately inbound only. It accepts a small versioned command vocabulary;
it does not receive raw WhatsApp messages, interpret natural language, or push reminders. A Hermes
adapter can be added as a separate process once its callable interface is known.

## Safety model

- The gateway is disabled unless `INTEGRATION_API_MODE=enabled`.
- Every credential belongs to exactly one workspace. The server derives the workspace from the
  authenticated credential; no integration request accepts a caller-selected workspace ID.
- Credentials carry explicit `schedule:read` and/or `schedule:write` scopes. A credential cannot use an
  endpoint outside its stored scopes.
- Every mutation uses a two-step prepare/confirm flow. Preparing validates and durably records an
  exact structured command but does not execute it. The prepare response returns that stored command
  for review; confirming executes that exact command once.
- Confirmation records are bound to the credential, workspace, caller request ID, and command hash.
  They expire after `INTEGRATION_CONFIRMATION_TTL_SECONDS` (600 seconds by default), are row-locked
  during confirmation, and are consumed only once.
- Confirmed requests require an `Idempotency-Key`. A successful retry with the same credential, key,
  operation, and command replays the stored response while the credential remains valid. Reusing the
  key for a different request is a conflict. Concurrent confirmation cannot execute the command
  twice.
- Work-item and schedule-block updates retain their normal optimistic `expectedVersion` checks.
  Today activity retains the current-plan identity and `expectedHeadVersion` check. The gateway does
  not weaken domain or concurrency validation.
- Successful mutations, their integration principal, and their request identity are audited in the
  same transaction as the mutation and idempotency result. Secrets are not audit data.
- JSON objects are strict, request bodies retain the API size limit, and integration requests have
  separate bounded per-client-IP and per-credential rate limits.

An integration credential is a narrow machine capability, not an end-user login. Enabling this
gateway does not turn the unauthenticated local product API into a hosted multi-user API and does not
implement browser sessions, user provisioning, or synchronization.

### Runtime settings

| Variable                               | Default    | Contract                                                          |
| -------------------------------------- | ---------- | ----------------------------------------------------------------- |
| `INTEGRATION_API_MODE`                 | `disabled` | Set to `enabled` to register the integration routes               |
| `INTEGRATION_API_PEPPER`               | none       | Required when enabled; at least 32 characters                     |
| `INTEGRATION_CONFIRMATION_TTL_SECONDS` | `600`      | Confirmation lifetime from 60 through 3,600 seconds               |
| `INTEGRATION_RATE_LIMIT_PER_MINUTE`    | `120`      | Per-IP and presented credential-ID limit from 1 through 1,000     |
| `API_TRUSTED_PROXIES`                  | empty      | Comma-delimited explicit proxy addresses/CIDRs; empty trusts none |

The integration mode is independent of `PRODUCT_API_MODE`. A hosted process can keep the
unauthenticated product routes disabled while registering only authenticated integration routes.

## Credentials

`INTEGRATION_API_PEPPER` must be a cryptographically random value of at least 32 characters whenever
the gateway is enabled. Keep it outside source control and back it up with the deployment's secret
manager. The credential CLI requires that same pepper even while the gateway is disabled. Losing it
invalidates authentication for every existing integration credential.

Create a credential from a trusted shell that can reach the Schedule database:

```powershell
pnpm integration:credentials -- create --workspace 11111111-1111-4111-8111-111111111111 `
  --name "Hermes phone assistant" --scopes schedule:read,schedule:write
```

The command prints a bearer token in this form exactly once:

```text
22222222-2222-4222-8222-222222222222.<base64url-secret>
```

Schedule stores the public credential UUID and an HMAC-SHA-256 digest of the random 32-byte secret,
not the plaintext token. `list` and `revoke` never reveal either the secret or its digest:

```powershell
pnpm integration:credentials -- list --workspace 11111111-1111-4111-8111-111111111111
pnpm integration:credentials -- revoke --credential 22222222-2222-4222-8222-222222222222
```

Capture a new token immediately in the adapter's secret store. If it is lost or exposed, create a
replacement, deploy the replacement, then revoke the old credential. Do not paste a real token into
source code, issue trackers, logs, or chat transcripts.

## HTTP contract

All routes use the media-contract version string `schedule.integration/v1` and require:

```http
Authorization: Bearer <credential-uuid>.<base64url-secret>
```

Successful responses are non-cacheable and use one envelope:

```json
{
  "version": "schedule.integration/v1",
  "requestId": "33333333-3333-4333-8333-333333333333",
  "data": {}
}
```

The prepare response uses the caller's `requestId`, confirm uses the stable `confirmationId`, and
Today uses the server's HTTP request ID. The command-specific value is always inside `data`.

The only routes in version 1 are:

| Method | Route                               | Scope            | Behavior                                     |
| ------ | ----------------------------------- | ---------------- | -------------------------------------------- |
| `GET`  | `/v1/integrations/today?date=DATE`  | `schedule:read`  | Read the credential workspace's current plan |
| `POST` | `/v1/integrations/commands/prepare` | `schedule:write` | Validate and prepare one exact mutation      |
| `POST` | `/v1/integrations/commands/confirm` | `schedule:write` | Execute one prepared mutation idempotently   |

`DATE` is a real Gregorian local date in `YYYY-MM-DD` form. Today obtains the workspace exclusively
from the credential and never creates a missing plan. Its response `data` is
`{workspaceId,date,headVersion,plan}`; `plan` is the same public current-plan representation returned
by the local product API.

### Prepare envelope

```json
{
  "version": "schedule.integration/v1",
  "requestId": "33333333-3333-4333-8333-333333333333",
  "command": {
    "type": "work_item.create",
    "title": "Renew passport",
    "description": null,
    "priority": "high",
    "status": "backlog",
    "planningDurationMinutes": 45,
    "dueOn": "2026-08-01"
  }
}
```

`requestId` is a caller-generated UUID used to make preparation safe to retry. Repeating the same
request ID with the same validated command content returns the original confirmation; JSON object
key order is irrelevant. Reusing it with different content is a conflict. Persist the exact prepared
request until the exchange ends. If its confirmation expires, prepare again with a new request ID.
Preparing a command performs no product mutation.

The `201` response's `data` is:

```json
{
  "confirmationId": "44444444-4444-4444-8444-444444444444",
  "requestId": "33333333-3333-4333-8333-333333333333",
  "commandHash": "20f1fbbca4eff6961d4dc656230b5b792131046fe2583d4771676a19fae1f4cb",
  "command": {
    "type": "work_item.create",
    "title": "Renew passport",
    "description": null,
    "priority": "high",
    "status": "backlog",
    "planningDurationMinutes": 45,
    "dueOn": "2026-08-01"
  },
  "commandDisplay": "{\"description\":null,\"dueOn\":\"2026-08-01\",\"planningDurationMinutes\":45,\"priority\":\"high\",\"status\":\"backlog\",\"title\":\"Renew passport\",\"type\":\"work_item.create\"}",
  "summary": "Create work item “Renew passport” (status backlog, priority high, 45 planned minutes, due 2026-08-01).",
  "expiresAt": "2026-07-13T12:10:00.000Z"
}
```

`command` is the exact validated command stored behind this confirmation. `commandDisplay` is its
complete, sorted-key canonical JSON rendering with control and bidirectional-formatting characters
visibly escaped. The lowercase `commandHash` is the SHA-256 digest of the exact UTF-8
`commandDisplay` bytes.

Before asking for human confirmation, an adapter must:

1. parse `commandDisplay` and verify that it deep-equals `command`;
2. recompute its SHA-256 digest and verify `commandHash`;
3. compare the returned command with the mutation it intended to prepare; and
4. present every command field to the user, using `commandDisplay` directly or an equivalent
   all-field rendering with the canonical display available for inspection.

If any check fails, or a field is unrecognized or cannot be rendered safely, abort the exchange. The
command is the confirmation authority; never infer its meaning from the digest. Treat
`confirmationId` and `requestId` as opaque identifiers.

`summary` is a server-generated convenience preview of at most 500 characters, not the confirmation
authority. Its control and bidirectional-formatting characters are neutralized, and it discloses
common material fields such as descriptions and activity reasons, but it deliberately omits arbitrary
activity `metadata`. Render all returned strings as untrusted text with bidirectional isolation;
never inject them as HTML. Do not use metadata to hide user-relevant intent, and do not place secrets
in it.

### Confirm envelope

```json
{
  "version": "schedule.integration/v1",
  "confirmationId": "44444444-4444-4444-8444-444444444444"
}
```

Confirmation additionally requires an opaque 1–160 character header generated once for the logical
operation and retained across ambiguous retries:

```http
Idempotency-Key: hermes-message-123:confirm
```

Do not create a new key merely because the client timed out. A same-key retry replays the successful
response; changing the key after an ambiguous successful response loses that replay path and is
rejected because the confirmation has already been consumed. A confirmation can be used only by the
credential that prepared it and only before expiry.

The successful response's `data` includes `receiptVersion: 1` and identifies the confirmation,
normalized operation, command hash, and typed `outcome`. Work-item outcomes contain `workItem`,
schedule-block outcomes contain `scheduleBlock`, and plan-item activity outcomes contain
`planItemActivity`. A replay returns the same stored result rather than re-running the command.
Unversioned durable receipts created before deadline support are replayed unchanged, so those legacy
work-item results may omit both `receiptVersion` and `dueOn`; adapters must treat a missing legacy
`dueOn` as `null`. Newly written receipts always include both fields, and versioned receipts retain
strict exact-key validation.

### Commands

Commands are strict JSON objects discriminated by `type`:

| Type                    | Required fields                                                                                         | Optional fields                                                                  |
| ----------------------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `work_item.create`      | `title`                                                                                                 | `description`, `status`, `priority`, `planningDurationMinutes`, `dueOn`          |
| `work_item.update`      | `workItemId`, `expectedVersion`, and at least one change                                                | `title`, `description`, `status`, `priority`, `planningDurationMinutes`, `dueOn` |
| `schedule_block.create` | `startsAt`, `endsAt`, `timeZone`                                                                        | `workItemId`, `title`                                                            |
| `schedule_block.update` | `scheduleBlockId`, `expectedVersion`, and at least one change                                           | `workItemId`, `title`, `startsAt`, `endsAt`, `timeZone`                          |
| `plan_item.activity`    | `date`, `itemId`, `expectedPlanId`, `expectedHeadVersion`, `activityType`, `occurredAt`, and `timeZone` | `durationMinutes`, `reason`, `metadata`                                          |

The allowed work status, priority, timestamp, duration, metadata, and version values are the same as
their corresponding routes in [API.md](./API.md). `dueOn` is optional, but if non-null it must be a
strict real Gregorian `YYYY-MM-DD` local date. Omit it on update to preserve the date, or send JSON
`null` to clear it. The confirmation preview includes the resulting due-date change so a human can
approve it explicitly. `activityType` is one of `started`, `completed`,
`skipped`, `deferred`, `dismissed`, or `completion_reversed`. Nullable fields must be sent as JSON
`null` when clearing a value; a non-null `durationMinutes` is accepted only for `completed`. Omitting a
field means to leave it unchanged where updates allow that. Unknown fields and unknown command types
are rejected.

### Errors

Errors retain the API's standard envelope from [API.md](./API.md), not the successful integration
envelope. Authentication failures return a deliberately generic `401` with
`integration.authentication_failed`; the response does not reveal whether a credential exists, is
revoked, is expired, or has the wrong secret. Insufficient scope returns `403` with
`integration.scope_denied`; conflicting prepare request IDs or confirmation receipts return `409`;
expired or consumed confirmations return `410`; a missing or non-JSON mutation media type returns
`415`; and rate limiting returns `429` with a positive `Retry-After` value.

## Example exchange

The values below are placeholders. Never put a real credential into documentation or shell history.

Read the current plan:

```bash
curl --fail-with-body \
  -H 'Authorization: Bearer <credential-uuid>.<base64url-secret>' \
  'https://schedule.example.test/v1/integrations/today?date=2026-07-13'
```

Prepare an update:

```bash
curl --fail-with-body -X POST \
  -H 'Authorization: Bearer <credential-uuid>.<base64url-secret>' \
  -H 'Content-Type: application/json' \
  --data '{
    "version":"schedule.integration/v1",
    "requestId":"33333333-3333-4333-8333-333333333333",
    "command":{
      "type":"work_item.update",
      "workItemId":"55555555-5555-4555-8555-555555555555",
      "expectedVersion":3,
      "status":"in_progress"
    }
  }' \
  'https://schedule.example.test/v1/integrations/commands/prepare'
```

After the adapter verifies `commandDisplay`, `commandHash`, and `command`, presents the complete
action to the user, and receives an explicit confirmation, confirm it using the returned
`confirmationId`:

```bash
curl --fail-with-body -X POST \
  -H 'Authorization: Bearer <credential-uuid>.<base64url-secret>' \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: hermes-message-123:confirm' \
  --data '{
    "version":"schedule.integration/v1",
    "confirmationId":"44444444-4444-4444-8444-444444444444"
  }' \
  'https://schedule.example.test/v1/integrations/commands/confirm'
```

The adapter, not Schedule, is responsible for proving that the person confirming the command is the
right WhatsApp user. It should present the returned command's full material action, reject stale
conversational confirmations, and map one external message ID to one stable Schedule `requestId` and
idempotency key. The returned structured `command` is authoritative; the summary may assist the
presentation but must not replace reviewing the command. Use an opaque UUID or keyed hash for the
message mapping; do not embed a phone number, contact name, message text, or bearer token in either
identifier because both are persisted for audit and replay.

## Local and hosted deployment

For local-only integration, keep `API_HOST=127.0.0.1`, leave `API_TRUSTED_PROXIES` empty, and have a
local Hermes process call the loopback URL. Plain HTTP is acceptable only on loopback. Keep the
gateway disabled until a credential and a strong pepper are provisioned.

For a hosted adapter, terminate TLS at a trusted reverse proxy or platform load balancer and expose
the integration routes only through HTTPS. Store the pepper and bearer token in the platform's secret
manager, restrict database access to Schedule processes, apply network-level rate limits in addition
to the application limit, and preserve the client IP and request ID in redacted operational logs. Set
`API_TRUSTED_PROXIES` to a comma-delimited allowlist containing only the proxy's explicit IPv4/IPv6
addresses or CIDRs, for example `10.20.0.0/16,2001:db8:abcd::/48`. The empty default trusts no
forwarded address. Hostnames, duplicates, wildcard words, malformed prefixes, IPv4 CIDRs broader
than `/8`, and IPv6 CIDRs broader than `/32` are rejected. Split a verified provider range into
supported narrower subnets when necessary. Never add an unverified network merely to make
`X-Forwarded-For` appear to work; list only the immediate proxy source networks, not general client
networks or broad catch-all ranges. Provider networks change, so maintain this allowlist as deployment
configuration instead of hard-coding it once. TLS is mandatory whenever the bearer token crosses a
machine or network boundary.

Cloudflare, AWS, Railway, Oracle, or another provider can host this boundary; the protocol and core
packages do not depend on a specific platform. Before public exposure, add the provider-specific
secret rotation, monitoring, backup, and incident-response controls described in
[OPERATIONS.md](./OPERATIONS.md).

## Schedule-change refresh flow

The outbound webhook subsystem can opt one endpoint into the privacy-thin
`schedule.changed.v1` contract. This event is an invalidation hint, not a second source of schedule
state. It contains only a workspace ID, local date, resulting Today `headVersion`, event identity,
type, and timestamp. The exact body and subscription commands are specified in
[WEBHOOKS.md](./WEBHOOKS.md#automatic-schedule-change-events).

A Hermes-style adapter should authenticate and durably deduplicate the event, then call its
credential-scoped `GET /v1/integrations/today?date=<YYYY-MM-DD>` route for the supplied date. The
read response is authoritative: its `headVersion` may already be greater than the notification
because delivery is at least once and unordered. The adapter should update its projection from that
response, not infer a task change from the event or attach reminder semantics to it.

Polling remains mandatory as a fallback. An endpoint has no subscription by default; delivery may
also be globally disabled, delayed, dead-lettered, or interrupted during key rotation. Polling and
webhook refreshes should enter the same idempotent reconciliation path. Neither path authorizes a
phone notification: reminder policy, human/account binding, WhatsApp transport, and downstream
delivery receipts belong to the external adapter.

## Verification

Unit and contract coverage is part of the normal repository check:

```powershell
pnpm check
```

The live gateway verifier requires PostgreSQL access with permission to create and drop a disposable
database. It creates a nonce-named database, applies current migrations, exercises real Fastify
routes and all five commands, checks rollback, workspace isolation, and four-way concurrent
prepare/confirm exclusion, then removes the database:

```powershell
pnpm verify:integration-gateway
```

This verifier is also included in `pnpm verify:database` and its CI job.

## Retention and cleanup

Successful request receipts are the durable replay cache for `Idempotency-Key`. They are retained for
at least 90 days by the default maintenance policy. Once an old receipt is purged, Schedule can no
longer return its stored success response; the consumed or subsequently purged confirmation still
prevents the command from executing again. Adapters must resolve ambiguous responses promptly and
must not treat the integration receipt store as a permanent result archive.

Run bounded cleanup from a trusted maintenance shell with database access:

```powershell
pnpm integration:cleanup
pnpm integration:cleanup -- --retention-days 180 --batch-size 500 --max-batches 20
```

| Option             | Default | Allowed range |
| ------------------ | ------: | ------------: |
| `--retention-days` |      90 |      30–3,650 |
| `--batch-size`     |   1,000 |       1–1,000 |
| `--max-batches`    |     100 |       1–1,000 |

One run uses a constant cutoff and transactionally deletes bounded batches in this order:

1. succeeded request receipts whose completion is older than the retention cutoff;
2. confirmations whose expiry is older than the cutoff and which no remaining receipt references.

Processing receipts, credentials, and audit events are never deleted by this command. Its only
success output is an aggregate result object, for example:

```json
{
  "batches": 2,
  "deletedRequests": 1250,
  "deletedConfirmations": 1248,
  "totalDeleted": 2498,
  "limitReached": false
}
```

Schedule one instance as a recurring maintenance job. `limitReached: true` means the last allowed
batch still deleted rows, so a backlog may remain; run the command again. `limitReached: false` means
the run observed an empty batch. Choose a longer retention period before cleanup if an adapter needs
a longer replay window. Audit retention and backup retention are separate operational policies.

## Audit and operations

Treat credential creation, revocation, repeated authentication failure, preparation conflicts,
expired confirmations, and confirmed mutations as security-relevant events. The durable application
audit records credential provisioning/revocation plus prepared and confirmed commands with
structured identities and outcomes. Deployment monitoring must cover authentication failures,
conflicts, expiry, and throttling. Application and proxy logs should use request IDs and credential
IDs, never bearer tokens, secret digests, raw authorization headers, or unredacted WhatsApp content.

Database backups include credential digests, confirmations, idempotency receipts, and audit records.
Confirmation rows contain the structured Schedule command and its human-readable summary, so the
database and backups remain sensitive even though raw WhatsApp messages are never accepted. Backups
do not make the one-time plaintext token recoverable. Restoring an older backup can restore an older
credential/revocation state, so verify active credentials and rotate integration tokens after a
security-sensitive recovery.

## Current limitations

- There is no Hermes runtime or WhatsApp transport in this repository. No endpoint accepts a chat
  message, audio, image, or natural-language instruction.
- A disabled-by-default [outbound webhook substrate](./WEBHOOKS.md) can send operator-queued signed
  test events and explicitly subscribed `schedule.changed.v1` invalidations. It cannot send schedule
  contents, push-notification requests, reminders, or end-to-end phone delivery receipts. An adapter
  must still read and poll Today for authoritative schedule data.
- Version 1 does not create workspaces, routines, plans, or credentials over HTTP; delete commands
  are intentionally absent.
- The integration API is machine-to-machine authentication for one workspace, not hosted end-user
  authentication or multi-device synchronization.
- Confirmation proves possession of a Schedule credential. Human identity, conversational consent,
  WhatsApp account binding, and replay prevention at the messaging layer remain the adapter's
  responsibility.
