# Schedule

The evolving product definition is documented in [PRODUCT.md](./PRODUCT.md). The implemented deterministic-planner contract is documented in [PLANNER.md](./PLANNER.md), and the local HTTP surface is documented in [API.md](./API.md).

Provider-neutral infrastructure for a customizable work-management and scheduling system.

## Architecture

This repository starts as a TypeScript modular monolith:

- `packages/domain`: framework-free work and scheduling rules.
- `packages/application`: use cases and narrow infrastructure ports.
- `packages/config`: validated runtime configuration.
- `packages/database`: PostgreSQL schema, migrations, and adapters.
- `apps/api`: HTTP transport and health endpoints.
- `apps/worker`: database-backed outbox processing.

The domain now includes a pure, seeded daily planner that balances cadence, time budget, task count, context, and recent completion history.

`WorkItem` represents intent and workflow state. `ScheduleBlock` represents reserved time and may
optionally reference a work item. Their lifecycles remain independent.

The frontend is intentionally deferred until product workflows and visual direction are defined.

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

The API listens on `http://127.0.0.1:4000` by default. Use `/health/live` for process health and
`/health/ready` for database readiness.

Local unauthenticated product routes are enabled only for non-production loopback development. Configuration rejects attempts to enable them in production or on a non-loopback bind; authentication will be required before hosted product routes are introduced.

## Verification

```powershell
pnpm check
```

With PostgreSQL running, verify routine creation and optimistic updates, stable activity-history pagination, idempotent activity recording, deterministic plan generation, and atomic plan-revision persistence:

```powershell
pnpm verify:planner-db
pnpm verify:product-api
```

## Deployment boundary

The API and worker are ordinary OCI-compatible Node processes. PostgreSQL is the system of record.
Core packages do not depend on a hosting provider, queue vendor, or cloud SDK.
