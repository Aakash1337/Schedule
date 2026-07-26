import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { access, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
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
const dockerCommandTimeoutMs = 15 * 60 * 1_000;
const dockerTerminationGraceMs = 5_000;
const crashExitCode = 97;
const faultPoints = [
  "allocation-written",
  "staging-created",
  "staging-marked",
  "prepared",
  "after-operation:mark-previous",
  "after-operation:disable-active",
  "after-operation:rename-active",
  "after-operation:promote-staging",
  "after-operation:enable-active",
  "committed",
] as const;
type FaultPoint = (typeof faultPoints)[number];
const committedFaults = new Set<FaultPoint>([
  "after-operation:promote-staging",
  "after-operation:enable-active",
  "committed",
]);

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

async function runDocker(args: readonly string[], expectedExitCode = 0): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn("docker", [...args], {
      cwd: repositoryRoot,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    let timedOut = false;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const deadline = setTimeout(() => {
      timedOut = true;
      child.kill();
      escalation = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        try {
          child.kill("SIGKILL");
        } catch {
          // The explicit timeout result remains authoritative.
        }
        child.unref();
        finish(new Error("Docker recovery verifier runner timed out."));
      }, dockerTerminationGraceMs);
      escalation.unref?.();
    }, dockerCommandTimeoutMs);
    deadline.unref?.();
    const finish = (error?: Error, output?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (escalation !== undefined) clearTimeout(escalation);
      if (error !== undefined) reject(error);
      else resolve(output ?? "");
    };
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) =>
      finish(timedOut ? new Error("Docker recovery verifier runner timed out.") : error),
    );
    child.once("close", (code) => {
      if (timedOut) finish(new Error("Docker recovery verifier runner timed out."));
      else if (code === expectedExitCode) finish(undefined, Buffer.concat(stdout).toString("utf8"));
      else {
        const diagnostic = Buffer.concat(stderr).toString("utf8").trim();
        finish(
          new Error(
            `Docker recovery verifier runner failed with exit code ${String(code)} (expected ${expectedExitCode})${diagnostic === "" ? "." : `: ${diagnostic}`}`,
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

interface RecoveryScenario {
  readonly runnerArguments: readonly string[];
  readonly runnerBackupPath: string;
  readonly backupPath: string;
  readonly journalPath: string;
  readonly recoveryId: string;
}

async function createRecoveryScenario(
  directory: string,
  target: Target,
  backupPath: string,
  backupSha256: string,
  backupBytes: number,
  index: number,
): Promise<RecoveryScenario> {
  const journalPath = path.join(directory, `import-journal-${index}.json`);
  const runnerBackupPath = `/work/${path.basename(backupPath)}`;
  const runnerJournalPath = `/work/${path.basename(journalPath)}`;
  const recoveryId = randomUUID();
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
    `SCHEDULE_PORTABLE_IMPORT_JOURNAL=${runnerJournalPath}`,
    `SCHEDULE_EXPECTED_ARCHIVE_ID=${recoveryId}`,
    `SCHEDULE_EXPECTED_ARCHIVE_SHA256=${backupSha256}`,
    `SCHEDULE_EXPECTED_BACKUP_BYTES=${backupBytes}`,
    "SCHEDULE_PG_RESTORE_EXECUTABLE=/usr/local/bin/pg_restore",
  ];
  const postgresContainer = await composePostgresContainer();
  return {
    backupPath,
    runnerBackupPath,
    journalPath,
    recoveryId,
    runnerArguments: [
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
    ],
  };
}

async function runFaultChild(
  image: string,
  scenario: RecoveryScenario,
  fault: FaultPoint,
  index: number,
): Promise<void> {
  const markerPath = `/work/fault-${index}.txt`;
  const program = [
    'import { writeFileSync } from "node:fs";',
    'import { restoreDesktopMigrationBackup } from "/workspace/packages/database/dist/desktop-portable.js";',
    `const fault = ${JSON.stringify(fault)};`,
    `const marker = ${JSON.stringify(markerPath)};`,
    `await restoreDesktopMigrationBackup(${JSON.stringify(scenario.runnerBackupPath)}, undefined, {`,
    "  fault: async (point) => {",
    "    if (point !== fault) return;",
    '    writeFileSync(marker, `${point}\\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });',
    `    process.exit(${crashExitCode});`,
    "  },",
    "});",
    'throw new Error("requested backup-recovery fault was not reached");',
  ].join("\n");
  await runDocker(
    [
      ...scenario.runnerArguments,
      image,
      "/usr/local/bin/node",
      "--input-type=module",
      "--eval",
      program,
    ],
    crashExitCode,
  );
  assert.equal(
    await readFile(path.join(path.dirname(scenario.journalPath), `fault-${index}.txt`), "utf8"),
    `${fault}\n`,
  );
  await access(scenario.journalPath);
}

async function runRecoveryRunner(
  image: string,
  scenario: RecoveryScenario,
  retryNeedsDump: boolean,
): Promise<void> {
  const output = await runDocker([
    ...scenario.runnerArguments,
    image,
    "/usr/local/bin/node",
    "/workspace/packages/database/dist/desktop-portable.js",
    "restore-backup",
    scenario.runnerBackupPath,
  ]);
  assert.equal(
    output,
    'SCHEDULE_DESKTOP_BACKUP_RECOVERY_V1 {"previousRetained":true}\n',
    "recovery helper must emit only its bounded success protocol",
  );
  if (retryNeedsDump) {
    const reconciliation = await runDocker([
      ...scenario.runnerArguments,
      image,
      "/usr/local/bin/node",
      "/workspace/packages/database/dist/desktop-portable.js",
      "recover",
    ]);
    assert.equal(
      reconciliation,
      `SCHEDULE_PORTABLE_RECOVERY_V1 {"recovered":true,"committed":true,"archiveId":"${scenario.recoveryId}"}\n`,
      "restart reconciliation must durably finish the committed backup recovery",
    );
  }
  await assert.rejects(access(scenario.journalPath));
  if (retryNeedsDump) assert.ok((await readFile(scenario.backupPath)).length > 0);
}

async function assertRecovered(target: Target, ledger: string, fault: FaultPoint): Promise<void> {
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
  assert.equal(
    previous.length,
    1,
    `recovery must retain exactly one prior database after ${fault}`,
  );
  assert.equal(staging.length, 0, `recovery must not leave staging after ${fault}`);
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
}

async function verifyFault(
  image: string,
  directory: string,
  fault: FaultPoint,
  index: number,
): Promise<void> {
  const target = await createTarget();
  try {
    const ledger = await migrationLedgerSignature(target.databaseName);
    const backupPath = path.join(directory, `recovery-${index}.dump`);
    const backup = await createBackup(backupPath, target.databaseName);
    const backupSha256 = createHash("sha256")
      .update(await readFile(backup.path))
      .digest("hex");
    const scenario = await createRecoveryScenario(
      directory,
      target,
      backup.path,
      backupSha256,
      backup.sizeBytes,
      index,
    );
    await runPsql(
      target.databaseName,
      `INSERT INTO public.workspaces (id, name) VALUES (${sqlString(postBackupWorkspaceId)}, ${sqlString(postBackupWorkspaceName)});
       SELECT setval('${sequence}', 900000, true);`,
    );
    await runFaultChild(image, scenario, fault, index);
    const committed = committedFaults.has(fault);
    if (committed) await rename(backup.path, `${backup.path}.withheld`);
    await runRecoveryRunner(image, scenario, !committed);
    await assertRecovered(target, ledger, fault);
  } finally {
    await cleanupTarget(target);
  }
}

async function verify(): Promise<void> {
  await assertComposeDatabaseReady("postgres");
  const directory = await mkdtemp(path.join(tmpdir(), "schedule-desktop-migration-backup-"));
  let image: string | undefined;
  let failure: unknown;
  try {
    image = await buildRecoveryRunner(directory);
    for (const [index, fault] of faultPoints.entries()) {
      await verifyFault(image, directory, fault, index);
    }
  } catch (error) {
    failure = error;
  }
  const cleanup: Promise<unknown>[] = [];
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
