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

`pg_dump` takes a transactionally consistent snapshot while the app is running. For the clearest
recovery point, stop the API and worker or stop `pnpm dev` before an important backup.

## Verify the complete archive path

With the Compose PostgreSQL service running, the current migrations applied, and the app stopped:

```powershell
pnpm verify:backup-restore
```

The verifier creates a temporary private archive, restores it into a uniquely named disposable
database, and validates:

- the exact expected public application-table set;
- the exact expected application-sequence set and every sequence's `last_value` / `is_called` state;
- a supported ordered Drizzle migration-identity/timestamp sequence and the current migration count;
- a deterministic schema signal covering columns, constraints, indexes, triggers, functions, and
  enums;
- deterministic row-count and content hashes for every application table and the migration ledger.

It then drops the disposable database and removes the temporary archive. It never replaces the main
`schedule` database. Avoid writes during this check, because an intentional concurrent source change
makes source-to-restore comparison ambiguous.

## Restore and pre-swap validation

Restoring is intentionally refused unless the Compose service is healthy, the archive has the full
Schedule catalog, the active `schedule` database is already on the current migration set, and this
exact confirmation is supplied. Requiring a current active database guarantees the retained rollback
copy is independently valid under the current code:

```powershell
pnpm db:restore -- C:\Users\you\.schedule\backups\schedule-<timestamp>.dump --confirm=replace-schedule
```

Stop the API, worker, web development process, database studio, and other clients first. The command:

1. Restores the archive into a unique staging database.
2. Validates every expected table and the migration ledger.
3. Runs the current migrations against staging.
4. Compares staging's full schema signal to a separate freshly migrated reference database.
5. Runs the real PostgreSQL planner, product API, isolated outbox lease/fencing, and disposable
   weekday-migration upgrade verifiers against the same PostgreSQL server.
6. Restores verifier-only sequence movement and confirms no application-table, ledger, or sequence
   changes remain.
7. Revalidates the complete schema and ordered migration identities.
8. Disables connections briefly and promotes staging to `schedule`.

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

GitHub CI keeps static checks and PostgreSQL integration checks in separate jobs. The integration job
starts a fresh PostgreSQL 17 service, applies every migration, and runs the planner, local product
API, outbox lease/fencing, and weekday-migration upgrade verifiers. Backup/restore verification
remains local because it deliberately exercises the repository's Docker Compose service and host
filesystem.

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
