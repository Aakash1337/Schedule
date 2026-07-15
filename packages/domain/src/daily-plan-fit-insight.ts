import { createHash } from "node:crypto";

import { addLocalDays, isValidLocalDate, type LocalDate } from "./calendar.js";
import { invariant } from "./errors.js";
import type { ActivityEventId, DailyPlanId, PlanItemId, WorkspaceId } from "./ids.js";
import {
  isTerminalPlanItemActivityState,
  planItemActivityStates,
  type PlanItemActivityState,
} from "./plan-item-activity.js";

export const dailyPlanFitInsightLookbackDays = 90;
export const dailyPlanFitInsightMinimumSamples = 3;
export const dailyPlanFitInsightMaximumSamples = 28;
export const dailyPlanFitInsightMaximumCandidatePlans = 90;
export const dailyPlanFitInsightMaximumItemsPerPlan = 512;
export const dailyPlanFitInsightMaximumScheduledMinutes = 43_200;

export const dailyPlanFitInsightStatuses = [
  "insufficient_history",
  "aligned",
  "suggested",
] as const;
export type DailyPlanFitInsightStatus = (typeof dailyPlanFitInsightStatuses)[number];

export const dailyPlanFitInsightDispositions = ["available", "dismissed"] as const;
export type DailyPlanFitInsightDisposition = (typeof dailyPlanFitInsightDispositions)[number];

export interface DailyPlanFitEvidenceItem {
  readonly id: PlanItemId;
  readonly scheduledMinutes: number;
  readonly activityState: PlanItemActivityState;
  readonly lastActivityEventId: ActivityEventId | null;
}

/** One current daily-plan head projected with its original targets and current item states. */
export interface DailyPlanFitEvidencePlan {
  readonly workspaceId: WorkspaceId;
  readonly planId: DailyPlanId;
  readonly date: LocalDate;
  readonly targetMinutes: number;
  readonly targetTaskCount: number;
  readonly items: readonly DailyPlanFitEvidenceItem[];
}

/** Read-only guidance; applying its target pair is deliberately a separate UI action. */
export interface DailyPlanFitInsight {
  readonly status: DailyPlanFitInsightStatus;
  readonly insightKey: string | null;
  readonly disposition: DailyPlanFitInsightDisposition;
  readonly dismissedAt: Date | null;
  readonly forDate: LocalDate;
  readonly windowStartedOn: LocalDate;
  readonly windowEndedOn: LocalDate;
  readonly lookbackDays: number;
  readonly sampleCount: number;
  readonly minimumSamples: number;
  readonly maximumSamples: number;
  readonly evaluatedAt: Date;
  readonly typicalPlannedMinutes: number | null;
  readonly typicalCompletedMinutes: number | null;
  readonly materialThresholdMinutes: number | null;
  readonly typicalPlannedTaskCount: number | null;
  readonly typicalCompletedTaskCount: number | null;
  readonly materialThresholdTaskCount: number | null;
  readonly suggestedTargetMinutes: number | null;
  readonly suggestedTargetTaskCount: number | null;
}

interface CanonicalResolvedSample {
  readonly planId: DailyPlanId;
  readonly date: LocalDate;
  readonly targetMinutes: number;
  readonly targetTaskCount: number;
  readonly completedMinutes: number;
  readonly completedTaskCount: number;
  readonly items: readonly {
    readonly id: PlanItemId;
    readonly scheduledMinutes: number;
    readonly activityState: PlanItemActivityState;
    readonly lastActivityEventId: ActivityEventId;
  }[];
}

function positiveWhole(value: number, code: string, message: string, maximum: number): void {
  invariant(Number.isSafeInteger(value) && value >= 1 && value <= maximum, code, message);
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle]!;
  return Math.floor((sorted[middle - 1]! + sorted[middle]!) / 2 + 0.5);
}

function nearestQuarterHour(value: number): number {
  return Math.floor(value / 15 + 0.5) * 15;
}

function canonicalResolvedSample(plan: DailyPlanFitEvidencePlan): CanonicalResolvedSample | null {
  positiveWhole(
    plan.targetMinutes,
    "daily_plan_fit_insight.target_minutes_invalid",
    "Plan Fit evidence requires a valid positive target-minute snapshot.",
    dailyPlanFitInsightMaximumScheduledMinutes,
  );
  positiveWhole(
    plan.targetTaskCount,
    "daily_plan_fit_insight.target_task_count_invalid",
    "Plan Fit evidence requires a valid positive target-task snapshot.",
    dailyPlanFitInsightMaximumItemsPerPlan,
  );
  invariant(
    plan.items.length <= dailyPlanFitInsightMaximumItemsPerPlan,
    "daily_plan_fit_insight.item_limit_exceeded",
    "A Plan Fit evidence plan exceeds the bounded item limit.",
  );
  if (plan.items.length === 0) return null;

  const seenItems = new Set<PlanItemId>();
  const items = plan.items.map((item) => {
    invariant(
      !seenItems.has(item.id),
      "daily_plan_fit_insight.duplicate_item",
      "A plan item appears more than once in Plan Fit evidence.",
    );
    seenItems.add(item.id);
    positiveWhole(
      item.scheduledMinutes,
      "daily_plan_fit_insight.scheduled_minutes_invalid",
      "Plan Fit item evidence requires positive scheduled minutes.",
      dailyPlanFitInsightMaximumScheduledMinutes,
    );
    invariant(
      planItemActivityStates.some((state) => state === item.activityState),
      "daily_plan_fit_insight.activity_state_invalid",
      "Plan Fit evidence contains an unsupported activity state.",
    );
    if (!isTerminalPlanItemActivityState(item.activityState)) return null;
    invariant(
      item.lastActivityEventId !== null,
      "daily_plan_fit_insight.activity_event_missing",
      "Resolved Plan Fit evidence requires the terminal activity event identity.",
    );
    return {
      id: item.id,
      scheduledMinutes: item.scheduledMinutes,
      activityState: item.activityState,
      lastActivityEventId: item.lastActivityEventId,
    };
  });
  if (items.some((item) => item === null)) return null;

  const resolvedItems = (items as Exclude<(typeof items)[number], null>[]).sort((left, right) =>
    left.id.localeCompare(right.id, "en"),
  );
  const completedItems = resolvedItems.filter((item) => item.activityState === "completed");
  return {
    planId: plan.planId,
    date: plan.date,
    targetMinutes: plan.targetMinutes,
    targetTaskCount: plan.targetTaskCount,
    completedMinutes: completedItems.reduce((total, item) => total + item.scheduledMinutes, 0),
    completedTaskCount: completedItems.length,
    items: resolvedItems,
  };
}

function actionableInsightKey(
  forDate: LocalDate,
  windowStartedOn: LocalDate,
  windowEndedOn: LocalDate,
  evidence: readonly CanonicalResolvedSample[],
): string {
  const canonical = {
    calculation: "daily-plan-fit-insight-v1",
    policy: {
      lookbackDays: dailyPlanFitInsightLookbackDays,
      minimumSamples: dailyPlanFitInsightMinimumSamples,
      maximumSamples: dailyPlanFitInsightMaximumSamples,
      completedWorkload: "scheduled-minutes-for-completed-items",
      minuteRounding: "nearest-15-half-up-minimum-30",
      minuteMateriality: "max-30-or-20-percent-ceiled-to-15",
      taskMateriality: "max-1-or-25-percent-ceiled",
      direction: "downward-only",
    },
    forDate,
    windowStartedOn,
    windowEndedOn,
    evidence,
  } as const;
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

/**
 * Derives a bounded, deterministic joint time/task target from fully resolved current plan heads.
 * Skips and deferrals help close a plan but never count as completed workload.
 */
export function calculateDailyPlanFitInsight(
  workspaceId: WorkspaceId,
  forDate: LocalDate,
  evidencePlans: readonly DailyPlanFitEvidencePlan[],
  evaluatedAt: Date,
): DailyPlanFitInsight {
  invariant(
    isValidLocalDate(forDate),
    "daily_plan_fit_insight.for_date_invalid",
    "A valid Plan Fit local date is required.",
  );
  invariant(
    evaluatedAt instanceof Date && Number.isFinite(evaluatedAt.getTime()),
    "daily_plan_fit_insight.evaluated_at_invalid",
    "A valid Plan Fit evaluation timestamp is required.",
  );
  invariant(
    evidencePlans.length <= dailyPlanFitInsightMaximumCandidatePlans,
    "daily_plan_fit_insight.candidate_limit_exceeded",
    "Plan Fit evidence exceeds the bounded candidate window.",
  );

  const windowStartedOn = addLocalDays(forDate, -dailyPlanFitInsightLookbackDays);
  const windowEndedOn = addLocalDays(forDate, -1);
  const seenPlans = new Set<DailyPlanId>();
  const resolved: CanonicalResolvedSample[] = [];
  for (const plan of evidencePlans) {
    invariant(
      plan.workspaceId === workspaceId,
      "daily_plan_fit_insight.workspace_mismatch",
      "Plan Fit evidence must belong to the requested workspace.",
    );
    invariant(
      isValidLocalDate(plan.date),
      "daily_plan_fit_insight.plan_date_invalid",
      "Plan Fit evidence requires a valid plan date.",
    );
    invariant(
      !seenPlans.has(plan.planId),
      "daily_plan_fit_insight.duplicate_plan",
      "A current plan appears more than once in Plan Fit evidence.",
    );
    seenPlans.add(plan.planId);
    if (plan.date < windowStartedOn || plan.date > windowEndedOn) continue;
    const sample = canonicalResolvedSample(plan);
    if (sample !== null) resolved.push(sample);
  }

  const selected = resolved
    .sort(
      (left, right) =>
        right.date.localeCompare(left.date, "en") || right.planId.localeCompare(left.planId, "en"),
    )
    .slice(0, dailyPlanFitInsightMaximumSamples)
    .sort(
      (left, right) =>
        left.date.localeCompare(right.date, "en") || left.planId.localeCompare(right.planId, "en"),
    );
  const base = {
    disposition: "available",
    dismissedAt: null,
    forDate,
    windowStartedOn,
    windowEndedOn,
    lookbackDays: dailyPlanFitInsightLookbackDays,
    sampleCount: selected.length,
    minimumSamples: dailyPlanFitInsightMinimumSamples,
    maximumSamples: dailyPlanFitInsightMaximumSamples,
    evaluatedAt: new Date(evaluatedAt),
  } as const;
  if (selected.length < dailyPlanFitInsightMinimumSamples) {
    return {
      ...base,
      status: "insufficient_history",
      insightKey: null,
      typicalPlannedMinutes: null,
      typicalCompletedMinutes: null,
      materialThresholdMinutes: null,
      typicalPlannedTaskCount: null,
      typicalCompletedTaskCount: null,
      materialThresholdTaskCount: null,
      suggestedTargetMinutes: null,
      suggestedTargetTaskCount: null,
    };
  }

  const typicalPlannedMinutes = median(selected.map((sample) => sample.targetMinutes));
  const typicalCompletedMinutes = median(selected.map((sample) => sample.completedMinutes));
  const typicalPlannedTaskCount = median(selected.map((sample) => sample.targetTaskCount));
  const typicalCompletedTaskCount = median(selected.map((sample) => sample.completedTaskCount));
  const materialThresholdMinutes = Math.max(30, Math.ceil((typicalPlannedMinutes * 0.2) / 15) * 15);
  const materialThresholdTaskCount = Math.max(1, Math.ceil(typicalPlannedTaskCount * 0.25));
  const proposedMinutes = Math.min(
    typicalPlannedMinutes,
    Math.max(30, nearestQuarterHour(typicalCompletedMinutes)),
  );
  const proposedTaskCount = Math.min(
    typicalPlannedTaskCount,
    Math.max(1, typicalCompletedTaskCount),
  );
  const minuteSuggestionIsMaterial =
    proposedMinutes < typicalPlannedMinutes &&
    typicalPlannedMinutes - typicalCompletedMinutes >= materialThresholdMinutes;
  const taskSuggestionIsMaterial =
    proposedTaskCount < typicalPlannedTaskCount &&
    typicalPlannedTaskCount - typicalCompletedTaskCount >= materialThresholdTaskCount;
  const shared = {
    ...base,
    typicalPlannedMinutes,
    typicalCompletedMinutes,
    materialThresholdMinutes,
    typicalPlannedTaskCount,
    typicalCompletedTaskCount,
    materialThresholdTaskCount,
  } as const;

  if (!minuteSuggestionIsMaterial && !taskSuggestionIsMaterial) {
    return {
      ...shared,
      status: "aligned",
      insightKey: null,
      suggestedTargetMinutes: null,
      suggestedTargetTaskCount: null,
    };
  }
  return {
    ...shared,
    status: "suggested",
    insightKey: actionableInsightKey(forDate, windowStartedOn, windowEndedOn, selected),
    suggestedTargetMinutes: proposedMinutes,
    suggestedTargetTaskCount: proposedTaskCount,
  };
}
