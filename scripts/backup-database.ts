import { spawn } from "node:child_process";
import { constants, type BigIntStats } from "node:fs";
import { chmod, lstat, mkdtemp, open, mkdir, rm, stat, type FileHandle } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const composeDatabaseName = "schedule";
export const composeDatabaseService = "postgres";
export const composeDatabaseUser = "schedule";
export const expectedScheduleTables = [
  "activity_events",
  "audit_events",
  "daily_plan_fit_insight_feedback_events",
  "daily_plan_heads",
  "daily_plan_item_states",
  "daily_plan_items",
  "daily_plans",
  "integration_confirmations",
  "integration_credentials",
  "integration_requests",
  "natural_language_proposals",
  "notification_delivery_attempts",
  "notification_delivery_commands",
  "notification_delivery_requests",
  "notification_intents",
  "notification_profiles",
  "notification_rules",
  "one_off_reminders",
  "outbox_events",
  "plan_interaction_events",
  "plan_mutations",
  "recurrence_series",
  "routine_duration_insight_feedback_events",
  "routine_planning_feedback_events",
  "routines",
  "schedule_blocks",
  "webhook_deliveries",
  "webhook_endpoint_secrets",
  "webhook_endpoints",
  "webhook_event_subscriptions",
  "work_item_dependencies",
  "work_items",
  "workspaces",
] as const;
export const expectedScheduleSequences = [
  { schema: "drizzle", name: "__drizzle_migrations_id_seq" },
  { schema: "public", name: "activity_events_ingested_sequence_seq" },
  {
    schema: "public",
    name: "daily_plan_fit_insight_feedback_events_ingested_sequence_seq",
  },
  { schema: "public", name: "plan_interaction_events_ingested_sequence_seq" },
  {
    schema: "public",
    name: "routine_duration_insight_feedback_events_ingested_sequence_seq",
  },
  {
    schema: "public",
    name: "routine_planning_feedback_events_ingested_sequence_seq",
  },
] as const;

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

interface ComposeCommandOptions {
  readonly inputPath?: string;
  readonly outputPath?: string;
}

export interface PreparedRestoreArchive {
  readonly sourcePath: string;
  readonly snapshotPath: string;
  readonly sizeBytes: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runComposeCommand(
  args: readonly string[],
  options: ComposeCommandOptions = {},
): Promise<string> {
  let input: FileHandle | undefined;
  let output: FileHandle | undefined;
  let commandSucceeded = false;

  try {
    input = options.inputPath === undefined ? undefined : await open(options.inputPath, "r");
    output =
      options.outputPath === undefined ? undefined : await open(options.outputPath, "wx", 0o600);
    const result = await new Promise<string>((resolve, reject) => {
      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      const child = spawn("docker", ["compose", ...args], {
        cwd: repositoryRoot,
        windowsHide: true,
        stdio: [input?.fd ?? "ignore", output?.fd ?? "pipe", "pipe"],
      });

      if (output === undefined) {
        child.stdout?.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
      }
      child.stderr?.on("data", (chunk: Buffer) => stderrChunks.push(chunk));
      child.once("error", reject);
      child.once("close", (code) => {
        if (code === 0) {
          resolve(Buffer.concat(stdoutChunks).toString("utf8"));
          return;
        }

        const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
        reject(
          new Error(
            `Docker Compose command failed with exit code ${String(code)}${stderr === "" ? "" : `: ${stderr}`}`,
          ),
        );
      });
    });
    commandSucceeded = true;
    return result;
  } finally {
    await Promise.all([input?.close(), output?.close()]);
    if (!commandSucceeded && output !== undefined && options.outputPath !== undefined) {
      await rm(options.outputPath, { force: true });
    }
  }
}

export function createTimestamp(): string {
  return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

export function defaultBackupPath(): string {
  const backupDirectory =
    process.env.SCHEDULE_BACKUP_DIR ?? path.join(homedir(), ".schedule", "backups");
  return path.join(backupDirectory, `schedule-${createTimestamp()}.dump`);
}

export async function assertComposeDatabaseReady(
  databaseName = composeDatabaseName,
): Promise<void> {
  await runComposeCommand([
    "exec",
    "-T",
    composeDatabaseService,
    "pg_isready",
    "--username",
    composeDatabaseUser,
    "--dbname",
    databaseName,
  ]);
}

export interface ScheduleArchiveCatalog {
  readonly tables: readonly string[];
  readonly sequences: readonly { readonly schema: string; readonly name: string }[];
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function assertSafeDatabaseName(databaseName: string): void {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(databaseName)) {
    throw new Error(`Unsafe PostgreSQL database identifier: ${databaseName}`);
  }
}

async function readSourceCatalog(databaseName: string): Promise<ScheduleArchiveCatalog> {
  assertSafeDatabaseName(databaseName);
  const tables = (
    await runComposeCommand([
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
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;",
    ])
  )
    .trim()
    .split(/\r?\n/)
    .filter((value) => value !== "");
  const sequenceRows = (
    await runComposeCommand([
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
      "SELECT schemaname || '.' || sequencename FROM pg_sequences WHERE schemaname IN ('public', 'drizzle') ORDER BY schemaname, sequencename;",
    ])
  )
    .trim()
    .split(/\r?\n/)
    .filter((value) => value !== "");
  const sequences = sequenceRows.map((value) => {
    const separator = value.indexOf(".");
    if (separator < 1 || separator === value.length - 1) {
      throw new Error(`Could not parse source sequence identifier: ${value}`);
    }
    return { schema: value.slice(0, separator), name: value.slice(separator + 1) };
  });
  return { tables, sequences };
}

export function parseArchiveCatalog(listing: string): ScheduleArchiveCatalog {
  const catalogLines = listing.split(/\r?\n/);
  const unexpectedSchemas = catalogLines
    .map((line) => /\bSCHEMA - ([^\s]+)/.exec(line)?.[1])
    .filter(
      (schema): schema is string =>
        schema !== undefined && schema !== "drizzle" && schema !== "public",
    );
  if (unexpectedSchemas.length > 0) {
    throw new Error(
      `Backup contains unexpected user schemas: ${[...new Set(unexpectedSchemas)].join(", ")}`,
    );
  }

  const tableDefinitions = sortedUnique(
    catalogLines.flatMap((line) => {
      const match = /\bTABLE (public|drizzle) ([a-z_][a-z0-9_]*)(?:\s|$)/.exec(line);
      return match?.[1] === undefined || match[2] === undefined ? [] : [`${match[1]}.${match[2]}`];
    }),
  );
  const tableData = sortedUnique(
    catalogLines.flatMap((line) => {
      const match = /\bTABLE DATA (public|drizzle) ([a-z_][a-z0-9_]*)(?:\s|$)/.exec(line);
      return match?.[1] === undefined || match[2] === undefined ? [] : [`${match[1]}.${match[2]}`];
    }),
  );
  if (JSON.stringify(tableDefinitions) !== JSON.stringify(tableData)) {
    throw new Error(
      "Backup table definitions and data sections do not form the same complete set.",
    );
  }
  if (!tableDefinitions.includes("drizzle.__drizzle_migrations")) {
    throw new Error("Backup is missing the Drizzle migration ledger and its data section.");
  }
  const unexpectedDrizzleTables = tableDefinitions.filter(
    (table) => table.startsWith("drizzle.") && table !== "drizzle.__drizzle_migrations",
  );
  if (unexpectedDrizzleTables.length > 0) {
    throw new Error(
      `Backup contains unexpected Drizzle tables: ${unexpectedDrizzleTables.join(", ")}`,
    );
  }

  const sequenceDefinitions = sortedUnique(
    catalogLines.flatMap((line) => {
      const match = /\bSEQUENCE (public|drizzle) ([a-z_][a-z0-9_]*)(?:\s|$)/.exec(line);
      return match?.[1] === undefined || match[2] === undefined ? [] : [`${match[1]}.${match[2]}`];
    }),
  );
  const sequenceValues = sortedUnique(
    catalogLines.flatMap((line) => {
      const match = /\bSEQUENCE SET (public|drizzle) ([a-z_][a-z0-9_]*)(?:\s|$)/.exec(line);
      return match?.[1] === undefined || match[2] === undefined ? [] : [`${match[1]}.${match[2]}`];
    }),
  );
  if (JSON.stringify(sequenceDefinitions) !== JSON.stringify(sequenceValues)) {
    throw new Error(
      "Backup sequence definitions and value-set sections are incomplete or filtered.",
    );
  }
  const requiredBaselineSequences = ["drizzle.__drizzle_migrations_id_seq"];
  const missingBaselineSequences = requiredBaselineSequences.filter(
    (sequence) => !sequenceDefinitions.includes(sequence),
  );
  if (missingBaselineSequences.length > 0) {
    throw new Error(
      `Backup is missing baseline Schedule sequences: ${missingBaselineSequences.join(", ")}`,
    );
  }

  const tables = tableDefinitions
    .filter((table) => table.startsWith("public."))
    .map((table) => table.slice("public.".length));
  const baselineTables = [
    "audit_events",
    "outbox_events",
    "recurrence_series",
    "schedule_blocks",
    "work_items",
    "workspaces",
  ];
  const missingBaselineTables = baselineTables.filter((table) => !tables.includes(table));
  if (missingBaselineTables.length > 0) {
    throw new Error(
      `Backup is not a supported Schedule archive; missing baseline tables: ${missingBaselineTables.join(", ")}`,
    );
  }

  return {
    tables,
    sequences: sequenceDefinitions.map((value) => {
      const separator = value.indexOf(".");
      return { schema: value.slice(0, separator), name: value.slice(separator + 1) };
    }),
  };
}

async function copyOpenedArchive(
  source: FileHandle,
  destination: FileHandle,
  initialState: BigIntStats,
): Promise<number> {
  if (initialState.size > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Restore archive is too large to snapshot safely.");
  }
  const sizeBytes = Number(initialState.size);
  const buffer = Buffer.allocUnsafe(Math.min(sizeBytes, 1024 * 1024));
  let sourceOffset = 0;
  while (sourceOffset < sizeBytes) {
    const requested = Math.min(buffer.length, sizeBytes - sourceOffset);
    const { bytesRead } = await source.read(buffer, 0, requested, sourceOffset);
    if (bytesRead === 0) {
      throw new Error("Restore archive changed while its private snapshot was being created.");
    }
    let written = 0;
    while (written < bytesRead) {
      const { bytesWritten } = await destination.write(
        buffer,
        written,
        bytesRead - written,
        sourceOffset + written,
      );
      if (bytesWritten === 0) {
        throw new Error("Could not write the complete private restore archive snapshot.");
      }
      written += bytesWritten;
    }
    sourceOffset += bytesRead;
  }
  const finalState = await source.stat({ bigint: true });
  if (
    finalState.dev !== initialState.dev ||
    finalState.ino !== initialState.ino ||
    finalState.size !== initialState.size ||
    finalState.mtimeNs !== initialState.mtimeNs ||
    finalState.ctimeNs !== initialState.ctimeNs
  ) {
    throw new Error("Restore archive changed while its private snapshot was being created.");
  }
  await destination.sync();
  return sizeBytes;
}

async function prepareRestoreArchive(backupPath: string): Promise<{
  readonly archive: PreparedRestoreArchive;
  readonly cleanup: () => Promise<void>;
}> {
  const sourcePath = path.resolve(backupPath);
  const pathMetadata = await lstat(sourcePath, { bigint: true });
  if (pathMetadata.isSymbolicLink() || !pathMetadata.isFile() || pathMetadata.size === 0n) {
    throw new Error(`Restore archive must be a non-empty, non-symlink regular file: ${sourcePath}`);
  }

  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "schedule-restore-archive-"));
  const snapshotPath = path.join(temporaryDirectory, "archive.dump");
  let source: FileHandle | undefined;
  let destination: FileHandle | undefined;

  try {
    await chmod(temporaryDirectory, 0o700);
    const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
    source = await open(sourcePath, constants.O_RDONLY | noFollow);
    const openedMetadata = await source.stat({ bigint: true });
    if (
      !openedMetadata.isFile() ||
      openedMetadata.size <= 0n ||
      openedMetadata.dev !== pathMetadata.dev ||
      openedMetadata.ino !== pathMetadata.ino ||
      openedMetadata.size !== pathMetadata.size ||
      openedMetadata.mtimeNs !== pathMetadata.mtimeNs ||
      openedMetadata.ctimeNs !== pathMetadata.ctimeNs
    ) {
      throw new Error(`Restore archive path changed before it could be snapshotted: ${sourcePath}`);
    }
    destination = await open(snapshotPath, "wx", 0o600);
    const sizeBytes = await copyOpenedArchive(source, destination, openedMetadata);
    await destination.close();
    destination = undefined;
    await source.close();
    source = undefined;

    let cleanupPromise: Promise<void> | undefined;
    return {
      archive: { sourcePath, snapshotPath, sizeBytes },
      cleanup: () => {
        cleanupPromise ??= rm(temporaryDirectory, { recursive: true, force: true });
        return cleanupPromise;
      },
    };
  } catch (error) {
    await Promise.allSettled([source?.close(), destination?.close()]);
    try {
      await rm(temporaryDirectory, { recursive: true, force: true });
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Preparing a private restore archive failed and its temporary directory could not be removed.",
        { cause: cleanupError },
      );
    }
    throw error;
  }
}

export async function withPreparedRestoreArchive<Result>(
  backupPath: string,
  operation: (archive: PreparedRestoreArchive) => Promise<Result>,
): Promise<Result> {
  const prepared = await prepareRestoreArchive(backupPath);
  let operationCompleted = false;
  let operationResult: Result | undefined;
  let operationError: unknown;
  try {
    operationResult = await operation(prepared.archive);
    operationCompleted = true;
  } catch (error) {
    operationError = error;
  }
  let cleanupError: unknown;
  try {
    await prepared.cleanup();
  } catch (error) {
    cleanupError = error;
  }
  if (!operationCompleted) {
    if (cleanupError !== undefined) {
      throw new AggregateError(
        [operationError, cleanupError],
        "Restore archive processing failed and its private snapshot could not be removed.",
        { cause: operationError },
      );
    }
    throw operationError;
  }
  if (cleanupError !== undefined) throw cleanupError;
  return operationResult as Result;
}

export async function verifyBackup(
  backupPath: string,
  expectedCatalog?: ScheduleArchiveCatalog,
): Promise<ScheduleArchiveCatalog> {
  const resolvedPath = path.resolve(backupPath);
  const archive = await stat(resolvedPath);
  if (!archive.isFile() || archive.size === 0) {
    throw new Error(`Backup is missing or empty: ${resolvedPath}`);
  }

  const listing = await runComposeCommand(
    ["exec", "-T", composeDatabaseService, "pg_restore", "--list"],
    { inputPath: resolvedPath },
  );

  const catalog = parseArchiveCatalog(listing);
  if (expectedCatalog !== undefined) {
    const expectedTables = sortedUnique(expectedCatalog.tables);
    const expectedSequences = sortedUnique(
      expectedCatalog.sequences.map((sequence) => `${sequence.schema}.${sequence.name}`),
    );
    const actualSequences = catalog.sequences.map(
      (sequence) => `${sequence.schema}.${sequence.name}`,
    );
    if (
      JSON.stringify(catalog.tables) !== JSON.stringify(expectedTables) ||
      JSON.stringify(actualSequences) !== JSON.stringify(expectedSequences)
    ) {
      throw new Error(
        "Backup catalog does not exactly match the source database; the archive may be filtered or incomplete.",
      );
    }
  }
  return catalog;
}

export async function createBackup(
  outputPath = defaultBackupPath(),
  databaseName = composeDatabaseName,
): Promise<{
  readonly path: string;
  readonly sizeBytes: number;
}> {
  assertSafeDatabaseName(databaseName);
  const resolvedPath = path.resolve(outputPath);
  await assertComposeDatabaseReady(databaseName);
  const sourceCatalog = await readSourceCatalog(databaseName);
  await mkdir(path.dirname(resolvedPath), { recursive: true, mode: 0o700 });
  let dumpCompleted = false;

  try {
    await runComposeCommand(
      [
        "exec",
        "-T",
        composeDatabaseService,
        "pg_dump",
        "--username",
        composeDatabaseUser,
        "--dbname",
        databaseName,
        "--format=custom",
        "--compress=6",
        "--no-owner",
        "--no-privileges",
      ],
      { outputPath: resolvedPath },
    );
    dumpCompleted = true;
    await verifyBackup(resolvedPath, sourceCatalog);
  } catch (error) {
    if (dumpCompleted) await rm(resolvedPath, { force: true });
    throw error;
  }

  return { path: resolvedPath, sizeBytes: (await stat(resolvedPath)).size };
}

function requestedOutputPath(args: readonly string[]): string | undefined {
  const normalizedArgs = args.filter((arg) => arg !== "--");
  if (normalizedArgs.length === 0) return undefined;
  if (
    normalizedArgs.length === 2 &&
    normalizedArgs[0] === "--output" &&
    normalizedArgs[1] !== undefined
  ) {
    return normalizedArgs[1];
  }
  const inlineOutput = normalizedArgs.find((arg) => arg.startsWith("--output="));
  if (normalizedArgs.length === 1 && inlineOutput !== undefined) {
    return inlineOutput.slice("--output=".length);
  }
  throw new Error("Usage: pnpm db:backup [--output <path>]");
}

async function main(): Promise<void> {
  try {
    const result = await createBackup(requestedOutputPath(process.argv.slice(2)));
    console.log(`Backup created and verified: ${result.path}`);
    console.log(`Archive size: ${result.sizeBytes.toLocaleString("en-US")} bytes`);
  } catch (error) {
    console.error(`Database backup failed: ${errorMessage(error)}`);
    process.exitCode = 1;
  }
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(path.resolve(entryPoint)).href) {
  await main();
}
