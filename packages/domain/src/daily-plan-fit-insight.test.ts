import { describe, expect, it } from "vitest";

import { addLocalDays, localDate } from "./calendar.js";
import {
  calculateDailyPlanFitInsight,
  dailyPlanFitInsightMaximumItemsPerPlan,
  dailyPlanFitInsightMaximumSamples,
  type DailyPlanFitEvidencePlan,
} from "./daily-plan-fit-insight.js";
import {
  createDailyPlanFitInsightFeedback,
  latestDailyPlanFitInsightFeedback,
  resolveDailyPlanFitInsightFeedback,
} from "./daily-plan-fit-insight-feedback.js";
import {
  activityEventId,
  dailyPlanFitInsightFeedbackId,
  dailyPlanId,
  planItemId,
  workspaceId,
} from "./ids.js";

const workspace = workspaceId("plan-fit-workspace");
const forDate = localDate("2026-07-14");
const evaluatedAt = new Date("2026-07-14T12:00:00.000Z");

function evidencePlan(
  sequence: number,
  input: {
    readonly targetMinutes?: number;
    readonly targetTaskCount?: number;
    readonly completedMinutes?: readonly number[];
    readonly remainingState?: "pending" | "started" | "skipped" | "deferred" | "dismissed";
    readonly itemCount?: number;
  } = {},
): DailyPlanFitEvidencePlan {
  const completedMinutes = input.completedMinutes ?? [45, 45];
  const itemCount = input.itemCount ?? 4;
  const remainingState = input.remainingState ?? "skipped";
  return {
    workspaceId: workspace,
    planId: dailyPlanId(`plan-${sequence.toString().padStart(3, "0")}`),
    date: addLocalDays(forDate, -sequence),
    targetMinutes: input.targetMinutes ?? 180,
    targetTaskCount: input.targetTaskCount ?? 4,
    items: Array.from({ length: itemCount }, (_, index) => {
      const completed = index < completedMinutes.length;
      const activityState = completed ? "completed" : remainingState;
      return {
        id: planItemId(`plan-${sequence}-item-${index}`),
        scheduledMinutes: completed ? completedMinutes[index]! : 30,
        activityState,
        lastActivityEventId:
          activityState === "pending" ? null : activityEventId(`plan-${sequence}-event-${index}`),
      };
    }),
  };
}

describe("Daily Plan Fit insight", () => {
  it("requires three fully resolved, nonempty current plans", () => {
    const insight = calculateDailyPlanFitInsight(
      workspace,
      forDate,
      [
        evidencePlan(1),
        evidencePlan(2),
        evidencePlan(3, { remainingState: "started" }),
        evidencePlan(4, { itemCount: 0, completedMinutes: [] }),
      ],
      evaluatedAt,
    );

    expect(insight).toMatchObject({
      status: "insufficient_history",
      insightKey: null,
      sampleCount: 2,
      minimumSamples: 3,
      typicalPlannedMinutes: null,
      suggestedTargetMinutes: null,
    });
  });

  it("jointly recommends materially lower median time and task targets", () => {
    const insight = calculateDailyPlanFitInsight(
      workspace,
      forDate,
      [evidencePlan(1), evidencePlan(2), evidencePlan(3)],
      evaluatedAt,
    );

    expect(insight).toMatchObject({
      status: "suggested",
      sampleCount: 3,
      typicalPlannedMinutes: 180,
      typicalCompletedMinutes: 90,
      materialThresholdMinutes: 45,
      typicalPlannedTaskCount: 4,
      typicalCompletedTaskCount: 2,
      materialThresholdTaskCount: 1,
      suggestedTargetMinutes: 90,
      suggestedTargetTaskCount: 2,
    });
    expect(insight.insightKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not emit an actionable suggestion for a sub-threshold gap", () => {
    const plans = [1, 2, 3].map((sequence) =>
      evidencePlan(sequence, {
        completedMinutes: [40, 40, 40, 30],
        targetTaskCount: 4,
      }),
    );

    expect(calculateDailyPlanFitInsight(workspace, forDate, plans, evaluatedAt)).toMatchObject({
      status: "aligned",
      typicalPlannedMinutes: 180,
      typicalCompletedMinutes: 150,
      materialThresholdMinutes: 45,
      insightKey: null,
      suggestedTargetMinutes: null,
      suggestedTargetTaskCount: null,
    });
  });

  it("uses safe minimum targets when recent plans resolved with no completed items", () => {
    const plans = [1, 2, 3].map((sequence) =>
      evidencePlan(sequence, { completedMinutes: [], remainingState: "deferred" }),
    );

    expect(calculateDailyPlanFitInsight(workspace, forDate, plans, evaluatedAt)).toMatchObject({
      status: "suggested",
      typicalCompletedMinutes: 0,
      typicalCompletedTaskCount: 0,
      suggestedTargetMinutes: 30,
      suggestedTargetTaskCount: 1,
    });
  });

  it("caps evidence, ignores repository order, and excludes the evaluation clock from its key", () => {
    const plans = Array.from({ length: 30 }, (_, index) => evidencePlan(index + 1));
    const first = calculateDailyPlanFitInsight(workspace, forDate, plans, evaluatedAt);
    const reordered = calculateDailyPlanFitInsight(
      workspace,
      forDate,
      [...plans].reverse(),
      new Date("2026-07-14T23:59:00.000Z"),
    );
    const changedOutsideCap = plans.map((plan, index) =>
      index === 29 ? { ...plan, targetMinutes: 360 } : plan,
    );
    const outside = calculateDailyPlanFitInsight(
      workspace,
      forDate,
      changedOutsideCap,
      evaluatedAt,
    );

    expect(first.sampleCount).toBe(dailyPlanFitInsightMaximumSamples);
    expect(reordered.insightKey).toBe(first.insightKey);
    expect(outside.insightKey).toBe(first.insightKey);
    expect(reordered.evaluatedAt).not.toEqual(first.evaluatedAt);
  });

  it("rejects cross-workspace and duplicate evidence", () => {
    const plan = evidencePlan(1);
    expect(() =>
      calculateDailyPlanFitInsight(
        workspace,
        forDate,
        [{ ...plan, workspaceId: workspaceId("other") }],
        evaluatedAt,
      ),
    ).toThrow("requested workspace");
    expect(() =>
      calculateDailyPlanFitInsight(workspace, forDate, [plan, plan], evaluatedAt),
    ).toThrow("more than once");
  });

  it("fails closed when one evidence plan exceeds the item bound", () => {
    const oversized = evidencePlan(1, {
      itemCount: dailyPlanFitInsightMaximumItemsPerPlan + 1,
    });
    expect(() =>
      calculateDailyPlanFitInsight(workspace, forDate, [oversized], evaluatedAt),
    ).toThrow("bounded item limit");
  });
});

describe("Daily Plan Fit feedback", () => {
  it("resolves the latest exact-key dismissal and reset", () => {
    const insight = calculateDailyPlanFitInsight(
      workspace,
      forDate,
      [evidencePlan(1), evidencePlan(2), evidencePlan(3)],
      evaluatedAt,
    );
    const shared = {
      workspaceId: workspace,
      forDate,
      insightKey: insight.insightKey!,
      sampleCount: insight.sampleCount,
      typicalPlannedMinutes: insight.typicalPlannedMinutes!,
      typicalCompletedMinutes: insight.typicalCompletedMinutes!,
      typicalPlannedTaskCount: insight.typicalPlannedTaskCount!,
      typicalCompletedTaskCount: insight.typicalCompletedTaskCount!,
      suggestedTargetMinutes: insight.suggestedTargetMinutes!,
      suggestedTargetTaskCount: insight.suggestedTargetTaskCount!,
    } as const;
    const dismissed = createDailyPlanFitInsightFeedback({
      ...shared,
      id: dailyPlanFitInsightFeedbackId("feedback-a"),
      ingestedSequence: 1,
      kind: "dismissed",
      idempotencyKey: "dismiss",
      recordedAt: new Date("2026-07-14T12:01:00.000Z"),
    });
    const reset = createDailyPlanFitInsightFeedback({
      ...shared,
      id: dailyPlanFitInsightFeedbackId("feedback-b"),
      ingestedSequence: 2,
      kind: "reset",
      idempotencyKey: "reset",
      recordedAt: new Date("2026-07-14T12:02:00.000Z"),
    });

    expect(resolveDailyPlanFitInsightFeedback(insight, workspace, [dismissed])).toMatchObject({
      disposition: "dismissed",
      dismissedAt: dismissed.recordedAt,
    });
    expect(
      resolveDailyPlanFitInsightFeedback(insight, workspace, [reset, dismissed]),
    ).toMatchObject({
      disposition: "available",
      dismissedAt: null,
    });
    expect(
      latestDailyPlanFitInsightFeedback([reset, dismissed], workspace, insight.insightKey!),
    ).toBe(reset);

    const available = resolveDailyPlanFitInsightFeedback(insight, workspace, []);
    expect(available).not.toBe(insight);
    available.evaluatedAt.setUTCFullYear(2030);
    expect(insight.evaluatedAt).toEqual(evaluatedAt);
  });

  it("keeps a used event separate from exact-key dismissal state", () => {
    const insight = calculateDailyPlanFitInsight(
      workspace,
      forDate,
      [evidencePlan(1), evidencePlan(2), evidencePlan(3)],
      evaluatedAt,
    );
    const used = createDailyPlanFitInsightFeedback({
      id: dailyPlanFitInsightFeedbackId("feedback-used"),
      ingestedSequence: 1,
      workspaceId: workspace,
      forDate,
      insightKey: insight.insightKey!,
      kind: "used",
      planId: dailyPlanId("plan-used"),
      sampleCount: insight.sampleCount,
      typicalPlannedMinutes: insight.typicalPlannedMinutes!,
      typicalCompletedMinutes: insight.typicalCompletedMinutes!,
      typicalPlannedTaskCount: insight.typicalPlannedTaskCount!,
      typicalCompletedTaskCount: insight.typicalCompletedTaskCount!,
      suggestedTargetMinutes: insight.suggestedTargetMinutes!,
      suggestedTargetTaskCount: insight.suggestedTargetTaskCount!,
      appliedTargetMinutes: insight.suggestedTargetMinutes!,
      appliedTargetTaskCount: insight.suggestedTargetTaskCount!,
      idempotencyKey: "used",
      recordedAt: new Date("2026-07-14T12:01:00.000Z"),
    });

    expect(resolveDailyPlanFitInsightFeedback(insight, workspace, [used])).toMatchObject({
      disposition: "available",
      dismissedAt: null,
    });
  });

  it("normalizes idempotency and validates nonnegative completed medians", () => {
    const event = createDailyPlanFitInsightFeedback({
      id: dailyPlanFitInsightFeedbackId("feedback-zero"),
      ingestedSequence: 0,
      workspaceId: workspace,
      forDate,
      insightKey: "a".repeat(64),
      kind: "dismissed",
      sampleCount: 3,
      typicalPlannedMinutes: 180,
      typicalCompletedMinutes: 0,
      typicalPlannedTaskCount: 4,
      typicalCompletedTaskCount: 0,
      suggestedTargetMinutes: 30,
      suggestedTargetTaskCount: 1,
      idempotencyKey: "  retry-safe  ",
      recordedAt: evaluatedAt,
    });
    expect(event.idempotencyKey).toBe("retry-safe");
    expect(() =>
      createDailyPlanFitInsightFeedback({
        ...event,
        id: undefined,
        typicalCompletedMinutes: -1,
      }),
    ).toThrow("non-negative");
  });
});
