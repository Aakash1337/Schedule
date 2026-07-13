# Local operations

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
`pnpm verify:database` and the PostgreSQL CI job. `schedule.changed.v1` is only an invalidation; the
Hermes/WhatsApp adapter, reminder decisions, phone transport, and end-to-end receipts remain
deferred. A successful test or invalidation delivery does not imply those systems exist.

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
