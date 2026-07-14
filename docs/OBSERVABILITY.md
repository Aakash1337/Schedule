# Worker observability

Schedule has an optional, provider-neutral operational surface for the local worker. It exposes
process liveness, database-backed readiness, and fixed-cardinality Prometheus text metrics without
including workspace IDs, task or reminder titles, occurrence keys, destinations, credentials,
provider references, payloads, or raw failures.

This surface is disabled by default and always binds to IPv4 loopback. It is an operator diagnostic
boundary, not a public product API and not end-user authentication.

## Enabling the loopback surface

Set these values for the worker process and restart it:

```dotenv
WORKER_OBSERVABILITY_MODE=loopback
WORKER_OBSERVABILITY_PORT=9464
```

The port is validated from 1 through 65535. The bind address is not configurable: it is always
`127.0.0.1`. To disable the listener, restore `WORKER_OBSERVABILITY_MODE=disabled` and restart the
worker.

The three read-only routes are:

- `GET /health/live`: returns `200 {"status":"alive"}` while the listener can serve requests. It
  does not query PostgreSQL.
- `GET /health/ready`: returns `200 {"status":"ready"}` only after a fresh PostgreSQL health query,
  otherwise `503 {"status":"not_ready"}`. It never returns the database error.
- `GET /metrics`: returns Prometheus 0.0.4 text. A database collection failure still returns the
  in-process metrics with `schedule_worker_database_up 0`; every database-backed gauge is `NaN`,
  preventing an outage from looking like an empty queue.

All responses use `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`. The server sends
no CORS headers, accepts only `GET`, and shuts down from the worker's shared abort signal. It uses a
dedicated one-connection, read-only PostgreSQL pool rather than consuming the primary outbox or
materialization pool. Both readiness and aggregate queries have a five-second client response
deadline backed by a PostgreSQL statement timeout, which is the authoritative query cancellation
mechanism. A bind, listener, or query failure emits only a
fixed diagnostic classification; primary outbox and reminder processing continues.

Example local checks:

```powershell
Invoke-RestMethod http://127.0.0.1:9464/health/live
Invoke-RestMethod http://127.0.0.1:9464/health/ready
Invoke-WebRequest http://127.0.0.1:9464/metrics | Select-Object -ExpandProperty Content
```

## Metric contract

Metric names are fixed and have no labels. This deliberately trades dimensional drill-down for a
strict cardinality and privacy boundary. Concurrent scrapes share one aggregate database collection
so they cannot multiply the same query while it is in flight. The dedicated observability pool and
deadline also bound the connection pressure of a stalled or over-frequent scraper.

### Process and database

- `schedule_worker_uptime_seconds`
- `schedule_worker_database_up`
- `schedule_worker_database_collection_failures_total`

### Outbox execution

- `schedule_outbox_claimed_total`
- `schedule_outbox_completed_total`
- `schedule_outbox_retried_total`
- `schedule_outbox_dead_lettered_total`
- `schedule_outbox_stale_claims_total`
- `schedule_outbox_lease_renewal_failures_total`
- `schedule_outbox_shutdown_deadlines_total`
- `schedule_outbox_ready`
- `schedule_outbox_processing`
- `schedule_outbox_dead_letter`
- `schedule_outbox_oldest_ready_age_seconds`

Process counters reset when the worker restarts. Queue gauges are a fresh aggregate PostgreSQL
snapshot. “Ready” means the persisted availability time is no later than PostgreSQL's captured
clock and the event topic is claimable by this worker configuration; future retries and disabled
webhook-delivery topics do not inflate ready age.

### Notification materialization

- `schedule_notification_materialization_cycles_total`
- `schedule_notification_materialization_workspace_failures_total`
- `schedule_notification_materialization_workspace_skips_total`
- `schedule_notification_materialization_list_failures_total`
- `schedule_notification_materialization_limit_exceeded_total`
- `schedule_notification_materialization_aborted_total`
- `schedule_notification_materialization_created_intents_total`
- `schedule_notification_materialization_existing_intents_total`
- `schedule_notification_materialization_suppressed_candidates_total`
- `schedule_notification_materialization_last_completed_timestamp_seconds`
- `schedule_notification_materialization_last_successful_timestamp_seconds`

An unconfigured workspace is an expected skip, not a failed cycle. A success timestamp advances only
when workspace discovery succeeds, the local workspace cap is respected, no unexpected workspace
fails, and shutdown does not interrupt the cycle.

### Provider-neutral reminder delivery

- `schedule_notification_intents_ready`
- `schedule_notification_intents_oldest_ready_age_seconds`
- `schedule_notification_delivery_ready`
- `schedule_notification_delivery_processing`
- `schedule_notification_delivery_dead_letter`
- `schedule_notification_delivery_oldest_ready_age_seconds`
- `schedule_notification_delivery_attempt_records`
- `schedule_notification_delivery_delivered_attempt_records`
- `schedule_notification_delivery_retryable_failure_attempt_records`
- `schedule_notification_delivery_permanent_failure_attempt_records`
- `schedule_notification_delivery_lease_expired_attempt_records`

The attempt-record gauges are retained aggregates from PostgreSQL, so they survive a worker restart
but can decrease when a workspace and its retained history are deleted. They describe Schedule
claim/receipt state only. A `delivered` receipt remains an adapter assertion and is not independently
verified phone delivery. Intent readiness uses the same workspace-plus-occurrence fence as delivery
claiming, so a rematerialized intent cannot appear ready after that occurrence already crossed the
delivery boundary.

## Initial alert guidance

These are starting operational thresholds, not hard-coded product policy:

1. Page or stop rollout when `schedule_worker_database_up == 0` for two consecutive minutes.
2. Investigate any increase in `schedule_outbox_dead_lettered_total`, any nonzero
   `schedule_outbox_dead_letter`, or any nonzero `schedule_notification_delivery_dead_letter`.
3. Warn when `schedule_outbox_oldest_ready_age_seconds` exceeds five minutes. Raise the threshold
   deliberately if a configured transport has a longer documented outage budget.
4. When automatic materialization is enabled, warn if the last-success timestamp is older than the
   greater of five minutes or three configured materialization intervals. Suppress this alert until
   the first cycle has had time to finish.
5. Investigate any increase in workspace/list/limit materialization failures, stale claims, lease
   renewal failures, or shutdown deadlines.
6. When an adapter is expected to poll, warn when ready notification intents or delivery commands
   remain older than the adapter's declared poll and retry budget.

Alert on rates and sustained age, not on ordinary nonzero work queues. Expected unconfigured
workspace skips are diagnostic only.

## Verification and limitations

Run:

```powershell
pnpm verify:worker-observability
```

The verifier creates a nonce database, applies all migrations, seeds private-looking outbox data,
starts the production loopback listener, and proves aggregate queue gauges, fixed metric names,
redaction, health semantics, database-failure signaling, and shutdown. It closes and drops the
database even on failure and is included in `pnpm verify:database`.

This slice does not install Prometheus, retain time-series history, configure a hosted dashboard,
send alerts, expose a public metrics endpoint, or count future browser-authentication failures.
Hosted deployment must keep the listener on an internal/sidecar boundary and add infrastructure
scraping, retention, dashboards, and alert routing separately. Provider/account transport remains a
separate adapter responsibility.
