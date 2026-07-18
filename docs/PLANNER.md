# Deterministic Planner v6

This document describes the first implemented planner contract. The broader product intent remains in [PRODUCT.md](./PRODUCT.md).

## Current implementation

The following Phase 1 capabilities exist in code:

- Reusable routines with structured priority, effort, energy, preference, context, category, and free-form tags
- Explicitly opted-in one-time work items with a positive planning duration, priority, and optional local due date
- Directed same-workspace work-item prerequisites with done-only satisfaction
- Validated duration ranges, optional split sessions, minimum useful session length, and overhead
- Daily, weekly, monthly, and rolling-day cadence policies
- Minimum, target, and maximum completions; spacing; preferred and excluded weekdays; and lifecycle dates
- Append-only activity events with idempotency, occurrence time zone, preserved local civil date, correction references, and completion reversals
- Daily planning requests with both time and task-count bounds, availability windows, context, energy, stable seed, and request revision
- Hard eligibility, explainable integer scoring, seeded weighted exploration, window-capacity fitting, and plan-level fitness
- Canonical input snapshots and SHA-256 hashes for replay
- Versioned algorithm, score configuration, and pseudorandom generator identifiers
- PostgreSQL storage for routines, work items, typed activity history, plans, and typed plan items
- Concrete PostgreSQL repositories for routine creation/loading/versioned updates, idempotent activity append, stable history pagination, and atomic plan revision insertion
- Application use cases for creating, retrieving, listing, and updating routines and work items; listing and recording activity; and generating a workspace/date/revision plan
- A validated, local-only HTTP API for workspaces, routines, activity events, and exact plan revisions
- Stable plan-item identities, an authoritative per-day plan head, and optimistic idempotent item locking
- Immutable regeneration and replacement revisions with exact anchored-item carry-forward
- Plan-item-scoped start, completion, skip, defer, and dismiss actions with projected Today state
- Append-only **Not today** and **Not this week** routine feedback with reset and immediate replanning
- Append-only, resettable explicit routine selection preferences with a bounded future-plan score
- Daily Plan Fit guidance from fully resolved prior plans, with exact-key dismissal/reset, atomic
  explicit-use receipts, and read-only outcome history

The planner is implemented as a pure domain operation in `packages/domain/src/daily-planning.ts`. It does not require PostgreSQL, a network connection, or a language model.

## Civil-time contract

- Each activity event stores both an absolute occurrence instant and the local calendar date observed in its occurrence time zone.
- Historical events retain that local date if the user later changes time zones.
- Cadence periods and spacing are calculated from stored local dates, avoiding 23-hour and 25-hour daylight-saving-day errors.
- Weekdays use `0` for Sunday through `6` for Saturday. The default week starts on Monday.
- `minimumSpacingDays: 1` means one full local date must remain between completions. A Monday completion is therefore ineligible on Tuesday and eligible again on Wednesday.
- `pausedUntil` is inclusive: a routine becomes eligible on the following local date.
- Reaching a target reduces selection weight. Reaching a maximum is a hard exclusion.
- Suggestions, skips, and dismissals do not count as cadence completions.
- A completion reversal removes its referenced completion from derived cadence history without deleting either event.
- **Not today** ends on its request local date. **Not this week** ends on the routine cadence's
  `weekStartsOn` boundary. Neither uses the server's local date or modifies cadence history.

## Planning process

1. Canonically sort routines, opted-in work items, work-item dependency projections, activity events, the latest applicable routine-feedback event per routine, and bounded explicit routine selection preference events.
2. Apply routine exclusions for temporary feedback, lifecycle, dates, weekdays, context, cadence maximum, spacing, consecutive-day prohibition, and minimum duration fit. Apply work-item exclusions when its planning duration is absent, its status is not `backlog`, `planned`, or `in_progress`, any direct prerequisite status is not `done`, or its full duration cannot fit a window. A due date never bypasses these exclusions.
3. Score eligible routines with integer components for priority, cadence deficit, minimum urgency, neglect, preferred weekday, energy/context fit, preference, recent frequency, consecutive-day repetition, skip fatigue, and explicit selection preference. The selection preference uses the latest eight directional events after the latest reset inside the inclusive prior 90 local days, at 100 points per event and clamped to `[-400, 400]`. Score eligible one-time work from explicit priority plus deadline pressure. The default 14-day horizon gives future work a linearly increasing increment as its local due date approaches, gives work due today the `workItemDeadlineDueToday` increment, and gives overdue work a capped increment. A due date outside the horizon adds an explicit zero-pressure explanation. One-time work has no cadence, activity-history, or routine-preference score.
4. Convert the scores to integer selection weights with a nonzero exploration floor.
5. Generate deterministic weighted permutations using the versioned Mulberry32 implementation.
6. Fit each permutation into the available windows without exceeding maximum minutes or task count. Splittable routines may use a shorter session, but never less than their configured minimum; work items use their full planning duration.
7. Rank candidate combinations using task scores, time fit, task-count fit, category diversity, and minimum-bound shortfall penalties.
8. Select from the strongest candidate combinations using the same seeded generator.
9. Return the selected items, score components, explanations, exclusions, warnings, full canonical input snapshot, and replay metadata.

The default search is bounded at 128 eligible candidates and 32 randomized iterations. Applying the candidate limit emits a warning rather than silently presenting the result as exhaustive.
Custom deadline configuration must use a non-negative safe-integer horizon, and its horizon multiplied by the future-per-day weight cannot exceed the planner's 1,000,000-point component bound. This keeps every derived deadline score finite and safely comparable.

## Client-derived calendar availability

`availableWindows` is an explicit caller-owned planning input. The planner never queries schedule
blocks or silently changes the supplied windows. The local Today client offers an opt-in convenience
for the first plan: it subtracts browser-local schedule blocks from one outer range, using half-open
instant intervals, deterministic sorting, clipping, and overlap/adjacency merging. The resulting
non-empty free windows are submitted through the existing multi-window request contract.

Today rereads the relevant calendar day immediately before submission. If the identity, version, or
clipped timing of an affecting block changed, it refreshes the preview and requires a new explicit
submission. Load or validation failure stops generation; turning the option off deliberately returns
to the unchanged manual range. This check reduces stale-calendar mistakes but is not a server lock:
the exact submitted windows remain authoritative if a block changes after the final read.

The accepted request, including its exact derived windows, participates in the canonical snapshot,
input hash, persistence, and replay contract. Replay, regeneration, and replacement do not rederive
availability from later calendar state or mutate an earlier revision. Schedule blocks therefore
remain independent reservations rather than planner candidates or automatic placements.

## Determinism contract

For the same canonical input snapshot, request revision, seed, algorithm version, configuration version, and PRNG version, the planner returns the same item selection and explanations regardless of input array order. Planner algorithm v6 owns the canonical dependency and routine-selection-preference projections and their snapshot and hash semantics. Preference events are tenant/date filtered, ordered by routine then ingestion sequence and ID, reset-trimmed, and bounded before snapshotting. Expired, future, and reset-discarded preference history is hash-neutral. The `default-weights-v4` configuration owns the resulting visible score component.

The generated plan ID and generation timestamp are supplied by the caller when strict byte-for-byte replay is required. The persisted input hash intentionally changes when any input fact changes, even if the final selected items remain the same.

## Persistence and concurrency

The database migration adds:

- `routines`
- `activity_events`
- `daily_plans`
- `daily_plan_items`
- `daily_plan_heads`
- `daily_plan_item_states`
- `work_item_dependencies`
- `plan_interaction_events`
- `plan_mutations`
- `daily_plan_fit_insight_feedback_events`
- `routine_duration_insight_feedback_events`
- `routine_planning_feedback_events`
- `routine_selection_preference_feedback_events`

All planner relationships carry `workspace_id` in their foreign keys. A dependency row has a natural composite key over its workspace, prerequisite, and dependent; tenant-scoped foreign keys on both endpoints cascade when either work item is removed, and a database check rejects self-edges. Activity idempotency is unique within a workspace. Daily plan revisions are unique by workspace and local date. A plan item carries exactly one typed source (`routine` or `work_item`), and a plan cannot repeat the same source or position within one revision. A work item has no global one-plan claim: while eligible, it can appear in later revisions, dates, or sessions until completed, cancelled, or opted out. The unified-candidate migration backfills every legacy plan item and activity as a routine source and rewrites legacy exclusion entries to the same explicit type before typed-source constraints are enforced.

The application port `DailyPlanRepository.insertForRevision` must atomically insert a plan or return the plan already stored for that revision. The use case rejects an existing revision whose input hash differs, preventing a stale request from being mistaken for an idempotent retry.

The PostgreSQL adapter implements this contract with a unique workspace/date/revision constraint and `INSERT ... ON CONFLICT DO NOTHING` inside the unit-of-work transaction. Activity append uses the same pattern with the workspace-scoped idempotency key and rejects reuse of a key for different event content.

Routine selection preference has its own non-negative version head on the routine row, independent
from routine policy version. A workspace/key advisory lock serializes the idempotency identity, then
a routine-row lock fences the expected preference version. The command rechecks for a committed
receipt after any wait before rejecting a stale version. Exact retries therefore return the original
event version without advancing, while semantic key reuse conflicts. Each successful unique append
advances the preference head exactly once in the same transaction. Planner reads use a per-routine
window rank so one noisy routine cannot consume another candidate's bounded event allowance.

PostgreSQL units of work default to serializable isolation and retry serialization failures with
bounded exponential backoff. Operations that first wait on an advisory lock and must observe the
prior lock holder's commit explicitly use read committed; this includes routine policy updates,
duration-insight approval and feedback, routine-planning-feedback mutation, and workspace-scoped
Daily Plan Fit feedback. Routine saves include the expected version in the atomic update predicate.

Dependency edits take a workspace-scoped advisory lock before reading the current graph. Addition
validates both same-tenant endpoints and uses a recursive reachability query to reject direct and
transitive cycles before inserting. Existing-edge addition and absent-edge removal are set-idempotent;
only real changes append `work_item_dependency.added` or `work_item_dependency.removed` audit events.
The graph does not change either work item or its workflow status. Product UUIDs and the workspace
component of the advisory-lock key use canonical lowercase spelling, so equivalent mixed-case UUIDs
cannot split one logical graph or evade self-reference checks.

Generation and regeneration do not take the dependency graph write lock. They retain serializable
isolation and consume one consistent MVCC snapshot of work candidates, prerequisite statuses, edges,
activity, and feedback. A concurrent graph edit therefore linearizes before or after that planning
snapshot like a concurrent work-item edit; an edit whose response completed before planning began is
visible. Planning never combines a new edge with a stale prerequisite status from another snapshot.

The PostgreSQL adapter loads active opted-in work candidates and their relevant dependency and
prerequisite-status rows in one bounded, ordered SQL statement. Feedback and feedback-reset
mutations reuse this correlated loader while retaining their required read-committed transaction, so
candidate eligibility from one statement snapshot cannot be paired with a dependency projection
from another.

The combined loader validates tagged row shape, identities, statuses, dates, self-reference, and
deterministic group/order before returning domain input. Malformed or unordered stored rows fail
closed as `planning.work_item_graph_corrupt`; the product error boundary redacts the message and graph
contents behind `500 internal.unexpected_error` while logging only the stable invariant code.

Local-mode planning reads are bounded to 500 routines, the latest feedback event for at most 500
routines, 5,000 activity events, and 2,000 dependency rows whose dependents are active opted-in
planning candidates, so plan generation cannot hold a database connection over an unbounded in-memory
snapshot. The application requests 2,001 relevant dependencies and fails closed with
`planning.work_item_dependency_pool_too_large` rather than planning from a truncated graph. Edges for
noncandidate dependents remain manageable through the graph API but do not enter the planner
projection. Inactive routines remain in the planner input long enough to produce explicit paused or
archived exclusions.

Each activity append receives a monotonic ingestion sequence after taking a per-source transaction lock, so the application write path cannot commit a lower sequence after a higher one. Existing rows are backfilled deterministically by recording time and ID when this column is introduced. Routine-history pages use the sequence as a newest-first keyset and preserve the first page's high-water mark in an integrity-protected, route-bound cursor, preventing later appends from shifting the remaining traversal. Public activity representations omit idempotency keys.

Database triggers make `activity_events`, `audit_events`,
`daily_plan_fit_insight_feedback_events`, `routine_duration_insight_feedback_events`, and
`routine_planning_feedback_events` append-only and
require corrections and reversals to reference a completion from the same workspace and typed source.
Plan-linked activity takes its source from the referenced plan item rather than trusting a
client-supplied source. A completion may be reversed only once. Explicit local maintenance can set
`schedule.allow_activity_event_mutation`, `schedule.allow_audit_event_mutation`,
`schedule.allow_daily_plan_fit_insight_feedback_event_change`,
`schedule.allow_routine_duration_insight_feedback_event_change`, or
`schedule.allow_routine_planning_feedback_event_change` to `on` within its transaction; routine
application operations do not set these escape hatches. Because an audit row otherwise blocks its
workspace's cascading deletion, tenant erasure must be an explicit maintenance operation. These local
owner-role escape hatches provide operational protection, not an authorization boundary. Hosted
deployment requires separate non-owner runtime and maintenance roles before product routes are
enabled.

The highest generated revision becomes the authoritative per-day head. Plan items expose stable UUIDs, while mutable interaction state is stored separately from immutable plan snapshots. Lock and unlock commands use the current plan ID, an optimistic head version, and a workspace-scoped idempotency key. Each command appends an immutable interaction event; the item-state projection and head version support fast Today reads and stale-client rejection.

Regeneration and replacement take the per-day transaction lock, resolve command idempotency before checking the head, and allocate `current revision + 1` on the server. Retained non-terminal items normally preserve position, window, duration, lock state, and typed source identity. On regeneration, an unlocked work item with a currently unmet prerequisite is removed from retention and excluded from residual selection. A locked nonterminal item remains anchored under the existing user-authority rules; terminal items remain excluded under the existing replan rules. Retained items' occupied time and source identities are removed from the residual planner input. Replacement anchors every sibling and excludes the target source. The resulting snapshot hashes the source plan, anchors, exclusions, canonical dependency projections, and residual planner input; the source revision is never mutated. Adding or removing an edge alone never changes the current revision or Today head.

Temporary routine feedback uses the same per-day transaction lock, optimistic plan/head identity,
workspace-and-date-scoped idempotency ledger, and immutable revision path. Applying feedback is limited to an
unlocked, pending routine plan item; work items and terminal or started routine items are rejected.
The command appends `not_today` or `not_this_week`, removes the source item from the anchors, and
replans immediately with explicit `feedback_not_today` or `feedback_not_this_week` exclusion
evidence. The weekly end date is derived from the routine's `weekStartsOn` value. Reset appends its
own event and immediately replans; because the latest applicable event wins, reset does not delete
history and an older suppression cannot reappear. Feedback never appends an activity event, changes
cadence, or counts as completion history.

Because feedback is routine-global while plan heads are per date, each plan snapshot also acts as the
routine feedback head it observed. Feedback mutations take a routine-scoped advisory lock and use
read-committed statement snapshots so a commit made while waiting is visible. The newest persisted
`(ingestedSequence, id)` tuple must equal the source snapshot's tuple before append; otherwise the
command returns `planning.feedback_head_conflict` with no write. The persisted head lookup is
intentionally not date-bounded: once a newer-date instruction exists, an older-date plan cannot
retroactively overwrite it, even after that older plan is refreshed. Idempotent receipt resolution
runs before this comparison, so an already accepted older command still replays its original result.

Today item actions use the same per-day lock, current plan identity, head version, and workspace-scoped idempotency ledger. Each accepted action appends an activity event attributed to the exact typed plan source, advances the head, and transactionally updates a fast item-state projection. Pending items may be started or made terminal; started items may be completed, skipped, deferred, or dismissed; terminal items reject further transitions. A completion reversal is the narrow audited exception and reopens the item as pending; for routines it removes the completion from later cadence calculations. Completing a work-derived item marks only `backlog`, `planned`, or `in_progress` source work `done` and records the prior status plus completion ownership version in immutable event metadata. Reversal restores that prior status only when the work item still has the completion's expected version and `done` status; a later accepted completion or edit is never clobbered. This does not auto-regenerate the plan. The append-only activity record is the planner input, while the projection exists only for fast Today reads.

## Daily Plan Fit guidance

Daily Plan Fit is a read-only, deterministic interpretation of resolved plan history. For an
explicit local `forDate`, it considers current plan heads from the preceding 90 local dates. A plan
is an eligible sample only when it is nonempty and every item is terminal: completed, skipped,
deferred, or dismissed. Pending or started work excludes the whole plan from the sample. Completed
workload uses each completed item's scheduled minutes and item count; skips, deferrals, and
dismissals close the plan but contribute zero completed workload. The calculation uses the 28 most
recent eligible samples from a repository query bounded to 90 candidate heads, fails closed above
512 items in any head or the corresponding total row ceiling, and requires at least three.

The calculation takes half-up medians of planned minutes, completed minutes, planned task count, and
completed task count. A proposed minute target is the smaller of the planned median and the completed
median rounded to the nearest 15 minutes with a floor of 30. A proposed task target is the smaller
of the planned median and completed median with a floor of one. Guidance is `suggested` only when at
least one target decreases materially: the minute gap is at least the larger of 30 minutes or 20%
of the planned median rounded up to 15, or the task gap is at least the larger of one task or 25% of
the planned median rounded up. Otherwise the result is `aligned`; fewer than three samples yields
`insufficient_history`. Version 1 deliberately never recommends an increase.

An actionable pair receives a lowercase SHA-256 key over the calculation/policy version, requested
date and evidence window, and canonical selected evidence including terminal activity identities.
Evaluation time and repository order do not participate. The latest append-only `dismissed` or
`reset` event for the exact workspace and key projects the suggestion as hidden or available.
Feedback takes a lowercase-canonical workspace advisory lock under read committed isolation, so
equivalent UUID casing cannot split serialization. After the advisory lock, the repository touches
the existing workspace row as a physical SSI guard. A serializable keyed generation that began and
waited before a dismissal committed therefore receives `40001`, retries with a fresh snapshot, and
observes the winning disposition. Feedback resolves exact idempotent replay first and recalculates
the evidence before append. Changed evidence returns
`daily_plan_fit_insight.evidence_conflict`; semantic key reuse and invalid disposition transitions
also fail without a write. New resolved evidence produces a new key and can therefore surface a new
suggestion without deleting the user's earlier feedback.

Selecting **Use** still performs no write. The local Today interface only copies the suggested pair
into the two editable target fields. If the user later submits the initial generation form, the
request may carry that exact evidence key alongside the final user-edited targets. Inside the same
serializable transaction as revision-1 creation, generation locks the day and the workspace feedback
stream, recomputes current bounded evidence, and requires the key to remain an available suggestion.
Stale evidence returns `daily_plan_fit_insight.evidence_conflict` before either the plan or a usage
event is stored.

Successful explicit generation appends one immutable `used` event atomically with the plan. It keeps
the reviewed medians and suggested pair, the generated plan identity, and the actual submitted target
minutes and task count. The deterministic receipt key is derived from the plan ID; exact revision
retry must find an identical receipt and returns the same plan without adding another event. A `used`
event does not dismiss the still-current suggestion and never edits cadence, eligibility, scoring,
selection, or an existing plan head.

The bounded usage-history projection reads at most 28 newest `used` events and bulk-joins the current
plan head for their dates. It reports `pending` while any current item is nonterminal, `resolved` only
after every current item is terminal, and `not_evaluable` when no nonempty current plan exists.
Resolved completion counts and scheduled minutes include only completed items; partial completion is
withheld. The projection preserves suggested-versus-applied targets and flags when the current plan
is a later revision than the plan that recorded the use. It is descriptive, read-only history: it is
not an acceptance score, causal effectiveness claim, planner input, or learned policy.

A separate bounded effectiveness projection aggregates at most the 28 newest outcomes without
exposing dates, usage IDs, evidence keys, or task content. It partitions every explicit use by status
and exact-versus-edited submission, counts later revisions separately, and admits only resolved,
unrevised current heads to weighted totals. **Target scheduled** is scheduled workload divided by the
submitted editable target; **Plan completed** is completed workload divided by scheduled workload.
Minute and task rates remain separate, use half-up integer basis points, and are unavailable without
an eligible denominator. Today withholds rate display until three settled, unrevised uses are
available. Per-plan percentages are never averaged. The projection is a descriptive
read model only: no value flows into eligibility, ranking, target generation, a model prompt, or
automatic adaptation, and it cannot establish that Plan Fit caused an outcome.

No language model, Hermes adapter, or provider participates in the calculation, usage receipt, or
outcome projection. Automatic application, generation, target changes, and outcome-driven adaptation
remain outside this boundary.

## Planning outcomes

Planning outcomes is a read-only workspace summary for an explicit local `forDate`. It reuses the
authoritative current-plan projection for each of the preceding 30 local dates and counts at most one
final head per date. Every item contributes its scheduled minutes and one task to the planned totals;
only items whose current activity state is `completed` contribute to completed totals. Empty plan
heads still count as plan days but add no workload.

The two completion rates divide weighted completed totals by weighted planned totals and use half-up
integer basis points. A rate is unavailable when its denominator is zero; Today withholds both rates
until three prior plan days exist. The summary also adds `requestRevision - 1` across the current
heads and labels the result **additional plan revisions**. That count is not a replacement-frequency
or causality claim.

The read writes no telemetry, activity, plan, or model state and never enters planner scoring,
guidance, prompts, or automatic adaptation. It uses scheduled rather than stopwatch duration and may
span planner versions, so it is a compact description of current local history—not an algorithm
comparison or claim that the planner improved an outcome.

## Duration-calibration boundary

Routine-duration calibration is a read-only interpretation of activity history, not another planner
mutation. It derives a median from corrected, non-reversed routine completions in the inclusive
trailing 90 days and requires three samples before exposing an observed value. A material median
inside the routine's configured range may be offered as a suggestion; an out-of-range median requires
manual range review.

Only the dedicated approval command treats a suggested median as approved. Inside one read-committed
unit of work, it acquires the same per-routine advisory lock used by activity appends before reloading
the current routine and bounded 90-day evidence, verifies the expected routine version, recomputes the
suggestion, and saves only if the requested expected duration is still supported. The request carries
the complete duration policy, but its minimum, maximum, splitting,
minimum-session, and overhead values must equal the current user-owned settings. Concurrent routine
changes fail with `routine.version_conflict`; a completion, correction, or reversal that changes the
supported suggestion fails with `routine_duration_insight.evidence_conflict`.

Read committed is intentional for lock-coordinated duration commands: every routine and evidence
statement after an advisory-lock wait sees commits made by the earlier lock holder. Generic routine
updates take the same lock and isolation before reading and saving the versioned routine, preventing a
manual edit from racing an approval, dismissal, reset, or activity append. Product units of work that
do not require this lock retain serializable isolation by default.

The generic routine `PATCH` remains a manual edit and is not an insight-approval path. Approval does
not rewrite an existing plan or advance its Today head. The current plan therefore retains the
duration selected when its immutable revision was generated; a later explicit generation or
regeneration may consume the newly approved routine estimate. Neither insight path calls Gemma,
Hermes, or any other advisor or integration.

Duration-insight dismissal is also outside the planner. An actionable `suggested` or `review_range`
insight has a SHA-256 key over its calculation policy, relevant duration policy, and canonical
completion, correction, and reversal evidence. The latest append-only `dismissed` or `reset` event
for that exact workspace, routine, and key projects the insight as `dismissed` or `available`.
Workspace-scoped idempotency makes exact command retry return the original event and rejects semantic
key reuse. Changed evidence or relevant policy produces a different insight key and therefore
resurfaces a still-actionable recommendation as available.

Dismiss and reset revalidate the current routine version and insight before appending feedback, but
they do not save the routine, approve or change a duration, mutate an existing plan or Today head,
generate a plan revision, or enter the planner snapshot. They cannot affect eligibility, scoring,
selection, cadence, or activity history.

## Local-advisor boundary

The optional local-model advisor reviews a completed current-plan projection; it is not a planner
stage and does not receive or produce planner input. Its provider-neutral application port receives
no repositories, unit of work, plan commands, or mutation service. The supplied context contains a
bounded sanitized view of the current plan plus active opted-in backlog candidates whose direct
prerequisites are all `done`, not routine history, the persisted planner input snapshot, random seed,
calendar blocks, or a dedicated/free-form model instruction. Candidate work, dependency edges, and
prerequisite statuses use the same bounded statement projection. User-authored titles are included
only as bounded untrusted data.

Schedule builds the initial context in a short read-only unit of work and closes it before invoking
the provider. The Ollama adapter performs one bounded direct loopback request. If output passes its
versioned schema, canonical-text, target-membership, and duplicate checks, the application opens a
second short read-only unit of work and rebuilds the exact same context and dependency fingerprint. A
plan-head, backlog, dependency, or prerequisite-status change produces `advisor.snapshot_conflict`,
including a dependency change that leaves visible membership unchanged; no stale advice is returned.

Advice can refer only to supplied plan items, supplied backlog items, or the plan as a whole. It
cannot change hard constraints, eligibility, scoring, selection, fit, capacity, cadence, feedback,
duration policy, activity history, random seed, or the authoritative head. It creates no plan
revision or persistent event and exposes no Apply operation. Disabled or failed inference returns an
unavailable review state while the deterministic plan remains fully usable and unchanged. Duration
calibration never calls the advisor.

Run the database-backed vertical-slice verification while PostgreSQL is available:

```powershell
pnpm verify:planner-db
```

## Deliberately deferred

- Authentication, authorization, and public network exposure
- Exact start-time placement within a selected window
- Alternative-plan branching and multi-step undo workflows
- Learned cadence, preference, energy, and adaptive-selection adjustments
- Automatic Plan Fit application, upward target expansion, user-editable Plan Fit policy, and
  outcome-driven learning
- Automatic duration-insight application and historical insight comparison
- User-editable scoring profiles
- Natural-language creation, model-driven calibration or plan application, and hosted model advisors
- Cross-device synchronization

These are later layers over the deterministic contract and should not weaken its hard constraints or offline fallback.
