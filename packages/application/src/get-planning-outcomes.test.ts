import { describe, expect, it, vi } from "vitest";

import {
  dailyPlanId,
  localDate,
  planItemId,
  routineId,
  workspaceId,
  type DailyPlan,
} from "@schedule/domain";

import { GetPlanningOutcomes } from "./get-planning-outcomes.js";
import type { TransactionContext, UnitOfWork } from "./ports.js";

const workspace = workspaceId("60000000-0000-4000-8000-000000000001");
const plan: DailyPlan = {
  id: dailyPlanId("61000000-0000-4000-8000-000000000001"),
  workspaceId: workspace,
  date: localDate("2026-07-15"),
  timeZone: "UTC",
  items: [
    {
      id: planItemId("62000000-0000-4000-8000-000000000001"),
      sourceType: "routine",
      routineId: routineId("63000000-0000-4000-8000-000000000001"),
      workItemId: null,
      title: "Review",
      position: 0,
      windowIndex: 0,
      scheduledMinutes: 30,
      partialSession: false,
      score: 1,
      scoreComponents: {},
      reasons: [],
      locked: false,
      activityState: "completed",
      lastActivityEventId: null,
      activityUpdatedAt: null,
    },
  ],
  totalMinutes: 30,
  fitness: 1,
  algorithmVersion: "planner-v6",
  configVersion: "weights-v4",
  prngVersion: "mulberry32-v1",
  seed: "outcomes",
  requestRevision: 2,
  inputHash: "a".repeat(64),
  inputSnapshot: {},
  exclusions: [],
  warnings: [],
  generatedAt: new Date("2026-07-15T12:00:00.000Z"),
};

function harness(workspaceExists = true) {
  const findCurrentForDates = vi
    .fn()
    .mockResolvedValue(new Map([[plan.date, { plan, headVersion: 2 }]]));
  const context = {
    workspaces: { findById: vi.fn().mockResolvedValue(workspaceExists ? { id: workspace } : null) },
    dailyPlans: { findCurrentForDates },
  } as unknown as TransactionContext;
  let runCount = 0;
  const unitOfWork: UnitOfWork = {
    run: async (operation) => {
      runCount += 1;
      return operation(context);
    },
  };
  return {
    useCase: new GetPlanningOutcomes(unitOfWork),
    findCurrentForDates,
    runCount: () => runCount,
  };
}

describe("GetPlanningOutcomes", () => {
  it("loads one fixed prior-30-day current-head window", async () => {
    const test = harness();
    await expect(
      test.useCase.execute({ workspaceId: workspace, forDate: localDate("2026-07-16") }),
    ).resolves.toMatchObject({
      windowStartedOn: "2026-06-16",
      windowEndedOn: "2026-07-15",
      plansConsidered: 1,
      plannedTaskCount: 1,
      completedTaskCount: 1,
      skippedTaskCount: 0,
      deferredTaskCount: 0,
      dismissedTaskCount: 0,
      skippedMinutes: 0,
      deferredMinutes: 0,
      dismissedMinutes: 0,
      additionalPlanRevisionCount: 1,
    });
    const dates = test.findCurrentForDates.mock.calls[0]?.[1];
    expect(dates).toHaveLength(30);
    expect(dates?.[0]).toBe("2026-06-16");
    expect(dates?.[29]).toBe("2026-07-15");
    expect(test.runCount()).toBe(1);
  });

  it("rejects invalid dates before opening a transaction and missing workspaces inside it", async () => {
    const invalid = harness();
    await expect(
      invalid.useCase.execute({ workspaceId: workspace, forDate: "2026-02-30" as never }),
    ).rejects.toMatchObject({ code: "planning.outcomes_date_invalid" });
    expect(invalid.runCount()).toBe(0);
    await expect(
      harness(false).useCase.execute({
        workspaceId: workspace,
        forDate: localDate("2026-07-16"),
      }),
    ).rejects.toMatchObject({ code: "workspace.not_found" });
  });
});
