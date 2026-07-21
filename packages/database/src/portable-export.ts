import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import {
  lstat,
  mkdtemp,
  open,
  opendir,
  readFile,
  rm,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { Sql } from "postgres";

import { createDatabase } from "./database.js";
import { inspectMigrationLedger, loadMigrationManifest } from "./migration-ledger.js";
import { portableDataPolicyV1, type PortableDataTableV1 } from "./portable-data.js";
import {
  currentProducerPlatform,
  type PortableArchiveManifestV1,
  writePortableArchive,
} from "./portable-archive.js";
import {
  readPortablePayload,
  writePortablePayload,
  type PortableColumnDescriptor,
  type PortableColumnMap,
  type PortablePayloadExpectations,
  type PortableTextValue,
} from "./portable-payload.js";

export const portableExportScavengeAgeMs = 24 * 60 * 60 * 1_000;
export const portableExportScavengeLimit = 32;
const portableExportScavengeEntryLimit = portableExportScavengeLimit * 8;
const portableExportTemporaryPrefix = "schedule-portable-export-";
const portableExportOwnerMarkerName = ".schedule-portable-export-owner-v1";
const portableExportOwnerMarkerV1 = "schedule-portable-export-temporary\nversion=1\n";
const portableExportPayloadName = "portable-data.ndjson";

function sameIdentity(first: BigIntStats, second: BigIntStats): boolean {
  return first.dev === second.dev && first.ino === second.ino;
}

function sameFileState(first: BigIntStats, second: BigIntStats): boolean {
  return (
    sameIdentity(first, second) &&
    first.size === second.size &&
    first.mtimeNs === second.mtimeNs &&
    first.ctimeNs === second.ctimeNs
  );
}

function isStale(metadata: BigIntStats, nowMs: number): boolean {
  return metadata.mtimeMs <= BigInt(Math.floor(nowMs - portableExportScavengeAgeMs));
}

async function stableRegularFile(filePath: string): Promise<BigIntStats | null> {
  try {
    const before = await lstat(filePath, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink()) return null;
    const file = await open(
      filePath,
      constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
    );
    try {
      const opened = await file.stat({ bigint: true });
      return sameFileState(before, opened) ? opened : null;
    } finally {
      await file.close();
    }
  } catch {
    return null;
  }
}

async function readStableOwnerMarker(markerPath: string): Promise<BigIntStats | null> {
  const before = await stableRegularFile(markerPath);
  if (before === null || before.size > 1024n) return null;
  try {
    const marker = await open(
      markerPath,
      constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
    );
    try {
      const opened = await marker.stat({ bigint: true });
      if (!sameFileState(before, opened)) return null;
      const bytes = await marker.readFile();
      const after = await marker.stat({ bigint: true });
      return bytes.toString("utf8") === portableExportOwnerMarkerV1 && sameFileState(opened, after)
        ? after
        : null;
    } finally {
      await marker.close();
    }
  } catch {
    return null;
  }
}

type PortableExportTemporaryDirectoryContents = "marker-only" | "with-payload";

/**
 * A stale export directory is deliberately flat and has no more than two owned entries.
 * Stop after the third entry rather than materializing an attacker-controlled directory.
 */
async function inspectPortableExportTemporaryDirectory(
  directoryPath: string,
): Promise<PortableExportTemporaryDirectoryContents | null> {
  try {
    const directory = await opendir(directoryPath);
    try {
      const first = await directory.read();
      const second = await directory.read();
      const third = await directory.read();
      if (first === null || third !== null) return null;
      if (second === null) {
        return first.name === portableExportOwnerMarkerName ? "marker-only" : null;
      }
      return (first.name === portableExportOwnerMarkerName &&
        second.name === portableExportPayloadName) ||
        (first.name === portableExportPayloadName && second.name === portableExportOwnerMarkerName)
        ? "with-payload"
        : null;
    } finally {
      await directory.close();
    }
  } catch {
    return null;
  }
}

/** Best-effort bounded cleanup of stale, flat v1-owned export work directories. */
export async function scavengePortableExportTemporaryDirectories(
  temporaryRoot = tmpdir(),
  nowMs = Date.now(),
  maximumCandidates = portableExportScavengeLimit,
): Promise<number> {
  const candidateLimit = Number.isSafeInteger(maximumCandidates)
    ? Math.max(0, Math.min(maximumCandidates, portableExportScavengeLimit))
    : 0;
  if (!Number.isFinite(nowMs) || candidateLimit === 0) return 0;
  let root: BigIntStats;
  try {
    root = await lstat(temporaryRoot, { bigint: true });
    if (!root.isDirectory() || root.isSymbolicLink()) return 0;
  } catch {
    return 0;
  }
  let entriesInspected = 0;
  let candidatesExamined = 0;
  let removed = 0;
  try {
    const directory = await opendir(temporaryRoot);
    for await (const entry of directory) {
      if (entriesInspected >= portableExportScavengeEntryLimit) break;
      entriesInspected += 1;
      if (!/^schedule-portable-export-[A-Za-z0-9]{6}$/.test(entry.name)) continue;
      if (candidatesExamined >= candidateLimit) break;
      candidatesExamined += 1;
      const candidatePath = path.join(temporaryRoot, entry.name);
      let candidate: BigIntStats;
      try {
        candidate = await lstat(candidatePath, { bigint: true });
      } catch {
        continue;
      }
      if (!candidate.isDirectory() || candidate.isSymbolicLink() || !isStale(candidate, nowMs)) {
        continue;
      }
      const contents = await inspectPortableExportTemporaryDirectory(candidatePath);
      if (contents === null) continue;
      const markerPath = path.join(candidatePath, portableExportOwnerMarkerName);
      const marker = await readStableOwnerMarker(markerPath);
      if (marker === null || !isStale(marker, nowMs)) continue;

      let payload: BigIntStats | undefined;
      if (contents === "with-payload") {
        const payloadPath = path.join(candidatePath, portableExportPayloadName);
        payload = (await stableRegularFile(payloadPath)) ?? undefined;
        if (payload === undefined || !isStale(payload, nowMs)) continue;
      }
      try {
        const currentRoot = await lstat(temporaryRoot, { bigint: true });
        const currentCandidate = await lstat(candidatePath, { bigint: true });
        if (!sameIdentity(root, currentRoot) || !sameIdentity(candidate, currentCandidate))
          continue;
        if (payload !== undefined) {
          const payloadPath = path.join(candidatePath, portableExportPayloadName);
          const currentPayload = await lstat(payloadPath, { bigint: true });
          if (!sameFileState(payload, currentPayload)) continue;
          await unlink(payloadPath);
        }
        const currentMarker = await lstat(markerPath, { bigint: true });
        if (!sameFileState(marker, currentMarker)) continue;
        await unlink(markerPath);
        await rmdir(candidatePath);
        removed += 1;
      } catch {
        // Preserve unreadable, swapped, or concurrently changed candidates for safety.
      }
    }
  } catch {
    // Temporary-root enumeration is opportunistic and must not block a new export.
  }
  return removed;
}

export interface PortableExportArtifact<Manifest = unknown> {
  readonly path: string;
  readonly sizeBytes: number;
  readonly manifest: Manifest;
}

export interface PortableExportRuntime<Source, Verification, Manifest = unknown> {
  /** Runs even when prepareSource fails after allocating host resources. */
  readonly cleanup?: () => Promise<void>;
  readonly prepareSource: () => Promise<Source>;
  readonly createVerification: (source: Source) => Promise<Verification>;
  readonly writeArchive: (
    source: Source,
    verification: Verification,
  ) => Promise<PortableExportArtifact<Manifest>>;
  readonly cleanupVerification: (verification: Verification) => Promise<void>;
  readonly cleanupSource: (source: Source) => Promise<void>;
  readonly removeArchive: (path: string) => Promise<void>;
}

/** A completed, verified archive is retained when only post-operation cleanup fails. */
export function shouldRemovePortableExportResult(operationError: unknown): boolean {
  return operationError !== undefined;
}

export async function runPortableExport<Source, Verification, Manifest = unknown>(
  runtime: PortableExportRuntime<Source, Verification, Manifest>,
): Promise<PortableExportArtifact<Manifest>> {
  let source: Source | undefined;
  let verification: Verification | undefined;
  let artifact: PortableExportArtifact<Manifest> | undefined;
  let operationError: unknown;
  try {
    source = await runtime.prepareSource();
    verification = await runtime.createVerification(source);
    artifact = await runtime.writeArchive(source, verification);
  } catch (error) {
    operationError = error;
  }

  const cleanupErrors: unknown[] = [];
  if (verification !== undefined) {
    try {
      await runtime.cleanupVerification(verification);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (source !== undefined) {
    try {
      await runtime.cleanupSource(source);
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (runtime.cleanup !== undefined) {
    try {
      await runtime.cleanup();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (operationError !== undefined || cleanupErrors.length > 0) {
    if (artifact !== undefined && shouldRemovePortableExportResult(operationError)) {
      try {
        await runtime.removeArchive(artifact.path);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    const errors =
      operationError === undefined ? cleanupErrors : [operationError, ...cleanupErrors];
    throw errors.length === 1
      ? errors[0]
      : new AggregateError(errors, "Portable export failed and cleanup was incomplete.");
  }
  if (artifact === undefined) throw new Error("Portable export produced no archive.");
  return artifact;
}

export interface PortableMigrationIdentity {
  readonly count: number;
  readonly latestTag: string;
  readonly fingerprint: string;
}

export async function readPortableMigrationIdentity(
  migrationsFolder: string,
): Promise<PortableMigrationIdentity> {
  const journal = JSON.parse(
    await readFile(path.join(migrationsFolder, "meta", "_journal.json"), "utf8"),
  ) as {
    entries?: {
      idx?: unknown;
      version?: unknown;
      when?: unknown;
      tag?: unknown;
      breakpoints?: unknown;
    }[];
  };
  if (!Array.isArray(journal.entries) || journal.entries.length === 0) {
    throw new Error("Drizzle migration journal is missing or empty.");
  }
  const hash = createHash("sha256");
  hash.update("schedule-portable-migrations-v1\0", "utf8");
  let latestTag = "";
  for (const [position, entry] of journal.entries.entries()) {
    if (
      entry.idx !== position ||
      typeof entry.version !== "string" ||
      typeof entry.when !== "number" ||
      !Number.isSafeInteger(entry.when) ||
      typeof entry.tag !== "string" ||
      !/^\d{4}_[a-z0-9_-]+$/.test(entry.tag) ||
      typeof entry.breakpoints !== "boolean"
    ) {
      throw new Error(`Drizzle migration journal entry ${position} is invalid.`);
    }
    const sql = (await readFile(path.join(migrationsFolder, `${entry.tag}.sql`), "utf8")).replace(
      /\r\n?/g,
      "\n",
    );
    hash.update(
      JSON.stringify([
        entry.idx,
        entry.version,
        entry.when,
        entry.tag,
        entry.breakpoints,
        Buffer.byteLength(sql, "utf8"),
      ]),
      "utf8",
    );
    hash.update("\0", "utf8");
    hash.update(sql, "utf8");
    hash.update("\0", "utf8");
    latestTag = entry.tag;
  }
  return { count: journal.entries.length, latestTag, fingerprint: hash.digest("hex") };
}

interface PortableCatalogColumnRow {
  readonly table_name: string;
  readonly column_name: string;
  readonly data_type: string;
  readonly type_schema: string;
  readonly type_name: string;
  readonly type_kind: string;
  readonly identity_kind: string;
  readonly generated_kind: string;
}

interface PortableColumnCatalog {
  readonly columns: PortableColumnMap;
  readonly casts: Readonly<Record<PortableDataTableV1, readonly string[]>>;
}

type PortableQuerySql = Pick<Sql, "unsafe">;

export interface PortableDatabaseSignals {
  readonly contentSignals: Readonly<Record<string, string>>;
  readonly sequenceSignals: Readonly<Record<string, string>>;
}

export interface VerifiedPortableDatabaseExportOptions {
  readonly outputPath: string;
  readonly sourceDatabaseUrl: string;
  readonly migrationsFolder: string;
  readonly applicationVersion: string;
  /** Called immediately after creation so a later failure still owns cleanup. */
  readonly createVerificationDatabase: (
    databaseName: string,
    databaseUrl: string,
    onCreated: () => void,
  ) => Promise<void>;
  readonly migrateVerificationDatabase: (
    databaseName: string,
    databaseUrl: string,
  ) => Promise<void>;
  readonly dropVerificationDatabase: (databaseName: string) => Promise<void>;
  readonly verificationDatabaseUrl?: (databaseName: string) => string;
  readonly verificationDatabaseName?: () => string;
}

function quoteIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) {
    throw new Error("Portable PostgreSQL identifier is invalid.");
  }
  return `"${value}"`;
}

function databaseUrlFor(base: string, databaseName: string): string {
  quoteIdentifier(databaseName);
  const url = new URL(base);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("Portable PostgreSQL URL is invalid.");
  }
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function portableCastSql(column: PortableCatalogColumnRow): string {
  if (column.type_schema === "public" && column.type_kind === "e") {
    if (!/^[a-z_][a-z0-9_]*$/.test(column.type_name) || column.data_type !== column.type_name) {
      throw new Error(`Portable enum type is not supported: ${column.data_type}`);
    }
    return `public.${quoteIdentifier(column.type_name)}`;
  }
  if (column.type_schema !== "pg_catalog") {
    throw new Error(`Portable column type is not supported: ${column.data_type}`);
  }
  const fixed = new Map<string, string>([
    ["bigint", "pg_catalog.int8"],
    ["boolean", "pg_catalog.bool"],
    ["date", "pg_catalog.date"],
    ["integer", "pg_catalog.int4"],
    ["integer[]", "pg_catalog.int4[]"],
    ["jsonb", "pg_catalog.jsonb"],
    ["text", "pg_catalog.text"],
    ["text[]", "pg_catalog.text[]"],
    ["timestamp with time zone", "pg_catalog.timestamptz"],
    ["timestamp without time zone", "pg_catalog.timestamp"],
    ["uuid", "pg_catalog.uuid"],
  ]);
  const fixedType = fixed.get(column.data_type);
  if (fixedType !== undefined) return fixedType;
  const varying = /^character varying\((\d+)\)$/.exec(column.data_type);
  const length = varying?.[1] === undefined ? Number.NaN : Number(varying[1]);
  if (Number.isSafeInteger(length) && length > 0 && length <= 10_485_760) {
    return `pg_catalog.varchar(${length})`;
  }
  throw new Error(`Portable column type is not supported: ${column.data_type}`);
}

async function readPortableColumnCatalog(sql: PortableQuerySql): Promise<PortableColumnCatalog> {
  const tableValues = portableDataPolicyV1.includedTables.map((table) => `('${table}')`).join(", ");
  const rows = await sql.unsafe<PortableCatalogColumnRow[]>(`
    WITH selected_tables(name) AS (VALUES ${tableValues})
    SELECT relation.relname AS table_name,
      attribute.attname AS column_name,
      pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) AS data_type,
      type_namespace.nspname AS type_schema,
      column_type.typname AS type_name,
      column_type.typtype AS type_kind,
      attribute.attidentity AS identity_kind,
      attribute.attgenerated AS generated_kind
    FROM pg_catalog.pg_class AS relation
    JOIN pg_catalog.pg_namespace AS relation_namespace ON relation_namespace.oid = relation.relnamespace
    JOIN selected_tables ON selected_tables.name = relation.relname
    JOIN pg_catalog.pg_attribute AS attribute
      ON attribute.attrelid = relation.oid AND attribute.attnum > 0 AND NOT attribute.attisdropped
    JOIN pg_catalog.pg_type AS column_type ON column_type.oid = attribute.atttypid
    JOIN pg_catalog.pg_namespace AS type_namespace ON type_namespace.oid = column_type.typnamespace
    WHERE relation_namespace.nspname = 'public' AND relation.relkind IN ('r', 'p')
    ORDER BY relation.relname, attribute.attname
  `);
  const columns = Object.fromEntries(
    portableDataPolicyV1.includedTables.map((table) => [table, [] as PortableColumnDescriptor[]]),
  ) as Record<PortableDataTableV1, PortableColumnDescriptor[]>;
  const casts = Object.fromEntries(
    portableDataPolicyV1.includedTables.map((table) => [table, [] as string[]]),
  ) as Record<PortableDataTableV1, string[]>;
  for (const row of rows) {
    if (
      !portableDataPolicyV1.includedTables.includes(row.table_name as PortableDataTableV1) ||
      !/^[a-z_][a-z0-9_]*$/.test(row.column_name) ||
      row.identity_kind !== "" ||
      row.generated_kind !== ""
    ) {
      throw new Error(`Portable database column metadata is unsupported: ${row.table_name}.`);
    }
    const table = row.table_name as PortableDataTableV1;
    if (columns[table].some(({ name }) => name === row.column_name)) {
      throw new Error(
        `Portable database column metadata is duplicated: ${table}.${row.column_name}.`,
      );
    }
    columns[table].push({ name: row.column_name, type: row.data_type });
    casts[table].push(portableCastSql(row));
  }
  for (const table of portableDataPolicyV1.includedTables) {
    if (columns[table].length === 0 || columns[table].length !== casts[table].length) {
      throw new Error(`Portable database table metadata is missing: ${table}.`);
    }
  }
  return { columns, casts };
}

function normalizedRowExpression(table: string): string {
  switch (table) {
    case "work_items":
      return `to_jsonb("record") || jsonb_build_object('hosted_sync_cursor', to_jsonb(0::bigint))`;
    case "audit_events":
      return `to_jsonb("record") || jsonb_build_object('actor_id', null)`;
    case "natural_language_proposals":
      return `CASE WHEN "record".status = 'pending' THEN to_jsonb("record") || jsonb_build_object(
        'status', 'cancelled', 'cancelled_at', to_jsonb("record".expires_at),
        'updated_at', to_jsonb(GREATEST("record".updated_at, "record".expires_at)),
        'version', to_jsonb("record".version + 1)) ELSE to_jsonb("record") END`;
    case "webhook_endpoints":
      return `CASE WHEN "record".status = 'active' THEN to_jsonb("record") || jsonb_build_object(
        'status', 'revoked', 'revoked_at', to_jsonb("record".updated_at))
        ELSE to_jsonb("record") END`;
    default:
      return `to_jsonb("record")`;
  }
}

async function readSignals(sql: PortableQuerySql): Promise<PortableDatabaseSignals> {
  const contentSignals: Record<string, string> = {};
  for (const table of portableDataPolicyV1.includedTables) {
    const [row] = await sql.unsafe<{ signal: string }[]>(`
      SELECT count(*)::text || ':' || md5(COALESCE(
        string_agg(normalized::text, E'\\n' ORDER BY normalized::text), ''
      )) AS signal
      FROM (SELECT ${normalizedRowExpression(table)} AS normalized
        FROM public.${quoteIdentifier(table)} AS "record") AS portable_rows
    `);
    if (row === undefined || !/^\d+:[0-9a-f]{32}$/.test(row.signal)) {
      throw new Error(`Portable table ${table} content signal is invalid.`);
    }
    contentSignals[table] = row.signal;
  }
  const sequenceSignals: Record<string, string> = {};
  for (const sequence of portableDataPolicyV1.sequences) {
    const [row] = await sql.unsafe<{ last_value: string; is_called: boolean }[]>(
      `SELECT last_value::text AS last_value, is_called FROM public.${quoteIdentifier(sequence)}`,
    );
    if (
      row === undefined ||
      !/^-?\d+$/.test(row.last_value) ||
      typeof row.is_called !== "boolean"
    ) {
      throw new Error(`Portable sequence ${sequence} state is invalid.`);
    }
    sequenceSignals[sequence] = `${row.last_value}:${row.is_called ? "true" : "false"}`;
  }
  return { contentSignals, sequenceSignals };
}

export const portableCanonicalSessionStatements = [
  "SET LOCAL TIME ZONE 'UTC'",
  "SET LOCAL DateStyle = 'ISO, YMD'",
  "SET LOCAL IntervalStyle = 'postgres'",
  "SET LOCAL bytea_output = 'hex'",
  "SET LOCAL extra_float_digits = 3",
] as const;

async function applyPortableCanonicalSessionSettings(sql: PortableQuerySql): Promise<void> {
  for (const statement of portableCanonicalSessionStatements) await sql.unsafe(statement);
}

async function schemaSignatures(sql: PortableQuerySql): Promise<readonly string[]> {
  const tableValues = portableDataPolicyV1.includedTables.map((table) => `('${table}')`).join(", ");
  const sequenceValues = portableDataPolicyV1.sequences
    .map((sequence) => `('${sequence}')`)
    .join(", ");
  const rows = await sql.unsafe<{ signature: string }[]>(`
    WITH selected_tables(name) AS (VALUES ${tableValues}),
    selected_sequences(name) AS (VALUES ${sequenceValues}),
    selected_relations AS (
      SELECT relation.oid, relation.relname
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      JOIN selected_tables ON selected_tables.name = relation.relname
      WHERE namespace.nspname = 'public' AND relation.relkind IN ('r', 'p')
    ), objects AS (
      SELECT 'column|public|' || relation.relname || '|' || attribute.attname || '|' ||
        pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) || '|' ||
        attribute.attnotnull::text || '|' || attribute.attidentity::text || '|' ||
        attribute.attgenerated::text AS signature
      FROM selected_relations AS relation
      JOIN pg_catalog.pg_attribute AS attribute ON attribute.attrelid = relation.oid
        AND attribute.attnum > 0 AND NOT attribute.attisdropped
      UNION ALL
      SELECT 'enum|public|' || enum_type.typname || '|' || enum_value.enumsortorder::text || '|' ||
        enum_value.enumlabel
      FROM selected_relations AS relation
      JOIN pg_catalog.pg_attribute AS attribute ON attribute.attrelid = relation.oid
        AND attribute.attnum > 0 AND NOT attribute.attisdropped
      JOIN pg_catalog.pg_type AS enum_type ON enum_type.oid = attribute.atttypid
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = enum_type.typnamespace
      JOIN pg_catalog.pg_enum AS enum_value ON enum_value.enumtypid = enum_type.oid
      WHERE namespace.nspname = 'public'
      UNION ALL
      SELECT 'sequence|public|' || sequence.sequencename || '|' || sequence.data_type || '|' ||
        sequence.start_value || '|' || sequence.min_value || '|' || sequence.max_value || '|' ||
        sequence.increment_by || '|' || sequence.cycle::text
      FROM pg_catalog.pg_sequences AS sequence
      JOIN selected_sequences ON selected_sequences.name = sequence.sequencename
      WHERE sequence.schemaname = 'public'
    ) SELECT signature FROM objects ORDER BY signature
  `);
  if (rows.length === 0 || rows.some(({ signature }) => typeof signature !== "string")) {
    throw new Error("Portable database schema signal is incomplete.");
  }
  return rows.map(({ signature }) => signature);
}

async function schemaSignal(sql: PortableQuerySql): Promise<string> {
  return createHash("sha256")
    .update((await schemaSignatures(sql)).join("\n"), "utf8")
    .digest("hex");
}

/** Full live-schema admission signal; the archive manifest separately keeps its v1 portable signal. */
async function fullSchemaSignal(sql: PortableQuerySql): Promise<string> {
  const [row] = await sql.unsafe<{ signal: string }[]>(`
    WITH live_columns AS (
      SELECT columns.*, row_number() OVER (
        PARTITION BY table_schema, table_name ORDER BY ordinal_position
      ) AS live_ordinal_position
      FROM information_schema.columns AS columns
      WHERE table_schema IN ('public', 'drizzle')
    ), objects AS (
      SELECT 'relation|' || namespace.nspname || '|' || relation.relname || '|' ||
        relation.relkind::text || '|' || relation.relrowsecurity::text || '|' ||
        relation.relforcerowsecurity::text AS signature
      FROM pg_catalog.pg_class AS relation
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname IN ('public', 'drizzle')
        AND relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
      UNION ALL
      SELECT 'column|' || table_schema || '|' || table_name || '|' ||
        live_ordinal_position::text || '|' || column_name || '|' || data_type || '|' ||
        udt_schema || '|' || udt_name || '|' || is_nullable || '|' ||
        COALESCE(column_default, '') AS signature
      FROM live_columns
      UNION ALL
      SELECT 'constraint|' || namespace.nspname || '|' || relation.relname || '|' ||
        constraint_name.conname || '|' || pg_catalog.pg_get_constraintdef(constraint_name.oid, true)
      FROM pg_catalog.pg_constraint AS constraint_name
      JOIN pg_catalog.pg_class AS relation ON relation.oid = constraint_name.conrelid
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname IN ('public', 'drizzle')
      UNION ALL
      SELECT 'index|' || schemaname || '|' || indexname || '|' || indexdef
      FROM pg_catalog.pg_indexes WHERE schemaname IN ('public', 'drizzle')
      UNION ALL
      SELECT 'trigger|' || namespace.nspname || '|' || relation.relname || '|' ||
        trigger_name.tgname || '|' || pg_catalog.pg_get_triggerdef(trigger_name.oid, true)
      FROM pg_catalog.pg_trigger AS trigger_name
      JOIN pg_catalog.pg_class AS relation ON relation.oid = trigger_name.tgrelid
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname IN ('public', 'drizzle') AND NOT trigger_name.tgisinternal
      UNION ALL
      SELECT 'policy|' || namespace.nspname || '|' || relation.relname || '|' ||
        policy.polname || '|' || policy.polcmd::text || '|' || policy.polpermissive::text || '|' ||
        COALESCE((SELECT string_agg(
          CASE WHEN role_id = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(role_id) END,
          ',' ORDER BY CASE WHEN role_id = 0 THEN 'PUBLIC' ELSE pg_catalog.pg_get_userbyid(role_id) END
        ) FROM unnest(policy.polroles) AS policy_role(role_id)), '') || '|' ||
        COALESCE(pg_catalog.pg_get_expr(policy.polqual, policy.polrelid, true), '') || '|' ||
        COALESCE(pg_catalog.pg_get_expr(policy.polwithcheck, policy.polrelid, true), '')
      FROM pg_catalog.pg_policy AS policy
      JOIN pg_catalog.pg_class AS relation ON relation.oid = policy.polrelid
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname IN ('public', 'drizzle')
      UNION ALL
      SELECT 'function|' || namespace.nspname || '|' || procedure.proname || '|' ||
        pg_catalog.pg_get_function_identity_arguments(procedure.oid) || '|' ||
        pg_catalog.pg_get_function_result(procedure.oid) || '|' || language.lanname || '|' ||
        procedure.provolatile::text || '|' || procedure.prosecdef::text || '|' ||
        procedure.proisstrict::text || '|' || procedure.proparallel::text || '|' ||
        procedure.proleakproof::text || '|' || COALESCE(array_to_string(procedure.proconfig, ','), '') || '|' ||
        md5(replace(replace(procedure.prosrc, chr(13) || chr(10), chr(10)), chr(13), chr(10)))
      FROM pg_catalog.pg_proc AS procedure
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
      JOIN pg_catalog.pg_language AS language ON language.oid = procedure.prolang
      WHERE namespace.nspname IN ('public', 'drizzle')
      UNION ALL
      SELECT 'enum|' || namespace.nspname || '|' || type_name.typname || '|' ||
        enum_value.enumsortorder::text || '|' || enum_value.enumlabel
      FROM pg_catalog.pg_type AS type_name
      JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = type_name.typnamespace
      JOIN pg_catalog.pg_enum AS enum_value ON enum_value.enumtypid = type_name.oid
      WHERE namespace.nspname IN ('public', 'drizzle')
      UNION ALL
      SELECT 'sequence|' || sequence_schema || '|' || sequence_name || '|' || data_type || '|' ||
        start_value || '|' || minimum_value || '|' || maximum_value || '|' || increment || '|' || cycle_option
      FROM information_schema.sequences WHERE sequence_schema IN ('public', 'drizzle')
    ) SELECT md5(COALESCE(string_agg(signature, E'\\n' ORDER BY signature), '')) AS signal
    FROM objects
  `);
  if (row === undefined || !/^[a-f0-9]{32}$/.test(row.signal)) {
    throw new Error("Portable full schema admission signal is invalid.");
  }
  return row.signal;
}

async function assertExactLedger(sql: Sql, migrationsFolder: string): Promise<void> {
  const manifest = await loadMigrationManifest(migrationsFolder);
  if ((await inspectMigrationLedger(sql, manifest)) !== "exact") {
    throw new Error("Portable source migration history is incompatible.");
  }
}

async function assertExactSchemaNamespaces(sql: Sql): Promise<void> {
  const [row] = await sql<{ schemas: string }[]>`
    select coalesce(string_agg(nspname, ',' order by nspname), '') as schemas
    from pg_catalog.pg_namespace
    where nspname !~ '^pg_' and nspname <> 'information_schema'
  `;
  if (row?.schemas !== "drizzle,public") {
    throw new Error("Portable database has an unexpected user-schema set.");
  }
}

interface PreparedSource {
  readonly expectations: PortablePayloadExpectations;
  readonly schemaSignal: string;
  readonly admissionSchemaSignal: string;
  readonly postgresVersion: string;
}

async function prepareSource(
  sourceDatabaseUrl: string,
  payloadPath: string,
  migrationsFolder: string,
): Promise<PreparedSource> {
  const connection = createDatabase(sourceDatabaseUrl, 1, {
    readOnly: true,
    statementTimeoutMs: 120_000,
    applicationName: "schedule-portable-export",
  });
  try {
    const [version] = await connection.sql<{ version: string }[]>`
      select current_setting('server_version') as version
    `;
    if (version === undefined || version.version.length < 1 || version.version.length > 160) {
      throw new Error("PostgreSQL version is invalid.");
    }
    const prepared = await connection.sql.begin(
      "isolation level repeatable read read only",
      async (transaction) => {
        await applyPortableCanonicalSessionSettings(transaction);
        await transaction.unsafe("LOCK TABLE drizzle.__drizzle_migrations IN SHARE MODE");
        const sourceTables = [
          ...portableDataPolicyV1.includedTables,
          ...portableDataPolicyV1.excludedTables.map(({ name }) => name),
        ].sort();
        await transaction.unsafe(
          `LOCK TABLE drizzle.__drizzle_migrations, ${sourceTables
            .map((table) => `public.${quoteIdentifier(table)}`)
            .join(", ")} IN ACCESS SHARE MODE`,
        );
        await assertExactLedger(transaction as unknown as Sql, migrationsFolder);
        await assertExactSchemaNamespaces(transaction as unknown as Sql);
        const catalog = await readPortableColumnCatalog(transaction);
        const sourceSchemaSignal = await schemaSignal(transaction);
        const admissionSchemaSignal = await fullSchemaSignal(transaction);
        const capturedSignals = await readSignals(transaction);
        const written = await writePortablePayload(payloadPath, {
          columns: catalog.columns,
          rows: (table, columns): AsyncIterable<readonly PortableTextValue[]> => ({
            async *[Symbol.asyncIterator]() {
              const expression = `pg_catalog.jsonb_build_array(${columns
                .map(({ name }) => `${quoteIdentifier(name)}::text`)
                .join(", ")})::text`;
              const query = transaction.unsafe<{ portable_row: string }[]>(`
                SELECT portable_row FROM (
                  SELECT ${expression} AS portable_row FROM public.${quoteIdentifier(table)}
                ) AS portable_rows ORDER BY portable_row
              `);
              for await (const batch of query.cursor(128)) {
                for (const row of batch) {
                  const parsed: unknown = JSON.parse(row.portable_row);
                  if (
                    !Array.isArray(parsed) ||
                    parsed.length !== columns.length ||
                    parsed.some((value) => value !== null && typeof value !== "string")
                  ) {
                    throw new Error(`Portable table ${table} produced an invalid typed-text row.`);
                  }
                  yield parsed as PortableTextValue[];
                }
              }
            },
          }),
          sequenceSignals: async () => capturedSignals.sequenceSignals,
        });
        const expectations = {
          columns: catalog.columns,
          contentSignals: capturedSignals.contentSignals,
          sequenceSignals: written.sequenceSignals,
        };
        await readPortablePayload(payloadPath, expectations);
        return { expectations, sourceSchemaSignal, admissionSchemaSignal };
      },
    );
    return {
      expectations: prepared.expectations,
      schemaSignal: prepared.sourceSchemaSignal,
      admissionSchemaSignal: prepared.admissionSchemaSignal,
      postgresVersion: version.version,
    };
  } finally {
    await connection.close();
  }
}

async function restorePayload(
  databaseUrl: string,
  payloadPath: string,
  expected: PortablePayloadExpectations,
): Promise<void> {
  const connection = createDatabase(databaseUrl, 1, {
    statementTimeoutMs: 120_000,
    applicationName: "schedule-portable-verification-restore",
  });
  try {
    const catalog = await readPortableColumnCatalog(connection.sql);
    await readPortablePayload(payloadPath, { ...expected, columns: catalog.columns });
    await connection.sql.begin(async (transaction) => {
      await transaction.unsafe("SET LOCAL search_path = pg_catalog, public");
      await transaction.unsafe("SET LOCAL session_replication_role = replica");
      let currentTable: PortableDataTableV1 | undefined;
      let batch: PortableTextValue[][] = [];
      let batchBytes = 0;
      const flush = async (): Promise<void> => {
        if (currentTable === undefined || batch.length === 0) return;
        const columns = catalog.columns[currentTable];
        const casts = catalog.casts[currentTable];
        const encoded = JSON.stringify(batch);
        await transaction.unsafe(
          `WITH portable_rows(value) AS (
            SELECT value FROM pg_catalog.jsonb_array_elements($1::pg_catalog.jsonb) AS item(value)
          ) INSERT INTO public.${quoteIdentifier(currentTable)}
            (${columns.map(({ name }) => quoteIdentifier(name)).join(", ")})
          SELECT ${casts.map((cast, index) => `(portable_row.value ->> ${index})::${cast}`).join(", ")}
          FROM portable_rows AS portable_row`,
          [encoded],
        );
        batch = [];
        batchBytes = 0;
      };
      await readPortablePayload(
        payloadPath,
        { ...expected, columns: catalog.columns },
        {
          beginTable: async (table) => {
            await flush();
            currentTable = table;
          },
          consumeRow: async (_table, values) => {
            const rowBytes = Buffer.byteLength(JSON.stringify(values), "utf8");
            if (
              batch.length >= 128 ||
              (batch.length > 0 && batchBytes + rowBytes > 4 * 1024 * 1024)
            ) {
              await flush();
            }
            batch.push([...values]);
            batchBytes += rowBytes;
            if (batchBytes > 4 * 1024 * 1024) await flush();
          },
          endTable: flush,
        },
      );
      await flush();
      for (const sequence of portableDataPolicyV1.sequences) {
        const match = /^(-?\d+):(true|false)$/.exec(expected.sequenceSignals[sequence] ?? "");
        if (match?.[1] === undefined || match[2] === undefined) {
          throw new Error(`Portable sequence ${sequence} signal is invalid.`);
        }
        await transaction.unsafe(
          `SELECT pg_catalog.setval('public.${sequence}'::pg_catalog.regclass,
            $1::pg_catalog.int8, $2::pg_catalog.bool)`,
          [match[1], match[2] === "true"],
        );
      }
      await transaction.unsafe("SET LOCAL session_replication_role = origin");
    });
  } finally {
    await connection.close();
  }
}

function foreignKeyAuditSql(): string {
  return `DO $portable_fk_audit$
    DECLARE constraint_row record; join_predicate text; nonnull_predicate text; has_orphan boolean;
    BEGIN
      FOR constraint_row IN SELECT definition.oid, definition.conname, definition.conrelid,
        definition.confrelid, definition.conkey, definition.confkey
        FROM pg_catalog.pg_constraint AS definition
        JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = definition.connamespace
        WHERE definition.contype = 'f' AND namespace.nspname = 'public'
      LOOP
        SELECT string_agg(format('child.%I = parent.%I', child.attname, parent.attname),
          ' AND ' ORDER BY key_position.ordinality),
          string_agg(format('child.%I IS NOT NULL', child.attname),
          ' AND ' ORDER BY key_position.ordinality)
        INTO join_predicate, nonnull_predicate
        FROM unnest(constraint_row.conkey, constraint_row.confkey) WITH ORDINALITY
          AS key_position(child_number, parent_number, ordinality)
        JOIN pg_catalog.pg_attribute AS child ON child.attrelid = constraint_row.conrelid
          AND child.attnum = key_position.child_number
        JOIN pg_catalog.pg_attribute AS parent ON parent.attrelid = constraint_row.confrelid
          AND parent.attnum = key_position.parent_number;
        EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s AS child LEFT JOIN %s AS parent ON %s
          WHERE %s AND parent.ctid IS NULL)', constraint_row.conrelid::regclass,
          constraint_row.confrelid::regclass, join_predicate, nonnull_predicate) INTO has_orphan;
        IF has_orphan THEN RAISE EXCEPTION 'Portable import violates foreign key %', constraint_row.conname; END IF;
      END LOOP;
    END $portable_fk_audit$`;
}

async function normalizeAndVerify(sql: Sql): Promise<void> {
  await sql.begin(async (transaction) => {
    await transaction.unsafe("SET LOCAL session_replication_role = replica");
    await transaction.unsafe(
      "UPDATE public.work_items SET hosted_sync_cursor = 0 WHERE hosted_sync_cursor <> 0",
    );
    await transaction.unsafe(
      "UPDATE public.audit_events SET actor_id = NULL WHERE actor_id IS NOT NULL",
    );
    await transaction.unsafe(`UPDATE public.natural_language_proposals SET status = 'cancelled',
      cancelled_at = expires_at, updated_at = GREATEST(updated_at, expires_at), version = version + 1
      WHERE status = 'pending'`);
    await transaction.unsafe(`UPDATE public.webhook_endpoints SET status = 'revoked',
      revoked_at = updated_at WHERE status = 'active'`);
    await transaction.unsafe(`INSERT INTO public.hosted_work_item_sync_states
      (workspace_id, head_cursor, minimum_cursor, updated_at)
      SELECT id, 0, 0, clock_timestamp() FROM public.workspaces ON CONFLICT (workspace_id) DO NOTHING`);
    await transaction.unsafe("SET LOCAL session_replication_role = origin");
    await transaction.unsafe(foreignKeyAuditSql());
  });
  const ordinarilyEmpty = portableDataPolicyV1.excludedTables
    .map(({ name }) => name)
    .filter(
      (table) =>
        table !== "hosted_work_item_sync_capability" && table !== "hosted_work_item_sync_states",
    );
  const assertions = [
    ...ordinarilyEmpty.map(
      (table) =>
        `SELECT '${table}' AS failed_check WHERE EXISTS (SELECT 1 FROM public.${quoteIdentifier(table)})`,
    ),
    `SELECT 'hosted_work_item_sync_capability' WHERE NOT EXISTS (
      SELECT 1 FROM public.hosted_work_item_sync_capability HAVING count(*) = 1
      AND bool_and(singleton AND NOT capture_enabled AND enabled_at IS NULL))`,
    `SELECT 'hosted_work_item_sync_states' WHERE
      (SELECT count(*) FROM public.hosted_work_item_sync_states) <> (SELECT count(*) FROM public.workspaces)
      OR EXISTS (SELECT 1 FROM public.hosted_work_item_sync_states WHERE head_cursor <> 0 OR minimum_cursor <> 0)`,
    `SELECT 'work_items.hosted_sync_cursor' WHERE EXISTS (SELECT 1 FROM public.work_items WHERE hosted_sync_cursor <> 0)`,
    `SELECT 'audit_events.actor_id' WHERE EXISTS (SELECT 1 FROM public.audit_events WHERE actor_id IS NOT NULL)`,
    `SELECT 'natural_language_proposals.pending' WHERE EXISTS (SELECT 1 FROM public.natural_language_proposals WHERE status = 'pending')`,
    `SELECT 'webhook_endpoints.active' WHERE EXISTS (SELECT 1 FROM public.webhook_endpoints WHERE status = 'active')`,
  ];
  const failures = await sql.unsafe<{ failed_check: string }[]>(assertions.join("\nUNION ALL\n"));
  if (failures.length > 0) throw new Error("Portable database normalization failed.");
}

function assertSignalsMatch(
  actual: PortableDatabaseSignals,
  expected: PortablePayloadExpectations,
): void {
  const contentMatches = portableDataPolicyV1.includedTables.every(
    (table) => actual.contentSignals[table] === expected.contentSignals[table],
  );
  const sequencesMatch = portableDataPolicyV1.sequences.every(
    (sequence) => actual.sequenceSignals[sequence] === expected.sequenceSignals[sequence],
  );
  if (!contentMatches || !sequencesMatch) {
    throw new Error(
      "Portable verification content does not match its repeatable-read source payload.",
    );
  }
}

interface VerificationResult {
  readonly signals: PortableDatabaseSignals;
  readonly created: boolean;
}

export async function exportVerifiedPortableDatabase(
  options: VerifiedPortableDatabaseExportOptions,
): Promise<PortableExportArtifact<PortableArchiveManifestV1>> {
  const applicationVersion = options.applicationVersion;
  if (applicationVersion.length < 1 || applicationVersion.length > 80) {
    throw new Error("Schedule application version is invalid.");
  }
  const migration = await readPortableMigrationIdentity(options.migrationsFolder);
  const verificationDatabase =
    options.verificationDatabaseName?.() ?? `schedule_verify_${randomUUID().replaceAll("-", "")}`;
  quoteIdentifier(verificationDatabase);
  const verificationUrl =
    options.verificationDatabaseUrl?.(verificationDatabase) ??
    databaseUrlFor(options.sourceDatabaseUrl, verificationDatabase);
  const temporaryRoot = tmpdir();
  await scavengePortableExportTemporaryDirectories(temporaryRoot);
  const temporaryDirectory = await mkdtemp(path.join(temporaryRoot, portableExportTemporaryPrefix));
  const ownerMarkerPath = path.join(temporaryDirectory, portableExportOwnerMarkerName);
  try {
    await writeFile(ownerMarkerPath, portableExportOwnerMarkerV1, { flag: "wx", mode: 0o600 });
  } catch (error) {
    try {
      await rmdir(temporaryDirectory);
    } catch {
      // Preserve the allocation if it changed before marker initialization completed.
    }
    throw error;
  }
  const temporaryDirectoryIdentity = await lstat(temporaryDirectory, { bigint: true });
  if (!temporaryDirectoryIdentity.isDirectory() || temporaryDirectoryIdentity.isSymbolicLink()) {
    throw new Error("Portable export temporary directory is not a private directory.");
  }
  const payloadPath = path.join(temporaryDirectory, portableExportPayloadName);
  let verificationCreated = false;

  return runPortableExport<PreparedSource, VerificationResult, PortableArchiveManifestV1>({
    prepareSource: async () => {
      const current = await lstat(temporaryDirectory, { bigint: true });
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        !sameIdentity(temporaryDirectoryIdentity, current)
      ) {
        throw new Error("Portable export temporary directory changed before use.");
      }
      return prepareSource(options.sourceDatabaseUrl, payloadPath, options.migrationsFolder);
    },
    createVerification: async (source) => {
      await options.createVerificationDatabase(verificationDatabase, verificationUrl, () => {
        verificationCreated = true;
      });
      await options.migrateVerificationDatabase(verificationDatabase, verificationUrl);
      const connection = createDatabase(verificationUrl, 1, {
        statementTimeoutMs: 120_000,
        applicationName: "schedule-portable-verification",
      });
      try {
        await assertExactLedger(connection.sql, options.migrationsFolder);
        await assertExactSchemaNamespaces(connection.sql);
        if ((await fullSchemaSignal(connection.sql)) !== source.admissionSchemaSignal) {
          throw new Error(
            "Portable source schema does not exactly match the packaged migration schema.",
          );
        }
        if ((await schemaSignal(connection.sql)) !== source.schemaSignal) {
          throw new Error("Portable verification schema does not match the source schema.");
        }
      } finally {
        await connection.close();
      }
      await restorePayload(verificationUrl, payloadPath, source.expectations);
      const verification = createDatabase(verificationUrl, 1, {
        statementTimeoutMs: 120_000,
        applicationName: "schedule-portable-verification-audit",
      });
      try {
        await normalizeAndVerify(verification.sql);
        await assertExactLedger(verification.sql, options.migrationsFolder);
        const signals = await verification.sql.begin(
          "isolation level repeatable read read only",
          async (transaction) => {
            await applyPortableCanonicalSessionSettings(transaction);
            return readSignals(transaction);
          },
        );
        assertSignalsMatch(signals, source.expectations);
        return { signals, created: true };
      } finally {
        await verification.close();
      }
    },
    writeArchive: (source, verification) =>
      writePortableArchive(options.outputPath, payloadPath, {
        producer: {
          applicationVersion,
          ...currentProducerPlatform(),
          postgresVersion: source.postgresVersion,
        },
        compatibility: {
          policyRevision: 1,
          schemaSignal: source.schemaSignal,
          migrationCount: migration.count,
          latestMigrationTag: migration.latestTag,
          migrationFingerprint: migration.fingerprint,
        },
        data: verification.signals,
      }),
    cleanupVerification: async () => {
      if (verificationCreated) {
        await options.dropVerificationDatabase(verificationDatabase);
        verificationCreated = false;
      }
    },
    cleanupSource: async () => undefined,
    cleanup: async () => {
      const errors: unknown[] = [];
      if (verificationCreated) {
        try {
          await options.dropVerificationDatabase(verificationDatabase);
          verificationCreated = false;
        } catch (error) {
          errors.push(error);
        }
      }
      try {
        const currentDirectory = await lstat(temporaryDirectory, { bigint: true });
        if (
          !currentDirectory.isDirectory() ||
          currentDirectory.isSymbolicLink() ||
          !sameIdentity(temporaryDirectoryIdentity, currentDirectory)
        ) {
          throw new Error("Portable export temporary directory changed before cleanup.");
        }
        const contents = await inspectPortableExportTemporaryDirectory(temporaryDirectory);
        if (contents === null) {
          throw new Error("Portable export temporary directory contains unexpected entries.");
        }
        if (contents === "with-payload") {
          const payload = await stableRegularFile(payloadPath);
          if (payload === null) {
            throw new Error("Portable export payload changed before cleanup.");
          }
          await unlink(payloadPath);
        }
        const marker = await readStableOwnerMarker(ownerMarkerPath);
        if (marker === null) {
          throw new Error("Portable export owner marker changed before cleanup.");
        }
        await unlink(ownerMarkerPath);
        const finalDirectory = await lstat(temporaryDirectory, { bigint: true });
        if (!sameIdentity(temporaryDirectoryIdentity, finalDirectory)) {
          throw new Error("Portable export temporary directory changed during cleanup.");
        }
        await rmdir(temporaryDirectory);
      } catch (error) {
        errors.push(error);
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) throw new AggregateError(errors, "Portable export cleanup failed.");
    },
    removeArchive: (archivePath) => rm(archivePath, { force: true }),
  });
}
