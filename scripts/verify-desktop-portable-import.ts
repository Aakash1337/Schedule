import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { access, chmod, lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import {
  importDesktopPortableScheduleData,
  recoverDesktopPortableImport,
  runDesktopPortableChild,
  type DesktopPortableImportEnvironment,
} from "../packages/database/src/desktop-portable.js";
import { createDatabase } from "../packages/database/src/database.js";
import { withPreparedPortableArchive } from "../packages/database/src/portable-archive.js";
import {
  assertComposeDatabaseReady,
  composeDatabaseUser,
  repositoryRoot,
} from "./backup-database.js";
import { exportPortableScheduleData } from "./portable-database.js";
import {
  cleanupDisposableRecoveryDatabase,
  createDisposableRecoveryPlan,
  databaseExists,
  initializeDisposableRecoveryActiveDatabase,
  quoteIdentifier,
  runPsql,
} from "./restore-database.js";

const crashExitCode = 97;
const childTimeoutMs = 120_000;
const childStderrLimitBytes = 4 * 1024;
const sourceWorkspaceId = "10000000-0000-0000-0000-000000000101";
const destinationWorkspaceId = "10000000-0000-0000-0000-000000000102";
const sourceWorkspaceName = "desktop portable source";
const destinationWorkspaceName = "desktop portable destination";
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

interface ChildConfiguration {
  readonly archivePath: string;
  readonly environment: DesktopPortableImportEnvironment;
  readonly progressPath: string;
}

interface Target {
  readonly databaseName: string;
  readonly ownerRole: string;
  readonly runtimeRole: string;
  readonly runtimeDatabaseUrl: string;
  readonly environment: DesktopPortableImportEnvironment;
}

function postgresUrl(user: string, password: string, database: string): string {
  return `postgres://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:5432/${database}`;
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

function parseFault(value: string | undefined): FaultPoint {
  if (faultPoints.includes(value as FaultPoint)) return value as FaultPoint;
  throw new Error("invalid desktop portable verifier fault");
}

async function writeChildConfiguration(
  directory: string,
  target: Target,
  archivePath: string,
): Promise<string> {
  const configurationPath = path.join(directory, `child-${randomUUID().replaceAll("-", "")}.json`);
  const progressPath = `${configurationPath}.progress`;
  await writeFile(
    configurationPath,
    `${JSON.stringify({ archivePath, environment: target.environment, progressPath })}\n`,
    { encoding: "utf8", mode: 0o600, flag: "wx" },
  );
  return configurationPath;
}

async function readChildConfiguration(configurationPath: string): Promise<ChildConfiguration> {
  const metadata = await lstat(configurationPath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 16 * 1024) {
    throw new Error("invalid desktop portable verifier child configuration");
  }
  const value: unknown = JSON.parse(await readFile(configurationPath, "utf8"));
  if (
    typeof value !== "object" ||
    value === null ||
    typeof (value as { archivePath?: unknown }).archivePath !== "string" ||
    typeof (value as { progressPath?: unknown }).progressPath !== "string" ||
    typeof (value as { environment?: unknown }).environment !== "object" ||
    (value as { environment?: unknown }).environment === null
  ) {
    throw new Error("invalid desktop portable verifier child configuration");
  }
  return value as ChildConfiguration;
}

async function runFaultChild(configurationPath: string, fault: FaultPoint): Promise<void> {
  const cli = path.join(repositoryRoot, "node_modules", "tsx", "dist", "cli.mjs");
  const script = path.resolve(process.argv[1] ?? "");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [cli, script, "--child", configurationPath, fault], {
      cwd: repositoryRoot,
      shell: false,
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, NODE_ENV: "production" },
    });
    let stderrBytes = 0;
    let timedOut = false;
    child.stderr?.on("data", (chunk: Buffer) => {
      stderrBytes = Math.min(childStderrLimitBytes, stderrBytes + chunk.length);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, childTimeoutMs);
    timer.unref?.();
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", async (code, signal) => {
      clearTimeout(timer);
      if (code === crashExitCode && signal === null) resolve();
      else if (timedOut) {
        const progress = await readFile(`${configurationPath}.progress`, "utf8").catch(
          () => "unstarted\n",
        );
        const stage = progress === "before-import\n" ? "import" : "startup";
        reject(
          new Error(
            `desktop portable verifier child timed out during ${stage} at ${fault} (${stderrBytes === 0 ? "no diagnostic" : "bounded diagnostic captured"})`,
          ),
        );
      } else
        reject(
          new Error(
            `desktop portable verifier child did not crash at ${fault} (${stderrBytes === 0 ? "no diagnostic" : "bounded diagnostic captured"})`,
          ),
        );
    });
  });
}

async function runChild(configurationPath: string, fault: FaultPoint): Promise<void> {
  const { archivePath, environment, progressPath } =
    await readChildConfiguration(configurationPath);
  await writeFile(progressPath, "before-import\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
  await importDesktopPortableScheduleData(archivePath, environment, {
    fault: async (point) => {
      if (point !== fault) return;
      await writeFile(progressPath, "fault-reached\n", { encoding: "utf8", mode: 0o600 });
      process.exit(crashExitCode);
    },
  });
  throw new Error("desktop portable verifier child did not reach its requested crash seam");
}

async function createTarget(
  directory: string,
  archive: Pick<ChildConfiguration, "archivePath"> & {
    readonly archiveId: string;
    readonly archiveSha256: string;
  },
): Promise<Target> {
  const nonce = randomUUID().replaceAll("-", "");
  const databaseName = generatedName("schedule_dpi_", nonce);
  const ownerRole = generatedName("schedule_dpi_owner_", nonce.slice(0, 16));
  const runtimeRole = generatedName("schedule_dpi_runtime_", nonce.slice(0, 16));
  const ownerPassword = randomBytes(24).toString("hex");
  const runtimePassword = randomBytes(24).toString("hex");
  const owner = quoteIdentifier(ownerRole);
  const runtime = quoteIdentifier(runtimeRole);
  const database = quoteIdentifier(databaseName);
  try {
    await runPsql(
      "postgres",
      `CREATE ROLE ${owner} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD ${sqlString(ownerPassword)};
       CREATE ROLE ${runtime} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD ${sqlString(runtimePassword)};`,
    );
    await runPsql(
      "postgres",
      `CREATE DATABASE ${database} OWNER ${owner} TEMPLATE template0 ENCODING 'UTF8';`,
    );
    await runPsql(
      "postgres",
      `REVOKE ALL ON DATABASE ${database} FROM PUBLIC;
       GRANT CONNECT ON DATABASE ${database} TO ${runtime};`,
    );
    await runPsql(
      databaseName,
      `REVOKE CREATE ON SCHEMA public FROM PUBLIC;
       GRANT USAGE, CREATE ON SCHEMA public TO ${owner};
       GRANT USAGE ON SCHEMA public TO ${runtime};
       GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${runtime};
       GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${runtime};
       ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${runtime};
       ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${runtime};`,
    );
    const environment: DesktopPortableImportEnvironment = {
      databaseUrl: postgresUrl(ownerRole, ownerPassword, databaseName),
      adminDatabaseUrl: postgresUrl(composeDatabaseUser, composeDatabaseUser, "postgres"),
      nodeExecutable: process.execPath,
      migrationEntrypoint: path.join(repositoryRoot, "packages", "database", "dist", "migrate.js"),
      applicationVersion: "0.1.0",
      databaseName,
      clusterAdminRole: composeDatabaseUser,
      ownerRole,
      runtimeRole,
      importJournalPath: path.join(directory, "import-journal.json"),
      expectedArchiveId: archive.archiveId,
      expectedArchiveSha256: archive.archiveSha256,
    };
    await runDesktopPortableChild(environment.nodeExecutable, [environment.migrationEntrypoint], {
      DATABASE_URL: environment.databaseUrl,
      DOTENV_CONFIG_QUIET: "true",
      DOTENV_CONFIG_DEBUG: "false",
    });
    await runPsql(
      databaseName,
      `INSERT INTO public.workspaces (id, name) VALUES (${sqlString(destinationWorkspaceId)}, ${sqlString(destinationWorkspaceName)});`,
    );
    return {
      databaseName,
      ownerRole,
      runtimeRole,
      runtimeDatabaseUrl: postgresUrl(runtimeRole, runtimePassword, databaseName),
      environment,
    };
  } catch (error) {
    await cleanupTarget({ databaseName, ownerRole, runtimeRole });
    throw error;
  }
}

async function ownedImportDatabases(target: Target): Promise<readonly string[]> {
  const rows = await runPsql(
    "postgres",
    `SELECT datname FROM pg_catalog.pg_database WHERE pg_catalog.pg_get_userbyid(datdba) = ${sqlString(target.ownerRole)}
     AND (datname = ${sqlString(target.databaseName)} OR datname ~ '^schedule_(restore|previous)_[0-9a-f]{32}$') ORDER BY datname;`,
    { quiet: true },
  );
  return rows.trim().split(/\r?\n/).filter(Boolean);
}

async function cleanupTarget(
  target: Pick<Target, "databaseName" | "ownerRole" | "runtimeRole">,
): Promise<void> {
  const names = await ownedImportDatabases(target as Target).catch(() => [target.databaseName]);
  for (const name of names) {
    quoteIdentifier(name);
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

async function assertRecovered(target: Target, fault: FaultPoint): Promise<void> {
  const committed = [
    "after-operation:promote-staging",
    "after-operation:enable-active",
    "committed",
  ].includes(fault);
  const recovery = await recoverDesktopPortableImport(target.environment);
  assert.equal(recovery.committed, committed, `unexpected recovery outcome at ${fault}`);
  assert.equal(recovery.previousRetained, committed, `unexpected retention outcome at ${fault}`);
  await assert.rejects(access(target.environment.importJournalPath));
  const activeRows = (
    await runPsql(
      target.databaseName,
      `SELECT id::text || '|' || name FROM public.workspaces WHERE id IN (${sqlString(sourceWorkspaceId)}, ${sqlString(destinationWorkspaceId)}) ORDER BY id;`,
      { quiet: true },
    )
  )
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  assert.deepEqual(
    activeRows,
    committed
      ? [`${sourceWorkspaceId}|${sourceWorkspaceName}`]
      : [`${destinationWorkspaceId}|${destinationWorkspaceName}`],
  );
  const runtime = createDatabase(target.runtimeDatabaseUrl, 1, {
    idleTimeoutSeconds: 0,
    statementTimeoutMs: 10_000,
    suppressNotices: true,
    applicationName: "schedule-desktop-portable-runtime-verification",
  });
  try {
    const [visible] = await runtime.sql<{ count: number }[]>`
      SELECT count(*)::integer AS count FROM public.workspaces
    `;
    assert.ok(
      (visible?.count ?? 0) > 0,
      `runtime role could not read imported data after ${fault}`,
    );
  } finally {
    await runtime.close();
  }
  const databases = await ownedImportDatabases(target);
  const retained = databases.filter((name) => name.startsWith("schedule_previous_"));
  const staging = databases.filter((name) => name.startsWith("schedule_restore_"));
  assert.equal(staging.length, 0, `staging database remained after ${fault}`);
  assert.equal(retained.length, committed ? 1 : 0, `unexpected previous databases after ${fault}`);
  assert.ok(databases.includes(target.databaseName));
}

async function createArchive(directory: string): Promise<{
  readonly archivePath: string;
  readonly archiveId: string;
  readonly archiveSha256: string;
}> {
  const plan = createDisposableRecoveryPlan();
  const archivePath = path.join(directory, "desktop-portable.schedule");
  let primaryFailed = false;
  let cleanupFailure: unknown;
  let result:
    | { readonly archivePath: string; readonly archiveId: string; readonly archiveSha256: string }
    | undefined;
  const priorDatabaseUrl = process.env.DATABASE_URL;
  try {
    await initializeDisposableRecoveryActiveDatabase(plan);
    await runPsql(
      plan.activeDatabase,
      `INSERT INTO public.workspaces (id, name) VALUES (${sqlString(sourceWorkspaceId)}, ${sqlString(sourceWorkspaceName)});`,
    );
    process.env.DATABASE_URL = postgresUrl(
      composeDatabaseUser,
      composeDatabaseUser,
      plan.activeDatabase,
    );
    await exportPortableScheduleData(archivePath, plan.activeDatabase);
    result = await withPreparedPortableArchive(
      archivePath,
      async ({ manifest, archiveSha256 }) => ({
        archivePath,
        archiveId: manifest.archiveId,
        archiveSha256,
      }),
    );
  } catch (error) {
    primaryFailed = true;
    throw error;
  } finally {
    if (priorDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = priorDatabaseUrl;
    try {
      if (await databaseExists(plan.activeDatabase))
        await cleanupDisposableRecoveryDatabase(plan, "active");
    } catch (cleanupError) {
      if (!primaryFailed) cleanupFailure = cleanupError;
    }
  }
  if (cleanupFailure !== undefined) throw cleanupFailure;
  if (result === undefined) throw new Error("desktop portable verifier archive was not created");
  return result;
}

async function verify(): Promise<void> {
  await assertComposeDatabaseReady("postgres");
  const directory = await mkdtemp(path.join(tmpdir(), "schedule-desktop-portable-verify-"));
  let failure: unknown;
  try {
    await chmod(directory, 0o700);
    const archive = await createArchive(directory);
    for (const fault of faultPoints) {
      const target = await createTarget(directory, archive);
      try {
        const configuration = await writeChildConfiguration(directory, target, archive.archivePath);
        await runFaultChild(configuration, fault);
        await assertRecovered(target, fault);
      } finally {
        await cleanupTarget(target);
      }
    }
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    await rm(directory, { recursive: true, force: true }).catch((cleanupError) => {
      if (failure === undefined) throw cleanupError;
    });
  }
}

const args = process.argv.slice(2);
if (args[0] === "--child") {
  if (args.length !== 3 || args[1] === undefined || args[2] === undefined) {
    throw new Error("invalid desktop portable verifier child arguments");
  }
  await runChild(path.resolve(args[1]), parseFault(args[2]));
} else {
  if (args.length !== 0) throw new Error("Usage: pnpm verify:desktop-portable-import");
  await verify();
  console.log("Desktop portable import crash-recovery verification passed.");
}
