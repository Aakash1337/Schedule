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
`TRUNCATE` statements; sequence resets; dropping data-bearing or compatibility-critical objects,
including indexes; replacing or altering triggers, policies, or rules; compatibility-changing type
operations; and table changes that drop or rename columns or objects, change column types, or change
enforcement modes. Dollar-quoted or procedural SQL also
requires the acknowledgement because a lexical gate cannot prove dynamic SQL is harmless.
Unicode-escaped quoted identifiers are forbidden because they can hide protected operations. Exact Drizzle
`--> statement-breakpoint` markers are raw boundaries before lexical analysis, matching the runtime
migrator; semicolons are boundaries only outside comments, strings, quoted identifiers, and
dollar-quoted bodies. Keyword boundaries follow PostgreSQL identifier rules, including dollar signs
and non-ASCII characters.

The policy gate and runtime share the SQL statement lexer. The migration connection pins
`standard_conforming_strings=on` before every top-level statement and verifies it again afterward.
New migrations may not change or reset that setting or call `set_config`, so computed setting names
cannot bypass the rule. The runtime also rejects persistent database or role setting changes. The
live PostgreSQL verifier forces an unsafe database default, a mid-migration session change, and a
persistent database setting change; the first must still migrate safely and both changes must roll
back without partial migration state.
These recognition rules are deliberately conservative. The acknowledgement is an explicit policy
record, not a replacement for normal pull-request review or a populated-data migration test.

Migration SQL may not issue top-level transaction-control commands such as `COMMIT`, `ROLLBACK`,
`BEGIN`, or `SAVEPOINT`. Both CI and the runtime reject them with the shared lexer before execution.
The runtime owns the single transaction that covers every pending migration; a migration cannot end
it early, even with a destructive-change acknowledgement. Parenthesized rule actions and SQL-standard
`BEGIN ATOMIC` function or procedure bodies remain single statements under this boundary check.

## Historical compatibility hashes

An audit of every migration version reachable from repository history found six previously
journaled SQL variants that differ from their current canonical source. Existing databases may
retain those exact LF hashes or their deterministic CRLF equivalents, so the runtime accepts them
only at the matching tag and canonical timestamp:

| Migration                    | Historical LF SHA-256                                              | Historical CRLF SHA-256                                            |
| ---------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `0004_public_cerise`         | `6ab84e9bb63326595061b24584e8fe58f3cf23ba1e6d6786f3777a7347a646f6` | `690349d1c4e55355661e7acb5ffc1a79b92d3503548d7ef289bbef9367047170` |
| `0024_fast_thundra`          | `26f049d219f3962d7298fd4acca87bc0b8ceeeb680bc7df1b65056eb572b38c5` | `fe5ca493d9ed22bb35395029a713441db2792bcbf8ca0f6e4638a0c37a614d6d` |
| `0031_daffy_bloodstrike`     | `34e68d0a3907c79ecbc3f97949c493800d688e84998657d440f155bfa089b8c1` | `1ce33357c59ca26bd28f93e4ab902bc705279de9b05198f4cbf8e8b3cfc4ae88` |
| `0032_harsh_purifiers`       | `4b9982a0deb4d00e68b7871ea4c84b2b28c6bdfcf257f8717ec0025c8de5e1e9` | `849a6143a47c4e606c51cbb1ad583ebc44e5fd37e08a0472e78f433f86d9501a` |
| `0041_hosted_work_item_sync` | `40064a598eab70d10c7a0090d29f2793417621d39029d7d7b799403d515abd9f` | `5c4d70031606bfe9eeeb776d7c2085fc6759e9ebff1960674f22fef9efb82e3e` |
| `0041_hosted_work_item_sync` | `b4c65f84c69c294c5f481b1c36f7906af625016a9fd1300cad6cf7f0a9b885ca` | `f2890f9d40b00d52f373654ad31df9fdc99af9c0147264ac807fd0ee401148ce` |

Timestamps alone are insufficient. The manifest and policy gate pin this closed set and forbid a
new alias or another source rewrite. All canonical migration SQL and accepted historical hashes are
immutable after release.

Canonical migration files are hashed after normalizing CRLF to LF, and the runtime derives exactly
one CRLF hash for the same bytes. This keeps Windows and Linux ledgers compatible without accepting
other byte changes. Migration `0042_reconcile_historical_schema` repairs the durable catalog
differences in the historical `0031` and `0041` variants without deleting or rewriting product rows.
An oversized identity that predates the byte bound is retained under a `NOT VALID` constraint while
the same bound is enforced for new writes; clean databases validate the constraint immediately.
