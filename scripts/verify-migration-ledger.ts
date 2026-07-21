import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createDatabase, type DatabaseConnection } from "../packages/database/src/index.js";
import {
  loadMigrationManifest,
  type MigrationManifest,
} from "../packages/database/src/migration-ledger.js";
import { migrationSqlStatements } from "../packages/database/src/migration-sql.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrateEntryPoint = path.join(repositoryRoot, "packages/database/dist/migrate.js");
const migrationsFolder = path.join(repositoryRoot, "packages/database/drizzle");
const timeoutMs = 30_000;
const maximumChildOutputBytes = 4_096;
const maximumHistoricalMigrationBytes = 512 * 1024;
const disposableName = /^schedule_ledger_verify_[a-f0-9]{32}$/u;
const statusLine = "SCHEDULE_MIGRATION_STATUS_V1 exact\n";
const divergentStatusLine = "SCHEDULE_MIGRATION_STATUS_V1 divergent\n";
const migrationFailure = "Database migration compatibility check failed.\n";
const missingVaultKey = `dotenv://:key_${"a".repeat(64)}@dotenvx.com/vault/.env.vault?environment=test`;
const historicalRepairTag = "0042_reconcile_historical_schema";

type HistoricalMigrationSource = {
  readonly tag: string;
  readonly sha256: string;
  readonly commit: string;
};

const historicalMigrationSources: readonly HistoricalMigrationSource[] = [
  {
    tag: "0004_public_cerise",
    sha256: "6ab84e9bb63326595061b24584e8fe58f3cf23ba1e6d6786f3777a7347a646f6",
    commit: "937ee3e25cf7ace12665e021e2173f7dd8808efe",
  },
  {
    tag: "0024_fast_thundra",
    sha256: "26f049d219f3962d7298fd4acca87bc0b8ceeeb680bc7df1b65056eb572b38c5",
    commit: "06693fabd83f4ba8e3d92c7b9938722826d8f826",
  },
  {
    tag: "0031_daffy_bloodstrike",
    sha256: "34e68d0a3907c79ecbc3f97949c493800d688e84998657d440f155bfa089b8c1",
    commit: "7b6be91770dbcd71438a652276f249ccdb39cd6f",
  },
  {
    tag: "0032_harsh_purifiers",
    sha256: "4b9982a0deb4d00e68b7871ea4c84b2b28c6bdfcf257f8717ec0025c8de5e1e9",
    commit: "a4d55da7f0ac61499ea5d808cf92ff387b0a2786",
  },
  {
    tag: "0041_hosted_work_item_sync",
    sha256: "40064a598eab70d10c7a0090d29f2793417621d39029d7d7b799403d515abd9f",
    commit: "4025a81a8fb0f5e4184864af3e7c7a962954f792",
  },
  {
    tag: "0041_hosted_work_item_sync",
    sha256: "b4c65f84c69c294c5f481b1c36f7906af625016a9fd1300cad6cf7f0a9b885ca",
    commit: "0d2316a64b32199bf16488ab00b878a186eafd2a",
  },
];

export type CommandResult = {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
};

export function parseMigrationLedgerVerifierArguments(arguments_: readonly string[]): void {
  if (arguments_.length !== 0) {
    throw new Error("Usage: pnpm exec tsx scripts/verify-migration-ledger.ts");
  }
}

export function disposableDatabaseName(nonce: string): string {
  const name = `schedule_ledger_verify_${nonce}`;
  if (!disposableName.test(name)) throw new Error("Disposable database identifier is invalid.");
  return name;
}

export function databaseUrlFor(source: string, databaseName: string): string {
  let url: URL;
  try {
    url = new URL(source);
  } catch {
    throw new Error("DATABASE_URL must be a PostgreSQL URL.");
  }
  if ((url.protocol !== "postgres:" && url.protocol !== "postgresql:") || url.hostname === "") {
    throw new Error("DATABASE_URL must be a PostgreSQL URL.");
  }
  if (!disposableName.test(databaseName) && databaseName !== "postgres") {
    throw new Error("Disposable database identifier is invalid.");
  }
  url.pathname = `/${databaseName}`;
  return url.toString();
}

export function assertExactStatus(result: CommandResult, expected: string): void {
  assert.equal(result.code, 0, "migration status process failed");
  assert.equal(result.stderr, "", "migration status wrote stderr");
  assert.equal(result.stdout, expected, "migration status was not canonical");
}

export function assertNormalMigration(result: CommandResult, expectedCode: number): void {
  assert.equal(result.code, expectedCode, "migration process returned an unexpected exit code");
  assert.equal(result.stdout, "", "migration process wrote unexpected stdout");
  assert.equal(
    result.stderr,
    expectedCode === 0 ? "" : migrationFailure,
    "migration process wrote unexpected stderr",
  );
}

export async function runProcess(
  executable: string,
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
  deadlineMs = timeoutMs,
  outputLimitBytes = maximumChildOutputBytes,
): Promise<CommandResult> {
  return await new Promise<CommandResult>((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let settled = false;
    const child = spawn(executable, arguments_, {
      cwd: repositoryRoot,
      env: environment,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error("Migration process exceeded its deadline."));
    }, deadlineMs);
    timer.unref();
    const capture = (target: Buffer[], chunk: Buffer): void => {
      if (settled) return;
      outputBytes += chunk.length;
      if (outputBytes > outputLimitBytes) {
        settled = true;
        clearTimeout(timer);
        child.kill("SIGKILL");
        reject(new Error("Migration process exceeded its output limit."));
        return;
      }
      target.push(chunk);
    };
    child.stdout?.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr?.on("data", (chunk: Buffer) => capture(stderr, chunk));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}

async function runMigrator(
  databaseUrl: string,
  status = false,
  environmentFile?: string,
  dotenvKey?: string,
): Promise<CommandResult> {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    DOTENV_CONFIG_QUIET: "false",
    DOTENV_CONFIG_DEBUG: "true",
    DATABASE_URL: databaseUrl,
    NODE_ENV: "test",
  };
  if (environmentFile !== undefined) {
    environment.DOTENV_CONFIG_PATH = environmentFile;
    environment.DOTENV_CONFIG_OVERRIDE = "true";
    delete environment.DATABASE_URL;
  }
  if (dotenvKey !== undefined) environment.DOTENV_CONFIG_DOTENV_KEY = dotenvKey;
  return await runProcess(
    process.execPath,
    [migrateEntryPoint, ...(status ? ["--status"] : [])],
    environment,
  );
}

async function writeMigrationEnvironment(file: string, databaseUrl: string): Promise<void> {
  if (/\r|\n/u.test(databaseUrl)) throw new Error("Migration environment URL is invalid.");
  await writeFile(
    file,
    `DATABASE_URL=${databaseUrl}\ndotenv_config_quiet=false\nDoTeNv_CoNfIg_DeBuG=true\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
}

function quotedDatabase(name: string): string {
  if (!disposableName.test(name)) throw new Error("Disposable database identifier is invalid.");
  return `"${name}"`;
}

async function close(connection: DatabaseConnection | undefined): Promise<void> {
  await connection?.close().catch(() => undefined);
}

async function createDisposable(admin: DatabaseConnection, name: string): Promise<void> {
  await admin.sql.unsafe(`create database ${quotedDatabase(name)}`);
}

async function requirePinnedStringSyntax(
  databaseUrl: string,
  mutation: "none" | "session" | "persistent" = "none",
): Promise<void> {
  const guard = createDatabase(databaseUrl, 1);
  try {
    await guard.sql.unsafe(`
      create function public.schedule_require_standard_strings()
      returns event_trigger
      language plpgsql
      as $guard$
      begin
        if current_setting('standard_conforming_strings') <> 'on' then
          raise exception 'migration string syntax is not pinned';
        end if;
        ${
          mutation === "session"
            ? "perform set_config('standard_conforming_strings', 'off', false);"
            : mutation === "persistent"
              ? "execute format('alter database %I set schedule.verifier_persistent = %L', current_database(), 'changed');"
              : ""
        }
      end
      $guard$
    `);
    await guard.sql.unsafe(`
      create event trigger schedule_require_standard_strings
      on ddl_command_start
      execute function public.schedule_require_standard_strings()
    `);
  } finally {
    await guard.close();
  }
}

async function dropDisposable(admin: DatabaseConnection, name: string): Promise<void> {
  await admin.sql.unsafe(`drop database if exists ${quotedDatabase(name)} with (force)`);
}

async function assertCanonicalLedger(
  connection: DatabaseConnection,
  expectedRows: number,
): Promise<void> {
  const [ledger] = await connection.sql<
    { ledgerRelations: number; rows: number; uniqueRows: number }[]
  >`
    select
      (select count(*)::integer from pg_catalog.pg_class c join pg_catalog.pg_namespace n
        on n.oid = c.relnamespace where n.nspname = 'drizzle' and c.relname = '__drizzle_migrations'
        and c.relkind = 'r') as "ledgerRelations",
      (select count(*)::integer from drizzle.__drizzle_migrations) as rows,
      (select count(*)::integer from (
        select distinct id, created_at, hash from drizzle.__drizzle_migrations
      ) unique_rows) as "uniqueRows"
  `;
  assert.deepEqual(ledger, {
    ledgerRelations: 1,
    rows: expectedRows,
    uniqueRows: expectedRows,
  });
}

async function assertNoPartialMigration(connection: DatabaseConnection): Promise<void> {
  const [rolledBack] = await connection.sql<
    { ledger: string | null; persistentChanges: number; schema: boolean }[]
  >`
    select
      to_regclass('drizzle.__drizzle_migrations')::text as ledger,
      exists(select 1 from pg_catalog.pg_namespace where nspname = 'drizzle') as schema,
      (select count(*)::integer
        from pg_catalog.pg_db_role_setting
        where setdatabase = (select oid from pg_catalog.pg_database where datname = current_database())
          and setconfig @> array['schedule.verifier_persistent=changed']) as "persistentChanges"
  `;
  assert.deepEqual(
    rolledBack,
    { ledger: null, persistentChanges: 0, schema: false },
    "guard violation left partial migration state",
  );
}

async function retainedSnapshot(connection: DatabaseConnection): Promise<{
  readonly rows: number;
  readonly ledgers: number;
  readonly relations: number;
}> {
  const [snapshot] = await connection.sql<{ rows: number; ledgers: number; relations: number }[]>`
    select
      (select count(*)::integer from retained.keep) as rows,
      (select count(*)::integer from pg_catalog.pg_class c join pg_catalog.pg_namespace n
        on n.oid = c.relnamespace where n.nspname = 'drizzle' and c.relname = '__drizzle_migrations'
        and c.relkind = 'r') as ledgers,
      (select count(*)::integer from pg_catalog.pg_class c join pg_catalog.pg_namespace n
        on n.oid = c.relnamespace where n.nspname = 'retained' and c.relkind = 'r') as relations
  `;
  if (snapshot === undefined) throw new Error("Retained-data snapshot failed.");
  return snapshot;
}

function forgedLedgerSql(manifest: MigrationManifest): string {
  const rows = manifest.entries
    .map((entry, index) => `(${index + 1}, '${entry.sha256}', ${entry.createdAt})`)
    .join(", ");
  return `
    create schema drizzle;
    create view drizzle.__drizzle_migrations as
      select id::bigint as id, hash::text as hash, created_at::bigint as created_at
      from (values ${rows}) ledger(id, hash, created_at);
    create schema retained;
    create table retained.keep (id integer primary key, note text not null);
    insert into retained.keep values (1, 'preserve');
  `;
}

async function forgedLedgerSnapshot(connection: DatabaseConnection): Promise<{
  readonly kind: string | null;
  readonly ledgerRows: number;
  readonly retainedRows: number;
}> {
  const [snapshot] = await connection.sql<
    { kind: string | null; ledgerRows: number; retainedRows: number }[]
  >`
    select
      (select c.relkind::text from pg_catalog.pg_class c join pg_catalog.pg_namespace n
        on n.oid = c.relnamespace
        where n.nspname = 'drizzle' and c.relname = '__drizzle_migrations') as kind,
      (select count(*)::integer from drizzle.__drizzle_migrations) as "ledgerRows",
      (select count(*)::integer from retained.keep) as "retainedRows"
  `;
  if (snapshot === undefined) throw new Error("Forged-ledger snapshot failed.");
  return snapshot;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function historicalMigrationSql(source: HistoricalMigrationSource): Promise<string> {
  const result = await runProcess(
    "git",
    ["show", `${source.commit}:packages/database/drizzle/${source.tag}.sql`],
    process.env,
    timeoutMs,
    maximumHistoricalMigrationBytes,
  );
  if (result.code !== 0 || result.stderr !== "") {
    throw new Error(`Historical migration source ${source.tag} is unavailable.`);
  }
  const sql = Buffer.from(result.stdout, "utf8");
  if (sha256(sql) !== source.sha256) {
    throw new Error(`Historical migration source ${source.tag} does not match its accepted hash.`);
  }
  return result.stdout;
}

async function applyHistoricalMigrationHistory(
  connection: DatabaseConnection,
  manifest: MigrationManifest,
  source: HistoricalMigrationSource,
): Promise<void> {
  const sourceIndex = manifest.entries.findIndex((entry) => entry.tag === source.tag);
  const repairIndex = manifest.entries.findIndex((entry) => entry.tag === historicalRepairTag);
  const sourceEntry = manifest.entries[sourceIndex];
  if (
    sourceIndex < 0 ||
    repairIndex <= sourceIndex ||
    sourceEntry === undefined ||
    !sourceEntry.compatibleSha256.includes(source.sha256)
  ) {
    throw new Error("Historical migration source is not in the released history.");
  }
  const historicalSql = await historicalMigrationSql(source);
  const migrations = await Promise.all(
    manifest.entries.slice(0, repairIndex).map(async (entry, index) => {
      if (index === sourceIndex) return { entry, sql: historicalSql, hash: source.sha256 };
      const bytes = await readFile(path.join(migrationsFolder, `${entry.tag}.sql`));
      const hash = sha256(bytes);
      if (hash !== entry.sha256 && hash !== entry.crlfSha256) {
        throw new Error(`Canonical migration source ${entry.tag} does not match its manifest.`);
      }
      return { entry, sql: bytes.toString("utf8"), hash };
    }),
  );
  await connection.sql.begin(async (transaction) => {
    await transaction.unsafe("set standard_conforming_strings = on");
    const [syntax] = await transaction<{ value: string }[]>`
      select current_setting('standard_conforming_strings') as value
    `;
    assert.equal(syntax?.value, "on", "historical migration string syntax was not pinned");
    await transaction.unsafe(`
      create schema drizzle;
      create table drizzle.__drizzle_migrations (
        id serial primary key not null,
        hash text not null,
        created_at bigint not null
      );
    `);
    for (const migration of migrations) {
      for (const statement of migrationSqlStatements(migration.sql)) {
        await transaction.unsafe(statement.source);
      }
      await transaction`
        insert into drizzle.__drizzle_migrations (hash, created_at)
        values (${migration.hash}, ${migration.entry.createdAt})
      `;
    }
  });
}

async function retainedUpgradeSnapshot(connection: DatabaseConnection): Promise<string> {
  const [snapshot] = await connection.sql<{ value: string }[]>`
    select jsonb_build_object(
      'users', (select coalesce(jsonb_agg(to_jsonb(users) order by id), '[]'::jsonb) from public.users),
      'identities', (select coalesce(jsonb_agg(to_jsonb(external_identities) order by id), '[]'::jsonb) from public.external_identities),
      'workspaces', (select coalesce(jsonb_agg(to_jsonb(workspaces) order by id), '[]'::jsonb) from public.workspaces),
      'workItems', (select coalesce(jsonb_agg(to_jsonb(work_items) order by id), '[]'::jsonb) from public.work_items),
      'syncCapability', (select coalesce(jsonb_agg(to_jsonb(hosted_work_item_sync_capability) order by singleton), '[]'::jsonb) from public.hosted_work_item_sync_capability),
      'syncStates', (select coalesce(jsonb_agg(to_jsonb(hosted_work_item_sync_states) order by workspace_id), '[]'::jsonb) from public.hosted_work_item_sync_states),
      'syncChanges', (select coalesce(jsonb_agg(to_jsonb(hosted_work_item_sync_changes) order by workspace_id, cursor), '[]'::jsonb) from public.hosted_work_item_sync_changes)
    )::text as value
  `;
  if (snapshot === undefined) throw new Error("Historical data snapshot failed.");
  return snapshot.value;
}

async function seedHistoricalRetainedData(
  connection: DatabaseConnection,
  includeOversizedIdentity: boolean,
): Promise<{ readonly workspaceId: string; readonly workItemId: string }> {
  const userId = randomUUID();
  const workspaceId = randomUUID();
  const workItemId = randomUUID();
  await connection.sql`insert into public.users (id) values (${userId})`;
  await connection.sql`
    insert into public.external_identities (user_id, issuer, subject)
    values (${userId}, ${includeOversizedIdentity ? "i".repeat(2_000) : "https://issuer.test"}, ${includeOversizedIdentity ? "s" : "subject"})
  `;
  await connection.sql`insert into public.workspaces (id, name) values (${workspaceId}, 'Retained')`;
  await connection.sql`
    insert into public.work_items (id, workspace_id, title)
    values (${workItemId}, ${workspaceId}, 'Retained work item')
  `;
  return { workspaceId, workItemId };
}

async function assertHistoricalRepair(
  connection: DatabaseConnection,
  manifest: MigrationManifest,
  source: HistoricalMigrationSource,
  before: string,
  workspaceId: string,
  workItemId: string,
): Promise<void> {
  assert.deepEqual(
    await retainedUpgradeSnapshot(connection),
    before,
    "upgrade changed retained data",
  );
  await assertCanonicalLedger(connection, manifest.entries.length);
  const repairIndex = manifest.entries.findIndex((entry) => entry.tag === historicalRepairTag);
  const [ledger] = await connection.sql<{ historical: string; repair: string }[]>`
    select
      (select hash from drizzle.__drizzle_migrations order by id offset ${manifest.entries.findIndex((entry) => entry.tag === source.tag)} limit 1) as historical,
      (select hash from drizzle.__drizzle_migrations order by id offset ${repairIndex} limit 1) as repair
  `;
  assert.deepEqual(ledger, {
    historical: source.sha256,
    repair: manifest.entries[repairIndex]?.sha256,
  });
  const [catalog] = await connection.sql<
    {
      readonly identityBound: boolean;
      readonly identityBoundValidated: boolean;
      readonly retentionIndexReady: boolean;
      readonly retentionIndexColumns: readonly string[] | null;
      readonly failClosedFunction: boolean;
      readonly functionUsesUpsert: boolean;
    }[]
  >`
    select
      exists(select 1 from pg_catalog.pg_constraint where conrelid = 'public.external_identities'::regclass and conname = 'external_identities_key_bytes_bounded') as "identityBound",
      coalesce((select convalidated from pg_catalog.pg_constraint where conrelid = 'public.external_identities'::regclass and conname = 'external_identities_key_bytes_bounded'), false) as "identityBoundValidated",
      coalesce((select i.indisvalid and i.indisready from pg_catalog.pg_index i where i.indexrelid = 'public.hosted_work_item_sync_states_retention_idx'::regclass), false) as "retentionIndexReady",
      (select array_agg(a.attname order by key.ordinality)
        from pg_catalog.pg_index i
        cross join lateral unnest(i.indkey) with ordinality key(attnum, ordinality)
        join pg_catalog.pg_attribute a on a.attrelid = i.indrelid and a.attnum = key.attnum
        where i.indexrelid = 'public.hosted_work_item_sync_states_retention_idx'::regclass) as "retentionIndexColumns",
      position('hosted work item sync state is missing' in pg_get_functiondef('public.capture_hosted_work_item_sync_change()'::regprocedure)) > 0 as "failClosedFunction",
      position('on conflict' in lower(pg_get_functiondef('public.capture_hosted_work_item_sync_change()'::regprocedure))) > 0 as "functionUsesUpsert"
  `;
  assert.equal(catalog?.identityBound, true, "identity byte bound was not repaired");
  assert.equal(
    catalog?.identityBoundValidated,
    source.tag !== "0031_daffy_bloodstrike",
    "identity byte bound validation did not preserve historical data",
  );
  assert.equal(catalog?.retentionIndexReady, true, "sync retention index is not ready");
  assert.deepEqual(catalog?.retentionIndexColumns, ["updated_at", "workspace_id"]);
  assert.equal(catalog?.failClosedFunction, true, "sync capture function was not repaired");
  assert.equal(catalog?.functionUsesUpsert, false, "sync capture function retained an upsert path");
  await assert.rejects(
    connection.sql`
      insert into public.external_identities (user_id, issuer, subject)
      select id, ${"z".repeat(2_000)}, 'new-oversized-identity' from public.users limit 1
    `,
    (error: unknown) =>
      (error as { code?: string; constraint_name?: string }).code === "23514" &&
      (error as { constraint_name?: string }).constraint_name ===
        "external_identities_key_bytes_bounded",
    "new oversized identities must be rejected",
  );
  await connection.sql`
    update public.hosted_work_item_sync_capability
    set capture_enabled = true, enabled_at = pg_catalog.clock_timestamp()
    where singleton
  `;
  await connection.sql.unsafe(
    "alter table public.hosted_work_item_sync_states disable trigger hosted_work_item_sync_states_delete_guard",
  );
  try {
    await connection.sql`
      delete from public.hosted_work_item_sync_states where workspace_id = ${workspaceId}
    `;
  } finally {
    await connection.sql.unsafe(
      "alter table public.hosted_work_item_sync_states enable trigger hosted_work_item_sync_states_delete_guard",
    );
  }
  await assert.rejects(
    connection.sql`update public.work_items set title = 'must fail closed' where id = ${workItemId}`,
    (error: unknown) =>
      (error as { code?: string; message?: string }).code === "55000" &&
      (error as { message?: string }).message === "hosted work item sync state is missing",
    "missing sync state must fail closed",
  );
  const [retainedWorkItem] = await connection.sql<{ title: string }[]>`
    select title from public.work_items where id = ${workItemId}
  `;
  assert.equal(
    retainedWorkItem?.title,
    "Retained work item",
    "failed sync update changed work data",
  );
}

export async function verifyMigrationLedger(sourceDatabaseUrl: string): Promise<void> {
  await access(migrateEntryPoint);
  const manifest = await loadMigrationManifest(migrationsFolder);
  const environmentDirectory = await mkdtemp(path.join(os.tmpdir(), "schedule-ledger-env-"));
  const exactEnvironment = path.join(environmentDirectory, "exact.env");
  const divergentEnvironment = path.join(environmentDirectory, "divergent.env");
  const nonce = randomUUID().replaceAll("-", "");
  const cleanName = disposableDatabaseName(nonce);
  const sessionMutationName = disposableDatabaseName(randomUUID().replaceAll("-", ""));
  const persistentMutationName = disposableDatabaseName(randomUUID().replaceAll("-", ""));
  const retainedName = disposableDatabaseName(randomUUID().replaceAll("-", ""));
  const forgedLedgerName = disposableDatabaseName(randomUUID().replaceAll("-", ""));
  const admin = createDatabase(databaseUrlFor(sourceDatabaseUrl, "postgres"), 1, {
    applicationName: "schedule-migration-ledger-verifier",
  });
  let clean: DatabaseConnection | undefined;
  let sessionMutation: DatabaseConnection | undefined;
  let persistentMutation: DatabaseConnection | undefined;
  let retained: DatabaseConnection | undefined;
  let forgedLedger: DatabaseConnection | undefined;
  let cleanCreated = false;
  let sessionMutationCreated = false;
  let persistentMutationCreated = false;
  let retainedCreated = false;
  let forgedLedgerCreated = false;
  try {
    await createDisposable(admin, cleanName);
    cleanCreated = true;
    const cleanUrl = databaseUrlFor(sourceDatabaseUrl, cleanName);
    await requirePinnedStringSyntax(cleanUrl);
    await admin.sql.unsafe(
      `alter database ${quotedDatabase(cleanName)} set standard_conforming_strings = off`,
    );
    clean = createDatabase(cleanUrl, 1);
    const [untrustedDefault] = await clean.sql<{ value: string }[]>`
      select current_setting('standard_conforming_strings') as value
    `;
    assert.equal(untrustedDefault?.value, "off", "database string default was not changed");
    const [first, second] = await Promise.all([runMigrator(cleanUrl), runMigrator(cleanUrl)]);
    assertNormalMigration(first, 0);
    assertNormalMigration(second, 0);
    await assertCanonicalLedger(clean, manifest.entries.length);
    assertExactStatus(await runMigrator(cleanUrl, true), statusLine);
    await writeMigrationEnvironment(exactEnvironment, cleanUrl);
    assertExactStatus(await runMigrator(cleanUrl, true, exactEnvironment), statusLine);
    assertNormalMigration(await runMigrator(cleanUrl, true, exactEnvironment, missingVaultKey), 1);

    await createDisposable(admin, sessionMutationName);
    sessionMutationCreated = true;
    const sessionMutationUrl = databaseUrlFor(sourceDatabaseUrl, sessionMutationName);
    await requirePinnedStringSyntax(sessionMutationUrl, "session");
    assertNormalMigration(await runMigrator(sessionMutationUrl), 1);
    sessionMutation = createDatabase(sessionMutationUrl, 1);
    await assertNoPartialMigration(sessionMutation);

    await createDisposable(admin, persistentMutationName);
    persistentMutationCreated = true;
    const persistentMutationUrl = databaseUrlFor(sourceDatabaseUrl, persistentMutationName);
    await requirePinnedStringSyntax(persistentMutationUrl, "persistent");
    assertNormalMigration(await runMigrator(persistentMutationUrl), 1);
    persistentMutation = createDatabase(persistentMutationUrl, 1);
    await assertNoPartialMigration(persistentMutation);

    await createDisposable(admin, retainedName);
    retainedCreated = true;
    const retainedUrl = databaseUrlFor(sourceDatabaseUrl, retainedName);
    retained = createDatabase(retainedUrl, 1);
    await retained.sql.unsafe(
      "create schema retained; create table retained.keep (id integer primary key, note text not null); insert into retained.keep values (1, 'preserve');",
    );
    const before = await retainedSnapshot(retained);
    assert.deepEqual(before, { rows: 1, ledgers: 0, relations: 1 });
    assertExactStatus(await runMigrator(retainedUrl, true), divergentStatusLine);
    assertNormalMigration(await runMigrator(retainedUrl), 1);
    assert.deepEqual(await retainedSnapshot(retained), before, "divergent database was mutated");

    await createDisposable(admin, forgedLedgerName);
    forgedLedgerCreated = true;
    const forgedLedgerUrl = databaseUrlFor(sourceDatabaseUrl, forgedLedgerName);
    forgedLedger = createDatabase(forgedLedgerUrl, 1);
    await forgedLedger.sql.unsafe(forgedLedgerSql(manifest));
    const forgedBefore = await forgedLedgerSnapshot(forgedLedger);
    assert.deepEqual(forgedBefore, {
      kind: "v",
      ledgerRows: manifest.entries.length,
      retainedRows: 1,
    });
    assertExactStatus(await runMigrator(forgedLedgerUrl, true), divergentStatusLine);
    await writeMigrationEnvironment(divergentEnvironment, forgedLedgerUrl);
    assertExactStatus(
      await runMigrator(forgedLedgerUrl, true, divergentEnvironment),
      divergentStatusLine,
    );
    assertNormalMigration(await runMigrator(forgedLedgerUrl), 1);
    assert.deepEqual(
      await forgedLedgerSnapshot(forgedLedger),
      forgedBefore,
      "non-table migration ledger was mutated",
    );

    for (let index = 0; index < historicalMigrationSources.length; index += 2) {
      const results = await Promise.allSettled(
        historicalMigrationSources.slice(index, index + 2).map(async (source) => {
          const historicalName = disposableDatabaseName(randomUUID().replaceAll("-", ""));
          let historical: DatabaseConnection | undefined;
          let historicalCreated = false;
          try {
            await createDisposable(admin, historicalName);
            historicalCreated = true;
            const historicalUrl = databaseUrlFor(sourceDatabaseUrl, historicalName);
            historical = createDatabase(historicalUrl, 1, {
              applicationName: "schedule-historical-migration-verifier",
              suppressNotices: true,
            });
            await applyHistoricalMigrationHistory(historical, manifest, source);
            const retained = await seedHistoricalRetainedData(
              historical,
              source.tag === "0031_daffy_bloodstrike",
            );
            const before = await retainedUpgradeSnapshot(historical);
            assertExactStatus(
              await runMigrator(historicalUrl, true),
              "SCHEDULE_MIGRATION_STATUS_V1 prefix\n",
            );
            assertNormalMigration(await runMigrator(historicalUrl), 0);
            assertExactStatus(await runMigrator(historicalUrl, true), statusLine);
            await assertHistoricalRepair(
              historical,
              manifest,
              source,
              before,
              retained.workspaceId,
              retained.workItemId,
            );
          } finally {
            await close(historical);
            if (historicalCreated) {
              await dropDisposable(admin, historicalName).catch(() => undefined);
            }
          }
        }),
      );
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    }
  } finally {
    await close(clean);
    await close(sessionMutation);
    await close(persistentMutation);
    await close(retained);
    await close(forgedLedger);
    if (cleanCreated) await dropDisposable(admin, cleanName).catch(() => undefined);
    if (sessionMutationCreated) {
      await dropDisposable(admin, sessionMutationName).catch(() => undefined);
    }
    if (persistentMutationCreated) {
      await dropDisposable(admin, persistentMutationName).catch(() => undefined);
    }
    if (retainedCreated) await dropDisposable(admin, retainedName).catch(() => undefined);
    if (forgedLedgerCreated) {
      await dropDisposable(admin, forgedLedgerName).catch(() => undefined);
    }
    try {
      await admin.close();
    } finally {
      await rm(environmentDirectory, { recursive: true, force: true });
    }
  }
}

async function main(): Promise<void> {
  parseMigrationLedgerVerifierArguments(process.argv.slice(2));
  const source = process.env.DATABASE_URL;
  if (source === undefined || source === "") throw new Error("DATABASE_URL is required.");
  await verifyMigrationLedger(source);
  process.stdout.write("Migration ledger verification passed.\n");
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch(() => {
    process.stderr.write("Migration ledger verification failed.\n");
    process.exitCode = 1;
  });
}
