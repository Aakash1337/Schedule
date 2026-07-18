# Hosted deployment

Schedule remains provider-neutral. The first concrete adapter targets Railway because the existing
OCI images map directly to two services and managed PostgreSQL. No Railway SDK is used by runtime
code.

This is a deployment contract, not evidence of a live production release. A staging environment
must still prove public ingress, external OIDC, backups, and alerts before production use.

## Topology

| Resource   | Exposure     | Responsibility                                |
| ---------- | ------------ | --------------------------------------------- |
| PostgreSQL | Private only | System of record and migration ledger         |
| API        | Public HTTPS | OIDC, capture shell, hosted routes, health    |
| Worker     | Private only | Outbox and explicitly enabled background jobs |

Use the repository root as the build context. In each Railway service, set the custom config path:

- API: `/infra/deploy/railway/api.railway.json`
- Worker: `/infra/deploy/railway/worker.railway.json`

The manifests reuse `infra/docker/api.Dockerfile` and `infra/docker/worker.Dockerfile`. Their
Dockerfile commands remain authoritative; neither manifest duplicates a start command.

## Variables

Reference the private PostgreSQL service URL as `DATABASE_URL`; do not use its public URL. Keep
secrets in sealed service variables, never in the repository or Docker build arguments.

API variables:

```dotenv
NODE_ENV=production
LOG_LEVEL=info
API_HOST=::
DATABASE_URL=${{Postgres.DATABASE_URL}}
PRODUCT_API_MODE=disabled
HOSTED_API_MODE=oidc
HOSTED_PUBLIC_ORIGIN=https://schedule.example.com
HOSTED_OIDC_ISSUER=https://identity.example.com/tenant
HOSTED_OIDC_CLIENT_ID=schedule-browser
HOSTED_OIDC_PREFLIGHT_MODE=enabled
HOSTED_OIDC_TOKEN_AUTH_METHOD=client_secret_basic
HOSTED_OIDC_CLIENT_SECRET=<sealed>
HOSTED_LOGIN_TRANSACTION_PEPPER=<sealed-random-32+-bytes>
HOSTED_SESSION_PEPPER=<different-sealed-random-32+-bytes>
HOSTED_LOGIN_PKCE_KEYS=primary:<sealed-base64url-32-byte-key>
HOSTED_LOGIN_PKCE_PRIMARY_KEY_ID=primary
```

The API purpose-derives durable work-item sync cursor signing from `HOSTED_SESSION_PEPPER`; there is
no additional sync secret. Every API replica must receive the same value. Rotating it intentionally
signs out browser sessions and forces sync consumers to authenticate and bootstrap again.

Do not set `API_PORT`; the API uses `API_PORT` when explicitly supplied and otherwise honors the
platform `PORT`. Keep `API_TRUSTED_PROXIES` empty unless the provider publishes exact ingress
addresses or CIDRs that have been verified. An empty list is safer than trusting all forwarded
headers, although source throttling may then aggregate at the ingress proxy.

Worker variables:

```dotenv
NODE_ENV=production
LOG_LEVEL=info
DATABASE_URL=${{Postgres.DATABASE_URL}}
NOTIFICATION_MATERIALIZATION_MODE=disabled
WEBHOOK_DELIVERY_MODE=disabled
WORKER_OBSERVABILITY_MODE=disabled
WORKER_DEPLOYMENT_HEALTH_MODE=railway
```

Enable worker capabilities only after their credentials and runbooks are ready. The existing worker
observability server is intentionally loopback-only and is not presented as a public Railway health
endpoint.

## Worker deployment readiness

Railway injects `PORT`; do not define it manually. With `NODE_ENV=production` and
`WORKER_DEPLOYMENT_HEALTH_MODE=railway`, the worker binds a deployment-only listener to that port on
all interfaces. It exposes only `GET /health/live` and database-backed `GET /health/ready`.
`/metrics` and every other path return `404`, non-GET methods return `405`, responses are `no-store`,
and database failures are reduced to `503 {"status":"not_ready"}` without detail.

This listener is a critical worker service. A bind/listener failure stops sibling processing and
causes a nonzero process exit. Readiness probes share one in-flight query on a dedicated
one-connection, read-only pool with a five-second statement timeout, so traffic on this port cannot
consume the processing pool. Shutdown stops accepting connections, lets that bounded query finish,
then closes the health pool. The manifest gives the process 40 seconds between `SIGTERM` and
`SIGKILL`.

Railway gates promotion on `/health/ready` for up to 300 seconds. This is not continuous monitoring:
Railway checks the endpoint while activating a deployment, then stops polling it. Keep the separate
loopback metrics surface private and configure an external uptime/alerting system only after
selecting one operational provider. See [Railway healthchecks](https://docs.railway.com/deployments/healthchecks)
and [deployment teardown](https://docs.railway.com/deployments/deployment-teardown).

## Public hosted health probe

Run one provider-neutral check against a deployed public origin without a browser or credentials:

```powershell
$env:SCHEDULE_HOSTED_HEALTH_ORIGIN = "https://schedule.example.com"
pnpm verify:hosted-health
```

The probe accepts only one canonical HTTPS origin with a DNS hostname, follows no redirects, sends
no cookies or authentication, and applies a fixed ten-second timeout to each sequential request. The
operator or provider remains responsible for choosing the intended public target and its DNS/network
routing. The probe requires exact `200 {"status":"alive"}` and `200 {"status":"ready"}` responses
from `/health/live` and `/health/ready`; failures disclose neither response bodies nor transport
details. This command is a single active check suitable for a provider scheduler. It does not
schedule itself, retain history, route alerts, inspect worker metrics, or prove the authenticated
product flow.

## Release order

The API pre-deploy command runs the built migration entry point. A non-zero migration exit stops
that API deployment before traffic moves. The worker deliberately does not run migrations, avoiding
two services racing the same ledger.

Migration `0041` leaves global work-item capture disabled. The first OIDC API startup performs the
database's one-way enrollment before returning the app to its listener; failure stops startup. Treat
that first hosted start as irreversible for the database and schedule bounded retention before it.

For the first release, deploy the API and wait for `/health/ready` before deploying the worker.
Railway promotes the worker only after its readiness succeeds, but the new process may claim work
while promotion is still pending. Outbox leases, fencing tokens, and insert-only reminder
materialization already support this brief multi-replica overlap; the healthcheck is not a leader
election mechanism. Railway has no Compose-style cross-service `depends_on`, so later migrations must use
backward-compatible expand/contract changes. Pause worker autodeploy and release it after the API
when a change cannot satisfy that rule.

Railway deployment health checks are promotion checks, not continuous monitoring. Monitor public
`/health/live` and `/health/ready` separately, and alert on repeated restarts, migration failures,
database saturation, and worker queue growth.

## Backup and rollback

Enable managed backup retention and point-in-time recovery for PostgreSQL, then perform a restore
drill before production. Record recovery-point and recovery-time targets. The local Compose restore
scripts are not a hosted recovery mechanism. Hosted backups must include the work-item sync capability
singleton, state, change log, migration ledger, row fence, enum, and initializer/capture/protection
functions and triggers; restoring only current work items loses the cursor/change-history boundary and
is not a valid protocol recovery.

Schedule does not prune sync history automatically. Run the bounded `pnpm hosted-sync:cleanup`
procedure from [HOSTED_SYNC.md](./HOSTED_SYNC.md) through an explicitly scheduled operator job, choose
a retention window longer than the supported client-disconnection interval, and alert on repeated
`410 hosted_sync.cursor_expired` responses or sustained change-log growth.

Rollback application code by promoting the previous API and worker images together. Do not reverse
schema migrations in place during an incident. Expand/contract migrations should keep the previous
application version usable; use a tested database restore only for data or incompatible-schema
recovery.

## Verification

Before attaching a production domain:

1. Run `pnpm check`, `pnpm verify:hosted-work-item-sync`, and `pnpm verify:oci-runtime` locally.
2. Deploy staging with production-shaped variables and a separate database.
3. Run `pnpm verify:hosted-staging` with the exact staging host/workspace confirmations; it checks
   `/health/live`, `/health/ready`, manual real-OIDC login, session, workspace discovery, Today,
   the sync-backed work-item view, capture, Done, and logout through public HTTPS. The browser view
   uses an in-memory bootstrap followed by mutation-triggered deltas; this does not prove offline or
   background synchronization.
4. Force a failed migration and confirm the previous deployment remains active.
5. Run `pnpm verify:oci-runtime`, then use only a provider-approved staging database drill to confirm
   API liveness remains available while readiness fails, the worker exits nonzero, the schema
   survives, API readiness recovers without an API restart, and a restarted worker becomes ready.
6. Restore the latest backup into an isolated database and run the database verification suite.

## Operator-assisted staging gate

`pnpm verify:hosted-staging` is a headed, mutation-capable, staging-only launch gate. It refuses
common CI markers, requires one exact canonical HTTPS host containing `staging` or `smoke`, an
operator-designated workspace prefixed with `staging` or `smoke`, and an exact host/workspace
mutation confirmation. It accepts no identity-provider credentials, opens a fresh
browser profile, and requires the operator to complete the real OIDC login manually. It then checks
health, session, workspace selection, Today, the sync-backed work-item view, create, Done, and
logout. It stores no trace, screenshot, or video, and deliberately leaves one completed, auditable
work item in that dedicated workspace: there is no cleanup route.

This gate exists but has not been executed here against external staging. It is not CI evidence:
CI cannot exercise a public HTTPS ingress or external OIDC. It makes no claim of live production,
provider monitoring, backup restore, a deployed offline client, or broad synchronization.

Railway references: [config as code](https://docs.railway.com/config-as-code),
[pre-deploy commands](https://docs.railway.com/deployments/pre-deploy-command),
[health checks](https://docs.railway.com/deployments/healthchecks),
[private networking](https://docs.railway.com/private-networking), and
[variables](https://docs.railway.com/variables).
