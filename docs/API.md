# Local Product API

The local product API exposes the deterministic planner without committing the project to a frontend or cloud authentication design. It is available under `/v1` when `PRODUCT_API_MODE=local_unauthenticated`.

This document describes the loopback product surface. Trusted machine callers use the separately
authenticated [inbound integration gateway](./INTEGRATIONS.md); its workspace-scoped credentials do
not authorize these product routes.

## Safety boundary

- Development defaults to `local_unauthenticated` and binds to `127.0.0.1`.
- Production is always `disabled`; configuration rejects attempts to enable unauthenticated routes in production or on a non-loopback application bind.
- This mode must not be exposed to an untrusted network. Authentication and authorization are required before public hosting.
- CORS is disabled, JSON bodies are limited to 256 KiB, request objects reject unknown fields, and error responses do not include stack traces.
- Product routes reject missing, malformed, or non-loopback `Host` authorities before routing. This protects the unauthenticated loopback service from browser DNS-rebinding attacks; `localhost`, IPv4 `127.0.0.0/8`, and IPv6 loopback (`[::1]`) are accepted with an optional valid port. Health and system-information endpoints remain outside this product-route guard for local process and container diagnostics.
- Product routes are limited to 240 requests per minute per source address and two concurrent plan generations per API process.
- Local mode caps an installation at 20 workspaces; each workspace is capped at 500 routines, 5,000 activity events, 2,000 plan revisions, and 50 revisions for one date.
- Plan responses expose the original planning request, input hash, and algorithm versions, but not routine snapshots or activity history from the complete persisted input snapshot.

## Routes

| Method   | Route                                                                                          | Result                                           |
| -------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `POST`   | `/v1/workspaces`                                                                               | Create a workspace (`201`)                       |
| `GET`    | `/v1/workspaces`                                                                               | List local workspaces                            |
| `GET`    | `/v1/workspaces/{workspaceId}`                                                                 | Retrieve one workspace                           |
| `POST`   | `/v1/workspaces/{workspaceId}/work-items`                                                      | Create a backlog/Kanban item (`201`)             |
| `GET`    | `/v1/workspaces/{workspaceId}/work-items`                                                      | List a bounded work-item page                    |
| `GET`    | `/v1/workspaces/{workspaceId}/work-items/{workItemId}`                                         | Retrieve one work item                           |
| `PATCH`  | `/v1/workspaces/{workspaceId}/work-items/{workItemId}`                                         | Version-checked work-item update                 |
| `POST`   | `/v1/workspaces/{workspaceId}/schedule-blocks`                                                 | Create a calendar block (`201`)                  |
| `GET`    | `/v1/workspaces/{workspaceId}/schedule-blocks?from={instant}&to={instant}`                     | List blocks overlapping a bounded range          |
| `GET`    | `/v1/workspaces/{workspaceId}/schedule-blocks/{scheduleBlockId}`                               | Retrieve one calendar block                      |
| `PATCH`  | `/v1/workspaces/{workspaceId}/schedule-blocks/{scheduleBlockId}`                               | Version-checked calendar-block update            |
| `DELETE` | `/v1/workspaces/{workspaceId}/schedule-blocks/{scheduleBlockId}`                               | Version-checked audited deletion (`204`)         |
| `POST`   | `/v1/workspaces/{workspaceId}/routines`                                                        | Create a routine (`201`)                         |
| `GET`    | `/v1/workspaces/{workspaceId}/routines?status=active&limit=100&offset=0`                       | List a bounded routine page (`200`)              |
| `GET`    | `/v1/workspaces/{workspaceId}/routines/{routineId}`                                            | Retrieve one routine (`200` or `404`)            |
| `PATCH`  | `/v1/workspaces/{workspaceId}/routines/{routineId}`                                            | Version-checked partial update (`200` or `409`)  |
| `GET`    | `/v1/workspaces/{workspaceId}/routines/{routineId}/duration-insight`                           | Derive a read-only insight (`200` or `404`)      |
| `POST`   | `/v1/workspaces/{workspaceId}/routines/{routineId}/duration-insight/approve`                   | Atomically approve an insight (`200` or `409`)   |
| `POST`   | `/v1/workspaces/{workspaceId}/routines/{routineId}/duration-insight/dismissals`                | Dismiss one exact insight (`200` or `409`)       |
| `POST`   | `/v1/workspaces/{workspaceId}/routines/{routineId}/duration-insight/dismissal-resets`          | Restore one exact insight (`200` or `409`)       |
| `GET`    | `/v1/workspaces/{workspaceId}/routines/{routineId}/activity-events`                            | List stable, cursor-paginated history (`200`)    |
| `POST`   | `/v1/workspaces/{workspaceId}/routines/{routineId}/activity-events`                            | Idempotently record activity (`200`)             |
| `POST`   | `/v1/workspaces/{workspaceId}/plans`                                                           | Create revision 1 or retry an exact revision     |
| `GET`    | `/v1/workspaces/{workspaceId}/plans/{YYYY-MM-DD}?revision=1`                                   | Retrieve an exact revision (`200` or `404`)      |
| `GET`    | `/v1/workspaces/{workspaceId}/plans/{YYYY-MM-DD}/current`                                      | Retrieve the current Today plan and head version |
| `PATCH`  | `/v1/workspaces/{workspaceId}/plans/{YYYY-MM-DD}/items/{itemId}/lock`                          | Idempotently lock or unlock a current plan item  |
| `POST`   | `/v1/workspaces/{workspaceId}/plans/{YYYY-MM-DD}/items/{itemId}/activity-events`               | Record a current item action                     |
| `POST`   | `/v1/workspaces/{workspaceId}/plans/{YYYY-MM-DD}/regenerations`                                | Regenerate around locked items                   |
| `POST`   | `/v1/workspaces/{workspaceId}/plans/{YYYY-MM-DD}/items/{itemId}/replacement`                   | Replace one unlocked item                        |
| `POST`   | `/v1/workspaces/{workspaceId}/plans/{YYYY-MM-DD}/items/{itemId}/routine-feedback`              | Suppress one pending routine and replan          |
| `POST`   | `/v1/workspaces/{workspaceId}/plans/{YYYY-MM-DD}/routines/{routineId}/routine-feedback-resets` | Reset routine feedback and replan                |

Activity requests require an `Idempotency-Key` header containing 1–160 characters. Reusing a key with identical event content returns the original event. Reusing it for different content returns `409 activity.idempotency_conflict`. Public event responses omit the key because the caller already owns it and it is retry metadata, not activity history.

Work items provide the initial backlog and status-column Kanban model through `backlog`, `planned`, `in_progress`, `blocked`, `done`, and `cancelled`. `planningDurationMinutes` is nullable: `null` keeps normal work out of Today, while a positive value (up to 43,200) opts it into the planner. `dueOn` is independently nullable and, when present, must be a strict real Gregorian `YYYY-MM-DD` local date. Create may omit it or send `null`; update omission preserves it, while update `null` clears it. Only opted-in `backlog`, `planned`, and `in_progress` work is eligible, and a due date never overrides status, duration, window, time-budget, or task-count constraints. List requests accept optional `status` and `priority` filters plus `limit` from 1–200 and `offset` from 0–1,000,000. Ordering is stable by creation time and ID. Updates require `expectedVersion`, increment exactly once for a real semantic change, and preserve the version for a normalized no-op. Work-item hard deletion and manual card ranking are not part of this MVP surface; cancellation is the removal workflow, and clients group items by status. A completion from a stale plan never auto-transitions `blocked` or `cancelled` work to `done`.

Schedule-block range reads require offset-bearing `from` and `to` instants, use half-open overlap (`startsAt < to` and `endsAt > from`), and accept ranges no longer than 93 days with the same bounded pagination convention. Absolute instants remain authoritative when `timeZone` changes. A block may reference a work item from the same workspace, but their lifecycles remain independent. Create and update validate the workspace and optional link. Update and deletion require `expectedVersion`; deletion returns `204` and appends an immutable audit snapshot in the same transaction. Recurrence authoring, conflict detection, and automatic placement are deferred.

Routine updates require `expectedVersion`. Scalar fields are partial; if `tags`, `duration`, or `cadence` is supplied, that nested object is a complete replacement. A real change increments the routine version once. A semantic no-op returns the current routine without writing or incrementing its version. A stale version returns `409 routine.version_conflict`. The update takes the same per-routine advisory lock used by activity and duration-insight commands, then reloads and saves under read committed so a manual edit cannot race an approval, dismissal, reset, or evidence append. This generic `PATCH` is still the manual editing path; it does not assert that a duration-insight suggestion is current.

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

Routine activity history is ordered by newest ingestion first and accepts `limit` from 1–200 (default 50) plus an opaque, integrity-protected `cursor`. The cursor is bound to its workspace and routine. The first page captures a high-water mark, so later appends do not shift subsequent pages. A non-null `page.nextCursor` retrieves the next page. Local cursor signing keys are process-bound, so clients should restart pagination after an API restart.

A plan is identified by workspace, real Gregorian local date, and positive request revision. Generic `POST /plans` creates only the initial revision 1. It may also retry an already persisted exact generic revision: the server recomputes the deterministic input and returns the persisted plan when the input hash is unchanged. Planner input includes routines, opted-in eligible work items, activity history, and canonical routine planning feedback. If any input has changed, retrying that revision returns `409 planning.revision_conflict`.

Generic generation never allocates a later revision. A missing revision greater than 1, or any new generic revision after a current head exists, returns `409 planning.revision_creation_conflict`. Clients must use regeneration or replacement with the current plan identity, head version, and an idempotency key; those mutation endpoints allocate the next revision atomically and preserve the Today interaction contract. Mutation retries must return to the original mutation endpoint with the same idempotency key.

Every plan item has a stable UUID, a typed source identity (`sourceType` plus exactly one of `routineId` or `workItemId`), and a projected `locked` flag. The current-plan response adds `headVersion`. Lock changes require an `Idempotency-Key` plus `expectedPlanId` and `expectedHeadVersion`; stale state returns `409 planning.head_conflict`. Identical retries return the original result, while key reuse for another command returns `409 planning.idempotency_conflict`. Lock and unlock facts are append-only even though the current flag is projected for efficient reads.

Current plan items also expose `activityState`, `lastActivityEventId`, and `activityUpdatedAt`. An item activity request uses the same optimistic identity and idempotency requirements as locking, and supports `started`, `completed`, `skipped`, `deferred`, `dismissed`, or `completion_reversed`. A pending item may enter any direct action state; a started item may enter any terminal state. Terminal states cannot transition again, except that reversing a completion reopens it as pending. Only completion may include an actual `durationMinutes`. The resulting activity event records the plan, plan item, and typed source identity, advances the Today head once, and feeds later planner history. Completing a work-derived item marks its source work item `done` only from an active work status. Its reversal restores the saved prior status only if no later accepted completion or work-item edit has advanced the completion ownership version; otherwise the newer state wins unchanged. Lock state remains independent, and an action does not automatically regenerate the plan.

Generic routine activity may still be recorded outside a plan. Item completion reversal uses the item endpoint so its append-only event, Today projection, conditional work-status restoration, and head version change atomically; generic reversal remains appropriate for routine activity recorded outside a plan.

Regeneration and replacement require the same optimistic identity and idempotency header plus a complete planning request with a new seed. The server allocates the next revision. Regeneration carries locked non-terminal items exactly and plans only residual capacity. Replacement anchors every sibling, rejects a locked target, excludes the removed typed source, and fills the released capacity. Terminal sources are not replanned. Prior revisions remain immutable and mutation provenance is retained for replay. A retry resolves to the same immutable plan revision and recorded head version; its projected lock and activity fields reflect the latest state for that revision.

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
