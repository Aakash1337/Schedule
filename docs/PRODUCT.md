# Adaptive Scheduling System — Product Specification

Status: Working product definition
Last updated: 2026-07-13

Implementation note: deterministic Phase 1 is implemented across the domain, application use cases, PostgreSQL adapters, schema, migrations, unit tests, and seeded simulation coverage. Phase 2 now includes stable typed plan-item identities, an authoritative Today-plan head, audited lock and activity state, immutable regeneration/replacement revisions, routine-only **Not today** and **Not this week** feedback, status-based backlog/Kanban work items, bounded non-recurring calendar-block management, and a responsive local web interface. Planner v4 selects both reusable routines and explicitly opted-in one-time work items, applies temporary routine feedback as a versioned hard constraint, and adds transparent deadline pressure for eligible work. Phase 3 now includes a transparent, read-only routine-duration insight, explicit approval, and reversible dismissal of one exact evidence-backed recommendation; broader learned preferences and automatic adaptation remain deferred. A provider-neutral authenticated inbound gateway now provides Today reads, credential-scoped backlog/Kanban work-item discovery, and confirmed structured mutations for future agents. The secure outbound substrate supports operator-queued tests and an explicit opt-in, privacy-thin `schedule.changed.v1` invalidation without schedule content. See [API.md](./API.md), [WEB.md](./WEB.md), [INTEGRATIONS.md](./INTEGRATIONS.md), and [WEBHOOKS.md](./WEBHOOKS.md). Alternative-plan comparison, generalized undo, recurrence authoring, reminder and phone-notification events, a Hermes/WhatsApp adapter, and public hosting remain deferred.

## 1. Product summary

The target application combines conventional task and schedule management with an adaptive daily
planner. The current local MVP supports ordinary one-time work, a status-based board, bounded
non-recurring calendar blocks, and a pool of reusable routines from which it generates a practical
daily plan. Projects and the broader conventional feature set in section 12 remain product targets.

The planner considers both the user's available time and desired number of tasks. It uses explicit rules, completion history, and controlled randomness to balance priority, cadence, variety, urgency, effort, and personal context. An optional local language model may advise the planner, but the deterministic scheduling engine remains authoritative.

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
does not override any of these eligibility or capacity constraints. Calendar blocks remain independent
reservations rather than planner candidates or automatic placements.

### 7.2 Hard constraints

The engine first removes impossible choices, including:

- Paused, archived, or unavailable items
- Cadence maximum already reached
- Required context not currently available
- Duration that cannot fit any available window and cannot be split
- Minimum spacing not satisfied
- Explicit exclusions or snoozes
- Active **Not today** or **Not this week** routine feedback

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

The current interface supports stable generation, lock/unlock, lock-preserving regeneration,
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
describe the broader interaction target; alternatives, **less often**/**more often** adaptation, and
generalized plan undo are not implemented yet.

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
evidence, explicit approval, and exact-key dismissal and reset memory. Learned cadence or energy
preferences; adaptive probabilistic selection beyond the existing versioned deterministic planner;
historical insight comparison; and automatic application of learned values remain deferred.

## 11. Optional local-model advisor

No language-model advisor or `PlanningAdvisor` interface is implemented. This section defines a
future target only: if added, a language model would advise rather than control scheduling, and
integration would occur through a provider-neutral `PlanningAdvisor` interface.

Potential implementations:

- Disabled advisor
- Local Ollama-compatible advisor
- Local OpenAI-compatible endpoint
- Future hosted provider

Appropriate responsibilities:

- Convert natural-language requests into proposed structured tasks or routines
- Suggest tags, duration ranges, cadence, energy, and context
- Break large work into feasible sessions
- Interpret daily context such as "I am tired and have two free hours"
- Explain plans in natural language
- Identify unrealistic or contradictory settings
- Propose policy changes for user approval

Prohibited responsibilities:

- Writing directly to the database
- Inventing completion history or calendar availability
- Silently changing priorities, deadlines, or cadence
- Bypassing eligibility constraints
- Producing the only available plan

Future advisor output must use a versioned JSON schema, be validated, and time out safely. Invalid,
unavailable, or slow model responses must fall back to the deterministic planner. Prompts and
responses should be locally inspectable and excluded from cloud synchronization unless explicitly
enabled.

## 12. Conventional scheduling features

The adaptive planner complements, rather than replaces:

- Inbox and backlog
- List and Kanban views
- Projects and milestones
- Calendar day, week, and month views
- One-time and recurring work
- Dependencies and blockers
- Subtasks and checklists
- Work-item due dates; reminders and notifications remain deferred
- Search, filters, saved views, and bulk editing
- Notes, links, and attachments
- Import, export, backup, and restore
- Activity history and audit trail
- Multiple workspaces, with collaboration considered later

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
- Implemented: Kanban/backlog work can opt into Today with a planning duration and an optional local due date; calendar blocks remain independent
- Partial: "why selected" details are implemented; alternative-plan comparison is deferred

### Phase 3 — Transparent adaptation

- Implemented: routine-duration insight from a corrected, reversal-aware 90-day median
- Implemented: visible insufficient/aligned/suggested/range-review states and explicit atomic
  approval with evidence revalidation and without automatic Today regeneration
- Implemented: append-only, idempotent **Not now** and **Show again** feedback for one exact
  evidence key, with automatic resurfacing when evidence or relevant policy changes
- Deferred: learned cadence, day/time, energy, preference, overload, and category-balance signals
- Deferred: automatic application, adaptive probabilistic selection, historical insight comparison,
  and algorithm comparison tools

### Phase 4 — Local-model advisor

- Deferred: provider-neutral interface and schema validation
- Deferred: natural-language routine creation and task breakdown
- Deferred: context interpretation and plan explanations
- Deferred: local privacy controls, diagnostics, and deterministic fallback

Gemma, Ollama, and other local or hosted models do not participate in duration calibration. Any
future advisor remains optional and subordinate to the deterministic engine and explicit user
approval.

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
- Authentication and secure workspace isolation
- Cloud deployment selected from measured operational needs
- Offline-capable synchronization and conflict handling, if required
- Managed backup retention, point-in-time recovery, monitoring, and deployment automation

## 17. Decisions still open

- Default duration and task-count targets
- Whether minimum cadence is a hard commitment or an urgency signal
- Default exploration probability after a target is met
- How partial completion contributes to cadence
- How much calendar auto-placement occurs versus simple task selection
- Initial local-model runtime and model choice
- Single-user versus early multi-user product scope
- Notification philosophy and escalation limits

These decisions should be tested against real usage rather than embedded prematurely as irreversible rules.
