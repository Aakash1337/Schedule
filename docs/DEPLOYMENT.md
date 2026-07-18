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

## Release order

The API pre-deploy command runs the built migration entry point. A non-zero migration exit stops
that API deployment before traffic moves. The worker deliberately does not run migrations, avoiding
two services racing the same ledger.

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
scripts are not a hosted recovery mechanism.

Rollback application code by promoting the previous API and worker images together. Do not reverse
schema migrations in place during an incident. Expand/contract migrations should keep the previous
application version usable; use a tested database restore only for data or incompatible-schema
recovery.

## Verification

Before attaching a production domain:

1. Run `pnpm check` and `pnpm verify:oci-runtime` locally.
2. Deploy staging with production-shaped variables and a separate database.
3. Confirm `/health/live` and `/health/ready`, then complete login, callback, workspace discovery,
   hosted Today/backlog reads, capture, authorized work creation/status update, idempotent Today
   completion, logout, and session revocation through public HTTPS.
4. Force a failed migration and confirm the previous deployment remains active.
5. Stop PostgreSQL and confirm readiness fails while liveness remains available.
6. Restore the latest backup into an isolated database and run the database verification suite.

Railway references: [config as code](https://docs.railway.com/config-as-code),
[pre-deploy commands](https://docs.railway.com/deployments/pre-deploy-command),
[health checks](https://docs.railway.com/deployments/healthchecks),
[private networking](https://docs.railway.com/private-networking), and
[variables](https://docs.railway.com/variables).
