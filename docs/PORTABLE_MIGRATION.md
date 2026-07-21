# Portable data migration

Schedule can move durable local product data between independent installations with one versioned
`.schedule` archive. The archive carries a typed, data-only logical payload, so it can move between
Windows and Linux without copying a PostgreSQL data directory or depending on filesystem layout.

This is currently a repository CLI workflow backed by the local Docker Compose PostgreSQL service.
Native one-click desktop export/import is a separate integration step; desktop-to-cloud live sync
also remains a future capability.

## Export

Run the same Schedule release that owns the source database, then create the archive:

```powershell
pnpm infra:up
pnpm db:migrate
pnpm data:export -- --output E:\ScheduleTransfer\my-schedule.schedule
```

Without `--output`, the archive is written beneath `~/.schedule/exports`. Export refuses to replace
an existing file. Before publishing it, Schedule restores the data into a fresh migrated database
and verifies the resulting schema, rows, sequences, exclusions, and foreign keys.

## Import on another operating system

Install the matching Schedule schema release on the destination. Copy the `.schedule` file through
your normal private transfer method, start PostgreSQL, and import it explicitly:

```bash
pnpm infra:up
pnpm db:migrate
pnpm data:import -- /private/path/my-schedule.schedule --confirm=replace-schedule
```

Import is intentionally replacement, not merge. Schedule restores into a new migrated staging
database, validates it, and only then promotes it to `schedule`. The former active database is kept
under the name printed by the command so it remains available for inspected rollback. Take an
ordinary recovery backup before later cleanup or upgrades.

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
rejection, symlink and overwrite refusal, exact dump catalog, and explicit replacement confirmation.
The real PostgreSQL drill creates fixtures in every portable table, including AI proposals and all
four long-term feedback streams, exports them, imports them into an independent database, proves
secret and transient tables are empty, verifies normalization and exact content signals, replaces an
existing database, and exercises rollback:

```powershell
pnpm verify:portable-migration
```

The archive framing and migration fingerprint are OS-neutral and unit-tested with Windows and Linux
producer metadata. Current CI runs the full database drill on Linux; a physical Windows-producer to
Linux-consumer artifact handoff is not yet a CI claim.
