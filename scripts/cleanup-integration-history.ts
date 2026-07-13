import path from "node:path";
import { pathToFileURL } from "node:url";

import { loadWorkerConfig } from "../packages/config/src/index.js";
import {
  createDatabase,
  DEFAULT_INTEGRATION_MINIMUM_RETENTION_MS,
  MAX_INTEGRATION_MINIMUM_RETENTION_MS,
  MAX_INTEGRATION_PURGE_BATCH_SIZE,
  MIN_INTEGRATION_MINIMUM_RETENTION_MS,
  purgeIntegrationHistory,
  type DatabaseConnection,
} from "../packages/database/src/index.js";

const dayMilliseconds = 24 * 60 * 60 * 1_000;

export const integrationHistoryCleanupDefaults = {
  retentionDays: DEFAULT_INTEGRATION_MINIMUM_RETENTION_MS / dayMilliseconds,
  batchSize: MAX_INTEGRATION_PURGE_BATCH_SIZE,
  maxBatches: 100,
} as const;

export const integrationHistoryCleanupBounds = {
  retentionDays: {
    minimum: MIN_INTEGRATION_MINIMUM_RETENTION_MS / dayMilliseconds,
    maximum: MAX_INTEGRATION_MINIMUM_RETENTION_MS / dayMilliseconds,
  },
  batchSize: { minimum: 1, maximum: MAX_INTEGRATION_PURGE_BATCH_SIZE },
  maxBatches: { minimum: 1, maximum: 1_000 },
} as const;

export interface IntegrationHistoryCleanupOptions {
  readonly retentionDays: number;
  readonly batchSize: number;
  readonly maxBatches: number;
}

export interface IntegrationHistoryPurgeResult {
  readonly deletedRequests: number;
  readonly deletedConfirmations: number;
  readonly totalDeleted: number;
}

export interface IntegrationHistoryCleanupSummary extends IntegrationHistoryPurgeResult {
  readonly batches: number;
  /** True when the bounded run stopped after its final allowed non-empty batch. */
  readonly limitReached: boolean;
}

interface ClosableConnection {
  close(): Promise<void>;
}

export interface IntegrationHistoryCleanupDependencies<TConnection extends ClosableConnection> {
  readonly connection: TConnection;
  readonly now: () => Date;
  readonly purgeBatch: (
    connection: TConnection,
    options: {
      readonly now: Date;
      readonly minimumRetentionMs: number;
      readonly batchSize: number;
    },
  ) => Promise<IntegrationHistoryPurgeResult>;
}

const usage =
  "Usage: pnpm integration:cleanup -- [--retention-days 90] [--batch-size 1000] [--max-batches 100]";

function argumentError(message: string): Error {
  return new Error(`${message}\n${usage}`);
}

function parseIntegerOption(
  value: string,
  option: string,
  bounds: { readonly minimum: number; readonly maximum: number },
): number {
  if (!/^(0|[1-9][0-9]*)$/.test(value)) {
    throw argumentError(`${option} must be a whole number.`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < bounds.minimum || parsed > bounds.maximum) {
    throw argumentError(
      `${option} must be between ${String(bounds.minimum)} and ${String(bounds.maximum)}.`,
    );
  }
  return parsed;
}

export function parseIntegrationHistoryCleanupArguments(
  args: readonly string[],
): IntegrationHistoryCleanupOptions {
  const tokens = args.filter((argument) => argument !== "--");
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

    const inlineValue = separator < 0 ? undefined : token.slice(separator + 1);
    const followingValue = separator < 0 ? tokens[index + 1] : undefined;
    const value = inlineValue ?? followingValue;
    if (value === undefined || value === "" || (separator < 0 && value.startsWith("--"))) {
      throw argumentError(`Option requires a value: ${option}`);
    }
    if (separator < 0) index += 1;
    values.set(option, value);
  }

  return {
    retentionDays:
      values.get("--retention-days") === undefined
        ? integrationHistoryCleanupDefaults.retentionDays
        : parseIntegerOption(
            values.get("--retention-days")!,
            "--retention-days",
            integrationHistoryCleanupBounds.retentionDays,
          ),
    batchSize:
      values.get("--batch-size") === undefined
        ? integrationHistoryCleanupDefaults.batchSize
        : parseIntegerOption(
            values.get("--batch-size")!,
            "--batch-size",
            integrationHistoryCleanupBounds.batchSize,
          ),
    maxBatches:
      values.get("--max-batches") === undefined
        ? integrationHistoryCleanupDefaults.maxBatches
        : parseIntegerOption(
            values.get("--max-batches")!,
            "--max-batches",
            integrationHistoryCleanupBounds.maxBatches,
          ),
  };
}

function assertPurgeResult(
  result: IntegrationHistoryPurgeResult,
  batchSize: number,
): IntegrationHistoryPurgeResult {
  const counts = [result.deletedRequests, result.deletedConfirmations, result.totalDeleted];
  if (counts.some((count) => !Number.isSafeInteger(count) || count < 0)) {
    throw new Error("Integration history purge returned an invalid deletion count.");
  }
  if (result.deletedRequests > batchSize || result.deletedConfirmations > batchSize) {
    throw new Error("Integration history purge exceeded its bounded batch size.");
  }
  if (result.totalDeleted !== result.deletedRequests + result.deletedConfirmations) {
    throw new Error("Integration history purge returned inconsistent deletion counts.");
  }
  return result;
}

export async function cleanupIntegrationHistory<TConnection extends ClosableConnection>(
  options: IntegrationHistoryCleanupOptions,
  dependencies: IntegrationHistoryCleanupDependencies<TConnection>,
): Promise<IntegrationHistoryCleanupSummary> {
  let summary: IntegrationHistoryCleanupSummary | undefined;
  let operationError: unknown;

  try {
    for (const [name, value, bounds] of [
      ["retentionDays", options.retentionDays, integrationHistoryCleanupBounds.retentionDays],
      ["batchSize", options.batchSize, integrationHistoryCleanupBounds.batchSize],
      ["maxBatches", options.maxBatches, integrationHistoryCleanupBounds.maxBatches],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < bounds.minimum || value > bounds.maximum) {
        throw new Error(`Integration history cleanup received an invalid ${name} value.`);
      }
    }

    const now = dependencies.now();
    if (!Number.isFinite(now.getTime())) {
      throw new Error("Integration history cleanup requires a valid current time.");
    }

    let batches = 0;
    let deletedRequests = 0;
    let deletedConfirmations = 0;

    for (let attempt = 0; attempt < options.maxBatches; attempt += 1) {
      const result = assertPurgeResult(
        await dependencies.purgeBatch(dependencies.connection, {
          now,
          minimumRetentionMs: options.retentionDays * dayMilliseconds,
          batchSize: options.batchSize,
        }),
        options.batchSize,
      );
      if (result.totalDeleted === 0) break;

      batches += 1;
      deletedRequests += result.deletedRequests;
      deletedConfirmations += result.deletedConfirmations;
      if (!Number.isSafeInteger(deletedRequests) || !Number.isSafeInteger(deletedConfirmations)) {
        throw new Error(
          "Integration history cleanup deletion counts exceeded safe integer bounds.",
        );
      }
    }

    summary = {
      batches,
      deletedRequests,
      deletedConfirmations,
      totalDeleted: deletedRequests + deletedConfirmations,
      limitReached: batches === options.maxBatches,
    };
  } catch (error) {
    operationError = error;
  }

  try {
    await dependencies.connection.close();
  } catch (closeError) {
    operationError =
      operationError === undefined
        ? closeError
        : new AggregateError(
            [operationError, closeError],
            "Integration history cleanup and database close both failed.",
          );
  }

  if (operationError !== undefined) throw operationError;
  if (summary === undefined)
    throw new Error("Integration history cleanup did not produce a summary.");
  return summary;
}

export function formatIntegrationHistoryCleanupSummary(
  summary: IntegrationHistoryCleanupSummary,
): string {
  return JSON.stringify(summary);
}

export async function runIntegrationHistoryCleanup(
  options: IntegrationHistoryCleanupOptions,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<IntegrationHistoryCleanupSummary> {
  const config = loadWorkerConfig(environment);
  const connection = createDatabase(config.DATABASE_URL, 1);
  return cleanupIntegrationHistory<DatabaseConnection>(options, {
    connection,
    now: () => new Date(),
    purgeBatch: async (activeConnection, purgeOptions) =>
      purgeIntegrationHistory(activeConnection, purgeOptions),
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main(): Promise<void> {
  try {
    const options = parseIntegrationHistoryCleanupArguments(process.argv.slice(2));
    const summary = await runIntegrationHistoryCleanup(options);
    console.log(formatIntegrationHistoryCleanupSummary(summary));
  } catch (error) {
    console.error(`Integration history cleanup failed: ${errorMessage(error)}`);
    process.exitCode = 1;
  }
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(path.resolve(entryPoint)).href) {
  await main();
}
