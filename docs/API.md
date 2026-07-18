# Local Product API

The local product API exposes the deterministic planner without committing the project to a frontend or cloud authentication design. It is available under `/v1` when `PRODUCT_API_MODE=local_unauthenticated`.

This document describes the loopback product surface. Trusted machine callers use the separately
authenticated [inbound integration gateway](./INTEGRATIONS.md); its workspace-scoped credentials do
not authorize these product routes.

## Safety boundary

- Development defaults to `local_unauthenticated` and binds to `127.0.0.1`.
- Production is always `disabled`; configuration rejects attempts to enable unauthenticated routes in production or on a non-loopback application bind.
- `HOSTED_API_MODE` is a separate fail-closed gate. It defaults to `disabled`; `oidc` requires one
  complete validated registration, `HOSTED_OIDC_PREFLIGHT_MODE=enabled`, the complete bounded secret
  set, and `PRODUCT_API_MODE=disabled`. Enabled startup completes provider discovery before listening,
  installs the four browser lifecycle routes and the membership-authorized hosted work-item read/create,
  applies `HOSTED_RATE_LIMIT_PER_MINUTE`, and reports `hostedEndpointsEnabled: true`. Partial,
  malformed, mixed-case, and unknown non-empty `HOSTED_*` values fail startup without disclosure.
- Hosted mode is still a narrow API slice, not a complete public product: workspace provisioning,
  and administration are not public routes. First login creates one default workspace and active
  membership atomically; `GET /v1/hosted/workspaces?limit=20&offset=0` returns only the authenticated
  principal's active workspace page. A fixed
  `GET /v1/hosted/workspaces/{workspaceId}/work-items` returns only the first 20 backlog
  IDs/titles/versions. Its item versions support a strict
  `PATCH /v1/hosted/workspaces/{workspaceId}/work-items/{workItemId}` body containing only
  `expectedVersion` and `status=in_progress|done`.
  `GET /v1/hosted/workspaces/{workspaceId}/today?date=YYYY-MM-DD` returns only an existing current
  plan's titles, scheduled minutes, activity states, and total minutes. Workspace detail reads, most
  product routes, synchronization, ingress/TLS, and deployment automation remain separate
  requirements.
- CORS is disabled, JSON bodies are limited to 256 KiB, request objects reject unknown fields, and error responses do not include stack traces.
- Product routes reject missing, malformed, or non-loopback `Host` authorities before routing. This protects the unauthenticated loopback service from browser DNS-rebinding attacks; `localhost`, IPv4 `127.0.0.0/8`, and IPv6 loopback (`[::1]`) are accepted with an optional valid port. Health and system-information endpoints remain outside this product-route guard for local process and container diagnostics.
- Accepted UUID values in product-route paths and bodies are canonicalized to lowercase before service dispatch and identity comparison; responses therefore use the canonical spelling.
- Product routes are limited to `PRODUCT_RATE_LIMIT_PER_MINUTE` requests per minute per source address (240 by default; bounded from 1 through 10,000) and two concurrent plan generations per API process.
- The optional advisor is independently disabled by default. When enabled, its adapter accepts only
  one exact raw `http://127.0.0.1:<port>` Ollama origin and an allowlisted local Gemma model; it does
  not use DNS, redirects, proxies, tools, or credentials.
- Natural-language proposals are separately disabled by default, use that same transport policy,
  persist no prompt or free-form model prose, and cannot create work without a versioned,
  idempotent confirmation request.
- Local mode caps an installation at 20 workspaces; each workspace is capped at 500 routines, 5,000 activity events, 2,000 plan revisions, and 50 revisions for one date. Planning reads at most 2,001 dependency rows whose dependents are active opted-in candidates and fails closed with `planning.work_item_dependency_pool_too_large` when more than 2,000 relevant rows exist.
- Plan responses expose the original planning request, input hash, and algorithm versions, but not routine snapshots or activity history from the complete persisted input snapshot.

## Routes

| Method   | Route                                                                                          | Result                                                 |
| -------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `POST`   | `/v1/workspaces`                                                                               | Create a workspace (`201`)                             |
| `GET`    | `/v1/workspaces`                                                                               | List local workspaces                                  |
| `GET`    | `/v1/workspaces/{workspaceId}`                                                                 | Retrieve one workspace                                 |
| `POST`   | `/v1/workspaces/{workspaceId}/work-items`                                                      | Create a backlog/Kanban item (`201`)                   |
| `GET`    | `/v1/workspaces/{workspaceId}/work-items`                                                      | List a bounded work-item page                          |
| `GET`    | `/v1/workspaces/{workspaceId}/work-items/{workItemId}`                                         | Retrieve one work item                                 |
| `PATCH`  | `/v1/workspaces/{workspaceId}/work-items/{workItemId}`                                         | Version-checked work-item update                       |
| `POST`   | `/v1/workspaces/{workspaceId}/work-items/{workItemId}/subtasks`                                | Create a direct child (`201`)                          |
| `GET`    | `/v1/workspaces/{workspaceId}/work-items/{workItemId}/subtasks`                                | List a bounded direct-child page                       |
| `POST`   | `/v1/workspaces/{workspaceId}/natural-language/proposals`                                      | Prepare one review-only backlog-title proposal         |
| `PATCH`  | `/v1/workspaces/{workspaceId}/natural-language/proposals/{proposalId}`                         | Replace the version-checked reviewed work snapshot     |
| `POST`   | `/v1/workspaces/{workspaceId}/natural-language/proposals/{proposalId}/cancellations`           | Cancel a pending proposal without creating work        |
| `POST`   | `/v1/workspaces/{workspaceId}/natural-language/proposals/{proposalId}/confirmations`           | Idempotently confirm and create the exact work item    |
| `GET`    | `/v1/workspaces/{workspaceId}/work-item-dependencies`                                          | List a bounded dependency page                         |
| `POST`   | `/v1/workspaces/{workspaceId}/work-items/{workItemId}/prerequisites`                           | Add one direct prerequisite (`201` or `200`)           |
| `DELETE` | `/v1/workspaces/{workspaceId}/work-items/{workItemId}/prerequisites/{prerequisiteWorkItemId}`  | Idempotently remove a prerequisite (`204`)             |
| `POST`   | `/v1/workspaces/{workspaceId}/schedule-blocks`                                                 | Create a calendar block (`201`)                        |
| `GET`    | `/v1/workspaces/{workspaceId}/schedule-blocks?from={instant}&to={instant}`                     | List blocks overlapping a bounded range                |
| `GET`    | `/v1/workspaces/{workspaceId}/schedule-blocks/{scheduleBlockId}`                               | Retrieve one calendar block                            |
| `PATCH`  | `/v1/workspaces/{workspaceId}/schedule-blocks/{scheduleBlockId}`                               | Version-checked calendar-block update                  |
| `DELETE` | `/v1/workspaces/{workspaceId}/schedule-blocks/{scheduleBlockId}`                               | Version-checked audited deletion (`204`)               |
| `PUT`    | `/v1/workspaces/{workspaceId}/notification-profile`                                            | Create or version-update reminder policy               |
| `GET`    | `/v1/workspaces/{workspaceId}/notification-profile`                                            | Read reminder policy                                   |
| `POST`   | `/v1/workspaces/{workspaceId}/notification-rules`                                              | Create a deterministic reminder rule (`201`)           |
| `GET`    | `/v1/workspaces/{workspaceId}/notification-rules`                                              | List reminder rules                                    |
| `PATCH`  | `/v1/workspaces/{workspaceId}/notification-rules/{notificationRuleId}`                         | Version-checked reminder-rule update                   |
| `POST`   | `/v1/workspaces/{workspaceId}/one-off-reminders`                                               | Create an explicit reminder (`201`)                    |
| `GET`    | `/v1/workspaces/{workspaceId}/one-off-reminders?from={instant}&to={instant}`                   | List up to 500 reminders in a range of at most 31 days |
| `PATCH`  | `/v1/workspaces/{workspaceId}/one-off-reminders/{oneOffReminderId}`                            | Version-checked explicit-reminder update               |
| `POST`   | `/v1/workspaces/{workspaceId}/one-off-reminders/{oneOffReminderId}/cancellations`              | Cancel an explicit reminder                            |
| `GET`    | `/v1/workspaces/{workspaceId}/notification-intents?from={instant}&to={instant}`                | List insert-only materialized intents                  |
| `POST`   | `/v1/workspaces/{workspaceId}/notification-intents/materializations`                           | Materialize a bounded policy window                    |
| `GET`    | `/v1/workspaces/{workspaceId}/notification-deliveries?from={instant}&to={instant}`             | List product-safe delivery execution history           |
| `POST`   | `/v1/integrations/reminder-deliveries/claim`                                                   | Claim one due reminder with `schedule:delivery`        |
| `POST`   | `/v1/integrations/reminder-deliveries/receipt`                                                 | Record one fenced, bounded delivery outcome            |
| `POST`   | `/v1/workspaces/{workspaceId}/routines`                                                        | Create a routine (`201`)                               |
| `GET`    | `/v1/workspaces/{workspaceId}/routines?status=active&limit=100&offset=0`                       | List a bounded routine page (`200`)                    |
| `GET`    | `/v1/workspaces/{workspaceId}/routines/{routineId}`                                            | Retrieve one routine (`200` or `404`)                  |
| `PATCH`  | `/v1/workspaces/{workspaceId}/routines/{routineId}`                                            | Version-checked partial update (`200` or `409`)        |
| `GET`    | `/v1/workspaces/{workspaceId}/routines/{routineId}/selection-preference?timeZone={iana}`       | Read explicit future-plan preference state             |
| `POST`   | `/v1/workspaces/{workspaceId}/routines/{routineId}/selection-preference`                       | Append a versioned future-plan preference              |
| `GET`    | `/v1/workspaces/{workspaceId}/routines/{routineId}/duration-insight`                           | Derive a read-only insight (`200` or `404`)            |
| `POST`   | `/v1/workspaces/{workspaceId}/routines/{routineId}/duration-insight/approve`                   | Atomically approve an insight (`200` or `409`)         |
| `POST`   | `/v1/workspaces/{workspaceId}/routines/{routineId}/duration-insight/dismissals`                | Dismiss one exact insight (`200` or `409`)             |
| `POST`   | `/v1/workspaces/{workspaceId}/routines/{routineId}/duration-insight/dismissal-resets`          | Restore one exact insight (`200` or `409`)             |
| `GET`    | `/v1/workspaces/{workspaceId}/daily-plan-fit-insight?forDate={YYYY-MM-DD}`                     | Derive read-only joint target guidance                 |
| `GET`    | `/v1/workspaces/{workspaceId}/daily-plan-fit-insight/usages?limit=5`                           | List bounded explicit-use outcomes                     |
| `GET`    | `/v1/workspaces/{workspaceId}/daily-plan-fit-insight/effectiveness?limit=28`                   | Summarize bounded explicit-use outcomes                |
| `POST`   | `/v1/workspaces/{workspaceId}/daily-plan-fit-insight/dismissals`                               | Dismiss one exact target suggestion                    |
| `POST`   | `/v1/workspaces/{workspaceId}/daily-plan-fit-insight/dismissal-resets`                         | Restore one exact target suggestion                    |
| `GET`    | `/v1/workspaces/{workspaceId}/planning-outcomes?forDate={YYYY-MM-DD}`                          | Summarize the prior 30 current plan heads              |
| `GET`    | `/v1/workspaces/{workspaceId}/routines/{routineId}/activity-events`                            | List stable, cursor-paginated history (`200`)          |
| `POST`   | `/v1/workspaces/{workspaceId}/routines/{routineId}/activity-events`                            | Idempotently record activity (`200`)                   |
| `POST`   | `/v1/workspaces/{workspaceId}/plans`                                                           | Create revision 1 or retry an exact revision           |
| `GET`    | `/v1/workspaces/{workspaceId}/plans/{YYYY-MM-DD}?revision=1`                                   | Retrieve an exact revision (`200` or `404`)            |
| `GET`    | `/v1/workspaces/{workspaceId}/plans/{YYYY-MM-DD}/current`                                      | Retrieve the current Today plan and head version       |
| `POST`   | `/v1/workspaces/{workspaceId}/advisor/advice`                                                  | Request read-only local advice for a current plan      |
| `PATCH`  | `/v1/workspaces/{workspaceId}/plans/{YYYY-MM-DD}/items/{itemId}/lock`                          | Idempotently lock or unlock a current plan item        |
| `POST`   | `/v1/workspaces/{workspaceId}/plans/{YYYY-MM-DD}/items/{itemId}/activity-events`               | Record a current item action                           |
| `POST`   | `/v1/workspaces/{workspaceId}/plans/{YYYY-MM-DD}/regenerations`                                | Regenerate around locked items                         |
| `POST`   | `/v1/workspaces/{workspaceId}/plans/{YYYY-MM-DD}/alternative-previews`                         | Preview up to three distinct plans without writing     |
| `POST`   | `/v1/workspaces/{workspaceId}/plans/{YYYY-MM-DD}/alternative-selections`                       | Select one still-current alternative idempotently      |
| `POST`   | `/v1/workspaces/{workspaceId}/plans/{YYYY-MM-DD}/items/{itemId}/replacement`                   | Replace one unlocked item                              |
| `POST`   | `/v1/workspaces/{workspaceId}/plans/{YYYY-MM-DD}/items/{itemId}/routine-feedback`              | Suppress one pending routine and replan                |
| `POST`   | `/v1/workspaces/{workspaceId}/plans/{YYYY-MM-DD}/routines/{routineId}/routine-feedback-resets` | Reset routine feedback and replan                      |

Activity requests require an `Idempotency-Key` header containing 1–160 characters. Reusing a key with identical event content returns the original event. Reusing it for different content returns `409 activity.idempotency_conflict`. Public event responses omit the key because the caller already owns it and it is retry metadata, not activity history.

Work items provide the initial backlog and status-column Kanban model through `backlog`, `planned`,
`in_progress`, `blocked`, `done`, and `cancelled`. Every response includes nullable
`parentWorkItemId`; `null` is a top-level item. `planningDurationMinutes` is nullable: `null` keeps
normal work out of Today, while a positive value up to 43,200 opts a leaf item into the planner.
`dueOn` is independently nullable and, when present, must be a strict real Gregorian `YYYY-MM-DD`
local date. Create may omit either nullable field or send `null`; update omission preserves it, while
update `null` clears it. Only opted-in `backlog`, `planned`, and `in_progress` leaf work is eligible.
A parent with children is excluded even when it retains a positive duration, and becomes eligible
again only after every child is detached. A due date never overrides status, duration, hierarchy,
window, time-budget, or task-count constraints.

The root create route accepts optional `parentWorkItemId`. The nested `POST .../{parentId}/subtasks`
route derives the parent from its path and rejects a conflicting body field. Its `GET` companion
returns only direct children as `{items,page:{limit,offset}}`, with `limit` from 1–200 and `offset`
from 0–1,000,000. Hierarchy supports arbitrary depth, remains same-workspace and acyclic, and never
cascades status. `PATCH` may set `parentWorkItemId` to another work-item UUID or `null` to detach.
The child's current `expectedVersion` is required; a real move increments only the child. A missing
or cross-workspace parent returns `404 work_item.not_found`, self-parenting returns
`422 work_item_hierarchy.self_reference_invalid`, and a direct or transitive cycle returns
`409 work_item_hierarchy.cycle_conflict`. Concurrent graph changes share one workspace lock.

General list requests accept optional `status` and `priority` filters plus the same pagination
bounds. Ordering is stable by creation time and ID. Updates increment exactly once for a real
semantic change and preserve the version for a normalized no-op. Work-item hard deletion and manual
card ranking are not part of this MVP surface; cancellation is the removal workflow, and clients
group items by status. The parent foreign key restricts deletion while children remain. A completion
from a stale plan never auto-transitions `blocked` or `cancelled` work to `done`.

Work-item prerequisites are directed same-workspace edges. The `POST .../work-items/{dependentWorkItemId}/prerequisites` route accepts the strict body
`{"prerequisiteWorkItemId":"<uuid>"}`. A new edge returns `201`; an exact existing edge returns the
same dependency with `200`. `DELETE` uses both IDs in the path and returns `204` whether or not the
edge still exists. Neither operation requires or changes a work-item version because the graph is a
separate resource. The response shape is
`{workspaceId, prerequisiteWorkItemId, dependentWorkItemId, createdAt}`, with `createdAt` as an ISO
instant and every UUID in canonical lowercase form.

`GET /work-item-dependencies` accepts only `limit` from 1–200 and `offset` from 0–1,000,000, with
defaults of 100 and 0. It returns `{items, page:{limit,offset}}`. The collection route validates the
workspace and paging. The mutation routes validate the workspace and both item IDs before changing
the graph. Results have stable ascending order by creation time, prerequisite ID, and dependent ID. A
missing workspace returns `404 workspace.not_found`; missing or cross-workspace items return
`404 work_item.not_found`; a self-edge returns
`422 work_item_dependency.self_reference_invalid`; and any
direct or transitive cycle returns `409 work_item_dependency.cycle_conflict`. Both graph mutations
take a workspace-scoped PostgreSQL advisory lock before reading the current graph, so concurrent
additions cannot pass cycle validation against stale views. UUID case cannot bypass these rules: a
mixed-case spelling of the same work item is still a `422` self-edge, and the advisory key uses the
canonical workspace UUID. Concurrent reciprocal additions produce one created edge while the other
request is rejected with the cycle conflict.

Only `done` satisfies a direct prerequisite. Adding or removing an edge never changes either work
item's status or version and never mutates the current Today revision or head. The planner applies the
current graph when generating a new revision. On explicit regeneration, an unlocked dependent with an
unmet prerequisite is neither retained nor newly selected. A locked nonterminal item preserves its
anchor, while terminal items remain excluded under the existing replan rules.

The combined work/dependency planning projection is decoded and order-checked defensively. Malformed
persisted rows fail closed with the internal `planning.work_item_graph_corrupt` invariant. Product
routes return only `500 internal.unexpected_error`, log the stable invariant code once, and expose
neither the stored graph contents nor the internal error message.

Schedule-block range reads require offset-bearing `from` and `to` instants, use half-open overlap (`startsAt < to` and `endsAt > from`), and accept ranges no longer than 93 days with the same bounded pagination convention. Absolute instants remain authoritative when `timeZone` changes. A block may reference a work item from the same workspace, but their lifecycles remain independent. Create and update validate the workspace and optional link. Update and deletion require `expectedVersion`; deletion returns `204` and appends an immutable audit snapshot in the same transaction. Recurrence authoring, conflict detection, and automatic placement are deferred.

Notification policy is Schedule-owned and deterministic. Create the workspace profile with a strict
`PUT` body such as:

```json
{
  "expectedVersion": null,
  "enabled": true,
  "timeZone": "America/La_Paz",
  "quietHoursStartMinute": 1320,
  "quietHoursEndMinute": 420,
  "quietHoursPolicy": "next_allowed",
  "catchUpWindowMinutes": 60,
  "dailyIntentLimit": 12
}
```

`expectedVersion: null` creates; a positive exact version updates. Quiet-hour fields must be supplied
together and may both be `null`. Rule creation accepts one of `daily_digest`, `daily_follow_up`,
`plan_window_open`, `schedule_block_lead`, or `work_item_due`, plus `enabled`, `cooldownMinutes`, and
`priority`. Digest, follow-up, and due rules require `localMinute` and no `leadMinutes`; plan-window
and schedule-block rules require `leadMinutes` and no `localMinute`. A rule's kind is immutable;
disable or version-update its timing and selection controls instead. A workspace is limited to 100
stored rules; both create and list fail closed if persisted state exceeds that boundary.

One-off creation accepts `{title, scheduledFor}`. Its update accepts a positive `expectedVersion`
plus title and/or instant. Cancellation is a dedicated version-checked command and is idempotent only
at the domain state boundary; a stale HTTP command still receives the normal version conflict.

Materialization accepts offset-bearing instants and a maximum 31-day half-open window:

```json
{
  "from": "2026-07-20T08:00:00.000Z",
  "through": "2026-07-21T00:00:00.000Z"
}
```

The response contains `created`, `existing`, and `suppressed`. Repeating or concurrently issuing the
same request returns the natural-key winners under a workspace advisory lock. Materialization never
calls a provider or generic outbox. A later delivery-scoped adapter claim lazily creates the fenced
command for a still-valid due intent. Intent list reads accept `limit` 1–500 and a nonnegative
`offset`. See
[REMINDERS.md](./REMINDERS.md) for DST, quiet-hours, catch-up, priority, cooldown, and daily-limit
semantics. Profile changes invalidate all pending intents; rule and one-off changes invalidate only
their own. Schedule-block/work-item edits, plan replacement, and terminal item activity invalidate
the affected pending target intents transactionally. No mutation rewrites a previously accepted
intent in place.

Delivery-history reads use the same maximum 31-day range, `limit` 1–500, and a nonnegative bounded
`offset`. They are workspace-scoped and ordered by scheduled instant then delivery ID. The response
contains only product-facing lifecycle facts: delivery and intent IDs, reminder kind and target
class, bounded title, schedule/local date/priority, status, attempt count, availability and
completion instants, a bounded last-failure code, and record timestamps. It never returns claim
tokens, lease details, credentials, dedupe internals, destinations, providers, channels, recipients,
or provider payloads. A `processing` command means Schedule has granted a fenced claim; it is not
proof that any external message was sent.

The two `/v1/integrations/reminder-deliveries/*` routes are not local product routes. They require
the integration bearer-token boundary, the explicit `schedule:delivery` scope, JSON, and an
`Idempotency-Key`. Claim returns at most one privacy-bounded command; receipt accepts only a fenced
`delivered`, `retryable_failure`, or `permanent_failure` outcome. See
[INTEGRATIONS.md](./INTEGRATIONS.md#reminder-delivery) for the wire contract and adapter obligations.

Routine updates require `expectedVersion`. Scalar fields are partial; if `tags`, `duration`, or `cadence` is supplied, that nested object is a complete replacement. A real change increments the routine version once. A semantic no-op returns the current routine without writing or incrementing its version. A stale version returns `409 routine.version_conflict`. The update takes the same per-routine advisory lock used by activity and duration-insight commands, then reloads and saves under read committed so a manual edit cannot race an approval, dismissal, reset, or evidence append. This generic `PATCH` is still the manual editing path; it does not assert that a duration-insight suggestion is current.

Routine selection preference is a separate append-only stream. `GET .../selection-preference`
requires an explicit IANA `timeZone` and returns only `routineId`, `feedbackVersion`,
`activeEventCount`, bounded `score`, human-readable `reason`, and nullable `updatedAt`. The active
count distinguishes a quiet untouched/reset state from directional events that currently cancel to
a zero score. Version 0 has count and score 0, no reason, and no update time.

`POST .../selection-preference` requires an `Idempotency-Key` header and a strict body containing
`kind` (`more_often`, `less_often`, or `reset`), non-negative `expectedFeedbackVersion`, and
`timeZone`. Optional nullable `sourcePlanId` and `sourcePlanItemId` preserve Today provenance; a
source item requires its source plan, and reset cannot identify an item. Success returns the same
public projection accepted by that mutation; a concurrent later instruction cannot change its
response. Exact retries replay that projection without advancing. Source provenance is validated
against the same workspace and routine. Semantic key reuse or a stale preference version returns
`409`; nonexistent provenance returns `404`. Each routine has a finite 1,000-event append-only
history, after which new instructions return `422`. The command never edits the routine or current
plan. A later explicit generation or regeneration is a new planning run and may consume the signal.

The routine `duration-insight` route is a read-only calculation over same-workspace, same-routine
activity. It considers completed sessions whose occurrence lies in the inclusive interval from
`windowStartedAt` through `evaluatedAt` (the trailing 90 days), and whose occurrence and recording are
not in the future. A qualifying completion uses its latest non-future `duration_corrected` amendment,
ordered by recording time and then event ID, and is removed when it has a non-future
`completion_reversed` amendment. At least three remaining positive, integer-duration samples are
required.

The response includes `routineId`, `routineVersion`, `status`, `insightKey`, `disposition`,
`dismissedAt`, `sampleCount`, `minimumSamples`, `lookbackDays`, `evaluatedAt`, `windowStartedAt`, the
current minimum/expected/maximum minutes, `observedMedianMinutes`, `materialThresholdMinutes`, and
`suggestedExpectedMinutes`. Status is one of:

- `insufficient_history`: fewer than three samples; both observed and suggested values are `null`;
- `aligned`: the median is inside the configured range and differs from expected by less than
  `max(5, ceil(expectedMinutes * 0.10))`;
- `suggested`: the difference meets that threshold and the median remains inside the configured
  range, so `suggestedExpectedMinutes` contains the median; or
- `review_range`: the median is outside the configured minimum/maximum, so no direct suggestion is
  returned.

`suggested` and `review_range` are actionable and receive a strict 64-character lowercase SHA-256
`insightKey`. The key fingerprints the calculation version, lookback and minimum-sample policy,
current minimum/expected/maximum duration policy, and canonical qualifying completion, correction,
and reversal evidence. It deliberately excludes evaluation time, repository return order, and
presentation-only routine fields. `insufficient_history` and `aligned` have `insightKey: null`.

An actionable response has `disposition: "available"` and `dismissedAt: null` unless its latest exact-
key feedback event is `dismissed`. A dismissal yields `disposition: "dismissed"` plus the event's
recording time. A later `reset` restores `available`. A changed evidence set, relevant duration
policy, or calculation policy produces a new key, so a still-actionable recommendation resurfaces as
available without deleting its earlier feedback history.

The `GET` route never mutates a routine or plan. A client accepts a suggestion with the dedicated
`POST .../duration-insight/approve` command. Its body is strict and contains exactly an
`expectedVersion` plus the complete duration replacement:

```json
{
  "expectedVersion": 2,
  "duration": {
    "minimumMinutes": 20,
    "expectedMinutes": 48,
    "maximumMinutes": 60,
    "splittable": false,
    "minimumSessionMinutes": null,
    "overheadMinutes": 0
  }
}
```

In one read-committed unit of work, the server acquires the same per-routine advisory lock used by
activity appends, reloads the workspace-scoped routine, verifies its version, captures the evaluation
time, reads current evidence for the resulting inclusive 90-day window, recomputes the insight, and
saves the routine. Capturing the cutoff after the lock wait includes evidence committed by the earlier
lock holder. Read committed is intentional here: each statement after that wait sees those commits.
Every submitted duration field except `expectedMinutes` must equal the current
user-owned value. A changed range, splitting, session, or overhead setting is rejected with
`routine_duration_insight.approval_scope_invalid`; callers use the generic routine `PATCH` for those
manual edits.

A stale routine returns `409 routine.version_conflict`. If a completion, correction, or reversal
means the requested expected duration is no longer the current supported suggestion, the command
returns `409 routine_duration_insight.evidence_conflict` without saving. Clients must reload the
routine and evidence and obtain fresh approval rather than retry automatically. Successful approval
does not change the current Today plan or its head. A later explicit generation or regeneration can
use the new expected duration.

Dismiss and reset use the dedicated `POST .../dismissals` and
`POST .../dismissal-resets` routes. Both require an `Idempotency-Key` header from 1 to 160 characters
and the same strict body:

```json
{
  "expectedVersion": 2,
  "insightKey": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
}
```

The server takes the routine activity lock and uses read committed so evidence committed by an earlier
lock holder is visible. It resolves an exact accepted-command replay before revalidating current
state. For a new command, it verifies the workspace, routine, expected version, current actionable
insight, and required disposition before appending an immutable `dismissed` or `reset` event. A `200`
response returns that event with `id`,
`ingestedSequence`, `workspaceId`, `routineId`, `insightKey`, `kind`, `routineVersion`,
`observedMedianMinutes`, nullable `suggestedExpectedMinutes`, `idempotencyKey`, and ISO `recordedAt`.
Exact command retry returns the original event. Reusing the workspace-scoped idempotency key for
different semantics returns `409 routine_duration_insight.idempotency_conflict`; changed evidence or
policy returns `409 routine_duration_insight.evidence_conflict`; dismissing an already dismissed key
or resetting an available key returns `409 routine_duration_insight.disposition_conflict`; and a stale
routine version returns `409 routine.version_conflict`. Missing or malformed headers and bodies return
`400`, missing resources return `404`, and other domain-policy errors return `422`.

These feedback commands only change the insight's disposition. They never edit the routine or its
duration, approve a suggestion, mutate Today or its head, regenerate a plan, or change planner input,
scoring, and selection.

The workspace-level `daily-plan-fit-insight` route requires an explicit real Gregorian `forDate`
query value. It derives deterministic guidance from the current heads of fully resolved, nonempty
plans in the preceding 90 local dates. Every item must be completed, skipped, deferred, or dismissed;
a pending or started item excludes that plan from the sample. At most the 28 most recent eligible
plans are used, at most 512 items are accepted in one evidence plan, and at least three samples are
required. Completed workload is the scheduled minutes and count of items marked complete, not
optional stopwatch duration. Oversized or over-ceiling evidence fails closed instead of deriving a
partial recommendation.

The response contains `status`, nullable `insightKey`, `disposition`, nullable `dismissedAt`,
`forDate`, `windowStartedOn`, `windowEndedOn`, `lookbackDays`, `sampleCount`, `minimumSamples`,
`maximumSamples`, `evaluatedAt`, the four nullable `typicalPlanned*` and `typicalCompleted*` medians,
both nullable materiality thresholds, and nullable `suggestedTargetMinutes` and
`suggestedTargetTaskCount`. Status is one of:

- `insufficient_history`: fewer than three fully resolved current heads;
- `aligned`: the median completed workload does not support a material downward adjustment; or
- `suggested`: at least one dimension supports a material decrease and both proposed target values
  are returned.

Version 1 rounds proposed minutes to the nearest 15 with a 30-minute floor and uses a one-task floor.
The minute threshold is the larger of 30 minutes or 20% of the planned median rounded up to 15; the
task threshold is the larger of one task or 25% of the planned median rounded up. It does not
recommend targets above the user's typical plan. `insufficient_history` and `aligned` are
informational and have no key. A `suggested` result receives a lowercase SHA-256 key over the policy,
requested date, evidence window, and canonical selected evidence; evaluation time and repository
ordering are excluded.

Dismiss and reset use strict bodies containing exactly the requested date and key, plus a required
`Idempotency-Key` header of 1–160 characters:

```json
{
  "forDate": "2026-07-14",
  "insightKey": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
}
```

The server takes a lowercase-canonical workspace-scoped advisory lock, resolves an exact accepted
replay first, and then recalculates current evidence before appending an immutable `dismissed` or
`reset` event. Exact retry
returns the original event. Semantic key reuse returns
`409 daily_plan_fit_insight.idempotency_conflict`; changed evidence returns
`409 daily_plan_fit_insight.evidence_conflict`; and an invalid disposition transition returns
`409 daily_plan_fit_insight.disposition_conflict`. A changed evidence snapshot has a different key,
so it can surface as available despite an older dismissal.

Copying a suggestion into editable target fields is a client action and performs no API mutation.
When the user subsequently submits ordinary revision-1 generation, the otherwise strict plan body
may include nullable `planFitInsightKey`. The server locks the date and workspace feedback stream,
recomputes current evidence, and requires that exact key to remain an available suggestion. A stale
key returns `409 daily_plan_fit_insight.evidence_conflict` without creating a plan or event.
Successful generation stores the plan and one immutable `used` receipt in the same transaction. The
receipt preserves the exact evidence and suggested pair, generated plan ID, and final user-edited
targets. Exact plan retry requires the matching receipt and cannot duplicate it; mismatched provenance
returns `409 daily_plan_fit_insight.usage_replay_conflict`. Mutation endpoints intentionally reject
the provenance key because later revisions are reported against the original explicit use.

`GET .../daily-plan-fit-insight/usages` accepts `limit` 1–28, defaults to 5, and returns newest uses
only for the requested workspace. Each item contains the usage ID, date, evidence key and timestamp,
source plan ID, nullable current-plan identity/revision/head version, `revisedSinceUsage`, suggested
and applied targets, `usedExactSuggestion`, and nullable planned/completed minute and task totals.
`status` is `pending` until every item in the current plan is terminal, `resolved` after that point,
or `not_evaluable` when there is no nonempty current plan. Partial completion totals are deliberately
withheld. Reads never append feedback, move a head, regenerate, or alter planner scoring.

`GET .../daily-plan-fit-insight/effectiveness` accepts `limit` 1–28 and defaults to 28. It returns no
usage identities, dates, evidence keys, or item content. Instead it reports the bounded sample size;
resolved, pending, and not-evaluable status counts; an overlapping revised count; exact-versus-edited
use counts; and auditable integer target, scheduled, and completed totals. Only resolved outcomes
whose current head is still the source plan contribute to totals or rates. Target-scheduled rates are
weighted scheduled totals divided by the actual submitted targets; plan-completed rates are weighted
completed totals divided by scheduled totals. Rates are half-up integer basis points and are `null`
without an eligible denominator. Pending, not-evaluable, and later-revised outcomes remain counted but
are excluded from every rate. The summary is descriptive current-head reporting, not a causal effect,
improvement score, planner input, learned policy, or model signal.

`GET .../planning-outcomes` requires one real Gregorian `forDate` and summarizes the preceding 30
local dates. It uses at most one authoritative current head per date and returns the window bounds,
plan-day count, weighted planned/completed task and scheduled-minute totals, additional revisions
beyond revision 1, and half-up completion rates in integer basis points. Rates are `null` when their
planned denominator is zero. The route is read-only and does not write telemetry, compare planner
versions, infer causality, or influence planning or model input.

Routine activity history is ordered by newest ingestion first and accepts `limit` from 1–200 (default 50) plus an opaque, integrity-protected `cursor`. The cursor is bound to its workspace and routine. The first page captures a high-water mark, so later appends do not shift subsequent pages. A non-null `page.nextCursor` retrieves the next page. Local cursor signing keys are process-bound, so clients should restart pagination after an API restart.

A plan is identified by workspace, real Gregorian local date, and positive request revision. Generic `POST /plans` creates only the initial revision 1. It may also retry an already persisted exact generic revision: the server recomputes the deterministic input and returns the persisted plan when the input hash is unchanged. Planner input includes routines, opted-in eligible work items, activity history, and canonical routine planning feedback. If any input has changed, retrying that revision returns `409 planning.revision_conflict`.

`availableWindows` is an explicit caller-owned array and may contain multiple validated,
non-overlapping half-open instant ranges. The API and planner do not query schedule blocks or subtract
calendar state automatically. The local Today client may derive these windows from a fresh calendar
read, but the exact accepted array is persisted in the plan request and remains authoritative for
deterministic replay and later plan mutations.

Generic generation never allocates a later revision. A missing revision greater than 1, or any new generic revision after a current head exists, returns `409 planning.revision_creation_conflict`. Clients must use regeneration or replacement with the current plan identity, head version, and an idempotency key; those mutation endpoints allocate the next revision atomically and preserve the Today interaction contract. Mutation retries must return to the original mutation endpoint with the same idempotency key.

Every plan item has a stable UUID, a typed source identity (`sourceType` plus exactly one of `routineId` or `workItemId`), and a projected `locked` flag. The current-plan response adds `headVersion`. Lock changes require an `Idempotency-Key` plus `expectedPlanId` and `expectedHeadVersion`; stale state returns `409 planning.head_conflict`. Identical retries return the original result, while key reuse for another command returns `409 planning.idempotency_conflict`. Lock and unlock facts are append-only even though the current flag is projected for efficient reads.

Current plan items also expose `activityState`, `lastActivityEventId`, and `activityUpdatedAt`. An item activity request uses the same optimistic identity and idempotency requirements as locking, and supports `started`, `completed`, `skipped`, `deferred`, `dismissed`, or `completion_reversed`. A pending item may enter any direct action state; a started item may enter any terminal state. Terminal states cannot transition again, except that reversing a completion reopens it as pending. Only completion may include an actual `durationMinutes`. The resulting activity event records the plan, plan item, and typed source identity, advances the Today head once, and feeds later planner history. Completing a work-derived item marks its source work item `done` only from an active work status. Its reversal restores the saved prior status only if no later accepted completion or work-item edit has advanced the completion ownership version; otherwise the newer state wins unchanged. Lock state remains independent, and an action does not automatically regenerate the plan.

Generic routine activity may still be recorded outside a plan. Item completion reversal uses the item endpoint so its append-only event, Today projection, conditional work-status restoration, and head version change atomically; generic reversal remains appropriate for routine activity recorded outside a plan.

### Natural-language proposal lifecycle

Natural-language capture is an explicit proposal-then-confirm flow. It is independently disabled by
default and accepts only one versioned prompt request:

```json
{
  "version": "schedule.natural-language/v1",
  "requestId": "11111111-1111-4111-8111-111111111111",
  "prompt": "Turn my launch notes into one checklist task"
}
```

The caller cannot supply a command, provider, model, options, tools, destination ID, priority, date,
duration, tags, or other mutation fields. A successful `200` response contains transient summary and
warning text plus either one pending `work_item.create` title, `no_proposal`, or a bounded unavailable
reason. Preparing a proposal does not create a work item or hold a database transaction open during
inference. Reusing the same request UUID and normalized prompt returns the still-pending stored
proposal without another provider call; reusing it for different text returns
`409 natural_language.request_conflict`.

The response's proposal has an ID, request ID, exact canonical title-only command and command hash,
provider/model identifiers, `pending` status, expiration instant, positive optimistic version, and
`userSelection` initialized to `none`/`null`/`null` for priority, due date, and planning duration.
The prompt, provider summary, warnings, raw envelope, and provider errors are not persisted. Schedule
stores only a deployment-keyed prompt fingerprint for request-conflict detection. Every response in
this route family, including validation and errors, uses `Cache-Control: no-store`.

Editing sends the complete reviewed snapshot to the proposal item route:

```json
{
  "expectedVersion": 1,
  "title": "Reviewed title",
  "userSelection": {
    "priority": "high",
    "dueOn": "2026-07-20",
    "planningDurationMinutes": 60
  }
}
```

`userSelection` is authored by the user after inference; it is not extracted or suggested by the
model. Priority is `none`, `low`, `medium`, `high`, or `urgent`; due date is a real local Gregorian
date or `null`; duration is a whole number from 1 through 43,200 or `null`.
Cancellation sends only `{ "expectedVersion": 1 }` to its dedicated route. Both lock the exact
tenant-scoped proposal and reject terminal state. An edit with a mismatched version conflicts unless
the requested title and all three review fields already equal the stored winner and the expected
version is not from the future; this exact semantic replay returns the current version without
another audit and lets a client recover when the original successful response was lost. An accepted change increments its
version and appends an audit event. Cancellation requires the exact current version. Neither command
creates work.

Confirmation sends `{ "expectedVersion": 2 }` and requires an `Idempotency-Key`. The first accepted
call returns `201` with the proposal ID, command hash, `replayed: false`, and the created backlog work
item. The exact same key returns the original result with `200` and `replayed: true`; a different key
after confirmation returns `409 natural_language.confirmation_conflict`. One serializable
transaction locks and revalidates the proposal, expiration, version, canonical command digest,
reviewed fields, and deterministic result identity before creating one root backlog work item with
the reviewed priority, due date, and duration, marking confirmation, and auditing it.
The review fields have a separate canonical digest; the title-only model command hash is never
repurposed. Same-key replay also verifies that the stored result identity is the proposal-derived ID.
Concurrent confirmations therefore create one work item and one confirmation audit. Missing
proposals return `404`; expired, cancelled, or already-consumed proposal operations return `410`;
corrupt stored commands fail as a redacted `500`.

There is intentionally no proposal-list or proposal-read route in version 1. Pending proposals are
short-lived interaction state, not a prompt or model-output history. See
[NATURAL_LANGUAGE.md](./NATURAL_LANGUAGE.md) for the complete trust and persistence contract.

The advisor route is an explicit read operation with no automatic retry. It requires
a current plan and accepts this complete strict body; unknown fields, including `prompt`, `model`,
`url`, `options`, `tools`, `think`, and `stream`, return `400` before provider dispatch:

```json
{
  "version": "schedule.advisor/v1",
  "requestId": "11111111-1111-4111-8111-111111111111",
  "date": "2026-07-15",
  "focus": "both",
  "expectedPlanId": "22222222-2222-4222-8222-222222222222",
  "expectedHeadVersion": 3
}
```

Version 1 requires the literal `both` focus and rejects narrower values until their projection and
output semantics are defined. The server, not the caller, constructs an immutable
`schedule.advisor-context/v1` projection. It contains a maximum of
50 sorted current-plan items and 50 deterministically ordered eligible backlog items, selected
scheduling fields, bounded reasons and warnings, and explicit truncation flags. Eligible backlog
excludes current-plan work and any item whose direct prerequisites are not all `done`; candidates and
their dependency/status projection come from one bounded database statement. The context excludes
descriptions, workspace names, calendar blocks, activity history, full planner snapshots, secrets,
and any dedicated or free-form model-instruction field. Titles and other stored text may be
user-authored, so the fixed provider prompt treats every supplied string as untrusted data. Stored
text is normalized and sanitized, individual fields are bounded, and the complete JSON context
cannot exceed 64 KiB.

An available `200` response has the following versioned shape. The request ID is echoed exactly,
timestamps are ISO instants, and all provider text has passed strict shape, length, canonical-text,
target-membership, and duplicate validation:

```json
{
  "version": "schedule.advisor/v1",
  "requestId": "11111111-1111-4111-8111-111111111111",
  "status": "available",
  "reason": null,
  "snapshot": {
    "date": "2026-07-15",
    "planId": "22222222-2222-4222-8222-222222222222",
    "headVersion": 3
  },
  "input": {
    "planItemCount": 4,
    "backlogCount": 8,
    "truncated": { "planItems": false, "backlog": false }
  },
  "provenance": {
    "provider": "ollama",
    "model": "gemma4:e4b",
    "requestedAt": "2026-07-15T12:00:00.000Z",
    "completedAt": "2026-07-15T12:00:01.250Z",
    "latencyMs": 1250
  },
  "summary": "Protect the first focused block and keep the later work flexible.",
  "suggestions": [
    {
      "id": "advice-1",
      "kind": "focus",
      "targetType": "plan_item",
      "targetId": "33333333-3333-4333-8333-333333333333",
      "title": "Start with the focused block",
      "rationale": "It is already selected and has the clearest priority signal.",
      "confidence": "medium"
    }
  ]
}
```

Suggestion kinds are `focus` or `sequence` targeting a supplied `plan_item`, `consider_backlog`
targeting a supplied `work_item`, and untargeted `plan_observation`. Confidence is only `low` or
`medium`, and no response contains an executable action. A disabled or recoverably unavailable
advisor also returns `200` with the same snapshot, input, and provenance envelope, but with
`status: "unavailable"`, `summary: null`, an empty suggestion array, and one of `disabled`, `busy`,
`timeout`, `unreachable`, `provider_rejected`, `response_too_large`, `malformed_response`, or
`invalid_advice` as `reason`.

The initial context read closes before the model call. Valid advice is returned only after a second
short unit of work rebuilds and exactly compares the sanitized plan-and-backlog context plus its
canonical dependency projection. A stale expected identity or any plan, backlog, dependency, or
prerequisite-status change during inference returns
`409 advisor.snapshot_conflict`; the model output is discarded. Missing workspaces or current plans
return `404`; invalid context or policy data returns `422`. Every advisor response, including route
validation, body-limit, rate-limit, and conflict errors, carries `Cache-Control: no-store`. If the
caller disconnects while inference is pending, cancellation reaches the provider adapter, destroys
the loopback request, and releases its bounded concurrency permit. The route performs no database
write, audit append, plan regeneration, or readiness check against Ollama.

Regeneration and replacement require the same optimistic identity and idempotency header plus a complete planning request with a new seed. The server allocates the next revision. Regeneration carries locked non-terminal items exactly and plans only residual capacity. Replacement anchors every sibling, rejects a locked target, excludes the removed typed source, and fills the released capacity. Terminal sources are not replanned. Prior revisions remain immutable and mutation provenance is retained for replay. A retry resolves to the same immutable plan revision and recorded head version; its projected lock and activity fields reflect the latest state for that revision.

Alternative preview accepts the same strict planning request and exact `expectedPlanId` and
`expectedHeadVersion`, but performs no insert, head advance, notification invalidation, or audit
write. It returns at most three deterministic, structurally distinct non-primary candidates with an
opaque lowercase SHA-256 `candidateKey`, projected items, totals, fitness, warnings, and differences
from the current plan. Candidate keys bind the canonical planner input and placements; they exclude
generated timestamps and disposable UUIDs. Responses use `Cache-Control: no-store`.

Alternative selection sends the identical request and chosen `candidateKey`, plus an
`Idempotency-Key`. Under the existing workspace/day lock order, the server resolves an earlier
receipt before checking the head, reloads tenant-scoped planner inputs, and recomputes the bounded
candidate set. A missing key returns `409 planning.alternative_stale` without writing. An accepted
choice preserves locked nonterminal anchors, excludes terminal sources, stores exactly one immutable
next revision and `alternative_select` receipt, advances the head once, and invalidates notification
intents for the superseded plan. Exact retries return that recorded revision even after the head has
advanced; semantic key reuse returns `409 planning.idempotency_conflict`.

Routine feedback is a separate plan mutation, not an item activity. Applying feedback posts the same
strict mutation body plus `kind: "not_today" | "not_this_week"` to the item route. The item must be a
pending, unlocked routine; one-time work, locked items, and started or terminal items are rejected.
The server appends an immutable feedback event and immediately allocates and returns the next plan
revision. **Not today** is effective only for the request local date. **Not this week** remains a hard
exclusion through the end of that routine's configured week. The new plan exposes
`feedback_not_today` or `feedback_not_this_week` in its exclusion evidence.

Reset posts the ordinary strict mutation body to the routine reset route. It appends a reset event
and immediately replans; it does not delete the original instruction. Both routes require
`Idempotency-Key`, `expectedPlanId`, `expectedHeadVersion`, and the complete planning request, and use
the same `409 planning.head_conflict` and `planning.idempotency_conflict` behavior as regeneration.
Feedback also has a routine-global optimistic head. If another plan date recorded a newer instruction
for that routine after the source plan was generated, the server returns
`409 planning.feedback_head_conflict` without appending an event or plan revision. This deliberately
prevents an older-date plan from overwriting newer feedback; the caller must use the newer plan date.
An accepted command still replays its original result after the global head advances. Neither route
changes routine cadence or records a completion, skip, deferral, or dismissal.

## Error shape

```json
{
  "error": {
    "code": "cadence.minimum_exceeds_target",
    "message": "Cadence minimum cannot exceed its target."
  },
  "requestId": "req-1"
}
```

Malformed request data returns `400`, a disallowed local product-route Host returns `403`, domain validation returns `422`, absent workspace/work-item/schedule-block/routine/plan resources return `404`, idempotency or version/revision conflicts return `409`, oversized bodies return `413`, rate or concurrency limits return `429`, and unexpected failures return a redacted `500`. Minute-bucket request throttling includes a positive `Retry-After` header; the in-process planning concurrency limit does not promise a retry interval.

## Minimal local flow

Create a workspace:

```powershell
$workspace = Invoke-RestMethod -Method Post -Uri http://127.0.0.1:4000/v1/workspaces `
  -ContentType application/json -Body '{"name":"Personal"}'
```

Create a routine:

```powershell
$routineBody = @{
  title = "Practice Spanish"
  tags = @{ priority = "high"; contexts = @("computer"); categories = @("learning") }
  duration = @{ expectedMinutes = 30 }
  cadence = @{ period = "week"; targetCompletions = 3; maximumCompletions = 4 }
} | ConvertTo-Json -Depth 6

$routine = Invoke-RestMethod -Method Post `
  -Uri "http://127.0.0.1:4000/v1/workspaces/$($workspace.id)/routines" `
  -ContentType application/json -Body $routineBody
```

Pause the routine using optimistic concurrency:

```powershell
$updateBody = @{ expectedVersion = $routine.version; status = "paused" } | ConvertTo-Json
$routine = Invoke-RestMethod -Method Patch `
  -Uri "http://127.0.0.1:4000/v1/workspaces/$($workspace.id)/routines/$($routine.id)" `
  -ContentType application/json -Body $updateBody
```

The database-backed in-process API verification can be run with:

```powershell
pnpm verify:product-api
```
