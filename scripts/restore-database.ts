import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  assertComposeDatabaseReady,
  composeDatabaseName,
  composeDatabaseService,
  composeDatabaseUser,
  expectedScheduleSequences,
  expectedScheduleTables,
  repositoryRoot,
  runComposeCommand,
  type ScheduleArchiveCatalog,
  verifyBackup,
  withPreparedRestoreArchive,
} from "./backup-database.js";

const restoreConfirmation = "replace-schedule";
const rollbackConfirmation = "rollback-to-retained";
const retainedDatabasePattern = /^schedule_(previous|rejected)_[a-f0-9]{32}$/;
const cleanupDatabasePattern =
  /^schedule_(previous|rejected|restore|schema|verify|outbox_verify|weekday_verify)_[a-f0-9]{32}$/;
const disposableNoncePattern = /^[a-f0-9]{32}$/;

export const disposableRecoveryVerificationSentinel =
  "schedule-disposable-recovery-state-machine-v1";

export type DisposableRecoveryRole = "active" | "staging" | "previous" | "rejected" | "reference";

export interface DisposableRecoveryPlan {
  readonly nonce: string;
  readonly activeDatabase: string;
  readonly stagingDatabase: string;
  readonly previousDatabase: string;
  readonly rejectedDatabase: string;
  readonly referenceDatabase: string;
}

interface RestoreRoleNames {
  readonly activeDatabase: string;
  readonly stagingDatabase: string;
  readonly previousDatabase: string;
  readonly referenceDatabase: string;
}

interface RollbackRoleNames {
  readonly activeDatabase: string;
  readonly previousDatabase: string;
  readonly rejectedDatabase: string;
  readonly referenceDatabase: string;
}

export interface RecoveryDatabaseOperations {
  readonly databaseExists: (databaseName: string) => Promise<boolean>;
  readonly databaseIdentity: (databaseName: string) => Promise<number | null>;
  readonly databaseAllowsConnections: (databaseName: string) => Promise<boolean>;
  readonly setDatabaseAllowsConnections: (
    databaseName: string,
    allowsConnections: boolean,
  ) => Promise<void>;
  readonly terminateDatabaseConnections: (databaseName: string) => Promise<void>;
  readonly renameDatabase: (sourceDatabase: string, targetDatabase: string) => Promise<void>;
  readonly dropDatabase: (databaseName: string) => Promise<void>;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatErrorTree(error: unknown, indent = ""): string {
  if (error instanceof AggregateError) {
    const nested = error.errors.map((item) => formatErrorTree(item, `${indent}  `)).join("\n");
    return `${indent}${error.message}${nested === "" ? "" : `\n${nested}`}`;
  }
  return `${indent}${errorMessage(error)}`;
}

export function quoteIdentifier(identifier: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(identifier)) {
    throw new Error(`Unsafe PostgreSQL database identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

export function assertRetainedDatabaseIdentifier(identifier: string): void {
  quoteIdentifier(identifier);
  if (!retainedDatabasePattern.test(identifier)) {
    throw new Error(
      `Refusing database operation for ${identifier}; expected a retained Schedule database identifier.`,
    );
  }
}

export function assertCleanupDatabaseIdentifier(identifier: string): void {
  quoteIdentifier(identifier);
  if (!cleanupDatabasePattern.test(identifier)) {
    throw new Error(
      `Refusing cleanup for ${identifier}; it is not an exact generated Schedule recovery identifier.`,
    );
  }
}

function createDatabaseIdentifier(prefix: string): string {
  return `${prefix}${randomUUID().replaceAll("-", "")}`;
}

function disposableDatabaseName(role: DisposableRecoveryRole, nonce: string): string {
  return `schedule_recovery_${role}_${nonce}`;
}

export function createDisposableRecoveryPlan(): DisposableRecoveryPlan {
  const nonce = randomBytes(16).toString("hex");
  return {
    nonce,
    activeDatabase: disposableDatabaseName("active", nonce),
    stagingDatabase: disposableDatabaseName("staging", nonce),
    previousDatabase: disposableDatabaseName("previous", nonce),
    rejectedDatabase: disposableDatabaseName("rejected", nonce),
    referenceDatabase: disposableDatabaseName("reference", nonce),
  };
}

function disposablePlanEntries(
  plan: DisposableRecoveryPlan,
): readonly (readonly [DisposableRecoveryRole, string])[] {
  return [
    ["active", plan.activeDatabase],
    ["staging", plan.stagingDatabase],
    ["previous", plan.previousDatabase],
    ["rejected", plan.rejectedDatabase],
    ["reference", plan.referenceDatabase],
  ];
}

export function assertDisposableRecoveryPlan(plan: DisposableRecoveryPlan): void {
  if (!disposableNoncePattern.test(plan.nonce)) {
    throw new Error("Disposable recovery nonce must be exactly 128 bits encoded as lowercase hex.");
  }

  const entries = disposablePlanEntries(plan);
  for (const [, databaseName] of entries) {
    quoteIdentifier(databaseName);
    if (databaseName === composeDatabaseName) {
      throw new Error("Disposable recovery plans may never target the bare schedule database.");
    }
  }

  const names = entries.map(([, databaseName]) => databaseName);
  if (new Set(names).size !== names.length) {
    throw new Error("Every disposable recovery role must have a distinct database identifier.");
  }

  for (const [role, databaseName] of entries) {
    const expected = disposableDatabaseName(role, plan.nonce);
    if (databaseName !== expected) {
      throw new Error(
        `Disposable recovery ${role} database is not exactly bound to the plan nonce.`,
      );
    }
  }
  if (names.includes(composeDatabaseName)) {
    throw new Error("Disposable recovery plans may never target the bare schedule database.");
  }
}

export function disposableRecoveryDatabaseName(
  plan: DisposableRecoveryPlan,
  role: DisposableRecoveryRole,
): string {
  assertDisposableRecoveryPlan(plan);
  return Object.fromEntries(disposablePlanEntries(plan))[role] as string;
}

export async function runPsql(databaseName: string, statement: string): Promise<string> {
  quoteIdentifier(databaseName);
  return runComposeCommand([
    "exec",
    "-T",
    composeDatabaseService,
    "psql",
    "--username",
    composeDatabaseUser,
    "--dbname",
    databaseName,
    "--no-psqlrc",
    "--set=ON_ERROR_STOP=1",
    "--tuples-only",
    "--no-align",
    "--command",
    statement,
  ]);
}

export async function databaseExists(databaseName: string): Promise<boolean> {
  quoteIdentifier(databaseName);
  const result = (
    await runPsql(
      "postgres",
      `SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = '${databaseName}')::text;`,
    )
  ).trim();
  return result === "true" || result === "t";
}

export async function databaseIdentity(databaseName: string): Promise<number | null> {
  quoteIdentifier(databaseName);
  const result = (
    await runPsql(
      "postgres",
      `SELECT COALESCE((SELECT oid::text FROM pg_database WHERE datname = '${databaseName}'), '');`,
    )
  ).trim();
  if (result === "") return null;
  if (!/^\d+$/.test(result)) {
    throw new Error(`Could not read database identity for ${databaseName}.`);
  }
  return Number(result);
}

export async function databaseAllowsConnections(databaseName: string): Promise<boolean> {
  quoteIdentifier(databaseName);
  const result = (
    await runPsql(
      "postgres",
      `SELECT datallowconn::text FROM pg_database WHERE datname = '${databaseName}';`,
    )
  ).trim();
  if (result === "") throw new Error(`Database does not exist: ${databaseName}`);
  return result === "true" || result === "t";
}

export async function createEmptyDatabase(databaseName: string): Promise<void> {
  const database = quoteIdentifier(databaseName);
  await runPsql(
    "postgres",
    `CREATE DATABASE ${database} OWNER ${quoteIdentifier(composeDatabaseUser)};`,
  );
}

export async function dropDatabase(databaseName: string): Promise<void> {
  await runPsql(
    "postgres",
    `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE);`,
  );
}

async function setDatabaseAllowsConnections(
  databaseName: string,
  allowsConnections: boolean,
): Promise<void> {
  await runPsql(
    "postgres",
    `ALTER DATABASE ${quoteIdentifier(databaseName)} WITH ALLOW_CONNECTIONS ${allowsConnections ? "true" : "false"};`,
  );
}

async function terminateDatabaseConnections(databaseName: string): Promise<void> {
  quoteIdentifier(databaseName);
  await runPsql(
    "postgres",
    `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${databaseName}' AND pid <> pg_backend_pid();`,
  );
}

async function renameDatabase(sourceDatabase: string, targetDatabase: string): Promise<void> {
  await runPsql(
    "postgres",
    `ALTER DATABASE ${quoteIdentifier(sourceDatabase)} RENAME TO ${quoteIdentifier(targetDatabase)};`,
  );
}

const postgresRecoveryOperations: RecoveryDatabaseOperations = {
  databaseExists,
  databaseIdentity,
  databaseAllowsConnections,
  setDatabaseAllowsConnections,
  terminateDatabaseConnections,
  renameDatabase,
  dropDatabase,
};

export async function restoreArchiveIntoDatabase(
  backupPath: string,
  databaseName: string,
): Promise<void> {
  quoteIdentifier(databaseName);
  await runComposeCommand(
    [
      "exec",
      "-T",
      composeDatabaseService,
      "pg_restore",
      "--username",
      composeDatabaseUser,
      "--dbname",
      databaseName,
      "--exit-on-error",
      "--single-transaction",
      "--no-owner",
      "--no-privileges",
    ],
    { inputPath: path.resolve(backupPath) },
  );
}

interface ExpectedMigration {
  readonly createdAt: number;
}

async function expectedMigrations(): Promise<readonly ExpectedMigration[]> {
  const migrationsFolder = path.join(repositoryRoot, "packages", "database", "drizzle");
  const journalPath = path.join(migrationsFolder, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
    entries?: { tag?: unknown; when?: unknown }[];
  };
  if (!Array.isArray(journal.entries) || journal.entries.length === 0) {
    throw new Error("Drizzle migration journal is missing or empty.");
  }

  const migrations: ExpectedMigration[] = [];
  for (const entry of journal.entries) {
    if (typeof entry.tag !== "string" || typeof entry.when !== "number") {
      throw new Error("Drizzle migration journal contains an invalid entry.");
    }
    await readFile(path.join(migrationsFolder, `${entry.tag}.sql`), "utf8");
    migrations.push({ createdAt: entry.when });
  }
  return migrations;
}

export async function assertScheduleDatabase(
  databaseName: string,
  options: {
    readonly requireCurrentMigrations?: boolean;
    readonly expectedCatalog?: ScheduleArchiveCatalog;
  } = {},
): Promise<void> {
  const schemaResult = (
    await runPsql(
      databaseName,
      "SELECT COALESCE(string_agg(nspname, ',' ORDER BY nspname), '') FROM pg_namespace WHERE nspname NOT LIKE 'pg\\_%' ESCAPE '\\' AND nspname <> 'information_schema';",
    )
  ).trim();
  if (schemaResult !== "drizzle,public") {
    throw new Error(
      `Database ${databaseName} has an unexpected user-schema set: ${schemaResult || "none"}.`,
    );
  }

  const tableResult = (
    await runPsql(
      databaseName,
      "SELECT COALESCE(string_agg(tablename, ',' ORDER BY tablename), '') FROM pg_tables WHERE schemaname = 'public';",
    )
  ).trim();
  const actualTables = tableResult === "" ? [] : tableResult.split(",");
  const expectedTables =
    options.requireCurrentMigrations === true
      ? [...expectedScheduleTables].sort()
      : options.expectedCatalog === undefined
        ? undefined
        : [...options.expectedCatalog.tables].sort();
  if (
    expectedTables !== undefined &&
    JSON.stringify(actualTables) !== JSON.stringify(expectedTables)
  ) {
    throw new Error(
      `Database ${databaseName} has an unexpected Schedule table set. Expected ${expectedTables.join(", ")}; received ${actualTables.join(", ") || "none"}.`,
    );
  }

  const sequenceResult = (
    await runPsql(
      databaseName,
      "SELECT COALESCE(string_agg(schemaname || '.' || sequencename, ',' ORDER BY schemaname, sequencename), '') FROM pg_sequences WHERE schemaname IN ('public', 'drizzle');",
    )
  ).trim();
  const actualSequences = sequenceResult === "" ? [] : sequenceResult.split(",");
  const expectedSequences =
    options.requireCurrentMigrations === true
      ? expectedScheduleSequences.map((sequence) => `${sequence.schema}.${sequence.name}`).sort()
      : options.expectedCatalog === undefined
        ? undefined
        : options.expectedCatalog.sequences
            .map((sequence) => `${sequence.schema}.${sequence.name}`)
            .sort();
  if (
    expectedSequences !== undefined &&
    JSON.stringify(actualSequences) !== JSON.stringify(expectedSequences)
  ) {
    throw new Error(
      `Database ${databaseName} has an unexpected Schedule sequence set. Expected ${expectedSequences.join(", ")}; received ${actualSequences.join(", ") || "none"}.`,
    );
  }

  const ledger = (
    await runPsql(
      databaseName,
      "SELECT COALESCE(to_regclass('drizzle.__drizzle_migrations')::text, '');",
    )
  ).trim();
  if (ledger !== "drizzle.__drizzle_migrations") {
    throw new Error(`Database ${databaseName} is missing the Drizzle migration ledger.`);
  }

  const ledgerRows = (
    await runPsql(
      databaseName,
      "SELECT created_at::text FROM drizzle.__drizzle_migrations ORDER BY created_at, id;",
    )
  )
    .trim()
    .split(/\r?\n/)
    .filter((row) => row !== "");
  const migrationCount = ledgerRows.length;
  if (!Number.isSafeInteger(migrationCount) || migrationCount < 1) {
    throw new Error(`Database ${databaseName} has an empty or invalid Drizzle migration ledger.`);
  }
  const currentMigrations = await expectedMigrations();
  const supportedLedgerPrefix = currentMigrations
    .slice(0, ledgerRows.length)
    .map((migration) => String(migration.createdAt));
  if (JSON.stringify(ledgerRows) !== JSON.stringify(supportedLedgerPrefix)) {
    throw new Error(
      `Database ${databaseName} migration ledger is not a supported ordered source-migration prefix.`,
    );
  }
  if (options.requireCurrentMigrations === true && ledgerRows.length !== currentMigrations.length) {
    throw new Error(
      `Database ${databaseName} has ${ledgerRows.length} migrations; current source requires ${currentMigrations.length}.`,
    );
  }
}

export async function databaseSchemaSignal(databaseName: string): Promise<string> {
  const result = await runPsql(
    databaseName,
    `
      WITH live_columns AS (
        SELECT columns.*,
          row_number() OVER (
            PARTITION BY table_schema, table_name ORDER BY ordinal_position
          ) AS live_ordinal_position
        FROM information_schema.columns AS columns
        WHERE table_schema IN ('public', 'drizzle')
      ), objects AS (
        SELECT
          'column|' || table_schema || '|' || table_name || '|' || live_ordinal_position::text || '|' ||
          column_name || '|' || data_type || '|' || udt_schema || '|' || udt_name || '|' ||
          is_nullable || '|' || COALESCE(column_default, '') AS signature
        FROM live_columns
        UNION ALL
        SELECT
          'constraint|' || namespace.nspname || '|' || relation.relname || '|' || constraint_name.conname ||
          '|' || pg_get_constraintdef(constraint_name.oid, true)
        FROM pg_constraint AS constraint_name
        JOIN pg_class AS relation ON relation.oid = constraint_name.conrelid
        JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname IN ('public', 'drizzle')
        UNION ALL
        SELECT 'index|' || schemaname || '|' || indexname || '|' || indexdef
        FROM pg_indexes
        WHERE schemaname IN ('public', 'drizzle')
        UNION ALL
        SELECT
          'trigger|' || namespace.nspname || '|' || relation.relname || '|' || trigger_name.tgname ||
          '|' || pg_get_triggerdef(trigger_name.oid, true)
        FROM pg_trigger AS trigger_name
        JOIN pg_class AS relation ON relation.oid = trigger_name.tgrelid
        JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname IN ('public', 'drizzle') AND NOT trigger_name.tgisinternal
        UNION ALL
        SELECT
          'function|' || namespace.nspname || '|' || procedure.proname || '|' ||
          pg_get_function_identity_arguments(procedure.oid) || '|' || pg_get_function_result(procedure.oid) ||
          '|' || language.lanname || '|' || procedure.provolatile::text || '|' ||
          procedure.prosecdef::text || '|' || procedure.proisstrict::text || '|' ||
          procedure.proparallel::text || '|' || procedure.proleakproof::text || '|' ||
          COALESCE(array_to_string(procedure.proconfig, ','), '') || '|' ||
          md5(replace(replace(procedure.prosrc, chr(13) || chr(10), chr(10)), chr(13), chr(10)))
        FROM pg_proc AS procedure
        JOIN pg_namespace AS namespace ON namespace.oid = procedure.pronamespace
        JOIN pg_language AS language ON language.oid = procedure.prolang
        WHERE namespace.nspname IN ('public', 'drizzle')
        UNION ALL
        SELECT
          'enum|' || namespace.nspname || '|' || type_name.typname || '|' || enum_value.enumsortorder::text ||
          '|' || enum_value.enumlabel
        FROM pg_type AS type_name
        JOIN pg_namespace AS namespace ON namespace.oid = type_name.typnamespace
        JOIN pg_enum AS enum_value ON enum_value.enumtypid = type_name.oid
        WHERE namespace.nspname IN ('public', 'drizzle')
        UNION ALL
        SELECT
          'sequence|' || sequence_schema || '|' || sequence_name || '|' || data_type || '|' ||
          start_value || '|' || minimum_value || '|' || maximum_value || '|' || increment || '|' || cycle_option
        FROM information_schema.sequences
        WHERE sequence_schema IN ('public', 'drizzle')
      )
      SELECT md5(COALESCE(string_agg(signature, E'\\n' ORDER BY signature), '')) FROM objects;
    `,
  );
  const signal = result.trim();
  if (!/^[a-f0-9]{32}$/.test(signal)) {
    throw new Error(`Could not calculate a deterministic schema signal for ${databaseName}.`);
  }
  return signal;
}

export async function databaseContentSignal(databaseName: string): Promise<string> {
  const relations: { schema: string; table: string }[] = expectedScheduleTables.map((table) => ({
    schema: "public",
    table,
  }));
  relations.push({ schema: "drizzle", table: "__drizzle_migrations" });
  const signals: string[] = [];

  for (const relation of relations) {
    const schema = quoteIdentifier(relation.schema);
    const table = quoteIdentifier(relation.table);
    const signal = (
      await runPsql(
        databaseName,
        `SELECT count(*)::text || ':' || md5(COALESCE(string_agg(to_jsonb("record")::text, E'\\n' ORDER BY to_jsonb("record")::text), '')) FROM ${schema}.${table} AS "record";`,
      )
    ).trim();
    if (!/^\d+:[a-f0-9]{32}$/.test(signal)) {
      throw new Error(
        `Could not calculate a deterministic content signal for ${relation.schema}.${relation.table}.`,
      );
    }
    signals.push(`${relation.schema}.${relation.table}=${signal}`);
  }

  for (const sequence of expectedScheduleSequences) {
    const schema = quoteIdentifier(sequence.schema);
    const name = quoteIdentifier(sequence.name);
    const signal = (
      await runPsql(
        databaseName,
        `SELECT last_value::text || ':' || is_called::text FROM ${schema}.${name};`,
      )
    ).trim();
    if (!/^\d+:(true|false|t|f)$/.test(signal)) {
      throw new Error(
        `Could not calculate a deterministic sequence signal for ${sequence.schema}.${sequence.name}.`,
      );
    }
    signals.push(`${sequence.schema}.${sequence.name}=${signal}`);
  }

  return signals.join("\n");
}

interface SequenceState {
  readonly schema: string;
  readonly name: string;
  readonly lastValue: string;
  readonly isCalled: boolean;
}

async function readSequenceStates(databaseName: string): Promise<readonly SequenceState[]> {
  const states: SequenceState[] = [];
  for (const sequence of expectedScheduleSequences) {
    const schema = quoteIdentifier(sequence.schema);
    const name = quoteIdentifier(sequence.name);
    const result = (
      await runPsql(
        databaseName,
        `SELECT last_value::text || ':' || is_called::text FROM ${schema}.${name};`,
      )
    ).trim();
    const match = /^(-?\d+):(true|false|t|f)$/.exec(result);
    if (match?.[1] === undefined || match[2] === undefined) {
      throw new Error(`Could not read sequence state for ${sequence.schema}.${sequence.name}.`);
    }
    states.push({
      schema: sequence.schema,
      name: sequence.name,
      lastValue: match[1],
      isCalled: match[2] === "true" || match[2] === "t",
    });
  }
  return states;
}

async function restoreSequenceStates(
  databaseName: string,
  states: readonly SequenceState[],
): Promise<void> {
  for (const state of states) {
    const qualifiedName = `${quoteIdentifier(state.schema)}.${quoteIdentifier(state.name)}`;
    await runPsql(
      databaseName,
      `SELECT setval('${qualifiedName}'::regclass, ${state.lastValue}, ${state.isCalled ? "true" : "false"});`,
    );
  }
}

function databaseUrl(databaseName: string): string {
  quoteIdentifier(databaseName);
  return `postgres://${composeDatabaseUser}:${composeDatabaseUser}@127.0.0.1:5432/${databaseName}`;
}

async function runRepositoryCommand(
  args: readonly string[],
  label: string,
  databaseName: string,
): Promise<void> {
  const targetDatabaseUrl = databaseUrl(databaseName);
  const executable =
    process.platform === "win32"
      ? (process.env.ComSpec ?? "C:\\Windows\\System32\\cmd.exe")
      : "pnpm";
  const commandArgs =
    process.platform === "win32" ? ["/d", "/s", "/c", "pnpm.cmd", ...args] : [...args];

  await new Promise<void>((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const child = spawn(executable, commandArgs, {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        DATABASE_URL: targetDatabaseUrl,
        NODE_ENV: "test",
        PRODUCT_API_MODE: "local_unauthenticated",
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const output = Buffer.concat([...stdout, ...stderr])
        .toString("utf8")
        .replaceAll(targetDatabaseUrl, "[DATABASE_URL]")
        .replaceAll(`${composeDatabaseUser}:${composeDatabaseUser}`, "[REDACTED]")
        .trim();
      reject(
        new Error(
          `${label} failed with exit code ${String(code)}${output === "" ? "" : `: ${output}`}`,
        ),
      );
    });
  });
}

async function collectRecoveryError(
  errors: Error[],
  label: string,
  action: () => Promise<void>,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    errors.push(new Error(`${label}: ${errorMessage(error)}`, { cause: error }));
  }
}

export async function cleanupOwnedRestoreStagingAfterFailure(
  originalError: unknown,
  stagingDatabase: string,
  stagingIdentity: number | null,
  operations: RecoveryDatabaseOperations = postgresRecoveryOperations,
): Promise<never> {
  if (stagingIdentity === null) throw originalError;
  const cleanupErrors: Error[] = [];
  await collectRecoveryError(
    cleanupErrors,
    `remove failed staging database ${stagingDatabase}`,
    async () => {
      await cleanupDatabaseInternal(stagingDatabase, operations, false, stagingIdentity);
    },
  );
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      [originalError, ...cleanupErrors],
      `Restore validation failed and staging cleanup was incomplete. Retained staging identifier: ${stagingDatabase}.`,
      { cause: originalError },
    );
  }
  throw originalError;
}

export type DisposablePreflightPhase = "initialize" | "restore" | "rollback";

function expectedDisposableExistence(
  phase: DisposablePreflightPhase,
): Readonly<Record<DisposableRecoveryRole, boolean>> {
  return {
    active: phase !== "initialize",
    staging: false,
    previous: phase === "rollback",
    rejected: false,
    reference: false,
  };
}

export async function assertDisposableRecoveryPreflight(
  plan: DisposableRecoveryPlan,
  phase: DisposablePreflightPhase,
  operations: Pick<RecoveryDatabaseOperations, "databaseExists"> = postgresRecoveryOperations,
): Promise<void> {
  assertDisposableRecoveryPlan(plan);
  const expected = expectedDisposableExistence(phase);
  const collisions: string[] = [];
  for (const [role, databaseName] of disposablePlanEntries(plan)) {
    const exists = await operations.databaseExists(databaseName);
    if (exists !== expected[role]) {
      collisions.push(`${role}=${databaseName} expected ${expected[role] ? "present" : "absent"}`);
    }
  }
  if (collisions.length > 0) {
    throw new Error(
      `Disposable recovery ${phase} preflight refused before mutation: ${collisions.join("; ")}.`,
    );
  }
}

async function assertRoleExistence(
  expectations: readonly (readonly [string, boolean])[],
  operations: Pick<RecoveryDatabaseOperations, "databaseExists">,
  label: string,
): Promise<void> {
  const mismatches: string[] = [];
  for (const [databaseName, shouldExist] of expectations) {
    quoteIdentifier(databaseName);
    if ((await operations.databaseExists(databaseName)) !== shouldExist) {
      mismatches.push(`${databaseName} expected ${shouldExist ? "present" : "absent"}`);
    }
  }
  if (mismatches.length > 0) {
    throw new Error(`${label} refused before mutation: ${mismatches.join("; ")}.`);
  }
}

async function currentSchemaSignalFromFreshDatabase(referenceDatabase: string): Promise<string> {
  quoteIdentifier(referenceDatabase);
  await assertRoleExistence(
    [[referenceDatabase, false]],
    postgresRecoveryOperations,
    "Reference schema creation",
  );
  await createEmptyDatabase(referenceDatabase);
  let signal: string | undefined;
  let originalError: unknown;

  try {
    await runRepositoryCommand(["db:migrate"], "Reference schema migration", referenceDatabase);
    await assertScheduleDatabase(referenceDatabase, { requireCurrentMigrations: true });
    signal = await databaseSchemaSignal(referenceDatabase);
  } catch (error) {
    originalError = error;
  }

  const cleanupErrors: Error[] = [];
  await collectRecoveryError(
    cleanupErrors,
    `remove reference schema database ${referenceDatabase}`,
    async () => {
      await cleanupDatabaseInternal(referenceDatabase, postgresRecoveryOperations, false);
    },
  );
  if (originalError !== undefined) {
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [originalError, ...cleanupErrors],
        `Reference schema validation failed and cleanup was incomplete. Retained identifier: ${referenceDatabase}.`,
        { cause: originalError },
      );
    }
    throw originalError;
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      cleanupErrors,
      `Reference schema cleanup failed. Retained identifier: ${referenceDatabase}.`,
    );
  }
  if (signal === undefined) throw new Error("Reference schema validation produced no signal.");
  return signal;
}

async function migrateAndVerifyStagingDatabase(
  databaseName: string,
  expectedSchemaSignal: string,
): Promise<void> {
  await runRepositoryCommand(["db:migrate"], "Staging migration", databaseName);
  await assertScheduleDatabase(databaseName, { requireCurrentMigrations: true });
  const stagingSchemaSignal = await databaseSchemaSignal(databaseName);
  if (stagingSchemaSignal !== expectedSchemaSignal) {
    throw new Error("Staging schema does not match a freshly migrated current Schedule database.");
  }
  const beforeVerification = await databaseContentSignal(databaseName);
  const sequenceStates = await readSequenceStates(databaseName);
  await runRepositoryCommand(["verify:database"], "Staging database verification", databaseName);
  await restoreSequenceStates(databaseName, sequenceStates);
  await assertScheduleDatabase(databaseName, { requireCurrentMigrations: true });
  const afterVerification = await databaseContentSignal(databaseName);
  if (afterVerification !== beforeVerification) {
    throw new Error("Database verifiers left persistent application-table changes in staging.");
  }
}

function recoveryInstructions(
  activeDatabase: string,
  previousDatabase: string,
  candidateDatabase: string,
): string {
  return [
    `Recovery identifiers: active=${activeDatabase}, previous=${previousDatabase}, candidate=${candidateDatabase}.`,
    "Do not drop any of these databases until their state is inspected.",
    `Inspect with: docker compose exec -T ${composeDatabaseService} psql -U ${composeDatabaseUser} -d postgres -c "SELECT datname, datallowconn FROM pg_database WHERE datname IN ('${activeDatabase}', '${previousDatabase}', '${candidateDatabase}') ORDER BY datname;"`,
    `If ${activeDatabase} is missing and ${previousDatabase} exists, run: docker compose exec -T ${composeDatabaseService} psql -U ${composeDatabaseUser} -d postgres -v ON_ERROR_STOP=1 -c "ALTER DATABASE ${quoteIdentifier(previousDatabase)} RENAME TO ${quoteIdentifier(activeDatabase)};"`,
    `Then enable the recovered database: docker compose exec -T ${composeDatabaseService} psql -U ${composeDatabaseUser} -d postgres -v ON_ERROR_STOP=1 -c "ALTER DATABASE ${quoteIdentifier(activeDatabase)} WITH ALLOW_CONNECTIONS true;"`,
  ].join("\n");
}

async function promoteStagingDatabase(
  names: Pick<RestoreRoleNames, "activeDatabase" | "stagingDatabase" | "previousDatabase">,
  operations: RecoveryDatabaseOperations,
  onMutationStart: () => void = () => undefined,
): Promise<void> {
  const { activeDatabase, stagingDatabase, previousDatabase } = names;
  await assertRoleExistence(
    [
      [activeDatabase, true],
      [stagingDatabase, true],
      [previousDatabase, false],
    ],
    operations,
    "Database promotion",
  );
  onMutationStart();

  let activeRenamed = false;
  let stagingPromoted = false;
  try {
    await operations.setDatabaseAllowsConnections(activeDatabase, false);
    await operations.terminateDatabaseConnections(activeDatabase);
    await operations.renameDatabase(activeDatabase, previousDatabase);
    activeRenamed = true;
    await operations.renameDatabase(stagingDatabase, activeDatabase);
    stagingPromoted = true;
    await operations.setDatabaseAllowsConnections(activeDatabase, true);
  } catch (originalError) {
    const recoveryErrors: Error[] = [];
    if (stagingPromoted) {
      await collectRecoveryError(
        recoveryErrors,
        "disable promoted database connections",
        async () => {
          await operations.setDatabaseAllowsConnections(activeDatabase, false);
        },
      );
      await collectRecoveryError(recoveryErrors, "close promoted database sessions", async () => {
        await operations.terminateDatabaseConnections(activeDatabase);
      });
      let promotedDemoted = false;
      try {
        await operations.renameDatabase(activeDatabase, stagingDatabase);
        promotedDemoted = true;
      } catch (error) {
        recoveryErrors.push(
          new Error(`restore staging database name: ${errorMessage(error)}`, { cause: error }),
        );
      }
      if (promotedDemoted) {
        await collectRecoveryError(recoveryErrors, "restore previous database name", async () => {
          await operations.renameDatabase(previousDatabase, activeDatabase);
        });
      } else {
        recoveryErrors.push(
          new Error(
            `restore previous database name skipped because ${activeDatabase} could not be vacated safely.`,
          ),
        );
      }
    } else if (activeRenamed) {
      await collectRecoveryError(recoveryErrors, "restore previous database name", async () => {
        await operations.renameDatabase(previousDatabase, activeDatabase);
      });
    }
    await collectRecoveryError(
      recoveryErrors,
      "re-enable active database connections",
      async () => {
        await operations.setDatabaseAllowsConnections(activeDatabase, true);
      },
    );
    throw new AggregateError(
      [originalError, ...recoveryErrors],
      `Database promotion failed. ${recoveryInstructions(activeDatabase, previousDatabase, stagingDatabase)}`,
      { cause: originalError },
    );
  }
}

export async function promoteDisposableRecoveryStaging(
  plan: DisposableRecoveryPlan,
  operations: RecoveryDatabaseOperations = postgresRecoveryOperations,
): Promise<void> {
  assertDisposableRecoveryPlan(plan);
  await assertRoleExistence(
    [
      [plan.activeDatabase, true],
      [plan.stagingDatabase, true],
      [plan.previousDatabase, false],
      [plan.rejectedDatabase, false],
      [plan.referenceDatabase, false],
    ],
    operations,
    "Disposable database promotion",
  );
  await promoteStagingDatabase(plan, operations);
}

async function restoreDatabaseUsingRoles(
  backupPath: string,
  names: RestoreRoleNames,
): Promise<void> {
  const resolvedPath = path.resolve(backupPath);
  const databaseNames = [
    names.activeDatabase,
    names.stagingDatabase,
    names.previousDatabase,
    names.referenceDatabase,
  ];
  for (const databaseName of databaseNames) quoteIdentifier(databaseName);
  if (new Set(databaseNames).size !== databaseNames.length) {
    throw new Error("Recovery database roles must use distinct identifiers.");
  }
  await assertRoleExistence(
    [
      [names.activeDatabase, true],
      [names.stagingDatabase, false],
      [names.previousDatabase, false],
      [names.referenceDatabase, false],
    ],
    postgresRecoveryOperations,
    "Restore",
  );
  await assertScheduleDatabase(names.activeDatabase, { requireCurrentMigrations: true });
  await runRepositoryCommand(["build:packages"], "Pre-restore package build", names.activeDatabase);
  const expectedSchemaSignal = await currentSchemaSignalFromFreshDatabase(names.referenceDatabase);
  if ((await databaseSchemaSignal(names.activeDatabase)) !== expectedSchemaSignal) {
    throw new Error(
      `Active database ${names.activeDatabase} does not match a freshly migrated current schema; restore refused so rollback state remains trustworthy.`,
    );
  }
  let stagingIdentity: number | null = null;
  const discardFailedStaging = (originalError: unknown): Promise<never> =>
    cleanupOwnedRestoreStagingAfterFailure(originalError, names.stagingDatabase, stagingIdentity);
  const archiveCatalog = await withPreparedRestoreArchive(
    resolvedPath,
    async ({ snapshotPath }): Promise<ScheduleArchiveCatalog> => {
      const catalog = await verifyBackup(snapshotPath);
      await assertRoleExistence(
        [
          [names.stagingDatabase, false],
          [names.previousDatabase, false],
        ],
        postgresRecoveryOperations,
        "Staging creation",
      );
      await createEmptyDatabase(names.stagingDatabase);
      stagingIdentity = await postgresRecoveryOperations.databaseIdentity(names.stagingDatabase);
      if (stagingIdentity === null) {
        throw new Error(
          `Created staging database identity could not be confirmed; retained identifier: ${names.stagingDatabase}.`,
        );
      }
      await restoreArchiveIntoDatabase(snapshotPath, names.stagingDatabase);
      return catalog;
    },
  ).catch(discardFailedStaging);

  let promotionStarted = false;
  try {
    await assertScheduleDatabase(names.stagingDatabase, { expectedCatalog: archiveCatalog });
    await migrateAndVerifyStagingDatabase(names.stagingDatabase, expectedSchemaSignal);
    await assertScheduleDatabase(names.stagingDatabase, { requireCurrentMigrations: true });
    await promoteStagingDatabase(names, postgresRecoveryOperations, () => {
      promotionStarted = true;
    });
  } catch (originalError) {
    if (promotionStarted) throw originalError;
    await discardFailedStaging(originalError);
  }
}

export interface RestoreResult {
  readonly previousDatabase: string;
  readonly activeDatabase: typeof composeDatabaseName;
}

export async function restoreScheduleDatabase(backupPath: string): Promise<RestoreResult> {
  const names: RestoreRoleNames = {
    activeDatabase: composeDatabaseName,
    stagingDatabase: createDatabaseIdentifier("schedule_restore_"),
    previousDatabase: createDatabaseIdentifier("schedule_previous_"),
    referenceDatabase: createDatabaseIdentifier("schedule_schema_"),
  };
  await assertComposeDatabaseReady();
  await restoreDatabaseUsingRoles(backupPath, names);
  return { previousDatabase: names.previousDatabase, activeDatabase: composeDatabaseName };
}

export interface DisposableRestoreResult {
  readonly previousDatabase: string;
  readonly activeDatabase: string;
}

export async function restoreDisposableScheduleDatabase(
  backupPath: string,
  plan: DisposableRecoveryPlan,
): Promise<DisposableRestoreResult> {
  assertDisposableRecoveryPlan(plan);
  await assertComposeDatabaseReady("postgres");
  await assertDisposableRecoveryPreflight(plan, "restore");
  await restoreDatabaseUsingRoles(backupPath, plan);
  return { previousDatabase: plan.previousDatabase, activeDatabase: plan.activeDatabase };
}

async function validateRetainedRollbackDatabase(
  previousDatabase: string,
  referenceDatabase: string,
): Promise<void> {
  if (await databaseAllowsConnections(previousDatabase)) {
    throw new Error(
      `Rollback refused because retained database ${previousDatabase} unexpectedly allows connections.`,
    );
  }

  let validationError: unknown;
  await setDatabaseAllowsConnections(previousDatabase, true);
  try {
    await assertScheduleDatabase(previousDatabase, { requireCurrentMigrations: true });
    await runRepositoryCommand(["build:packages"], "Rollback package build", previousDatabase);
    const expectedSchemaSignal = await currentSchemaSignalFromFreshDatabase(referenceDatabase);
    if ((await databaseSchemaSignal(previousDatabase)) !== expectedSchemaSignal) {
      throw new Error(
        `Retained rollback database ${previousDatabase} does not match the current Schedule schema.`,
      );
    }
  } catch (error) {
    validationError = error;
  }

  const recoveryErrors: Error[] = [];
  await collectRecoveryError(recoveryErrors, "disable retained database connections", async () => {
    await setDatabaseAllowsConnections(previousDatabase, false);
  });
  await collectRecoveryError(
    recoveryErrors,
    "close retained database validation sessions",
    async () => {
      await terminateDatabaseConnections(previousDatabase);
    },
  );

  if (validationError !== undefined) {
    throw new AggregateError(
      [validationError, ...recoveryErrors],
      `Retained rollback database validation failed. Identifier preserved: ${previousDatabase}.`,
      { cause: validationError },
    );
  }
  if (recoveryErrors.length > 0) {
    throw new AggregateError(
      recoveryErrors,
      `Retained database validation succeeded but connection lockdown failed. Identifier: ${previousDatabase}.`,
    );
  }
}

async function rollbackDatabaseNames(
  names: Pick<RollbackRoleNames, "activeDatabase" | "previousDatabase" | "rejectedDatabase">,
  operations: RecoveryDatabaseOperations,
): Promise<void> {
  const { activeDatabase, previousDatabase, rejectedDatabase } = names;
  await assertRoleExistence(
    [
      [activeDatabase, true],
      [previousDatabase, true],
      [rejectedDatabase, false],
    ],
    operations,
    "Database rollback",
  );

  let activeRenamed = false;
  let previousPromoted = false;
  try {
    await operations.setDatabaseAllowsConnections(previousDatabase, false);
    await operations.terminateDatabaseConnections(previousDatabase);
    await operations.setDatabaseAllowsConnections(activeDatabase, false);
    await operations.terminateDatabaseConnections(activeDatabase);
    await operations.renameDatabase(activeDatabase, rejectedDatabase);
    activeRenamed = true;
    await operations.renameDatabase(previousDatabase, activeDatabase);
    previousPromoted = true;
    await operations.setDatabaseAllowsConnections(activeDatabase, true);
  } catch (originalError) {
    const recoveryErrors: Error[] = [];
    if (previousPromoted) {
      await collectRecoveryError(recoveryErrors, "disable promoted rollback database", async () => {
        await operations.setDatabaseAllowsConnections(activeDatabase, false);
      });
      await collectRecoveryError(recoveryErrors, "close promoted rollback sessions", async () => {
        await operations.terminateDatabaseConnections(activeDatabase);
      });
      let previousNameRestored = false;
      try {
        await operations.renameDatabase(activeDatabase, previousDatabase);
        previousNameRestored = true;
      } catch (error) {
        recoveryErrors.push(
          new Error(`restore retained database name: ${errorMessage(error)}`, { cause: error }),
        );
      }
      if (previousNameRestored) {
        await collectRecoveryError(recoveryErrors, "restore rejected database name", async () => {
          await operations.renameDatabase(rejectedDatabase, activeDatabase);
        });
      } else {
        recoveryErrors.push(
          new Error(
            `restore rejected database name skipped because ${activeDatabase} could not be vacated safely.`,
          ),
        );
      }
    } else if (activeRenamed) {
      await collectRecoveryError(recoveryErrors, "restore rejected database name", async () => {
        await operations.renameDatabase(rejectedDatabase, activeDatabase);
      });
    }
    await collectRecoveryError(
      recoveryErrors,
      "re-enable active database connections",
      async () => {
        await operations.setDatabaseAllowsConnections(activeDatabase, true);
      },
    );
    throw new AggregateError(
      [originalError, ...recoveryErrors],
      [
        "Rollback failed; automatic compensation steps were attempted conservatively.",
        recoveryInstructions(activeDatabase, previousDatabase, rejectedDatabase),
      ].join("\n"),
      { cause: originalError },
    );
  }
}

export async function rollbackDisposableRecoveryNames(
  plan: DisposableRecoveryPlan,
  operations: RecoveryDatabaseOperations = postgresRecoveryOperations,
): Promise<void> {
  assertDisposableRecoveryPlan(plan);
  await assertDisposableRecoveryPreflight(plan, "rollback", operations);
  await rollbackDatabaseNames(plan, operations);
}

export interface RollbackResult {
  readonly activeDatabase: typeof composeDatabaseName;
  readonly rejectedDatabase: string;
}

export async function rollbackToRetainedDatabase(
  previousDatabase: string,
): Promise<RollbackResult> {
  assertRetainedDatabaseIdentifier(previousDatabase);
  if (!previousDatabase.startsWith("schedule_previous_")) {
    throw new Error("Rollback requires the schedule_previous_* identifier printed by db:restore.");
  }
  const names: RollbackRoleNames = {
    activeDatabase: composeDatabaseName,
    previousDatabase,
    rejectedDatabase: createDatabaseIdentifier("schedule_rejected_"),
    referenceDatabase: createDatabaseIdentifier("schedule_schema_"),
  };
  await assertComposeDatabaseReady("postgres");
  await assertRoleExistence(
    [
      [names.activeDatabase, true],
      [names.previousDatabase, true],
      [names.rejectedDatabase, false],
      [names.referenceDatabase, false],
    ],
    postgresRecoveryOperations,
    "Rollback",
  );
  await validateRetainedRollbackDatabase(names.previousDatabase, names.referenceDatabase);
  await rollbackDatabaseNames(names, postgresRecoveryOperations);
  return { activeDatabase: composeDatabaseName, rejectedDatabase: names.rejectedDatabase };
}

export interface DisposableRollbackResult {
  readonly activeDatabase: string;
  readonly rejectedDatabase: string;
}

export async function rollbackDisposableScheduleDatabase(
  plan: DisposableRecoveryPlan,
): Promise<DisposableRollbackResult> {
  assertDisposableRecoveryPlan(plan);
  await assertComposeDatabaseReady("postgres");
  await assertDisposableRecoveryPreflight(plan, "rollback");
  await validateRetainedRollbackDatabase(plan.previousDatabase, plan.referenceDatabase);
  await rollbackDatabaseNames(plan, postgresRecoveryOperations);
  return { activeDatabase: plan.activeDatabase, rejectedDatabase: plan.rejectedDatabase };
}

async function cleanupDatabaseInternal(
  databaseName: string,
  operations: RecoveryDatabaseOperations,
  requireExisting: boolean,
  expectedIdentity?: number,
): Promise<boolean> {
  quoteIdentifier(databaseName);
  const identity =
    expectedIdentity === undefined ? undefined : await operations.databaseIdentity(databaseName);
  if (
    (expectedIdentity === undefined && !(await operations.databaseExists(databaseName))) ||
    (expectedIdentity !== undefined && identity === null)
  ) {
    if (requireExisting) throw new Error(`Retained database does not exist: ${databaseName}`);
    return false;
  }
  if (expectedIdentity !== undefined && identity !== expectedIdentity) {
    throw new Error(
      `Database identity changed for ${databaseName}; refusing to remove an unowned replacement.`,
    );
  }
  // The random name and repeated OID checks prevent accidental or stale-name cleanup. They are not
  // a security boundary against another concurrent PostgreSQL administrator using the same role.
  const assertExpectedIdentity = async (phase: string): Promise<void> => {
    if (
      expectedIdentity !== undefined &&
      (await operations.databaseIdentity(databaseName)) !== expectedIdentity
    ) {
      throw new Error(
        `Database identity changed for ${databaseName} ${phase}; refusing to alter an unowned replacement.`,
      );
    }
  };
  if (await operations.databaseAllowsConnections(databaseName)) {
    await assertExpectedIdentity("before disabling connections");
    await operations.setDatabaseAllowsConnections(databaseName, false);
  }
  await assertExpectedIdentity("before terminating connections");
  await operations.terminateDatabaseConnections(databaseName);
  await assertExpectedIdentity("before removal");
  await operations.dropDatabase(databaseName);
  return true;
}

export async function cleanupGeneratedRecoveryDatabase(databaseName: string): Promise<void> {
  assertCleanupDatabaseIdentifier(databaseName);
  await assertComposeDatabaseReady("postgres");
  await cleanupDatabaseInternal(databaseName, postgresRecoveryOperations, true);
}

export async function cleanupDisposableRecoveryDatabase(
  plan: DisposableRecoveryPlan,
  role: DisposableRecoveryRole,
): Promise<void> {
  const databaseName = disposableRecoveryDatabaseName(plan, role);
  await assertComposeDatabaseReady("postgres");
  await cleanupDatabaseInternal(databaseName, postgresRecoveryOperations, true);
}

export async function initializeDisposableRecoveryActiveDatabase(
  plan: DisposableRecoveryPlan,
): Promise<void> {
  assertDisposableRecoveryPlan(plan);
  await assertComposeDatabaseReady("postgres");
  await assertDisposableRecoveryPreflight(plan, "initialize");
  await createEmptyDatabase(plan.activeDatabase);
  let originalError: unknown;
  try {
    await runRepositoryCommand(
      ["db:migrate"],
      "Disposable active database migration",
      plan.activeDatabase,
    );
    await assertScheduleDatabase(plan.activeDatabase, { requireCurrentMigrations: true });
  } catch (error) {
    originalError = error;
  }
  if (originalError === undefined) return;

  const cleanupErrors: Error[] = [];
  await collectRecoveryError(
    cleanupErrors,
    `remove failed disposable active database ${plan.activeDatabase}`,
    async () => {
      await cleanupDatabaseInternal(plan.activeDatabase, postgresRecoveryOperations, false);
    },
  );
  throw new AggregateError(
    [originalError, ...cleanupErrors],
    `Disposable active database initialization failed for nonce ${plan.nonce}.`,
    { cause: originalError },
  );
}

type Command =
  | { readonly kind: "restore"; readonly backupPath: string; readonly confirmed: boolean }
  | { readonly kind: "rollback"; readonly previousDatabase: string; readonly confirmed: boolean };

function parseArguments(args: readonly string[]): Command {
  const normalizedArgs = args.filter((arg) => arg !== "--");
  const rollback = normalizedArgs.includes("--rollback");
  const withoutMode = normalizedArgs.filter((arg) => arg !== "--rollback");
  const confirmation = withoutMode.find((arg) => arg.startsWith("--confirm="));
  const positional = withoutMode.filter((arg) => !arg.startsWith("--confirm="));
  if (positional.length !== 1 || positional[0] === undefined) {
    throw new Error(
      rollback
        ? `Usage: pnpm db:restore:rollback -- <schedule_previous_...> --confirm=${rollbackConfirmation}`
        : `Usage: pnpm db:restore -- <backup.dump> --confirm=${restoreConfirmation}`,
    );
  }
  return rollback
    ? {
        kind: "rollback",
        previousDatabase: positional[0],
        confirmed: confirmation === `--confirm=${rollbackConfirmation}`,
      }
    : {
        kind: "restore",
        backupPath: positional[0],
        confirmed: confirmation === `--confirm=${restoreConfirmation}`,
      };
}

async function main(): Promise<void> {
  try {
    const command = parseArguments(process.argv.slice(2));
    if (!command.confirmed) {
      throw new Error(
        command.kind === "rollback"
          ? `Rollback refused. Stop the app and pass --confirm=${rollbackConfirmation}.`
          : `Restore refused. Stop the app, verify the backup path, then pass --confirm=${restoreConfirmation}.`,
      );
    }

    if (command.kind === "rollback") {
      const result = await rollbackToRetainedDatabase(command.previousDatabase);
      console.log(`Rollback completed. Active database: ${result.activeDatabase}`);
      console.log(`Rejected restored database retained: ${result.rejectedDatabase}`);
      console.log(
        `After validation, remove it explicitly with: pnpm db:restore:cleanup -- ${result.rejectedDatabase} --confirm=drop-retained-database`,
      );
      return;
    }

    const result = await restoreScheduleDatabase(command.backupPath);
    console.log(`Database restored from verified archive: ${path.resolve(command.backupPath)}`);
    console.log(`Active database: ${result.activeDatabase}`);
    console.log(`Previous database retained with connections disabled: ${result.previousDatabase}`);
    console.log(
      `Accept and clean up with: pnpm db:restore:cleanup -- ${result.previousDatabase} --confirm=drop-retained-database`,
    );
    console.log(
      `Roll back with: pnpm db:restore:rollback -- ${result.previousDatabase} --confirm=${rollbackConfirmation}`,
    );
  } catch (error) {
    console.error(`Database restore operation failed:\n${formatErrorTree(error)}`);
    process.exitCode = 1;
  }
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(path.resolve(entryPoint)).href) {
  await main();
}
