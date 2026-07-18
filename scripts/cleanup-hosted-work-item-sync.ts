import path from "node:path";
import { pathToFileURL } from "node:url";

import { loadWorkerConfig } from "../packages/config/src/index.js";
import {
  createDatabase,
  DEFAULT_HOSTED_WORK_ITEM_SYNC_MINIMUM_RETENTION_MS,
  DEFAULT_HOSTED_WORK_ITEM_SYNC_PURGE_BATCH_SIZE,
  MAX_HOSTED_WORK_ITEM_SYNC_MINIMUM_RETENTION_MS,
  MAX_HOSTED_WORK_ITEM_SYNC_PURGE_BATCH_SIZE,
  MIN_HOSTED_WORK_ITEM_SYNC_MINIMUM_RETENTION_MS,
  purgeHostedWorkItemSyncChanges,
  type DatabaseConnection,
} from "../packages/database/src/index.js";

const dayMilliseconds = 86_400_000;
const maximumBatches = 1_000;

export interface HostedWorkItemSyncCleanupOptions {
  readonly retentionDays: number;
  readonly batchSize: number;
  readonly maxBatches: number;
}

export const hostedWorkItemSyncCleanupDefaults: HostedWorkItemSyncCleanupOptions = {
  retentionDays: DEFAULT_HOSTED_WORK_ITEM_SYNC_MINIMUM_RETENTION_MS / dayMilliseconds,
  batchSize: DEFAULT_HOSTED_WORK_ITEM_SYNC_PURGE_BATCH_SIZE,
  maxBatches: 100,
};

export const hostedWorkItemSyncCleanupBounds = {
  retentionDays: {
    minimum: MIN_HOSTED_WORK_ITEM_SYNC_MINIMUM_RETENTION_MS / dayMilliseconds,
    maximum: MAX_HOSTED_WORK_ITEM_SYNC_MINIMUM_RETENTION_MS / dayMilliseconds,
  },
  batchSize: { minimum: 1, maximum: MAX_HOSTED_WORK_ITEM_SYNC_PURGE_BATCH_SIZE },
  maxBatches: { minimum: 1, maximum: maximumBatches },
} as const;

export interface HostedWorkItemSyncCleanupSummary {
  readonly batches: number;
  readonly deletedChanges: number;
  readonly workspacesTouched: number;
  readonly limitReached: boolean;
}

interface CleanupConnection {
  close(): Promise<void>;
}

interface PurgeResult {
  readonly workspaceId: string | null;
  readonly minimumCursor: string | null;
  readonly deletedChanges: number;
}

export interface HostedWorkItemSyncCleanupDependencies<Connection extends CleanupConnection> {
  readonly connection: Connection;
  readonly now: () => Date;
  readonly purgeBatch: (
    connection: Connection,
    options: {
      readonly now: Date;
      readonly minimumRetentionMs: number;
      readonly batchSize: number;
    },
  ) => Promise<PurgeResult>;
}

const usage =
  "Usage: pnpm hosted-sync:cleanup -- [--retention-days 90] [--batch-size 250] [--max-batches 100]";

function argumentError(message: string): Error {
  return new Error(`${message}\n${usage}`);
}

function boundedInteger(value: string, option: string, minimum: number, maximum: number): number {
  if (!/^(0|[1-9][0-9]*)$/u.test(value)) {
    throw argumentError(`${option} must be a canonical whole number.`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw argumentError(`${option} must be between ${String(minimum)} and ${String(maximum)}.`);
  }
  return parsed;
}

export function parseHostedWorkItemSyncCleanupArguments(
  arguments_: readonly string[],
): HostedWorkItemSyncCleanupOptions {
  const tokens = arguments_.filter((value) => value !== "--");
  const values = new Map<string, string>();
  const allowed = new Set(["--retention-days", "--batch-size", "--max-batches"]);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined || !token.startsWith("--")) {
      throw argumentError(`Unexpected argument: ${token ?? ""}`);
    }
    const separator = token.indexOf("=");
    const option = separator < 0 ? token : token.slice(0, separator);
    if (!allowed.has(option)) throw argumentError(`Unknown option: ${option}`);
    if (values.has(option)) throw argumentError(`Option may only be supplied once: ${option}`);
    const value = separator < 0 ? tokens[index + 1] : token.slice(separator + 1);
    if (value === undefined || value === "" || (separator < 0 && value.startsWith("--"))) {
      throw argumentError(`Option requires a value: ${option}`);
    }
    if (separator < 0) index += 1;
    values.set(option, value);
  }

  const read = (
    option: string,
    fallback: number,
    bounds: { readonly minimum: number; readonly maximum: number },
  ): number => {
    const value = values.get(option);
    return value === undefined
      ? fallback
      : boundedInteger(value, option, bounds.minimum, bounds.maximum);
  };
  return {
    retentionDays: read(
      "--retention-days",
      hostedWorkItemSyncCleanupDefaults.retentionDays,
      hostedWorkItemSyncCleanupBounds.retentionDays,
    ),
    batchSize: read(
      "--batch-size",
      hostedWorkItemSyncCleanupDefaults.batchSize,
      hostedWorkItemSyncCleanupBounds.batchSize,
    ),
    maxBatches: read(
      "--max-batches",
      hostedWorkItemSyncCleanupDefaults.maxBatches,
      hostedWorkItemSyncCleanupBounds.maxBatches,
    ),
  };
}

export async function cleanupHostedWorkItemSync<Connection extends CleanupConnection>(
  options: HostedWorkItemSyncCleanupOptions,
  dependencies: HostedWorkItemSyncCleanupDependencies<Connection>,
): Promise<HostedWorkItemSyncCleanupSummary> {
  let summary: HostedWorkItemSyncCleanupSummary | undefined;
  let failure: unknown;
  try {
    for (const [name, value, bounds] of [
      ["retentionDays", options.retentionDays, hostedWorkItemSyncCleanupBounds.retentionDays],
      ["batchSize", options.batchSize, hostedWorkItemSyncCleanupBounds.batchSize],
      ["maxBatches", options.maxBatches, hostedWorkItemSyncCleanupBounds.maxBatches],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < bounds.minimum || value > bounds.maximum) {
        throw new Error(`Sync cleanup received an invalid ${name} value.`);
      }
    }
    const now = dependencies.now();
    if (!Number.isFinite(now.getTime())) throw new Error("Sync cleanup requires a valid clock.");
    let batches = 0;
    let deletedChanges = 0;
    const workspaces = new Set<string>();
    let limitReached = true;
    for (let attempt = 0; attempt < options.maxBatches; attempt += 1) {
      const result = await dependencies.purgeBatch(dependencies.connection, {
        now,
        minimumRetentionMs: options.retentionDays * dayMilliseconds,
        batchSize: options.batchSize,
      });
      if (
        !Number.isSafeInteger(result.deletedChanges) ||
        result.deletedChanges < 0 ||
        result.deletedChanges > options.batchSize ||
        (result.deletedChanges === 0
          ? result.workspaceId !== null || result.minimumCursor !== null
          : result.workspaceId === null ||
            result.minimumCursor === null ||
            !/^[1-9][0-9]*$/u.test(result.minimumCursor))
      ) {
        throw new Error("Sync cleanup received an invalid purge result.");
      }
      if (result.deletedChanges === 0) {
        limitReached = false;
        break;
      }
      batches += 1;
      deletedChanges += result.deletedChanges;
      if (!Number.isSafeInteger(deletedChanges)) {
        throw new Error("Sync cleanup deletion count exceeded safe integer bounds.");
      }
      workspaces.add(result.workspaceId!);
    }
    summary = {
      batches,
      deletedChanges,
      workspacesTouched: workspaces.size,
      limitReached,
    };
  } catch (error) {
    failure = error;
  }
  try {
    await dependencies.connection.close();
  } catch (closeError) {
    failure =
      failure === undefined
        ? closeError
        : new AggregateError([failure, closeError], "Sync cleanup and database close both failed.");
  }
  if (failure !== undefined) throw failure;
  if (summary === undefined) throw new Error("Sync cleanup did not produce a summary.");
  return summary;
}

export async function runHostedWorkItemSyncCleanup(
  options: HostedWorkItemSyncCleanupOptions,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<HostedWorkItemSyncCleanupSummary> {
  const connection = createDatabase(loadWorkerConfig(environment).DATABASE_URL, 1);
  return cleanupHostedWorkItemSync<DatabaseConnection>(options, {
    connection,
    now: () => new Date(),
    purgeBatch: purgeHostedWorkItemSyncChanges,
  });
}

async function main(): Promise<void> {
  try {
    const summary = await runHostedWorkItemSyncCleanup(
      parseHostedWorkItemSyncCleanupArguments(process.argv.slice(2)),
    );
    console.log(JSON.stringify(summary));
  } catch (error) {
    console.error(
      `Hosted work-item sync cleanup failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exitCode = 1;
  }
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(path.resolve(entryPoint)).href) {
  await main();
}
