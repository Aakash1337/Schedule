import { describe, expect, it } from "vitest";

import { localDate } from "./calendar.js";
import type { DailyPlan, PlanItem } from "./daily-planning.js";
import { dailyPlanId, planItemId, routineId, workspaceId } from "./ids.js";
import { calculatePlanningOutcomes } from "./planning-outcomes.js";

const workspace = workspaceId("10000000-0000-4000-8000-000000000001");

function item(index: number, minutes: number, completed: boolean): PlanItem {
  const suffix = String(index).padStart(12, "0");
  return {
    id: planItemId(`20000000-0000-4000-8000-${suffix}`),
    sourceType: "routine",
    routineId: routineId(`30000000-0000-4000-8000-${suffix}`),
    workItemId: null,
    title: `Task ${String(index)}`,
    position: index,
    windowIndex: 0,
    scheduledMinutes: minutes,
    partialSession: false,
    score: 1,
    scoreComponents: {},
    reasons: [],
    locked: false,
    activityState: completed ? "completed" : "skipped",
    lastActivityEventId: null,
    activityUpdatedAt: null,
  };
}

function plan(
  index: number,
  date: string,
  items: readonly PlanItem[],
  overrides: Partial<DailyPlan> = {},
): DailyPlan {
  return {
    id: dailyPlanId(`40000000-0000-4000-8000-${String(index).padStart(12, "0")}`),
    workspaceId: workspace,
    date: localDate(date),
    timeZone: "UTC",
    items,
    totalMinutes: items.reduce((total, candidate) => total + candidate.scheduledMinutes, 0),
    fitness: 1,
    algorithmVersion: "planner-v6",
    configVersion: "weights-v4",
    prngVersion: "mulberry32-v1",
    seed: `plan-${String(index)}`,
    requestRevision: 1,
    inputHash: "a".repeat(64),
    inputSnapshot: {},
    exclusions: [],
    warnings: [],
    generatedAt: new Date(`${date}T12:00:00.000Z`),
    ...overrides,
  };
}

describe("planning outcomes", () => {
  it("returns an explicit empty prior-30-day window", () => {
    expect(calculatePlanningOutcomes(workspace, localDate("2026-07-16"), [])).toEqual({
      forDate: "2026-07-16",
      windowStartedOn: "2026-06-16",
      windowEndedOn: "2026-07-15",
      plansConsidered: 0,
      plannedTaskCount: 0,
      completedTaskCount: 0,
      plannedMinutes: 0,
      completedMinutes: 0,
      additionalPlanRevisionCount: 0,
      completionTasksRateBasisPoints: null,
      completionMinutesRateBasisPoints: null,
    });
  });

  it("uses weighted current-head task and minute totals", () => {
    const values = [
      plan(1, "2026-07-14", [item(1, 30, true)]),
      plan(2, "2026-07-15", [item(2, 30, true), item(3, 60, false)], {
        requestRevision: 3,
      }),
    ];
    expect(calculatePlanningOutcomes(workspace, localDate("2026-07-16"), values)).toMatchObject({
      plansConsidered: 2,
      plannedTaskCount: 3,
      completedTaskCount: 2,
      plannedMinutes: 120,
      completedMinutes: 60,
      additionalPlanRevisionCount: 2,
      completionTasksRateBasisPoints: 6_667,
      completionMinutesRateBasisPoints: 5_000,
    });
    expect(
      calculatePlanningOutcomes(workspace, localDate("2026-07-16"), [...values].reverse()),
    ).toEqual(calculatePlanningOutcomes(workspace, localDate("2026-07-16"), values));
  });

  it("rejects duplicate, cross-workspace, out-of-window, or inconsistent plans", () => {
    const first = plan(1, "2026-07-15", [item(1, 30, true)]);
    expect(() =>
      calculatePlanningOutcomes(workspace, localDate("2026-07-16"), [first, first]),
    ).toThrowError(/one local date twice/i);
    expect(() =>
      calculatePlanningOutcomes(workspace, localDate("2026-07-16"), [
        plan(2, "2026-07-14", [item(2, 30, true)], {
          workspaceId: workspaceId("10000000-0000-4000-8000-000000000002"),
        }),
      ]),
    ).toThrowError(/one workspace/i);
    expect(() =>
      calculatePlanningOutcomes(workspace, localDate("2026-07-16"), [
        plan(3, "2026-06-15", [item(3, 30, true)]),
      ]),
    ).toThrowError(/outside/i);
    expect(() =>
      calculatePlanningOutcomes(workspace, localDate("2026-07-16"), [
        plan(4, "2026-07-13", [item(4, 30, true)], { totalMinutes: 31 }),
      ]),
    ).toThrowError(/consistent/i);
  });
});
