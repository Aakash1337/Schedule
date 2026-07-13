# Schedule

Project documentation is indexed in [docs/README.md](./docs/README.md). The main specifications are
the [product definition](./docs/PRODUCT.md),
[deterministic planner contract](./docs/PLANNER.md), [local HTTP API](./docs/API.md), and
[local web application](./docs/WEB.md). Local data protection and recovery procedures are in the
[operations guide](./docs/OPERATIONS.md). Behavioral confidence and known test limitations are tracked
in the [evaluation guide](./docs/EVALUATION.md).

Provider-neutral infrastructure for a customizable work-management and scheduling system.

## Architecture

This repository starts as a TypeScript modular monolith:

- `packages/domain`: framework-free work and scheduling rules.
- `packages/application`: use cases and narrow infrastructure ports.
- `packages/config`: validated runtime configuration.
- `packages/database`: PostgreSQL schema, migrations, and adapters.
- `apps/api`: HTTP transport and health endpoints.
- `apps/web`: local React interface for Today, routines, work, and calendar blocks.
- `apps/worker`: database-backed outbox processing.

Outbox delivery is at least once. Every handler that produces an external or otherwise durable side
effect must make that effect idempotent for the outbox event ID before acknowledging the claim. The
PostgreSQL verifier runs the production worker loop in child processes, kills it both before a side
effect and after an idempotent side effect but before acknowledgement, then proves lease recovery,
fencing, exactly-once effect persistence, and second-attempt completion.

The domain now includes a pure, seeded daily planner that balances cadence, time budget, task count, context, and recent completion history.

The local API also exposes status-based backlog/Kanban work items and bounded non-recurring calendar blocks, providing the backend surface for the first usable interface.

`WorkItem` represents intent and workflow state. `ScheduleBlock` represents reserved time and may
optionally reference a work item. Their lifecycles remain independent.

The local web app uses the API through a Vite same-origin development proxy. CORS remains disabled,
and product routes accept only loopback `Host` authorities, preventing DNS rebinding from expanding
the unauthenticated surface beyond local development.

## Local development

Prerequisites: Node.js 24+, pnpm 11.7+, and Docker Compose.

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

Local unauthenticated product routes are enabled only for non-production loopback development. Configuration rejects attempts to enable them in production or on a non-loopback bind, and the API rejects non-loopback product-route `Host` headers. Authentication will be required before hosted product routes are introduced. Health and system-information endpoints intentionally remain available independently of the product Host guard for local diagnostics.

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

With PostgreSQL running, verify backlog/Kanban and calendar management, routine creation and optimistic updates, stable activity-history pagination, idempotent routine and Today-item activity recording, deterministic plan generation, and atomic plan-revision persistence:

```powershell
pnpm verify:database
```

GitHub CI runs the same PostgreSQL-backed planner, product API, isolated outbox lease/fencing, and
populated legacy plan-state and weekday migration upgrades after applying every migration to a fresh
PostgreSQL 17 Compose project. It also verifies a complete archive round trip and the real disposable
restore/promote/rollback/cleanup state machine.

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
Core packages do not depend on a hosting provider, queue vendor, or cloud SDK.
