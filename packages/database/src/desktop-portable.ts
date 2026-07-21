import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { access, lstat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { Sql } from "postgres";

import { createDatabase } from "./database.js";
import {
  exportVerifiedPortableDatabase,
  type VerifiedPortableDatabaseExportOptions,
} from "./portable-export.js";

export const desktopPortableSuccessPrefix = "SCHEDULE_PORTABLE_EXPORT_V1 ";
const childOutputLimitBytes = 64 * 1024;
const childTimeoutMs = 120_000;
const staleVerificationAgeSeconds = 6 * 60 * 60;
const maximumStaleVerificationDatabases = 8;
const verificationDatabasePattern = /^schedule_verify_([0-9a-f]{8})_([0-9a-z]{8})_([0-9a-f]{16})$/;
const verificationDatabaseOwnershipMarkerPrefix =
  "schedule:desktop-portable-verification-database:v1:";

export interface DesktopPortableEnvironment {
  readonly databaseUrl: string;
  readonly adminDatabaseUrl: string;
  readonly nodeExecutable: string;
  readonly migrationEntrypoint: string;
  readonly applicationVersion: string;
}

export function parseDesktopPortableExport(args: readonly string[]): string {
  if (
    args.length !== 2 ||
    args[0] !== "export" ||
    !path.isAbsolute(args[1] ?? "") ||
    path.extname(args[1] ?? "") !== ".schedule"
  ) {
    throw new Error("invalid desktop portable export invocation");
  }
  return path.resolve(args[1]!);
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 32_768 ||
    value.includes("\0")
  ) {
    throw new Error("invalid desktop portable export environment");
  }
  return value;
}

function postgresUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("invalid desktop portable export environment");
  }
  return value;
}

export function readDesktopPortableEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): DesktopPortableEnvironment {
  const nodeExecutable = required(env, "SCHEDULE_NODE_EXECUTABLE");
  const migrationEntrypoint = required(env, "SCHEDULE_MIGRATION_ENTRYPOINT");
  if (!path.isAbsolute(nodeExecutable) || !path.isAbsolute(migrationEntrypoint)) {
    throw new Error("invalid desktop portable export environment");
  }
  return {
    databaseUrl: postgresUrl(required(env, "DATABASE_URL")),
    adminDatabaseUrl: postgresUrl(required(env, "SCHEDULE_ADMIN_DATABASE_URL")),
    nodeExecutable,
    migrationEntrypoint,
    applicationVersion: required(env, "SCHEDULE_APPLICATION_VERSION"),
  };
}

export function desktopMigrationInvocation(
  environment: DesktopPortableEnvironment,
  verificationDatabaseUrl: string,
): {
  readonly executable: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
} {
  return {
    executable: environment.nodeExecutable,
    // migrate.js accepts no migration-mode argument.
    args: [environment.migrationEntrypoint],
    env: {
      DATABASE_URL: verificationDatabaseUrl,
      DOTENV_CONFIG_QUIET: "true",
      DOTENV_CONFIG_DEBUG: "false",
    },
  };
}

/** Shell-free, bounded child execution. Child output is deliberately never surfaced. */
export async function runDesktopPortableChild(
  executable: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  timeoutMs = childTimeoutMs,
): Promise<void> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new Error("invalid child timeout");
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, [...args], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...env },
    });
    let outputBytes = 0;
    let failed = false;
    const fail = (): void => {
      failed = true;
      child.kill();
    };
    const consume = (chunk: Buffer): void => {
      outputBytes += chunk.length;
      if (outputBytes > childOutputLimitBytes) fail();
    };
    child.stdout?.on("data", consume);
    child.stderr?.on("data", consume);
    const timer = setTimeout(fail, timeoutMs);
    timer.unref?.();
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("desktop portable export failed"));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (!failed && code === 0) resolve();
      else reject(new Error("desktop portable export failed"));
    });
  });
}

export async function assertDesktopPortableExportTarget(destination: string): Promise<void> {
  if (!path.isAbsolute(destination) || path.extname(destination) !== ".schedule") {
    throw new Error("invalid desktop portable export destination");
  }
  const parent = path.dirname(destination);
  const parentEntry = await lstat(parent).catch(() => null);
  if (parentEntry === null || !parentEntry.isDirectory() || parentEntry.isSymbolicLink()) {
    throw new Error("invalid desktop portable export destination");
  }
  if ((await lstat(destination).catch(() => null)) !== null) {
    throw new Error("desktop portable export destination already exists");
  }
  await access(parent);
}

function quoteDatabaseName(databaseName: string): string {
  if (!verificationDatabasePattern.test(databaseName)) {
    throw new Error("desktop portable export failed");
  }
  return `"${databaseName}"`;
}

function databaseUrlFor(base: string, databaseName: string): string {
  quoteDatabaseName(databaseName);
  const url = new URL(base);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function assertPrivateEmbeddedCluster(sourceDatabaseUrl: string, adminDatabaseUrl: string): void {
  const source = new URL(sourceDatabaseUrl);
  const admin = new URL(adminDatabaseUrl);
  const loopback = new Set(["127.0.0.1", "localhost", "[::1]"]);
  const port = (url: URL): string => (url.port === "" ? "5432" : url.port);
  if (
    !loopback.has(source.hostname.toLowerCase()) ||
    source.hostname.toLowerCase() !== admin.hostname.toLowerCase() ||
    port(source) !== port(admin)
  ) {
    throw new Error("desktop portable export failed");
  }
}

export function desktopVerificationClusterToken(systemIdentifier: string): string {
  if (!/^\d{10,30}$/.test(systemIdentifier)) throw new Error("desktop portable export failed");
  return createHash("sha256").update(systemIdentifier, "utf8").digest("hex").slice(0, 8);
}

export function desktopVerificationDatabaseName(
  clusterToken: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): string {
  if (!/^[0-9a-f]{8}$/.test(clusterToken) || !Number.isSafeInteger(nowSeconds) || nowSeconds < 0) {
    throw new Error("desktop portable export failed");
  }
  const timestamp = nowSeconds.toString(36).padStart(8, "0");
  if (timestamp.length !== 8) throw new Error("desktop portable export failed");
  const nonce = randomBytes(8).toString("hex");
  return `schedule_verify_${clusterToken}_${timestamp}_${nonce}`;
}

export function desktopVerificationDatabaseOwnershipMarker(
  systemIdentifier: string,
  databaseName: string,
): string {
  const expectedClusterToken = desktopVerificationClusterToken(systemIdentifier);
  const match = verificationDatabasePattern.exec(databaseName);
  if (match?.[1] !== expectedClusterToken) throw new Error("desktop portable export failed");
  return `${verificationDatabaseOwnershipMarkerPrefix}${systemIdentifier}:${databaseName}`;
}

export interface DesktopVerificationDatabaseIdentity {
  readonly databaseOid: string;
  readonly databaseName: string;
  readonly ownershipMarker: string | null;
  readonly databaseOwner: string;
  readonly currentAdmin: string;
  readonly systemIdentifier: string;
  readonly isTemplate: boolean;
}

export type DesktopVerificationDatabaseMarkerRequirement =
  "exact" | "null" | "exact-or-null-for-same-run";

function isAcceptedDesktopVerificationDatabaseIdentity(
  identity: DesktopVerificationDatabaseIdentity,
  systemIdentifier: string,
  expectedOwner: string,
  markerRequirement: DesktopVerificationDatabaseMarkerRequirement,
): boolean {
  const databaseOid = Number(identity.databaseOid);
  if (
    !Number.isSafeInteger(databaseOid) ||
    databaseOid < 1 ||
    databaseOid > 4_294_967_295 ||
    String(databaseOid) !== identity.databaseOid ||
    identity.isTemplate ||
    identity.databaseOwner !== expectedOwner ||
    identity.currentAdmin !== expectedOwner ||
    identity.systemIdentifier !== systemIdentifier
  ) {
    return false;
  }
  try {
    const expectedMarker = desktopVerificationDatabaseOwnershipMarker(
      systemIdentifier,
      identity.databaseName,
    );
    if (markerRequirement === "null") return identity.ownershipMarker === null;
    if (markerRequirement === "exact-or-null-for-same-run") {
      return identity.ownershipMarker === null || identity.ownershipMarker === expectedMarker;
    }
    return identity.ownershipMarker === expectedMarker;
  } catch {
    return false;
  }
}

export interface DesktopVerificationDatabaseCreationOperations {
  readonly createCandidate: (databaseName: string) => Promise<void>;
  readonly readCandidate: (
    databaseName: string,
  ) => Promise<DesktopVerificationDatabaseIdentity | undefined>;
  readonly markCandidate: (databaseName: string, ownershipMarker: string) => Promise<void>;
}

export async function createGuardedDesktopVerificationDatabase(
  databaseName: string,
  systemIdentifier: string,
  expectedOwner: string,
  onCaptured: (
    identity: Pick<DesktopVerificationDatabaseIdentity, "databaseOid" | "databaseName">,
  ) => void,
  operations: DesktopVerificationDatabaseCreationOperations,
): Promise<Pick<DesktopVerificationDatabaseIdentity, "databaseOid" | "databaseName">> {
  await operations.createCandidate(databaseName);
  // CREATE DATABASE cannot return an OID or run transactionally with this catalog read. If this
  // immediate read fails, there is no safe object identity to register and the allocation may leak.
  const baseIdentity = await operations.readCandidate(databaseName);
  if (
    baseIdentity === undefined ||
    !isAcceptedDesktopVerificationDatabaseIdentity(
      baseIdentity,
      systemIdentifier,
      expectedOwner,
      "null",
    )
  ) {
    throw new Error("desktop portable export failed");
  }
  const captured = {
    databaseOid: baseIdentity.databaseOid,
    databaseName: baseIdentity.databaseName,
  };
  onCaptured(captured);
  const ownershipMarker = desktopVerificationDatabaseOwnershipMarker(
    systemIdentifier,
    databaseName,
  );
  await operations.markCandidate(databaseName, ownershipMarker);
  const markedIdentity = await operations.readCandidate(databaseName);
  if (
    markedIdentity === undefined ||
    markedIdentity.databaseOid !== captured.databaseOid ||
    markedIdentity.databaseName !== captured.databaseName ||
    !isAcceptedDesktopVerificationDatabaseIdentity(
      markedIdentity,
      systemIdentifier,
      expectedOwner,
      "exact",
    )
  ) {
    throw new Error("desktop portable export failed");
  }
  return captured;
}

async function readDesktopVerificationDatabaseIdentity(
  sql: Sql,
  databaseName: string,
): Promise<DesktopVerificationDatabaseIdentity | undefined> {
  quoteDatabaseName(databaseName);
  const [row] = await sql<DesktopVerificationDatabaseIdentity[]>`
    select database.oid::text as "databaseOid",
      database.datname as "databaseName",
      pg_catalog.shobj_description(database.oid, 'pg_database') as "ownershipMarker",
      pg_catalog.pg_get_userbyid(database.datdba) as "databaseOwner",
      current_user::text as "currentAdmin",
      control.system_identifier::text as "systemIdentifier",
      database.datistemplate as "isTemplate"
    from pg_catalog.pg_database as database
    cross join pg_catalog.pg_control_system() as control
    where database.datname = ${databaseName}
  `;
  return row;
}

function selectStaleDesktopVerificationDatabaseIdentities(
  identities: readonly DesktopVerificationDatabaseIdentity[],
  systemIdentifier: string,
  expectedOwner: string,
  nowSeconds: number,
  maximum = maximumStaleVerificationDatabases,
): readonly DesktopVerificationDatabaseIdentity[] {
  const clusterToken = desktopVerificationClusterToken(systemIdentifier);
  if (
    expectedOwner.length === 0 ||
    !Number.isSafeInteger(nowSeconds) ||
    nowSeconds < 0 ||
    !Number.isSafeInteger(maximum) ||
    maximum < 1 ||
    maximum > maximumStaleVerificationDatabases
  ) {
    throw new Error("desktop portable export failed");
  }
  const selected = identities.flatMap((identity) => {
    if (
      !isAcceptedDesktopVerificationDatabaseIdentity(
        identity,
        systemIdentifier,
        expectedOwner,
        "exact",
      )
    ) {
      return [];
    }
    const match = verificationDatabasePattern.exec(identity.databaseName);
    if (match?.[1] !== clusterToken || match[2] === undefined) return [];
    const createdAt = Number.parseInt(match[2], 36);
    return Number.isSafeInteger(createdAt) && createdAt <= nowSeconds - staleVerificationAgeSeconds
      ? [{ identity, createdAt }]
      : [];
  });
  selected.sort(
    (left, right) =>
      left.createdAt - right.createdAt ||
      left.identity.databaseName.localeCompare(right.identity.databaseName),
  );
  return selected.slice(0, maximum).map(({ identity }) => identity);
}

export function selectStaleDesktopVerificationDatabases(
  identities: readonly DesktopVerificationDatabaseIdentity[],
  systemIdentifier: string,
  expectedOwner: string,
  nowSeconds: number,
  maximum = maximumStaleVerificationDatabases,
): readonly string[] {
  return selectStaleDesktopVerificationDatabaseIdentities(
    identities,
    systemIdentifier,
    expectedOwner,
    nowSeconds,
    maximum,
  ).map(({ databaseName }) => databaseName);
}

export interface DesktopVerificationDatabaseDropOperations {
  readonly revalidateCandidate: (
    databaseName: string,
  ) => Promise<DesktopVerificationDatabaseIdentity | undefined>;
  readonly terminateCandidateConnections: (
    identity: Pick<DesktopVerificationDatabaseIdentity, "databaseOid" | "databaseName">,
  ) => Promise<void>;
  readonly dropCandidate: (databaseName: string) => Promise<void>;
}

export interface DesktopVerificationReclamationOperations extends DesktopVerificationDatabaseDropOperations {
  readonly listCandidates: () => Promise<readonly DesktopVerificationDatabaseIdentity[]>;
}

export async function dropGuardedDesktopVerificationDatabase(
  expectedIdentity: Pick<DesktopVerificationDatabaseIdentity, "databaseOid" | "databaseName">,
  systemIdentifier: string,
  expectedOwner: string,
  markerRequirement: Extract<
    DesktopVerificationDatabaseMarkerRequirement,
    "exact" | "exact-or-null-for-same-run"
  >,
  operations: DesktopVerificationDatabaseDropOperations,
): Promise<boolean> {
  const isExpectedIdentity = (
    identity: DesktopVerificationDatabaseIdentity | undefined,
  ): identity is DesktopVerificationDatabaseIdentity =>
    identity !== undefined &&
    identity.databaseOid === expectedIdentity.databaseOid &&
    identity.databaseName === expectedIdentity.databaseName &&
    isAcceptedDesktopVerificationDatabaseIdentity(
      identity,
      systemIdentifier,
      expectedOwner,
      markerRequirement,
    );

  if (!isExpectedIdentity(await operations.revalidateCandidate(expectedIdentity.databaseName))) {
    return false;
  }
  await operations.terminateCandidateConnections(expectedIdentity);
  if (!isExpectedIdentity(await operations.revalidateCandidate(expectedIdentity.databaseName))) {
    return false;
  }
  // PostgreSQL DROP DATABASE is name-only and cannot be transactionally conditioned on an OID.
  // These adjacent checks narrow, but cannot eliminate, a noncooperating-superuser name swap.
  await operations.dropCandidate(expectedIdentity.databaseName);
  return true;
}

export async function reclaimStaleDesktopVerificationDatabases(
  systemIdentifier: string,
  expectedOwner: string,
  nowSeconds: number,
  operations: DesktopVerificationReclamationOperations,
): Promise<readonly string[]> {
  const selected = selectStaleDesktopVerificationDatabaseIdentities(
    await operations.listCandidates(),
    systemIdentifier,
    expectedOwner,
    nowSeconds,
  );
  const reclaimed: string[] = [];
  for (const identity of selected) {
    if (
      await dropGuardedDesktopVerificationDatabase(
        identity,
        systemIdentifier,
        expectedOwner,
        "exact",
        operations,
      )
    ) {
      reclaimed.push(identity.databaseName);
    }
  }
  return reclaimed;
}

async function prepareDesktopDatabaseLifecycle(
  sourceDatabaseUrl: string,
  adminDatabaseUrl: string,
): Promise<
  Pick<
    VerifiedPortableDatabaseExportOptions,
    | "createVerificationDatabase"
    | "dropVerificationDatabase"
    | "verificationDatabaseUrl"
    | "verificationDatabaseName"
  >
> {
  assertPrivateEmbeddedCluster(sourceDatabaseUrl, adminDatabaseUrl);
  let ownedDatabase:
    Pick<DesktopVerificationDatabaseIdentity, "databaseOid" | "databaseName"> | undefined;
  const admin = createDatabase(adminDatabaseUrl, 1, {
    idleTimeoutSeconds: 0,
    statementTimeoutMs: 30_000,
    suppressNotices: true,
    applicationName: "schedule-portable-verification-reclamation",
  });
  let systemIdentifier: string;
  let adminName: string;
  try {
    const [control] = await admin.sql<{ systemIdentifier: string; adminName: string }[]>`
      select system_identifier::text as "systemIdentifier", current_user::text as "adminName"
      from pg_catalog.pg_control_system()
    `;
    if (control === undefined) throw new Error("desktop portable export failed");
    systemIdentifier = control.systemIdentifier;
    adminName = control.adminName;
    const clusterToken = desktopVerificationClusterToken(systemIdentifier);
    const ownershipMarkerPrefix = `${verificationDatabaseOwnershipMarkerPrefix}${systemIdentifier}:`;
    const nowSeconds = Math.floor(Date.now() / 1000);
    const readCandidate = (databaseName: string) =>
      readDesktopVerificationDatabaseIdentity(admin.sql, databaseName);
    await reclaimStaleDesktopVerificationDatabases(systemIdentifier, adminName, nowSeconds, {
      listCandidates: async () => {
        const rows = await admin.sql<DesktopVerificationDatabaseIdentity[]>`
          select database.oid::text as "databaseOid",
            database.datname as "databaseName",
            pg_catalog.shobj_description(database.oid, 'pg_database') as "ownershipMarker",
            pg_catalog.pg_get_userbyid(database.datdba) as "databaseOwner",
            current_user::text as "currentAdmin",
            control.system_identifier::text as "systemIdentifier",
            database.datistemplate as "isTemplate"
          from pg_catalog.pg_database as database
          cross join pg_catalog.pg_control_system() as control
          where database.datname like ${`schedule_verify_${clusterToken}_%`}
            and database.datname ~ ${`^schedule_verify_${clusterToken}_[0-9a-z]{8}_[0-9a-f]{16}$`}
            and not database.datistemplate
            and pg_catalog.pg_get_userbyid(database.datdba) = ${adminName}
            and current_user::text = ${adminName}
            and control.system_identifier::text = ${systemIdentifier}
            and pg_catalog.shobj_description(database.oid, 'pg_database') =
              ${ownershipMarkerPrefix} || database.datname
          order by database.datname
          limit ${maximumStaleVerificationDatabases + 1}
        `;
        return rows;
      },
      revalidateCandidate: readCandidate,
      terminateCandidateConnections: async ({ databaseName, databaseOid }) => {
        quoteDatabaseName(databaseName);
        await admin.sql`
          select pg_catalog.pg_terminate_backend(pid) from pg_catalog.pg_stat_activity
          where datid = ${databaseOid}::pg_catalog.oid and datname = ${databaseName}
            and pid <> pg_catalog.pg_backend_pid()
        `;
      },
      dropCandidate: async (databaseName) => {
        await admin.sql.unsafe(`DROP DATABASE ${quoteDatabaseName(databaseName)}`);
      },
    });
  } finally {
    await admin.close();
  }
  return {
    verificationDatabaseName: () =>
      desktopVerificationDatabaseName(desktopVerificationClusterToken(systemIdentifier)),
    verificationDatabaseUrl: (databaseName) => databaseUrlFor(adminDatabaseUrl, databaseName),
    createVerificationDatabase: async (databaseName, _databaseUrl, onCreated) => {
      const connection = createDatabase(adminDatabaseUrl, 1, {
        idleTimeoutSeconds: 0,
        statementTimeoutMs: 30_000,
        suppressNotices: true,
        applicationName: "schedule-portable-verification-admin",
      });
      try {
        await createGuardedDesktopVerificationDatabase(
          databaseName,
          systemIdentifier,
          adminName,
          (captured) => {
            ownedDatabase = captured;
            onCreated();
          },
          {
            createCandidate: async (name) => {
              await connection.sql.unsafe(`CREATE DATABASE ${quoteDatabaseName(name)}`);
            },
            readCandidate: (name) => readDesktopVerificationDatabaseIdentity(connection.sql, name),
            markCandidate: async (name, ownershipMarker) => {
              await connection.sql.unsafe(
                `COMMENT ON DATABASE ${quoteDatabaseName(name)} IS '${ownershipMarker}'`,
              );
            },
          },
        );
      } finally {
        await connection.close();
      }
    },
    dropVerificationDatabase: async (databaseName) => {
      if (ownedDatabase?.databaseName !== databaseName) {
        throw new Error("desktop portable export failed");
      }
      const connection = createDatabase(adminDatabaseUrl, 1, {
        idleTimeoutSeconds: 0,
        statementTimeoutMs: 30_000,
        suppressNotices: true,
        applicationName: "schedule-portable-verification-cleanup",
      });
      try {
        const dropped = await dropGuardedDesktopVerificationDatabase(
          { databaseName, databaseOid: ownedDatabase.databaseOid },
          systemIdentifier,
          adminName,
          "exact-or-null-for-same-run",
          {
            revalidateCandidate: (name) =>
              readDesktopVerificationDatabaseIdentity(connection.sql, name),
            terminateCandidateConnections: async ({ databaseName: name, databaseOid }) => {
              await connection.sql`
                select pg_catalog.pg_terminate_backend(pid) from pg_catalog.pg_stat_activity
                where datid = ${databaseOid}::pg_catalog.oid and datname = ${name}
                  and pid <> pg_catalog.pg_backend_pid()
              `;
            },
            dropCandidate: async (name) => {
              await connection.sql.unsafe(`DROP DATABASE ${quoteDatabaseName(name)}`);
            },
          },
        );
        if (!dropped) throw new Error("desktop portable export failed");
        ownedDatabase = undefined;
      } finally {
        await connection.close();
      }
    },
  };
}

export interface DesktopPortableDependencies {
  readonly exportDatabase?: typeof exportVerifiedPortableDatabase;
  readonly runChild?: typeof runDesktopPortableChild;
  readonly prepareLifecycle?: typeof prepareDesktopDatabaseLifecycle;
}

export async function exportDesktopPortableScheduleData(
  destination: string,
  environment: DesktopPortableEnvironment = readDesktopPortableEnvironment(),
  dependencies: DesktopPortableDependencies = {},
): Promise<{ readonly sizeBytes: number }> {
  await assertDesktopPortableExportTarget(destination);
  const lifecycle = await (dependencies.prepareLifecycle ?? prepareDesktopDatabaseLifecycle)(
    environment.databaseUrl,
    environment.adminDatabaseUrl,
  );
  const runChild = dependencies.runChild ?? runDesktopPortableChild;
  const result = await (dependencies.exportDatabase ?? exportVerifiedPortableDatabase)({
    outputPath: destination,
    sourceDatabaseUrl: environment.databaseUrl,
    migrationsFolder: path.resolve(path.dirname(environment.migrationEntrypoint), "../drizzle"),
    applicationVersion: environment.applicationVersion,
    ...lifecycle,
    migrateVerificationDatabase: async (_databaseName, databaseUrl) => {
      const invocation = desktopMigrationInvocation(environment, databaseUrl);
      await runChild(invocation.executable, invocation.args, invocation.env);
    },
  });
  return { sizeBytes: result.sizeBytes };
}

export interface DesktopPortableCliIo {
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
  readonly exportSchedule?: typeof exportDesktopPortableScheduleData;
}

export async function runDesktopPortableCli(
  args: readonly string[] = process.argv.slice(2),
  environment: NodeJS.ProcessEnv = process.env,
  io: DesktopPortableCliIo = {
    stdout: (value) => process.stdout.write(value),
    stderr: (value) => process.stderr.write(value),
  },
): Promise<boolean> {
  try {
    const destination = parseDesktopPortableExport(args);
    const result = await (io.exportSchedule ?? exportDesktopPortableScheduleData)(
      destination,
      readDesktopPortableEnvironment(environment),
    );
    io.stdout(
      `${desktopPortableSuccessPrefix}${JSON.stringify({ sizeBytes: result.sizeBytes })}\n`,
    );
    return true;
  } catch {
    io.stderr("Schedule portable export failed.\n");
    return false;
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  if (!(await runDesktopPortableCli())) process.exitCode = 1;
}
