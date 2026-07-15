# Local Web Application

The first product interface is a local React application in `apps/web`. It turns the deterministic
planner and conventional scheduling APIs into a usable single-person workflow without expanding the
security boundary to a public network.

## Runtime shape

- React renders a dependency-light single-page application.
- Vite serves the development UI on `127.0.0.1:5173`.
- Relative `/v1` and `/health` requests are proxied to the loopback API on `127.0.0.1:4000`.
- The proxy target may be changed with `SCHEDULE_API_URL`; the built-app preview uses the same
  same-origin proxy contract as development.
- CORS remains disabled. Product routes also require an exact loopback `Host` authority, while the
  Vite proxy's `localhost` or `127/8` authority remains accepted.
- PostgreSQL remains the system of record; browser storage retains only the selected workspace.

Run the complete local stack after migration:

```powershell
pnpm infra:up
pnpm db:migrate
pnpm dev
```

## Information architecture

The application uses a persistent desktop rail and a compact mobile navigation bar:

1. **Today** creates and operates the current daily plan. It accepts an outer planning range, both
   time and task-count targets, fit preference, energy, and contexts. Before the first plan, an
   optional **Exclude calendar blocks** control can turn that range into multiple explicit free
   windows. Plan items expose explanations, locks, activity actions, temporary routine feedback,
   replacement, regeneration, warnings, and exclusions. Active **Not today** and **Not this week**
   instructions appear in a separate **Temporarily hidden** list with an Undo control. When a plan
   exists, **Ask local advisor** can request an optional, read-only review of that exact plan and its
   eligible backlog.
2. **Work** groups one-time work items into the six supported status columns. Status changes use
   explicit controls because manual card ranking is not part of the API contract. Titles,
   descriptions, priority, status, optional local **Due date**, and an explicit **Include in Today**
   planning duration remain editable from the board. A due date uses strict `YYYY-MM-DD` local-date
   form and can be cleared. Only opted-in `backlog`, `planned`, and `in_progress` work may become a
   Today candidate; the card shows its selected duration and due date when present. A due date adds
   visible planner pressure but cannot make ineligible or over-capacity work appear in Today. Each
   card also lists its direct prerequisites, their workflow statuses, and how many are done.
3. **Routines** manages the reusable activity pool, including structured tags, duration policy,
   cadence, status, activity history, and transparent duration calibration. The selected routine
   reports whether it needs more completed sessions, supports the current estimate, has a material
   in-range suggestion, or needs manual range review.
4. **Calendar** presents one-time schedule blocks in a week-first agenda. Blocks may link to a work
   item, but remain independently editable. Date and time fields use the browser's IANA time zone so
   the displayed wall time and persisted instant cannot disagree.

Workspace creation is the first-run path. Returning sessions restore the last selected workspace and
open Today.

## Mutation and conflict contract

The browser retains every resource version returned by the API. Work-item, routine, and calendar
updates submit `expectedVersion`. Today commands submit the current plan ID and head version. Actions
that require idempotency retain the same generated key and request timestamp across an ambiguous
transport retry, then apply the mutation response directly.

On a `409` response, the interface reloads authoritative state and refuses to advance a stale full
resource draft to the newer version. Routine and calendar editors show the latest server values;
work detail edits close after the refreshed board arrives. A calendar draft is retained only when
the original block was actually deleted, and it is explicitly converted to create mode. The
interface does not silently overwrite concurrent changes. Offset-paginated collections are read to
exhaustion and, when more than one page is involved, accepted only after two identical traversals.
A collection that changes during traversal asks the user to refresh instead of silently presenting a
partial list. Initial loading uses announced skeleton states, and mutations keep existing data
visible while disabling only the submitted control.

## Work-item prerequisites

The Work board loads the complete bounded work-item and dependency collections even when a priority
filter hides some cards, so a linked prerequisite does not disappear merely because the board is
filtered. Each card's **Manage prerequisites** disclosure offers other unlinked work items, excludes
self-reference, and shows every existing prerequisite with its title and current status. `Done` is
the only satisfied status; the interface does not equate the workflow's manual `Blocked` column with
dependency state.

The complete workspace catalog and edge collection are cached across priority-filter changes, while
fresh filtered records merge back into the catalog so visible prerequisite statuses do not go stale.
An explicit board refresh revalidates both collections; a failed refresh remains retryable, and a
workspace change discards the cache and ignores late responses from the prior workspace.

Add and Remove use the API's natural set idempotency without inventing an `Idempotency-Key` header.
Only the affected card is busy while a request is pending. Success updates the local edge collection,
announces that the work-item status was not changed, and returns focus to the remaining editor or
summary. A cycle conflict stays local to the card and explains that another prerequisite must be
chosen. Other failures remain visible and retryable. Responses from a previous workspace or stale
collection request are ignored under the same query-key and cancellation rules as the board.

Changing prerequisites does not alter the current Today plan. The user must explicitly regenerate
Today to reevaluate unlocked selected work. Locked nonterminal items retain their established anchor
authority, while terminal items remain excluded under the existing replan rules.

Pending, unlocked routine items expose **Not today** and **Not this week** under a separate planning-
feedback control; work items and started or terminal routines do not. The browser sends the current
plan ID, head version, complete planning request, and a stable idempotency key. A successful response
replaces Today immediately with the new revision and announces what was hidden. The resulting
exclusion stays visible under **Temporarily hidden**, where Undo appends a reset and replans again.
The interface describes these as temporary planner instructions: they do not mark activity and do
not change cadence. Ambiguous transport retries retain the original command identity, while a head
conflict reloads the authoritative plan instead of replaying a stale instruction. If a newer plan
date has changed the routine-global feedback head, the older plan remains unchanged and the interface
directs the user to the newer plan rather than claiming the unchanged older revision is authoritative.
After a successful suppression removes the initiating control, keyboard focus moves to the newly
rendered Undo action; reloads and ordinary plan changes do not steal focus.

## Calendar-aware Today availability

The first-plan form keeps manual availability as the default. When **Exclude calendar blocks** is
enabled, Today reads all schedule blocks that overlap the browser-local civil day, clips them to the
selected outer range, sorts and merges overlapping or adjacent reservations, and previews the
remaining half-open free windows plus their combined minutes. Blocks that touch only the range edge
do not consume capacity. The preview is an ordinary labelled list with polite loading/success status
and actionable error or fully-booked states; no modal or hidden automatic choice is involved.

Immediately before generation, Today reads the day again and compares the identity, version, and
clipped timing of every block that affects the selected range. A changed snapshot updates the
preview and stops the command so the user must review and submit again. A failed or malformed
calendar read also stops generation. The user can retry or explicitly turn the option off to submit
the original manual range. Late responses from an earlier workspace are aborted and ignored.

The exact derived windows in the accepted generation request are authoritative and are persisted
with the immutable plan input. The planner and API do not independently query schedule blocks, and
later calendar edits do not silently rewrite an existing plan or its regeneration settings. This
client-owned opt-in preserves existing API callers while leaving a versioned server-side policy mode
as a future option if multiple integrations need uniform enforcement.

A duration suggestion is never applied on load. The user must choose **Apply estimate**, which sends
the selected routine's complete duration policy and insight version to the dedicated atomic approval
endpoint. The server re-reads the routine and current evidence before saving and permits only the
expected duration to change; the ordinary routine `PATCH` remains the manual editor path. A routine or
evidence conflict reloads both resources, shows the conflict, and requires approval again. The browser
does not auto-retry the old suggestion. An out-of-range median opens ordinary duration editing instead
of offering a direct apply action. Applying an estimate leaves the current Today plan unchanged until
the user explicitly generates or regenerates it.

An available `suggested` or `review_range` insight also offers a quiet **Not now** action. It sends
the current routine version and exact evidence key with a fresh idempotency key, then refetches the
insight. A dismissed insight keeps its recommendation explanation and evidence visible, hides
**Apply estimate**, edit/review, and **Not now**, and instead offers **Show again**. That reset uses
the same exact key and refetches the current disposition. Neither action edits the routine, changes
its duration, mutates Today or its head, regenerates a plan, or changes planner behavior.

Only the submitted feedback controls are disabled while a command is pending. A transport or policy
failure keeps the current insight visible and can be retried with a new command attempt. A `409`
refreshes stale routine and insight evidence rather than pretending the old recommendation changed.
Late responses for a previously selected routine do not replace the current detail view. After a
successful dismissal or reset, keyboard focus returns to the insight heading and a polite live
message announces the new disposition. Changed completion evidence or relevant duration policy
produces a new key, so a still-actionable recommendation automatically appears as available even if
an earlier key was dismissed.

## Local-advisor interaction

The Today header exposes **Ask local advisor** only after a current plan has loaded. It sends a fresh
request ID, the visible plan ID and head version, the selected date, and the fixed `both` focus. There
is no prompt field, model picker, automatic invocation, or background retry. The current plan remains
visible while the button shows a busy state, and a second advisor request cannot start. Today
mutations remain user-controlled and invalidate the pending or displayed review.

The inline **Local advisor** panel always states, “Advice only. It cannot change your schedule.” A
successful response shows the validated summary, an ordered suggestion list, low/medium confidence,
the configured model, completion time, source plan head, reviewed item counts, and whether the input
was truncated. Model strings render only as ordinary React text. The panel contains no **Apply**,
**Accept**, task-creation, plan-mutation, or planner-setting action.

Backlog advice can target only an item the server supplied after applying the same done-only direct-
prerequisite eligibility rule as planning. An unmet dependent is absent from the model context and
cannot become a valid suggestion target.

Disabled, busy, timeout, unreachable, provider-rejected, oversized, malformed, and invalid-advice
results produce specific safe messages while preserving the plan. Transport failure uses a bounded
generic message and requires a new explicit click. If the API returns
`409 advisor.snapshot_conflict`, or if the response snapshot does not exactly identify the requested
date, plan, and head, the browser discards the result, reloads the authoritative plan, and asks the
user to review it before trying again. A workspace/date change, plan mutation, regeneration, refresh,
or newer request aborts or invalidates the earlier review so a late response cannot replace current
state. Closing or aborting the browser request also propagates cancellation through the API to the
local provider request, releasing its concurrency permit.

The trigger is programmatically associated with the panel and its non-mutation guarantee. The loading
message and a concise completion message use polite live regions, while the detailed result remains
non-live; unavailable and failed states use alerts. Keyboard focus returns to the triggering button
after completion when it is still present and enabled. These states are component-tested; the optional
real-model smoke check is a separate operator command, not part of the Chromium product flow.

## Design system

The interface uses warm paper-toned surfaces, ink-like neutrals, and a restrained violet accent for
selection and primary actions. Native controls, visible focus states, semantic landmarks, reduced
motion support, and breakpoint-driven navigation keep the application understandable on keyboard,
desktop, and narrow screens.

## Live browser verification

The Chromium smoke test exercises the central product path through real built processes and a fresh
PostgreSQL database: create a workspace, opt in one-time work, add a routine, and generate today's
plan; apply **Not today**, verify the separate hidden state survives reload, reset it, and verify the
routine returns pending; then complete and reverse work, complete the routine, reload, and confirm
that activity persists. It asserts successful feedback and reset HTTP responses and does not
intercept network requests or replace the API with mocks. A second scenario persists a work-item due
date and exposes its deadline pressure through live planning. A third creates completion evidence,
dismisses and reloads an exact duration insight, resets it, dismisses it again, then appends changed
evidence and expects the new key to resurface as available. The fourth runs the Work board at 320px,
keyboard-adds a done prerequisite, reloads it, removes it, reloads its absence, and asserts focus,
44px targets, horizontal fit, unchanged workflow status, and clean page/network results. Duration-
calibration approval has component and API/PostgreSQL evidence but is not yet part of a browser
scenario.

Install the local browser binary once, then run the bounded verifier:

```powershell
pnpm exec playwright install chromium
pnpm verify:web-e2e
```

The verifier builds the API and web application, allocates unused loopback ports, starts an isolated
Compose project backed by PostgreSQL `tmpfs`, applies every migration, and starts the production API
entry point plus Vite's built-app preview. PostgreSQL receives a Docker-assigned loopback port, and
the browser clock is fixed in UTC. The runner refuses pre-existing project resources, labels its
container with a per-run ownership token, and refuses cleanup when that token does not match. Success
and failure both stop the web process tree and remove the disposable container, network, and
database; a leaked port or failed cleanup makes the command fail. GitHub CI runs the same command in
a dedicated Chromium job and retains traces, screenshots, and video when it fails.

## Deliberately deferred

- Public hosting and production static serving until authentication and authorization exist
- Drag ranking, bulk editing, projects, subtasks, attachments, and saved searches
- Recurrence authoring, calendar conflict detection, and automatic placement
- Alternative-plan comparison and generalized plan undo
- Learned cadence, energy, preference, overload, and adaptive-selection settings
- Automatic duration-insight application and historical insight-comparison controls
- Natural-language task/routine creation, model-driven plan application, and hosted advisor controls
- Collaboration, sync, reminder settings and intent history, Hermes/WhatsApp transport, and cloud deployment
