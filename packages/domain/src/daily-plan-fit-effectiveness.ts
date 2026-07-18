import { invariant } from "./errors.js";
import type { DailyPlanFitUsageOutcome } from "./daily-plan-fit-usage-outcome.js";

/**
 * Bounded descriptive totals derived from explicit Plan Fit uses. These values never feed planner
 * scoring, model prompts, or automatic adaptation.
 */
export interface DailyPlanFitEffectiveness {
  readonly usesConsidered: number;
  readonly resolvedUseCount: number;
  readonly pendingUseCount: number;
  readonly notEvaluableUseCount: number;
  /** Overlaps the status counts; revised outcomes are excluded from every rate. */
  readonly revisedUseCount: number;
  readonly eligibleResolvedUseCount: number;
  readonly exactSuggestionUseCount: number;
  readonly editedSuggestionUseCount: number;
  readonly appliedTargetMinutes: number;
  readonly scheduledMinutes: number;
  readonly completedMinutes: number;
  readonly appliedTargetTaskCount: number;
  readonly scheduledTaskCount: number;
  readonly completedTaskCount: number;
  /** Scheduled workload divided by the submitted editable target, in basis points. */
  readonly scheduledMinutesRateBasisPoints: number | null;
  readonly scheduledTasksRateBasisPoints: number | null;
  /** Completed workload divided by scheduled workload, in basis points. */
  readonly completionMinutesRateBasisPoints: number | null;
  readonly completionTasksRateBasisPoints: number | null;
}

function safeWholeNumber(value: number, minimum: number, label: string): number {
  invariant(
    Number.isSafeInteger(value) && value >= minimum,
    "daily_plan_fit_insight.effectiveness_value_invalid",
    `${label} must be a safe whole number of at least ${String(minimum)}.`,
  );
  return value;
}

function safeAdd(left: number, right: number, label: string): number {
  const total = left + right;
  invariant(
    Number.isSafeInteger(total),
    "daily_plan_fit_insight.effectiveness_total_invalid",
    `${label} exceeds the supported aggregate range.`,
  );
  return total;
}

function ratioBasisPoints(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  const rounded = (BigInt(numerator) * 10_000n + BigInt(denominator) / 2n) / BigInt(denominator);
  const value = Number(rounded);
  invariant(
    Number.isSafeInteger(value),
    "daily_plan_fit_insight.effectiveness_rate_invalid",
    "A Plan Fit effectiveness rate exceeds the supported range.",
  );
  return value;
}

/**
 * Aggregates newest-first usage outcomes without averaging per-plan percentages. Only resolved,
 * unrevised current heads contribute to totals and rates; every use still contributes to counts.
 */
export function calculateDailyPlanFitEffectiveness(
  outcomes: readonly DailyPlanFitUsageOutcome[],
): DailyPlanFitEffectiveness {
  const workspaceId = outcomes[0]?.workspaceId;
  const usageIds = new Set<string>();
  let resolvedUseCount = 0;
  let pendingUseCount = 0;
  let notEvaluableUseCount = 0;
  let revisedUseCount = 0;
  let eligibleResolvedUseCount = 0;
  let exactSuggestionUseCount = 0;
  let editedSuggestionUseCount = 0;
  let appliedTargetMinutes = 0;
  let scheduledMinutes = 0;
  let completedMinutes = 0;
  let appliedTargetTaskCount = 0;
  let scheduledTaskCount = 0;
  let completedTaskCount = 0;

  for (const outcome of outcomes) {
    invariant(
      workspaceId === outcome.workspaceId,
      "daily_plan_fit_insight.effectiveness_workspace_mismatch",
      "Plan Fit effectiveness outcomes must belong to one workspace.",
    );
    invariant(
      !usageIds.has(outcome.usageId),
      "daily_plan_fit_insight.effectiveness_duplicate_usage",
      "Plan Fit effectiveness cannot count one explicit use twice.",
    );
    usageIds.add(outcome.usageId);
    safeWholeNumber(outcome.appliedTargetMinutes, 1, "Applied target minutes");
    safeWholeNumber(outcome.appliedTargetTaskCount, 1, "Applied target task count");

    switch (outcome.status) {
      case "resolved":
        resolvedUseCount += 1;
        break;
      case "pending":
        pendingUseCount += 1;
        break;
      case "not_evaluable":
        notEvaluableUseCount += 1;
        break;
      default:
        invariant(
          false,
          "daily_plan_fit_insight.effectiveness_status_invalid",
          "Plan Fit effectiveness requires a supported outcome status.",
        );
    }
    if (outcome.revisedSinceUsage) revisedUseCount += 1;
    if (outcome.usedExactSuggestion) {
      exactSuggestionUseCount += 1;
    } else {
      editedSuggestionUseCount += 1;
    }
    if (outcome.status !== "resolved" || outcome.revisedSinceUsage) continue;

    invariant(
      outcome.plannedMinutes !== null &&
        outcome.plannedTaskCount !== null &&
        outcome.completedMinutes !== null &&
        outcome.completedTaskCount !== null,
      "daily_plan_fit_insight.effectiveness_resolved_shape_invalid",
      "An eligible resolved Plan Fit outcome must include scheduled and completed workload.",
    );
    const nextScheduledMinutes = safeWholeNumber(outcome.plannedMinutes, 1, "Scheduled minutes");
    const nextScheduledTasks = safeWholeNumber(outcome.plannedTaskCount, 1, "Scheduled task count");
    const nextCompletedMinutes = safeWholeNumber(outcome.completedMinutes, 0, "Completed minutes");
    const nextCompletedTasks = safeWholeNumber(
      outcome.completedTaskCount,
      0,
      "Completed task count",
    );
    invariant(
      nextCompletedMinutes <= nextScheduledMinutes && nextCompletedTasks <= nextScheduledTasks,
      "daily_plan_fit_insight.effectiveness_completion_invalid",
      "Completed Plan Fit workload cannot exceed its scheduled workload.",
    );

    eligibleResolvedUseCount += 1;
    appliedTargetMinutes = safeAdd(
      appliedTargetMinutes,
      outcome.appliedTargetMinutes,
      "Applied target minutes",
    );
    scheduledMinutes = safeAdd(scheduledMinutes, nextScheduledMinutes, "Scheduled minutes");
    completedMinutes = safeAdd(completedMinutes, nextCompletedMinutes, "Completed minutes");
    appliedTargetTaskCount = safeAdd(
      appliedTargetTaskCount,
      outcome.appliedTargetTaskCount,
      "Applied target task count",
    );
    scheduledTaskCount = safeAdd(scheduledTaskCount, nextScheduledTasks, "Scheduled task count");
    completedTaskCount = safeAdd(completedTaskCount, nextCompletedTasks, "Completed task count");
  }

  return {
    usesConsidered: outcomes.length,
    resolvedUseCount,
    pendingUseCount,
    notEvaluableUseCount,
    revisedUseCount,
    eligibleResolvedUseCount,
    exactSuggestionUseCount,
    editedSuggestionUseCount,
    appliedTargetMinutes,
    scheduledMinutes,
    completedMinutes,
    appliedTargetTaskCount,
    scheduledTaskCount,
    completedTaskCount,
    scheduledMinutesRateBasisPoints: ratioBasisPoints(scheduledMinutes, appliedTargetMinutes),
    scheduledTasksRateBasisPoints: ratioBasisPoints(scheduledTaskCount, appliedTargetTaskCount),
    completionMinutesRateBasisPoints: ratioBasisPoints(completedMinutes, scheduledMinutes),
    completionTasksRateBasisPoints: ratioBasisPoints(completedTaskCount, scheduledTaskCount),
  };
}
