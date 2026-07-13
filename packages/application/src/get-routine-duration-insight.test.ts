import { describe, expect, it } from "vitest";

import {
  activityEventId,
  createCadencePolicy,
  createDurationRange,
  createRoutine,
  createRoutineDurationInsightFeedback,
  createStructuredTags,
  createWorkspace,
  recordActivityEvent,
  routineId,
  workspaceId,
  type ActivityEvent,
  type RoutineDurationInsightFeedbackKind,
} from "@schedule/domain";

import { GetRoutineDurationInsight } from "./get-routine-duration-insight.js";
import type { TransactionContext, UnitOfWork } from "./ports.js";

const evaluatedAt = new Date("2026-07-13T18:30:00.000Z");
const workspace = createWorkspace({
  id: workspaceId("duration-insight-application-workspace"),
  name: "Duration insight",
  now: new Date("2026-01-01T00:00:00.000Z"),
});
const routine = createRoutine({
  id: routineId("duration-insight-application-routine"),
  workspaceId: workspace.id,
  title: "Language practice",
  tags: createStructuredTags({ priority: "medium" }),
  duration: createDurationRange({
    expectedMinutes: 30,
    minimumMinutes: 10,
    maximumMinutes: 120,
  }),
  cadence: createCadencePolicy({ period: "week", targetCompletions: 3 }),
  now: new Date("2026-01-01T00:00:00.000Z"),
});

function completion(sequence: number, durationMinutes: number): ActivityEvent {
  return recordActivityEvent({
    id: activityEventId(`duration-insight-application-event-${sequence}`),
    workspaceId: workspace.id,
    routineId: routine.id,
    type: "completed",
    occurredAt: new Date(`2026-07-${String(9 + sequence).padStart(2, "0")}T10:00:00.000Z`),
    timeZone: "UTC",
    durationMinutes,
    idempotencyKey: `duration-insight-application-${sequence}`,
    recordedAt: new Date(`2026-07-${String(9 + sequence).padStart(2, "0")}T10:01:00.000Z`),
  });
}

function harness(
  options: {
    workspaceExists?: boolean;
    routineExists?: boolean;
    evidence?: readonly ActivityEvent[];
    feedbackKind?: RoutineDurationInsightFeedbackKind;
  } = {},
) {
  const evidence = options.evidence ?? [completion(1, 50), completion(2, 60), completion(3, 70)];
  const calls: Array<{
    workspaceId: typeof workspace.id;
    routineId: typeof routine.id;
    fromInclusive: Date;
    throughInclusive: Date;
  }> = [];
  let routineFindCount = 0;
  let runCount = 0;
  let clockCount = 0;
  const feedbackKeys: string[] = [];
  const context = {
    workspaces: {
      findById: async () => (options.workspaceExists === false ? null : workspace),
      list: async () => [],
      insert: async () => undefined,
    },
    routines: {
      findById: async () => {
        routineFindCount += 1;
        return options.routineExists === false ? null : routine;
      },
      list: async () => [],
      listPlanningCandidates: async () => [],
      insert: async () => undefined,
      save: async () => undefined,
    },
    activityEvents: {
      lockRoutineActivity: async () => undefined,
      findById: async () => null,
      listForPlanning: async () => [],
      listDurationEvidence: async (
        receivedWorkspaceId: typeof workspace.id,
        receivedRoutineId: typeof routine.id,
        fromInclusive: Date,
        throughInclusive: Date,
      ) => {
        calls.push({
          workspaceId: receivedWorkspaceId,
          routineId: receivedRoutineId,
          fromInclusive,
          throughInclusive,
        });
        return evidence;
      },
      append: async (event: ActivityEvent) => event,
      listHistory: async () => ({ items: [], nextCursor: null }),
    },
    routineDurationInsightFeedback: {
      findLatestForKey: async (
        receivedWorkspaceId: typeof workspace.id,
        receivedRoutineId: typeof routine.id,
        insightKey: string,
      ) => {
        expect(receivedWorkspaceId).toBe(workspace.id);
        expect(receivedRoutineId).toBe(routine.id);
        feedbackKeys.push(insightKey);
        return options.feedbackKind === undefined
          ? null
          : createRoutineDurationInsightFeedback({
              ingestedSequence: 1,
              workspaceId: workspace.id,
              routineId: routine.id,
              insightKey,
              kind: options.feedbackKind,
              routineVersion: routine.version,
              observedMedianMinutes: 60,
              suggestedExpectedMinutes: 60,
              idempotencyKey: `get-insight-${options.feedbackKind}`,
              recordedAt: new Date("2026-07-13T18:00:00.000Z"),
            });
      },
      findByIdempotencyKey: async () => null,
      append: async (feedback) => feedback,
    },
    workItems: {} as TransactionContext["workItems"],
    scheduleBlocks: {} as TransactionContext["scheduleBlocks"],
    dailyPlans: {} as TransactionContext["dailyPlans"],
    auditEvents: {} as TransactionContext["auditEvents"],
  } satisfies TransactionContext;
  const unitOfWork: UnitOfWork = {
    run: async (operation) => {
      runCount += 1;
      return operation(context);
    },
  };
  const useCase = new GetRoutineDurationInsight(unitOfWork, {
    now: () => {
      clockCount += 1;
      return evaluatedAt;
    },
  });

  return {
    useCase,
    calls,
    routineFindCount: () => routineFindCount,
    runCount: () => runCount,
    clockCount: () => clockCount,
    feedbackKeys,
  };
}

describe("GetRoutineDurationInsight", () => {
  it("reads the exact 90-day routine evidence window and returns the derived suggestion", async () => {
    const test = harness();

    await expect(
      test.useCase.execute({ workspaceId: workspace.id, routineId: routine.id }),
    ).resolves.toMatchObject({
      routineId: routine.id,
      routineVersion: 1,
      status: "suggested",
      sampleCount: 3,
      lookbackDays: 90,
      evaluatedAt,
      windowStartedAt: new Date("2026-04-14T18:30:00.000Z"),
      currentExpectedMinutes: 30,
      observedMedianMinutes: 60,
      suggestedExpectedMinutes: 60,
      disposition: "available",
      dismissedAt: null,
    });

    expect(test.calls).toEqual([
      {
        workspaceId: workspace.id,
        routineId: routine.id,
        fromInclusive: new Date("2026-04-14T18:30:00.000Z"),
        throughInclusive: evaluatedAt,
      },
    ]);
    expect(test.runCount()).toBe(1);
    expect(test.clockCount()).toBe(1);
    expect(test.feedbackKeys).toHaveLength(1);
    expect(test.feedbackKeys[0]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("resolves an exact-key dismissal into the current duration insight", async () => {
    const test = harness({ feedbackKind: "dismissed" });

    await expect(
      test.useCase.execute({ workspaceId: workspace.id, routineId: routine.id }),
    ).resolves.toMatchObject({
      status: "suggested",
      disposition: "dismissed",
      dismissedAt: new Date("2026-07-13T18:00:00.000Z"),
    });
    expect(test.feedbackKeys).toHaveLength(1);
  });

  it("does not query feedback when the current insight is not actionable", async () => {
    const test = harness({ evidence: [completion(1, 29), completion(2, 30), completion(3, 31)] });

    await expect(
      test.useCase.execute({ workspaceId: workspace.id, routineId: routine.id }),
    ).resolves.toMatchObject({
      status: "aligned",
      insightKey: null,
      disposition: "available",
      dismissedAt: null,
    });
    expect(test.feedbackKeys).toEqual([]);
  });

  it("validates the workspace before reading the routine or duration evidence", async () => {
    const test = harness({ workspaceExists: false });

    await expect(
      test.useCase.execute({ workspaceId: workspace.id, routineId: routine.id }),
    ).rejects.toMatchObject({ code: "workspace.not_found" });
    expect(test.routineFindCount()).toBe(0);
    expect(test.calls).toEqual([]);
    expect(test.clockCount()).toBe(1);
  });

  it("reports a missing routine without reading cross-routine evidence", async () => {
    const test = harness({ routineExists: false });

    await expect(
      test.useCase.execute({ workspaceId: workspace.id, routineId: routine.id }),
    ).rejects.toMatchObject({ code: "routine.not_found" });
    expect(test.routineFindCount()).toBe(1);
    expect(test.calls).toEqual([]);
    expect(test.clockCount()).toBe(1);
  });
});
