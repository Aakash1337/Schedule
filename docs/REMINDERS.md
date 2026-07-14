# Deterministic reminder policy core

Schedule owns reminder decisions. The current implementation stores workspace policy, reusable
rules, explicit one-off reminders, insert-only notification intents, and a provider-neutral delivery
gateway. Schedule still does **not** connect to WhatsApp, email, push, or a phone account. Instead, a
separately authenticated adapter claims Schedule-owned commands and reports bounded outcomes without
being allowed to reinterpret policy or mutate scheduled work.

The core is available through the local product API. Materialization is currently an explicit
command; no periodic production worker invokes it yet. This boundary is intentional for the first
slice: policy evaluation is explicit, while the delivery boundary can be verified independently of
any particular messaging provider.

## Stored resources

Each workspace may have one versioned notification profile:

- `enabled` is the global policy pause.
- `timeZone` is a required IANA zone for all local-date and local-minute rules.
- quiet hours are a nullable paired start/end minute in the range 0–1439. The interval is half-open
  `[start,end)`, may cross midnight, and is disabled when start equals end.
- `quietHoursPolicy` is `skip` or `next_allowed`.
- `catchUpWindowMinutes` bounds recovery after downtime from 0 through 10,080 minutes.
- `dailyIntentLimit` bounds accepted intents per resulting local date from 1 through 100.

Rules are reusable, independently enabled, versioned policy records. A rule has a user-controlled
priority from 0 through 100 and a cooldown from 0 through 10,080 minutes. Its kind determines its
only valid trigger configuration. Each workspace may store at most 100 rules; overflow fails closed:

| Rule kind             | Trigger configuration | Occurrence source                                                      |
| --------------------- | --------------------- | ---------------------------------------------------------------------- |
| `daily_digest`        | local minute          | One workspace occurrence per local date                                |
| `daily_follow_up`     | local minute          | One occurrence when the current plan still has pending or started work |
| `plan_window_open`    | lead minutes          | Each accepted availability-window start in the current plan snapshot   |
| `schedule_block_lead` | lead minutes          | Each bounded schedule block                                            |
| `work_item_due`       | local minute          | Each nonterminal work item with a due local date                       |

`plan_window_open` is about the submitted availability window, not an inferred task start. Plan
items currently store a window index and duration, not an exact allocated start instant, so the core
does not claim “ten minutes before this task.”

A one-off reminder stores a bounded title and an absolute instant. It may be versioned until it is
cancelled; cancellation is idempotent, and a cancelled one-off cannot be edited or materialized.

An intent is an insert-only result of one accepted occurrence. It snapshots only the policy and
target metadata needed to explain and later deliver that decision: source IDs, kind, stable
occurrence key, target type/ID, bounded title snapshot, scheduled instant/local date, priority,
profile/rule/target versions, local-time resolution, quiet-hours adjustment, and catch-up status.
No provider, channel, recipient, conversation, raw provider response, credential, or delivery result
belongs in this table. Those values are also absent from provider-neutral delivery commands. Rule
provenance is constrained by workspace, rule ID, and rule kind. Target-bearing
intents use separate tenant-scoped foreign keys for daily plans, schedule blocks, and work items;
deleting one of those targets cascades its still-pending intent instead of leaving a deliverable
dangling reference.

Accepted intents are never edited in place. A profile update deletes all of the workspace's pending
intents; a rule or one-off update/cancellation deletes only intents from that source. Schedule-block
and work-item edits, plan replacement, and terminal plan-item activity delete the affected target
intents in the same transaction as the source change. Terminal activity removes only
`daily_follow_up` for the plan, and a completed work-backed item also removes its `work_item_due`
intent, so unrelated plan-window reminders survive. The normal API and confirmed integration
gateway acquire the same workspace notification lock before these mutations. A later materializer
recreates only occurrences that remain valid under current state. Idempotent activity replays are
identified by the persistence boundary and never repeat invalidation side effects.

## Time and selection semantics

Local minutes use Temporal-compatible disambiguation:

- an ordinary local time maps exactly;
- a nonexistent spring-forward time moves later through the gap;
- a repeated fall-back time chooses the earlier instant.

The chosen outcome is persisted on the intent. Quiet hours are applied after the original trigger is
resolved. `skip` suppresses an occurrence in the interval. `next_allowed` moves it to the interval's
end on the same or next local date and resolves that local time with the same DST rules.

If the adjusted candidate is already past, it is accepted at the materialization clock only when its
lateness is within the inclusive catch-up window. Quiet hours are then applied again at that clock;
catch-up cannot bypass a rest period. Older candidates are suppressed as `outside_catch_up`.

Accepted candidates inside the requested half-open materialization window are ordered by:

1. resulting local date;
2. source class: one-off, schedule-block lead, work-item due, plan-window open, daily follow-up,
   daily digest;
3. configured priority, descending;
4. scheduled instant;
5. stable occurrence key.

Existing intents count toward the daily limit. Rule cooldown loads the complete configured
cooldown horizon (up to seven days) and compares the scheduled time with
existing and newly selected intents for that same rule; one-off reminders have no cooldown. The
materialization response reports every suppressed occurrence and its stable reason so callers do not
have to infer why an intent was absent.

## Idempotency and concurrency

Occurrence keys deliberately omit policy version. Examples include one rule/date, one rule/block,
one rule/work-item due date, one rule/plan window, and one one-off ID. PostgreSQL uniquely constrains
`(workspace_id, occurrence_key)`.

Materialization takes a workspace-scoped PostgreSQL advisory transaction lock before reading policy,
sources, or existing intents. It then runs under read committed, so a waiter observes the previous
holder's committed intents. Two concurrent materializers therefore produce one natural-key winner;
the other receives the existing records. The repository still uses `ON CONFLICT DO NOTHING` and
reloads the winner as a final idempotency boundary.

The core never enqueues a generic outbox event. Delivery uses a dedicated lifecycle because a
credential-scoped pull adapter must not be able to lease unrelated outbox topics.

## Delivery lifecycle

A `schedule:delivery` credential may claim at most one due command at a time. Delivery permission is
never included in the credential CLI's default read/write scopes; it must be explicitly granted. A
claim runs under the same workspace notification lock as materialization and source invalidation,
then re-fetches and row-locks the credential after the workspace lock. Credential revocation takes
the same row lock, so a revocation that wins that lock is observed before any claim or receipt write.
PostgreSQL's clock is authoritative for due checks, leases, retry availability, and receipts.

The command is created lazily from a still-present due intent. Its `deliveryId`, `intentId`, and
`dedupeKey` are the same stable UUID. It contains only the reminder kind, target class, bounded title,
scheduled instant/local date, priority, attempt number, claim token, and lease expiry. It never
contains an account, destination, provider, channel, conversation, credential, or provider payload.

The default lease is five minutes and the default maximum is five attempts. Each claim appends an
immutable attempt with a new UUID fencing token. The adapter must durably deduplicate the external
side effect by `dedupeKey` before reporting a receipt. If it sends successfully and stops before the
receipt commits, a later claim exposes the same delivery/dedupe ID with a new token; the adapter must
recognize its earlier side effect and acknowledge it without sending again. Multiple adapter
instances for one workspace therefore require a shared deduplication store.
Expired processing and invalidated leases are swept through a partial workspace/expiry index, so
bounded recovery does not degrade into a full delivery-command scan.

| Current state    | Accepted action                                     | Result                        |
| ---------------- | --------------------------------------------------- | ----------------------------- |
| due intent       | claim                                               | `processing`                  |
| `processing`     | `delivered` receipt before lease expiry             | `delivered`                   |
| `processing`     | retryable failure before the attempt limit          | delayed `pending`             |
| `processing`     | permanent failure or retryable failure at the limit | `dead_letter`                 |
| `processing`     | lease expires                                       | same command may be reclaimed |
| any open command | source/policy invalidation                          | `invalidated`                 |

Receipts accept only `delivered`, `retryable_failure`, or `permanent_failure`. Failures carry a
lowercase machine code of at most 80 characters; retry hints are integers from 0 through 60 seconds.
Free-form exception text and provider receipts are rejected. A receipt must present the current
claim token and arrive before its lease expires. Exact request replay is durable for both command and
empty claims as well as successful receipts; reusing a key for a different operation or payload is a
conflict.

Source changes before claim prevent command creation. Source changes after claim mark the command
invalidated and prevent it from being reclaimed, but Schedule cannot retract a side effect already
in flight outside its transaction. A receipt arriving before that claim's lease ends records the
attempt outcome while the command remains `invalidated`; an abandoned invalidated attempt is closed
as `lease_expired` after the lease. This claim-commit boundary is the documented unavoidable race.
The adapter should minimize work between claim and its deduplicated side effect.

## Local API

The profile, rule, and one-off mutation routes use optimistic versions. See [API.md](./API.md) for
the complete route table and payloads. The main flow is:

1. `PUT /v1/workspaces/{workspaceId}/notification-profile` with `expectedVersion: null`.
2. Create one or more rules with `POST .../notification-rules` and/or explicit reminders with
   `POST .../one-off-reminders`.
3. Explicitly materialize a bounded window with
   `POST .../notification-intents/materializations`.
4. Inspect immutable results with `GET .../notification-intents?from=...&to=...`.
5. Inspect the product-safe execution state with
   `GET .../notification-deliveries?from=...&to=...`.
6. From an explicitly delivery-scoped integration credential, claim with
   `POST /v1/integrations/reminder-deliveries/claim` and a unique `Idempotency-Key`.
7. Report the fenced outcome with `POST /v1/integrations/reminder-deliveries/receipt` and a new
   `Idempotency-Key`.

The materialization window must be increasing and no longer than 31 days. One-off list requests are
also limited to 31 days and fail closed above 500 returned rows. Materialization source queries fetch
at most one row beyond their 5,000-row ceiling so an exact-boundary result remains valid while an
overflow is detected before unbounded transfer. Malformed persisted plan snapshots fail closed
instead of silently omitting window reminders. One plan snapshot may contribute at most 64 windows,
and one invocation may produce at most 10,000 aggregate candidates; both limits fail closed. The
31-day request plus the maximum seven-day catch-up horizon is fully included in the bounded
local-date scan.

## Web interface

The local **Reminders** view exposes three explicit surfaces:

- **Policy** creates or version-updates the workspace profile, manages independently enabled rules,
  and creates, edits, or cancels one-off reminders. A missing profile is a setup state; the browser
  never silently saves a guessed default. The device time zone is only a prefilled suggestion until
  the user saves it. Rule kind is immutable after creation, and cancelled one-offs cannot be revived.
- **Planned** lists immutable intents and provides the only materialization action. Refreshing this
  view does not materialize automatically. The action reports created, existing, and suppressed
  results before reloading the list.
- **Execution** lists the product-safe delivery projection. Status copy distinguishes an
  acknowledged Schedule result from a currently claimed command and explicitly says that a claim is
  not proof of an external send. Claim tokens, leases, credentials, provider/channel/destination
  fields, and provider payloads never cross this product route.

The browser reads recent and upcoming activity through bounded 31-day, 50-row pages and offers an
explicit **Show 50 more** action. A version conflict reloads authoritative policy before asking the
user to retry. The view states that periodic materialization, adapter polling, and
WhatsApp/email/push/phone transport are not connected, so the interface cannot be mistaken for a
production notification provider.

## Verification and operational boundary

With PostgreSQL running:

```powershell
pnpm verify:notification-core
pnpm verify:notification-delivery
pnpm verify:notification-migrations
pnpm verify:backup-restore
```

The policy verifier uses the real API and PostgreSQL repositories, creates all six source kinds, runs
two materializers concurrently, proves exact-once occurrence persistence, rejects cross-workspace
source and target references, rejects rule-kind mismatches and duplicate keys, proves policy and
target edits invalidate pending intents, proves terminal activity performs selective cleanup, proves
target deletion cascades, and confirms the outbox count does not change. The migration verifier
upgrades populated pre-0024, pre-0025, pre-0026, and pre-0027 databases in isolation, checks the
due-work, delivery-recovery, and workspace/schedule/id history indexes plus tenant constraints, and
proves legacy command, credential, and message data remains intact. The delivery verifier uses a
nonce database and the real HTTP gateway to prove the product-safe history projection as well as concurrent claim replay,
post-lock lease freshness, revocation linearization, cross-tenant rejection, retry, dead-lettering,
expiry fencing/recovery, source invalidation, empty claim replay, bounded receipts, audit records,
and occurrence uniqueness.
Backup/restore verification includes all seven reminder and delivery tables.

Not yet implemented in this slice:

- automatic periodic materialization;
- a Hermes/WhatsApp, email, push, or other provider transport and human/account binding;
- automatic worker polling of the delivery gateway;
- dead-letter redrive controls;
- hosted-user authorization for these local product routes.
