import type { WorkerConfig } from "@schedule/config";
import {
  purgeHostedWorkItemSyncChanges,
  type DatabaseConnection,
  type PurgeHostedWorkItemSyncChangesOptions,
  type PurgeHostedWorkItemSyncChangesResult,
} from "@schedule/database";

import type { HostedSyncCleanupTelemetry } from "./observability.js";

const DAY_MILLISECONDS = 86_400_000;

type HostedSyncCleanupConfig = Pick<
  WorkerConfig,
  | "HOSTED_WORK_ITEM_SYNC_CLEANUP_MODE"
  | "HOSTED_WORK_ITEM_SYNC_CLEANUP_INTERVAL_MS"
  | "HOSTED_WORK_ITEM_SYNC_CLEANUP_RETENTION_DAYS"
  | "HOSTED_WORK_ITEM_SYNC_CLEANUP_BATCH_SIZE"
  | "HOSTED_WORK_ITEM_SYNC_CLEANUP_MAX_BATCHES"
>;

type SafeLogEntry = Readonly<Record<string, string | number | boolean>>;

export interface HostedSyncCleanupLogger {
  info(entry: SafeLogEntry): void;
  error(entry: SafeLogEntry): void;
}

export interface HostedSyncCleanupDependencies {
  readonly now: () => Date;
  readonly purgeBatch: (
    options: PurgeHostedWorkItemSyncChangesOptions,
  ) => Promise<PurgeHostedWorkItemSyncChangesResult>;
}

export interface HostedSyncCleanupCycleSummary {
  readonly batches: number;
  readonly deletedChanges: number;
  readonly workspacesTouched: number;
  readonly failed: boolean;
  readonly contended: boolean;
  readonly limitReached: boolean;
  readonly aborted: boolean;
}

const defaultLogger: HostedSyncCleanupLogger = {
  info: (entry) => console.info(JSON.stringify({ level: "info", ...entry })),
  error: (entry) => console.error(JSON.stringify({ level: "error", ...entry })),
};

const noOpTelemetry: HostedSyncCleanupTelemetry = {
  recordHostedSyncCleanupCycle: () => undefined,
};

const sleep = (milliseconds: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });

const emptySummary = (): HostedSyncCleanupCycleSummary => ({
  batches: 0,
  deletedChanges: 0,
  workspacesTouched: 0,
  failed: false,
  contended: false,
  limitReached: false,
  aborted: false,
});

function validPurgeResult(
  result: PurgeHostedWorkItemSyncChangesResult,
  batchSize: number,
): boolean {
  return (
    Number.isSafeInteger(result.deletedChanges) &&
    result.deletedChanges >= 0 &&
    result.deletedChanges <= batchSize &&
    typeof result.contended === "boolean" &&
    (result.deletedChanges === 0
      ? result.workspaceId === null && result.minimumCursor === null
      : result.workspaceId !== null &&
        result.minimumCursor !== null &&
        !result.contended &&
        /^[1-9][0-9]*$/u.test(result.minimumCursor))
  );
}

export function createHostedSyncCleanupDependencies(
  connection: DatabaseConnection,
  now: () => Date = () => new Date(),
): HostedSyncCleanupDependencies {
  return {
    now,
    purgeBatch: async (options) => await purgeHostedWorkItemSyncChanges(connection, options),
  };
}

export async function runHostedSyncCleanupCycle(
  config: HostedSyncCleanupConfig,
  dependencies: HostedSyncCleanupDependencies,
  signal: AbortSignal,
  logger: HostedSyncCleanupLogger = defaultLogger,
  telemetry: HostedSyncCleanupTelemetry = noOpTelemetry,
): Promise<HostedSyncCleanupCycleSummary> {
  if (config.HOSTED_WORK_ITEM_SYNC_CLEANUP_MODE === "disabled") return emptySummary();
  if (signal.aborted) {
    const summary = { ...emptySummary(), aborted: true };
    telemetry.recordHostedSyncCleanupCycle(summary);
    return summary;
  }

  let summary = emptySummary();
  const workspaces = new Set<string>();
  try {
    const now = new Date(dependencies.now().getTime());
    if (!Number.isFinite(now.getTime())) throw new RangeError("Invalid cleanup clock.");

    for (
      let attempt = 0;
      attempt < config.HOSTED_WORK_ITEM_SYNC_CLEANUP_MAX_BATCHES && !signal.aborted;
      attempt += 1
    ) {
      const result = await dependencies.purgeBatch({
        now,
        minimumRetentionMs: config.HOSTED_WORK_ITEM_SYNC_CLEANUP_RETENTION_DAYS * DAY_MILLISECONDS,
        batchSize: config.HOSTED_WORK_ITEM_SYNC_CLEANUP_BATCH_SIZE,
      });
      if (!validPurgeResult(result, config.HOSTED_WORK_ITEM_SYNC_CLEANUP_BATCH_SIZE)) {
        throw new Error("Invalid hosted sync cleanup result.");
      }
      if (result.deletedChanges === 0) {
        summary = { ...summary, contended: result.contended };
        break;
      }

      workspaces.add(result.workspaceId!);
      summary = {
        ...summary,
        batches: summary.batches + 1,
        deletedChanges: summary.deletedChanges + result.deletedChanges,
        workspacesTouched: workspaces.size,
      };
    }

    summary = {
      ...summary,
      limitReached:
        !signal.aborted && summary.batches === config.HOSTED_WORK_ITEM_SYNC_CLEANUP_MAX_BATCHES,
      aborted: signal.aborted,
    };
  } catch {
    summary = { ...summary, failed: true, aborted: signal.aborted };
    logger.error({
      event: "hosted_sync_cleanup_cycle_failed",
      failureClass: "cleanup_error",
    });
  }

  logger.info({
    event: "hosted_sync_cleanup_cycle_completed",
    batches: summary.batches,
    deletedChanges: summary.deletedChanges,
    workspacesTouched: summary.workspacesTouched,
    failed: summary.failed,
    contended: summary.contended,
    limitReached: summary.limitReached,
    aborted: summary.aborted,
  });
  telemetry.recordHostedSyncCleanupCycle(summary);
  return summary;
}

export async function runHostedSyncCleanupWorker(
  config: HostedSyncCleanupConfig,
  dependencies: HostedSyncCleanupDependencies,
  signal: AbortSignal,
  logger: HostedSyncCleanupLogger = defaultLogger,
  telemetry: HostedSyncCleanupTelemetry = noOpTelemetry,
): Promise<void> {
  if (config.HOSTED_WORK_ITEM_SYNC_CLEANUP_MODE === "disabled") return;

  while (!signal.aborted) {
    await runHostedSyncCleanupCycle(config, dependencies, signal, logger, telemetry);
    if (!signal.aborted) {
      await sleep(config.HOSTED_WORK_ITEM_SYNC_CLEANUP_INTERVAL_MS, signal);
    }
  }
}
