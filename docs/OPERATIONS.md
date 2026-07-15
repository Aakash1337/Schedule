# Local operations

## Production-image runtime smoke

Run `pnpm verify:oci-runtime` before selecting or deploying to a cloud provider. The disposable
verification builds the repository's API and worker OCI images, migrates a temporary PostgreSQL
database from the built API image, and proves production health/readiness, disabled product and
integration routes, loopback-only worker diagnostics, and graceful worker shutdown. It uses no
provider credentials or persistent volume and removes its uniquely named Compose project and images
on completion.

This is a runtime portability gate, not a hosted deployment. It does not enable browser
authentication, public product routes, managed backups, monitoring, TLS, synchronization, or any
specific AWS, Cloudflare, Railway, Oracle, or other provider configuration.

This guide covers backup, restore, rollback, and database verification for the loopback-only Docker
Compose PostgreSQL service. These procedures protect the local MVP; they are not a substitute for
managed backups, point-in-time recovery, encryption, and access controls in a hosted deployment.

## Backup before migration

Always back up an existing database **before** applying pending migrations or upgrading code:

```powershell
pnpm infra:up
pnpm db:backup
pnpm db:migrate
```

`db:backup` uses `pg_dump` inside the PostgreSQL 17 Compose service. It writes a compressed
custom-format archive and asks `pg_restore` to read its catalog. Success requires definitions and
data sections matching every application table in the source database, the
`drizzle.__drizzle_migrations` ledger, and definition / value-set entries matching every source
Schedule sequence. This source-derived catalog check allows a valid backup before pending migrations
without silently accepting a filtered archive. The default location is:

```text
~/.schedule/backups/schedule-<UTC timestamp>.dump
```

Set `SCHEDULE_BACKUP_DIR` to choose a different default directory, or choose one archive path for a
single run:

```powershell
pnpm db:backup -- --output D:\Backups\schedule-before-upgrade.dump
```

The command refuses to overwrite an existing file and removes an incomplete new archive after a
failed dump or verification. Newly created backup directories and files request private POSIX modes
`0700` and `0600`. Node file modes do not establish Windows ACLs, so on Windows the selected backup
directory must be private to the current account through NTFS permissions or encrypted storage.

The database URL and password are never passed as command arguments or printed. The archive itself
contains personal application data and is **not encrypted**. Keep at least one recent copy off the
development machine, protect it with storage encryption and access controls, and periodically delete
archives that are no longer required.

Only restore archives created by this tool and kept under your control. PostgreSQL restore archives
contain executable database definitions; they are not a safe interchange format for untrusted files.
For a restore, the selected path must be a non-empty, non-symlink regular file. The command copies
that file from one opened handle into an exclusive private temporary snapshot and uses only the
snapshot for catalog validation and `pg_restore`. Replacing or rewriting the original path after
snapshot creation cannot change the bytes being restored. The snapshot is removed before database
promotion; requested POSIX modes are `0700` for its directory and `0600` for the file. As with backup
files, Windows confidentiality still depends on the current account's temporary-directory ACLs.

`pg_dump` takes a transactionally consistent snapshot while the app is running. For the clearest
recovery point, stop the API and worker or stop `pnpm dev` before an important backup.

## Verify the complete archive path

With the Compose PostgreSQL service running, the current migrations applied, and the app stopped:

```powershell
pnpm verify:backup-restore
```

The verifier creates a temporary private archive, restores it into a uniquely named disposable
database, and validates:

- empty, plain-SQL, truncated, schema-only, and migration-ledger-filtered inputs are rejected without
  changing the active database or creating recovery-role databases;
- replacing the caller-controlled archive after private snapshot creation does not change the
  verified bytes supplied to `pg_restore`;
- the exact expected public application-table set;
- the exact expected application-sequence set and every sequence's `last_value` / `is_called` state;
- a supported ordered Drizzle migration-identity/timestamp sequence and the current migration count;
- a deterministic schema signal covering columns, constraints, indexes, triggers, functions, and
  enums;
- deterministic row-count and content hashes for every application table and the migration ledger.

It then drops the disposable database and removes the temporary archive. It never replaces the main
`schedule` database. Avoid writes during this check, because an intentional concurrent source change
makes source-to-restore comparison ambiguous.

## Verify the recovery state machine

The complete restore, promotion, rollback, and cleanup path has a separate destructive verifier. Its
launcher establishes two test-only guards and operates only on five exact, nonce-bound
`schedule_recovery_*` database names:

```powershell
pnpm verify:recovery-state-machine
```

The launcher refuses a conflicting pre-existing `NODE_ENV` or recovery sentinel. The underlying
verifier still checks both guards before it can create a database.

The verifier creates and migrates a disposable active database, adds a private marker, backs up that
database, and first proves that a malformed restore input leaves its OID, content, and all recovery
roles unchanged. A second valid-but-incompatible archive is restored into staging and deliberately
fails post-restore schema validation, proving OID-bound staging cleanup without altering the active
database. It then changes the live disposable marker, runs the real staged restore and promotion,
proves the archived state is active while the newer state is retained with connections disabled,
runs the real rollback, and proves both database identities, content signals, and connection states
were exchanged correctly. It then exercises the supported cleanup path. A final independent cleanup
pass inspects and removes every generated role database and temporary archive even if an earlier
assertion fails. A name that existed before the verifier began is never treated as owned or removed.

This command never names or replaces the real `schedule` database. The generated plan must contain
five distinct role names bound to one 128-bit nonce, and startup is refused if any role already
exists. Run it only against a disposable local PostgreSQL instance; GitHub CI supplies a fresh,
job-scoped Compose project and tears down its volume afterward. It verifies the mechanics, but it
does not replace user inspection before accepting a restore of real data.

## Restore and pre-swap validation

Restoring is intentionally refused unless the Compose service is healthy, the archive has the full
Schedule catalog, the active `schedule` database is already on the current migration set, and this
exact confirmation is supplied. Requiring a current active database guarantees the retained rollback
copy is independently valid under the current code:

```powershell
pnpm db:restore -- C:\Users\you\.schedule\backups\schedule-<timestamp>.dump --confirm=replace-schedule
```

Stop the API, worker, web development process, database studio, and other clients first. The command:

1. Creates and verifies one private immutable snapshot of the chosen archive.
2. Restores that snapshot into a unique staging database, then removes the snapshot before any
   promotion can begin.
3. Validates every expected table and the migration ledger.
4. Runs the current migrations against staging.
5. Compares staging's full schema signal to a separate freshly migrated reference database.
6. Runs the real PostgreSQL planner, product API, isolated outbox lease/fencing, and disposable
   weekday-migration upgrade verifiers against the same PostgreSQL server.
7. Restores verifier-only sequence movement and confirms no application-table, ledger, or sequence
   changes remain.
8. Revalidates the complete schema and ordered migration identities.
9. Disables connections briefly and promotes staging to `schedule`.

Generated staging ownership is bound to its PostgreSQL OID and rechecked before connection changes,
session termination, and removal. This protects against stale or accidentally reused names, but it
is not a security boundary against another concurrent process using the same PostgreSQL superuser or
the same operating-system account. The local procedure requires those credentials and the backup
directory to remain under one user's control; hosted deployment must use separate restricted runtime,
migration, and recovery roles.

The staging `DATABASE_URL` exists only in the child-process environment. It is redacted from captured
failure output and is never placed in command arguments.

The former database is **not deleted**. It is renamed to an exact safe identifier such as
`schedule_previous_<id>`, retained with connections disabled, and printed with both the acceptance
cleanup and rollback commands. Record that exact identifier before restarting the app.

## Accept a restore

Start the app, inspect important routines, plans, history, work items, and calendar blocks, and only
then accept the restore. Stop the app again and use the exact identifier printed by `db:restore`:

```powershell
pnpm db:restore:cleanup -- schedule_previous_<exact-id> --confirm=drop-retained-database
```

Cleanup accepts only exact tool-generated identifiers with a 32-character lowercase hexadecimal
suffix, including `schedule_previous_*`, `schedule_rejected_*`, and reported disposable
`schedule_restore_*`, `schedule_schema_*`, or `schedule_verify_*` failures. It can never match
`schedule`. After exact confirmation it disables connections, terminates remaining sessions, and
drops only that generated identifier.

## Roll back a restore

If post-restore inspection fails, stop all app and database clients and use the retained identifier
printed by the restore:

```powershell
pnpm db:restore:rollback -- schedule_previous_<exact-id> --confirm=rollback-to-retained
```

Rollback promotes the retained database back to `schedule`. The rejected restored database is kept
with connections disabled under a new `schedule_rejected_<id>` identifier. After validating the
rolled-back app, remove that rejected database explicitly with the cleanup command and exact printed
identifier.

Swap and rollback compensation steps are attempted independently. If automatic recovery is
incomplete, the error preserves the original failure, every compensation failure, and the exact
`schedule`, previous, staging, or rejected identifiers. It also prints inspection and manual rename /
connection-enable commands. Do not drop any named database in that state; stop clients, inspect
`pg_database`, and follow the printed commands in order.

## Optional local-model advisor

The advisor is disabled by default and is not required for planning, application startup, health, or
readiness. Enabling it permits one explicit Today action to send a bounded plan-and-backlog snapshot
to a local Ollama process. Keep Ollama bound to loopback: its local API has no Schedule credential or
authentication layer, and this integration is not designed for a container hostname, LAN address,
remote tunnel, or hosted endpoint.

Install Ollama separately, make one allowlisted model available, and test it with Ollama's own CLI.
The supported model names are exactly `gemma4:e2b`, `gemma4:e4b`, `gemma4:26b`, and `gemma4:31b`;
the Schedule default is `gemma4:e4b`. Then set the API process environment and restart it:

```dotenv
LOCAL_MODEL_ADVISOR_MODE=ollama
LOCAL_MODEL_ADVISOR_URL=http://127.0.0.1:11434
LOCAL_MODEL_ADVISOR_MODEL=gemma4:e4b
LOCAL_MODEL_ADVISOR_CONNECT_TIMEOUT_MS=2000
LOCAL_MODEL_ADVISOR_REQUEST_TIMEOUT_MS=60000
LOCAL_MODEL_ADVISOR_MAX_RESPONSE_BYTES=32768
LOCAL_MODEL_ADVISOR_MAX_CONCURRENT=1
```

The URL is deliberately stricter than an ordinary URL field. Its raw value must be exactly
`http://127.0.0.1:<port>` with a decimal port from 1 through 65,535: no trailing slash, DNS name,
alternate numeric address, IPv6 literal, credentials, path, query, fragment, or HTTPS endpoint is
accepted. Connection timeout is 100–10,000 ms; request timeout is 1,000–120,000 ms and must be at
least the connection timeout; response capacity is 1,024–65,536 bytes; and concurrency is 1–4.
A first cold model load can take materially longer than a warm request on the same machine. If an
otherwise healthy local model exceeds the 60-second default, verify it directly with Ollama and then
raise the request timeout only within the 120-second bound; do not remove the timeout or assume one
observed load time applies to every model or host.

Schedule makes one direct `/api/chat` request per explicit click and never follows redirects, uses a
proxy, supplies tools, or retries automatically. It sends only the sanitized bounded context
documented in [PRODUCT.md](./PRODUCT.md), requests structured output with thinking disabled, and
discards raw provider envelopes and metadata. Schedule does not persist model prompts, responses, or
advice. The visible advice remains browser-session state and has no Apply path. Model availability
therefore must never be used as a durability, authentication, or planner-correctness dependency.

With Ollama running and the configured model present, run the opt-in real-provider smoke check:

```powershell
$env:LOCAL_MODEL_ADVISOR_MODE = "ollama"
$env:LOCAL_MODEL_ADVISOR_URL = "http://127.0.0.1:11434"
$env:LOCAL_MODEL_ADVISOR_MODEL = "gemma4:e4b"
pnpm verify:local-model-advisor
```

The verifier uses the production adapter with one deterministic synthetic plan item and one backlog
item, checks that the adapter did not mutate its input, revalidates the strict output relationships,
and, on success, prints only provider, model, latency, and suggestion count. A failed provider call
prints only one fixed allowlisted unavailable reason; it never prints schedule or model-generated
content. This manual command is separate from normal CI and must not be interpreted as a model-quality
benchmark or a database/API end-to-end test. The CI suite uses deterministic loopback fakes to test
the verifier, transport, and validation boundaries; it does not download, start, or invoke Ollama.

Troubleshooting is intentionally fail-closed:

- `disabled`: set `LOCAL_MODEL_ADVISOR_MODE=ollama` and restart the API only if local advice is
  desired.
- `unreachable`: confirm Ollama is listening on the exact configured loopback port and the model is
  present; do not weaken the origin validation.
- `timeout`: verify the model can answer locally, then adjust the bounded request timeout if the
  machine needs more inference time. Schedule does not retry the request.
- `busy`: wait for the active local review to finish or, after measuring host capacity, raise the
  concurrency limit within its bound.
- `provider_rejected`, `response_too_large`, `malformed_response`, or `invalid_advice`: inspect the
  local Ollama service independently. Schedule deliberately exposes no raw response body or hidden
  reasoning.
- `409 advisor.snapshot_conflict`: the plan or eligible backlog changed during inference. Review the
  refreshed Today state and click again only if another review is useful.

Set `LOCAL_MODEL_ADVISOR_MODE=disabled` and restart the API for the kill switch. The advisor route
then returns a safe unavailable result without opening a network connection; the rest of Schedule is
unchanged.

## Local natural-language proposal drafting

Proposal drafting is independently disabled. It uses the advisor's same strict loopback URL, model
allowlist, timeouts, response limit, and shared concurrency permit, but it may be enabled while the
Today advisor remains disabled. Configure a stable secret of at least 32 bytes and a lifetime from 60
through 3,600 seconds:

```dotenv
LOCAL_MODEL_PROPOSAL_MODE=ollama
LOCAL_MODEL_PROPOSAL_HMAC_KEY=replace-with-stable-random-secret-material
LOCAL_MODEL_PROPOSAL_TTL_SECONDS=600
LOCAL_MODEL_ADVISOR_URL=http://127.0.0.1:11434
LOCAL_MODEL_ADVISOR_MODEL=gemma4:e4b
```

Generate the HMAC key with an operating-system secret generator and keep it outside source control,
logs, backups of configuration text, and screenshots. Schedule uses it only for domain-separated
prompt fingerprints; raw prompts and free-form model prose are not stored. Do not rotate the key
while generation is enabled and pending proposals may exist: disable proposal mode, wait at least the
configured TTL (at most one hour), rotate the secret, and restart. Existing confirmations do not
need the original key, but replaying an old generation request after rotation cannot match its prior
fingerprint.

Migration `0028` creates `natural_language_proposals`, and the table is part of the exact backup and
restore catalog. Back up before migration. After applying it, run the real concurrency verifier:

```powershell
pnpm db:migrate
pnpm verify:natural-language-proposals
```

The verifier does not call Ollama. It uses production PostgreSQL repositories from two independent
connection pools and checks private persistence, tenant isolation, same-key replay, competing-key
conflict, and exactly one result/audit. The browser verifier starts a strict loopback model double and
exercises the production adapter and UI. A real provider can be checked manually through the Work
view after Ollama itself is healthy; this is usability smoke testing, not a correctness or quality
gate.

Set `LOCAL_MODEL_PROPOSAL_MODE=disabled` and restart the API for the generation kill switch. Pending
proposals remain short-lived rows but cannot be reached through a list/read API; ordinary structured
capture and every deterministic feature remain available. If confirmation reports a conflict, do not
change keys and retry blindly: refresh the Work board and verify whether the deterministic result
already exists. Expired or cancelled proposals must be prepared again with a new request ID.

See [NATURAL_LANGUAGE.md](./NATURAL_LANGUAGE.md) for the full authority and privacy boundary.

## Outbound webhook operations

Outbound webhook delivery is disabled by default. Provision its external encryption keyring and
endpoint records while it remains disabled, verify the receiver, and only then enable the worker.
The complete security boundary, signing contract, commands, and rotation procedure are in
[WEBHOOKS.md](./WEBHOOKS.md).

The supported endpoint workflow is CLI-only:

```powershell
pnpm webhooks -- generate-master-key --id primary
pnpm webhooks -- create --workspace <workspace-uuid> --name "Hermes bridge" --url https://hooks.example.com/schedule
pnpm webhooks -- send-test --workspace <workspace-uuid> --endpoint <endpoint-uuid>
pnpm webhooks -- list-subscriptions --workspace <workspace-uuid> --endpoint <endpoint-uuid>
pnpm webhooks -- replace-subscriptions --workspace <workspace-uuid> --endpoint <endpoint-uuid> --events schedule.changed.v1 --confirm replace-automatic-subscriptions
pnpm webhooks -- replace-subscriptions --workspace <workspace-uuid> --endpoint <endpoint-uuid> --events none --confirm replace-automatic-subscriptions
pnpm webhooks -- dead-letters --workspace <workspace-uuid>
pnpm webhooks -- redrive --workspace <workspace-uuid> --delivery <delivery-uuid>
```

Keep `WEBHOOK_DELIVERY_MODE=disabled` during initial provisioning. Store `WEBHOOK_MASTER_KEYS`
outside PostgreSQL and outside the repository, and keep every still-referenced old master key. A
missing master key cannot decrypt an endpoint's stored envelope, so the worker fails that delivery
closed. The one-time endpoint signing secret printed after creation or rotation belongs at the
receiver and cannot be recovered from the database alone.

Every endpoint begins with no automatic subscriptions. After a signed test succeeds, configure the
receiver with a workspace-scoped integration credential and verify it can read
`GET /v1/integrations/today?date=<YYYY-MM-DD>`. Then inspect and deliberately replace the complete
subscription set. `replace-subscriptions` is intentionally destructive and accepts only the literal
`--confirm replace-automatic-subscriptions`; use `--events schedule.changed.v1` to enable the
privacy-thin invalidation or `--events none` to stop future automatic event creation. Re-list after
every change and record the opaque endpoint ID in the change ticket.

`WEBHOOK_DELIVERY_MODE=disabled` is the global transport kill switch. After the worker restarts in
that mode, it excludes webhook deliveries from both claiming and recovery, so it makes no network
attempts and does not spend their retry or dead-letter budget. It does not remove subscriptions or
queued deliveries. Committed Today-head changes still enqueue durable invalidations for subscribed
endpoints. Before re-enabling, inspect pending age and receiver readiness; deliveries older than the
configured maximum age fail closed once processing resumes. If an outage will be long and new
events are not wanted, replace each endpoint's subscription set with `none` as well.

For a delivery incident:

1. Leave endpoint and secret history intact; list workspace-scoped dead-letter metadata.
2. Check the receiver using its own logs and the opaque delivery ID. Schedule intentionally does not
   print endpoint URLs, request or response bodies, signatures, DNS answers, key material, or raw
   network exceptions in worker failures.
3. Correct the receiver, DNS, certificate, or key configuration. Do not bypass the public-HTTPS DNS
   policy to reach a private Hermes process; that requires a separate authenticated transport.
4. Redrive the existing delivery. Redrive preserves the delivery ID, exact body, destination, and
   secret version, so the receiver must deduplicate it.
5. Revoke the endpoint if its destination or receiver secret may be compromised. Create a replacement
   endpoint for a URL change; rotate through the staged prepare/activate commands for a secret change.

After webhook persistence or migration changes, run the disposable PostgreSQL verifier:

```powershell
pnpm verify:webhook-delivery
```

The verifier covers workspace isolation, encrypted-envelope constraints, rotation, subscription
replacement, privacy-thin automatic event fan-out, immutable body and outbox linkage, audit records,
dead-letter redrive, revocation, and transactional rollback. It is also part of
`pnpm verify:database` and the PostgreSQL CI job. `schedule.changed.v1` is only an invalidation; it
does not transport reminder commands. Reminder claim/receipt state uses a separate authenticated
pull gateway. The dormant [Hermes adapter foundation](./HERMES.md) consumes that contract, but its
concrete transport, durable shared store, provider/account binding, polling process, and phone
verification remain deferred. A successful webhook test or invalidation delivery does not imply
those systems exist.

## Deterministic reminder operations

Worker liveness, readiness, aggregate queue gauges, materialization counters, and initial alert
guidance are specified in [Worker observability](./OBSERVABILITY.md). The surface is disabled by
default, binds only to `127.0.0.1`, and deliberately exposes no workspace, content, destination, or
provider labels.

Migration `0024` adds `notification_profiles`, `notification_rules`, `one_off_reminders`, and
`notification_intents`. The delivery migration adds `notification_delivery_commands`,
`notification_delivery_attempts`, and `notification_delivery_requests`. All seven tables are part
of the exact backup catalog and restore-content signal. Back up before applying migrations, then run:

```powershell
pnpm db:migrate
pnpm verify:notification-core
pnpm verify:notification-materializer
pnpm verify:notification-delivery
pnpm verify:notification-migrations
pnpm verify:backup-restore
```

`verify:notification-core` uses the production local API and repositories. It creates every rule
source and a one-off, launches two materializers concurrently, proves one intent per occurrence,
checks cross-tenant source/target, rule-kind, and duplicate-key rejection, proves source/target edits
and terminal activity invalidate the correct pending intents, proves target deletion cleanup, and
confirms the outbox count is unchanged.
`verify:notification-migrations` creates a nonce database, migrates it only through `0023`, seeds
legacy data, applies each reminder migration in order, validates constraints and populated upgrades,
and drops the database. `verify:notification-delivery` creates a separate nonce database and drives
the real authenticated Fastify routes through claim, exact replay, retry, expiry, recovery,
invalidation, dead letter, receipt fencing, and a credential-revocation lock race. The migration and
delivery verifiers also assert the partial expired-lease recovery index. These commands are also
inside `verify:database`.

Automatic local materialization is disabled by default. Leave
`NOTIFICATION_MATERIALIZATION_MODE=disabled` while policy is being provisioned. To enable it, set
the mode to `enabled`, keep `NOTIFICATION_MATERIALIZATION_INTERVAL_MS` between 10 seconds and one
hour, keep `NOTIFICATION_MATERIALIZATION_LOOKAHEAD_MS` between one second and one hour, and restart
the worker. The defaults are a 60-second interval and five-minute look-ahead. This switch creates
Schedule intents only; it does not enable webhook transport, claim the delivery gateway, or contact
a provider.

Each tick processes at most 20 workspaces sequentially. It passes one captured look-ahead window to
the application use case, which applies each profile's own bounded catch-up horizon. Monitor the
structured `notification_materialization_tick_completed` count fields and the
fixed `notification_materialization_workspace_list_failed` /
`notification_materialization_workspace_failed` classifications. A
`notification_materialization_workspace_limit_exceeded` classification means persisted data
violates the 20-workspace local-installation cap; the tick intentionally creates no intents until the
invariant is restored. Logs intentionally omit titles,
policy contents, occurrence keys, destinations, and raw exceptions. A SIGINT/SIGTERM prevents the
next workspace or tick and waits for an already-running materialization transaction to settle before
the shared database pool closes. Disable the mode and restart the worker to stop new automatic
ticks; persisted intents remain subject to normal policy/source invalidation.

Manual materialization remains available through the local product API. Use a window no longer than
31 days and inspect all three result groups: `created`, `existing`, and `suppressed`.
Repeated or concurrent invocation is safe. Policy and target changes never rewrite an intent; they
transactionally delete affected pending intents under the same workspace notification lock. Deleting
a referenced daily plan, schedule block, or work item also invalidates its open delivery command and
removes the source intent so it cannot later be claimed against a missing target.

`verify:notification-materializer` creates and migrates a disposable database, runs two production
cycles concurrently through independent pools, repeats a restart cycle, and proves exact-once
intents, catch-up acceptance/suppression, safe unconfigured-workspace skips, and unchanged
outbox/delivery-command counts. It drops
the nonce database even on failure and is included in `verify:database`.

The provider-neutral delivery routes are pull-based and require an explicitly `schedule:delivery`
credential; the default credential scopes do not grant delivery. Each claim leases one command for
five minutes by default, creates a new fencing token, and exposes the stable delivery ID as the
adapter dedupe key. Receipt outcomes are bounded metadata only. Schedule stores no destination,
provider response, conversation, account, or raw exception. PostgreSQL time is authoritative for
due checks, lease expiry, retry availability, and receipts. Final claim/receipt authorization
row-locks the credential after the workspace lock; revocation uses the same row lock and therefore
cannot commit invisibly between final authorization and the delivery mutation.

Operational adapters must persist dedupe IDs before causing external side effects. A process crash
after a provider accepts a message but before Schedule commits the receipt can cause the same
delivery ID to be claimed with a new token. A second instance must share the same dedupe store.
Repeated `claim` and `receipt` calls must use the original idempotency key only for exact replay; use
a new key for the next poll or changed outcome. `dead_letter` is terminal in this slice and has no
redrive command. Inspect it through database-safe operational metrics only; do not log provider or
recipient data.

Source invalidation before claim prevents delivery. Invalidation after claim prevents reclaim, but
cannot retract an already-running external side effect. A receipt before the original lease expires
records the attempt while the command stays `invalidated`; otherwise later claim maintenance closes
the abandoned attempt as `lease_expired`. Treat this claim-commit interval as an unavoidable race,
not proof a message did or did not leave the adapter.

Profile `enabled: false` is the policy kill switch. The versioned update invalidates existing pending
intents and open commands and suppresses new candidate evaluation, but does not erase the profile,
rules, or one-offs and cannot retract an in-flight provider side effect. External transport needs
its own adapter-side kill switch when implemented. See
[REMINDERS.md](./REMINDERS.md).

## Routine verification

For an existing database, preserve the backup-before-migration order:

```powershell
pnpm check
pnpm infra:up
pnpm db:backup
pnpm db:migrate
pnpm verify:database
pnpm verify:backup-restore
```

`verify:database` includes the dormant hosted-identity persistence and populated migration drills.
They prove exact concurrent identity provisioning, bounded exact identity keys, digest-only session
storage, rotation and revocation boundaries, binary membership authorization including
post-revocation fencing, hosted workspace provisioning beyond the local worker cap, and
preservation of workspace/product data when a user is deleted. These checks do not enable hosted
authentication or change the local API boundary; see [HOSTED_IDENTITY.md](./HOSTED_IDENTITY.md) and
[HOSTED_AUTHORIZATION.md](./HOSTED_AUTHORIZATION.md).

Run the separately guarded `pnpm verify:recovery-state-machine` command from the preceding section
when testing against a disposable PostgreSQL instance.

GitHub CI keeps static checks and PostgreSQL integration checks in separate jobs. The integration job
starts a fresh PostgreSQL 17 Compose project, applies every migration, and runs the planner, local
product API, integration gateway, outbox lease/fencing, outbound webhook, plan-state and
weekday-migration upgrades, complete archive round-trip, and recovery state-machine verifiers.
Diagnostics are captured on failure, and the job always removes the disposable database volume.

Migration `0012` adds weekday range, uniqueness, and exclusion/preference overlap constraints. It
removes out-of-range legacy values, deduplicates in first-occurrence order, and resolves overlaps in
favor of exclusion because exclusion is the hard scheduling boundary.

Migration `0013` adds one-dimensional-array constraints. PostgreSQL legacy multidimensional weekday
arrays are flattened in row-major traversal order before the constraints are added. Migration `0012`
has already guaranteed their range, uniqueness, and disjointness, so every valid weekday is retained.
Migration `0014` also canonicalizes non-1 array lower bounds and requires non-empty arrays to be
one-dimensional with lower bound 1, matching the shape returned by the PostgreSQL client. Empty
arrays remain valid. Current domain and API writes already create canonical arrays.

## Current boundary

These scripts intentionally target the current Compose service, database, and role:

- service: `postgres`
- database: `schedule`
- role: `schedule`

Custom-format PostgreSQL archives are recovery artifacts, not portable user exports. A stable,
versioned JSON or CSV import/export format remains deferred.

Do not reuse the Compose credentials or these destructive local commands for a hosted environment.
A hosted release needs provider-managed backup retention and restore drills, separate runtime and
migration roles, TLS, secret management, observability, and a documented disaster-recovery target.
