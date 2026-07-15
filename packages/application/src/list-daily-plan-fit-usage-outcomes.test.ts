import { describe, expect, it, vi } from "vitest";

import {
  activityEventId,
  createDailyPlanFitInsightFeedback,
  dailyPlanFitInsightFeedbackId,
  dailyPlanId,
  localDate,
  planItemId,
  routineId,
  workspaceId,
  type DailyPlan,
} from "@schedule/domain";

import {
  ListDailyPlanFitUsageOutcomes,
  maximumDailyPlanFitUsageOutcomes,
} from "./list-daily-plan-fit-usage-outcomes.js";
import type { TransactionContext, UnitOfWork } from "./ports.js";

const workspace = workspaceId("70000000-0000-4000-8000-000000000001");
const planId = dailyPlanId("71000000-0000-4000-8000-000000000001");

const usage = createDailyPlanFitInsightFeedback({
  id: dailyPlanFitInsightFeedbackId("72000000-0000-4000-8000-000000000001"),
  ingestedSequence: 1,
  workspaceId: workspace,
  forDate: localDate("2026-07-14"),
  insightKey: "c".repeat(64),
  kind: "used",
  planId,
  sampleCount: 5,
  typicalPlannedMinutes: 180,
  typicalCompletedMinutes: 90,
  typicalPlannedTaskCount: 4,
  typicalCompletedTaskCount: 2,
  suggestedTargetMinutes: 90,
  suggestedTargetTaskCount: 2,
  appliedTargetMinutes: 105,
  appliedTargetTaskCount: 3,
  idempotencyKey: `plan-fit-used:${planId}`,
  recordedAt: new Date("2026-07-14T12:00:00.000Z"),
});

const plan: DailyPlan = {
  id: planId,
  workspaceId: workspace,
  date: localDate("2026-07-14"),
  timeZone: "UTC",
  items: [
    {
      id: planItemId("73000000-0000-5000-a000-000000000001"),
      sourceType: "routine",
      routineId: routineId("74000000-0000-4000-8000-000000000001"),
      workItemId: null,
      title: "Review",
      position: 1,
      windowIndex: 0,
      scheduledMinutes: 60,
      partialSession: false,
      score: 1,
      scoreComponents: {},
      reasons: [],
      locked: false,
      activityState: "completed",
      lastActivityEventId: activityEventId("75000000-0000-4000-8000-000000000001"),
      activityUpdatedAt: new Date("2026-07-14T17:00:00.000Z"),
    },
  ],
  totalMinutes: 60,
  fitness: 1,
  algorithmVersion: "deterministic-planner-v6",
  configVersion: "default-weights-v4",
  prngVersion: "mulberry32-v1",
  seed: "history",
  requestRevision: 1,
  inputHash: "d".repeat(64),
  inputSnapshot: {},
  exclusions: [],
  warnings: [],
  generatedAt: new Date("2026-07-14T12:00:00.000Z"),
};

function harness(workspaceExists = true) {
  const listUsed = vi.fn().mockResolvedValue([usage]);
  const findCurrentForDates = vi
    .fn()
    .mockResolvedValue(new Map([[plan.date, { plan, headVersion: 1 }]]));
  const context = {
    workspaces: { findById: vi.fn().mockResolvedValue(workspaceExists ? { id: workspace } : null) },
    dailyPlanFitInsightFeedback: { listUsed },
    dailyPlans: { findCurrentForDates },
  } as unknown as TransactionContext;
  const unitOfWork: UnitOfWork = { run: async (operation) => operation(context) };
  return { useCase: new ListDailyPlanFitUsageOutcomes(unitOfWork), listUsed, findCurrentForDates };
}

describe("ListDailyPlanFitUsageOutcomes", () => {
  it("returns bounded explicit uses joined to current resolved plans", async () => {
    const test = harness();
    await expect(test.useCase.execute({ workspaceId: workspace, limit: 5 })).resolves.toMatchObject(
      [
        {
          usageId: usage.id,
          status: "resolved",
          appliedTargetMinutes: 105,
          plannedMinutes: 60,
          completedMinutes: 60,
          completedTaskCount: 1,
        },
      ],
    );
    expect(test.listUsed).toHaveBeenCalledWith(workspace, 5);
    expect(test.findCurrentForDates).toHaveBeenCalledWith(workspace, [usage.forDate]);
  });

  it("rejects invalid bounds and missing workspaces", async () => {
    await expect(
      harness().useCase.execute({
        workspaceId: workspace,
        limit: maximumDailyPlanFitUsageOutcomes + 1,
      }),
    ).rejects.toMatchObject({ code: "daily_plan_fit_insight.usage_limit_invalid" });
    await expect(
      harness(false).useCase.execute({ workspaceId: workspace, limit: 5 }),
    ).rejects.toMatchObject({ code: "workspace.not_found" });
  });
});
