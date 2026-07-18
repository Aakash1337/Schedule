import { describe, expect, it } from "vitest";

import { localDate } from "./calendar.js";
import { calculateDailyPlanFitEffectiveness } from "./daily-plan-fit-effectiveness.js";
import type { DailyPlanFitUsageOutcome } from "./daily-plan-fit-usage-outcome.js";
import { dailyPlanFitInsightFeedbackId, dailyPlanId, workspaceId } from "./ids.js";

const workspace = workspaceId("10000000-0000-4000-8000-000000000001");

function outcome(
  index: number,
  overrides: Partial<DailyPlanFitUsageOutcome> = {},
): DailyPlanFitUsageOutcome {
  const suffix = String(index).padStart(12, "0");
  const sourcePlanId = dailyPlanId(`20000000-0000-4000-8000-${suffix}`);
  return {
    usageId: dailyPlanFitInsightFeedbackId(`30000000-0000-4000-8000-${suffix}`),
    workspaceId: workspace,
    forDate: localDate(`2026-07-${String(10 + index).padStart(2, "0")}`),
    insightKey: String(index).repeat(64).slice(0, 64),
    recordedAt: new Date(`2026-07-${String(10 + index).padStart(2, "0")}T12:00:00.000Z`),
    sourcePlanId,
    currentPlanId: sourcePlanId,
    currentPlanRevision: 1,
    currentHeadVersion: 1,
    revisedSinceUsage: false,
    status: "resolved",
    suggestedTargetMinutes: 120,
    suggestedTargetTaskCount: 4,
    appliedTargetMinutes: 120,
    appliedTargetTaskCount: 4,
    usedExactSuggestion: true,
    plannedMinutes: 90,
    plannedTaskCount: 3,
    completedMinutes: 60,
    completedTaskCount: 2,
    ...overrides,
  };
}

describe("Daily Plan Fit effectiveness", () => {
  it("returns explicit zero totals and unavailable rates for an empty bounded sample", () => {
    expect(calculateDailyPlanFitEffectiveness([])).toEqual({
      usesConsidered: 0,
      resolvedUseCount: 0,
      pendingUseCount: 0,
      notEvaluableUseCount: 0,
      revisedUseCount: 0,
      eligibleResolvedUseCount: 0,
      exactSuggestionUseCount: 0,
      editedSuggestionUseCount: 0,
      appliedTargetMinutes: 0,
      scheduledMinutes: 0,
      completedMinutes: 0,
      appliedTargetTaskCount: 0,
      scheduledTaskCount: 0,
      completedTaskCount: 0,
      scheduledMinutesRateBasisPoints: null,
      scheduledTasksRateBasisPoints: null,
      completionMinutesRateBasisPoints: null,
      completionTasksRateBasisPoints: null,
    });
  });

  it("uses weighted resolved-unrevised totals while counting every outcome transparently", () => {
    const values = [
      outcome(1),
      outcome(2, {
        usedExactSuggestion: false,
        appliedTargetMinutes: 60,
        appliedTargetTaskCount: 2,
        plannedMinutes: 60,
        plannedTaskCount: 2,
        completedMinutes: 30,
        completedTaskCount: 1,
      }),
      outcome(3, {
        revisedSinceUsage: true,
        currentPlanId: dailyPlanId("20000000-0000-4000-8000-000000000099"),
      }),
      outcome(4, {
        status: "pending",
        usedExactSuggestion: false,
        completedMinutes: null,
        completedTaskCount: null,
      }),
      outcome(5, {
        status: "not_evaluable",
        currentPlanId: null,
        currentPlanRevision: null,
        currentHeadVersion: null,
        plannedMinutes: null,
        plannedTaskCount: null,
        completedMinutes: null,
        completedTaskCount: null,
      }),
    ];

    expect(calculateDailyPlanFitEffectiveness(values)).toEqual({
      usesConsidered: 5,
      resolvedUseCount: 3,
      pendingUseCount: 1,
      notEvaluableUseCount: 1,
      revisedUseCount: 1,
      eligibleResolvedUseCount: 2,
      exactSuggestionUseCount: 3,
      editedSuggestionUseCount: 2,
      appliedTargetMinutes: 180,
      scheduledMinutes: 150,
      completedMinutes: 90,
      appliedTargetTaskCount: 6,
      scheduledTaskCount: 5,
      completedTaskCount: 3,
      scheduledMinutesRateBasisPoints: 8_333,
      scheduledTasksRateBasisPoints: 8_333,
      completionMinutesRateBasisPoints: 6_000,
      completionTasksRateBasisPoints: 6_000,
    });
    expect(calculateDailyPlanFitEffectiveness([...values].reverse())).toEqual(
      calculateDailyPlanFitEffectiveness(values),
    );
  });

  it("rounds half-up in basis points and never clamps transparent target-fill anomalies", () => {
    expect(
      calculateDailyPlanFitEffectiveness([
        outcome(1, {
          appliedTargetMinutes: 3,
          appliedTargetTaskCount: 3,
          plannedMinutes: 1,
          plannedTaskCount: 1,
          completedMinutes: 1,
          completedTaskCount: 1,
        }),
      ]),
    ).toMatchObject({
      scheduledMinutesRateBasisPoints: 3_333,
      scheduledTasksRateBasisPoints: 3_333,
      completionMinutesRateBasisPoints: 10_000,
      completionTasksRateBasisPoints: 10_000,
    });
    expect(
      calculateDailyPlanFitEffectiveness([
        outcome(2, {
          appliedTargetMinutes: 1,
          appliedTargetTaskCount: 1,
          plannedMinutes: 3,
          plannedTaskCount: 3,
          completedMinutes: 3,
          completedTaskCount: 3,
        }),
      ]),
    ).toMatchObject({
      scheduledMinutesRateBasisPoints: 30_000,
      scheduledTasksRateBasisPoints: 30_000,
    });
  });

  it("fails closed on duplicate, cross-workspace, or malformed resolved evidence", () => {
    const first = outcome(1);
    expect(() => calculateDailyPlanFitEffectiveness([first, first])).toThrowError(/count one/i);
    expect(() =>
      calculateDailyPlanFitEffectiveness([
        first,
        outcome(2, { workspaceId: workspaceId("10000000-0000-4000-8000-000000000002") }),
      ]),
    ).toThrowError(/one workspace/i);
    expect(() =>
      calculateDailyPlanFitEffectiveness([outcome(3, { plannedMinutes: null })]),
    ).toThrowError(/scheduled and completed/i);
    expect(() =>
      calculateDailyPlanFitEffectiveness([outcome(4, { completedTaskCount: 4 })]),
    ).toThrowError(/cannot exceed/i);
  });
});
