import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createDatabase } from "../packages/database/src/database.js";
import { runDesktopPortableChild } from "../packages/database/src/desktop-portable.js";
import {
  assertComposeDatabaseReady,
  composeDatabaseService,
  composeDatabaseUser,
  createBackup,
  repositoryRoot,
} from "./backup-database.js";
import { quoteIdentifier, runPsql } from "./restore-database.js";

const backupWorkspaceId = "10000000-0000-0000-0000-000000000201";
const postBackupWorkspaceId = "10000000-0000-0000-0000-000000000202";
const backupWorkspaceName = "migration backup source";
const postBackupWorkspaceName = "migration backup post-change";
const sequence = "public.activity_events_ingested_sequence_seq";
const backupSequenceValue = 700_001;

function postgresUrl(user: string, password: string, database: string, host = "127.0.0.1"): string {
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}:5432/${database}`;
}

function sqlString(value: string): string {
  if (!/^[a-z0-9_ -]+$/.test(value)) throw new Error("invalid verifier SQL string");
  return `'${value}'`;
}

function generatedName(prefix: string, nonce: string): string {
  const value = `${prefix}${nonce}`;
  quoteIdentifier(value);
  return value;
}

async function runDocker(args: readonly string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn("docker", [...args], {
      cwd: repositoryRoot,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(Buffer.concat(stdout).toString("utf8"));
      else {
        const diagnostic = Buffer.concat(stderr).toString("utf8").trim();
        reject(
          new Error(
            `Docker recovery verifier runner failed with exit code ${String(code)}${diagnostic === "" ? "." : `: ${diagnostic}`}`,
          ),
        );
      }
    });
  });
}

async function composePostgresContainer(): Promise<string> {
  const container = (await runDocker(["compose", "ps", "--quiet", composeDatabaseService])).trim();
  if (!/^[a-f0-9]{12,64}$/.test(container)) {
    throw new Error("Disposable PostgreSQL Compose container is unavailable.");
  }
  return container;
}

async function buildRecoveryRunner(directory: string): Promise<string> {
  const dockerfile = path.join(directory, "Dockerfile");
  await writeFile(
    dockerfile,
    [
      "FROM postgres:17-bookworm AS postgres",
      "FROM node:24-bookworm",
      "RUN apt-get update && apt-get install --yes --no-install-recommends libpq5 && rm -rf /var/lib/apt/lists/*",
      "COPY --from=postgres /usr/lib/postgresql/17/bin/pg_restore /usr/local/bin/pg_restore",
      "RUN /usr/local/bin/pg_restore --version",
    ].join("\n"),
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
  const tag = `schedule-recovery-verifier-${randomUUID().replaceAll("-", "")}`;
  await runDocker(["build", "--quiet", "--tag", tag, "--file", dockerfile, directory]);
  return tag;
}

function migrationLedgerSignature(databaseName: string): Promise<string> {
  return runPsql(
    databaseName,
    "SELECT COALESCE(string_agg(id::text || ':' || hash || ':' || created_at::text, ',' ORDER BY id), '') FROM drizzle.__drizzle_migrations;",
    { quiet: true },
  ).then((value) => value.trim());
}

interface Target {
  readonly databaseName: string;
  readonly ownerRole: string;
  readonly runtimeRole: string;
  readonly ownerPassword: string;
  readonly runtimePassword: string;
}

async function createTarget(): Promise<Target> {
  const nonce = randomUUID().replaceAll("-", "");
  const target: Target = {
    databaseName: generatedName("schedule_dmr_", nonce),
    ownerRole: generatedName("schedule_dmr_owner_", nonce.slice(0, 16)),
    runtimeRole: generatedName("schedule_dmr_runtime_", nonce.slice(0, 16)),
    ownerPassword: randomBytes(24).toString("hex"),
    runtimePassword: randomBytes(24).toString("hex"),
  };
  const owner = quoteIdentifier(target.ownerRole);
  const runtime = quoteIdentifier(target.runtimeRole);
  const database = quoteIdentifier(target.databaseName);
  try {
    await runPsql(
      "postgres",
      `CREATE ROLE ${owner} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD ${sqlString(target.ownerPassword)};
       CREATE ROLE ${runtime} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD ${sqlString(target.runtimePassword)};`,
    );
    await runPsql(
      "postgres",
      `CREATE DATABASE ${database} OWNER ${owner} TEMPLATE template0 ENCODING 'UTF8';`,
    );
    await runPsql(
      target.databaseName,
      `REVOKE CREATE ON SCHEMA public FROM PUBLIC;
       GRANT USAGE, CREATE ON SCHEMA public TO ${owner};
       GRANT USAGE ON SCHEMA public TO ${runtime};`,
    );
    await runDesktopPortableChild(
      process.execPath,
      [path.join(repositoryRoot, "packages", "database", "dist", "migrate.js")],
      {
        DATABASE_URL: postgresUrl(target.ownerRole, target.ownerPassword, target.databaseName),
        DOTENV_CONFIG_QUIET: "true",
        DOTENV_CONFIG_DEBUG: "false",
      },
    );
    await runPsql(
      target.databaseName,
      `INSERT INTO public.workspaces (id, name) VALUES (${sqlString(backupWorkspaceId)}, ${sqlString(backupWorkspaceName)});
       SELECT setval('${sequence}', ${backupSequenceValue}, true);`,
    );
    return target;
  } catch (error) {
    await cleanupTarget(target).catch(() => undefined);
    throw error;
  }
}

async function ownedDatabases(target: Target): Promise<readonly string[]> {
  const rows = await runPsql(
    "postgres",
    `SELECT datname FROM pg_catalog.pg_database WHERE pg_catalog.pg_get_userbyid(datdba) = ${sqlString(target.ownerRole)}
     AND (datname = ${sqlString(target.databaseName)} OR datname ~ '^schedule_(restore|previous)_[0-9a-f]{32}$') ORDER BY datname;`,
    { quiet: true },
  );
  return rows.trim().split(/\r?\n/).filter(Boolean);
}

async function cleanupTarget(target: Target): Promise<void> {
  const names = await ownedDatabases(target).catch(() => [target.databaseName]);
  for (const name of names) {
    await runPsql(
      "postgres",
      `DROP DATABASE IF EXISTS ${quoteIdentifier(name)} WITH (FORCE);`,
    ).catch(() => undefined);
  }
  await runPsql("postgres", `DROP ROLE IF EXISTS ${quoteIdentifier(target.runtimeRole)};`).catch(
    () => undefined,
  );
  await runPsql("postgres", `DROP ROLE IF EXISTS ${quoteIdentifier(target.ownerRole)};`).catch(
    () => undefined,
  );
}

async function runRecoveryRunner(
  image: string,
  directory: string,
  target: Target,
  backupPath: string,
  backupSha256: string,
  backupBytes: number,
): Promise<void> {
  const runnerBackupPath = "/work/recovery.dump";
  await writeFile(path.join(directory, "runner-ready"), "ready\n", {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });
  const environment = [
    `DATABASE_URL=${postgresUrl(target.ownerRole, target.ownerPassword, target.databaseName)}`,
    `SCHEDULE_ADMIN_DATABASE_URL=${postgresUrl(composeDatabaseUser, composeDatabaseUser, "postgres")}`,
    "SCHEDULE_NODE_EXECUTABLE=/usr/local/bin/node",
    "SCHEDULE_MIGRATION_ENTRYPOINT=/workspace/packages/database/dist/migrate.js",
    "SCHEDULE_APPLICATION_VERSION=0.1.0",
    `SCHEDULE_DATABASE_NAME=${target.databaseName}`,
    `SCHEDULE_CLUSTER_ADMIN_ROLE=${composeDatabaseUser}`,
    `SCHEDULE_OWNER_ROLE=${target.ownerRole}`,
    `SCHEDULE_RUNTIME_ROLE=${target.runtimeRole}`,
    "SCHEDULE_PORTABLE_IMPORT_JOURNAL=/work/import-journal.json",
    `SCHEDULE_EXPECTED_ARCHIVE_ID=${randomUUID()}`,
    `SCHEDULE_EXPECTED_ARCHIVE_SHA256=${backupSha256}`,
    `SCHEDULE_EXPECTED_BACKUP_BYTES=${backupBytes}`,
    "SCHEDULE_PG_RESTORE_EXECUTABLE=/usr/local/bin/pg_restore",
  ];
  const postgresContainer = await composePostgresContainer();
  const runnerArguments = [
    "run",
    "--rm",
    "--network",
    `container:${postgresContainer}`,
    "--volume",
    `${repositoryRoot}:/workspace:ro`,
    "--volume",
    `${directory}:/work:rw`,
    "--workdir",
    "/workspace",
    ...environment.flatMap((value) => ["--env", value]),
  ];
  const output = await runDocker([
    ...runnerArguments,
    image,
    "/usr/local/bin/node",
    "/workspace/packages/database/dist/desktop-portable.js",
    "restore-backup",
    runnerBackupPath,
  ]);
  assert.equal(
    output,
    'SCHEDULE_DESKTOP_BACKUP_RECOVERY_V1 {"previousRetained":true}\n',
    "recovery helper must emit only its bounded success protocol",
  );
  assert.equal(
    await readFile(path.join(directory, "runner-ready"), "utf8"),
    "ready\n",
    "recovery runner must not mutate the disposable host directory outside its journal",
  );
  assert.equal((await readFile(backupPath)).length, backupBytes);
}

async function verify(): Promise<void> {
  await assertComposeDatabaseReady("postgres");
  const directory = await mkdtemp(path.join(tmpdir(), "schedule-desktop-migration-backup-"));
  let image: string | undefined;
  let target: Target | undefined;
  let failure: unknown;
  try {
    image = await buildRecoveryRunner(directory);
    target = await createTarget();
    const ledger = await migrationLedgerSignature(target.databaseName);
    const backupPath = path.join(directory, "recovery.dump");
    const backup = await createBackup(backupPath, target.databaseName);
    const backupSha256 = createHash("sha256")
      .update(await readFile(backup.path))
      .digest("hex");
    await runPsql(
      target.databaseName,
      `INSERT INTO public.workspaces (id, name) VALUES (${sqlString(postBackupWorkspaceId)}, ${sqlString(postBackupWorkspaceName)});
       SELECT setval('${sequence}', 900000, true);`,
    );
    await runRecoveryRunner(image, directory, target, backup.path, backupSha256, backup.sizeBytes);

    const activeRows = (
      await runPsql(
        target.databaseName,
        `SELECT id::text || '|' || name FROM public.workspaces WHERE id IN (${sqlString(backupWorkspaceId)}, ${sqlString(postBackupWorkspaceId)}) ORDER BY id;`,
        { quiet: true },
      )
    )
      .trim()
      .split(/\r?\n/)
      .filter(Boolean);
    assert.deepEqual(activeRows, [`${backupWorkspaceId}|${backupWorkspaceName}`]);
    assert.equal(await migrationLedgerSignature(target.databaseName), ledger);
    assert.equal(
      (
        await runPsql(target.databaseName, `SELECT nextval('${sequence}')::text;`, { quiet: true })
      ).trim(),
      String(backupSequenceValue + 1),
      "restored sequence must resume from the verified backup",
    );

    const databases = await ownedDatabases(target);
    const previous = databases.filter((name) => name.startsWith("schedule_previous_"));
    const staging = databases.filter((name) => name.startsWith("schedule_restore_"));
    assert.equal(previous.length, 1, "recovery must retain exactly one prior active database");
    assert.equal(staging.length, 0, "recovery must not leave a staging database");
    await runPsql(
      "postgres",
      `ALTER DATABASE ${quoteIdentifier(previous[0]!)} WITH ALLOW_CONNECTIONS true;`,
    );
    let previousRows: string[];
    try {
      previousRows = (
        await runPsql(
          previous[0]!,
          `SELECT id::text || '|' || name FROM public.workspaces WHERE id IN (${sqlString(backupWorkspaceId)}, ${sqlString(postBackupWorkspaceId)}) ORDER BY id;`,
          { quiet: true },
        )
      )
        .trim()
        .split(/\r?\n/)
        .filter(Boolean);
    } finally {
      await runPsql(
        "postgres",
        `ALTER DATABASE ${quoteIdentifier(previous[0]!)} WITH ALLOW_CONNECTIONS false;
         SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = ${sqlString(previous[0]!)} AND pid <> pg_backend_pid();`,
      );
    }
    assert.deepEqual(previousRows, [
      `${backupWorkspaceId}|${backupWorkspaceName}`,
      `${postBackupWorkspaceId}|${postBackupWorkspaceName}`,
    ]);
    assert.equal(
      (
        await runPsql(
          "postgres",
          `SELECT datallowconn::text FROM pg_database WHERE datname = ${sqlString(previous[0]!)};`,
          { quiet: true },
        )
      ).trim(),
      "false",
      "retained prior database must remain connection-locked",
    );
    const runtime = createDatabase(
      postgresUrl(target.runtimeRole, target.runtimePassword, target.databaseName),
      1,
      { idleTimeoutSeconds: 0, statementTimeoutMs: 10_000, suppressNotices: true },
    );
    try {
      const [visible] = await runtime.sql<{ count: number }[]>`
        SELECT count(*)::integer AS count FROM public.workspaces WHERE id = ${backupWorkspaceId}::uuid
      `;
      assert.equal(visible?.count, 1, "runtime role must read the promoted recovered data");
    } finally {
      await runtime.close();
    }
  } catch (error) {
    failure = error;
  }
  const cleanup: Promise<unknown>[] = [];
  if (target !== undefined) cleanup.push(cleanupTarget(target));
  if (image !== undefined && image !== "")
    cleanup.push(runDocker(["image", "rm", "--force", image]));
  cleanup.push(rm(directory, { recursive: true, force: true }));
  const results = await Promise.allSettled(cleanup);
  const errors = results.filter(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failure !== undefined && errors.length > 0) {
    throw new AggregateError(
      [failure, ...errors.map((result) => result.reason)],
      "Desktop migration-backup recovery verification and cleanup failed.",
      { cause: failure },
    );
  }
  if (failure !== undefined) throw failure;
  if (errors.length > 0) {
    throw new AggregateError(
      errors.map((result) => result.reason),
      "Desktop migration-backup recovery cleanup failed.",
    );
  }
}

if (process.argv.length !== 2) {
  throw new Error("Usage: pnpm verify:desktop-migration-backup-recovery");
}
await verify();
console.log("Desktop migration-backup recovery verification passed.");
