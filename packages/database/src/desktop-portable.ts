import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  access,
  link,
  lstat,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type { Sql } from "postgres";

import { createDatabase } from "./database.js";
import {
  exportVerifiedPortableDatabase,
  normalizeAndVerifyPortableDatabase,
  portableDatabaseSchemaSignal,
  readPortableColumnCatalog,
  readPortableDatabaseSignals,
  readPortableMigrationIdentity,
  restorePortablePayload,
  type VerifiedPortableDatabaseExportOptions,
} from "./portable-export.js";
import { portableDataPolicyV1 } from "./portable-data.js";
import { importPortableScheduleData, runJournaledPortablePromotion } from "./portable-import.js";
import { withPreparedPortableArchive } from "./portable-archive.js";

export const desktopPortableSuccessPrefix = "SCHEDULE_PORTABLE_EXPORT_V1 ";
export const desktopPortableInspectSuccessPrefix = "SCHEDULE_PORTABLE_INSPECT_V1 ";
export const desktopPortableImportSuccessPrefix = "SCHEDULE_PORTABLE_IMPORT_V1 ";
export const desktopPortableRecoverySuccessPrefix = "SCHEDULE_PORTABLE_RECOVERY_V1 ";
const childOutputLimitBytes = 64 * 1024;
const childTimeoutMs = 120_000;
const staleVerificationAgeSeconds = 6 * 60 * 60;
const maximumStaleVerificationDatabases = 8;
const verificationDatabasePattern = /^schedule_verify_([0-9a-f]{8})_([0-9a-z]{8})_([0-9a-f]{16})$/;
const verificationDatabaseOwnershipMarkerPrefix =
  "schedule:desktop-portable-verification-database:v1:";

export interface DesktopPortableExportEnvironment {
  readonly databaseUrl: string;
  readonly adminDatabaseUrl: string;
  readonly nodeExecutable: string;
  readonly migrationEntrypoint: string;
  readonly applicationVersion: string;
}

export interface DesktopPortableEnvironment extends DesktopPortableExportEnvironment {
  readonly databaseName: string;
  readonly clusterAdminRole: string;
  readonly ownerRole: string;
  readonly runtimeRole: string;
}

export interface DesktopPortableRecoveryEnvironment extends DesktopPortableEnvironment {
  readonly importJournalPath: string;
}

export interface DesktopPortableImportEnvironment extends DesktopPortableRecoveryEnvironment {
  readonly expectedArchiveId: string;
  readonly expectedArchiveSha256: string;
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

export type DesktopPortableCommand =
  | { readonly kind: "export"; readonly destination: string }
  | { readonly kind: "inspect"; readonly source: string }
  | { readonly kind: "import"; readonly source: string }
  | { readonly kind: "recover" };

function parseDesktopPortableSource(args: readonly string[], kind: "inspect" | "import"): string {
  if (
    args.length !== 2 ||
    args[0] !== kind ||
    !path.isAbsolute(args[1] ?? "") ||
    path.extname(args[1] ?? "") !== ".schedule"
  ) {
    throw new Error("invalid desktop portable import invocation");
  }
  return path.resolve(args[1]!);
}

export function parseDesktopPortableCommand(args: readonly string[]): DesktopPortableCommand {
  if (args[0] === "export")
    return { kind: "export", destination: parseDesktopPortableExport(args) };
  if (args[0] === "inspect")
    return { kind: "inspect", source: parseDesktopPortableSource(args, "inspect") };
  if (args.length === 1 && args[0] === "recover") return { kind: "recover" };
  return { kind: "import", source: parseDesktopPortableSource(args, "import") };
}

/** Reject links and noncanonical locations before the archive snapshotter opens the source. */
export async function assertDesktopPortableImportSource(source: string): Promise<string> {
  if (!path.isAbsolute(source) || path.extname(source) !== ".schedule") {
    throw new Error("invalid desktop portable import source");
  }
  const resolved = path.resolve(source);
  const entry = await lstat(resolved).catch(() => null);
  if (entry === null || !entry.isFile() || entry.isSymbolicLink()) {
    throw new Error("invalid desktop portable import source");
  }
  const canonical = await realpath(resolved).catch(() => null);
  if (canonical === null || path.resolve(canonical) !== resolved) {
    throw new Error("invalid desktop portable import source");
  }
  return resolved;
}

export interface DesktopPortableArchiveInspection {
  readonly archiveId: string;
  readonly archiveSha256: string;
  readonly exportedAt: string;
  readonly applicationVersion: string;
  readonly schemaVersion: number;
  readonly sizeBytes: number;
}

export async function inspectDesktopPortableScheduleData(
  source: string,
): Promise<DesktopPortableArchiveInspection> {
  const admittedSource = await assertDesktopPortableImportSource(source);
  return withPreparedPortableArchive(
    admittedSource,
    async ({ manifest, sizeBytes, archiveSha256 }) => ({
      archiveId: manifest.archiveId,
      archiveSha256,
      exportedAt: manifest.createdAt,
      applicationVersion: manifest.producer.applicationVersion,
      schemaVersion: manifest.compatibility.migrationCount,
      sizeBytes,
    }),
  );
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

function postgresIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) {
    throw new Error("invalid desktop portable import environment");
  }
  return `"${value}"`;
}

function postgresCommentLiteral(value: string | null): string {
  if (value === null) return "NULL";
  if (!/^[a-z0-9:_-]{1,1024}$/.test(value)) {
    throw new Error("invalid desktop portable import marker");
  }
  return `'${value}'`;
}

export function readDesktopPortableEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): DesktopPortableEnvironment {
  const nodeExecutable = required(env, "SCHEDULE_NODE_EXECUTABLE");
  const migrationEntrypoint = required(env, "SCHEDULE_MIGRATION_ENTRYPOINT");
  if (!path.isAbsolute(nodeExecutable) || !path.isAbsolute(migrationEntrypoint)) {
    throw new Error("invalid desktop portable export environment");
  }
  const databaseName = required(env, "SCHEDULE_DATABASE_NAME");
  const clusterAdminRole = required(env, "SCHEDULE_CLUSTER_ADMIN_ROLE");
  const ownerRole = required(env, "SCHEDULE_OWNER_ROLE");
  const runtimeRole = required(env, "SCHEDULE_RUNTIME_ROLE");
  if (new Set([clusterAdminRole, ownerRole, runtimeRole]).size !== 3) {
    throw new Error("invalid desktop portable import environment");
  }
  for (const identifier of [databaseName, clusterAdminRole, ownerRole, runtimeRole]) {
    postgresIdentifier(identifier);
  }
  return {
    databaseUrl: postgresUrl(required(env, "DATABASE_URL")),
    adminDatabaseUrl: postgresUrl(required(env, "SCHEDULE_ADMIN_DATABASE_URL")),
    nodeExecutable,
    migrationEntrypoint,
    applicationVersion: required(env, "SCHEDULE_APPLICATION_VERSION"),
    databaseName,
    clusterAdminRole,
    ownerRole,
    runtimeRole,
  };
}

function portableJournalPath(env: NodeJS.ProcessEnv): string {
  const journalPath = required(env, "SCHEDULE_PORTABLE_IMPORT_JOURNAL");
  if (!path.isAbsolute(journalPath)) throw new Error("invalid desktop portable import environment");
  return path.resolve(journalPath);
}

export function readDesktopPortableRecoveryEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): DesktopPortableRecoveryEnvironment {
  return { ...readDesktopPortableEnvironment(env), importJournalPath: portableJournalPath(env) };
}

export function readDesktopPortableImportEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): DesktopPortableImportEnvironment {
  const expectedArchiveId = required(env, "SCHEDULE_EXPECTED_ARCHIVE_ID");
  const expectedArchiveSha256 = required(env, "SCHEDULE_EXPECTED_ARCHIVE_SHA256");
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      expectedArchiveId,
    ) ||
    !/^[0-9a-f]{64}$/.test(expectedArchiveSha256)
  ) {
    throw new Error("invalid desktop portable import environment");
  }
  return {
    ...readDesktopPortableRecoveryEnvironment(env),
    expectedArchiveId,
    expectedArchiveSha256,
  };
}

export function desktopMigrationInvocation(
  environment: DesktopPortableExportEnvironment,
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
  environment: DesktopPortableExportEnvironment = readDesktopPortableEnvironment(),
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

function embeddedDatabaseUrl(base: string, databaseName: string): string {
  postgresIdentifier(databaseName);
  const url = new URL(base);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function generatedImportDatabaseName(prefix: "schedule_restore_" | "schedule_previous_"): string {
  return `${prefix}${randomBytes(16).toString("hex")}`;
}

const importDatabasePattern = /^schedule_(restore|previous)_([0-9a-f]{32})$/;
const importOwnershipMarkerPrefix = "schedule:desktop-portable-import-database:v1:";
const importJournalFormat = "schedule.desktop-portable-import-journal";
const importJournalTemporaryStaleMs = 24 * 60 * 60 * 1_000;
const importJournalTemporaryScavengeLimit = 16;
const portableArchiveIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type DesktopImportJournalPhase =
  | "allocating-staging"
  | "prepared"
  | "before-mark-previous"
  | "after-mark-previous"
  | "before-disable-active"
  | "after-disable-active"
  | "before-rename-active"
  | "after-rename-active"
  | "before-promote-staging"
  | "after-promote-staging"
  | "before-enable-active"
  | "after-enable-active"
  | "committed";

export const desktopImportJournalPhases: readonly DesktopImportJournalPhase[] = [
  "allocating-staging",
  "prepared",
  "before-mark-previous",
  "after-mark-previous",
  "before-disable-active",
  "after-disable-active",
  "before-rename-active",
  "after-rename-active",
  "before-promote-staging",
  "after-promote-staging",
  "before-enable-active",
  "after-enable-active",
  "committed",
];

export interface DesktopImportDatabaseIdentity {
  readonly name: string;
  readonly oid: number;
  readonly owner: string;
}

export interface DesktopImportJournalV1 {
  readonly format: typeof importJournalFormat;
  readonly version: 1;
  readonly archiveId: string;
  readonly clusterSystemIdentifier: string;
  readonly phase: DesktopImportJournalPhase;
  readonly active: DesktopImportDatabaseIdentity;
  readonly staging: DesktopImportDatabaseIdentity;
  readonly previous: DesktopImportDatabaseIdentity;
}

interface DesktopImportCatalogIdentity extends DesktopImportDatabaseIdentity {
  readonly marker: string | null;
  readonly allowConnections: boolean;
}

function importOwnershipMarker(
  systemIdentifier: string,
  archiveId: string,
  role: "staging" | "previous",
  identity: DesktopImportDatabaseIdentity,
): string {
  if (
    !/^\d{10,30}$/.test(systemIdentifier) ||
    !portableArchiveIdPattern.test(archiveId) ||
    !importDatabasePattern.test(identity.name) ||
    !Number.isSafeInteger(identity.oid) ||
    identity.oid < 1
  ) {
    throw new Error("desktop portable import failed");
  }
  return `${importOwnershipMarkerPrefix}${systemIdentifier}:${archiveId}:${role}:${identity.name}:${identity.oid}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertDesktopImportIdentity(
  value: unknown,
  allowUnallocated = false,
): asserts value is DesktopImportDatabaseIdentity {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !== "name,oid,owner" ||
    typeof value.name !== "string" ||
    !/^[a-z_][a-z0-9_]{0,62}$/.test(value.name) ||
    typeof value.oid !== "number" ||
    !Number.isSafeInteger(value.oid) ||
    (allowUnallocated ? value.oid < 0 : value.oid < 1) ||
    typeof value.owner !== "string" ||
    !/^[a-z_][a-z0-9_]{0,62}$/.test(value.owner)
  ) {
    throw new Error("desktop portable import recovery failed");
  }
}

function assertDesktopImportJournal(value: unknown): asserts value is DesktopImportJournalV1 {
  if (
    !isRecord(value) ||
    Object.keys(value).sort().join(",") !==
      "active,archiveId,clusterSystemIdentifier,format,phase,previous,staging,version" ||
    value.format !== importJournalFormat ||
    value.version !== 1 ||
    typeof value.archiveId !== "string" ||
    !portableArchiveIdPattern.test(value.archiveId) ||
    typeof value.clusterSystemIdentifier !== "string" ||
    !/^\d{10,30}$/.test(value.clusterSystemIdentifier) ||
    typeof value.phase !== "string" ||
    !desktopImportJournalPhases.includes(value.phase as DesktopImportJournalPhase)
  ) {
    throw new Error("desktop portable import recovery failed");
  }
  assertDesktopImportIdentity(value.active);
  assertDesktopImportIdentity(value.staging, value.phase === "allocating-staging");
  assertDesktopImportIdentity(value.previous);
  if (
    value.active.name === value.staging.name ||
    value.active.name === value.previous.name ||
    value.staging.name === value.previous.name ||
    value.active.oid !== value.previous.oid ||
    value.active.owner !== value.previous.owner ||
    value.active.oid === value.staging.oid
  ) {
    throw new Error("desktop portable import recovery failed");
  }
  if (value.phase === "allocating-staging" && value.staging.oid !== 0) {
    throw new Error("desktop portable import recovery failed");
  }
}

async function syncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function assertJournalParent(journalPath: string): Promise<string> {
  if (!path.isAbsolute(journalPath) || path.basename(journalPath).length < 1) {
    throw new Error("desktop portable import recovery failed");
  }
  const parent = path.dirname(journalPath);
  const entry = await lstat(parent).catch(() => null);
  const canonical = await realpath(parent).catch(() => null);
  if (
    entry === null ||
    !entry.isDirectory() ||
    entry.isSymbolicLink() ||
    canonical === null ||
    path.resolve(canonical) !== path.resolve(parent)
  ) {
    throw new Error("desktop portable import recovery failed");
  }
  return parent;
}

/** Removes only stale, exact, valid journal temporaries left before atomic publication. */
export async function scavengeDesktopImportJournalTemporaries(
  journalPath: string,
  now = Date.now(),
): Promise<number> {
  const parent = await assertJournalParent(journalPath);
  const escaped = path.basename(journalPath).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^\\.${escaped}\\.[0-9a-f]{24}\\.tmp$`);
  const entries = await readdir(parent, { withFileTypes: true });
  let inspected = 0;
  let removed = 0;
  for (const entry of entries) {
    if (
      inspected >= importJournalTemporaryScavengeLimit * 8 ||
      removed >= importJournalTemporaryScavengeLimit
    ) {
      break;
    }
    if (!entry.isFile() || !pattern.test(entry.name)) continue;
    inspected += 1;
    const temporaryPath = path.join(parent, entry.name);
    const before = await lstat(temporaryPath, { bigint: true }).catch(() => null);
    if (
      before === null ||
      before.isSymbolicLink() ||
      !before.isFile() ||
      before.size <= 0n ||
      before.size > 16n * 1024n ||
      Number(before.mtimeMs) > now - importJournalTemporaryStaleMs
    ) {
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(await readFile(temporaryPath, "utf8"));
      assertDesktopImportJournal(value);
    } catch {
      continue;
    }
    const current = await lstat(temporaryPath, { bigint: true }).catch(() => null);
    if (
      current === null ||
      current.dev !== before.dev ||
      current.ino !== before.ino ||
      current.size !== before.size
    ) {
      continue;
    }
    await unlink(temporaryPath);
    removed += 1;
  }
  if (removed > 0) await syncDirectory(parent);
  return removed;
}

export async function writeDesktopImportJournal(
  journalPath: string,
  journal: DesktopImportJournalV1,
  requireAbsent = false,
): Promise<void> {
  assertDesktopImportJournal(journal);
  const parent = await assertJournalParent(journalPath);
  const encoded = `${JSON.stringify(journal)}\n`;
  if (Buffer.byteLength(encoded, "utf8") > 16 * 1024) {
    throw new Error("desktop portable import recovery failed");
  }
  const temporaryPath = path.join(
    parent,
    `.${path.basename(journalPath)}.${randomBytes(12).toString("hex")}.tmp`,
  );
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(encoded, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    if (requireAbsent) {
      await link(temporaryPath, journalPath).catch(() => {
        throw new Error("A portable import requires recovery before another import can start.");
      });
      await unlink(temporaryPath);
    } else {
      await rename(temporaryPath, journalPath);
    }
    await syncDirectory(parent);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export async function readDesktopImportJournal(
  journalPath: string,
): Promise<DesktopImportJournalV1 | null> {
  await assertJournalParent(journalPath);
  const before = await lstat(journalPath).catch(() => null);
  if (before === null) return null;
  if (!before.isFile() || before.isSymbolicLink() || before.size > 16 * 1024) {
    throw new Error("desktop portable import recovery failed");
  }
  const value: unknown = JSON.parse(await readFile(journalPath, "utf8"));
  const after = await lstat(journalPath);
  if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size) {
    throw new Error("desktop portable import recovery failed");
  }
  assertDesktopImportJournal(value);
  return value;
}

async function removeDesktopImportJournal(journalPath: string): Promise<void> {
  const parent = await assertJournalParent(journalPath);
  await unlink(journalPath);
  await syncDirectory(parent);
}

async function withEmbeddedDatabase<Result>(
  databaseUrl: string,
  applicationName: string,
  operation: (sql: Sql) => Promise<Result>,
): Promise<Result> {
  const connection = createDatabase(databaseUrl, 1, {
    idleTimeoutSeconds: 0,
    statementTimeoutMs: 120_000,
    suppressNotices: true,
    applicationName,
  });
  try {
    return await operation(connection.sql);
  } finally {
    await connection.close();
  }
}

async function embeddedDatabaseIdentity(
  adminUrl: string,
  databaseName: string,
): Promise<number | null> {
  return withEmbeddedDatabase(adminUrl, "schedule-portable-import-identity", async (sql) => {
    const [row] = await sql<{ oid: string }[]>`
      SELECT oid::text AS oid FROM pg_catalog.pg_database WHERE datname = ${databaseName}
    `;
    if (row === undefined) return null;
    if (!/^\d+$/.test(row.oid)) throw new Error("desktop portable import failed");
    const oid = Number(row.oid);
    if (!Number.isSafeInteger(oid) || oid < 1) throw new Error("desktop portable import failed");
    return oid;
  });
}

async function embeddedClusterSystemIdentifier(
  environment: DesktopPortableEnvironment,
): Promise<string> {
  return withEmbeddedDatabase(
    environment.adminDatabaseUrl,
    "schedule-portable-import-cluster-identity",
    async (sql) => {
      const [row] = await sql<{ systemIdentifier: string; admin: string }[]>`
        SELECT control.system_identifier::text AS "systemIdentifier", current_user::text AS admin
        FROM pg_catalog.pg_control_system() AS control
      `;
      if (
        row === undefined ||
        !/^\d{10,30}$/.test(row.systemIdentifier) ||
        row.admin !== environment.clusterAdminRole
      ) {
        throw new Error("desktop portable import failed");
      }
      return row.systemIdentifier;
    },
  );
}

async function readEmbeddedImportCatalog(
  environment: DesktopPortableEnvironment,
  databaseNames: readonly string[],
): Promise<Map<string, DesktopImportCatalogIdentity>> {
  for (const name of databaseNames) postgresIdentifier(name);
  return withEmbeddedDatabase(
    environment.adminDatabaseUrl,
    "schedule-portable-import-catalog-identity",
    async (sql) => {
      const rows = await sql<
        {
          name: string;
          oid: string;
          owner: string;
          marker: string | null;
          allowConnections: boolean;
        }[]
      >`
        SELECT database.datname AS name, database.oid::text AS oid,
          pg_catalog.pg_get_userbyid(database.datdba) AS owner,
          pg_catalog.shobj_description(database.oid, 'pg_database') AS marker,
          database.datallowconn AS "allowConnections"
        FROM pg_catalog.pg_database AS database WHERE database.datname = ANY(${databaseNames})
      `;
      return new Map(
        rows.map((row) => {
          const oid = Number(row.oid);
          if (!Number.isSafeInteger(oid) || oid < 1 || String(oid) !== row.oid) {
            throw new Error("desktop portable import failed");
          }
          return [row.name, { ...row, oid }] as const;
        }),
      );
    },
  );
}

function sameImportIdentity(
  actual: DesktopImportCatalogIdentity | undefined,
  expected: DesktopImportDatabaseIdentity,
): actual is DesktopImportCatalogIdentity {
  return (
    actual?.name === expected.name && actual.oid === expected.oid && actual.owner === expected.owner
  );
}

async function setEmbeddedDatabaseMarker(
  environment: DesktopPortableEnvironment,
  databaseName: string,
  marker: string | null,
): Promise<void> {
  await withEmbeddedDatabase(
    environment.adminDatabaseUrl,
    "schedule-portable-import-mark",
    async (sql) => {
      await sql.unsafe(
        `COMMENT ON DATABASE ${postgresIdentifier(databaseName)} IS ${postgresCommentLiteral(marker)}`,
      );
    },
  );
}

async function listMarkedImportDatabases(
  environment: DesktopPortableEnvironment,
  systemIdentifier: string,
): Promise<readonly DesktopImportCatalogIdentity[]> {
  return withEmbeddedDatabase(
    environment.adminDatabaseUrl,
    "schedule-portable-import-reclaim-list",
    async (sql) => {
      const rows = await sql<
        {
          name: string;
          oid: string;
          owner: string;
          marker: string | null;
          allowConnections: boolean;
        }[]
      >`
        SELECT database.datname AS name, database.oid::text AS oid,
          pg_catalog.pg_get_userbyid(database.datdba) AS owner,
          pg_catalog.shobj_description(database.oid, 'pg_database') AS marker,
          database.datallowconn AS "allowConnections"
        FROM pg_catalog.pg_database AS database
        WHERE database.datname ~ '^schedule_(restore|previous)_[0-9a-f]{32}$'
          AND pg_catalog.shobj_description(database.oid, 'pg_database')
            LIKE ${`${importOwnershipMarkerPrefix}${systemIdentifier}:%`}
        ORDER BY database.oid LIMIT 9
      `;
      return rows.map((row) => {
        const oid = Number(row.oid);
        if (!Number.isSafeInteger(oid) || oid < 1 || String(oid) !== row.oid) {
          throw new Error("desktop portable import failed");
        }
        return { ...row, oid };
      });
    },
  );
}

async function reclaimMarkedImportDatabases(
  environment: DesktopPortableEnvironment,
  systemIdentifier: string,
  retainOnePrevious = false,
): Promise<boolean> {
  const candidates = await listMarkedImportDatabases(environment, systemIdentifier);
  if (candidates.length > (retainOnePrevious ? 9 : 8)) {
    throw new Error("desktop portable import recovery required");
  }
  const retained = retainOnePrevious
    ? candidates.filter(({ name }) => name.startsWith("schedule_previous_")).at(-1)
    : undefined;
  for (const candidate of candidates) {
    const match = /^schedule_(restore|previous)_/.exec(candidate.name);
    const markerMatch = new RegExp(
      `^${importOwnershipMarkerPrefix}${systemIdentifier}:([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}):(staging|previous):([a-z0-9_]+):(\\d+)$`,
    ).exec(candidate.marker ?? "");
    if (
      candidate.owner !== environment.ownerRole ||
      match === null ||
      markerMatch?.[1] === undefined ||
      markerMatch[2] === undefined ||
      markerMatch[3] !== candidate.name ||
      markerMatch[4] !== String(candidate.oid) ||
      (match[1] === "restore" ? markerMatch[2] !== "staging" : markerMatch[2] !== "previous")
    ) {
      throw new Error("desktop portable import recovery failed");
    }
    const marker = importOwnershipMarker(
      systemIdentifier,
      markerMatch[1],
      markerMatch[2] as "staging" | "previous",
      candidate,
    );
    if (marker !== candidate.marker) throw new Error("desktop portable import recovery failed");
    if (candidate === retained) {
      if (!(await enableMarkedEmbeddedImportDatabase(environment, candidate, marker))) {
        throw new Error("desktop portable import recovery failed");
      }
      continue;
    }
    if (!(await dropMarkedEmbeddedImportDatabase(environment, candidate, marker))) {
      throw new Error("desktop portable import recovery failed");
    }
  }
  const remaining = await listMarkedImportDatabases(environment, systemIdentifier);
  if (
    remaining.length !== (retained === undefined ? 0 : 1) ||
    (retained !== undefined && remaining[0]?.oid !== retained.oid)
  ) {
    throw new Error("desktop portable import recovery failed");
  }
  return retained !== undefined;
}

async function assertEmbeddedImportAdmission(
  environment: DesktopPortableEnvironment,
): Promise<void> {
  assertPrivateEmbeddedCluster(environment.databaseUrl, environment.adminDatabaseUrl);
  if (new URL(environment.databaseUrl).pathname !== `/${environment.databaseName}`) {
    throw new Error("desktop portable import failed");
  }
  await withEmbeddedDatabase(
    environment.adminDatabaseUrl,
    "schedule-portable-import-admission",
    async (sql) => {
      const [row] = await sql<{ owner: string; admin: string; roles: string }[]>`
      SELECT pg_catalog.pg_get_userbyid(database.datdba) AS owner, current_user::text AS admin,
        (SELECT string_agg(rolname, ',' ORDER BY rolname) FROM pg_catalog.pg_roles
          WHERE rolname IN (${environment.clusterAdminRole}, ${environment.ownerRole}, ${environment.runtimeRole})) AS roles
      FROM pg_catalog.pg_database AS database WHERE database.datname = ${environment.databaseName}
    `;
      if (
        row === undefined ||
        row.owner !== environment.ownerRole ||
        row.admin !== environment.clusterAdminRole ||
        row.roles !==
          [environment.clusterAdminRole, environment.ownerRole, environment.runtimeRole]
            .sort()
            .join(",")
      ) {
        throw new Error("desktop portable import failed");
      }
    },
  );
}

async function createEmbeddedImportDatabase(
  environment: DesktopPortableEnvironment,
  databaseName: string,
): Promise<void> {
  await withEmbeddedDatabase(
    environment.adminDatabaseUrl,
    "schedule-portable-import-create",
    async (sql) => {
      await sql.unsafe(
        `CREATE DATABASE ${postgresIdentifier(databaseName)} OWNER ${postgresIdentifier(environment.ownerRole)}`,
      );
      await sql.unsafe(`REVOKE ALL ON DATABASE ${postgresIdentifier(databaseName)} FROM PUBLIC`);
      await sql.unsafe(
        `GRANT CONNECT ON DATABASE ${postgresIdentifier(databaseName)} TO ${postgresIdentifier(environment.runtimeRole)}`,
      );
    },
  );
}

async function applyEmbeddedRuntimePrivileges(
  environment: DesktopPortableEnvironment,
  databaseName: string,
): Promise<void> {
  const owner = postgresIdentifier(environment.ownerRole);
  const runtime = postgresIdentifier(environment.runtimeRole);
  await withEmbeddedDatabase(
    embeddedDatabaseUrl(environment.databaseUrl, databaseName),
    "schedule-portable-import-privileges",
    async (sql) => {
      for (const statement of [
        "REVOKE CREATE ON SCHEMA public FROM PUBLIC",
        `GRANT USAGE, CREATE ON SCHEMA public TO ${owner}`,
        `GRANT USAGE ON SCHEMA public TO ${runtime}`,
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${runtime}`,
        `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${runtime}`,
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${runtime}`,
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${runtime}`,
      ]) {
        await sql.unsafe(statement);
      }
    },
  );
}

async function removeOwnedEmbeddedImportDatabase(
  environment: DesktopPortableEnvironment,
  databaseName: string,
  expectedIdentity: number,
): Promise<void> {
  await withEmbeddedDatabase(
    environment.adminDatabaseUrl,
    "schedule-portable-import-cleanup",
    async (sql) => {
      const [before] = await sql<{ oid: string; owner: string }[]>`
      SELECT database.oid::text AS oid, pg_catalog.pg_get_userbyid(database.datdba) AS owner
      FROM pg_catalog.pg_database AS database WHERE database.datname = ${databaseName}
    `;
      if (before?.oid !== String(expectedIdentity) || before.owner !== environment.ownerRole)
        return;
      await sql`SELECT pg_catalog.pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity
      WHERE datid = ${expectedIdentity}::pg_catalog.oid AND pid <> pg_catalog.pg_backend_pid()`;
      const [after] = await sql<{ oid: string; owner: string }[]>`
      SELECT database.oid::text AS oid, pg_catalog.pg_get_userbyid(database.datdba) AS owner
      FROM pg_catalog.pg_database AS database WHERE database.datname = ${databaseName}
    `;
      if (after?.oid !== String(expectedIdentity) || after.owner !== environment.ownerRole) return;
      await sql.unsafe(`DROP DATABASE ${postgresIdentifier(databaseName)}`);
    },
  );
}

async function promoteEmbeddedImportDatabase(
  environment: DesktopPortableImportEnvironment,
  stagingDatabase: string,
  previousDatabase: string,
  activeDatabase: string,
  fault?: (point: string) => void | Promise<void>,
): Promise<void> {
  const systemIdentifier = await embeddedClusterSystemIdentifier(environment);
  const initial = await readEmbeddedImportCatalog(environment, [
    activeDatabase,
    stagingDatabase,
    previousDatabase,
  ]);
  const active = initial.get(activeDatabase);
  const staging = initial.get(stagingDatabase);
  if (
    active === undefined ||
    staging === undefined ||
    active.owner !== environment.ownerRole ||
    staging.owner !== environment.ownerRole ||
    initial.has(previousDatabase)
  ) {
    throw new Error("desktop portable import failed");
  }
  const previous: DesktopImportDatabaseIdentity = {
    name: previousDatabase,
    oid: active.oid,
    owner: active.owner,
  };
  const stagingIdentity: DesktopImportDatabaseIdentity = {
    name: staging.name,
    oid: staging.oid,
    owner: staging.owner,
  };
  const activeIdentity: DesktopImportDatabaseIdentity = {
    name: active.name,
    oid: active.oid,
    owner: active.owner,
  };
  const stagingMarker = importOwnershipMarker(
    systemIdentifier,
    environment.expectedArchiveId,
    "staging",
    stagingIdentity,
  );
  const previousMarker = importOwnershipMarker(
    systemIdentifier,
    environment.expectedArchiveId,
    "previous",
    previous,
  );
  const markedStaging = (await readEmbeddedImportCatalog(environment, [stagingDatabase])).get(
    stagingDatabase,
  );
  if (
    !sameImportIdentity(markedStaging, stagingIdentity) ||
    markedStaging.marker !== stagingMarker
  ) {
    throw new Error("desktop portable import failed");
  }
  const allocation = await readDesktopImportJournal(environment.importJournalPath);
  if (
    allocation?.phase !== "allocating-staging" ||
    allocation.archiveId !== environment.expectedArchiveId ||
    allocation.clusterSystemIdentifier !== systemIdentifier ||
    allocation.active.name !== activeIdentity.name ||
    allocation.active.oid !== activeIdentity.oid ||
    allocation.active.owner !== activeIdentity.owner ||
    allocation.staging.name !== stagingIdentity.name ||
    allocation.staging.oid !== 0 ||
    allocation.staging.owner !== stagingIdentity.owner ||
    allocation.previous.name !== previous.name ||
    allocation.previous.oid !== previous.oid ||
    allocation.previous.owner !== previous.owner
  ) {
    throw new Error("desktop portable import recovery failed");
  }
  let journal: DesktopImportJournalV1 = {
    format: importJournalFormat,
    version: 1,
    archiveId: environment.expectedArchiveId,
    clusterSystemIdentifier: systemIdentifier,
    phase: "prepared",
    active: activeIdentity,
    staging: stagingIdentity,
    previous,
  };
  await writeDesktopImportJournal(environment.importJournalPath, journal);
  await fault?.("prepared");

  await withEmbeddedDatabase(
    environment.adminDatabaseUrl,
    "schedule-portable-import-promote",
    async (sql) => {
      await runJournaledPortablePromotion({
        writePhase: async (next) => {
          journal = { ...journal, phase: next };
          await writeDesktopImportJournal(environment.importJournalPath, journal);
        },
        ...(fault === undefined ? {} : { fault }),
        run: async (operation) => {
          const before = await readEmbeddedImportCatalog(environment, [
            activeDatabase,
            stagingDatabase,
            previousDatabase,
          ]);
          const beforeActive = before.get(activeDatabase);
          const beforeStaging = before.get(stagingDatabase);
          const beforePrevious = before.get(previousDatabase);
          const oldIsActive = sameImportIdentity(beforeActive, activeIdentity);
          const oldIsPrevious =
            sameImportIdentity(beforePrevious, previous) &&
            beforePrevious.marker === previousMarker;
          const newIsStaging =
            sameImportIdentity(beforeStaging, stagingIdentity) &&
            beforeStaging.marker === stagingMarker;
          const newIsActive =
            beforeActive?.oid === stagingIdentity.oid &&
            beforeActive.owner === stagingIdentity.owner &&
            beforeActive.marker === stagingMarker;
          if (
            (operation === "mark-previous" &&
              (!oldIsActive || !newIsStaging || beforePrevious !== undefined)) ||
            ((operation === "disable-active" || operation === "rename-active") &&
              (!oldIsActive ||
                beforeActive.marker !== previousMarker ||
                !newIsStaging ||
                beforePrevious !== undefined)) ||
            (operation === "promote-staging" &&
              (beforeActive !== undefined || !newIsStaging || !oldIsPrevious)) ||
            (operation === "enable-active" &&
              (!newIsActive || beforeStaging !== undefined || !oldIsPrevious))
          ) {
            throw new Error("desktop portable import failed");
          }
          if (operation === "mark-previous") {
            await sql.unsafe(
              `COMMENT ON DATABASE ${postgresIdentifier(activeDatabase)} IS ${postgresCommentLiteral(previousMarker)}`,
            );
          } else if (operation === "disable-active") {
            await sql.unsafe(
              `ALTER DATABASE ${postgresIdentifier(activeDatabase)} WITH ALLOW_CONNECTIONS false`,
            );
            await sql`SELECT pg_catalog.pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity
              WHERE datname = ${activeDatabase} AND pid <> pg_catalog.pg_backend_pid()`;
          } else if (operation === "rename-active") {
            await sql.unsafe(
              `ALTER DATABASE ${postgresIdentifier(activeDatabase)} RENAME TO ${postgresIdentifier(previousDatabase)}`,
            );
          } else if (operation === "promote-staging") {
            await sql.unsafe(
              `ALTER DATABASE ${postgresIdentifier(stagingDatabase)} RENAME TO ${postgresIdentifier(activeDatabase)}`,
            );
          } else {
            await sql.unsafe(
              `ALTER DATABASE ${postgresIdentifier(activeDatabase)} WITH ALLOW_CONNECTIONS true`,
            );
          }
          const after = await readEmbeddedImportCatalog(environment, [
            activeDatabase,
            stagingDatabase,
            previousDatabase,
          ]);
          const afterActive = after.get(activeDatabase);
          const afterStaging = after.get(stagingDatabase);
          const afterPrevious = after.get(previousDatabase);
          const valid =
            operation === "mark-previous"
              ? sameImportIdentity(afterActive, activeIdentity) &&
                afterActive.marker === previousMarker &&
                sameImportIdentity(afterStaging, stagingIdentity) &&
                afterStaging.marker === stagingMarker &&
                afterPrevious === undefined
              : operation === "disable-active"
                ? sameImportIdentity(afterActive, activeIdentity) &&
                  afterActive.marker === previousMarker &&
                  !afterActive.allowConnections &&
                  sameImportIdentity(afterStaging, stagingIdentity) &&
                  afterStaging.marker === stagingMarker &&
                  afterPrevious === undefined
                : operation === "rename-active"
                  ? afterActive === undefined &&
                    sameImportIdentity(afterPrevious, previous) &&
                    afterPrevious.marker === previousMarker &&
                    sameImportIdentity(afterStaging, stagingIdentity) &&
                    afterStaging.marker === stagingMarker
                  : operation === "promote-staging"
                    ? afterStaging === undefined &&
                      afterActive?.oid === stagingIdentity.oid &&
                      afterActive.owner === stagingIdentity.owner &&
                      afterActive.marker === stagingMarker &&
                      sameImportIdentity(afterPrevious, previous) &&
                      afterPrevious.marker === previousMarker
                    : afterActive?.oid === stagingIdentity.oid &&
                      afterActive.owner === stagingIdentity.owner &&
                      afterActive.marker === stagingMarker &&
                      afterActive.allowConnections &&
                      sameImportIdentity(afterPrevious, previous) &&
                      afterPrevious.marker === previousMarker;
          if (!valid) throw new Error("desktop portable import failed");
        },
      });
      journal = { ...journal, phase: "committed" };
      await writeDesktopImportJournal(environment.importJournalPath, journal);
      await fault?.("committed");
    },
  );
}

async function dropMarkedEmbeddedImportDatabase(
  environment: DesktopPortableEnvironment,
  identity: DesktopImportDatabaseIdentity,
  marker: string,
): Promise<boolean> {
  const before = (await readEmbeddedImportCatalog(environment, [identity.name])).get(identity.name);
  if (!sameImportIdentity(before, identity) || before.marker !== marker) return false;
  return withEmbeddedDatabase(
    environment.adminDatabaseUrl,
    "schedule-portable-import-recovery-drop",
    async (sql) => {
      await sql`SELECT pg_catalog.pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity
        WHERE datid = ${identity.oid}::pg_catalog.oid AND datname = ${identity.name}
          AND pid <> pg_catalog.pg_backend_pid()`;
      const current = (await readEmbeddedImportCatalog(environment, [identity.name])).get(
        identity.name,
      );
      if (!sameImportIdentity(current, identity) || current.marker !== marker) return false;
      await sql.unsafe(`DROP DATABASE ${postgresIdentifier(identity.name)}`);
      return true;
    },
  );
}

async function dropAllocatedEmbeddedImportDatabase(
  environment: DesktopPortableEnvironment,
  journal: DesktopImportJournalV1,
  identity: DesktopImportCatalogIdentity,
): Promise<boolean> {
  const marker = importOwnershipMarker(
    journal.clusterSystemIdentifier,
    journal.archiveId,
    "staging",
    identity,
  );
  if (identity.marker !== null && identity.marker !== marker) return false;
  return withEmbeddedDatabase(
    environment.adminDatabaseUrl,
    "schedule-portable-import-allocation-drop",
    async (sql) => {
      await sql`SELECT pg_catalog.pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity
        WHERE datid = ${identity.oid}::pg_catalog.oid AND datname = ${identity.name}
          AND pid <> pg_catalog.pg_backend_pid()`;
      const current = (await readEmbeddedImportCatalog(environment, [identity.name])).get(
        identity.name,
      );
      if (
        !sameImportIdentity(current, identity) ||
        (current.marker !== null && current.marker !== marker)
      ) {
        return false;
      }
      await sql.unsafe(`DROP DATABASE ${postgresIdentifier(identity.name)}`);
      return true;
    },
  );
}

async function enableMarkedEmbeddedImportDatabase(
  environment: DesktopPortableEnvironment,
  identity: DesktopImportDatabaseIdentity,
  marker: string,
): Promise<boolean> {
  const before = (await readEmbeddedImportCatalog(environment, [identity.name])).get(identity.name);
  if (!sameImportIdentity(before, identity) || before.marker !== marker) return false;
  await withEmbeddedDatabase(
    environment.adminDatabaseUrl,
    "schedule-portable-import-recovery-enable",
    async (sql) => {
      await sql.unsafe(
        `ALTER DATABASE ${postgresIdentifier(identity.name)} WITH ALLOW_CONNECTIONS true`,
      );
    },
  );
  const after = (await readEmbeddedImportCatalog(environment, [identity.name])).get(identity.name);
  return (
    sameImportIdentity(after, identity) &&
    after.marker === marker &&
    after.allowConnections === true
  );
}

export interface DesktopPortableRecoveryResult {
  readonly recovered: boolean;
  readonly state: "no-journal" | "restored-previous-active" | "committed-new-active";
  readonly archiveId?: string;
  readonly previousRetained: boolean;
  readonly committed: boolean;
}

export type DesktopImportTopologyRole = "missing" | "old" | "new" | "other";

export function classifyDesktopImportRecoveryTopology(topology: {
  readonly active: DesktopImportTopologyRole;
  readonly staging: DesktopImportTopologyRole;
  readonly previous: DesktopImportTopologyRole;
}): "restore-old" | "finish-new" {
  if (topology.active === "new" && topology.staging === "missing" && topology.previous === "old") {
    return "finish-new";
  }
  if (
    (topology.active === "old" &&
      topology.previous === "missing" &&
      (topology.staging === "new" || topology.staging === "missing")) ||
    (topology.active === "missing" &&
      topology.previous === "old" &&
      (topology.staging === "new" || topology.staging === "missing"))
  ) {
    return "restore-old";
  }
  throw new Error("desktop portable import recovery failed");
}

/** Reconciles the durable journal from catalog topology, never from phase alone. */
export async function recoverDesktopPortableImport(
  environment: DesktopPortableRecoveryEnvironment = readDesktopPortableRecoveryEnvironment(),
): Promise<DesktopPortableRecoveryResult> {
  await scavengeDesktopImportJournalTemporaries(environment.importJournalPath);
  const journal = await readDesktopImportJournal(environment.importJournalPath);
  if (journal === null) {
    assertPrivateEmbeddedCluster(environment.databaseUrl, environment.adminDatabaseUrl);
    const previousRetained = await reclaimMarkedImportDatabases(
      environment,
      await embeddedClusterSystemIdentifier(environment),
      true,
    );
    return {
      recovered: false,
      state: "no-journal",
      previousRetained,
      committed: false,
    };
  }
  assertPrivateEmbeddedCluster(environment.databaseUrl, environment.adminDatabaseUrl);
  if ((await embeddedClusterSystemIdentifier(environment)) !== journal.clusterSystemIdentifier) {
    throw new Error("desktop portable import recovery failed");
  }
  if (
    journal.active.name !== environment.databaseName ||
    journal.active.owner !== environment.ownerRole ||
    journal.staging.owner !== environment.ownerRole ||
    journal.previous.owner !== environment.ownerRole
  ) {
    throw new Error("desktop portable import recovery failed");
  }
  const names = [journal.active.name, journal.staging.name, journal.previous.name];
  const catalog = await readEmbeddedImportCatalog(environment, names);
  const active = catalog.get(journal.active.name);
  const staging = catalog.get(journal.staging.name);
  const previous = catalog.get(journal.previous.name);
  if (journal.phase === "allocating-staging") {
    if (
      !sameImportIdentity(active, journal.active) ||
      previous !== undefined ||
      (staging !== undefined &&
        (staging.name !== journal.staging.name || staging.owner !== journal.staging.owner))
    ) {
      throw new Error("desktop portable import recovery failed");
    }
    if (
      staging !== undefined &&
      !(await dropAllocatedEmbeddedImportDatabase(environment, journal, staging))
    ) {
      throw new Error("desktop portable import recovery failed");
    }
    const finalCatalog = await readEmbeddedImportCatalog(environment, names);
    if (
      !sameImportIdentity(finalCatalog.get(journal.active.name), journal.active) ||
      finalCatalog.has(journal.staging.name) ||
      finalCatalog.has(journal.previous.name)
    ) {
      throw new Error("desktop portable import recovery failed");
    }
    await removeDesktopImportJournal(environment.importJournalPath);
    return {
      recovered: true,
      state: "restored-previous-active",
      archiveId: journal.archiveId,
      previousRetained: false,
      committed: false,
    };
  }
  const stagingMarker = importOwnershipMarker(
    journal.clusterSystemIdentifier,
    journal.archiveId,
    "staging",
    journal.staging,
  );
  const previousMarker = importOwnershipMarker(
    journal.clusterSystemIdentifier,
    journal.archiveId,
    "previous",
    journal.previous,
  );
  const activeIsOld = sameImportIdentity(active, journal.active);
  const activeIsNew =
    active !== undefined &&
    active.name === journal.active.name &&
    active.oid === journal.staging.oid &&
    active.owner === journal.staging.owner &&
    active.marker === stagingMarker;
  const previousIsOld =
    sameImportIdentity(previous, journal.previous) && previous.marker === previousMarker;
  const stagingIsNew =
    sameImportIdentity(staging, journal.staging) && staging.marker === stagingMarker;
  const disposition = classifyDesktopImportRecoveryTopology({
    active: activeIsOld ? "old" : activeIsNew ? "new" : active === undefined ? "missing" : "other",
    staging: stagingIsNew ? "new" : staging === undefined ? "missing" : "other",
    previous: previousIsOld ? "old" : previous === undefined ? "missing" : "other",
  });

  if (disposition === "finish-new") {
    await withEmbeddedDatabase(
      environment.adminDatabaseUrl,
      "schedule-portable-import-recovery-commit",
      async (sql) => {
        await sql.unsafe(
          `ALTER DATABASE ${postgresIdentifier(journal.active.name)} WITH ALLOW_CONNECTIONS true`,
        );
        await sql.unsafe(
          `ALTER DATABASE ${postgresIdentifier(journal.previous.name)} WITH ALLOW_CONNECTIONS true`,
        );
      },
    );
    const finalCatalog = await readEmbeddedImportCatalog(environment, [
      journal.active.name,
      journal.previous.name,
    ]);
    if (
      !sameImportIdentity(finalCatalog.get(journal.active.name), {
        ...journal.staging,
        name: journal.active.name,
      }) ||
      finalCatalog.get(journal.active.name)?.marker !== stagingMarker ||
      !sameImportIdentity(finalCatalog.get(journal.previous.name), journal.previous) ||
      finalCatalog.get(journal.previous.name)?.marker !== previousMarker ||
      finalCatalog.get(journal.active.name)?.allowConnections !== true ||
      finalCatalog.get(journal.previous.name)?.allowConnections !== true
    ) {
      throw new Error("desktop portable import recovery failed");
    }
    await removeDesktopImportJournal(environment.importJournalPath);
    return {
      recovered: true,
      state: "committed-new-active",
      archiveId: journal.archiveId,
      previousRetained: true,
      committed: true,
    };
  }

  await withEmbeddedDatabase(
    environment.adminDatabaseUrl,
    "schedule-portable-import-recovery-rollback",
    async (sql) => {
      if (previousIsOld) {
        await sql.unsafe(
          `ALTER DATABASE ${postgresIdentifier(journal.previous.name)} RENAME TO ${postgresIdentifier(journal.active.name)}`,
        );
      }
      await sql.unsafe(
        `ALTER DATABASE ${postgresIdentifier(journal.active.name)} WITH ALLOW_CONNECTIONS true`,
      );
    },
  );
  const restored = (await readEmbeddedImportCatalog(environment, [journal.active.name])).get(
    journal.active.name,
  );
  if (!sameImportIdentity(restored, journal.active) || restored.allowConnections !== true) {
    throw new Error("desktop portable import recovery failed");
  }
  if (restored.marker === previousMarker) {
    await setEmbeddedDatabaseMarker(environment, journal.active.name, null);
  }
  if (stagingIsNew) {
    if (!(await dropMarkedEmbeddedImportDatabase(environment, journal.staging, stagingMarker))) {
      throw new Error("desktop portable import recovery failed");
    }
  }
  const finalCatalog = await readEmbeddedImportCatalog(environment, names);
  const finalActive = finalCatalog.get(journal.active.name);
  if (
    !sameImportIdentity(finalActive, journal.active) ||
    finalActive.allowConnections !== true ||
    finalCatalog.has(journal.staging.name) ||
    finalCatalog.has(journal.previous.name)
  ) {
    throw new Error("desktop portable import recovery failed");
  }
  await removeDesktopImportJournal(environment.importJournalPath);
  return {
    recovered: true,
    state: "restored-previous-active",
    archiveId: journal.archiveId,
    previousRetained: false,
    committed: false,
  };
}

export async function importDesktopPortableScheduleData(
  source: string,
  environment: DesktopPortableImportEnvironment = readDesktopPortableImportEnvironment(),
  dependencies: {
    /** Test-only crash seam; production never reads a fault-injection environment variable. */
    readonly fault?: (point: string) => void | Promise<void>;
  } = {},
): Promise<{
  readonly archiveId: string;
  readonly previousDatabase: string;
  readonly committed: true;
}> {
  await scavengeDesktopImportJournalTemporaries(environment.importJournalPath);
  if ((await readDesktopImportJournal(environment.importJournalPath)) !== null) {
    throw new Error("A portable import requires recovery before another import can start.");
  }
  const archivePath = await assertDesktopPortableImportSource(source);
  const activeDatabase = environment.databaseName;
  const stagingDatabase = generatedImportDatabaseName("schedule_restore_");
  const previousDatabase = generatedImportDatabaseName("schedule_previous_");
  return importPortableScheduleData(
    {
      archivePath,
      expectedArchiveId: environment.expectedArchiveId,
      expectedArchiveSha256: environment.expectedArchiveSha256,
      activeDatabase,
      stagingDatabase,
      previousDatabase,
    },
    {
      assertDatabaseName: postgresIdentifier,
      assertActiveDatabase: async () => assertEmbeddedImportAdmission(environment),
      schemaSignal: (databaseName) =>
        withEmbeddedDatabase(
          embeddedDatabaseUrl(environment.databaseUrl, databaseName),
          "schedule-portable-import-schema",
          portableDatabaseSchemaSignal,
        ),
      migrationIdentity: () =>
        readPortableMigrationIdentity(
          path.resolve(path.dirname(environment.migrationEntrypoint), "../drizzle"),
        ),
      columnCatalog: async (databaseName) => {
        const { columns } = await withEmbeddedDatabase(
          embeddedDatabaseUrl(environment.databaseUrl, databaseName),
          "schedule-portable-import-catalog",
          readPortableColumnCatalog,
        );
        return columns;
      },
      prepareStagingDatabase: async (
        payloadPath,
        databaseName,
        schemaSignal,
        expectedData,
        onCreated,
      ) => {
        const systemIdentifier = await embeddedClusterSystemIdentifier(environment);
        await reclaimMarkedImportDatabases(environment, systemIdentifier);
        const allocationCatalog = await readEmbeddedImportCatalog(environment, [
          activeDatabase,
          databaseName,
          previousDatabase,
        ]);
        const active = allocationCatalog.get(activeDatabase);
        if (
          active === undefined ||
          active.owner !== environment.ownerRole ||
          allocationCatalog.has(databaseName) ||
          allocationCatalog.has(previousDatabase)
        ) {
          throw new Error("desktop portable import failed");
        }
        await writeDesktopImportJournal(
          environment.importJournalPath,
          {
            format: importJournalFormat,
            version: 1,
            archiveId: environment.expectedArchiveId,
            clusterSystemIdentifier: systemIdentifier,
            phase: "allocating-staging",
            active: { name: active.name, oid: active.oid, owner: active.owner },
            staging: { name: databaseName, oid: 0, owner: environment.ownerRole },
            previous: {
              name: previousDatabase,
              oid: active.oid,
              owner: active.owner,
            },
          },
          true,
        );
        await dependencies.fault?.("allocation-written");
        await createEmbeddedImportDatabase(environment, databaseName);
        await dependencies.fault?.("staging-created");
        const identity = await embeddedDatabaseIdentity(environment.adminDatabaseUrl, databaseName);
        if (identity === null) throw new Error("desktop portable import failed");
        onCreated(identity);
        const stagingIdentity = { name: databaseName, oid: identity, owner: environment.ownerRole };
        const marker = importOwnershipMarker(
          systemIdentifier,
          environment.expectedArchiveId,
          "staging",
          stagingIdentity,
        );
        await setEmbeddedDatabaseMarker(environment, databaseName, marker);
        await dependencies.fault?.("staging-marked");
        const marked = (await readEmbeddedImportCatalog(environment, [databaseName])).get(
          databaseName,
        );
        if (!sameImportIdentity(marked, stagingIdentity) || marked.marker !== marker) {
          throw new Error("desktop portable import failed");
        }
        const stagingUrl = embeddedDatabaseUrl(environment.databaseUrl, databaseName);
        const stagingAdminUrl = embeddedDatabaseUrl(environment.adminDatabaseUrl, databaseName);
        const invocation = desktopMigrationInvocation(environment, stagingUrl);
        await runDesktopPortableChild(invocation.executable, invocation.args, invocation.env);
        await applyEmbeddedRuntimePrivileges(environment, databaseName);
        await withEmbeddedDatabase(stagingUrl, "schedule-portable-import-restore", async (sql) => {
          if ((await portableDatabaseSchemaSignal(sql)) !== schemaSignal) {
            throw new Error("Portable staging schema does not match the source Schedule schema.");
          }
        });
        await restorePortablePayload(stagingAdminUrl, payloadPath, expectedData);
        await withEmbeddedDatabase(
          stagingAdminUrl,
          "schedule-portable-import-normalize",
          normalizeAndVerifyPortableDatabase,
        );
      },
      signalsMatch: async (databaseName, expected) => {
        try {
          const signals = await withEmbeddedDatabase(
            embeddedDatabaseUrl(environment.databaseUrl, databaseName),
            "schedule-portable-import-verify",
            readPortableDatabaseSignals,
          );
          return (
            portableDataPolicyV1.includedTables.every(
              (table) => signals.contentSignals[table] === expected.contentSignals[table],
            ) &&
            portableDataPolicyV1.sequences.every(
              (sequence) =>
                signals.sequenceSignals[sequence] === expected.sequenceSignals[sequence],
            )
          );
        } catch {
          return false;
        }
      },
      promoteStagingDatabase: (staging, previous, active) =>
        promoteEmbeddedImportDatabase(environment, staging, previous, active, dependencies.fault),
      databaseIdentity: (databaseName) =>
        embeddedDatabaseIdentity(environment.adminDatabaseUrl, databaseName),
      cleanupStagingAfterFailure: async (_cause, databaseName, identity) =>
        removeOwnedEmbeddedImportDatabase(environment, databaseName, identity),
    },
  );
}

export interface DesktopPortableCliIo {
  readonly stdout: (value: string) => void;
  readonly stderr: (value: string) => void;
  readonly exportSchedule?: typeof exportDesktopPortableScheduleData;
  readonly inspectSchedule?: typeof inspectDesktopPortableScheduleData;
  /** Test seam; production uses the direct PostgreSQL adapter above. */
  readonly importSchedule?: (
    source: string,
    environment: DesktopPortableImportEnvironment,
  ) => Promise<{ readonly archiveId: string; readonly committed: true }>;
  readonly recoverImport?: (
    environment: DesktopPortableRecoveryEnvironment,
  ) => Promise<DesktopPortableRecoveryResult>;
}

function writeDesktopPortableProtocol(
  write: (value: string) => void,
  prefix: string,
  value: object,
): void {
  const line = `${prefix}${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(line, "utf8") > childOutputLimitBytes) {
    throw new Error("desktop portable protocol output is too large");
  }
  write(line);
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
    const command = parseDesktopPortableCommand(args);
    if (command.kind === "inspect") {
      writeDesktopPortableProtocol(
        io.stdout,
        desktopPortableInspectSuccessPrefix,
        await (io.inspectSchedule ?? inspectDesktopPortableScheduleData)(command.source),
      );
      return true;
    }
    if (command.kind === "recover") {
      const result = await (io.recoverImport ?? recoverDesktopPortableImport)(
        readDesktopPortableRecoveryEnvironment(environment),
      );
      writeDesktopPortableProtocol(io.stdout, desktopPortableRecoverySuccessPrefix, {
        recovered: result.recovered,
        committed: result.committed,
      });
      return true;
    }
    if (command.kind === "import") {
      await (io.importSchedule ?? importDesktopPortableScheduleData)(
        command.source,
        readDesktopPortableImportEnvironment(environment),
      );
      writeDesktopPortableProtocol(io.stdout, desktopPortableImportSuccessPrefix, {
        previousRetained: true,
      });
      return true;
    }
    const desktopEnvironment = readDesktopPortableEnvironment(environment);
    const result = await (io.exportSchedule ?? exportDesktopPortableScheduleData)(
      command.destination,
      desktopEnvironment,
    );
    writeDesktopPortableProtocol(io.stdout, desktopPortableSuccessPrefix, {
      sizeBytes: result.sizeBytes,
    });
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
