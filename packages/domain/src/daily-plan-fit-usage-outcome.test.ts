import { describe, expect, it } from "vitest";

import { localDate } from "./calendar.js";
import { createDailyPlanFitInsightFeedback } from "./daily-plan-fit-insight-feedback.js";
import { calculateDailyPlanFitUsageOutcome } from "./daily-plan-fit-usage-outcome.js";
import type { DailyPlan, PlanItem } from "./daily-planning.js";
import {
  activityEventId,
  dailyPlanFitInsightFeedbackId,
  dailyPlanId,
  planItemId,
  routineId,
  workspaceId,
} from "./ids.js";

const workspace = workspaceId("10000000-0000-4000-8000-000000000001");
const sourcePlanId = dailyPlanId("20000000-0000-4000-8000-000000000001");

function usage() {
  return createDailyPlanFitInsightFeedback({
    id: dailyPlanFitInsightFeedbackId("30000000-0000-4000-8000-000000000001"),
    ingestedSequence: 1,
    workspaceId: workspace,
    forDate: localDate("2026-07-15"),
    insightKey: "a".repeat(64),
    kind: "used",
    planId: sourcePlanId,
    sampleCount: 5,
    typicalPlannedMinutes: 180,
    typicalCompletedMinutes: 90,
    typicalPlannedTaskCount: 4,
    typicalCompletedTaskCount: 2,
    suggestedTargetMinutes: 90,
    suggestedTargetTaskCount: 2,
    appliedTargetMinutes: 105,
    appliedTargetTaskCount: 3,
    idempotencyKey: `plan-fit-used:${sourcePlanId}`,
    recordedAt: new Date("2026-07-15T12:00:00.000Z"),
  });
}

function item(position: number, activityState: PlanItem["activityState"]): PlanItem {
  return {
    id: planItemId(`40000000-0000-5000-a000-00000000000${position}`),
    sourceType: "routine",
    routineId: routineId(`50000000-0000-4000-8000-00000000000${position}`),
    workItemId: null,
    title: `Routine ${position}`,
    position,
    windowIndex: 0,
    scheduledMinutes: position === 1 ? 60 : 45,
    partialSession: false,
    score: 10,
    scoreComponents: {},
    reasons: [],
    locked: false,
    activityState,
    lastActivityEventId:
      activityState === "pending"
        ? null
        : activityEventId(`60000000-0000-4000-8000-00000000000${position}`),
    activityUpdatedAt: activityState === "pending" ? null : new Date("2026-07-15T18:00:00.000Z"),
  };
}

function plan(
  overrides: Partial<DailyPlan> = {},
  items: readonly PlanItem[] = [item(1, "completed"), item(2, "skipped")],
): DailyPlan {
  return {
    id: sourcePlanId,
    workspaceId: workspace,
    date: localDate("2026-07-15"),
    timeZone: "America/La_Paz",
    items,
    totalMinutes: items.reduce((total, candidate) => total + candidate.scheduledMinutes, 0),
    fitness: 10,
    algorithmVersion: "deterministic-planner-v6",
    configVersion: "default-weights-v4",
    prngVersion: "mulberry32-v1",
    seed: "usage-outcome",
    requestRevision: 1,
    inputHash: "b".repeat(64),
    inputSnapshot: {},
    exclusions: [],
    warnings: [],
    generatedAt: new Date("2026-07-15T12:00:00.000Z"),
    ...overrides,
  };
}

describe("Daily Plan Fit usage outcomes", () => {
  it("reports only terminal completed workload and preserves edited-target provenance", () => {
    const outcome = calculateDailyPlanFitUsageOutcome(usage(), {
      plan: plan(),
      headVersion: 1,
    });

    expect(outcome).toMatchObject({
      status: "resolved",
      sourcePlanId,
      currentPlanId: sourcePlanId,
      revisedSinceUsage: false,
      suggestedTargetMinutes: 90,
      suggestedTargetTaskCount: 2,
      appliedTargetMinutes: 105,
      appliedTargetTaskCount: 3,
      usedExactSuggestion: false,
      plannedMinutes: 105,
      plannedTaskCount: 2,
      completedMinutes: 60,
      completedTaskCount: 1,
    });
  });

  it("withholds partial outcomes and identifies a later current revision", () => {
    const revisedPlanId = dailyPlanId("20000000-0000-4000-8000-000000000002");
    const outcome = calculateDailyPlanFitUsageOutcome(usage(), {
      plan: plan({ id: revisedPlanId, requestRevision: 2 }, [
        item(1, "completed"),
        item(2, "pending"),
      ]),
      headVersion: 2,
    });

    expect(outcome).toMatchObject({
      status: "pending",
      currentPlanId: revisedPlanId,
      currentPlanRevision: 2,
      currentHeadVersion: 2,
      revisedSinceUsage: true,
      completedMinutes: null,
      completedTaskCount: null,
    });
  });

  it("marks missing or empty current plans as not evaluable", () => {
    expect(calculateDailyPlanFitUsageOutcome(usage(), null)).toMatchObject({
      status: "not_evaluable",
      currentPlanId: null,
    });
    expect(
      calculateDailyPlanFitUsageOutcome(usage(), { plan: plan({}, []), headVersion: 1 }),
    ).toMatchObject({
      status: "not_evaluable",
      plannedMinutes: 0,
      plannedTaskCount: 0,
    });
  });

  it("rejects non-usage events and cross-date evidence", () => {
    const dismissed = createDailyPlanFitInsightFeedback({
      ...usage(),
      kind: "dismissed",
      planId: null,
      appliedTargetMinutes: null,
      appliedTargetTaskCount: null,
      idempotencyKey: "dismissed",
    });
    expect(() => calculateDailyPlanFitUsageOutcome(dismissed, null)).toThrowError(
      /canonical used event/i,
    );
    expect(() =>
      calculateDailyPlanFitUsageOutcome(usage(), {
        plan: plan({ date: localDate("2026-07-16") }),
        headVersion: 1,
      }),
    ).toThrowError(/workspace and date/i);
  });
});
