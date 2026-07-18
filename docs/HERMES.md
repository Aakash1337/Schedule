# Hermes integrations

Schedule contains two distinct, opt-in Hermes paths:

- the local Python Schedule plugin uses `schedule:read` and `schedule:write` credentials for
  conversational reads, reviewed mutations, and a deterministic stdout Today helper; and
- the provider-neutral TypeScript delivery adapter uses a separate `schedule:delivery` credential
  to claim Schedule-owned reminder commands behind durable dedupe and fail-safe supervision.

They do not share credentials, persistence, process lifecycle, or delivery semantics. Neither path
by itself proves that WhatsApp or a phone received a message.

## Provider-neutral reminder-delivery adapter foundation

Schedule includes a separate, provider-neutral adapter foundation for a future Hermes/WhatsApp
reminder process. It consumes the existing `schedule:delivery` claim/receipt API without adding
provider, destination, recipient, conversation, or account data to Schedule.

This is not yet a running WhatsApp transport. The repository now provides a supervised,
provider-neutral polling boundary and a dormant `HermesWhatsAppTransport` bridge, but an actual
Hermes client, human/account binding, provider-specific conclusive reconciliation, and external
process bootstrap still depend on the operator's Hermes installation and must be supplied before
real delivery can be enabled.

### Components

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
- `HermesWhatsAppTransport`, an inert adapter-side implementation of that port. It asks an injected
  `HermesDeliveryClient` to reconcile the Schedule `dedupeKey` before every submission, sends only
  after a conclusive `not_found`, maps exact accepted/retryable/permanent results to fixed
  Schedule-owned codes, and turns any ambiguous, extended, malformed, or thrown client result into
  one fixed redacted error. Importing or constructing the class does not start polling or connect to
  Hermes.
- `DeliveryDedupeStore`, the shared persistence port. Multiple adapter replicas must share one
  implementation. Reservations bind the stable command hash and fence updates with an opaque token;
  a mismatched payload fails permanently rather than reusing a dedupe identity for different text.
- `PostgresDeliveryDedupeStore`, a reference shared implementation with atomic reservation takeover,
  database-clock lease-budget checks, bounded database statements, digest-only reservation tokens,
  immutable delivered state, and fenced idempotent delivery/release transitions.
- `HermesReminderSupervisor`, a single-flight sequential loop around `HermesReminderRunner`. Polling
  is disabled unless an operator-supplied control returns `true`; the control is evaluated before
  every claim. Retryable dependency failures use bounded full-jitter backoff and a fixed consecutive
  failure budget, while contract, authentication, schema, and control failures stop the supervisor
  with fixed redacted classifications.
- `runHermesReminderHealthServer`, a health-only HTTP listener restricted to literal IPv4 or IPv6
  loopback. Its live and ready responses are fixed, contain no reminder or dependency detail, and
  readiness is withheld until the supervisor completes a successful poll.
- `runHermesReminderRuntime`, which owns the supervisor and health listener in one abort domain. A
  process does not begin polling until health is listening. Shutdown prevents another claim, waits
  for the current runner cycle, and then closes health; it does not invent a receipt or force-release
  an ambiguous reservation.

### Dormant Hermes client bridge

`HermesDeliveryClient` is the narrow operator-side port still requiring a real implementation. Its
`reconcile(dedupeKey, signal)` result may be `accepted`, conclusively `not_found`, or `ambiguous`.
Only conclusive absence allows `send({ dedupeKey, message }, signal)`. A send may be known accepted,
known retryable failure, known permanent failure, or ambiguous. Accepted means the configured
Hermes/provider boundary accepted or conclusively reconciled the stable key; it does not claim a
phone displayed or read the message.

The bridge sends only the stable Schedule delivery identity under `dedupeKey` and a bounded display
message. The current gateway uses the delivery UUID as that dedupe identity. The bridge strips line,
C0/C1, and bidirectional display controls from the untrusted reminder title and never passes the
Schedule claim token, credential, separate intent field, lease, provider destination, or account
binding to the client. It never forwards a provider failure code or diagnostic into Schedule: known
failures become only `hermes.retryable_failure` or `hermes.permanent_failure`. A missing or
control-only title becomes `Schedule reminder`. The actual client owns its configured
operator-approved destination outside Schedule.

Every client result has an exact key set. Unknown fields, contradictory data, invalid retry bounds,
an explicit ambiguous result, an abort, or any thrown raw provider error becomes
`HermesDeliveryAmbiguousError` with a fixed message and no cause. The runner therefore preserves its
durable reservation and records no Schedule failure receipt. On a later claim, the bridge reconciles
the same dedupe key again before considering a send. A real client's `not_found` result must account
for provider consistency and be strong enough that a resend cannot duplicate an already accepted
message.

### Supervised runtime boundary

The supervisor is a library boundary for an external adapter process, not an auto-starting service.
Its default kill switch is off: omitting the `enabled` hook performs no Schedule claim. A real
bootstrap must supply an explicit operator-controlled hook, the concrete `ReminderTransport`, the
shared dedupe-store client, and a delivery-only Schedule gateway credential.

Only one `runOnce` call can be active per supervisor and a second `run` call is rejected. Polling and
retry sleeps accept an abort signal, but an abort does not cancel or detach an already-running
claim/send/receipt cycle. The runtime waits for that cycle so the runner's existing dedupe and
ambiguity rules remain authoritative. Busy reservations, ambiguous sends, and insufficient lease
budget are ordinary bounded cycle outcomes rather than dependency failures.

Health is deliberately narrow. Liveness remains available while the process is starting, disabled,
backing off, or stopping. Readiness becomes true only while enabled and running after at least one
successful poll, and returns false after disablement, fatal failure, or shutdown. The endpoint never
returns delivery IDs, workspace IDs, raw errors, credentials, destinations, or provider data.

### PostgreSQL reference store

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

### Outcome and crash semantics

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

### Security boundary

Use a separate delivery-only Schedule credential for each workspace adapter. Conversational
read/write automation needs a different credential and process. The adapter's public callback
ingress, if any, must hold no Schedule bearer credential.

Account binding belongs outside Schedule and must be established through a trusted local control or
authenticated hosted control plane with explicit consent. Never choose a Schedule workspace or
credential from a callback phone number, display name, message body, or unverified provider claim.
Keep Schedule credentials, provider secrets, callback verification material, binding data, and
encryption keys separate. Do not log authorization headers, message bodies, destinations, provider
payloads, or raw exceptions.

### Remaining integration work

Before enabling a real process, provide and verify:

1. an authenticated `HermesDeliveryClient` implementation whose send is idempotent by dedupe key and
   whose `not_found` reconciliation is conclusive across the provider's consistency window;
2. an explicit human/account binding lifecycle;
3. provider authentication, secret rotation, and circuit breaking;
4. an external process bootstrap and explicit operator control source for the fail-safe `enabled`
   hook;
5. an opt-in live smoke test using a non-production recipient.

Inbound messages, natural-language interpretation, command confirmation, provider callbacks, and
hosted binding UI are separate follow-on slices. Schedule's existing structured prepare/confirm
gateway remains authoritative for any future conversational mutation.

### Verification

The package's normal tests cover Hermes-client reconciliation before send, accepted replay without a
second submission, minimal sanitized message projection, exact result schemas, bounded known-failure
mapping, ambiguous and raw-error redaction, later reconciliation after an ambiguous submission, and
preservation of the runner reservation and Schedule attempt. They also cover successful ordering,
empty claims, delivered replay without a second send, lease-budget refusal, reservation contention,
payload conflict, known failure release, ambiguous-send preservation, malformed transport results,
exact HTTP request contracts, strict streaming response limits and hard timeout, outbound receipt
validation, URL safety, and fixed HTTP failure classification. They cover fail-safe default
disablement, per-claim control checks,
single-flight polling, non-overlap, bounded jitter and failure budgets, fatal error sanitization,
invalid injected-hook handling, graceful in-flight shutdown, runtime sibling supervision, and the
real loopback live/ready HTTP surface. The HTTP tests use a real ephemeral loopback server and no
provider network. `pnpm verify:hermes-dedupe-store` additionally creates a nonce PostgreSQL database and proves
atomic multi-replica exclusion, payload binding before and after delivery, digest-only token storage,
idempotent delivery and release, expired-reservation takeover, stale-owner fencing, database-clock
budget and horizon rejection, bounded row-lock waits, checksum/catalog migration attestation,
search-path-stable deparsing, schema/relation/function owner drift, same-name definition,
function-source, trigger-enable, and logged-table tamper detection, bidirectional role-membership
rejection, default-private future functions, rejection of unexpected schema helpers and privilege
drift, successful operation through execute-only security-definer functions, denial of runtime table
reads/DML and DDL, restart durability, and exact cleanup of the nonce database and roles.

## Local Hermes Schedule plugin

The Hermes Schedule plugin is the local, opt-in adapter between a Hermes conversation and
Schedule's authenticated integration gateway. It can read the authoritative Today plan, bounded
Daily Plan Fit guidance, and work items, prepare one of Schedule's strict structured
commands—including one-off reminder creation—and
confirm that exact command only after a separate human turn. A companion script produces a deterministic daily-plan reminder on
standard output without invoking an LLM.

This is not a public webhook receiver or a hosted integration. Version 1 accepts only a canonical
IPv4 loopback Schedule URL. Schedule remains the system of record, and neither the plugin nor the
reminder script writes its PostgreSQL tables directly.

### What is off by default

Nothing in this integration starts automatically:

- Schedule's integration routes remain absent until `INTEGRATION_API_MODE=enabled`.
- Hermes plugins are opt-in; copying the directory does not enable it.
- The reminder script runs once and writes to standard output. It does not create a timer, a cron
  job, or a WhatsApp delivery by itself.
- A Hermes cron job exists only after the operator creates one.
- WhatsApp delivery is not configured or verified merely because the plugin is installed. The
  Hermes operator must configure `WHATSAPP_HOME_CHANNEL` and run a live self-chat smoke test.

These defaults prevent a repository checkout, dependency install, or Schedule process restart from
silently enabling automation or sending schedule content to a messaging service.

### Prerequisites

Before installing the plugin:

1. Run Schedule's API on an IPv4 loopback address. The repository default is
   `http://127.0.0.1:4000`; use the port of the API process you actually started.
2. Enable the integration gateway and provision its pepper as described in
   [INTEGRATIONS.md](./INTEGRATIONS.md#runtime-settings).
3. Create a workspace-bound integration credential.
4. Install a Hermes version with native plugin hooks and ensure the same operating-system account
   can reach the Schedule loopback API.
5. For phone delivery, complete Hermes's WhatsApp setup and configure its operator-owned home
   channel. Do not use a group or another person's conversation for an initial test.

The full interactive plugin needs both Schedule scopes:

```powershell
pnpm integration:credentials -- create `
  --workspace 11111111-1111-4111-8111-111111111111 `
  --name "Hermes Schedule plugin" `
  --scopes schedule:read,schedule:write
```

The credential is printed once. Store it in the secret environment of the Hermes process; do not
put it in `config.yaml`, a checked-in `.env`, a cron prompt, a chat message, or a command transcript.
A standalone reminder process needs only `schedule:read`, so give it a separate read-only credential
when its environment can be isolated from the interactive plugin.

### Install and enable

The repository-owned source is [`integrations/hermes-schedule`](../integrations/hermes-schedule).
Its installer copies only the plugin runtime and deterministic reminder files into the active
Hermes home. `HERMES_HOME` wins when set; otherwise the native Windows default is
`%LOCALAPPDATA%\hermes` and other platforms use `~/.hermes`. It does not read or write secrets,
enable the plugin, restart Hermes, create a cron job, or send a message:

```powershell
python .\integrations\hermes-schedule\install.py check
python .\integrations\hermes-schedule\install.py install
```

`check` is read-only and exits nonzero when either bundle is missing or differs. For an upgrade,
stop Hermes and pass `install --replace`; the installer stages each complete bundle before replacing
the old directory. Bundles are replaced separately, so rerun `check` after an interrupted install
before enabling anything. Configure the process environment before enabling the copied plugin.

Set these variables in the environment of the Hermes process:

```powershell
$env:SCHEDULE_INTEGRATION_URL = "http://127.0.0.1:4000"
$env:SCHEDULE_INTEGRATION_TOKEN = "<credential-uuid>.<secret>"
$BindingBytes = [byte[]]::new(32)
[Security.Cryptography.RandomNumberGenerator]::Fill($BindingBytes)
$env:SCHEDULE_HERMES_BINDING_KEY = [Convert]::ToBase64String($BindingBytes).TrimEnd("=").Replace("+", "-").Replace("/", "_")

hermes plugins enable hermes-schedule
hermes plugins list --enabled
```

Then run the installed native registration verifier with Hermes's Python. It performs fresh
plugin discovery and checks the exact seven tools, their `schedule` toolset, and the observer-only
turn hook. The verifier itself does not invoke a tool, call Schedule, query a model, or send a
message. Native discovery does import and initialize every enabled plugin under Hermes's normal
trusted-plugin model, so run it only against an installation whose enabled plugins you trust:

```powershell
$HermesHome = python .\integrations\hermes-schedule\install.py home
& "$HermesHome\hermes-agent\venv\Scripts\python.exe" `
  "$HermesHome\plugins\hermes-schedule\verify_native.py"
```

On POSIX, use the matching virtual-environment path:

```bash
HermesHome="$(python3 ./integrations/hermes-schedule/install.py home)"
"$HermesHome/hermes-agent/venv/bin/python" \
  "$HermesHome/plugins/hermes-schedule/verify_native.py"
```

The verifier's success line is `plugin=enabled tools=7 toolset=schedule hook=pre_llm_call`; Hermes or
another enabled plugin may emit its own diagnostics. A disabled plugin, load error, origin or
registration drift, or the wrong Python environment fails closed. This deliberately pins native
Hermes registration bookkeeping and verifies neither credential validity, gateway lifecycle, a
Schedule request, nor phone delivery.

`SCHEDULE_INTEGRATION_URL` has no implicit value and is required. Its accepted form is exactly
`http://127.0.0.1:<port>`, with a canonical decimal port from 1024 through 65535: no `localhost`,
IPv6 spelling, non-loopback address, HTTPS host, user information, path, trailing slash, query, or
fragment. This deliberate restriction means the v1 plugin cannot connect to a hosted Schedule
deployment. It also never follows a redirect.

`SCHEDULE_INTEGRATION_TOKEN` is required. It is a Schedule machine capability, not a Hermes user
login or browser session. `SCHEDULE_HERMES_BINDING_KEY` is a separate local secret used to bind a
pending confirmation to Hermes's sender, session, and platform identity. It must contain 32 through
4,096 UTF-8 bytes with no whitespace. Generate it independently from the integration token and the
Schedule API pepper. Restrict both secrets and the Hermes home directory to the operating-system
account running Hermes. Persist them through the service's secret environment rather than relying
on one interactive PowerShell session. Enabling updates Hermes's plugin allow-list; restart every
long-running Hermes gateway or agent process so it loads the new code and environment.

Pending exchanges are stored under `$HERMES_HOME/state/schedule-adapter.sqlite3` (or the equivalent
default Hermes home). It contains keyed identity hashes, turn counters, opaque Schedule identifiers,
the operation type, one-use challenge, expiry, idempotency identity, and an optional in-flight claim—not
raw sender IDs, raw messages, the bearer token, or the prepared command. Back up or delete this state
only while Hermes is stopped. Deleting it cancels the adapter's local recovery path but does not
revoke the Schedule credential or undo an operation that may already have committed.
On first start after this command was added, the plugin transactionally widens the operation field in
that dedicated state database while preserving pending and in-flight confirmations. An unfamiliar
pending-confirmation table schema fails closed instead of being rewritten.

### Conversation contract

The plugin registers seven tools:

| Tool                              | Purpose                                                                | Required Schedule scope                 |
| --------------------------------- | ---------------------------------------------------------------------- | --------------------------------------- |
| `schedule_today`                  | Read one existing authoritative Today plan                             | `schedule:read`                         |
| `schedule_daily_plan_fit`         | Read bounded deterministic target guidance for one local date          | `schedule:read`                         |
| `schedule_list_work_items`        | Read a bounded, filtered work-item page                                | `schedule:read`                         |
| `schedule_list_one_off_reminders` | Read one bounded time range of one-off reminders                       | `schedule:read`                         |
| `schedule_prepare_change`         | Validate and persist one exact structured command without executing it | `schedule:write`                        |
| `schedule_confirm_change`         | Execute the one pending prepared command after human confirmation      | `schedule:write`                        |
| `schedule_cancel_change`          | Remove the local pending exchange without executing it                 | none beyond the existing local exchange |

Hermes may interpret a natural-language request, but Schedule does not receive or interpret the raw
WhatsApp message. The model must select a command from the versioned vocabulary in
[INTEGRATIONS.md](./INTEGRATIONS.md#commands). Schedule validates that command using the same domain
and optimistic-concurrency rules as every other integration client.

`schedule_daily_plan_fit` accepts exactly `forDate`. It returns only status, disposition, sample
counts, and nullable joint minute/task targets; it rejects any extra response field, including an
evidence key. Hermes should present targets only when status is `suggested` and disposition is
`available`. The tool performs no confirmation or write, cannot apply or dismiss the suggestion, and
receives no Plan Fit history, outcome rates, raw evidence, workspace identity, or timestamps.

For “remind me” requests, Hermes may propose the strict `one_off_reminder.create` command with a title
and explicit-offset `scheduledFor` instant. The workspace reminder profile must already exist.
Hermes can discover existing reminders with `schedule_list_one_off_reminders` over an increasing,
explicit-offset `[from,to)` range of at most 31 days. The result contains at most 100 reminders in
`scheduledFor,id` order, including cancelled reminders, so the model should ask for clarification
rather than guess when a result is ambiguous.

After discovery, `one_off_reminder.update` changes the title, scheduled instant, or both;
`one_off_reminder.cancel` marks the source cancelled. Both require the returned ID and current
positive `expectedVersion`. A reschedule is an update, not a distinct command. Each write still
requires a separate confirmation turn and executes exactly once; an actual update or first
cancellation invalidates that source's pending materialized intents. None sends a message immediately
or bypasses normal materialization and delivery policy. `schedule_cancel_change` only abandons a
locally pending confirmation; it does not cancel an already-created Schedule reminder.

Preparation must occur inside a captured Hermes turn. On success, the plugin verifies Schedule's
canonical command display and SHA-256 command hash, stores the pending exchange, and returns the
complete command plus a one-use challenge. The mutation has **not** happened at this point.

The user must send this exact text in a later user turn:

```text
CONFIRM SCHEDULE <challenge>
```

Do not add punctuation, commentary, Markdown, or another instruction. `schedule_confirm_change`
accepts the phrase only from the same HMAC-bound Hermes sender, session, and platform identity that
prepared it. A copied phrase from another WhatsApp sender, another platform, or another session is
not authority. The server-side Schedule confirmation must also still be unexpired and belong to the
same integration credential.

The plugin atomically marks a confirmation in flight before contacting Schedule. Cancellation is
rejected while that claim exists, so it cannot race an irreversible request. A normal transport
failure releases the claim. If the process dies mid-request, the same exact confirmation phrase can
retry after 60 seconds with the same idempotency key; Schedule then replays the exact receipt instead
of executing the mutation again. A stale in-flight claim can be retried but never canceled. The local
pending exchange is consumed only after a strict successful response.

The adapter validates the returned operation and command hash, accepts only the expected typed
outcome schema, and returns a reduced receipt containing bounded identifiers, time/status/version fields,
and no reminder title, work description, activity reason, or metadata. If the user changes their mind before a
confirmation is in flight, Hermes should invoke `schedule_cancel_change`; a changed command requires
a new preparation and challenge.

The challenge flow limits accidental or model-initiated writes, but it does not make an untrusted
Hermes account safe. Sender and session authenticity are only as strong as the configured Hermes
platform connector and access to its local state.

### Deterministic reminders

[`reminder.py`](../integrations/hermes-schedule/reminder.py) performs one authenticated Today read,
formats a bounded deterministic summary, writes it to standard output, and exits. It does not call
Hermes's model, invoke the planner, change activity, create a plan, or mark anything complete.

Test it locally before creating a scheduled delivery:

```powershell
$env:SCHEDULE_INTEGRATION_URL = "http://127.0.0.1:4000"
$env:SCHEDULE_INTEGRATION_TOKEN = "<read-only-or-read-write-token>"
python .\integrations\hermes-schedule\reminder.py --date 2026-07-14
```

Use an explicit Schedule-local `YYYY-MM-DD` date for a repeatable manual check. Without `--date`, the
script uses `SCHEDULE_REMINDER_DATE` when present, then the host's current local date. Do not leave a
fixed `SCHEDULE_REMINDER_DATE` in a recurring production job unless repeating that old date is
intentional.

The message contains at most 20 pending or started items and at most 3,500 characters. A missing plan
or a plan with no unfinished items produces an explicit informational message. A configuration,
authentication, transport, or response-validation failure writes only a bounded error code to
standard error and exits nonzero. Standard output is the delivery boundary: inspect it for the
intended workspace and content before allowing any delivery command to consume it.

This stdout/cron helper does not use the separate `schedule:delivery` claim/receipt API, durable
dedupe store, or supervised TypeScript polling runtime described above. Hermes owns any downstream
local or WhatsApp delivery, so this path does not create Schedule delivery history or provider
receipts.

The installer also places the matching reminder and client files under
`$HERMES_HOME/scripts/schedule-reminder`. Create a local-delivery job first so no phone message can
be sent during initial validation:

```powershell
hermes cron create "0 9 * * *" `
  --name "Schedule morning reminder" `
  --script schedule-reminder/reminder.py `
  --no-agent `
  --deliver local

hermes cron list
```

The cron scheduler process must receive the same Schedule URL and token environment. `--no-agent`
is a security and determinism requirement here: it delivers the script's standard output verbatim
rather than asking a model to rewrite it. Use `hermes cron run <job-id>` and inspect the local result
before changing the target. `install.py check` detects a mixed or stale reminder bundle.

Only after local output is correct and Hermes's own WhatsApp transport is healthy should the
operator configure its home channel and create or edit a delivery with:

```powershell
$env:WHATSAPP_HOME_CHANNEL = "<operator-owned-self-chat-channel>"

hermes cron create "0 9 * * *" `
  --name "Schedule WhatsApp morning reminder" `
  --script schedule-reminder/reminder.py `
  --no-agent `
  --deliver whatsapp
```

`WHATSAPP_HOME_CHANNEL` is a Hermes transport prerequisite, not a Schedule setting. Until it is
configured in the environment of the cron/gateway process and an operator-run self-chat succeeds,
live WhatsApp delivery is **not complete**. The repository's automated checks cannot establish that
a phone, WhatsApp account, bridge session, or provider channel accepted a message.

### Privacy and threat model

- The plugin connects outbound to one exact loopback origin. It opens no public listener and does
  not consume Schedule's outbound webhooks.
- The bearer token is sent only in the loopback `Authorization` header. The plugin and verification
  suite must never print it, the binding key, or credential digests.
- The token selects exactly one Schedule workspace. Use least-privilege scopes, replace an exposed
  token, and revoke the old credential with `pnpm integration:credentials -- revoke`.
- WhatsApp and its configured provider can see any reminder text delivered through that channel.
  The helper applies its fixed 20-item/3,500-character bound; choose a private self-chat and avoid
  task titles that should not leave the machine.
- Work-item titles and every Schedule-returned string are untrusted data. The adapter verifies and
  displays the complete canonical command; it never treats a title, description, or metadata value
  as a hidden instruction or substitutes a model summary for confirmation authority.
- The explicit later-turn challenge reduces silent writes by a compromised model. Schedule's own
  strict schemas, credential scopes, confirmation expiry, optimistic versions, row locking, audit,
  and idempotency remain the final enforcement boundary.
- HMAC sender binding is not identity proof independent of Hermes. A compromised platform adapter,
  Hermes account, operating-system account, plugin directory, environment, or state database can
  defeat the local boundary. Keep the machine patched and the Hermes home private.
- The Hermes connector must supply stable, nonempty `sender_id` and `platform` hook values. The
  plugin refuses to capture confirmation state when either is missing, so the mutation tools fail
  closed instead of falling back to session-only authority.
- Local malware and a malicious process running as the Hermes user are outside this adapter's trust
  boundary. They can potentially read environment secrets or call the loopback API directly.

### Verification and safe rollout

Run the repository verifier from the Schedule checkout:

```powershell
pnpm verify:hermes-adapter
```

It runs deterministic Python tests plus a disposable PostgreSQL and real Fastify integration flow.
Through the production Python client, the gate first reads a strict non-mutating Plan Fit
projection without writing or entering confirmation state, then creates, discovers, reschedules, and
cancels one reminder. It verifies no mutation before confirmation, exact receipt replay, versions
`1` through `3`, one persistent source row, and pending-intent invalidation after update and
cancellation. It does not contact WhatsApp and does not prove phone delivery.

Use this rollout order:

1. Verify the plugin with the disposable automated gate.
2. Install it disabled, set secrets in the Hermes service environment, then enable it explicitly.
3. Run `verify_native.py` with Hermes's Python, then restart every long-running Hermes process.
4. Exercise `schedule_today`, `schedule_daily_plan_fit`, `schedule_list_work_items`, and
   `schedule_list_one_off_reminders` against the intended workspace.
5. Prepare a harmless test change, inspect every canonical field, and cancel it.
6. Prepare another bounded test, confirm from the same sender/session/platform on a later turn, and
   verify the result through Schedule.
7. Run `reminder.py` directly and inspect standard output.
8. Create a `--deliver local` no-agent cron job and trigger it once.
9. Configure `WHATSAPP_HOME_CHANNEL` to the operator's own self-chat, then perform one live delivery
   smoke. Record only opaque message or delivery identifiers, never the token or message contents.

### Limitations

- Version 1 is local-only. The strict loopback URL deliberately excludes hosted Schedule instances.
- The plugin exposes only the integration gateway's current read surfaces and structured command
  vocabulary. It does not add recurrence authoring, dependency editing, plan generation, deletes,
  arbitrary SQL, or a general Schedule natural-language API.
- Plan Fit access is guidance-only: no evidence key, feedback commands, use receipts, outcome history,
  effectiveness rates, prefill, or generation crosses the Hermes tool boundary.
- Natural-language interpretation occurs in Hermes and can be wrong. Nothing is written until the
  exact server-validated command is presented and separately confirmed.
- The stdout Today helper is a deterministic snapshot, not a durable Schedule reminder engine. It
  has no snooze, escalation, provider delivery receipt, phone read receipt, or Schedule-side delivery
  history. Schedule-managed one-offs use the separate reminder-policy and delivery-intent core.
- The adapter polls Schedule when invoked. Privacy-thin `schedule.changed.v1` webhooks remain a
  separate refresh mechanism and do not trigger this local plugin.
- One token is bound to one workspace. Multiple workspaces require distinct credentials and isolated
  plugin/runtime configuration.
- Credential rotation requires updating the Hermes process environment and restarting processes
  that captured the old value.
- An expired or abandoned pending confirmation remains local state until it is canceled. Ask Hermes
  to cancel the pending Schedule change before preparing a replacement.
- Automated verification establishes local/stdout behavior only. WhatsApp remains operator-verified
  and must not be described as complete while `WHATSAPP_HOME_CHANNEL` is absent.
