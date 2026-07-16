# Schedule

Project documentation is indexed in [docs/README.md](./docs/README.md). The main specifications are
the [product definition](./docs/PRODUCT.md),
[deterministic planner contract](./docs/PLANNER.md), [local HTTP API](./docs/API.md), and
[local web application](./docs/WEB.md). Deterministic reminder policy, intent materialization, and
provider-neutral delivery are specified in [docs/REMINDERS.md](./docs/REMINDERS.md). The
authenticated automation boundary is in
the [integration gateway guide](./docs/INTEGRATIONS.md). Local data protection and recovery
procedures are in the [operations guide](./docs/OPERATIONS.md). Behavioral confidence and known test
limitations are tracked in the [evaluation guide](./docs/EVALUATION.md). The two distinct opt-in
Hermes paths—one local conversational plugin and one provider-neutral reminder-delivery adapter
foundation—are documented in the [Hermes guide](./docs/HERMES.md).
The optional loopback worker health and metrics contract is in
[docs/OBSERVABILITY.md](./docs/OBSERVABILITY.md).
The opt-in hosted OIDC and workspace-authorization boundary is in
[docs/HOSTED_AUTHORIZATION.md](./docs/HOSTED_AUTHORIZATION.md).
The local model's explicit, review-before-write capture contract is documented in
[docs/NATURAL_LANGUAGE.md](./docs/NATURAL_LANGUAGE.md).

Provider-neutral infrastructure for a customizable work-management and scheduling system.

## Architecture

This repository starts as a TypeScript modular monolith:

- `packages/domain`: framework-free work and scheduling rules.
- `packages/application`: use cases and narrow infrastructure ports.
- `packages/config`: validated runtime configuration.
- `packages/database`: PostgreSQL schema, migrations, and adapters.
- `apps/api`: HTTP transport and health endpoints.
- `apps/web`: local React interface for Today, routines, work, calendar blocks, and reminders.
- `apps/worker`: database-backed outbox processing.

Outbox delivery is at least once. Every handler that produces an external or otherwise durable side
effect must make that effect idempotent for the outbox event ID before acknowledging the claim. The
PostgreSQL verifier runs the production worker loop in child processes, kills it both before a side
effect and after an idempotent side effect but before acknowledgement, then proves lease recovery,
fencing, exactly-once effect persistence, and second-attempt completion.

The domain now includes a pure, seeded daily planner that balances cadence, time budget, task count, context, and recent completion history.
Today can compare the current plan with up to three deterministic, structurally distinct alternatives
without writing anything. Choosing one is explicit, optimistic, and idempotent: the server recomputes
the opaque candidate under the day lock, preserves locked nonterminal work, rejects stale choices,
and stores one immutable next revision.

Routines also have explicit **More often**, **Less often**, and **Reset preference** controls. Each
choice appends a reversible, version-fenced ranking event for future plans. The bounded score is
visible in planner explanations; it never changes cadence, eligibility, duration, activity history,
or the current Today plan.

Routine details also expose a transparent duration-calibration insight. After three completed
sessions in the trailing 90 days, Schedule compares the routine's configured estimate with the
observed median, applies recorded corrections, excludes reversed completions, and offers a
version-checked update only when the user explicitly approves it. The approval command atomically
revalidates the current routine and evidence before saving; the insight never rewrites a routine or
the current Today plan on its own.

Today also exposes deterministic Daily Plan Fit guidance. Once at least three prior current plans
are fully resolved, Schedule compares the median planned and completed time/task pairs across a
bounded 90-day window and may suggest materially smaller joint targets. Using the suggestion only
prefills both editable fields; explicit generation is still required. Exact evidence-backed
dismissal and reset are append-only, and changed evidence receives a new key. When the user does
generate from a selected suggestion, Schedule revalidates that exact key and atomically records the
actual edited targets with the plan. A bounded read-only history then shows pending, resolved, and
not-evaluable outcomes, with later revisions disclosed separately. A separate workspace summary
reports weighted target-fill and plan-completion rates only for settled, unrevised uses. Both views
are descriptive and never feed planner scoring, model prompts, or automatic adaptation.

The local API also exposes status-based backlog/Kanban work items and bounded non-recurring calendar blocks, providing the backend surface for the first usable interface. Work items support arbitrary-depth, acyclic same-workspace subtasks plus directed prerequisites. Parent and child statuses remain independent, only leaf work is eligible for Today, and a dependent is newly selectable only when every direct prerequisite is `done`.

The Work view can optionally ask the same loopback-only Ollama/Gemma boundary to prepare one backlog
title from free-form text. It stores no raw prompt or model prose and performs no mutation until the
user reviews the exact command and confirms it. Confirmation is tenant-scoped, expiring,
version-checked, audited, and durable exactly-once under concurrent retries.

An optional integration gateway gives a workspace-scoped machine credential read-only access to
Today and a two-step, idempotent structured-command flow. It is disabled by default. Schedule stays
authoritative; Hermes or another messaging agent calls this boundary instead of writing the
database. The repository includes an opt-in local Hermes plugin that adds sender/session/platform-
bound later-turn confirmation and a deterministic stdout reminder helper. It remains local-only and
does not silently enable a cron job or WhatsApp delivery.

A separate outbound webhook substrate can deliver signed, workspace-bound test events and explicitly
subscribed privacy-thin Today-change invalidations through the existing durable outbox. It is also
disabled by default and never publishes schedule contents; see the
[webhook delivery guide](./docs/WEBHOOKS.md).

Schedule now also owns a deterministic reminder-policy core: versioned workspace profiles and rules,
explicit one-off reminders, DST/quiet-hours/catch-up evaluation, and concurrency-safe insert-only
pending-intent materialization with transactional invalidation when policy or targets change. The
provider-neutral integration gateway can lease one due intent with a fenced claim and record a
bounded delivery outcome. The web interface configures that policy, offers a manual materialization
control, and separates planned reminder history from a product-safe execution history. An opt-in
local worker can also materialize intents periodically with bounded catch-up and look-ahead windows.
Schedule still performs no provider transport and never stores provider, recipient, account,
conversation, or raw receipt data. A dormant [Hermes reminder adapter foundation](./docs/HERMES.md)
now implements the safe claim/send/receipt and dedupe ordering around this gateway plus a shared,
fenced PostgreSQL dedupe store that persists only a digest of its reservation token. A fail-safe,
single-flight polling supervisor and loopback health runtime are also implemented, but remain inert
without an explicit operator control. A concrete Hermes transport, human binding, provider
reconciliation, and external process bootstrap are still required for real delivery.

The worker can optionally expose loopback-only liveness, database readiness, and fixed-cardinality
Prometheus text metrics for outbox, reminder materialization, and provider-neutral delivery queues.
The surface is disabled by default and contains no task/reminder content or dynamic identifiers.

`WorkItem` represents intent and workflow state. `ScheduleBlock` represents reserved time and may
optionally reference a work item. Their lifecycles remain independent.

The local web app uses the API through a Vite same-origin development proxy. CORS remains disabled,
and product routes accept only loopback `Host` authorities, preventing DNS rebinding from expanding
the unauthenticated surface beyond local development.

## Local development

Prerequisites: Node.js 24+, pnpm 11.7+, and Docker Compose. The repository's `.nvmrc` pins the
local and CI Node.js major; run `nvm use` before installing dependencies when using nvm.

The development PostgreSQL and API ports are published on host loopback only.

```powershell
Copy-Item .env.example .env
pnpm install
pnpm infra:up
pnpm db:migrate
pnpm dev
```

The web app listens on `http://127.0.0.1:5173` and the API listens on
`http://127.0.0.1:4000` by default. Use `/health/live` for process health and `/health/ready` for
database readiness.

Local unauthenticated product routes are enabled only for non-production loopback development.
Configuration rejects attempts to enable them in production or on a non-loopback bind, and the API
rejects non-loopback product-route `Host` headers. `HOSTED_API_MODE` defaults to `disabled`; `oidc`
is accepted only with the complete immutable registration, secret-backed preflight, and local
unauthenticated product routes disabled. The enabled surface provides login, callback, session,
logout, automatic first-login default-workspace membership, and one membership-authorized work-item
create route with bounded per-source throttling. It does not yet provide a hosted web shell,
workspace discovery/administration, the broader product API, or synchronization.
Partial sets and non-empty mixed-case aliases or unknown companions fail startup without disclosing values.
Health and system-information endpoints
intentionally remain available independently of the product Host guard for local diagnostics.

The separately authenticated integration gateway is disabled by default. Provision a per-workspace
credential and configure `INTEGRATION_API_PEPPER` before enabling `INTEGRATION_API_MODE`; see the
[integration gateway guide](./docs/INTEGRATIONS.md). Its machine credentials do not authenticate the
browser product routes.

Outbound delivery remains disabled unless `WEBHOOK_DELIVERY_MODE=enabled` and a valid external
master-key keyring is configured. Provision endpoints and verify a receiver with the CLI before
enabling the worker. Endpoints have no automatic subscriptions by default; an operator may opt one
into `schedule.changed.v1`, which tells a receiver to refresh Today without carrying plan or task
content. This webhook is not used as a reminder. Reminder policy decisions, durable intents, and
provider-neutral supervised delivery polling are implemented, with polling disabled by default.
Provider/account binding, reconciliation, external bootstrap, and a concrete Hermes/WhatsApp
transport are not part of this release. Separately, the opt-in local Hermes plugin calls the
authenticated read/write gateway when invoked and offers a deterministic stdout Today helper; live
WhatsApp delivery remains incomplete until the operator configures `WHATSAPP_HOME_CHANNEL` and
verifies an operator-owned self-chat. Automatic
local intent materialization is available but disabled by default; set
`NOTIFICATION_MATERIALIZATION_MODE=enabled` only after reminder policy is configured. This does not
enable delivery. The least-privilege claim/receipt gateway is implemented for an external adapter.
Set `WORKER_OBSERVABILITY_MODE=loopback` to expose worker diagnostics only on `127.0.0.1:9464`;
this is independent from both materialization and delivery enablement.

## Verification

```powershell
pnpm check
pnpm eval
```

`pnpm eval` validates the feature-to-evidence registry and runs all unit and component tests with
coverage floors. PostgreSQL integrations and recovery drills run under `pnpm eval:full`. Test count
and line coverage are diagnostics; critical features must also point to passing PostgreSQL or
recovery-drill evidence. See the [evaluation guide](./docs/EVALUATION.md) for the scorecard and known
gaps.

After installing Chromium once with `pnpm exec playwright install chromium`, run
`pnpm verify:web-e2e` to exercise the built web application, live API, fresh migrations, and an
isolated PostgreSQL database through ten live flows: routine/Today activity and feedback,
work-item deadline pressure, duration-insight dismissal/reset, accessible 320px prerequisite
editing, mobile subtask persistence and leaf-only planning, routine ranking preferences,
deterministic alternative comparison and selection, reminder
policy/materialization/history with responsive checks, and deterministic Daily Plan Fit
prefill/dismissal/reset, stale-key rejection, explicit generation receipts, resolved outcomes, and
revision disclosure. The local proposal flow uses the production
local-model adapter against a strict loopback double to review a title plus user-authored
priority/date/duration, confirm, replay the same
confirmation key, cancel, focus, and reload natural-language work proposals without browser request
interception.

With PostgreSQL running, verify backlog/Kanban, hierarchy, work-item prerequisites, and calendar
management, routine creation and optimistic updates, duration calibration and Daily Plan Fit,
stable activity-history pagination, idempotent routine and Today-item activity recording,
deterministic plan generation, and atomic plan-revision persistence:

```powershell
pnpm verify:database
```

The database gate includes `verify:natural-language-proposals`, `verify:notification-core`,
`verify:notification-delivery`, and `verify:notification-migrations`. The proposal verifier covers
private persistence, exact reviewed root-item creation, tenant isolation, and concurrent same-key
and competing-key confirmation. The
reminder verifiers cover all six deterministic occurrence sources, concurrent
exact-once materialization, source/target invalidation, fenced claim/receipt recovery, tenant
constraints, and populated pre-0024/pre-0025/pre-0026/pre-0027 upgrades. The notification migration
verifier checks the
workspace/schedule/id execution-history index without changing delivery or credential data.

Verify the Hermes plugin's deterministic Python contract and its disposable PostgreSQL/real
Fastify prepare-and-confirm flow separately:

```powershell
pnpm verify:hermes-adapter
```

That command proves the local/stdout provider boundary, not delivery to a WhatsApp account or phone.

GitHub CI runs the same PostgreSQL-backed planner, product API, isolated outbox lease/fencing, and
populated legacy plan-state and weekday migration upgrades after applying every migration to a fresh
PostgreSQL 17 Compose project. It also verifies a complete archive round trip, the real disposable
restore/promote/rollback/cleanup state machine, and the ten live Chromium product flows in a
separate disposable database.

## Local data protection

Create a verified PostgreSQL custom-format backup **before** migrations, upgrades, or other risky
local work:

```powershell
pnpm db:backup
```

Backups default to `~/.schedule/backups`, outside the repository. Restoring replaces the local
`schedule` database only after staging, current migrations, and real database verification. The
previous database remains available for explicit rollback until a separately confirmed cleanup. The
same mechanics are exercised automatically against nonce-bound disposable databases in CI. See the
[operations guide](./docs/OPERATIONS.md) before using `pnpm db:restore`.

## Deployment boundary

The API and worker are ordinary OCI-compatible Node processes. PostgreSQL is the system of record.
Core packages do not depend on a hosting provider, queue vendor, or cloud SDK. The production
runtime images use a fixed non-root identity; the executable OCI smoke gate additionally enforces a
read-only root filesystem, dropped Linux capabilities, and `no-new-privileges` for migrations, the
API, and the worker. Complete secret-manager-fed `HOSTED_API_MODE=oidc` configuration now activates
the hardened authorization-code lifecycle, nonce-bound verification, browser sessions, first-login
workspace bootstrap, and one transaction-authorized hosted work-item mutation. Provider discovery,
JWKS, and token exchange use bounded direct HTTPS with pinned address policy; failed preflight closes
the database and exits before listening. Disabled mode remains route-closed.

These are provider-neutral runtime prerequisites, not a hosted release. TLS ingress, deployment
manifests, managed secrets/backups, monitoring, workspace discovery, the broader product surface,
synchronization, and a hosted web shell remain to be implemented and verified.
