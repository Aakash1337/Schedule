import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";

type JournalEntry = {
  readonly idx: number;
  readonly version: "7";
  readonly when: number;
  readonly tag: string;
  readonly breakpoints: boolean;
};

type Journal = {
  readonly version: "7";
  readonly dialect: "postgresql";
  readonly entries: readonly JournalEntry[];
};

type ManifestEntry = {
  readonly tag: string;
  readonly createdAt: number;
  readonly sha256: string;
  readonly compatibleSha256: readonly string[];
};

type Manifest = { readonly schemaVersion: 1; readonly entries: readonly ManifestEntry[] };

type SqlStatement = {
  readonly source: string;
  readonly searchable: string;
  readonly containsDollarQuote: boolean;
};

const migrationDirectory = "packages/database/drizzle";
const journalPath = `${migrationDirectory}/meta/_journal.json`;
const manifestPath = `${migrationDirectory}/meta/_migration_manifest.json`;
const safeTag = /^\d{4}_[a-z0-9_-]+$/u;
const sha256 = /^[a-f0-9]{64}$/u;
const statementBreakpoint = "--> statement-breakpoint";
const destructiveReview =
  /^\s*--\s*schedule-migration-review:\s*destructive-data-change\s*\r?\n\s*--\s*schedule-migration-reason:\s*\S[^\r\n]*\r?\n/iu;
const bootstrapCompatibleHashes = new Map<string, readonly string[]>([
  ["0004_public_cerise", ["6ab84e9bb63326595061b24584e8fe58f3cf23ba1e6d6786f3777a7347a646f6"]],
]);

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function git(root: string, arguments_: readonly string[]): Buffer {
  try {
    return execFileSync("git", arguments_, {
      cwd: root,
      encoding: "buffer",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    throw new Error(
      `Migration policy could not run git ${arguments_.join(" ")}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function revision(root: string, value: string): string {
  return git(root, ["rev-parse", "--verify", `${value}^{commit}`])
    .toString("utf8")
    .trim();
}

function gitPath(relativePath: string): string {
  return relativePath.replaceAll(path.sep, "/");
}

function fileAt(root: string, revision_: string, relativePath: string): Buffer {
  return git(root, ["show", `${revision_}:${gitPath(relativePath)}`]);
}

function hasFileAt(root: string, revision_: string, relativePath: string): boolean {
  try {
    execFileSync("git", ["cat-file", "-e", `${revision_}:${gitPath(relativePath)}`], {
      cwd: root,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function parseJson(source: Buffer, label: string): unknown {
  try {
    return JSON.parse(source.toString("utf8")) as unknown;
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

function parseJournal(source: Buffer, label: string): Journal {
  const value = parseJson(source, `${label} migration journal`);
  if (
    !object(value) ||
    !exactKeys(value, ["version", "dialect", "entries"]) ||
    value.version !== "7" ||
    value.dialect !== "postgresql" ||
    !Array.isArray(value.entries)
  ) {
    throw new Error(`${label} migration journal has an invalid header.`);
  }

  const tags = new Set<string>();
  const entries: JournalEntry[] = [];
  let previousTimestamp = -1;
  for (const [index, entryValue] of value.entries.entries()) {
    if (
      !object(entryValue) ||
      !exactKeys(entryValue, ["idx", "version", "when", "tag", "breakpoints"]) ||
      entryValue.idx !== index ||
      entryValue.version !== "7" ||
      typeof entryValue.when !== "number" ||
      !Number.isSafeInteger(entryValue.when) ||
      entryValue.when <= 0 ||
      entryValue.when <= previousTimestamp ||
      typeof entryValue.tag !== "string" ||
      !safeTag.test(entryValue.tag) ||
      tags.has(entryValue.tag) ||
      typeof entryValue.breakpoints !== "boolean"
    ) {
      throw new Error(`${label} migration journal entry ${index} is invalid.`);
    }
    tags.add(entryValue.tag);
    previousTimestamp = entryValue.when;
    entries.push({
      idx: index,
      version: "7",
      when: entryValue.when,
      tag: entryValue.tag,
      breakpoints: entryValue.breakpoints,
    });
  }
  return { version: "7", dialect: "postgresql", entries };
}

function parseManifest(source: Buffer, label: string): Manifest {
  const value = parseJson(source, `${label} migration manifest`);
  if (
    !object(value) ||
    !exactKeys(value, ["schemaVersion", "entries"]) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.entries) ||
    value.entries.length === 0
  ) {
    throw new Error(`${label} migration manifest has an invalid header.`);
  }

  const tags = new Set<string>();
  const acceptedHashes = new Set<string>();
  const entries: ManifestEntry[] = [];
  let previousTimestamp = -1;
  for (const [index, entryValue] of value.entries.entries()) {
    if (
      !object(entryValue) ||
      !exactKeys(entryValue, ["tag", "createdAt", "sha256", "compatibleSha256"]) ||
      typeof entryValue.tag !== "string" ||
      !safeTag.test(entryValue.tag) ||
      tags.has(entryValue.tag) ||
      typeof entryValue.createdAt !== "number" ||
      !Number.isSafeInteger(entryValue.createdAt) ||
      entryValue.createdAt <= 0 ||
      entryValue.createdAt <= previousTimestamp ||
      typeof entryValue.sha256 !== "string" ||
      !sha256.test(entryValue.sha256) ||
      !Array.isArray(entryValue.compatibleSha256) ||
      !entryValue.compatibleSha256.every(
        (hash): hash is string => typeof hash === "string" && sha256.test(hash),
      )
    ) {
      throw new Error(`${label} migration manifest entry ${index} is invalid.`);
    }
    const entryHashes = [entryValue.sha256, ...entryValue.compatibleSha256];
    if (
      new Set(entryHashes).size !== entryHashes.length ||
      entryHashes.some((hash) => acceptedHashes.has(hash))
    ) {
      throw new Error(`${label} migration manifest contains duplicate accepted hashes.`);
    }
    for (const hash of entryHashes) acceptedHashes.add(hash);
    tags.add(entryValue.tag);
    previousTimestamp = entryValue.createdAt;
    entries.push({
      tag: entryValue.tag,
      createdAt: entryValue.createdAt,
      sha256: entryValue.sha256,
      compatibleSha256: [...entryValue.compatibleSha256],
    });
  }
  return { schemaVersion: 1, entries };
}

function digest(source: Buffer): string {
  return createHash("sha256").update(source).digest("hex");
}

function validateManifest(
  root: string,
  revision_: string,
  label: string,
  journal: Journal,
  manifest: Manifest,
): void {
  if (manifest.entries.length !== journal.entries.length) {
    throw new Error(`${label} migration manifest and journal lengths differ.`);
  }
  for (const [index, manifestEntry] of manifest.entries.entries()) {
    const journalEntry = journal.entries[index];
    if (
      journalEntry === undefined ||
      journalEntry.tag !== manifestEntry.tag ||
      journalEntry.when !== manifestEntry.createdAt
    ) {
      throw new Error(`${label} migration manifest entry ${index} does not match the journal.`);
    }
    const migration = fileAt(root, revision_, `${migrationDirectory}/${manifestEntry.tag}.sql`);
    if (digest(migration) !== manifestEntry.sha256) {
      throw new Error(
        `${label} migration ${manifestEntry.tag} does not match its manifest SHA-256.`,
      );
    }
  }
}

function assertManifestBootstrapAliases(manifest: Manifest): void {
  for (const entry of manifest.entries) {
    const expected = bootstrapCompatibleHashes.get(entry.tag) ?? [];
    if (JSON.stringify(entry.compatibleSha256) !== JSON.stringify(expected)) {
      throw new Error(
        `Initial migration manifest contains an unapproved compatibility hash for ${entry.tag}.`,
      );
    }
  }
}

function assertAppendedEntriesHaveNoAliases(entries: readonly ManifestEntry[]): void {
  for (const entry of entries) {
    if (entry.compatibleSha256.length !== 0) {
      throw new Error(`New migration ${entry.tag} may not introduce alternate historical hashes.`);
    }
  }
}

function dollarQuoteDelimiter(source: string, index: number): string | undefined {
  const match = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/u.exec(source.slice(index));
  return match?.[0];
}

function sqlStatements(source: string): readonly SqlStatement[] {
  const statements: SqlStatement[] = [];
  let statementStart = 0;
  let searchable = "";
  let containsDollarQuote = false;
  let index = 0;

  const finish = (end: number): void => {
    const statementSource = source.slice(statementStart, end);
    if (statementSource.trim() !== "") {
      statements.push({ source: statementSource, searchable, containsDollarQuote });
    }
    searchable = "";
    containsDollarQuote = false;
  };

  while (index < source.length) {
    if (source.startsWith(statementBreakpoint, index)) {
      finish(index);
      const newline = source.indexOf("\n", index + statementBreakpoint.length);
      index = newline === -1 ? source.length : newline + 1;
      statementStart = index;
      continue;
    }

    const character = source[index] ?? "";
    const next = source[index + 1] ?? "";
    if (character === "-" && next === "-") {
      const newline = source.indexOf("\n", index + 2);
      searchable += " ";
      index = newline === -1 ? source.length : newline;
      continue;
    }
    if (character === "/" && next === "*") {
      let depth = 1;
      index += 2;
      while (index < source.length && depth > 0) {
        if (source[index] === "/" && source[index + 1] === "*") {
          depth += 1;
          index += 2;
        } else if (source[index] === "*" && source[index + 1] === "/") {
          depth -= 1;
          index += 2;
        } else {
          index += 1;
        }
      }
      if (depth !== 0) throw new Error("New migration contains an unterminated block comment.");
      searchable += " ";
      continue;
    }
    if (character === "'") {
      index += 1;
      let closed = false;
      while (index < source.length) {
        if (source[index] === "\\") {
          index += 2;
        } else if (source[index] === "'" && source[index + 1] === "'") {
          index += 2;
        } else if (source[index] === "'") {
          index += 1;
          closed = true;
          break;
        } else {
          index += 1;
        }
      }
      if (!closed) throw new Error("New migration contains an unterminated string literal.");
      searchable += "''";
      continue;
    }
    if (character === '"') {
      const quotedStart = index;
      index += 1;
      let closed = false;
      while (index < source.length) {
        if (source[index] === '"' && source[index + 1] === '"') {
          index += 2;
        } else if (source[index] === '"') {
          index += 1;
          closed = true;
          break;
        } else {
          index += 1;
        }
      }
      if (!closed) throw new Error("New migration contains an unterminated quoted identifier.");
      const quotedIdentifier = source.slice(quotedStart + 1, index - 1).replaceAll('""', '"');
      searchable += quotedIdentifier === "setval" ? '"setval"' : '""';
      continue;
    }
    if (character === "$") {
      const delimiter = dollarQuoteDelimiter(source, index);
      if (delimiter !== undefined) {
        const end = source.indexOf(delimiter, index + delimiter.length);
        if (end === -1) throw new Error("New migration contains an unterminated dollar quote.");
        containsDollarQuote = true;
        searchable += " ";
        index = end + delimiter.length;
        continue;
      }
    }
    searchable += character;
    index += 1;
  }
  finish(source.length);
  return statements;
}

function destructiveOperation(statement: SqlStatement): string | undefined {
  if (statement.containsDollarQuote) return "procedural or dollar-quoted SQL";
  const sql = statement.searchable.replaceAll(/\s+/gu, " ").trim();
  const rules: readonly [RegExp, string][] = [
    [
      /\bDROP\s+(?:TABLE|SCHEMA|DATABASE|TYPE|DOMAIN|SEQUENCE|EXTENSION|OWNED|MATERIALIZED\s+VIEW)\b/iu,
      "DROP data-bearing or compatibility-critical objects",
    ],
    [/\bTRUNCATE(?:\s+TABLE)?\b/iu, "TRUNCATE"],
    [/\bDELETE\s+FROM\b/iu, "DELETE FROM"],
    [/\bUPDATE\b/iu, "UPDATE"],
    [/\bMERGE\b/iu, "MERGE"],
    [/\bSETVAL"?\s*\(/iu, "sequence SETVAL"],
    [/\bALTER\s+SEQUENCE\b[\s\S]*\bRESTART\b/iu, "ALTER SEQUENCE RESTART"],
    [/\bALTER\s+TABLE\b[\s\S]*\bDROP\s+COLUMN\b/iu, "ALTER TABLE DROP COLUMN"],
    [/\bALTER\s+TABLE\b[\s\S]*\bDROP\s+IDENTITY\b/iu, "ALTER TABLE DROP IDENTITY"],
    [
      /\bALTER\s+TABLE\b[\s\S]*\bALTER\s+COLUMN\b[\s\S]*\bRESTART\b/iu,
      "ALTER TABLE identity RESTART",
    ],
    [
      /\bALTER\s+TABLE\b[\s\S]*\bALTER\s+COLUMN\b[\s\S]*\bTYPE\b/iu,
      "ALTER TABLE ALTER COLUMN TYPE",
    ],
    [/\bALTER\s+TABLE\b[\s\S]*\bRENAME\s+COLUMN\b/iu, "ALTER TABLE RENAME COLUMN"],
  ];
  return rules.find(([pattern]) => pattern.test(sql))?.[1];
}

function assertReviewedDestructiveSql(tag: string, source: string): void {
  for (const statement of sqlStatements(source)) {
    const operation = destructiveOperation(statement);
    if (operation !== undefined && !destructiveReview.test(statement.source)) {
      throw new Error(
        `New migration ${tag} contains ${operation}. Put the two required schedule-migration-review and schedule-migration-reason comments immediately before that statement.`,
      );
    }
  }
}

export function parseMigrationPolicyArguments(arguments_: readonly string[]): {
  readonly base: string;
} {
  const argumentsWithoutPnpmSeparator = arguments_[0] === "--" ? arguments_.slice(1) : arguments_;
  if (argumentsWithoutPnpmSeparator.length === 0) return { base: "HEAD^" };
  if (
    argumentsWithoutPnpmSeparator.length === 2 &&
    argumentsWithoutPnpmSeparator[0] === "--base" &&
    argumentsWithoutPnpmSeparator[1] !== undefined
  ) {
    return { base: argumentsWithoutPnpmSeparator[1] };
  }
  throw new Error("Usage: pnpm verify:migration-policy [-- --base <base-commit>]");
}

export function verifyMigrationPolicy(options: {
  readonly repositoryRoot: string;
  readonly base: string;
  readonly head?: string;
}): void {
  const base = revision(options.repositoryRoot, options.base);
  const head = revision(options.repositoryRoot, options.head ?? "HEAD");
  const baseJournal = parseJournal(fileAt(options.repositoryRoot, base, journalPath), "Base");
  const headJournal = parseJournal(fileAt(options.repositoryRoot, head, journalPath), "Current");
  if (headJournal.entries.length < baseJournal.entries.length) {
    throw new Error("Current migration journal removes historical migrations.");
  }
  for (const entry of baseJournal.entries) {
    const current = headJournal.entries[entry.idx];
    if (JSON.stringify(current) !== JSON.stringify(entry)) {
      throw new Error(`Historical migration journal entry ${entry.tag} was changed or reordered.`);
    }
    const migrationPath = `${migrationDirectory}/${entry.tag}.sql`;
    if (
      digest(fileAt(options.repositoryRoot, base, migrationPath)) !==
      digest(fileAt(options.repositoryRoot, head, migrationPath))
    ) {
      throw new Error(
        `Historical migration ${entry.tag} was changed (SHA-256 no longer matches its base revision).`,
      );
    }
  }

  const headManifest = parseManifest(fileAt(options.repositoryRoot, head, manifestPath), "Current");
  validateManifest(options.repositoryRoot, head, "Current", headJournal, headManifest);
  if (hasFileAt(options.repositoryRoot, base, manifestPath)) {
    const baseManifest = parseManifest(fileAt(options.repositoryRoot, base, manifestPath), "Base");
    validateManifest(options.repositoryRoot, base, "Base", baseJournal, baseManifest);
    for (const [index, entry] of baseManifest.entries.entries()) {
      if (JSON.stringify(headManifest.entries[index]) !== JSON.stringify(entry)) {
        throw new Error(`Historical migration manifest entry ${entry.tag} was changed.`);
      }
    }
    assertAppendedEntriesHaveNoAliases(headManifest.entries.slice(baseManifest.entries.length));
  } else {
    assertManifestBootstrapAliases(headManifest);
  }

  for (const entry of headJournal.entries.slice(baseJournal.entries.length)) {
    assertReviewedDestructiveSql(
      entry.tag,
      fileAt(options.repositoryRoot, head, `${migrationDirectory}/${entry.tag}.sql`).toString(
        "utf8",
      ),
    );
  }
}

function main(): void {
  const options = parseMigrationPolicyArguments(process.argv.slice(2));
  verifyMigrationPolicy({ repositoryRoot: process.cwd(), base: options.base });
  process.stdout.write(
    "Migration policy verification passed: the ledger authority and historical migrations are immutable, and risky new SQL is explicitly reviewed.\n",
  );
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
