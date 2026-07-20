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

## Historical compatibility hashes

An audit of every migration version reachable from repository history found six previously
journaled SQL hashes that differ from their current canonical source. Existing databases may retain
those exact hashes, so the runtime accepts them only at the matching tag and canonical timestamp:

| Migration                    | Accepted historical SHA-256                                        |
| ---------------------------- | ------------------------------------------------------------------ |
| `0004_public_cerise`         | `6ab84e9bb63326595061b24584e8fe58f3cf23ba1e6d6786f3777a7347a646f6` |
| `0024_fast_thundra`          | `26f049d219f3962d7298fd4acca87bc0b8ceeeb680bc7df1b65056eb572b38c5` |
| `0031_daffy_bloodstrike`     | `34e68d0a3907c79ecbc3f97949c493800d688e84998657d440f155bfa089b8c1` |
| `0032_harsh_purifiers`       | `4b9982a0deb4d00e68b7871ea4c84b2b28c6bdfcf257f8717ec0025c8de5e1e9` |
| `0041_hosted_work_item_sync` | `40064a598eab70d10c7a0090d29f2793417621d39029d7d7b799403d515abd9f` |
| `0041_hosted_work_item_sync` | `b4c65f84c69c294c5f481b1c36f7906af625016a9fd1300cad6cf7f0a9b885ca` |

Timestamps alone are insufficient. The manifest and policy gate pin this closed set and forbid a
new alias or another source rewrite. All canonical migration SQL and accepted historical hashes are
immutable after release.
