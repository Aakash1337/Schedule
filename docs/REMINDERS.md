# Deterministic reminder policy core

Schedule owns reminder decisions. The current implementation stores workspace policy, reusable
rules, explicit one-off reminders, and insert-only notification intents. It does **not** send a phone,
WhatsApp, email, webhook, or push notification. Delivery, acknowledgements, and provider receipts
remain a separate later layer so an adapter cannot reinterpret scheduling policy or silently mutate
work.

The core is available through the local product API. Materialization is currently an explicit
command; no periodic production worker invokes it yet. This boundary is intentional for the first
slice: policy and concurrency behavior can be verified before any external side effect exists.

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
No provider, channel, recipient, conversation, raw message, credential, or delivery result belongs
in this table. Rule provenance is constrained by workspace, rule ID, and rule kind. Target-bearing
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

The core never enqueues an outbox event. A future delivery layer must revalidate current source state
before delivery, write separate resolution/receipt records, and deduplicate every external side
effect by intent ID.

## Local API

The profile, rule, and one-off mutation routes use optimistic versions. See [API.md](./API.md) for
the complete route table and payloads. The main flow is:

1. `PUT /v1/workspaces/{workspaceId}/notification-profile` with `expectedVersion: null`.
2. Create one or more rules with `POST .../notification-rules` and/or explicit reminders with
   `POST .../one-off-reminders`.
3. Explicitly materialize a bounded window with
   `POST .../notification-intents/materializations`.
4. Inspect immutable results with `GET .../notification-intents?from=...&to=...`.

The materialization window must be increasing and no longer than 31 days. One-off list requests are
also limited to 31 days and fail closed above 500 returned rows. Materialization source queries fetch
at most one row beyond their 5,000-row ceiling so an exact-boundary result remains valid while an
overflow is detected before unbounded transfer. Malformed persisted plan snapshots fail closed
instead of silently omitting window reminders. One plan snapshot may contribute at most 64 windows,
and one invocation may produce at most 10,000 aggregate candidates; both limits fail closed. The
31-day request plus the maximum seven-day catch-up horizon is fully included in the bounded
local-date scan.

## Verification and operational boundary

With PostgreSQL running:

```powershell
pnpm verify:notification-core
pnpm verify:notification-migrations
pnpm verify:backup-restore
```

The core verifier uses the real API and PostgreSQL repositories, creates all six source kinds, runs
two materializers concurrently, proves exact-once occurrence persistence, rejects cross-workspace
source and target references, rejects rule-kind mismatches and duplicate keys, proves policy and
target edits invalidate pending intents, proves terminal activity performs selective cleanup, proves
target deletion cascades, and confirms the outbox count does not change. The migration verifier
upgrades a populated pre-0024 database in isolation, checks the due-work scan index and new tenant
constraints, and proves legacy data remains intact.
Backup/restore verification includes all four reminder tables.

Not yet implemented in this slice:

- automatic periodic materialization;
- intent claim/revalidation/resolution state;
- external delivery, retries, acknowledgement, or receipts;
- Hermes/WhatsApp, email, push, or webhook notification transport;
- reminder settings or intent-history screens in the web application;
- hosted-user authorization for these local product routes.
