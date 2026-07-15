import { describe, expect, it } from "vitest";

import {
  activityEventId,
  addLocalDays,
  calculateDailyPlanFitInsight,
  createDailyPlanFitInsightFeedback,
  createWorkspace,
  dailyPlanId,
  localDate,
  planItemId,
  workspaceId,
  type DailyPlanFitEvidencePlan,
  type DailyPlanFitInsightFeedback,
} from "@schedule/domain";

import { DismissDailyPlanFitInsight } from "./dismiss-daily-plan-fit-insight.js";
import { GetDailyPlanFitInsight } from "./get-daily-plan-fit-insight.js";
import type { TransactionContext, UnitOfWork, UnitOfWorkOptions } from "./ports.js";
import { ResetDailyPlanFitInsightDismissal } from "./reset-daily-plan-fit-insight-dismissal.js";

const now = new Date("2026-07-14T12:00:00.000Z");
const forDate = localDate("2026-07-14");
const workspace = createWorkspace({
  id: workspaceId("application-plan-fit-workspace"),
  name: "Plan Fit",
  now,
});

function evidencePlan(sequence: number, completed = 2): DailyPlanFitEvidencePlan {
  return {
    workspaceId: workspace.id,
    planId: dailyPlanId(`application-plan-fit-plan-${sequence}`),
    date: addLocalDays(forDate, -sequence),
    targetMinutes: 180,
    targetTaskCount: 4,
    items: Array.from({ length: 4 }, (_, index) => ({
      id: planItemId(`application-plan-fit-plan-${sequence}-item-${index}`),
      scheduledMinutes: index < completed ? 45 : 30,
      activityState: index < completed ? ("completed" as const) : ("skipped" as const),
      lastActivityEventId: activityEventId(`application-plan-fit-plan-${sequence}-event-${index}`),
    })),
  };
}

function harness(
  input: {
    readonly workspaceExists?: boolean;
    readonly evidence?: readonly DailyPlanFitEvidencePlan[];
    readonly initialFeedback?: readonly DailyPlanFitInsightFeedback[];
  } = {},
) {
  const evidence = input.evidence ?? [evidencePlan(1), evidencePlan(2), evidencePlan(3)];
  const feedback = [...(input.initialFeedback ?? [])];
  const idempotencyLookups: string[] = [];
  const locks: string[] = [];
  const listCalls: unknown[][] = [];
  const options: (UnitOfWorkOptions | undefined)[] = [];
  let sequence = feedback.length;
  const context = {
    workspaces: {
      findById: async () => (input.workspaceExists === false ? null : workspace),
    },
    dailyPlans: {
      listFitEvidence: async (...args: unknown[]) => {
        listCalls.push(args);
        return evidence;
      },
    },
    dailyPlanFitInsightFeedback: {
      lockWorkspace: async (receivedWorkspaceId: string) => {
        locks.push(receivedWorkspaceId);
      },
      findLatestForKey: async (_workspaceId: string, insightKey: string) =>
        [...feedback].reverse().find((event) => event.insightKey === insightKey) ?? null,
      findByIdempotencyKey: async (_workspaceId: string, key: string) => {
        idempotencyLookups.push(key);
        return feedback.find((event) => event.idempotencyKey === key) ?? null;
      },
      listUsed: async (_workspaceId: string, limit: number) =>
        feedback.filter((event) => event.kind === "used").slice(0, limit),
      append: async (event: DailyPlanFitInsightFeedback) => {
        const stored = { ...event, ingestedSequence: ++sequence };
        feedback.push(stored);
        return stored;
      },
    },
  } as TransactionContext;
  const unitOfWork: UnitOfWork = {
    run: async (operation, receivedOptions) => {
      options.push(receivedOptions);
      return operation(context);
    },
  };
  const clock = { now: () => now };
  return {
    get: new GetDailyPlanFitInsight(unitOfWork, clock),
    dismiss: new DismissDailyPlanFitInsight(unitOfWork, clock),
    reset: new ResetDailyPlanFitInsightDismissal(unitOfWork, clock),
    feedback,
    idempotencyLookups,
    locks,
    listCalls,
    options,
    evidence,
  };
}

describe("Daily Plan Fit application use cases", () => {
  it("reads the bounded prior-plan projection and resolves exact-key feedback", async () => {
    const test = harness();
    const available = await test.get.execute({ workspaceId: workspace.id, forDate });
    expect(available).toMatchObject({
      status: "suggested",
      disposition: "available",
      sampleCount: 3,
      suggestedTargetMinutes: 90,
      suggestedTargetTaskCount: 2,
    });
    expect(test.listCalls).toEqual([[workspace.id, forDate, 90, 90]]);

    const dismissed = createDailyPlanFitInsightFeedback({
      ingestedSequence: 1,
      workspaceId: workspace.id,
      forDate,
      insightKey: available.insightKey!,
      kind: "dismissed",
      sampleCount: available.sampleCount,
      typicalPlannedMinutes: available.typicalPlannedMinutes!,
      typicalCompletedMinutes: available.typicalCompletedMinutes!,
      typicalPlannedTaskCount: available.typicalPlannedTaskCount!,
      typicalCompletedTaskCount: available.typicalCompletedTaskCount!,
      suggestedTargetMinutes: available.suggestedTargetMinutes!,
      suggestedTargetTaskCount: available.suggestedTargetTaskCount!,
      idempotencyKey: "existing-dismissal",
      recordedAt: now,
    });
    const withFeedback = harness({ initialFeedback: [dismissed] });
    await expect(
      withFeedback.get.execute({ workspaceId: workspace.id, forDate }),
    ).resolves.toMatchObject({ disposition: "dismissed", dismissedAt: now });
  });

  it("rejects a missing workspace before reading history", async () => {
    const test = harness({ workspaceExists: false });
    await expect(test.get.execute({ workspaceId: workspace.id, forDate })).rejects.toMatchObject({
      code: "workspace.not_found",
    });
    expect(test.listCalls).toEqual([]);
  });

  it("rejects an invalid local date before opening a unit of work", async () => {
    const invalidDate = "2026-02-30" as typeof forDate;
    const operations = [
      (test: ReturnType<typeof harness>) =>
        test.get.execute({ workspaceId: workspace.id, forDate: invalidDate }),
      (test: ReturnType<typeof harness>) =>
        test.dismiss.execute({
          workspaceId: workspace.id,
          forDate: invalidDate,
          insightKey: "a".repeat(64),
          idempotencyKey: "invalid-dismiss",
        }),
      (test: ReturnType<typeof harness>) =>
        test.reset.execute({
          workspaceId: workspace.id,
          forDate: invalidDate,
          insightKey: "a".repeat(64),
          idempotencyKey: "invalid-reset",
        }),
    ];
    for (const operation of operations) {
      const test = harness();
      await expect(operation(test)).rejects.toMatchObject({
        code: "daily_plan_fit_insight.for_date_invalid",
      });
      expect(test.options).toEqual([]);
      expect(test.listCalls).toEqual([]);
    }
  });

  it("dismisses then resets the same exact suggestion under a read-committed lock", async () => {
    const test = harness();
    const insight = calculateDailyPlanFitInsight(workspace.id, forDate, test.evidence, now);
    const command = {
      workspaceId: workspace.id,
      forDate,
      insightKey: insight.insightKey!,
    };

    const dismissed = await test.dismiss.execute({ ...command, idempotencyKey: "dismiss-fit" });
    const reset = await test.reset.execute({ ...command, idempotencyKey: "reset-fit" });

    expect(dismissed).toMatchObject({
      kind: "dismissed",
      ingestedSequence: 1,
      sampleCount: 3,
      suggestedTargetMinutes: 90,
      suggestedTargetTaskCount: 2,
    });
    expect(reset).toMatchObject({ kind: "reset", ingestedSequence: 2 });
    expect(test.locks).toEqual([workspace.id, workspace.id]);
    expect(test.options).toEqual([
      { isolationLevel: "read_committed" },
      { isolationLevel: "read_committed" },
    ]);
  });

  it("returns an exact idempotent replay without recalculating evidence", async () => {
    const base = harness();
    const insight = calculateDailyPlanFitInsight(workspace.id, forDate, base.evidence, now);
    const replay = createDailyPlanFitInsightFeedback({
      ingestedSequence: 7,
      workspaceId: workspace.id,
      forDate,
      insightKey: insight.insightKey!,
      kind: "dismissed",
      sampleCount: insight.sampleCount,
      typicalPlannedMinutes: insight.typicalPlannedMinutes!,
      typicalCompletedMinutes: insight.typicalCompletedMinutes!,
      typicalPlannedTaskCount: insight.typicalPlannedTaskCount!,
      typicalCompletedTaskCount: insight.typicalCompletedTaskCount!,
      suggestedTargetMinutes: insight.suggestedTargetMinutes!,
      suggestedTargetTaskCount: insight.suggestedTargetTaskCount!,
      idempotencyKey: "same-key",
      recordedAt: now,
    });
    const test = harness({ initialFeedback: [replay] });

    await expect(
      test.dismiss.execute({
        workspaceId: workspace.id,
        forDate,
        insightKey: insight.insightKey!,
        idempotencyKey: "same-key",
      }),
    ).resolves.toBe(replay);
    expect(test.listCalls).toEqual([]);
  });

  it("rejects idempotency reuse and stale evidence", async () => {
    const base = harness();
    const insight = calculateDailyPlanFitInsight(workspace.id, forDate, base.evidence, now);
    const replay = createDailyPlanFitInsightFeedback({
      ingestedSequence: 1,
      workspaceId: workspace.id,
      forDate,
      insightKey: insight.insightKey!,
      kind: "dismissed",
      sampleCount: insight.sampleCount,
      typicalPlannedMinutes: insight.typicalPlannedMinutes!,
      typicalCompletedMinutes: insight.typicalCompletedMinutes!,
      typicalPlannedTaskCount: insight.typicalPlannedTaskCount!,
      typicalCompletedTaskCount: insight.typicalCompletedTaskCount!,
      suggestedTargetMinutes: insight.suggestedTargetMinutes!,
      suggestedTargetTaskCount: insight.suggestedTargetTaskCount!,
      idempotencyKey: "taken",
      recordedAt: now,
    });
    const collision = harness({ initialFeedback: [replay] });
    await expect(
      collision.reset.execute({
        workspaceId: workspace.id,
        forDate,
        insightKey: insight.insightKey!,
        idempotencyKey: "taken",
      }),
    ).rejects.toMatchObject({ code: "daily_plan_fit_insight.idempotency_conflict" });

    const stale = harness({ evidence: [evidencePlan(1), evidencePlan(2, 3), evidencePlan(3)] });
    await expect(
      stale.dismiss.execute({
        workspaceId: workspace.id,
        forDate,
        insightKey: insight.insightKey!,
        idempotencyKey: "stale",
      }),
    ).rejects.toMatchObject({ code: "daily_plan_fit_insight.evidence_conflict" });
  });

  it("enforces disposition transitions", async () => {
    const test = harness();
    const insight = calculateDailyPlanFitInsight(workspace.id, forDate, test.evidence, now);
    await expect(
      test.reset.execute({
        workspaceId: workspace.id,
        forDate,
        insightKey: insight.insightKey!,
        idempotencyKey: "reset-without-dismissal",
      }),
    ).rejects.toMatchObject({ code: "daily_plan_fit_insight.disposition_conflict" });
  });
});
