import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createDatabase, type DatabaseConnection } from "../packages/database/src/index.js";
import { loadMigrationManifest } from "../packages/database/src/migration-ledger.js";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const migrateEntryPoint = path.join(repositoryRoot, "packages/database/dist/migrate.js");
const migrationsFolder = path.join(repositoryRoot, "packages/database/drizzle");
const timeoutMs = 30_000;
const maximumChildOutputBytes = 4_096;
const disposableName = /^schedule_ledger_verify_[a-f0-9]{32}$/u;
const statusLine = "SCHEDULE_MIGRATION_STATUS_V1 exact\n";
const divergentStatusLine = "SCHEDULE_MIGRATION_STATUS_V1 divergent\n";
const migrationFailure = "Database migration compatibility check failed.\n";

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
      if (outputBytes > maximumChildOutputBytes) {
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

async function runMigrator(databaseUrl: string, status = false): Promise<CommandResult> {
  return await runProcess(process.execPath, [migrateEntryPoint, ...(status ? ["--status"] : [])], {
    ...process.env,
    DATABASE_URL: databaseUrl,
    NODE_ENV: "test",
  });
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

export async function verifyMigrationLedger(sourceDatabaseUrl: string): Promise<void> {
  await access(migrateEntryPoint);
  const nonce = randomUUID().replaceAll("-", "");
  const cleanName = disposableDatabaseName(nonce);
  const retainedName = disposableDatabaseName(randomUUID().replaceAll("-", ""));
  const admin = createDatabase(databaseUrlFor(sourceDatabaseUrl, "postgres"), 1, {
    applicationName: "schedule-migration-ledger-verifier",
  });
  let clean: DatabaseConnection | undefined;
  let retained: DatabaseConnection | undefined;
  let cleanCreated = false;
  let retainedCreated = false;
  try {
    await createDisposable(admin, cleanName);
    cleanCreated = true;
    const cleanUrl = databaseUrlFor(sourceDatabaseUrl, cleanName);
    const [first, second] = await Promise.all([runMigrator(cleanUrl), runMigrator(cleanUrl)]);
    assertNormalMigration(first, 0);
    assertNormalMigration(second, 0);
    clean = createDatabase(cleanUrl, 1);
    const manifest = await loadMigrationManifest(migrationsFolder);
    await assertCanonicalLedger(clean, manifest.entries.length);
    assertExactStatus(await runMigrator(cleanUrl, true), statusLine);

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
  } finally {
    await close(clean);
    await close(retained);
    if (cleanCreated) await dropDisposable(admin, cleanName).catch(() => undefined);
    if (retainedCreated) await dropDisposable(admin, retainedName).catch(() => undefined);
    await admin.close();
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
