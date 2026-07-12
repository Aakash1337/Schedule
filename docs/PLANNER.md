# Deterministic Planner v1

This document describes the first implemented planner contract. The broader product intent remains in [PRODUCT.md](./PRODUCT.md).

## Current implementation

The following Phase 1 capabilities exist in code:

- Reusable routines with structured priority, effort, energy, preference, context, category, and free-form tags
- Validated duration ranges, optional split sessions, minimum useful session length, and overhead
- Daily, weekly, monthly, and rolling-day cadence policies
- Minimum, target, and maximum completions; spacing; preferred and excluded weekdays; and lifecycle dates
- Append-only activity events with idempotency, occurrence time zone, preserved local civil date, correction references, and completion reversals
- Daily planning requests with both time and task-count bounds, availability windows, context, energy, stable seed, and request revision
- Hard eligibility, explainable integer scoring, seeded weighted exploration, window-capacity fitting, and plan-level fitness
- Canonical input snapshots and SHA-256 hashes for replay
- Versioned algorithm, score configuration, and pseudorandom generator identifiers
- PostgreSQL storage for routines, activity history, plans, and plan items
- Concrete PostgreSQL repositories for routine creation/loading/versioned updates, idempotent activity append, stable history pagination, and atomic plan revision insertion
- Application use cases for creating, retrieving, listing, and updating routines; listing and recording activity; and generating a workspace/date/revision plan
- A validated, local-only HTTP API for workspaces, routines, activity events, and exact plan revisions
- Stable plan-item identities, an authoritative per-day plan head, and optimistic idempotent item locking
- Immutable regeneration and replacement revisions with exact anchored-item carry-forward
- Plan-item-scoped start, completion, skip, defer, and dismiss actions with projected Today state

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

## Planning process

1. Canonically sort routines and activity events.
2. Apply hard exclusions for lifecycle, dates, weekdays, context, cadence maximum, spacing, consecutive-day prohibition, and minimum duration fit.
3. Score eligible routines with integer components for priority, cadence deficit, minimum urgency, neglect, preferred weekday, energy/context fit, preference, recent frequency, consecutive-day repetition, and skip fatigue.
4. Convert the scores to integer selection weights with a nonzero exploration floor.
5. Generate deterministic weighted permutations using the versioned Mulberry32 implementation.
6. Fit each permutation into the available windows without exceeding maximum minutes or task count. Splittable routines may use a shorter session, but never less than their configured minimum.
7. Rank candidate combinations using task scores, time fit, task-count fit, category diversity, and minimum-bound shortfall penalties.
8. Select from the strongest candidate combinations using the same seeded generator.
9. Return the selected items, score components, explanations, exclusions, warnings, full canonical input snapshot, and replay metadata.

The default search is bounded at 128 eligible candidates and 32 randomized iterations. Applying the candidate limit emits a warning rather than silently presenting the result as exhaustive.

## Determinism contract

For the same canonical input snapshot, request revision, seed, algorithm version, configuration version, and PRNG version, the planner returns the same item selection and explanations regardless of input array order.

The generated plan ID and generation timestamp are supplied by the caller when strict byte-for-byte replay is required. The persisted input hash intentionally changes when any input fact changes, even if the final selected items remain the same.

## Persistence and concurrency

The database migration adds:

- `routines`
- `activity_events`
- `daily_plans`
- `daily_plan_items`
- `daily_plan_heads`
- `daily_plan_item_states`
- `plan_interaction_events`
- `plan_mutations`

All planner relationships carry `workspace_id` in their foreign keys. Activity idempotency is unique within a workspace. Daily plan revisions are unique by workspace and local date. Plan items cannot repeat a routine or position within one plan.

The application port `DailyPlanRepository.insertForRevision` must atomically insert a plan or return the plan already stored for that revision. The use case rejects an existing revision whose input hash differs, preventing a stale request from being mistaken for an idempotent retry.

The PostgreSQL adapter implements this contract with a unique workspace/date/revision constraint and `INSERT ... ON CONFLICT DO NOTHING` inside the unit-of-work transaction. Activity append uses the same pattern with the workspace-scoped idempotency key and rejects reuse of a key for different event content.

PostgreSQL units of work run at serializable isolation and retry serialization failures up to twice. Routine saves include the expected version in the atomic update predicate. Local-mode planning reads are bounded to 500 routines and 5,000 activity events so plan generation cannot hold a database connection over an unbounded in-memory snapshot. Inactive routines remain in the planner input long enough to produce explicit paused or archived exclusions.

Each activity append receives a monotonic ingestion sequence after taking a per-routine transaction lock, so the application write path cannot commit a lower sequence after a higher one. Existing rows are backfilled deterministically by recording time and ID when this column is introduced. Routine-history pages use the sequence as a newest-first keyset and preserve the first page's high-water mark in an integrity-protected, route-bound cursor, preventing later appends from shifting the remaining traversal. Public activity representations omit idempotency keys.

Database triggers make `activity_events` and `audit_events` append-only and require corrections and reversals to reference a completion from the same workspace and routine. A completion may be reversed only once. Explicit local maintenance can set `schedule.allow_activity_event_mutation` or `schedule.allow_audit_event_mutation` to `on` within its transaction; routine application operations do not set these escape hatches. Because an audit row otherwise blocks its workspace's cascading deletion, tenant erasure must be an explicit maintenance operation. These local owner-role escape hatches provide operational protection, not an authorization boundary. Hosted deployment requires separate non-owner runtime and maintenance roles before product routes are enabled.

The highest generated revision becomes the authoritative per-day head. Plan items expose stable UUIDs, while mutable interaction state is stored separately from immutable plan snapshots. Lock and unlock commands use the current plan ID, an optimistic head version, and a workspace-scoped idempotency key. Each command appends an immutable interaction event; the item-state projection and head version support fast Today reads and stale-client rejection.

Regeneration and replacement take the per-day transaction lock, resolve command idempotency before checking the head, and allocate `current revision + 1` on the server. Retained items preserve position, window, duration, and lock state. Their occupied time and routine identities are removed from the residual planner input. Replacement anchors every sibling and excludes the target routine. The resulting snapshot hashes the source plan, anchors, exclusions, and residual planner input; the source revision is never mutated.

Today item actions use the same per-day lock, current plan identity, head version, and workspace-scoped idempotency ledger. Each accepted action appends an activity event attributed to the exact plan item, advances the head, and transactionally updates a fast item-state projection. Pending items may be started or made terminal; started items may be completed, skipped, deferred, or dismissed; terminal items reject further transitions. A completion reversal is the narrow audited exception and reopens the item as pending while removing that completion from later cadence calculations. This does not auto-regenerate the plan. The append-only activity record is the planner input, while the projection exists only for fast Today reads.

Run the database-backed vertical-slice verification while PostgreSQL is available:

```powershell
pnpm verify:planner-db
```

## Deliberately deferred

- Authentication, authorization, and public network exposure
- Selecting ordinary Work-board items as planner candidates; planner v1 selects routines only
- Exact start-time placement within a selected window
- Alternative-plan branching and multi-step undo workflows
- Work-item deadlines and dependency integration
- Learned duration and preference adjustments
- User-editable scoring profiles
- Local Gemma/Ollama or hosted model advisors
- Cross-device synchronization

These are later layers over the deterministic contract and should not weaken its hard constraints or offline fallback.
