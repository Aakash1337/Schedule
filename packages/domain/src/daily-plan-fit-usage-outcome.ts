import { invariant } from "./errors.js";
import type { DailyPlanFitInsightFeedback } from "./daily-plan-fit-insight-feedback.js";
import type { DailyPlan } from "./daily-planning.js";
import { isTerminalPlanItemActivityState } from "./plan-item-activity.js";

export const dailyPlanFitUsageOutcomeStatuses = ["pending", "resolved", "not_evaluable"] as const;
export type DailyPlanFitUsageOutcomeStatus = (typeof dailyPlanFitUsageOutcomeStatuses)[number];

export interface DailyPlanFitUsageCurrentPlan {
  readonly plan: DailyPlan;
  readonly headVersion: number;
}

/** A bounded, read-only comparison. It is never an input to planner scoring. */
export interface DailyPlanFitUsageOutcome {
  readonly usageId: DailyPlanFitInsightFeedback["id"];
  readonly workspaceId: DailyPlanFitInsightFeedback["workspaceId"];
  readonly forDate: DailyPlanFitInsightFeedback["forDate"];
  readonly insightKey: string;
  readonly recordedAt: Date;
  readonly sourcePlanId: DailyPlan["id"];
  readonly currentPlanId: DailyPlan["id"] | null;
  readonly currentPlanRevision: number | null;
  readonly currentHeadVersion: number | null;
  readonly revisedSinceUsage: boolean;
  readonly status: DailyPlanFitUsageOutcomeStatus;
  readonly suggestedTargetMinutes: number;
  readonly suggestedTargetTaskCount: number;
  readonly appliedTargetMinutes: number;
  readonly appliedTargetTaskCount: number;
  readonly usedExactSuggestion: boolean;
  readonly plannedMinutes: number | null;
  readonly plannedTaskCount: number | null;
  readonly completedMinutes: number | null;
  readonly completedTaskCount: number | null;
}

export function calculateDailyPlanFitUsageOutcome(
  usage: DailyPlanFitInsightFeedback,
  current: DailyPlanFitUsageCurrentPlan | null,
): DailyPlanFitUsageOutcome {
  invariant(
    usage.kind === "used" &&
      usage.planId !== null &&
      usage.appliedTargetMinutes !== null &&
      usage.appliedTargetTaskCount !== null,
    "daily_plan_fit_insight.usage_invalid",
    "A Plan Fit outcome requires a canonical used event.",
  );

  const base = {
    usageId: usage.id,
    workspaceId: usage.workspaceId,
    forDate: usage.forDate,
    insightKey: usage.insightKey,
    recordedAt: new Date(usage.recordedAt),
    sourcePlanId: usage.planId,
    suggestedTargetMinutes: usage.suggestedTargetMinutes,
    suggestedTargetTaskCount: usage.suggestedTargetTaskCount,
    appliedTargetMinutes: usage.appliedTargetMinutes,
    appliedTargetTaskCount: usage.appliedTargetTaskCount,
    usedExactSuggestion:
      usage.suggestedTargetMinutes === usage.appliedTargetMinutes &&
      usage.suggestedTargetTaskCount === usage.appliedTargetTaskCount,
  } as const;

  if (current === null) {
    return {
      ...base,
      currentPlanId: null,
      currentPlanRevision: null,
      currentHeadVersion: null,
      revisedSinceUsage: false,
      status: "not_evaluable",
      plannedMinutes: null,
      plannedTaskCount: null,
      completedMinutes: null,
      completedTaskCount: null,
    };
  }

  invariant(
    current.plan.workspaceId === usage.workspaceId && current.plan.date === usage.forDate,
    "daily_plan_fit_insight.usage_plan_mismatch",
    "Plan Fit outcome evidence must belong to the usage workspace and date.",
  );
  const plan = current.plan;
  const common = {
    ...base,
    currentPlanId: plan.id,
    currentPlanRevision: plan.requestRevision,
    currentHeadVersion: current.headVersion,
    revisedSinceUsage: plan.id !== usage.planId,
    plannedMinutes: plan.totalMinutes,
    plannedTaskCount: plan.items.length,
  } as const;
  if (plan.items.length === 0) {
    return {
      ...common,
      status: "not_evaluable",
      completedMinutes: null,
      completedTaskCount: null,
    };
  }
  if (!plan.items.every((item) => isTerminalPlanItemActivityState(item.activityState))) {
    return {
      ...common,
      status: "pending",
      completedMinutes: null,
      completedTaskCount: null,
    };
  }
  const completed = plan.items.filter((item) => item.activityState === "completed");
  return {
    ...common,
    status: "resolved",
    completedMinutes: completed.reduce((total, item) => total + item.scheduledMinutes, 0),
    completedTaskCount: completed.length,
  };
}
