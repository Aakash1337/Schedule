import {
  MaterializeNotificationIntents,
  type Clock,
  type MaterializeNotificationIntentsCommand,
  type MaterializeNotificationIntentsResult,
  type UnitOfWork,
} from "@schedule/application";
import type { WorkerConfig } from "@schedule/config";
import { DomainError, type WorkspaceId } from "@schedule/domain";

import type { NotificationMaterializationTelemetry } from "./observability.js";

export const MAXIMUM_AUTOMATIC_MATERIALIZATION_WORKSPACES = 20;

type NotificationMaterializationConfig = Pick<
  WorkerConfig,
  | "NOTIFICATION_MATERIALIZATION_MODE"
  | "NOTIFICATION_MATERIALIZATION_INTERVAL_MS"
  | "NOTIFICATION_MATERIALIZATION_LOOKAHEAD_MS"
>;

type SafeLogValue = string | number | boolean;
type SafeLogEntry = Readonly<Record<string, SafeLogValue>>;

export interface NotificationMaterializationLogger {
  info(entry: SafeLogEntry): void;
  error(entry: SafeLogEntry): void;
}

export interface NotificationMaterializationDependencies {
  readonly clock: Clock;
  /** Returns up to `limit + 1` rows so a broken local installation cap is detectable. */
  readonly listWorkspaces: (limit: number) => Promise<readonly { readonly id: WorkspaceId }[]>;
  readonly materialize: (
    command: MaterializeNotificationIntentsCommand,
    evaluatedAt: Date,
  ) => Promise<MaterializeNotificationIntentsResult>;
}

export interface NotificationMaterializationCycleSummary {
  readonly selectedWorkspaces: number;
  readonly attemptedWorkspaces: number;
  readonly skippedWorkspaces: number;
  readonly failedWorkspaces: number;
  readonly createdIntents: number;
  readonly existingIntents: number;
  readonly suppressedCandidates: number;
  readonly workspaceListFailed: boolean;
  readonly workspaceLimitExceeded: boolean;
  readonly aborted: boolean;
}

const defaultLogger: NotificationMaterializationLogger = {
  info: (entry) => console.info(JSON.stringify({ level: "info", ...entry })),
  error: (entry) => console.error(JSON.stringify({ level: "error", ...entry })),
};

const noOpTelemetry: NotificationMaterializationTelemetry = {
  recordNotificationMaterializationCycle: () => undefined,
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

function initialSummary(): NotificationMaterializationCycleSummary {
  return {
    selectedWorkspaces: 0,
    attemptedWorkspaces: 0,
    skippedWorkspaces: 0,
    failedWorkspaces: 0,
    createdIntents: 0,
    existingIntents: 0,
    suppressedCandidates: 0,
    workspaceListFailed: false,
    workspaceLimitExceeded: false,
    aborted: false,
  };
}

function isExpectedWorkspaceSkip(error: unknown): boolean {
  return (
    error instanceof DomainError &&
    (error.code === "notification_profile.not_found" || error.code === "workspace.not_found")
  );
}

function validTickInstant(clock: Clock): Date {
  const instant = new Date(clock.now().getTime());
  if (!Number.isFinite(instant.getTime())) {
    throw new RangeError("The notification materialization clock returned an invalid instant.");
  }
  return instant;
}

export function createNotificationMaterializationDependencies(
  unitOfWork: UnitOfWork,
  clock: Clock = { now: () => new Date() },
): NotificationMaterializationDependencies {
  return {
    clock,
    listWorkspaces: async (limit) =>
      await unitOfWork.run(async ({ workspaces }) => await workspaces.list(limit + 1, 0)),
    materialize: async (command, evaluatedAt) =>
      await new MaterializeNotificationIntents(unitOfWork, {
        now: () => new Date(evaluatedAt.getTime()),
      }).execute(command),
  };
}

export async function runNotificationMaterializationCycle(
  config: NotificationMaterializationConfig,
  dependencies: NotificationMaterializationDependencies,
  signal: AbortSignal,
  logger: NotificationMaterializationLogger = defaultLogger,
  telemetry: NotificationMaterializationTelemetry = noOpTelemetry,
): Promise<NotificationMaterializationCycleSummary> {
  if (config.NOTIFICATION_MATERIALIZATION_MODE === "disabled" || signal.aborted) {
    const summary = { ...initialSummary(), aborted: signal.aborted };
    if (config.NOTIFICATION_MATERIALIZATION_MODE === "enabled") {
      telemetry.recordNotificationMaterializationCycle(summary);
    }
    return summary;
  }

  const tickNow = validTickInstant(dependencies.clock);
  const fromInclusive = new Date(tickNow.getTime());
  const throughExclusive = new Date(
    tickNow.getTime() + config.NOTIFICATION_MATERIALIZATION_LOOKAHEAD_MS,
  );
  let summary = initialSummary();
  let workspaces: readonly { readonly id: WorkspaceId }[];

  try {
    workspaces = await dependencies.listWorkspaces(MAXIMUM_AUTOMATIC_MATERIALIZATION_WORKSPACES);
  } catch {
    summary = { ...summary, workspaceListFailed: true, aborted: signal.aborted };
    logger.error({
      event: "notification_materialization_workspace_list_failed",
      failureClass: "workspace_list_error",
    });
    telemetry.recordNotificationMaterializationCycle(summary);
    return summary;
  }

  if (workspaces.length > MAXIMUM_AUTOMATIC_MATERIALIZATION_WORKSPACES) {
    summary = { ...summary, workspaceLimitExceeded: true, aborted: signal.aborted };
    logger.error({
      event: "notification_materialization_workspace_limit_exceeded",
      failureClass: "local_installation_limit_violation",
      maximumWorkspaces: MAXIMUM_AUTOMATIC_MATERIALIZATION_WORKSPACES,
    });
    telemetry.recordNotificationMaterializationCycle(summary);
    return summary;
  }

  const selected = workspaces;
  summary = { ...summary, selectedWorkspaces: selected.length };

  for (const workspace of selected) {
    if (signal.aborted) break;
    summary = { ...summary, attemptedWorkspaces: summary.attemptedWorkspaces + 1 };
    try {
      const result = await dependencies.materialize(
        {
          workspaceId: workspace.id,
          fromInclusive: new Date(fromInclusive.getTime()),
          throughExclusive: new Date(throughExclusive.getTime()),
        },
        new Date(tickNow.getTime()),
      );
      summary = {
        ...summary,
        createdIntents: summary.createdIntents + result.created.length,
        existingIntents: summary.existingIntents + result.existing.length,
        suppressedCandidates: summary.suppressedCandidates + result.suppressed.length,
      };
    } catch (error) {
      if (isExpectedWorkspaceSkip(error)) {
        summary = { ...summary, skippedWorkspaces: summary.skippedWorkspaces + 1 };
      } else {
        summary = { ...summary, failedWorkspaces: summary.failedWorkspaces + 1 };
        logger.error({
          event: "notification_materialization_workspace_failed",
          failureClass: "materialization_error",
          workspaceId: workspace.id,
        });
      }
    }
  }

  summary = { ...summary, aborted: signal.aborted };
  logger.info({
    event: "notification_materialization_tick_completed",
    selectedWorkspaces: summary.selectedWorkspaces,
    attemptedWorkspaces: summary.attemptedWorkspaces,
    skippedWorkspaces: summary.skippedWorkspaces,
    failedWorkspaces: summary.failedWorkspaces,
    createdIntents: summary.createdIntents,
    existingIntents: summary.existingIntents,
    suppressedCandidates: summary.suppressedCandidates,
    aborted: summary.aborted,
  });
  telemetry.recordNotificationMaterializationCycle(summary);
  return summary;
}

export async function runNotificationMaterializationWorker(
  config: NotificationMaterializationConfig,
  dependencies: NotificationMaterializationDependencies,
  signal: AbortSignal,
  logger: NotificationMaterializationLogger = defaultLogger,
  telemetry: NotificationMaterializationTelemetry = noOpTelemetry,
): Promise<void> {
  if (config.NOTIFICATION_MATERIALIZATION_MODE === "disabled") return;

  while (!signal.aborted) {
    await runNotificationMaterializationCycle(config, dependencies, signal, logger, telemetry);
    if (!signal.aborted) {
      await sleep(config.NOTIFICATION_MATERIALIZATION_INTERVAL_MS, signal);
    }
  }
}
