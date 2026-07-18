import {
  addLocalDays,
  daysBetweenLocalDates,
  isValidLocalDate,
  type LocalDate,
} from "./calendar.js";
import type { DailyPlan } from "./daily-planning.js";
import { invariant } from "./errors.js";
import type { WorkspaceId } from "./ids.js";

export const planningOutcomesLookbackDays = 30;
const minimumPlanningOutcomeVersionPlansForRates = 3;

export interface PlanningOutcomeVersionSegment {
  readonly algorithmVersion: string;
  readonly configVersion: string;
  readonly plansConsidered: number;
  readonly plannedTaskCount: number;
  readonly completedTaskCount: number;
  readonly plannedMinutes: number;
  readonly completedMinutes: number;
  readonly completionTasksRateBasisPoints: number | null;
  readonly completionMinutesRateBasisPoints: number | null;
}

/** Descriptive current-head outcomes. These values never alter planning or model input. */
export interface PlanningOutcomes {
  readonly forDate: LocalDate;
  readonly windowStartedOn: LocalDate;
  readonly windowEndedOn: LocalDate;
  readonly plansConsidered: number;
  readonly plannedTaskCount: number;
  readonly completedTaskCount: number;
  readonly skippedTaskCount: number;
  readonly deferredTaskCount: number;
  readonly dismissedTaskCount: number;
  readonly plannedMinutes: number;
  readonly completedMinutes: number;
  readonly skippedMinutes: number;
  readonly deferredMinutes: number;
  readonly dismissedMinutes: number;
  readonly additionalPlanRevisionCount: number;
  readonly completionTasksRateBasisPoints: number | null;
  readonly completionMinutesRateBasisPoints: number | null;
  readonly versionSegments: readonly PlanningOutcomeVersionSegment[];
}

interface MutableVersionSegment {
  readonly algorithmVersion: string;
  readonly configVersion: string;
  plansConsidered: number;
  plannedTaskCount: number;
  completedTaskCount: number;
  plannedMinutes: number;
  completedMinutes: number;
}

function safeAdd(left: number, right: number): number {
  const result = left + right;
  invariant(
    Number.isSafeInteger(result),
    "planning.outcomes_total_invalid",
    "Planning outcome totals exceed the supported range.",
  );
  return result;
}

function rate(numerator: number, denominator: number): number | null {
  if (denominator === 0) return null;
  return Number((BigInt(numerator) * 10_000n + BigInt(denominator) / 2n) / BigInt(denominator));
}

function ordinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Aggregates one authoritative current plan per prior local date using weighted totals. */
export function calculatePlanningOutcomes(
  workspaceId: WorkspaceId,
  forDate: LocalDate,
  plans: readonly DailyPlan[],
): PlanningOutcomes {
  invariant(
    isValidLocalDate(forDate),
    "planning.outcomes_date_invalid",
    "A valid planning-outcomes local date is required.",
  );
  const windowStartedOn = addLocalDays(forDate, -planningOutcomesLookbackDays);
  const windowEndedOn = addLocalDays(forDate, -1);
  const dates = new Set<LocalDate>();
  let plannedTaskCount = 0;
  let completedTaskCount = 0;
  let skippedTaskCount = 0;
  let deferredTaskCount = 0;
  let dismissedTaskCount = 0;
  let plannedMinutes = 0;
  let completedMinutes = 0;
  let skippedMinutes = 0;
  let deferredMinutes = 0;
  let dismissedMinutes = 0;
  let additionalPlanRevisionCount = 0;
  const segmentsByAlgorithm = new Map<string, Map<string, MutableVersionSegment>>();

  for (const plan of plans) {
    invariant(
      workspaceId === plan.workspaceId,
      "planning.outcomes_workspace_mismatch",
      "Planning outcomes must belong to one workspace.",
    );
    const daysFromStart = daysBetweenLocalDates(windowStartedOn, plan.date);
    invariant(
      daysFromStart >= 0 && daysFromStart < planningOutcomesLookbackDays,
      "planning.outcomes_plan_outside_window",
      "A planning-outcomes plan falls outside the requested window.",
    );
    invariant(
      !dates.has(plan.date),
      "planning.outcomes_duplicate_date",
      "Planning outcomes cannot count one local date twice.",
    );
    invariant(
      Number.isSafeInteger(plan.requestRevision) && plan.requestRevision >= 1,
      "planning.outcomes_revision_invalid",
      "A planning-outcomes plan revision must be positive.",
    );
    invariant(
      plan.algorithmVersion.trim().length > 0 &&
        plan.algorithmVersion.length <= 120 &&
        plan.configVersion.trim().length > 0 &&
        plan.configVersion.length <= 120,
      "planning.outcomes_version_invalid",
      "Planning outcomes require bounded planner and configuration versions.",
    );
    dates.add(plan.date);

    let segmentsByConfig = segmentsByAlgorithm.get(plan.algorithmVersion);
    if (segmentsByConfig === undefined) {
      segmentsByConfig = new Map();
      segmentsByAlgorithm.set(plan.algorithmVersion, segmentsByConfig);
    }
    let segment = segmentsByConfig.get(plan.configVersion);
    if (segment === undefined) {
      segment = {
        algorithmVersion: plan.algorithmVersion,
        configVersion: plan.configVersion,
        plansConsidered: 0,
        plannedTaskCount: 0,
        completedTaskCount: 0,
        plannedMinutes: 0,
        completedMinutes: 0,
      };
      segmentsByConfig.set(plan.configVersion, segment);
    }
    segment.plansConsidered = safeAdd(segment.plansConsidered, 1);

    let planMinutes = 0;
    for (const item of plan.items) {
      invariant(
        Number.isSafeInteger(item.scheduledMinutes) && item.scheduledMinutes > 0,
        "planning.outcomes_minutes_invalid",
        "Planning outcomes require positive scheduled minutes.",
      );
      plannedTaskCount = safeAdd(plannedTaskCount, 1);
      plannedMinutes = safeAdd(plannedMinutes, item.scheduledMinutes);
      segment.plannedTaskCount = safeAdd(segment.plannedTaskCount, 1);
      segment.plannedMinutes = safeAdd(segment.plannedMinutes, item.scheduledMinutes);
      planMinutes = safeAdd(planMinutes, item.scheduledMinutes);
      switch (item.activityState) {
        case "completed":
          completedTaskCount = safeAdd(completedTaskCount, 1);
          completedMinutes = safeAdd(completedMinutes, item.scheduledMinutes);
          segment.completedTaskCount = safeAdd(segment.completedTaskCount, 1);
          segment.completedMinutes = safeAdd(segment.completedMinutes, item.scheduledMinutes);
          break;
        case "skipped":
          skippedTaskCount = safeAdd(skippedTaskCount, 1);
          skippedMinutes = safeAdd(skippedMinutes, item.scheduledMinutes);
          break;
        case "deferred":
          deferredTaskCount = safeAdd(deferredTaskCount, 1);
          deferredMinutes = safeAdd(deferredMinutes, item.scheduledMinutes);
          break;
        case "dismissed":
          dismissedTaskCount = safeAdd(dismissedTaskCount, 1);
          dismissedMinutes = safeAdd(dismissedMinutes, item.scheduledMinutes);
          break;
      }
    }
    invariant(
      planMinutes === plan.totalMinutes,
      "planning.outcomes_plan_total_mismatch",
      "Planning outcomes require a consistent plan total.",
    );
    additionalPlanRevisionCount = safeAdd(additionalPlanRevisionCount, plan.requestRevision - 1);
  }

  const versionSegments = [...segmentsByAlgorithm.values()]
    .flatMap((segmentsByConfig) => [...segmentsByConfig.values()])
    .map((segment): PlanningOutcomeVersionSegment => ({
      ...segment,
      completionTasksRateBasisPoints:
        segment.plansConsidered < minimumPlanningOutcomeVersionPlansForRates
          ? null
          : rate(segment.completedTaskCount, segment.plannedTaskCount),
      completionMinutesRateBasisPoints:
        segment.plansConsidered < minimumPlanningOutcomeVersionPlansForRates
          ? null
          : rate(segment.completedMinutes, segment.plannedMinutes),
    }))
    .sort(
      (left, right) =>
        right.plansConsidered - left.plansConsidered ||
        ordinal(left.algorithmVersion, right.algorithmVersion) ||
        ordinal(left.configVersion, right.configVersion),
    );

  return {
    forDate,
    windowStartedOn,
    windowEndedOn,
    plansConsidered: dates.size,
    plannedTaskCount,
    completedTaskCount,
    skippedTaskCount,
    deferredTaskCount,
    dismissedTaskCount,
    plannedMinutes,
    completedMinutes,
    skippedMinutes,
    deferredMinutes,
    dismissedMinutes,
    additionalPlanRevisionCount,
    completionTasksRateBasisPoints: rate(completedTaskCount, plannedTaskCount),
    completionMinutesRateBasisPoints: rate(completedMinutes, plannedMinutes),
    versionSegments,
  };
}
