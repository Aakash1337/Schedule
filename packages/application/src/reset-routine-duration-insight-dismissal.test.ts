import { describe, expect, it } from "vitest";

import {
  activityEventId,
  calculateRoutineDurationInsight,
  createCadencePolicy,
  createDurationRange,
  createRoutine,
  createRoutineDurationInsightFeedback,
  createStructuredTags,
  createWorkspace,
  latestRoutineDurationInsightFeedback,
  recordActivityEvent,
  routineId,
  workspaceId,
  type ActivityEvent,
  type Routine,
  type RoutineDurationInsightFeedback,
} from "@schedule/domain";

import type { TransactionContext, UnitOfWork, UnitOfWorkOptions } from "./ports.js";
import { ResetRoutineDurationInsightDismissal } from "./reset-routine-duration-insight-dismissal.js";

const now = new Date("2026-07-13T18:30:00.000Z");
const workspace = createWorkspace({
  id: workspaceId("duration-reset-workspace"),
  name: "Duration reset",
  now: new Date("2026-01-01T00:00:00.000Z"),
});
const routine = createRoutine({
  id: routineId("duration-reset-routine"),
  workspaceId: workspace.id,
  title: "Reading",
  tags: createStructuredTags({ priority: "medium" }),
  duration: createDurationRange({
    expectedMinutes: 30,
    minimumMinutes: 10,
    maximumMinutes: 120,
  }),
  cadence: createCadencePolicy({ period: "week", targetCompletions: 3 }),
  now: new Date("2026-01-01T00:00:00.000Z"),
});

function completions(durations: readonly number[]): readonly ActivityEvent[] {
  return durations.map((durationMinutes, index) =>
    recordActivityEvent({
      id: activityEventId(`duration-reset-completion-${index}-${durationMinutes}`),
      workspaceId: workspace.id,
      routineId: routine.id,
      type: "completed",
      occurredAt: new Date(`2026-07-${String(10 + index).padStart(2, "0")}T10:00:00.000Z`),
      timeZone: "UTC",
      durationMinutes,
      idempotencyKey: `duration-reset-completion-${index}`,
      recordedAt: new Date(`2026-07-${String(10 + index).padStart(2, "0")}T10:01:00.000Z`),
    }),
  );
}

const defaultEvidence = completions([50, 60, 70]);
const insightKey = calculateRoutineDurationInsight(routine, defaultEvidence, now).insightKey!;

function feedback(
  overrides: Partial<RoutineDurationInsightFeedback> = {},
): RoutineDurationInsightFeedback {
  return createRoutineDurationInsightFeedback({
    ingestedSequence: 1,
    workspaceId: workspace.id,
    routineId: routine.id,
    insightKey,
    kind: "dismissed",
    routineVersion: routine.version,
    observedMedianMinutes: 60,
    suggestedExpectedMinutes: 60,
    idempotencyKey: "original-dismissal",
    recordedAt: new Date("2026-07-13T18:00:00.000Z"),
    ...overrides,
  });
}

function harness(
  options: {
    workspaceExists?: boolean;
    routine?: Routine | null;
    evidence?: readonly ActivityEvent[];
    initialFeedback?: readonly RoutineDurationInsightFeedback[];
  } = {},
) {
  const stored = [...(options.initialFeedback ?? [feedback()])];
  const appended: RoutineDurationInsightFeedback[] = [];
  const operationOrder: string[] = [];
  let runCount = 0;
  let clockCount = 0;
  let unitOfWorkOptions: UnitOfWorkOptions | undefined;

  const context = {
    workspaces: {
      findById: async () => {
        operationOrder.push("workspace");
        return options.workspaceExists === false ? null : workspace;
      },
      list: async () => [],
      insert: async () => undefined,
    },
    routines: {
      findById: async () => {
        operationOrder.push("routine");
        return options.routine === undefined ? routine : options.routine;
      },
      list: async () => [],
      listPlanningCandidates: async () => [],
      insert: async () => undefined,
      save: async () => undefined,
    },
    activityEvents: {
      lockRoutineActivity: async () => {
        operationOrder.push("lock");
      },
      findById: async () => null,
      listForPlanning: async () => [],
      listDurationEvidence: async () => {
        operationOrder.push("evidence");
        return options.evidence ?? defaultEvidence;
      },
      append: async (event: ActivityEvent) => event,
      listHistory: async () => ({ items: [], nextCursor: null }),
    },
    routineDurationInsightFeedback: {
      findByIdempotencyKey: async (
        receivedWorkspaceId: typeof workspace.id,
        idempotencyKey: string,
      ) => {
        operationOrder.push("replay");
        return (
          stored.find(
            (item) =>
              item.workspaceId === receivedWorkspaceId && item.idempotencyKey === idempotencyKey,
          ) ?? null
        );
      },
      findLatestForKey: async (
        receivedWorkspaceId: typeof workspace.id,
        receivedRoutineId: typeof routine.id,
        receivedInsightKey: string,
      ) => {
        operationOrder.push("latest");
        return latestRoutineDurationInsightFeedback(
          stored,
          receivedWorkspaceId,
          receivedRoutineId,
          receivedInsightKey,
        );
      },
      append: async (candidate: RoutineDurationInsightFeedback) => {
        operationOrder.push("append");
        const result = { ...candidate, ingestedSequence: stored.length + 1 };
        stored.push(result);
        appended.push(result);
        return result;
      },
    },
    workItems: {} as TransactionContext["workItems"],
    workItemDependencies: {
      loadPlanningGraph: async () => ({ workItems: [], dependencies: [] }),
    } as TransactionContext["workItemDependencies"],
    scheduleBlocks: {} as TransactionContext["scheduleBlocks"],
    dailyPlans: {} as TransactionContext["dailyPlans"],
    auditEvents: {} as TransactionContext["auditEvents"],
  } satisfies TransactionContext;
  const unitOfWork: UnitOfWork = {
    run: async (operation, receivedOptions) => {
      runCount += 1;
      unitOfWorkOptions = receivedOptions;
      return operation(context);
    },
  };
  const useCase = new ResetRoutineDurationInsightDismissal(unitOfWork, {
    now: () => {
      operationOrder.push("clock");
      clockCount += 1;
      return new Date(now);
    },
  });
  return {
    useCase,
    appended,
    operationOrder,
    runCount: () => runCount,
    clockCount: () => clockCount,
    unitOfWorkOptions: () => unitOfWorkOptions,
  };
}

const command = {
  workspaceId: workspace.id,
  routineId: routine.id,
  expectedVersion: routine.version,
  insightKey,
  idempotencyKey: " reset-current-dismissal ",
} as const;

describe("ResetRoutineDurationInsightDismissal", () => {
  it("resets one exact active dismissal and snapshots current evidence", async () => {
    const test = harness();

    const result = await test.useCase.execute(command);

    expect(result).toMatchObject({
      ingestedSequence: 2,
      workspaceId: workspace.id,
      routineId: routine.id,
      insightKey,
      kind: "reset",
      routineVersion: 1,
      observedMedianMinutes: 60,
      suggestedExpectedMinutes: 60,
      idempotencyKey: "reset-current-dismissal",
      recordedAt: now,
    });
    expect(test.appended).toEqual([result]);
    expect(test.operationOrder).toEqual([
      "workspace",
      "lock",
      "replay",
      "routine",
      "clock",
      "evidence",
      "latest",
      "append",
    ]);
    expect(test.unitOfWorkOptions()).toEqual({ isolationLevel: "read_committed" });
  });

  it("replays an exact reset before revalidating current state", async () => {
    const prior = feedback({ kind: "reset", idempotencyKey: "reset-current-dismissal" });
    const test = harness({ routine: null, evidence: [], initialFeedback: [prior] });

    await expect(test.useCase.execute(command)).resolves.toBe(prior);
    expect(test.operationOrder).toEqual(["workspace", "lock", "replay"]);
    expect(test.clockCount()).toBe(0);
    expect(test.appended).toEqual([]);
  });

  it("rejects reset when the exact insight is not dismissed", async () => {
    const test = harness({ initialFeedback: [] });

    await expect(test.useCase.execute(command)).rejects.toMatchObject({
      code: "routine_duration_insight.disposition_conflict",
    });
    expect(test.appended).toEqual([]);
  });

  it("rejects reset after evidence changes the exact actionable key", async () => {
    const test = harness({ evidence: completions([70, 80, 90]) });

    await expect(test.useCase.execute(command)).rejects.toMatchObject({
      code: "routine_duration_insight.evidence_conflict",
    });
    expect(test.appended).toEqual([]);
  });

  it("rejects reuse of the reset key for another feedback command", async () => {
    const test = harness({
      initialFeedback: [feedback({ idempotencyKey: "reset-current-dismissal" })],
    });

    await expect(test.useCase.execute(command)).rejects.toMatchObject({
      code: "routine_duration_insight.idempotency_conflict",
    });
    expect(test.operationOrder).toEqual(["workspace", "lock", "replay"]);
  });

  it("checks workspace, routine, and version before recomputing evidence", async () => {
    const missingWorkspace = harness({ workspaceExists: false });
    await expect(missingWorkspace.useCase.execute(command)).rejects.toMatchObject({
      code: "workspace.not_found",
    });
    expect(missingWorkspace.operationOrder).toEqual(["workspace"]);

    const missingRoutine = harness({ routine: null });
    await expect(missingRoutine.useCase.execute(command)).rejects.toMatchObject({
      code: "routine.not_found",
    });
    expect(missingRoutine.operationOrder).toEqual(["workspace", "lock", "replay", "routine"]);

    const stale = harness({ routine: { ...routine, version: 2 } });
    await expect(stale.useCase.execute(command)).rejects.toMatchObject({
      code: "routine.version_conflict",
    });
    expect(stale.operationOrder).toEqual(["workspace", "lock", "replay", "routine"]);
  });

  it("strictly validates reset commands before opening a transaction", async () => {
    const test = harness();

    await expect(test.useCase.execute({ ...command, expectedVersion: 1.5 })).rejects.toMatchObject({
      code: "routine.expected_version_invalid",
    });
    await expect(
      test.useCase.execute({ ...command, insightKey: "0".repeat(63) }),
    ).rejects.toMatchObject({ code: "routine_duration_insight.insight_key_invalid" });
    await expect(
      test.useCase.execute({ ...command, idempotencyKey: "x".repeat(161) }),
    ).rejects.toMatchObject({
      code: "routine_duration_insight.feedback_idempotency_key_invalid",
    });
    expect(test.runCount()).toBe(0);
  });
});
