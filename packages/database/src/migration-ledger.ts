import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

import type { Sql } from "postgres";

const MAX_MANIFEST_BYTES = 1024 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;
const SAFE_TAG = /^[A-Za-z0-9_-]+$/u;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/u;

export type MigrationLedgerStatus = "exact" | "prefix" | "ahead" | "divergent";

export interface MigrationManifestEntry {
  readonly tag: string;
  readonly createdAt: number;
  readonly sha256: string;
  readonly compatibleSha256: readonly string[];
  /** Deterministic CRLF form of the canonical SQL for databases created on Windows. */
  readonly crlfSha256?: string;
}

export interface MigrationManifest {
  readonly schemaVersion: 1;
  readonly entries: readonly MigrationManifestEntry[];
}

export interface MigrationLedgerRow {
  readonly id: string;
  readonly createdAt: string;
  readonly hash: string;
}

export interface MigrationLedgerSnapshot {
  readonly exists: boolean;
  readonly hasUserRelations: boolean;
  readonly rows: readonly MigrationLedgerRow[];
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function portableSqlDigests(sql: Buffer): { readonly lf: string; readonly crlf?: string } {
  const source = sql.toString("utf8");
  if (!Buffer.from(source, "utf8").equals(sql)) {
    throw new Error("Migration SQL is not valid UTF-8.");
  }
  const lfSource = source.replaceAll("\r\n", "\n");
  if (lfSource.includes("\r")) {
    throw new Error("Migration SQL contains an invalid line ending.");
  }
  const lf = digest(Buffer.from(lfSource, "utf8"));
  const crlf = digest(Buffer.from(lfSource.replaceAll("\n", "\r\n"), "utf8"));
  return { lf, ...(crlf === lf ? {} : { crlf }) };
}

async function boundedJson(file: string): Promise<unknown> {
  const metadata = await stat(file);
  if (!metadata.isFile() || metadata.size === 0 || metadata.size > MAX_MANIFEST_BYTES) {
    throw new Error("Migration metadata is invalid.");
  }
  return JSON.parse(await readFile(file, "utf8")) as unknown;
}

/** Load the committed compatibility authority and prove it matches Drizzle's inputs. */
export async function loadMigrationManifest(migrationsFolder: string): Promise<MigrationManifest> {
  const manifestValue = await boundedJson(
    path.join(migrationsFolder, "meta", "_migration_manifest.json"),
  );
  const journalValue = await boundedJson(path.join(migrationsFolder, "meta", "_journal.json"));
  if (
    !object(manifestValue) ||
    !exactKeys(manifestValue, ["schemaVersion", "entries"]) ||
    manifestValue.schemaVersion !== 1 ||
    !Array.isArray(manifestValue.entries) ||
    manifestValue.entries.length === 0 ||
    !object(journalValue) ||
    !exactKeys(journalValue, ["version", "dialect", "entries"]) ||
    journalValue.version !== "7" ||
    journalValue.dialect !== "postgresql" ||
    !Array.isArray(journalValue.entries) ||
    journalValue.entries.length !== manifestValue.entries.length
  ) {
    throw new Error("Migration manifest is invalid.");
  }

  const entries: MigrationManifestEntry[] = [];
  const tags = new Set<string>();
  const acceptedHashes = new Set<string>();
  let previousCreatedAt = -1;
  for (let index = 0; index < manifestValue.entries.length; index += 1) {
    const value = manifestValue.entries[index];
    const journal = journalValue.entries[index];
    if (
      !object(value) ||
      !exactKeys(value, ["tag", "createdAt", "sha256", "compatibleSha256"]) ||
      typeof value.tag !== "string" ||
      !SAFE_TAG.test(value.tag) ||
      tags.has(value.tag) ||
      typeof value.createdAt !== "number" ||
      !Number.isSafeInteger(value.createdAt) ||
      value.createdAt <= 0 ||
      value.createdAt <= previousCreatedAt ||
      typeof value.sha256 !== "string" ||
      !SHA256.test(value.sha256) ||
      !Array.isArray(value.compatibleSha256) ||
      !value.compatibleSha256.every((hash) => typeof hash === "string" && SHA256.test(hash)) ||
      !object(journal) ||
      !exactKeys(journal, ["idx", "version", "when", "tag", "breakpoints"]) ||
      journal.idx !== index ||
      journal.version !== "7" ||
      typeof journal.when !== "number" ||
      !Number.isSafeInteger(journal.when) ||
      journal.when <= 0 ||
      journal.tag !== value.tag ||
      journal.when !== value.createdAt ||
      typeof journal.breakpoints !== "boolean"
    ) {
      throw new Error("Migration manifest is invalid.");
    }
    const accepted = [value.sha256, ...value.compatibleSha256];
    if (
      new Set(accepted).size !== accepted.length ||
      accepted.some((hash) => acceptedHashes.has(hash))
    ) {
      throw new Error("Migration manifest contains duplicate hashes.");
    }
    tags.add(value.tag);
    for (const hash of accepted) acceptedHashes.add(hash);
    const sql = await readFile(path.join(migrationsFolder, `${value.tag}.sql`));
    const sqlDigests = portableSqlDigests(sql);
    if (sqlDigests.lf !== value.sha256) {
      throw new Error("Migration SQL does not match the immutable manifest.");
    }
    if (sqlDigests.crlf !== undefined && acceptedHashes.has(sqlDigests.crlf)) {
      throw new Error("Migration manifest contains duplicate hashes.");
    }
    if (sqlDigests.crlf !== undefined) acceptedHashes.add(sqlDigests.crlf);
    previousCreatedAt = value.createdAt;
    entries.push({
      tag: value.tag,
      createdAt: value.createdAt,
      sha256: value.sha256,
      compatibleSha256: [...value.compatibleSha256] as string[],
      ...(sqlDigests.crlf === undefined ? {} : { crlfSha256: sqlDigests.crlf }),
    });
  }
  return { schemaVersion: 1, entries };
}

/** Compare a bounded, ordered live ledger with the immutable expected history. */
export function classifyMigrationLedger(
  manifest: MigrationManifest,
  snapshot: MigrationLedgerSnapshot,
): MigrationLedgerStatus {
  if (snapshot.rows.length === 0) {
    return snapshot.hasUserRelations ? "divergent" : "prefix";
  }
  if (!snapshot.exists) return "divergent";

  let previousId = 0n;
  const overlap = Math.min(snapshot.rows.length, manifest.entries.length);
  for (let index = 0; index < overlap; index += 1) {
    const row = snapshot.rows[index];
    const expected = manifest.entries[index];
    if (
      row === undefined ||
      expected === undefined ||
      !DECIMAL.test(row.id) ||
      !DECIMAL.test(row.createdAt) ||
      !SHA256.test(row.hash)
    ) {
      return "divergent";
    }
    const id = BigInt(row.id);
    if (
      id <= previousId ||
      row.createdAt !== String(expected.createdAt) ||
      (row.hash !== expected.sha256 &&
        row.hash !== expected.crlfSha256 &&
        !expected.compatibleSha256.includes(row.hash))
    ) {
      return "divergent";
    }
    previousId = id;
  }
  if (snapshot.rows.length < manifest.entries.length) return "prefix";
  if (snapshot.rows.length === manifest.entries.length) return "exact";
  return "ahead";
}

/** Read only enough live state to determine compatibility, including one ahead sentinel row. */
export async function inspectMigrationLedger(
  sql: Sql,
  manifest: MigrationManifest,
): Promise<MigrationLedgerStatus> {
  const [probe] = await sql<{ ledgerKind: string | null; hasUserRelations: boolean }[]>`select
      (select c.relkind::text
        from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'drizzle'
          and c.relname = '__drizzle_migrations') as "ledgerKind",
      exists (
        select 1
        from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid = c.relnamespace
        where n.nspname <> 'information_schema'
          and n.nspname !~ '^pg_'
          and c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
          and not (
            n.nspname = 'drizzle'
            and c.relname = '__drizzle_migrations'
            and c.relkind = 'r'
          )
          and not (
            c.relkind = 'S'
            and n.nspname = 'drizzle'
            and c.relname = '__drizzle_migrations_id_seq'
            and exists (
              select 1
              from pg_catalog.pg_depend d
              join pg_catalog.pg_class owner on owner.oid = d.refobjid
              join pg_catalog.pg_namespace owner_namespace
                on owner_namespace.oid = owner.relnamespace
              join pg_catalog.pg_attribute owner_column
                on owner_column.attrelid = owner.oid
                and owner_column.attnum = d.refobjsubid
              where d.classid = 'pg_catalog.pg_class'::regclass
                and d.objid = c.oid
                and d.refclassid = 'pg_catalog.pg_class'::regclass
                and d.deptype in ('a', 'i')
                and owner_namespace.nspname = 'drizzle'
                and owner.relname = '__drizzle_migrations'
                and owner.relkind = 'r'
                and owner_column.attname = 'id'
            )
          )
      ) as "hasUserRelations"`;
  if (probe === undefined) throw new Error("Migration ledger probe failed.");
  if (probe.ledgerKind === null) {
    return classifyMigrationLedger(manifest, {
      exists: false,
      hasUserRelations: probe.hasUserRelations,
      rows: [],
    });
  }
  if (probe.ledgerKind !== "r") return "divergent";
  const rows = await sql<MigrationLedgerRow[]>`
    select migrations.id::text as id, migrations.created_at::text as "createdAt", migrations.hash
    from drizzle.__drizzle_migrations migrations
    order by migrations.id
    limit ${manifest.entries.length + 1}
  `;
  return classifyMigrationLedger(manifest, {
    exists: true,
    hasUserRelations: probe.hasUserRelations,
    rows,
  });
}
