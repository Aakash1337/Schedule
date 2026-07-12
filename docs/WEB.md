# Local Web Application

The first product interface is a local React application in `apps/web`. It turns the deterministic
planner and conventional scheduling APIs into a usable single-person workflow without expanding the
security boundary to a public network.

## Runtime shape

- React renders a dependency-light single-page application.
- Vite serves the development UI on `127.0.0.1:5173`.
- Relative `/v1` and `/health` requests are proxied to the loopback API on `127.0.0.1:4000`.
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

1. **Today** creates and operates the current daily plan. It accepts one planning window, both time
   and task-count targets, fit preference, energy, and contexts. Plan items expose explanations,
   locks, activity actions, replacement, regeneration, warnings, and exclusions.
2. **Work** groups one-time work items into the six supported status columns. Status changes use
   explicit controls because manual card ranking is not part of the API contract. Titles,
   descriptions, priority, and status remain editable from the board. Work items are not yet
   candidates in the routine-backed Today planner.
3. **Routines** manages the reusable activity pool, including structured tags, duration policy,
   cadence, status, and activity history.
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

## Design system

The interface uses warm paper-toned surfaces, ink-like neutrals, and a restrained violet accent for
selection and primary actions. Native controls, visible focus states, semantic landmarks, reduced
motion support, and breakpoint-driven navigation keep the application understandable on keyboard,
desktop, and narrow screens.

## Deliberately deferred

- Public hosting and production static serving until authentication and authorization exist
- Drag ranking, bulk editing, projects, subtasks, attachments, and saved searches
- Recurrence authoring, calendar conflict detection, and automatic placement
- Work-item eligibility in Today, alternative-plan comparison, and generalized plan undo
- Learned-duration and adaptation settings
- Local-model advisor controls
- Collaboration, sync, notifications, and cloud deployment
