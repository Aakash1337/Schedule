import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { parseMigrationPolicyArguments, verifyMigrationPolicy } from "./verify-migration-policy.js";

type FixtureEntry = {
  readonly idx: number;
  readonly tag: string;
  readonly sql: string;
  readonly when?: number;
  readonly compatibleSha256?: readonly string[];
};

const directories: string[] = [];
const migrationRoot = "packages/database/drizzle";
const initialSql = "CREATE TABLE things (id integer);\n";

function run(directory: string, ...arguments_: string[]): string {
  return execFileSync("git", arguments_, { cwd: directory, encoding: "utf8" }).trim();
}

function digest(source: string): string {
  return createHash("sha256").update(source).digest("hex");
}

function journal(entries: readonly FixtureEntry[]): string {
  return `${JSON.stringify({
    version: "7",
    dialect: "postgresql",
    entries: entries.map((entry) => ({
      idx: entry.idx,
      version: "7",
      when: entry.when ?? 1_700_000_000_000 + entry.idx,
      tag: entry.tag,
      breakpoints: true,
    })),
  })}\n`;
}

function manifest(entries: readonly FixtureEntry[]): string {
  return `${JSON.stringify({
    schemaVersion: 1,
    entries: entries.map((entry) => ({
      tag: entry.tag,
      createdAt: entry.when ?? 1_700_000_000_000 + entry.idx,
      sha256: digest(entry.sql),
      compatibleSha256: entry.compatibleSha256 ?? [],
    })),
  })}\n`;
}

async function writeMetadata(root: string, entries: readonly FixtureEntry[]): Promise<void> {
  await writeFile(path.join(root, migrationRoot, "meta/_journal.json"), journal(entries));
  await writeFile(
    path.join(root, migrationRoot, "meta/_migration_manifest.json"),
    manifest(entries),
  );
}

function commit(root: string, message: string): void {
  run(root, "add", ".");
  run(root, "commit", "--quiet", "--message", message);
}

async function fixture(options: { readonly manifest?: boolean } = {}): Promise<{
  readonly root: string;
  readonly base: string;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "schedule-migration-policy-"));
  directories.push(root);
  run(root, "init", "--quiet");
  run(root, "config", "user.email", "tests@example.invalid");
  run(root, "config", "user.name", "Migration policy tests");
  run(root, "config", "core.autocrlf", "false");
  await mkdir(path.join(root, migrationRoot, "meta"), { recursive: true });
  const entries = [{ idx: 0, tag: "0000_initial", sql: initialSql }];
  await writeFile(path.join(root, migrationRoot, "0000_initial.sql"), initialSql);
  await writeFile(path.join(root, migrationRoot, "meta/_journal.json"), journal(entries));
  if (options.manifest !== false) {
    await writeFile(
      path.join(root, migrationRoot, "meta/_migration_manifest.json"),
      manifest(entries),
    );
  }
  commit(root, "base");
  return { root, base: run(root, "rev-parse", "HEAD") };
}

async function append(
  root: string,
  tag: string,
  sql: string,
  options: { readonly compatibleSha256?: readonly string[] } = {},
): Promise<void> {
  const entries = [
    { idx: 0, tag: "0000_initial", sql: initialSql },
    {
      idx: 1,
      tag,
      sql,
      ...(options.compatibleSha256 === undefined
        ? {}
        : { compatibleSha256: options.compatibleSha256 }),
    },
  ];
  await writeFile(path.join(root, migrationRoot, `${tag}.sql`), sql);
  await writeMetadata(root, entries);
  commit(root, "append");
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("migration policy", () => {
  it("allows an append-only migration, portable hyphenated tags, and harmless SQL", async () => {
    const { root, base } = await fixture();
    await append(
      root,
      "0001_plan-source-guard",
      "INSERT INTO things VALUES (2);\nDROP INDEX IF EXISTS things_idx;\n",
    );
    expect(() => verifyMigrationPolicy({ repositoryRoot: root, base })).not.toThrow();
  });

  it("rejects a historical migration rewrite", async () => {
    const { root, base } = await fixture();
    await writeFile(path.join(root, migrationRoot, "0000_initial.sql"), "DROP TABLE things;\n");
    commit(root, "rewrite");
    expect(() => verifyMigrationPolicy({ repositoryRoot: root, base })).toThrow(
      /Historical migration 0000_initial was changed/u,
    );
  });

  it("rejects historical journal changes, removal, and noncanonical entries", async () => {
    const cases: readonly [string, unknown][] = [
      ["timestamp", { idx: 0, version: "7", when: 42, tag: "0000_initial", breakpoints: true }],
      [
        "index",
        { idx: 1, version: "7", when: 1_700_000_000_000, tag: "0000_initial", breakpoints: true },
      ],
      [
        "version",
        { idx: 0, version: "6", when: 1_700_000_000_000, tag: "0000_initial", breakpoints: true },
      ],
      [
        "extra key",
        {
          idx: 0,
          version: "7",
          when: 1_700_000_000_000,
          tag: "0000_initial",
          breakpoints: true,
          extra: true,
        },
      ],
    ];
    for (const [label, entry] of cases) {
      const { root, base } = await fixture();
      await writeFile(
        path.join(root, migrationRoot, "meta/_journal.json"),
        `${JSON.stringify({ version: "7", dialect: "postgresql", entries: [entry] })}\n`,
      );
      commit(root, label);
      expect(() => verifyMigrationPolicy({ repositoryRoot: root, base })).toThrow(
        /migration journal/u,
      );
    }

    const removed = await fixture();
    await writeFile(path.join(removed.root, migrationRoot, "meta/_journal.json"), journal([]));
    commit(removed.root, "remove");
    expect(() =>
      verifyMigrationPolicy({ repositoryRoot: removed.root, base: removed.base }),
    ).toThrow(/removes historical migrations/u);
  }, 20_000);

  it("requires an explicit reason for destructive new SQL", async () => {
    const cases = [
      "DELETE FROM things;\n",
      "DROP SEQUENCE public.things_id_seq;\n",
      "ALTER SEQUENCE public.things_id_seq RESTART WITH 1;\n",
      "DROP EXTENSION IF EXISTS example CASCADE;\n",
      "DROP OWNED BY obsolete_role CASCADE;\n",
      "DROP MATERIALIZED VIEW historical_summary;\n",
      "DROP VIEW current_summary;\n",
      "DROP FUNCTION public.refresh_summary();\n",
      "DROP PROCEDURE public.rebuild_summary();\n",
      "DROP ROUTINE public.refresh_or_rebuild_summary();\n",
      "DROP DOMAIN customer_code CASCADE;\n",
      "ALTER TABLE things DROP obsolete;\n",
      "ALTER TABLE things DROP CONSTRAINT things_value_check;\n",
      "ALTER TABLE things ALTER CONSTRAINT things_parent_fk DEFERRABLE;\n",
      "ALTER TABLE things ALTER COLUMN id DROP IDENTITY;\n",
      "ALTER TABLE things ALTER COLUMN id RESTART WITH 1;\n",
      "ALTER TABLE things ALTER value TYPE text;\n",
      "ALTER TABLE things RENAME value TO old_value;\n",
      "ALTER TABLE things RENAME TO old_things;\n",
      "SELECT pg_catalog.setval('public.things_id_seq'::regclass, 1, false);\n",
      `SELECT pg_catalog."setval"('public.things_id_seq'::regclass, 1, false);\n`,
      "UPDATE things SET value = NULL;\n",
      "MERGE INTO things USING changes ON things.id = changes.id WHEN MATCHED THEN DELETE;\n",
    ];
    for (const [index, sql] of cases.entries()) {
      const { root, base } = await fixture();
      await append(root, `0001_destructive_${index}`, sql);
      expect(() => verifyMigrationPolicy({ repositoryRoot: root, base })).toThrow(
        /schedule-migration-review/u,
      );
    }
  }, 45_000);

  it("accepts reviewed destructive SQL and ignores trigger words in literals and comments", async () => {
    const { root, base } = await fixture();
    await append(
      root,
      "0001_next",
      "ALTER TABLE things ADD COLUMN added text;--> statement-breakpoint\n-- DELETE FROM is only documentation\nINSERT INTO things VALUES ('DROP TABLE');--> statement-breakpoint\n-- schedule-migration-review: destructive-data-change\n-- schedule-migration-reason: obsolete test data is intentionally removed\nDELETE FROM things;\n",
    );
    expect(() => verifyMigrationPolicy({ repositoryRoot: root, base })).not.toThrow();
  });

  it("requires review immediately before each semicolon-separated destructive statement", async () => {
    const misplaced = await fixture();
    await append(
      misplaced.root,
      "0001_next",
      "-- schedule-migration-review: destructive-data-change\n-- schedule-migration-reason: this comment approves only the select\nSELECT '; DELETE FROM ignored'; DELETE FROM things;\n",
    );
    expect(() =>
      verifyMigrationPolicy({ repositoryRoot: misplaced.root, base: misplaced.base }),
    ).toThrow(/schedule-migration-review/u);

    const reviewed = await fixture();
    await append(
      reviewed.root,
      "0001_next",
      "SELECT '; DELETE FROM ignored'; -- schedule-migration-review: destructive-data-change\n-- schedule-migration-reason: obsolete rows are intentionally removed\nDELETE FROM things;\n",
    );
    expect(() =>
      verifyMigrationPolicy({ repositoryRoot: reviewed.root, base: reviewed.base }),
    ).not.toThrow();
  });

  it("raw-splits Drizzle breakpoints before lexical analysis", async () => {
    const bypass = await fixture();
    await append(
      bypass.root,
      "0001_next",
      "SELECT 1;\n--> statement-breakpoint DELETE FROM things;\n",
    );
    expect(() => verifyMigrationPolicy({ repositoryRoot: bypass.root, base: bypass.base })).toThrow(
      /schedule-migration-review/u,
    );

    const embedded = await fixture();
    await append(
      embedded.root,
      "0001_next",
      "SELECT '--> statement-breakpoint inside a string';\n",
    );
    expect(() =>
      verifyMigrationPolicy({ repositoryRoot: embedded.root, base: embedded.base }),
    ).toThrow(/unterminated string literal/u);
  });

  it("distinguishes standard strings from PostgreSQL escape strings", async () => {
    const { root, base } = await fixture();
    await append(
      root,
      "0001_next",
      String.raw`SELECT 'C:\';
SELECT E'it\'s; DELETE FROM ignored';
-- schedule-migration-review: destructive-data-change
-- schedule-migration-reason: obsolete rows are intentionally removed
DELETE FROM things;
`,
    );
    expect(() => verifyMigrationPolicy({ repositoryRoot: root, base })).not.toThrow();
  });

  it("forbids migrations from changing standard string conformance", async () => {
    for (const sql of [
      String.raw`-- schedule-migration-review: destructive-data-change
-- schedule-migration-reason: review cannot weaken the policy lexer
SET standard_conforming_strings = off;
--> statement-breakpoint
SELECT 'a\'b'; DELETE FROM things; SELECT 'c\'d';
`,
      "SELECT set_config('standard_conforming_strings', 'off', false);\n",
      "SELECT set_config('standard_' || 'conforming_strings', 'off', false);\n",
      "SELECT set_config($setting$standard_conforming_strings$setting$, 'off', false);\n",
      'ALTER ROLE CURRENT_USER SET "STANDARD_CONFORMING_STRINGS" = off;\n',
      String.raw`-- schedule-migration-review: destructive-data-change
-- schedule-migration-reason: Unicode review cannot weaken the parser contract
SET U&"\0073tandard_conforming_strings" = off;
`,
    ]) {
      const { root, base } = await fixture();
      await append(root, "0001_next", sql);
      expect(() => verifyMigrationPolicy({ repositoryRoot: root, base })).toThrow(
        /may not (?:change standard_conforming_strings|use Unicode-escaped identifiers)/u,
      );
    }
  }, 20_000);

  it("forbids top-level transaction control without confusing SQL and procedural END", async () => {
    for (const sql of [
      "COMMIT AND CHAIN;\n",
      "END;\n",
      "ROLLBACK TO SAVEPOINT before_change;\n",
      "ABORT;\n",
      "BEGIN;\n",
      "START TRANSACTION;\n",
      "SAVEPOINT before_change;\n",
      "RELEASE SAVEPOINT before_change;\n",
      "PREPARE TRANSACTION 'migration';\n",
    ]) {
      const { root, base } = await fixture();
      await append(root, "0001_next", sql);
      expect(() => verifyMigrationPolicy({ repositoryRoot: root, base })).toThrow(
        /may not control its migration transaction/u,
      );
    }

    const harmless = await fixture();
    await append(harmless.root, "0001_next", "SELECT CASE WHEN true THEN 1 ELSE 0 END;\n");
    expect(() =>
      verifyMigrationPolicy({ repositoryRoot: harmless.root, base: harmless.base }),
    ).not.toThrow();
  }, 20_000);

  it("uses PostgreSQL identifier boundaries for keywords and E-string prefixes", async () => {
    const { root, base } = await fixture();
    await append(
      root,
      "0001_next",
      String.raw`CREATE TABLE pre$UPDATE (id integer);
CREATE TABLE préUPDATE (id integer);
SELECT foo$setval(1);
SELECT préE'C:\';
SET search_path = standard_conforming_strings, public;
`,
    );
    expect(() => verifyMigrationPolicy({ repositoryRoot: root, base })).not.toThrow();
  });

  it("forbids Unicode-escaped identifiers that can hide protected functions", async () => {
    const sql = String.raw`SELECT pg_catalog.U&"\0073etval"('things_id_seq'::regclass, 1, false);
`;
    const unreviewed = await fixture();
    await append(unreviewed.root, "0001_next", sql);
    expect(() =>
      verifyMigrationPolicy({ repositoryRoot: unreviewed.root, base: unreviewed.base }),
    ).toThrow(/may not use Unicode-escaped identifiers/u);

    const reviewed = await fixture();
    await append(
      reviewed.root,
      "0001_next",
      `-- schedule-migration-review: destructive-data-change\n-- schedule-migration-reason: reviewed Unicode identifier\n${sql}`,
    );
    expect(() =>
      verifyMigrationPolicy({ repositoryRoot: reviewed.root, base: reviewed.base }),
    ).toThrow(/may not use Unicode-escaped identifiers/u);
  });

  it("requires review for single-quoted procedural SQL", async () => {
    const body = "DO 'BEGIN RAISE NOTICE ''safe''; END';\n";
    const unreviewed = await fixture();
    await append(unreviewed.root, "0001_next", body);
    expect(() =>
      verifyMigrationPolicy({ repositoryRoot: unreviewed.root, base: unreviewed.base }),
    ).toThrow(/procedural SQL/u);

    const reviewed = await fixture();
    await append(
      reviewed.root,
      "0001_next",
      `-- schedule-migration-review: destructive-data-change\n-- schedule-migration-reason: reviewed procedural migration\n${body}`,
    );
    expect(() =>
      verifyMigrationPolicy({ repositoryRoot: reviewed.root, base: reviewed.base }),
    ).not.toThrow();
  });

  it("requires review for dollar-quoted procedural SQL and does not split inside its body", async () => {
    const body = "DO $body$ BEGIN RAISE NOTICE 'DROP TABLE; still text'; END $body$;\n";
    const unreviewed = await fixture();
    await append(unreviewed.root, "0001_next", body);
    expect(() =>
      verifyMigrationPolicy({ repositoryRoot: unreviewed.root, base: unreviewed.base }),
    ).toThrow(/procedural or dollar-quoted SQL/u);

    const reviewed = await fixture();
    await append(
      reviewed.root,
      "0001_next",
      `-- schedule-migration-review: destructive-data-change\n-- schedule-migration-reason: reviewed procedural migration\n${body}`,
    );
    expect(() =>
      verifyMigrationPolicy({ repositoryRoot: reviewed.root, base: reviewed.base }),
    ).not.toThrow();
  });

  it("recognizes non-ASCII dollar tags without mistaking dollar identifiers for openers", async () => {
    const body = "DO $é$ BEGIN RAISE NOTICE 'safe'; END $é$;\n";
    const unreviewed = await fixture();
    await append(unreviewed.root, "0001_next", body);
    expect(() =>
      verifyMigrationPolicy({ repositoryRoot: unreviewed.root, base: unreviewed.base }),
    ).toThrow(/procedural or dollar-quoted SQL/u);

    const reviewed = await fixture();
    await append(
      reviewed.root,
      "0001_next",
      `-- schedule-migration-review: destructive-data-change\n-- schedule-migration-reason: reviewed procedural migration\n${body}\nSELECT schedule$archive$;\n`,
    );
    expect(() =>
      verifyMigrationPolicy({ repositoryRoot: reviewed.root, base: reviewed.base }),
    ).not.toThrow();
  });

  it("keeps historical manifest entries and compatibility aliases immutable", async () => {
    const { root, base } = await fixture();
    const parsed = JSON.parse(
      await readFile(path.join(root, migrationRoot, "meta/_migration_manifest.json"), "utf8"),
    ) as { entries: { compatibleSha256: string[] }[] };
    parsed.entries[0]!.compatibleSha256.push("a".repeat(64));
    await writeFile(
      path.join(root, migrationRoot, "meta/_migration_manifest.json"),
      `${JSON.stringify(parsed)}\n`,
    );
    commit(root, "alias rewrite");
    expect(() => verifyMigrationPolicy({ repositoryRoot: root, base })).toThrow(
      /Historical migration manifest entry 0000_initial was changed/u,
    );
  });

  it("requires every journal migration to have a matching manifest entry and SQL digest", async () => {
    const missingManifest = await fixture();
    const entries = [
      { idx: 0, tag: "0000_initial", sql: initialSql },
      { idx: 1, tag: "0001_next", sql: "SELECT 1;\n" },
    ];
    await writeFile(
      path.join(missingManifest.root, migrationRoot, "0001_next.sql"),
      entries[1]!.sql,
    );
    await writeFile(
      path.join(missingManifest.root, migrationRoot, "meta/_journal.json"),
      journal(entries),
    );
    commit(missingManifest.root, "journal only");
    expect(() =>
      verifyMigrationPolicy({
        repositoryRoot: missingManifest.root,
        base: missingManifest.base,
      }),
    ).toThrow(/manifest and journal lengths differ/u);

    const staleDigest = await fixture();
    await append(staleDigest.root, "0001_next", "SELECT 1;\n");
    const stale = JSON.parse(
      await readFile(
        path.join(staleDigest.root, migrationRoot, "meta/_migration_manifest.json"),
        "utf8",
      ),
    ) as { entries: { sha256: string }[] };
    stale.entries[1]!.sha256 = "b".repeat(64);
    await writeFile(
      path.join(staleDigest.root, migrationRoot, "meta/_migration_manifest.json"),
      `${JSON.stringify(stale)}\n`,
    );
    commit(staleDigest.root, "stale digest");
    expect(() =>
      verifyMigrationPolicy({ repositoryRoot: staleDigest.root, base: staleDigest.base }),
    ).toThrow(/does not match its manifest SHA-256/u);
  });

  it("forbids alternate hashes on newly appended migrations", async () => {
    const { root, base } = await fixture();
    await append(root, "0001_next", "SELECT 1;\n", {
      compatibleSha256: ["c".repeat(64)],
    });
    expect(() => verifyMigrationPolicy({ repositoryRoot: root, base })).toThrow(
      /may not introduce alternate historical hashes/u,
    );
  });

  it("allows the initial manifest introduction but rejects unapproved bootstrap aliases", async () => {
    const accepted = await fixture({ manifest: false });
    await writeFile(
      path.join(accepted.root, migrationRoot, "meta/_migration_manifest.json"),
      manifest([{ idx: 0, tag: "0000_initial", sql: initialSql }]),
    );
    commit(accepted.root, "introduce manifest");
    expect(() =>
      verifyMigrationPolicy({ repositoryRoot: accepted.root, base: accepted.base }),
    ).not.toThrow();

    const rejected = await fixture({ manifest: false });
    await writeFile(
      path.join(rejected.root, migrationRoot, "meta/_migration_manifest.json"),
      manifest([
        {
          idx: 0,
          tag: "0000_initial",
          sql: initialSql,
          compatibleSha256: ["d".repeat(64)],
        },
      ]),
    );
    commit(rejected.root, "introduce alias");
    expect(() =>
      verifyMigrationPolicy({ repositoryRoot: rejected.root, base: rejected.base }),
    ).toThrow(/unapproved compatibility hash/u);
  });

  it("rejects a journaled migration whose SQL file disappears", async () => {
    const { root, base } = await fixture();
    await append(root, "0001_next", "SELECT 1;\n");
    await unlink(path.join(root, migrationRoot, "0001_next.sql"));
    commit(root, "remove sql");
    expect(() => verifyMigrationPolicy({ repositoryRoot: root, base })).toThrow(
      /Migration policy could not run git show/u,
    );
  });
});

describe("migration policy CLI", () => {
  it("uses the first parent locally and accepts only an explicit base option", () => {
    expect(parseMigrationPolicyArguments([])).toEqual({ base: "HEAD^" });
    expect(parseMigrationPolicyArguments(["--base", "abc123"])).toEqual({ base: "abc123" });
    expect(parseMigrationPolicyArguments(["--", "--base", "abc123"])).toEqual({
      base: "abc123",
    });
    expect(() => parseMigrationPolicyArguments(["--base"])).toThrow(/Usage/u);
  });
});
