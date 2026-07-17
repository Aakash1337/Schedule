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

## Hosted capture entry

The same package builds a separate `hosted.html` entry for explicit OIDC mode. It reuses the product
controls and visual tokens but includes only session bootstrap, active-workspace discovery, sign
in/out, name-only workspace creation, one current-day snapshot, one fixed first-page backlog
snapshot, narrow Today/backlog actions, and one backlog form with optional priority, due date, and
planning duration. The API serves that build from the same origin, so the
browser never needs CORS, provider tokens, or a second frontend service. The local application and
its unauthenticated routes are not bundled into the hosted entry.

The hosted shell offers name-only creation when no active workspace exists and behind one compact
disclosure when a workspace is selected. It shows a selector only when more than one active
membership exists, immediately selects a successful creation, stores only that selection in browser
storage, and sends the exact script-readable CSRF proof on
mutations, and treats session, access, throttling, and availability failures as bounded states. It
shows the browser-local day's existing plan through titles, durations, and activity states, plus the
first 20 backlog items with scheduling summaries. Optional capture fields stay behind one disclosure.
The two reads fail and retry independently; capture refreshes only the
backlog. Each visible backlog item can be moved only to started or done with its snapshot version.
Pending Today items offer Start, Done, and Skip; started items offer Done and Skip; terminal items
offer none.
An ambiguous Today failure explicitly retries the same timestamp/key, while a stale head discards
the intent and requires a fresh read. A successful action refreshes both Today and backlog.
The shell cannot generate a plan, page, filter, edit fields, reopen, cancel, synchronize work,
rename/delete workspaces, or administer membership.

## Information architecture

The application uses a persistent desktop rail and a compact mobile navigation bar:

1. **Today** creates and operates the current daily plan. It accepts an outer planning range, both
   time and task-count targets, fit preference, energy, and contexts. Before the first plan, an
   optional **Exclude calendar blocks** control can turn that range into multiple explicit free
   windows. Plan items expose explanations, locks, activity actions, temporary routine feedback,
   replacement, regeneration, warnings, and exclusions. Active **Not today** and **Not this week**
   instructions appear in a separate **Temporarily hidden** list with an Undo control. When a plan
   exists, **Ask local advisor** can request an optional, read-only review of that exact plan and its
   eligible backlog. Before generation, **Deterministic Plan Fit** explains whether enough resolved
   history exists, whether recent targets fit, or whether a smaller joint time/task target may help;
   explicit uses later appear in a read-only outcome history.
2. **Work** groups one-time work items into the six supported status columns. Status changes use
   explicit controls because manual card ranking is not part of the API contract. Titles,
   descriptions, priority, status, optional local **Due date**, and an explicit **Include in Today**
   planning duration remain editable from the board. A due date uses strict `YYYY-MM-DD` local-date
   form and can be cleared. Only opted-in `backlog`, `planned`, and `in_progress` work may become a
   Today candidate; the card shows its selected duration and due date when present. A due date adds
   visible planner pressure but cannot make ineligible or over-capacity work appear in Today. Each
   card also lists its parent, direct subtasks, completion progress, and direct prerequisites.
3. **Routines** manages the reusable activity pool, including structured tags, duration policy,
   cadence, status, activity history, and transparent duration calibration. The selected routine
   reports whether it needs more completed sessions, supports the current estimate, has a material
   in-range suggestion, or needs manual range review.
4. **Calendar** presents one-time schedule blocks in a week-first agenda. Blocks may link to a work
   item, but remain independently editable. Date and time fields use the browser's IANA time zone so
   the displayed wall time and persisted instant cannot disagree.
5. **Reminders** manages the versioned notification profile, reusable rules, and explicit one-offs.
   Separate **Planned** and **Execution** tabs distinguish immutable policy decisions from the
   product-safe delivery lifecycle. The interface exposes a manual materialization action and may
   display intents created by the separately configured local worker; it never claims that a
   currently claimed command proves an external send.

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

Today exposes **Compare alternatives** only for a current plan with retained planning settings. The
inline, non-modal panel keeps the current plan visible beside up to three deterministic alternatives,
including total time, item count, compact titles, and deltas. Previewing is read-only: no card is a
selection control, and nothing changes until **Use this plan** is pressed. Selection reuses the exact
preview request with the current plan ID/head and a retained idempotency key. A successful response
replaces Today with the authoritative revision and returns focus to its summary. A stale preview is
discarded on `409`, the latest plan is loaded, and the user must compare again; the client never
silently selects a replacement or automatically replays a stale choice. Workspace changes and any
observed head change abort and discard pending previews. On narrow screens, comparison cards stack
and their actions retain the 44px control minimum.

## Work-item hierarchy

The board remains organized by the six workflow columns instead of nesting cards. Each card shows
whether it is top-level or links back to its parent, reports direct-child completion, and offers a
contextual **Add subtask** action. The composer then names the selected parent and creates through
the nested child route. The first three children are directly navigable; a keyboard-operable
disclosure keeps every additional child reachable without making the card permanently tall.

The details editor can detach or move an item. It excludes the item and its complete descendant set
from parent choices, while the server still revalidates the graph for concurrent changes. A rejected
cycle keeps the draft and explains the conflict. Parent/child links clear an active priority filter
when necessary and move focus to the revealed card. Parent and child statuses remain independent.

Only leaf work items enter Today. A card with children uses a **Parent · not in Today** badge. If it
already has a saved duration, the editor shows that value as dormant and disables the planning
toggle until every child is detached; the preference is preserved rather than silently discarded.
Mobile hierarchy controls and disclosures are at least 44px high, and direct-child overflow does not
expand the page width.

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

## Explicit future-plan preference

The selected routine detail exposes a separate **Future selection** control with **More often**,
**Less often**, and **Clear preference** actions. This surface is intentionally in Routines rather
than Today: Today already owns temporary **Not today** and **Not this week** instructions, and mixing
future ranking into those item actions would blur two different intents.

The browser loads the routine's independent preference version in its explicit IANA time zone. Each
directional action appends one bounded score step and announces: “Saved for future plans. Today’s
plan was not changed.” A directional score and server explanation remain visible. An untouched or
reset state stays quiet. When recent directional events cancel to zero, the UI shows **Neutral · 0**
and retains **Clear preference**, because later event expiry could otherwise make that history
directional again. The API's `activeEventCount` distinguishes this state from a true reset.

Only this control group is busy during a write. Ambiguous transport retry reuses the exact command
identity. A `409` discards that identity, reloads authoritative state, requires a fresh choice, and
restores focus to the section heading. Workspace/routine changes abort or ignore stale reads and
writes. At 320px actions stack with 44px minimum targets; routine titles and server reasons render as
literal text.

## Reminder interaction

A workspace without a notification profile opens an explicit setup form. The browser may prefill its
own IANA time zone, but it does not create or update policy until the user submits. Existing profile,
rule, and one-off mutations retain and send server versions; a `409` reloads authoritative state and
requires a new decision instead of overwriting concurrent work. Rule kind is immutable, and a
cancelled one-off remains terminal.

The **Planned** tab reads insert-only notification intents and exposes **Refresh planned reminders**
as a manual materialization trigger. An operator may separately enable the local worker, so
background-created intents can appear on the next refresh. The **Execution** tab reads a separate product route whose DTO
omits claim fencing, leases, credentials, destinations, providers, channels, recipients, dedupe
internals, and provider payloads. Both histories use bounded pages and an explicit load-more control.
The three tabs support Arrow Left/Right, Home, and End and use roving keyboard focus.

Every reminder surface repeats the operational boundary: optional background intent planning is
operator-controlled, while adapter polling and WhatsApp/email/push/phone providers remain
unconnected. `processing` is described as a Schedule claim,
not an external-send acknowledgement. At 320px, the navigation, tabs, forms, and status cards remain
inside the viewport and interactive targets retain the 44px minimum used by the rest of the product.

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

## Daily Plan Fit interaction

The first-plan form independently loads workspace-scoped Plan Fit guidance for the selected local
date. Loading, unavailable-with-retry, insufficient-history, aligned, available-suggestion, and
dismissed states remain inline and do not block manual planning. When evidence exists, the panel
shows the typical planned and completed minute/task pairs and explains that completed time means the
scheduled duration of completed items. A plan counts only after every item is terminal.

**Use _n_ minutes and _n_ tasks** only copies both suggested values into the editable fields, moves
focus to the first target, and announces the result. It never submits the form. The user can review
or change either field and must still choose **Generate today's plan**. Prefilling creates no history
entry. The later generated request carries the selected evidence key plus the values the user
explicitly submitted. If that evidence changed, the browser clears the selection, reloads current
guidance, and leaves the date without a plan; it never silently generates from the stale choice.

**Plan Fit outcome summary** and **After using Plan Fit** remain visible while the generated current
plan is on screen. The bounded read-only history distinguishes the
original suggestion from the final edited targets, labels a use as pending until every current-plan
item is terminal, then shows completed scheduled workload for a resolved day. If the day was later
regenerated or otherwise revised, `revisedSinceUsage` discloses that separately while the row
evaluates the current head and preserves the original source plan. Missing or empty current plans are
labelled not evaluable. Loading, retry,
empty, and error states are independent of the guidance read, and fetching history cannot submit the
form or mutate planner state.

**Plan Fit outcome summary** is an independent workspace-scoped read of the newest 28 explicit uses.
It shows how many settled, unrevised uses support comparison, the separate time/task proportions of
submitted targets that were scheduled, and the proportions of scheduled plans that were completed.
Pending, revised, and not-evaluable uses remain visible as counts but never enter those rates. Exact
suggestion and edited-before-generation counts preserve user authority. Loading, failure, retry, empty,
and zero-eligible states are independent from both guidance and row history, and stale workspace/date
responses are aborted and ignored. The copy calls the summary descriptive, never improvement, success,
causal lift, or learned adaptation.

The separate **Planning outcomes** card summarizes the final current heads from the prior 30 local
dates whether or not Plan Fit was used. It shows weighted completed-versus-planned scheduled time and
task totals after three plan days, plus the number of additional revisions. Empty, insufficient,
loading, failure, and retry states stay inline. The card reuses existing Today presentation styles,
writes nothing, and never changes guidance, planning, or model input.

**Not now** appends feedback for the exact evidence key and refetches the panel. A paused suggestion
keeps its evidence visible and offers **Show again**. Ambiguous retry retains the same idempotency
key; other failures keep the action available, while a `409` discards the stale command, reloads the
current evidence, and states that no old suggestion was applied. A workspace/date change aborts and
invalidates older reads and feedback responses. Successful disposition changes return keyboard
focus to the panel heading and use a polite live announcement.

## Duration-calibration interaction

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

## Natural-language proposal interaction

The Work composer exposes **Describe work** as an optional alternative to ordinary structured quick
capture. Its inline panel states that the local model can suggest only one backlog title and cannot
create or change work. The prompt accepts one concrete outcome. **Review proposal** prepares only a
server-persisted, expiring proposal; the next screen displays the exact command, transient summary
and warnings, model provenance, expiration time, and the explicit message “Nothing has been created
yet.”

The title remains editable. Priority, optional due date, and optional planning duration appear in a
separate section labelled as the user's choices rather than model suggestions. Confirming any changed
field first replaces the complete review snapshot with its expected version and then sends one stable confirmation key. A transport failure keeps the proposal and key
so the user can retry without duplicate work. **Cancel proposal** terminally cancels it and announces
that no item was created. Closing during provider generation aborts that request; workspace changes
abort and discard every in-flight or displayed proposal so a late response cannot cross workspaces.

After a successful confirmation, the returned item is merged into Backlog without a second create
call. Any active priority filter is cleared when necessary, and focus moves to the new work card so a
keyboard user receives the same state transition as a pointer user. The ordinary composer remains
available regardless of model configuration or availability. The panel does not expose provider
settings, arbitrary commands, automation, or a prompt/model history. Component tests cover cancel,
edit/confirm/focus, stable-key retry, and a deliberately late success after workspace cancellation.
The live Chromium flow uses the built API and production adapter against a controllably held loopback
model double—without browser interception—to prove full-snapshot persistence, exact created fields,
cancellation, same-key replay, and workspace-switch request abortion.

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
date and exposes its deadline pressure through live planning. A dedicated 320px preference scenario
records **More often**, reloads, records **Less often**, preserves the net-zero clear action, resets
and reloads it, verifies 44px targets and horizontal fit, and proves no Today plan was created.
Another scenario creates completion evidence,
dismisses and reloads an exact duration insight, resets it, dismisses it again, then appends changed
evidence and expects the new key to resurface as available. A scenario runs the Work board at 320px,
keyboard-adds a done prerequisite, reloads it, removes it, reloads its absence, and asserts focus,
44px targets, horizontal fit, unchanged workflow status, and clean page/network results. Another
mobile Work scenario creates, completes, reloads, detaches, and reparents a subtask; proves the
parent is excluded while the leaf enters Today; expands overflow children; and verifies 44px targets
and horizontal fit. Duration-
calibration approval has component and API/PostgreSQL evidence but is not yet part of a browser
scenario. A reminder scenario creates policy, edits a rule, creates a one-off, explicitly materializes
intents, inserts an execution fixture through the isolated PostgreSQL test boundary, and verifies the
real product-safe history route and UI at desktop and 320px without request interception. Another
prepares one title through a strict loopback Ollama double, proves no card exists before confirmation,
edits and confirms through the real API, verifies focus, and reloads the persisted backlog item. A
Daily Plan Fit scenario creates three fully resolved historical plans, observes a joint
90-minute/two-task suggestion, dismisses and restores its exact key, rejects a stale selected key
without creating a plan or receipt, and proves that copying both targets still writes no history. It
edits the targets, generates explicitly, replays the request without duplicating usage, resolves the
plan, renders the outcome on the next no-plan day, revises the original day, and renders the revision
notice. The alternatives scenario compares deterministic choices, selects one exactly once, reloads
it, and rejects a stale selection.

Install the local browser binary once, then run the bounded verifier:

```powershell
pnpm exec playwright install chromium
pnpm verify:web-e2e
pnpm verify:hosted-web-e2e
```

The verifier builds the API and web application, allocates unused loopback ports, starts an isolated
Compose project backed by PostgreSQL `tmpfs`, applies every migration, and starts the production API
entry point plus Vite's built-app preview. PostgreSQL receives a Docker-assigned loopback port, and
the browser clock is fixed in UTC. The runner refuses pre-existing project resources, labels its
container with a per-run ownership token, and refuses cleanup when that token does not match. Success
and failure both stop the web process tree and remove the disposable container, network, and
database; a leaked port or failed cleanup makes the command fail. GitHub CI runs the same command in
a dedicated Chromium job and retains traces, screenshots, and video when it fails.

The hosted verifier builds its isolated entry and uses a strict in-browser API double to exercise
signed-out and authenticated capture, exact request verification, workspace selection, Today
first-plan generation, completion, and mobile layout. The missing-plan form uses the browser IANA
zone, one editable same-day window, and independent minute/task caps; after generation it disappears
in favor of the authoritative Today projection and focus moves to the persistent Today heading.
Ambiguous retries retain the exact request key and
window. The PostgreSQL/OIDC composition verifier separately covers the real server/database
transaction, deterministic replay, and conflicting-input rejection. A staging HTTPS smoke with the selected identity
provider remains required.

## Deliberately deferred

- The broader hosted product interface, external-provider smoke, and verified public deployment
- Drag ranking, bulk editing, projects, checklists, attachments, and saved searches
- Recurrence authoring, calendar conflict detection, and automatic placement
- Generalized plan undo
- Learned cadence, energy, preference, and adaptive-selection settings
- Automatic Plan Fit application, upward target expansion, and editable Plan Fit policy
- Automatic duration-insight application and historical insight-comparison controls
- Natural-language routine creation, tags/dates/duration, task breakdown, multi-command capture,
  model-driven plan application, and hosted advisor controls
- Collaboration, sync, automatic reminder execution, Hermes/WhatsApp transport, and cloud deployment
