# Adaptive Scheduling System — Product Specification

Status: Working product definition
Last updated: 2026-07-15

Implementation note: deterministic Phase 1 is implemented across the domain, application use cases, PostgreSQL adapters, schema, migrations, unit tests, and seeded simulation coverage. Phase 2 now includes stable typed plan-item identities, an authoritative Today-plan head, audited lock and activity state, immutable regeneration/replacement and alternative-selection revisions, deterministic read-only comparison of up to three distinct alternatives, routine-only **Not today** and **Not this week** feedback, status-based backlog/Kanban work items with direct prerequisites and arbitrary-depth subtasks, bounded non-recurring calendar-block management, opt-in calendar-aware first-plan availability, and a responsive local web interface. Planner v6 selects both reusable routines and explicitly opted-in one-time leaf work items, applies temporary routine feedback and explicit bounded routine selection preferences, and hard-excludes parent containers and work with unmet prerequisites from new selection and unlocked regeneration retention. A locked nonterminal item remains anchored under the existing user-authority rules. The planner also adds transparent deadline pressure for eligible work. Phase 3 now includes a transparent routine-duration insight with explicit approval, evidence-backed Daily Plan Fit guidance with explicit use receipts and read-only outcome history, and reversible user-authored routine ranking preferences; none applies automatically, and the descriptive history does not enter planner scoring. Broader inferred preferences and automatic adaptation remain deferred. Phase 4 now has an opt-in, read-only local advisor behind a provider-neutral application port: the Today interface can ask an allowlisted local Gemma model through Ollama for bounded structured suggestions, but neither the provider nor its output can mutate or replace the deterministic plan. The Work interface may separately prepare one expiring, editable backlog-title proposal from free-form text; no work exists until explicit, audited, exactly-once confirmation. A provider-neutral authenticated gateway provides Today reads, credential-scoped work-item discovery including hierarchy, reviewed create/reparent/detach mutations, and least-privilege reminder delivery claims/receipts for future agents. The secure outbound substrate supports operator-queued tests and an explicit opt-in, privacy-thin `schedule.changed.v1` invalidation without schedule content. A deterministic reminder-policy core stores versioned profiles and rules, explicit one-offs, concurrency-safe immutable intents, an opt-in local periodic materializer, and a provider-neutral fenced delivery lifecycle without performing provider transport. See [API.md](./API.md), [NATURAL_LANGUAGE.md](./NATURAL_LANGUAGE.md), [REMINDERS.md](./REMINDERS.md), [WEB.md](./WEB.md), [INTEGRATIONS.md](./INTEGRATIONS.md), and [WEBHOOKS.md](./WEBHOOKS.md). Natural-language routine creation, model-driven task breakdown, multi-command capture, automatic advisor application or calibration, hosted model providers, generalized undo, recurrence authoring, phone delivery, a Hermes/WhatsApp transport, and public hosting remain deferred.

The local reminder interface now configures profiles, rules, and one-offs; manually materializes
intents; and presents separate planned and product-safe execution histories. An operator may also
enable background intent materialization. Neither path implies that an external provider sent a
message.

Separately, an opt-in local Hermes plugin calls the authenticated read/write gateway, binds a later
confirmation turn to the same sender/session/platform identity, and includes a deterministic stdout
Today helper. It does not make the provider-neutral delivery runtime or live WhatsApp delivery
complete. See [HERMES.md](./HERMES.md).

## 1. Product summary

The target application combines conventional task and schedule management with an adaptive daily
planner. The current local MVP supports ordinary one-time work, a status-based board, bounded
non-recurring calendar blocks, and a pool of reusable routines from which it generates a practical
daily plan. Projects and the broader conventional feature set in section 12 remain product targets.

The planner considers both the user's available time and desired number of tasks. It uses explicit rules, completion history, and controlled randomness to balance priority, cadence, variety, urgency, effort, and personal context. An optional local language model may review a completed plan snapshot, but the deterministic scheduling engine remains authoritative.

## 2. Product principles

1. **Useful over theoretically optimal.** Plans should be realistic enough to complete.
2. **Explainable by default.** Every recommendation should have a human-readable reason.
3. **User authority.** The user can lock, replace, defer, dismiss, or manually add anything.
4. **Controlled variety.** Randomness prevents monotony without ignoring commitments.
5. **Graceful adaptation.** The system learns gradually, visibly, and reversibly.
6. **Local-first operation.** Core planning must work offline and without an AI model.
7. **Provider independence.** Local and hosted deployments should share the same domain model.
8. **Privacy by design.** An advisor receives only the minimum context required.

## 3. Core concepts

### 3.1 Work item

A normal, actionable unit of work. It may belong to a project, appear on a Kanban board, have an optional local due date, or remain in a backlog. `dueOn` is either `null` or a real Gregorian `YYYY-MM-DD` local date, not an instant or time-zone conversion. A work item remains off the automatic planner unless it has an explicit positive **planning duration**. An opted-in item is one-time work: it may appear at most once in a plan and may be selected again in later plan revisions, dates, or sessions until it is completed, cancelled, or opted out. It is not a recurring routine.

### 3.1.1 Work-item prerequisite

A direct prerequisite is a directed, same-workspace edge from a dependent work item to another work
item that must be `done` before the dependent can be newly selected for Today. The edge is separate
from workflow status: adding an unmet prerequisite does not change the dependent to `blocked`, and
completing or reopening either item never changes the other item's status. A prerequisite in any
status other than `done`, including `cancelled`, remains unsatisfied.

The graph rejects self-reference and any edge that would create a direct or transitive cycle. Add and
remove use set semantics: adding an existing edge returns it without creating another row, and
removing an absent edge succeeds without side effects. Every endpoint and foreign key keeps both
work items inside the same workspace. A workspace-scoped graph lock serializes cycle validation and
mutation so concurrent additions cannot jointly create a cycle. Product UUIDs are canonicalized to
lowercase before dispatch and lock-key derivation, while the domain also treats mixed-case spellings
of one persisted PostgreSQL UUID as the same identity. Casing therefore cannot bypass self-edge or
cycle protection.

### 3.1.2 Work-item hierarchy

Every work item has a nullable `parentWorkItemId`. `null` means top-level; a non-null value creates
one same-workspace parent edge. The adjacency model supports arbitrary depth, while every direct
child listing is bounded and stable. Parent and child workflow statuses, priorities, deadlines,
planning durations, and optimistic versions remain independent. Creating, moving, or detaching a
child never completes, reopens, reprioritizes, or increments either parent.

The hierarchy rejects self-parenting and direct or transitive cycles. It uses the same
workspace-scoped graph lock as prerequisite mutations, then walks the proposed parent chain inside
the transaction. The database also enforces tenant-bound parent references, rejects a physical
self-edge, restricts deletion of a referenced parent, and indexes direct-child reads. Reparent and
detach require the child's current `expectedVersion`; each real edge change increments only that
child and appends an immutable hierarchy audit event.

Only leaf work items are automatic planning candidates. A parent may retain a saved positive
planning duration, but that preference is dormant while it has children and becomes eligible again
only after every direct child is detached. Parent status never cascades to descendants. The local
API, Work board, and authenticated integration gateway can create a child, list direct children,
discover `parentWorkItemId`, and reparent or detach a child. Projects, milestones, and checklist
items remain separate future concepts rather than aliases for this hierarchy.

### 3.2 Routine

A reusable activity template eligible for repeated recommendation, such as exercising, studying a language, or reviewing finances. A routine defines intent and scheduling policy; it is not itself evidence that the activity occurred.

### 3.3 Schedule block

A reserved period on the calendar. It may reference a work item or routine occurrence, or stand alone as an appointment or unavailable period.

### 3.4 Plan item

An item selected for a particular daily plan. It records a typed source identity—exactly one routine or work item—why it was selected, its estimated duration, its position in the plan, and whether the user accepted or changed it.

### 3.5 Activity event

An immutable observation such as suggested, accepted, started, completed, skipped, deferred, dismissed, or duration corrected. Every event has the same typed source identity as its plan item. Routine events feed cadence history; work-item events preserve the one-time item lifecycle without inventing cadence.

### 3.6 Routine planning feedback

An explicit, temporary instruction to suppress one routine for the current local day or through the
end of its routine-defined week. **Not today** and **Not this week** are hard planner exclusions, not
activity outcomes and not edits to the routine's cadence. Feedback is append-only and records its
source plan; clearing it appends a reset rather than rewriting history. The latest applicable event
is authoritative, so a reset reverses the suppression immediately without allowing an older
instruction to resurface. The routine also has one global feedback order across plan dates: a plan
that observed an older feedback head cannot overwrite a newer-date instruction.

### 3.7 Routine selection preference

An explicit, reversible instruction to rank one routine more or less often in future plans. Each
**More often** event adds 100 points and each **Less often** event subtracts 100 points. The planner
uses at most the latest eight directional events after the latest reset within the inclusive prior
90 local days, and clamps the total to `[-400, 400]`. A reset clears the active preference without
deleting history.

This signal changes ranking only. It never changes cadence, eligibility, duration, activity,
routine policy, or the current Today plan. Events are append-only, tenant-bound, idempotent, and
guarded by a routine-local preference version independent from the routine edit version. The
append-only stream is capped at 1,000 events per routine; source-plan provenance is validated, and
an accepted mutation or exact retry returns its causally stable projection. A later explicit plan
generation is a new planning run and may consume the signal. This is a direct user instruction, not
inferred or model-generated learning.

## 4. Organization and tags

The application supports free-form tags, but algorithmically meaningful properties use structured dimensions:

| Dimension  | Examples                            | Planning purpose              |
| ---------- | ----------------------------------- | ----------------------------- |
| Priority   | low, medium, high, critical         | Express relative importance   |
| Cadence    | daily, weekly, monthly, flexible    | Define expected frequency     |
| Effort     | quick, short, medium, deep          | Match plan capacity           |
| Energy     | low, normal, high                   | Match user state              |
| Context    | home, computer, errands, phone      | Ensure the task is actionable |
| Category   | health, work, learning, maintenance | Maintain balance              |
| Preference | enjoyable, neutral, unpleasant      | Avoid fatigue and reward bias |

Custom categories and values may be added later. Display labels must remain distinct from behavioral rules so renaming a tag does not silently change the algorithm.

## 5. Cadence policy

A cadence is a policy rather than a single label. It may contain:

- Period: day, week, month, rolling interval, or custom range
- Target completions per period
- Optional minimum and maximum completions
- Minimum spacing between completions
- Preferred or excluded weekdays
- Preferred time of day
- Whether consecutive-day completion is discouraged or prohibited
- Grace period and rollover behavior
- Start, pause, and end dates

Example:

```json
{
  "period": "week",
  "target": 3,
  "minimum": 2,
  "maximum": 4,
  "minimumSpacingDays": 1,
  "discourageConsecutiveDays": true
}
```

Reaching a target sharply reduces selection probability. Reaching a hard maximum makes the routine ineligible until the period resets. A target is not a maximum unless explicitly configured as one.

## 6. Duration and capacity

Each item may define:

- Minimum, expected, and maximum duration
- Whether it can be split into sessions
- Minimum useful session length
- Setup or travel overhead
- Optional due date or fixed calendar window

The daily planning request defines both:

- A target time budget, with optional minimum and maximum
- A target number of tasks, with optional minimum and maximum
- A preference for time accuracy, task-count accuracy, or balanced fitting
- Available time windows and existing calendar commitments

Observed duration is stored separately from the user's estimate. The implemented routine insight
uses completed sessions from the inclusive trailing 90-day window, requires at least three valid
samples, applies the latest non-future correction for each completion, and excludes reversed or
future evidence. Its robust estimate is the integer median (an even-sample midpoint rounds half up).

The insight reports the evidence as insufficient until the sample minimum is met. With enough
history, it reports the estimate as aligned when the median differs by less than the greater of five
minutes or 10% of the current expected duration. It suggests the median only when that difference is
material and the value remains inside the user-owned minimum and maximum. A median outside that range
requires range review instead of offering a one-click change.

An actionable `suggested` or `review_range` result carries a lowercase SHA-256 `insightKey` and an
`available` or `dismissed` disposition. Informational `insufficient_history` and `aligned` results
have no key and always remain available. The key fingerprints the calculation version, lookback and
sample policy, the routine's minimum, expected, and maximum duration, and the canonical qualifying
completion, correction, and reversal evidence. Evaluation time, evidence return order, and
presentation-only routine fields do not change it.

Choosing **Not now** appends a `dismissed` event for that exact key. Choosing **Show again** appends a
`reset` event for the same key. The latest event for a workspace, routine, and key determines whether
that recommendation is available or dismissed; prior events remain immutable. Each command is
workspace-idempotent: an identical retry returns its original event, while reuse of the same
idempotency key for different semantics conflicts. The command revalidates the current routine
version and actionable insight before append, so stale evidence or policy cannot be dismissed or
reset as if it were current.

Dismissal does not suppress future learning. Any qualifying evidence change, relevant duration-policy
change, or calculation-policy change produces a different key. A still-actionable recommendation
with that new key resurfaces as `available` automatically. Dismiss and reset do not edit the routine,
apply a duration, mutate Today or its head, regenerate a plan, or alter planner scoring and selection.

This calculation is read-only. Accepting a suggestion sends its routine version and complete duration
policy to a dedicated approval command. In one read-committed transaction, the server acquires the same
per-routine advisory lock used by activity appends, reloads the routine and current 90-day evidence,
recomputes the insight, and saves only when the same expected duration is still supported. The
minimum, maximum, splitting, minimum-session, and overhead fields
must still match the current user-owned policy; approval may change only the expected duration.
Read committed is deliberate: statements made after an advisory-lock wait must see evidence committed
by the earlier lock holder. Generic routine updates take the same lock and isolation before their
version check and save, preventing a manual policy edit from racing approval or insight feedback.
Product transactions that do not coordinate on this lock remain serializable by default.

Routine-version or evidence conflicts are not retried automatically. The generic routine `PATCH`
remains the manual editing path and does not claim to approve an insight. Neither approval path
changes the current Today plan. A later explicit plan generation or regeneration may use the newly
approved estimate. Recency weighting and personalized calibration may be evaluated in later versions
against real outcome data.

## 7. Daily planning pipeline

### 7.1 Inputs

- Eligible work items and routines
- Completion and recommendation history
- Current calendar availability
- Time budget and target task count
- User context: energy, location, tools, and focus preference
- Deadlines, priorities, cadence policies, and locked items
- Temporary instructions such as "not this week"

The implemented planner draws candidates from reusable routines and from opted-in one-time work
items. A work item is eligible only when it has a positive planning duration and is in `backlog`,
`planned`, or `in_progress`; `blocked`, `done`, and `cancelled` work stays out of Today. A due date
does not override any of these eligibility or capacity constraints. Calendar blocks remain
independent reservations rather than planner candidates or automatic placements. For an initial
plan, Today can explicitly subtract those reservations from a user-selected outer range and submit
the resulting free windows; the persisted windows, not a later calendar query, remain authoritative.

### 7.2 Hard constraints

The engine first removes impossible choices, including:

- Paused, archived, or unavailable items
- Cadence maximum already reached
- Required context not currently available
- Duration that cannot fit any available window and cannot be split
- Minimum spacing not satisfied
- Explicit exclusions or snoozes
- Active **Not today** or **Not this week** routine feedback
- Work with at least one direct prerequisite whose current status is not `done`

Deadlines add score pressure only. They never override ordinary eligibility, available-window capacity,
or time and task-count limits. User-locked commitments are carried forward by the explicit mutation
path and are not a general deadline override.

### 7.3 Scoring

Each eligible candidate receives an explainable score assembled from normalized components. Routine
scores use cadence and activity history. One-time work uses its explicit priority plus deadline
pressure, so it cannot acquire accidental recurrence pressure from routine history. The default
deadline horizon is 14 days: work due today receives the configured
`workItemDeadlineDueToday` increment, future work
inside the horizon gains an increment for each day nearer its due date, and overdue work gains a
capped increment. Work due beyond the horizon remains eligible but receives zero deadline pressure:

```text
score =
  priority weight
  + deadline pressure
  + cadence deficit
  + neglect / time-since-completion
  + preferred-day and context fit
  + plan-balance benefit
  + user affinity
  + explicit routine selection preference
  - recent-frequency penalty
  - consecutive-day penalty
  - category saturation
  - skip or deferral fatigue
  - duration-fit penalty
```

Weights are versioned configuration. Scores and component contributions are saved with each generated plan so behavior can be audited and reproduced.

### 7.4 Controlled probability

Scores are converted into weighted probabilities. The planner then evaluates candidate combinations rather than rolling independently for every item. This preserves variety while fitting the plan as a whole.

The algorithm should support:

- A low probability floor for eligible, target-satisfied activities when exploration is allowed
- A temperature setting that controls how predictable or varied selection is
- A deterministic daily random seed so refreshing does not arbitrarily change the plan
- A new seed only when the user explicitly regenerates or edits planning inputs

### 7.5 Combination optimization

Candidate plans are ranked using a multi-objective fitness function:

```text
plan fitness =
  candidate scores
  + time-budget fit
  + task-count fit
  + category and effort diversity
  + calendar-window fit
  - overload
  - fragmentation
  - excessive context switching
```

Hard constraints must never be violated merely to improve fitness. The result may intentionally contain fewer tasks than requested when no realistic combination exists.

### 7.6 Output

The engine returns one recommended plan and, optionally, a small number of alternatives. Every plan item includes concise reasons such as:

> Selected because it is high priority, has not been completed for nine days, and fits your available 45-minute morning window. Its weekly target is currently 1 of 3.

## 8. Repetition behavior

For a routine targeted three times per week:

- Before the target is met, cadence deficit raises its score.
- A completion lowers its immediate score through spacing and repetition penalties.
- Three completions satisfy the target and sharply reduce its probability.
- If exploration is enabled, it retains a very small probability until its maximum is reached.
- At the maximum, it becomes ineligible for the remainder of the period.
- Near the end of a period, unmet minimums receive increasing urgency.

This is based on completions, not merely suggestions. Dismissals and skips influence fatigue separately.

## 9. Daily-plan interaction

The current interface supports stable generation, deterministic alternative comparison and explicit
selection, lock/unlock, lock-preserving regeneration,
single-item replacement, activity transitions, completion reversal, temporary routine feedback,
and selection/exclusion explanations. **Not today** and **Not this week** apply only to pending,
unlocked routine items, append a planning-feedback event, and immediately create a new plan revision
without the suppressed routine. **Not this week** ends at that routine's configured week boundary,
not the server's week or time zone. Reset is also append-only and immediately replans; it removes the
hard suppression without changing cadence or recording a completion, skip, deferral, or dismissal.
All feedback mutations use the current plan identity, optimistic head version, and an idempotency
key, so a stale client cannot silently replace a newer plan. A routine-scoped feedback-head check also
prevents a still-current older-date plan from overwriting an instruction recorded on a newer date.

Activity actions operate on the typed source of the selected plan item. Completing a work-derived
item marks its source work item `done`. Reversing that completion restores the prior work status only
when the completion's saved version is still current; a later accepted completion or edit wins and is
never overwritten. Activity actions do not automatically regenerate Today. The remaining bullets
describe the broader interaction target; **less often**/**more often** adaptation and
generalized plan undo are not implemented yet.

Dependency edits do not rewrite the current Today revision or change its optimistic head. An explicit
regeneration reevaluates current edges: an unlocked item with an unmet prerequisite is removed from
retention and cannot be newly selected, while a locked nonterminal item remains anchored under the
existing user-authority rules. Terminal items remain excluded under the existing replan rules. Once
every direct prerequisite is `done`, a later generation or regeneration may select the dependent
again. The accepted revision remains immutable, and its
canonical input snapshot records the exact dependency projection and prerequisite statuses used for
that decision.

The user can:

- Set available time, desired task count, energy, context, and planning style
- Generate a stable daily plan
- Lock items before regenerating the remainder
- Replace one item without reshuffling everything
- Ask for more or less demanding alternatives
- Mark an item started, completed, skipped, deferred, or dismissed
- Supply an actual duration or correct an estimate
- Choose "not today" or "not this week" for a routine and reset that instruction
- Choose "less often" or "more often"
- View why an item was selected or excluded
- Compare the recommended plan with alternative plans
- Undo plan modifications

Unfinished items do not automatically become permanently urgent. Carryover pressure should rise within a cap, and repeated deferrals should prompt a review of duration, priority, or relevance.

## 10. Adaptation and learning

Initial adaptive behavior uses transparent statistics rather than machine learning. The implemented
first slice is routine-duration calibration: it shows the sample count, lookback window, observed
median, current estimate, and whether more evidence, an explicit estimate update, or range review is
needed. Approval uses a dedicated atomic command that revalidates current evidence and routine state;
neither the insight nor its approval regenerates Today.

The following broader signals remain product targets:

- Day and time preference detection
- Completion likelihood by effort, energy, and context
- Repeated-dismissal detection
- Plan-overload detection
- Category balance over configurable periods

Adaptation safeguards:

- Require enough observations before making a recommendation
- Cap the rate and magnitude of changes
- Show the evidence behind material changes
- Separate learned values from explicit user values
- Allow accepting, rejecting, editing, or resetting learned behavior
- Never lower the importance of a deadline solely because prior suggestions were skipped

The current slice implements evidence thresholds, material-change gating, range review, visible
evidence, explicit approval, exact-key dismissal/reset memory, and Plan Fit use receipts with
descriptive pending, resolved, and not-evaluable history, separate later-revision disclosure, and
bounded weighted outcome rates that Today withholds until three comparable uses settle. Learned cadence or energy preferences; adaptive probabilistic
selection beyond the existing versioned deterministic planner; causal effectiveness analysis and
outcome-driven learning; and automatic application of learned values remain deferred.

## 11. Optional local-model advisor

The implemented first slice is an optional, read-only review of one current Today snapshot. A
provider-neutral `SchedulingAdvisor` application port receives an immutable data projection and has
no repository, transaction, or command-service access. The disabled provider is the default. An
operator may explicitly enable the Ollama adapter at one canonical raw
`http://127.0.0.1:<port>` origin and choose only `gemma4:e2b`, `gemma4:e4b`, `gemma4:26b`, or
`gemma4:31b`; `gemma4:e4b` is the default configured model. Ollama is never an application-readiness
dependency.

The user starts every review with **Ask local advisor**. There is no free-form advisor prompt and no
automatic invocation. The versioned request identifies the current plan ID and head version and
requires the fixed `both` focus. Narrower focus modes remain unavailable until they have explicit
projection and output-validation semantics.
Schedule constructs the context itself from at most 50 sorted plan items and 50 eligible backlog
items. An unselected work item is eligible for this projection only when it is active, opted in, and
every direct prerequisite is `done`; unmet dependents are never sent to or targetable by the
provider. It includes only bounded titles, plan reasons and warnings, scheduling fields, typed source
identity, and truncation signals. Descriptions, workspace names, calendar blocks, arbitrary history,
planner input snapshots, secrets, and dedicated or free-form model-instruction fields are not
included. Titles and other stored text may be user-authored and are explicitly treated as untrusted
data. Text is normalized, control and bidirectional-formatting characters are removed, and the
complete context is capped at 64 KiB before it leaves the application layer.

The Ollama request is one direct HTTP call to `/api/chat` with a fixed system instruction, no tools,
no redirects or proxy/DNS resolution, `stream: false`, `think: false`, a fixed JSON output schema,
and bounded generation, connection, total-time, response-size, and concurrency controls. There is no
automatic retry. Schedule accepts only a versioned summary plus at most five `focus`, `sequence`,
`consider_backlog`, or `plan_observation` suggestions. Every target must identify an item in the
supplied snapshot, unknown fields and duplicate suggestions fail validation, and confidence is
limited to `low` or `medium`. Raw provider envelopes, thinking metadata, and provider error bodies
are discarded rather than persisted or exposed.

The first snapshot is read in a short unit of work; inference runs after that unit of work has
closed. Before returning valid advice, a second short unit of work rebuilds and compares the exact
sanitized plan-and-backlog context and its canonical dependency projection. A dependency or
prerequisite-status change conflicts even when visible backlog membership happens to remain the same.
Any change returns `409 advisor.snapshot_conflict` and discards the advice. Disabled, busy,
timed-out, unreachable, rejected, oversized, malformed, or semantically invalid provider results
become bounded unavailable states. Unsafe or oversized stored context fails closed before provider
dispatch with a bounded domain error. A disconnected caller cancels and destroys the pending
loopback request so its concurrency permit is released promptly. Neither path alters the current
plan.

The implemented advisor may summarize the supplied plan, suggest focus or sequence among supplied
plan items, and point out an eligible supplied backlog item. The following broader responsibilities
remain deferred:

- Converting natural-language requests into routines, multiple tasks, or task breakdowns
- Suggesting or writing tags, duration policies, cadence, energy, or context
- Automatically breaking work into newly persisted sessions or subtasks
- Interpreting free-form daily context
- Applying recommendations, calibrating user values, or changing planner policy
- Local OpenAI-compatible endpoints and hosted providers

Prohibited responsibilities:

- Writing directly to the database
- Inventing completion history or calendar availability
- Silently changing priorities, deadlines, or cadence
- Bypassing eligibility constraints
- Producing the only available plan
- Exposing an Apply or Accept control for model output
- Participating in duration calibration or automatic adaptation

### 11.1 Explicit natural-language work proposals

The Work view has a separate, opt-in `NaturalLanguageProposer` boundary for one free-form capture
request. It shares the local Ollama transport controls but receives only a versioned request ID and
the submitted prompt; it has no plan context, repositories, tools, or mutation services. Its only
valid command is one `work_item.create` title. Model summary and warnings are transient review text.
The raw prompt and free-form model output are never persisted; only a secret-keyed prompt fingerprint,
canonical command/digest, bounded provenance, expiration, status, and result identity are durable.
Priority, due date, and planning duration are stored separately only when the user reviews them;
they never widen the title-only model command.

The proposal is not an applied recommendation. It is pending, editable, cancellable, tenant-scoped,
optimistically versioned, and valid for 60 minutes at most. Confirmation is a distinct explicit
action with a stable idempotency key. One serializable transaction locks and revalidates the exact
proposal and digest, creates a deterministic backlog work-item identity, marks the proposal, and
audits it. Same-key retries replay; a competing key conflicts. The user may select priority, a due
date, and a planning duration before confirmation. This creates eligible source data but does not
mutate the current Today plan, routines, calendar blocks, tags, or cadence.

This implements natural-language creation only for one reviewed root backlog item. Natural-language
routine creation, model-extracted structured fields, task breakdown, multi-command capture, automatic confirmation,
prompt history, model-driven planning, hosted providers, and Hermes/WhatsApp interpretation remain
deferred. The complete privacy, lifecycle, API, and verification contract is in
[NATURAL_LANGUAGE.md](./NATURAL_LANGUAGE.md).

## 12. Conventional scheduling features

The adaptive planner complements, rather than replaces:

- Inbox and backlog
- List and Kanban views
- Projects and milestones
- Calendar day, week, and month views
- One-time and recurring work
- Direct work-item prerequisites are implemented; project and milestone blockers remain targets
- Arbitrary-depth work-item subtasks are implemented; checklist rows remain a target
- Work-item due dates plus deterministic reminder policy, intent materialization, and a fenced
  provider-neutral delivery gateway; opt-in local periodic materialization is implemented while
  provider transport remains deferred
- Search, filters, saved views, and bulk editing
- Notes, links, and attachments
- Import, export, backup, and restore
- Activity history and audit trail
- Multiple workspaces, with collaboration considered later

### Deterministic reminder policy

The implemented core has one workspace profile, reusable rules for daily digest, unfinished-plan
follow-up, plan-window lead, schedule-block lead, and work-item due occurrences, plus explicit
one-off reminders. It resolves local minutes with documented DST disambiguation, enforces half-open
quiet hours, bounded catch-up, rule cooldowns, stable priority, and a daily cap, then persists an
insert-only natural-key intent under a workspace advisory lock. Two concurrent materializers cannot
create duplicate occurrences.

Materialization is available as an explicit local API command and as a disabled-by-default local
worker mode. The worker captures one bounded catch-up/look-ahead window per tick, processes at most
20 workspaces sequentially, and shares the same lock/idempotency boundary as manual calls. A
least-privilege machine credential can claim and revalidate one due intent, then report a fenced
bounded outcome. No destination, provider, account, channel, conversation, provider acknowledgement,
or raw receipt is stored. Those responsibilities stay
behind the separate boundary in [REMINDERS.md](./REMINDERS.md).

## 13. Fairness and well-being safeguards

"Fair" means the system should not repeatedly favor easy, enjoyable, or recently created work while neglecting important maintenance tasks. It should also avoid punitive behavior.

- Use category-balancing limits rather than assuming priority alone is fair.
- Do not equate skipped work with moral failure or use guilt-based language.
- Avoid escalating every unfinished task into an emergency.
- Respect rest periods, maximum planned load, and unavailable time.
- Make recommendation logic equally inspectable across categories.
- Provide a manual-planning mode and a global pause for adaptation.
- Never infer sensitive health or personal traits from behavior without an explicit feature and consent.

## 14. Observability and evaluation

The system should measure algorithm quality without requiring cloud telemetry:

- Plan acceptance rate
- Completion rate of accepted items
- Estimated versus actual duration error
- Regeneration and replacement frequency
- Cadence target and minimum attainment
- Category distribution and repetition
- Overfill and underfill of time budgets
- User overrides and explanation views

Local evaluation should support replaying historical days against a new algorithm version without changing actual records. Algorithm versions, configuration, random seeds, input snapshots, and outputs must be recorded for reproducibility.

Current executable evidence, coverage floors, planner contract metrics, and known evaluation gaps are
maintained in [EVALUATION.md](./EVALUATION.md). Feature evidence is CI-gated; production outcome
metrics remain non-gating until real local usage provides a defined denominator and sufficient sample.
The implemented Today summary is narrower: it reports weighted planned/completed scheduled workload
and additional revisions over the prior 30 current plan heads, without telemetry or adaptation.

Separately, the local worker has an opt-in loopback operational surface for liveness, database
readiness, outbox/reminder queue age and state, and fixed-cardinality failure counters. It contains
no task content or tenant/provider labels and does not treat operational throughput as productivity.
See [Worker observability](./OBSERVABILITY.md).

Success is not simply "more tasks completed." Useful measures include realistic plans, sustainable cadence attainment, low duration error, fewer unwanted regenerations, and continued user control.

## 15. Important edge cases

- Time-zone changes and daylight-saving transitions
- Weeks with different locale start days
- Tasks completed outside the application
- Partial completion and interrupted sessions
- More locked work than available time
- Zero eligible tasks
- Tasks whose minimum duration exceeds every available window
- Conflicting minimum, target, maximum, and spacing rules
- Reopening a completed item
- Editing history and recalculating learned values
- Duplicate suggestions across devices
- Planner generation while another client modifies the schedule

## 16. Initial implementation phases

### Phase 1 — Deterministic foundation

- Routine and structured-tag domain models
- Cadence policy and immutable activity history
- Duration ranges and daily planning request
- Eligibility, scoring, seeded weighted selection, and explanations
- Time-budget and task-count combination fitting
- Unit and simulation tests for repetition and boundary behavior

### Phase 2 — Daily planning experience

- Implemented: Today view and planning controls
- Implemented: lock, replace, regenerate, defer, dismiss, and completion flows
- Implemented: append-only, resettable **Not today** and **Not this week** routine feedback with
  immediate optimistic, idempotent replanning
- Implemented: Kanban/backlog work can opt into Today with a planning duration and an optional local
  due date
- Implemented: directed same-workspace work prerequisites with idempotent editing, transitive cycle
  rejection, and done-only eligibility for newly selected Today work
- Implemented: opt-in calendar-aware first-plan availability, with a visible free-window preview,
  stale-calendar rejection, and the submitted windows preserved as deterministic planner input
- Implemented: deterministic, read-only comparison of up to three distinct alternatives and an
  explicit, optimistic, idempotent selection that preserves locked nonterminal items
- Implemented: "why selected" details on current and alternative items

### Phase 3 — Transparent adaptation

- Implemented: routine-duration insight from a corrected, reversal-aware 90-day median
- Implemented: visible insufficient/aligned/suggested/range-review states and explicit atomic
  approval with evidence revalidation and without automatic Today regeneration
- Implemented: append-only, idempotent **Not now** and **Show again** feedback for one exact
  evidence key, with automatic resurfacing when evidence or relevant policy changes
- Implemented: deterministic Daily Plan Fit guidance from fully resolved current heads, with a
  bounded joint time/task suggestion, explicit prefill, and exact-key dismissal/reset
- Implemented: atomic exact-key Plan Fit use receipts with final edited targets and bounded read-only
  pending, resolved, and not-evaluable outcome history, separate later-revision disclosure, and
  descriptive target-fill and plan-completion rates that exclude later revisions and stay hidden
  until three comparable uses settle
- Implemented: a general read-only prior-30-day planning-outcomes summary using final current heads,
  weighted task/time completion totals, and a transparent additional-revision count
- Implemented: explicit append-only **More often**, **Less often**, and resettable routine ranking
  preferences for future plans, with bounded visible score contribution and no current-plan mutation
- Deferred: inferred cadence, day/time, energy, preference, and category-balance signals
- Deferred: automatic application, adaptive probabilistic selection, causal outcome analysis and
  learned policies, upward Plan Fit expansion, editable Plan Fit policy, and algorithm comparison tools

### Phase 4 — Local-model advisor

- Implemented: provider-neutral read-only interface, bounded sanitized snapshot, strict versioned
  schema validation, and exact post-inference snapshot revalidation
- Implemented: disabled-by-default direct-loopback Ollama adapter with an exact local Gemma
  allowlist, fixed request shape, resource limits, deterministic unavailable states, and no retries
- Implemented: explicit Today review with provenance, accessible loading/failure states, stale-result
  rejection, and no Apply or mutation control
- Implemented: separate free-form Work capture for one expiring, editable backlog-title proposal,
  with prompt-private persistence and explicit audited exactly-once confirmation
- Implemented: user-authored priority, optional due date, and optional planning duration in the
  versioned review snapshot; the model remains title-only
- Deferred: natural-language routine creation, model-extracted structured fields, multi-command
  capture, and task breakdown
- Deferred: free-form context interpretation, automatic application, duration calibration, and
  model-driven planner changes
- Deferred: local OpenAI-compatible endpoints and hosted model providers

Gemma and Ollama do not participate in duration calibration, eligibility, scoring, selection, or
plan mutation. The advisor remains optional and subordinate to the deterministic engine.

### Phase 5 — Hosting and synchronization

The local MVP now includes verified logical backups and staged restore commands. Its automated
disposable recovery drill exercises archive creation, staged restore, promotion, rollback, and exact
cleanup without touching the real local database. Phase 5 still covers provider-managed retention,
point-in-time recovery, hosted restore drills, and the operational controls required for hosting.

- Implemented foundation: workspace-bound machine credentials and a confirmed, idempotent inbound
  automation API with Today and credential-scoped work-item discovery; this is not hosted end-user
  authentication
- Implemented foundation: encrypted, signed outbound endpoints and explicit opt-in
  `schedule.changed.v1` invalidations; these are refresh hints, not reminders or a messaging adapter
- Implemented foundation: deterministic reminder profiles, rules, one-offs, exact-once intent
  materialization, an opt-in bounded local materialization worker, and provider-neutral claim/receipt
  state; a separate dormant Hermes adapter core now enforces lease budget, dedupe ordering, bounded
  outcomes, a strict Schedule HTTP client, shared PostgreSQL side-effect fencing, and fail-safe
  single-flight polling with loopback health and graceful shutdown, while concrete provider
  transport/reconciliation, external bootstrap/control wiring, and human/account binding remain
  follow-on work
- Implemented local adapter: disabled-by-default Hermes tools for authenticated Today/work-item
  reads and sender/session/platform-bound confirmed mutations, plus a deterministic stdout reminder
  helper and a checked runtime-only installer; it is separate from the delivery-claim runtime, and
  live WhatsApp still requires the operator's `WHATSAPP_HOME_CHANNEL` and self-chat smoke
- Implemented narrow hosted runtime: complete `HOSTED_API_MODE=oidc` configuration activates exact
  issuer/subject provisioning, digest-only revocable browser sessions, first-login default-workspace
  membership, login/session/logout, and one transaction-authorized work-item create route. Disabled
  mode remains route-closed, and local unauthenticated product routes cannot coexist with OIDC mode.
- Implemented security boundary: exact-Origin double-submit CSRF, host-only cookies, generic tenant
  denial, bounded client-address throttling, direct pinned OIDC HTTPS, startup preflight/cleanup, and
  same-transaction user/session/workspace/membership reauthorization.
- Implemented narrow hosted read: a signed-in principal can list only active workspace memberships
  through a bounded, no-store page without identity or role metadata.
- Implemented narrow hosted UI: a same-origin capture shell can sign in, select one active
  workspace, and create one backlog title through the transaction-authorized route; it exposes no
  provider tokens, identity metadata, workspace administration, or local-only routes.
- Deferred: hosted workspace administration, the broader product API and interface, account
  management, provider-specific production verification, collaboration roles, and sync.
- Cloud deployment selected from measured operational needs
- Offline-capable synchronization and conflict handling, if required
- Managed backup retention, point-in-time recovery, monitoring, and deployment automation

## 17. Decisions still open

- Default duration and task-count targets
- Whether minimum cadence is a hard commitment or an urgency signal
- Default exploration probability after a target is met
- How partial completion contributes to cadence
- How much calendar auto-placement occurs versus simple task selection
- Whether and how to add a hosted model provider after authentication and explicit cloud consent
- Single-user versus early multi-user product scope
- Notification philosophy and escalation limits

These decisions should be tested against real usage rather than embedded prematurely as irreversible rules.
