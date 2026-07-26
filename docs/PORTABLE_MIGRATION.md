# Portable data migration

Schedule can move durable local product data between independent installations with one versioned
`.schedule` archive. The archive carries a typed, data-only logical payload, so it can move between
Windows and Linux without copying a PostgreSQL data directory or depending on filesystem layout.

The installed desktop application can create and restore archives through its native **Export
archive** and **Import archive** controls. Operating-system file dialogs and all database credentials
stay outside the renderer. Export verifies an archive before publishing it; import shows a redacted
preview and requires a separate destructive confirmation before replacing local data. The CLI
remains available for repository and recovery workflows. Desktop-to-cloud live sync remains a
future capability.

## Export

In the desktop app, use **Export archive** and choose a new `.schedule` filename. The destination must
not already exist; cancellation leaves the local data unchanged. The export helper reads the live
database consistently, restores the typed payload into an isolated migrated verification database,
compares the normalized result, and only then publishes the archive.

Desktop verification databases carry an exact versioned ownership marker bound to the embedded
PostgreSQL cluster and database name. Cleanup revalidates that marker, the database owner, and
non-template status immediately before deletion; stale unmarked or changed databases are never
reclaimed. During the creating export, Schedule also retains the newly created database OID before
initializing its marker, so a marker-write failure can clean only that exact same-run database.

Publication never replaces an existing file. Filesystems without hard-link support use an exclusive,
verified copy fallback. It durably records an exact intention before creating the destination, writes
incomplete markers, and commits the real archive header last. POSIX publication also syncs directory
entries before reporting success. A crash can leave a fresh incomplete file, so Schedule preserves it
while it may still belong to an active export. After 24 hours, a later attempt can reclaim only exact
marker-owned partials and private export staging artifacts; valid archives and unmarked files are
preserved. If interruption occurs before the final file receives its exact incomplete marker,
Schedule deliberately preserves that unmarked file even when an intention exists. Choose a new
filename for an immediate retry, or delete the partial only after confirming no export is running.

For repository or recovery use, run the same Schedule release that owns the source database and
create the archive with the CLI:

```powershell
pnpm infra:up
pnpm db:migrate
pnpm data:export -- --output E:\ScheduleTransfer\my-schedule.schedule
```

Without `--output`, the archive is written beneath `~/.schedule/exports`. Export refuses to replace
an existing file. Before publishing it, Schedule restores the data into a fresh migrated database
and verifies the resulting schema, rows, sequences, exclusions, and foreign keys.

## Import on another operating system

Install the matching Schedule release on the destination and copy the `.schedule` file through your
normal private transfer method. In the desktop application, choose **Import archive**, review the
archive ID, export time, Schedule version, schema version, and size, then choose **Replace local data
and restart**. The confirmation is bound to both the inspected archive ID and the exact archive-byte
SHA-256, so replacing the file between inspection and confirmation is rejected before any database
mutation.

Import stops the local API and worker while keeping the private PostgreSQL service available. It
restores into a migrated staging database, verifies the restored data, and records each promotion
boundary in a durable journal before replacing the active database. A committed import keeps at
most one identity-checked previous database for recovery. Schedule reconciles an interrupted
promotion immediately and again during the next startup before accepting the database.

If the application reports that the archive was imported but services need a restart, restart
Schedule and do not import the archive again. If it reports that recovery is required, restart
Schedule so the journal can complete or roll back the interrupted promotion; again, do not re-run
the import.

For repository or recovery use, the equivalent explicit CLI workflow is:

```bash
pnpm infra:up
pnpm db:migrate
pnpm data:import -- /private/path/my-schedule.schedule --confirm=replace-schedule
```

Import is intentionally replacement, not merge. The former active database is retained only through
the bounded, identity-checked recovery policy. Take an ordinary recovery backup before later cleanup
or upgrades.

Version 1 requires an exact portable schema and ordered migration fingerprint match. If an archive
is rejected as incompatible, import it using the matching Schedule source release and then upgrade
that restored installation normally. Raw PostgreSQL cluster directories are never portable and must
not be copied between operating systems or PostgreSQL major versions.

## Application updates and data preservation

A portable archive is a transfer and recovery bridge, not a shortcut around database migrations.
For an older archive, first run its matching Schedule release, import and verify it there, take a
normal recovery backup, and then update the application. Normal desktop updates must keep the stable
per-user data location, validate the existing database, publish a verified pre-migration backup,
apply only an ordered forward migration, and fail closed instead of creating an empty replacement.
A newer or divergent migration ledger must be rejected without mutation.

The current desktop runtime retains its data outside installed program files, uses the live
migration ledger for upgrade and downgrade admission, backs up before a detected migration, and
refuses to silently reinitialize an existing installation. Full release-grade update evidence still
requires a populated installed N-1-to-N test matrix on Windows and Linux: populate every durable
table in N-1, install and verify N against the same data root, then prove N-1 refuses the upgraded
database without mutation. That limitation is recorded in [EVALUATION.md](./EVALUATION.md) rather
than being presented as a completed guarantee.

### Interrupted desktop update recovery

An interrupted desktop migration is not treated as a portable import. Once Schedule has created a
pre-update backup, it records an exact receipt in the same durable lifecycle journal before any
migration mutation: the attempt and recovery IDs, expected manifest digest, private dump filename,
byte count, and SHA-256. Only an incompatible migration journal with that valid receipt enables the
desktop’s explicit two-step **Restore automatic backup** action. The action cannot select an
arbitrary path: its second step is an OS-native warning with an explicit **Restore backup**
confirmation. Schedule never searches for a “most recent” dump. Legacy interrupted journals
without a receipt remain incompatible and require operator diagnosis rather than an unsafe guess.

Recovery takes a new private snapshot of the receipt-bound dump and verifies the recorded byte count
and digest again. The bundled helper restores it into a fresh, cluster-marked staging database; it
accepts only the recorded valid migration prefix or exact current ledger, migrates a prefix forward,
and then requires the exact ledger before identity/OID-bound promotion. Promotion uses the same
durable database-transition journal as import, retains the former active database within the bounded
recovery policy, and reconciles an interruption before another transition. Missing or substituted
backup bytes, an invalid restore, an unexpected ledger, or an uncertain promotion does not delete
the active database or clear the lifecycle journal. Schedule stops its private PostgreSQL service
before marking a successful restore and restarts through normal admission.

## Data that moves

The policy is exhaustive: every current Schedule table is classified as portable or local-only, and
a test fails whenever a new table is added without an explicit decision. The portable set includes:

- workspaces, work items, dependencies, routines, recurrence, and schedule blocks;
- every daily-plan revision, plan item, current item state, mutation, and activity event;
- reminder profiles, rules, and one-off reminder definitions;
- audit history and planner interaction history;
- natural-language/AI proposal records; and
- long-term behavior and adaptation evidence, including routine planning, duration, selection
  preference, and Daily Plan Fit feedback.

This preserves all AI and behavior information that Schedule durably stores. Ephemeral model
responses, model weights, Ollama/Gemma installations, and other files outside the Schedule database
are not part of the archive.

## Data that stays local

Environment-bound or derived state is deliberately excluded:

- users, external identities, browser sessions, login transactions, and workspace memberships;
- integration credentials and confirmation state;
- webhook secrets, delivery attempts, delivery commands, and delivery history;
- notification delivery queues and materialized notification intents;
- the outbox and hosted synchronization capability, cursor, state, and change journal.

Reminder definitions migrate, while derived notification intents are regenerated in the new
environment. Webhook configuration and subscriptions migrate in a revoked state because their
secrets do not; reconnect integrations and provision new webhook secrets after import. Audit actor
bindings are removed, hosted synchronization cursors restart at zero, and pending AI proposals are
cancelled at their original expiry time so an old review cannot be confirmed in a new environment.

## Security and custody

A `.schedule` archive contains private tasks, history, model proposals, and feedback. It is created
with private POSIX permissions where supported, but it is **not encrypted or signed**. Its SHA-256
checksums detect accidental corruption and modifications that do not also replace the associated
checksums; they do not authenticate provenance. Archive rows are strict typed-text arrays and are
passed to PostgreSQL only as bound data parameters; archive bytes are never interpreted as SQL or a
PostgreSQL restore program. A malicious party who can rewrite the file can also recompute its
checksums and alter imported data, so import only archives that remained under your control. Encrypt
the transfer or storage medium when appropriate.

Version 1 bounds the typed payload at 512 MiB. The importer validates the already-open frame and its
declared exact size before creating a private snapshot, then verifies and compacts that snapshot in
place. Invalid sparse files therefore cannot trigger an unbounded temporary copy.

## Verification

Unit tests enforce the exhaustive table policy, strict archive framing, corruption and truncation
rejection, symlink and overwrite refusal, exact dump catalog, archive-ID- and exact-byte-bound
confirmation, durable journal transitions, every promotion crash seam, bounded recovery topology,
and explicit replacement confirmation.
The real PostgreSQL drill creates fixtures in every portable table, including AI proposals and all
four long-term feedback streams, exports them, imports them into an independent database, proves
secret and transient tables are empty, verifies normalization and exact content signals, replaces an
existing database, and exercises rollback:

```powershell
pnpm verify:portable-migration
```

A separate desktop-helper drill terminates the import process before staging allocation, after
unmarked staging creation, after marker publication, at prepared state, each committed
database-promotion mutation, and the final receipt. It then proves exact rollback or completion,
bounded previous-database retention, and journal cleanup:

```powershell
pnpm verify:desktop-portable-import
```

The archive framing and migration fingerprint are OS-neutral and unit-tested with Windows and Linux
producer metadata. Current CI runs the full database drill on Linux; a physical Windows-producer to
Linux-consumer artifact handoff is not yet a CI claim. Nor does the current repository retain golden
archives from old released versions; version-1 archives still require their matching release before
a normal update.
