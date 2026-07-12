# Adaptive Scheduling System — Product Specification

Status: Working product definition
Last updated: 2026-07-12

Implementation note: deterministic Phase 1 is implemented across the domain, application use cases, PostgreSQL adapters, schema, migrations, unit tests, and seeded simulation coverage. Phase 2 now includes stable plan-item identities, an authoritative Today-plan head, audited lock and activity state, immutable regeneration/replacement revisions, status-based backlog/Kanban work items, bounded non-recurring calendar-block management, and a responsive local web interface for the complete core loop. See [API.md](./API.md) and [WEB.md](./WEB.md). Alternative-plan comparison, undo, recurrence authoring, and public hosting remain deferred.

## 1. Product summary

This application combines conventional task and schedule management with an adaptive daily planner. It supports ordinary one-time work, projects, boards, calendars, and recurring activities, while also maintaining a pool of reusable routines from which it can generate a practical daily plan.

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

A normal, actionable unit of work. It may belong to a project, appear on a Kanban board, have a deadline, or remain in a backlog. A work item can be scheduled zero, one, or multiple times.

### 3.2 Routine

A reusable activity template eligible for repeated recommendation, such as exercising, studying a language, or reviewing finances. A routine defines intent and scheduling policy; it is not itself evidence that the activity occurred.

### 3.3 Schedule block

A reserved period on the calendar. It may reference a work item or routine occurrence, or stand alone as an appointment or unavailable period.

### 3.4 Plan item

An item selected for a particular daily plan. It records why it was selected, its estimated duration, its position in the plan, and whether the user accepted or changed it.

### 3.5 Activity event

An immutable observation such as suggested, accepted, started, completed, skipped, deferred, dismissed, or duration corrected. Planning uses this history rather than overwriting it.

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
- Deadline or fixed calendar window

The daily planning request defines both:

- A target time budget, with optional minimum and maximum
- A target number of tasks, with optional minimum and maximum
- A preference for time accuracy, task-count accuracy, or balanced fitting
- Available time windows and existing calendar commitments

Observed duration is stored separately from the user's estimate. Once enough history exists, the system may calculate a learned estimate using a recency-weighted robust average. It should propose significant changes rather than silently rewriting user-entered values.

## 7. Daily planning pipeline

### 7.1 Inputs

- Eligible work items and routines
- Completion and recommendation history
- Current calendar availability
- Time budget and target task count
- User context: energy, location, tools, and focus preference
- Deadlines, priorities, cadence policies, and locked items
- Temporary instructions such as "not this week"

### 7.2 Hard constraints

The engine first removes impossible choices, including:

- Paused, archived, or unavailable items
- Cadence maximum already reached
- Required context not currently available
- Duration that cannot fit any available window and cannot be split
- Minimum spacing not satisfied
- Explicit exclusions or snoozes

Deadlines and user-locked commitments may override ordinary eligibility rules, but the override must be shown.

### 7.3 Scoring

Each eligible candidate receives an explainable score assembled from normalized components:

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

The user can:

- Set available time, desired task count, energy, context, and planning style
- Generate a stable daily plan
- Lock items before regenerating the remainder
- Replace one item without reshuffling everything
- Ask for more or less demanding alternatives
- Mark an item started, completed, skipped, deferred, or dismissed
- Supply an actual duration or correct an estimate
- Choose "less often," "more often," "not today," or "not this week"
- View why an item was selected or excluded
- Compare the recommended plan with alternative plans
- Undo plan modifications

Unfinished items do not automatically become permanently urgent. Carryover pressure should rise within a cap, and repeated deferrals should prompt a review of duration, priority, or relevance.

## 10. Adaptation and learning

Initial adaptive behavior should use transparent statistics rather than machine learning:

- Duration calibration from completed sessions
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

## 11. Optional local-model advisor

The language model is an advisor, not the scheduling authority. Integration occurs through a provider-neutral `PlanningAdvisor` interface.

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

Advisor output must use a versioned JSON schema, be validated, and time out safely. Invalid, unavailable, or slow model responses fall back to the deterministic planner. Prompts and responses should be locally inspectable and excluded from cloud synchronization unless explicitly enabled.

## 12. Conventional scheduling features

The adaptive planner complements, rather than replaces:

- Inbox and backlog
- List and Kanban views
- Projects and milestones
- Calendar day, week, and month views
- One-time and recurring work
- Dependencies and blockers
- Subtasks and checklists
- Deadlines, reminders, and notifications
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
- A deadline that conflicts with a cadence maximum
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

- Today view and planning controls
- Lock, replace, regenerate, defer, dismiss, and completion flows
- Kanban, backlog, and calendar integration
- Alternative plans and "why selected" details

### Phase 3 — Transparent adaptation

- Learned duration estimates
- Preference and overload observations
- Suggested policy changes with approval and reset controls
- Historical replay and algorithm comparison tools

### Phase 4 — Local-model advisor

- Provider-neutral interface and schema validation
- Natural-language routine creation and task breakdown
- Context interpretation and plan explanations
- Local privacy controls, diagnostics, and deterministic fallback

### Phase 5 — Hosting and synchronization

- Authentication and secure workspace isolation
- Cloud deployment selected from measured operational needs
- Offline-capable synchronization and conflict handling, if required
- Backup, restore, monitoring, and deployment automation

## 17. Decisions still open

- Default duration and task-count targets
- Whether minimum cadence is a hard commitment or an urgency signal
- Default exploration probability after a target is met
- Whether a cadence maximum may be overridden by a deadline
- How partial completion contributes to cadence
- How much calendar auto-placement occurs versus simple task selection
- Initial local-model runtime and model choice
- Single-user versus early multi-user product scope
- Notification philosophy and escalation limits

These decisions should be tested against real usage rather than embedded prematurely as irreversible rules.
