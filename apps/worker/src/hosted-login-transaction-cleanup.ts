import { PruneHostedLoginTransactions } from "@schedule/application";
import type { WorkerConfig } from "@schedule/config";
import {
  PostgresHostedLoginTransactionUnitOfWork,
  type DatabaseConnection,
} from "@schedule/database";

import type { HostedLoginTransactionCleanupTelemetry } from "./observability.js";

type HostedLoginTransactionCleanupConfig = Pick<
  WorkerConfig,
  | "HOSTED_LOGIN_TRANSACTION_CLEANUP_MODE"
  | "HOSTED_LOGIN_TRANSACTION_CLEANUP_INTERVAL_MS"
  | "HOSTED_LOGIN_TRANSACTION_CLEANUP_BATCH_SIZE"
>;

type SafeLogEntry = Readonly<Record<string, string | number | boolean>>;

export interface HostedLoginTransactionCleanupLogger {
  info(entry: SafeLogEntry): void;
  error(entry: SafeLogEntry): void;
}

export interface HostedLoginTransactionCleanupDependencies {
  prune(limit: number): Promise<number>;
}

export interface HostedLoginTransactionCleanupCycleSummary {
  readonly deletedTransactions: number;
  readonly failed: boolean;
  readonly aborted: boolean;
}

const defaultLogger: HostedLoginTransactionCleanupLogger = {
  info: (entry) => console.info(JSON.stringify({ level: "info", ...entry })),
  error: (entry) => console.error(JSON.stringify({ level: "error", ...entry })),
};

const noOpTelemetry: HostedLoginTransactionCleanupTelemetry = {
  recordHostedLoginTransactionCleanupCycle: () => undefined,
};

const emptySummary = (): HostedLoginTransactionCleanupCycleSummary => ({
  deletedTransactions: 0,
  failed: false,
  aborted: false,
});

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

export function createHostedLoginTransactionCleanupDependencies(
  connection: DatabaseConnection,
): HostedLoginTransactionCleanupDependencies {
  const prune = new PruneHostedLoginTransactions(
    new PostgresHostedLoginTransactionUnitOfWork(connection),
  );
  return { prune: async (limit) => await prune.execute(limit) };
}

export async function runHostedLoginTransactionCleanupCycle(
  config: HostedLoginTransactionCleanupConfig,
  dependencies: HostedLoginTransactionCleanupDependencies,
  signal: AbortSignal,
  logger: HostedLoginTransactionCleanupLogger = defaultLogger,
  telemetry: HostedLoginTransactionCleanupTelemetry = noOpTelemetry,
): Promise<HostedLoginTransactionCleanupCycleSummary> {
  if (config.HOSTED_LOGIN_TRANSACTION_CLEANUP_MODE === "disabled") return emptySummary();
  if (signal.aborted) {
    const summary = { ...emptySummary(), aborted: true };
    telemetry.recordHostedLoginTransactionCleanupCycle(summary);
    return summary;
  }

  let summary = emptySummary();
  try {
    const deletedTransactions = await dependencies.prune(
      config.HOSTED_LOGIN_TRANSACTION_CLEANUP_BATCH_SIZE,
    );
    if (
      !Number.isSafeInteger(deletedTransactions) ||
      deletedTransactions < 0 ||
      deletedTransactions > config.HOSTED_LOGIN_TRANSACTION_CLEANUP_BATCH_SIZE
    ) {
      throw new Error("Invalid hosted login transaction cleanup result.");
    }
    summary = { ...summary, deletedTransactions, aborted: signal.aborted };
  } catch {
    summary = { ...summary, failed: true, aborted: signal.aborted };
    logger.error({
      event: "hosted_login_transaction_cleanup_cycle_failed",
      failureClass: "cleanup_error",
    });
  }

  logger.info({
    event: "hosted_login_transaction_cleanup_cycle_completed",
    deletedTransactions: summary.deletedTransactions,
    failed: summary.failed,
    aborted: summary.aborted,
  });
  telemetry.recordHostedLoginTransactionCleanupCycle(summary);
  return summary;
}

export async function runHostedLoginTransactionCleanupWorker(
  config: HostedLoginTransactionCleanupConfig,
  dependencies: HostedLoginTransactionCleanupDependencies,
  signal: AbortSignal,
  logger: HostedLoginTransactionCleanupLogger = defaultLogger,
  telemetry: HostedLoginTransactionCleanupTelemetry = noOpTelemetry,
): Promise<void> {
  if (config.HOSTED_LOGIN_TRANSACTION_CLEANUP_MODE === "disabled") return;
  while (!signal.aborted) {
    await runHostedLoginTransactionCleanupCycle(config, dependencies, signal, logger, telemetry);
    if (!signal.aborted) {
      await sleep(config.HOSTED_LOGIN_TRANSACTION_CLEANUP_INTERVAL_MS, signal);
    }
  }
}
