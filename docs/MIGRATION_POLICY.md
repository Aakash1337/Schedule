# Database migration policy

Schedule updates must preserve existing user data. Database changes are forward-only: add a new
Drizzle migration, keep the journal and committed compatibility manifest append-only, and use an
expand/contract rollout when old and new application versions may overlap. Never edit, remove,
retimestamp, reorder, or add an alternate accepted hash to a released migration.

Run the policy gate locally before opening a migration PR:

```powershell
pnpm verify:migration-policy -- --base origin/main
```

CI compares a pull request to its actual base commit. It verifies the complete historical journal,
byte-for-byte SQL, and every entry in `_migration_manifest.json`, including its accepted hashes. A
new journal entry must have one matching manifest entry whose primary SHA-256 matches its SQL. New
entries cannot introduce alternate historical hashes. Drizzle metadata snapshots other than this
runtime compatibility authority remain outside the comparison because they are generated artifacts.

## Destructive changes

Avoid destructive migration SQL. When it is necessary, preserve/export the affected data, prove the
populated upgrade with a disposable PostgreSQL verifier, and put these two comments immediately
before each destructive statement:

```sql
-- schedule-migration-review: destructive-data-change
-- schedule-migration-reason: explain why retained data cannot remain compatible
```

The gate requires this acknowledgement for data-rewriting `UPDATE`, `MERGE`, `DELETE FROM`, and
`TRUNCATE` statements; sequence resets; dropping data-bearing or compatibility-critical objects;
and dropping, changing the type of, or renaming a column. Dollar-quoted or procedural SQL also
requires the acknowledgement because a lexical gate cannot prove dynamic SQL is harmless.
Statement separators are recognized only outside comments, strings, quoted identifiers, and
dollar-quoted bodies. The recognition rules are deliberately conservative. The acknowledgement is
an explicit policy record, not a replacement for normal pull-request review or a populated-data
migration test.

## Historical 0004 repair

Migration `0004_public_cerise` was repaired to scope its append-only event bypass around its
backfill. Its canonical source SHA-256 is
`4c15b8cd344fe8ad9fad3b5da537e1b4f2cdd925e510afd76ee2712ded6089d0`; databases upgraded before
the repair can retain legacy Drizzle ledger SHA-256
`6ab84e9bb63326595061b24584e8fe58f3cf23ba1e6d6786f3777a7347a646f6` at the same canonical journal
timestamp. Runtime compatibility requires that exact timestamp and either the canonical hash or
this one pinned legacy hash at index `0004`; timestamps alone are insufficient. The policy gate
freezes the exception with the rest of the manifest. It does not permit another source rewrite or a
new alias: the repaired source is now immutable like every other historical migration.
