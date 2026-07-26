import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  createDatabase,
  exportVerifiedPortableDatabase,
  importPortableScheduleData as importPortableScheduleDataCore,
  portableDataPolicyV1,
  readPortableMigrationIdentity,
  shouldRemovePortableExportResult,
  type PortableDataTableV1,
} from "../packages/database/src/index.js";
import { composeDatabaseName, createTimestamp, repositoryRoot } from "./backup-database.js";
import { assertPostgresVerifierReady, verifierDatabaseUrl } from "./postgres-verifier.js";
import {
  assertScheduleDatabase,
  cleanupGeneratedRecoveryDatabase,
  cleanupOwnedRestoreStagingAfterFailure,
  createEmptyDatabase,
  databaseIdentity,
  migrateScheduleDatabase,
  promoteScheduleStagingDatabase,
  quoteIdentifier,
  runPsql,
} from "./restore-database.js";
import { type PortableArchiveManifestV1 } from "./portable-archive.js";
import {
  type PortableColumnDescriptor,
  type PortableColumnMap,
  type PortablePayloadExpectations,
  type PortableTextValue,
  readPortablePayload,
} from "./portable-payload.js";

const replaceConfirmation = "replace-schedule";

interface MigrationIdentity {
  readonly count: number;
  readonly latestTag: string;
  readonly fingerprint: string;
}

interface PortableDatabaseSignals {
  readonly contentSignals: Readonly<Record<string, string>>;
  readonly sequenceSignals: Readonly<Record<string, string>>;
}

export interface PortableExportResult {
  readonly path: string;
  readonly sizeBytes: number;
  readonly manifest: PortableArchiveManifestV1;
}

export interface PortableImportResult {
  readonly activeDatabase: string;
  readonly previousDatabase: string;
  readonly archiveId: string;
}

export interface PortableImportOptions {
  readonly activeDatabase?: string;
  readonly stagingDatabase?: string;
  readonly previousDatabase?: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function generatedDatabaseName(
  prefix: "schedule_verify_" | "schedule_restore_" | "schedule_previous_",
): string {
  return `${prefix}${randomUUID().replaceAll("-", "")}`;
}

export function defaultPortableArchivePath(): string {
  const exportDirectory =
    process.env.SCHEDULE_EXPORT_DIR ?? path.join(homedir(), ".schedule", "exports");
  return path.join(exportDirectory, `schedule-portable-${createTimestamp()}.schedule`);
}

export async function readMigrationIdentity(): Promise<MigrationIdentity> {
  return readPortableMigrationIdentity(
    path.join(repositoryRoot, "packages", "database", "drizzle"),
  );
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

function databaseUrlFor(databaseName: string): string {
  quoteIdentifier(databaseName);
  return verifierDatabaseUrl(databaseName);
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

async function readPortableColumnCatalog(
  sql: ReturnType<typeof createDatabase>["sql"],
): Promise<PortableColumnCatalog> {
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
      ON attribute.attrelid = relation.oid
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
    JOIN pg_catalog.pg_type AS column_type ON column_type.oid = attribute.atttypid
    JOIN pg_catalog.pg_namespace AS type_namespace ON type_namespace.oid = column_type.typnamespace
    WHERE relation_namespace.nspname = 'public' AND relation.relkind IN ('r', 'p')
    ORDER BY relation.relname, attribute.attname;
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

async function readPortableCatalogForDatabase(
  databaseName: string,
): Promise<PortableColumnCatalog> {
  const connection = createDatabase(databaseUrlFor(databaseName), 1, {
    applicationName: "schedule-portable-catalog",
  });
  try {
    return await readPortableColumnCatalog(connection.sql);
  } finally {
    await connection.close();
  }
}

async function restorePortablePayloadIntoDatabase(
  payloadPath: string,
  databaseName: string,
  expected: PortablePayloadExpectations,
): Promise<void> {
  quoteIdentifier(databaseName);
  const connection = createDatabase(databaseUrlFor(databaseName), 1, {
    applicationName: "schedule-portable-import",
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
        const names = columns.map(({ name }) => quoteIdentifier(name)).join(", ");
        const values = casts
          .map((cast, index) => `(portable_row.value ->> ${index})::${cast}`)
          .join(", ");
        const encoded = JSON.stringify(batch);
        await transaction.unsafe(
          `
            WITH portable_rows(value) AS (
              SELECT value
              FROM pg_catalog.jsonb_array_elements($1::pg_catalog.jsonb) AS item(value)
            )
            INSERT INTO public.${quoteIdentifier(currentTable)} (${names})
            SELECT ${values} FROM portable_rows AS portable_row;
          `,
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
          endTable: async () => flush(),
        },
      );
      await flush();
      for (const sequence of portableDataPolicyV1.sequences) {
        const match = /^(-?\d+):(true|false)$/.exec(expected.sequenceSignals[sequence] ?? "");
        if (match?.[1] === undefined || match[2] === undefined) {
          throw new Error(`Portable sequence ${sequence} signal is invalid.`);
        }
        await transaction.unsafe(
          `SELECT pg_catalog.setval('public.${sequence}'::pg_catalog.regclass, $1::pg_catalog.int8, $2::pg_catalog.bool)`,
          [match[1], match[2] === "true"],
        );
      }
      await transaction.unsafe("SET LOCAL session_replication_role = origin");
    });
  } finally {
    await connection.close();
  }
}

function normalizedRowExpression(table: string): string {
  switch (table) {
    case "work_items":
      return `to_jsonb("record") || jsonb_build_object('hosted_sync_cursor', to_jsonb(0::bigint))`;
    case "audit_events":
      return `to_jsonb("record") || jsonb_build_object('actor_id', null)`;
    case "natural_language_proposals":
      return `CASE WHEN "record".status = 'pending' THEN
        to_jsonb("record") || jsonb_build_object(
          'status', 'cancelled',
          'cancelled_at', to_jsonb("record".expires_at),
          'updated_at', to_jsonb(GREATEST("record".updated_at, "record".expires_at)),
          'version', to_jsonb("record".version + 1)
        ) ELSE to_jsonb("record") END`;
    case "webhook_endpoints":
      return `CASE WHEN "record".status = 'active' THEN
        to_jsonb("record") || jsonb_build_object(
          'status', 'revoked',
          'revoked_at', to_jsonb("record".updated_at)
        ) ELSE to_jsonb("record") END`;
    default:
      return `to_jsonb("record")`;
  }
}

function parseSignalRows(
  output: string,
  keys: readonly string[],
  pattern: RegExp,
  label: string,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const row of output.trim().split(/\r?\n/).filter(Boolean)) {
    const separator = row.indexOf("=");
    const key = separator < 1 ? "" : row.slice(0, separator);
    const value = separator < 1 ? "" : row.slice(separator + 1);
    if (!keys.includes(key) || result[key] !== undefined || !pattern.test(value)) {
      throw new Error(`Could not parse ${label} row: ${row}`);
    }
    result[key] = value;
  }
  if (JSON.stringify(Object.keys(result).sort()) !== JSON.stringify([...keys].sort())) {
    throw new Error(`${label} result is incomplete.`);
  }
  return Object.fromEntries(keys.map((key) => [key, result[key] as string]));
}

function canonicalSignalTransaction(query: string): string {
  return `BEGIN;
    SET LOCAL TIME ZONE 'UTC';
    SET LOCAL DateStyle = 'ISO, YMD';
    SET LOCAL IntervalStyle = 'postgres';
    SET LOCAL bytea_output = 'hex';
    SET LOCAL extra_float_digits = 3;
    ${query};
    COMMIT;`;
}

export async function portableDatabaseSignals(
  databaseName: string,
): Promise<PortableDatabaseSignals> {
  quoteIdentifier(databaseName);
  const contentQuery = portableDataPolicyV1.includedTables
    .map((table) => {
      const relation = quoteIdentifier(table);
      const row = normalizedRowExpression(table);
      return `SELECT '${table}=' || count(*)::text || ':' || md5(COALESCE(string_agg(normalized::text, E'\\n' ORDER BY normalized::text), ''))
        FROM (SELECT ${row} AS normalized FROM public.${relation} AS "record") AS portable_rows`;
    })
    .join("\nUNION ALL\n");
  const contentSignals = parseSignalRows(
    await runPsql(databaseName, canonicalSignalTransaction(contentQuery), { quiet: true }),
    portableDataPolicyV1.includedTables,
    /^\d+:[0-9a-f]{32}$/,
    "portable content signal",
  );

  const sequenceQuery = portableDataPolicyV1.sequences
    .map((sequence) => {
      const relation = quoteIdentifier(sequence);
      return `SELECT '${sequence}=' || last_value::text || ':' || CASE WHEN is_called THEN 'true' ELSE 'false' END FROM public.${relation}`;
    })
    .join("\nUNION ALL\n");
  const sequenceSignals = parseSignalRows(
    await runPsql(databaseName, canonicalSignalTransaction(sequenceQuery), { quiet: true }),
    portableDataPolicyV1.sequences,
    /^-?\d+:(?:true|false)$/,
    "portable sequence signal",
  );
  return { contentSignals, sequenceSignals };
}

export async function portableSchemaSignatures(databaseName: string): Promise<readonly string[]> {
  quoteIdentifier(databaseName);
  const tableValues = portableDataPolicyV1.includedTables.map((table) => `('${table}')`).join(", ");
  const sequenceValues = portableDataPolicyV1.sequences
    .map((sequence) => `('${sequence}')`)
    .join(", ");
  const output = (
    await runPsql(
      databaseName,
      `
        WITH selected_tables(name) AS (VALUES ${tableValues}),
        selected_sequences(name) AS (VALUES ${sequenceValues}),
        selected_relations AS (
          SELECT relation.oid, relation.relname
          FROM pg_catalog.pg_class AS relation
          JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
          JOIN selected_tables ON selected_tables.name = relation.relname
          WHERE namespace.nspname = 'public' AND relation.relkind IN ('r', 'p')
        ),
        objects AS (
          SELECT
            'column|public|' || relation.relname || '|' || attribute.attname || '|' ||
            pg_catalog.format_type(attribute.atttypid, attribute.atttypmod) || '|' ||
            attribute.attnotnull::text || '|' || attribute.attidentity::text || '|' || attribute.attgenerated::text AS signature
          FROM selected_relations AS relation
          JOIN pg_catalog.pg_attribute AS attribute
            ON attribute.attrelid = relation.oid
            AND attribute.attnum > 0
            AND NOT attribute.attisdropped
          UNION ALL
          SELECT
            'enum|public|' || enum_type.typname || '|' || enum_value.enumsortorder::text || '|' || enum_value.enumlabel
          FROM selected_relations AS relation
          JOIN pg_catalog.pg_attribute AS attribute
            ON attribute.attrelid = relation.oid
            AND attribute.attnum > 0
            AND NOT attribute.attisdropped
          JOIN pg_catalog.pg_type AS enum_type ON enum_type.oid = attribute.atttypid
          JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = enum_type.typnamespace
          JOIN pg_catalog.pg_enum AS enum_value ON enum_value.enumtypid = enum_type.oid
          WHERE namespace.nspname = 'public'
          UNION ALL
          SELECT
            'sequence|public|' || sequence.sequencename || '|' || sequence.data_type || '|' ||
            sequence.start_value || '|' || sequence.min_value || '|' || sequence.max_value || '|' ||
            sequence.increment_by || '|' || sequence.cycle::text
          FROM pg_catalog.pg_sequences AS sequence
          JOIN selected_sequences ON selected_sequences.name = sequence.sequencename
          WHERE sequence.schemaname = 'public'
        )
        SELECT signature FROM objects ORDER BY signature;
      `,
    )
  ).trim();
  const signatures = output.split(/\r?\n/).filter(Boolean);
  if (signatures.length === 0) {
    throw new Error(`Could not calculate portable schema signatures for ${databaseName}.`);
  }
  return signatures;
}

export async function portableSchemaSignal(databaseName: string): Promise<string> {
  const signatures = await portableSchemaSignatures(databaseName);
  return createHash("sha256").update(signatures.join("\n"), "utf8").digest("hex");
}

function foreignKeyAuditSql(): string {
  return `
    DO $portable_fk_audit$
    DECLARE
      constraint_row record;
      join_predicate text;
      nonnull_predicate text;
      has_orphan boolean;
    BEGIN
      FOR constraint_row IN
        SELECT constraint_definition.oid, constraint_definition.conname,
          constraint_definition.conrelid, constraint_definition.confrelid,
          constraint_definition.conkey, constraint_definition.confkey
        FROM pg_catalog.pg_constraint AS constraint_definition
        JOIN pg_catalog.pg_namespace AS namespace
          ON namespace.oid = constraint_definition.connamespace
        WHERE constraint_definition.contype = 'f'
          AND namespace.nspname = 'public'
      LOOP
        SELECT
          string_agg(format('child.%I = parent.%I', child_attribute.attname, parent_attribute.attname), ' AND ' ORDER BY key_position.ordinality),
          string_agg(format('child.%I IS NOT NULL', child_attribute.attname), ' AND ' ORDER BY key_position.ordinality)
        INTO join_predicate, nonnull_predicate
        FROM unnest(constraint_row.conkey, constraint_row.confkey) WITH ORDINALITY
          AS key_position(child_number, parent_number, ordinality)
        JOIN pg_catalog.pg_attribute AS child_attribute
          ON child_attribute.attrelid = constraint_row.conrelid
          AND child_attribute.attnum = key_position.child_number
        JOIN pg_catalog.pg_attribute AS parent_attribute
          ON parent_attribute.attrelid = constraint_row.confrelid
          AND parent_attribute.attnum = key_position.parent_number;

        EXECUTE format(
          'SELECT EXISTS (SELECT 1 FROM %s AS child LEFT JOIN %s AS parent ON %s WHERE %s AND parent.ctid IS NULL)',
          constraint_row.conrelid::regclass,
          constraint_row.confrelid::regclass,
          join_predicate,
          nonnull_predicate
        ) INTO has_orphan;
        IF has_orphan THEN
          RAISE EXCEPTION 'Portable import violates foreign key %', constraint_row.conname;
        END IF;
      END LOOP;
    END
    $portable_fk_audit$;
  `;
}

export async function normalizeAndVerifyPortableDatabase(databaseName: string): Promise<void> {
  quoteIdentifier(databaseName);
  await runPsql(
    databaseName,
    `
      BEGIN;
      SET LOCAL session_replication_role = replica;
      UPDATE public.work_items SET hosted_sync_cursor = 0 WHERE hosted_sync_cursor <> 0;
      UPDATE public.audit_events SET actor_id = NULL WHERE actor_id IS NOT NULL;
      UPDATE public.natural_language_proposals
      SET status = 'cancelled',
        cancelled_at = expires_at,
        updated_at = GREATEST(updated_at, expires_at),
        version = version + 1
      WHERE status = 'pending';
      UPDATE public.webhook_endpoints
      SET status = 'revoked', revoked_at = updated_at
      WHERE status = 'active';
      INSERT INTO public.hosted_work_item_sync_states (workspace_id, head_cursor, minimum_cursor, updated_at)
      SELECT id, 0, 0, clock_timestamp() FROM public.workspaces
      ON CONFLICT (workspace_id) DO NOTHING;
      SET LOCAL session_replication_role = origin;
      ${foreignKeyAuditSql()}
      COMMIT;
    `,
  );

  const ordinarilyEmptyTables = portableDataPolicyV1.excludedTables
    .map(({ name }) => name)
    .filter(
      (table) =>
        table !== "hosted_work_item_sync_capability" && table !== "hosted_work_item_sync_states",
    );
  const assertions = [
    ...ordinarilyEmptyTables.map(
      (table) =>
        `SELECT '${table}' AS failed_check WHERE EXISTS (SELECT 1 FROM public.${quoteIdentifier(table)})`,
    ),
    `SELECT 'hosted_work_item_sync_capability' WHERE NOT EXISTS (
      SELECT 1 FROM public.hosted_work_item_sync_capability
      HAVING count(*) = 1 AND bool_and(singleton AND NOT capture_enabled AND enabled_at IS NULL)
    )`,
    `SELECT 'hosted_work_item_sync_states' WHERE
      (SELECT count(*) FROM public.hosted_work_item_sync_states) <> (SELECT count(*) FROM public.workspaces)
      OR EXISTS (SELECT 1 FROM public.hosted_work_item_sync_states WHERE head_cursor <> 0 OR minimum_cursor <> 0)`,
    `SELECT 'work_items.hosted_sync_cursor' WHERE EXISTS (SELECT 1 FROM public.work_items WHERE hosted_sync_cursor <> 0)`,
    `SELECT 'audit_events.actor_id' WHERE EXISTS (SELECT 1 FROM public.audit_events WHERE actor_id IS NOT NULL)`,
    `SELECT 'natural_language_proposals.pending' WHERE EXISTS (SELECT 1 FROM public.natural_language_proposals WHERE status = 'pending')`,
    `SELECT 'webhook_endpoints.active' WHERE EXISTS (SELECT 1 FROM public.webhook_endpoints WHERE status = 'active')`,
  ];
  const failures = (await runPsql(databaseName, assertions.join("\nUNION ALL\n")))
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  if (failures.length > 0) {
    throw new Error(`Portable database normalization failed: ${failures.join(", ")}`);
  }
  await assertScheduleDatabase(databaseName, { requireCurrentMigrations: true });
}

function assertSignalsMatch(
  actual: PortableDatabaseSignals,
  expected: Pick<PortableArchiveManifestV1["data"], "contentSignals" | "sequenceSignals">,
): void {
  const contentMatches = portableDataPolicyV1.includedTables.every(
    (table) => actual.contentSignals[table] === expected.contentSignals[table],
  );
  const sequencesMatch = portableDataPolicyV1.sequences.every(
    (sequence) => actual.sequenceSignals[sequence] === expected.sequenceSignals[sequence],
  );
  if (!contentMatches || !sequencesMatch) {
    throw new Error("Portable database content does not match the archive manifest after import.");
  }
}

async function currentApplicationVersion(): Promise<string> {
  const packageJson = JSON.parse(
    await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
  ) as {
    version?: unknown;
  };
  if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
    throw new Error("Schedule application version is missing.");
  }
  return packageJson.version;
}

async function prepareVerifiedPortableDatabase(
  payloadPath: string,
  databaseName: string,
  expectedSchemaSignal: string,
  expectedData: PortablePayloadExpectations,
  onCreated: (identity: number) => void = () => undefined,
): Promise<PortableDatabaseSignals> {
  await createEmptyDatabase(databaseName);
  const identity = await databaseIdentity(databaseName);
  if (identity === null) throw new Error("Portable staging database identity is missing.");
  onCreated(identity);
  await migrateScheduleDatabase(databaseName);
  if ((await portableSchemaSignal(databaseName)) !== expectedSchemaSignal) {
    throw new Error("Portable staging schema does not match the source Schedule schema.");
  }
  await restorePortablePayloadIntoDatabase(payloadPath, databaseName, expectedData);
  await normalizeAndVerifyPortableDatabase(databaseName);
  return portableDatabaseSignals(databaseName);
}

export async function exportPortableScheduleData(
  outputPath = defaultPortableArchivePath(),
  databaseName = composeDatabaseName,
): Promise<PortableExportResult> {
  quoteIdentifier(databaseName);
  await assertPostgresVerifierReady(databaseName);
  await assertScheduleDatabase(databaseName, { requireCurrentMigrations: true });
  return exportVerifiedPortableDatabase({
    outputPath,
    sourceDatabaseUrl: databaseUrlFor(databaseName),
    migrationsFolder: path.join(repositoryRoot, "packages", "database", "drizzle"),
    applicationVersion: await currentApplicationVersion(),
    createVerificationDatabase: async (verificationDatabase, _databaseUrl, onCreated) => {
      await createEmptyDatabase(verificationDatabase);
      onCreated();
    },
    migrateVerificationDatabase: async (verificationDatabase) => {
      await migrateScheduleDatabase(verificationDatabase);
    },
    dropVerificationDatabase: cleanupGeneratedRecoveryDatabase,
  });
}

export { shouldRemovePortableExportResult };

export async function importPortableScheduleData(
  archivePath: string,
  options: PortableImportOptions = {},
): Promise<PortableImportResult> {
  const activeDatabase = options.activeDatabase ?? composeDatabaseName;
  const stagingDatabase = options.stagingDatabase ?? generatedDatabaseName("schedule_restore_");
  const previousDatabase = options.previousDatabase ?? generatedDatabaseName("schedule_previous_");
  return importPortableScheduleDataCore(
    { archivePath, activeDatabase, stagingDatabase, previousDatabase },
    {
      assertDatabaseName: quoteIdentifier,
      assertActiveDatabase: async (databaseName) => {
        await assertPostgresVerifierReady(databaseName);
        await assertScheduleDatabase(databaseName, { requireCurrentMigrations: true });
      },
      schemaSignal: portableSchemaSignal,
      migrationIdentity: readMigrationIdentity,
      columnCatalog: async (databaseName) =>
        (await readPortableCatalogForDatabase(databaseName)).columns,
      prepareStagingDatabase: async (
        payloadPath,
        databaseName,
        schemaSignal,
        expectedData,
        onCreated,
      ) => {
        await prepareVerifiedPortableDatabase(
          payloadPath,
          databaseName,
          schemaSignal,
          expectedData,
          onCreated,
        );
      },
      signalsMatch: async (databaseName, expected) => {
        const signals = await portableDatabaseSignals(databaseName);
        try {
          assertSignalsMatch(signals, expected);
          return true;
        } catch {
          return false;
        }
      },
      promoteStagingDatabase: promoteScheduleStagingDatabase,
      databaseIdentity,
      cleanupStagingAfterFailure: cleanupOwnedRestoreStagingAfterFailure,
    },
  );
}

type Command =
  | { readonly kind: "export"; readonly outputPath?: string }
  | { readonly kind: "import"; readonly archivePath: string };

export function parsePortableCommand(args: readonly string[]): Command {
  const normalized = args.filter((arg) => arg !== "--");
  const [kind, ...options] = normalized;
  if (kind === "export") {
    if (options.length === 0) return { kind: "export" };
    if (options.length === 2 && options[0] === "--output" && options[1] !== undefined) {
      return { kind: "export", outputPath: options[1] };
    }
    const inline = options.length === 1 ? options[0] : undefined;
    if (inline?.startsWith("--output=") === true) {
      return { kind: "export", outputPath: inline.slice("--output=".length) };
    }
  }
  if (kind === "import") {
    const archivePath = options.find((option) => !option.startsWith("--"));
    const confirmed = options.includes(`--confirm=${replaceConfirmation}`);
    if (archivePath !== undefined && options.length === 2 && confirmed) {
      return { kind: "import", archivePath };
    }
  }
  throw new Error(
    "Usage: pnpm data:export [-- --output <path>] OR pnpm data:import -- <archive.schedule> --confirm=replace-schedule",
  );
}

async function main(): Promise<void> {
  try {
    const command = parsePortableCommand(process.argv.slice(2));
    if (command.kind === "export") {
      const result = await exportPortableScheduleData(command.outputPath);
      console.log(`Portable Schedule archive created and verified: ${result.path}`);
      console.log(`Archive size: ${result.sizeBytes.toLocaleString("en-US")} bytes`);
      console.log(
        "Credentials, sessions, delivery queues, and hosted sync journals were excluded.",
      );
      return;
    }
    const result = await importPortableScheduleData(command.archivePath);
    console.log(`Portable Schedule archive imported: ${result.archiveId}`);
    console.log(`Previous database retained for rollback: ${result.previousDatabase}`);
    console.log(
      "Reconnect integrations and provision new webhook secrets before enabling delivery.",
    );
  } catch (error) {
    console.error(`Portable Schedule migration failed: ${errorMessage(error)}`);
    process.exitCode = 1;
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  await main();
}
