import { describe, expect, it, vi } from "vitest";

import {
  dailyPlanFitInsightFeedbackId,
  dailyPlanId,
  localDate,
  workspaceId,
  type DailyPlanFitUsageOutcome,
} from "@schedule/domain";

import { GetDailyPlanFitEffectiveness } from "./get-daily-plan-fit-effectiveness.js";

const workspace = workspaceId("76000000-0000-4000-8000-000000000001");
const plan = dailyPlanId("77000000-0000-4000-8000-000000000001");
const resolvedOutcome: DailyPlanFitUsageOutcome = {
  usageId: dailyPlanFitInsightFeedbackId("78000000-0000-4000-8000-000000000001"),
  workspaceId: workspace,
  forDate: localDate("2026-07-14"),
  insightKey: "e".repeat(64),
  recordedAt: new Date("2026-07-14T12:00:00.000Z"),
  sourcePlanId: plan,
  currentPlanId: plan,
  currentPlanRevision: 1,
  currentHeadVersion: 3,
  revisedSinceUsage: false,
  status: "resolved",
  suggestedTargetMinutes: 90,
  suggestedTargetTaskCount: 2,
  appliedTargetMinutes: 120,
  appliedTargetTaskCount: 3,
  usedExactSuggestion: false,
  plannedMinutes: 90,
  plannedTaskCount: 3,
  completedMinutes: 60,
  completedTaskCount: 2,
};

describe("GetDailyPlanFitEffectiveness", () => {
  it("forwards the bounded workspace query and returns deterministic descriptive totals", async () => {
    const execute = vi.fn().mockResolvedValue([resolvedOutcome]);
    const useCase = new GetDailyPlanFitEffectiveness({ execute });

    await expect(useCase.execute({ workspaceId: workspace, limit: 28 })).resolves.toMatchObject({
      usesConsidered: 1,
      eligibleResolvedUseCount: 1,
      exactSuggestionUseCount: 0,
      editedSuggestionUseCount: 1,
      appliedTargetMinutes: 120,
      scheduledMinutes: 90,
      completedMinutes: 60,
      scheduledMinutesRateBasisPoints: 7_500,
      completionMinutesRateBasisPoints: 6_667,
    });
    expect(execute).toHaveBeenCalledWith({ workspaceId: workspace, limit: 28 });
  });

  it("preserves list validation and workspace failures", async () => {
    const failure = new Error("workspace unavailable");
    const execute = vi.fn().mockRejectedValue(failure);
    await expect(
      new GetDailyPlanFitEffectiveness({ execute }).execute({ workspaceId: workspace, limit: 28 }),
    ).rejects.toBe(failure);
  });
});
