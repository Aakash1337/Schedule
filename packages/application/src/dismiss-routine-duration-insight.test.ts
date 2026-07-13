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

import { DismissRoutineDurationInsight } from "./dismiss-routine-duration-insight.js";
import type { TransactionContext, UnitOfWork, UnitOfWorkOptions } from "./ports.js";

const now = new Date("2026-07-13T18:30:00.000Z");
const workspace = createWorkspace({
  id: workspaceId("duration-dismiss-workspace"),
  name: "Duration dismissal",
  now: new Date("2026-01-01T00:00:00.000Z"),
});
const routine = createRoutine({
  id: routineId("duration-dismiss-routine"),
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

function completions(durations: readonly number[]): readonly ActivityEvent[] {
  return durations.map((durationMinutes, index) =>
    recordActivityEvent({
      id: activityEventId(`duration-dismiss-completion-${index}-${durationMinutes}`),
      workspaceId: workspace.id,
      routineId: routine.id,
      type: "completed",
      occurredAt: new Date(`2026-07-${String(10 + index).padStart(2, "0")}T10:00:00.000Z`),
      timeZone: "UTC",
      durationMinutes,
      idempotencyKey: `duration-dismiss-completion-${index}`,
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
    idempotencyKey: "prior-dismissal",
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
    clockAfterLock?: Date;
  } = {},
) {
  const storedFeedback = [...(options.initialFeedback ?? [])];
  const appended: RoutineDurationInsightFeedback[] = [];
  const operationOrder: string[] = [];
  const evidenceCalls: Array<{ fromInclusive: Date; throughInclusive: Date }> = [];
  let runCount = 0;
  let clockCount = 0;
  let unitOfWorkOptions: UnitOfWorkOptions | undefined;
  let currentNow = now;

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
        if (options.clockAfterLock !== undefined) currentNow = options.clockAfterLock;
      },
      findById: async () => null,
      listForPlanning: async () => [],
      listDurationEvidence: async (
        _workspaceId: typeof workspace.id,
        _routineId: typeof routine.id,
        fromInclusive: Date,
        throughInclusive: Date,
      ) => {
        operationOrder.push("evidence");
        evidenceCalls.push({ fromInclusive, throughInclusive });
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
          storedFeedback.find(
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
          storedFeedback,
          receivedWorkspaceId,
          receivedRoutineId,
          receivedInsightKey,
        );
      },
      append: async (candidate: RoutineDurationInsightFeedback) => {
        operationOrder.push("append");
        const recorded = { ...candidate, ingestedSequence: storedFeedback.length + 1 };
        storedFeedback.push(recorded);
        appended.push(recorded);
        return recorded;
      },
    },
    workItems: {} as TransactionContext["workItems"],
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
  const useCase = new DismissRoutineDurationInsight(unitOfWork, {
    now: () => {
      operationOrder.push("clock");
      clockCount += 1;
      return new Date(currentNow);
    },
  });

  return {
    useCase,
    appended,
    operationOrder,
    evidenceCalls,
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
  idempotencyKey: " dismiss-current-insight ",
} as const;

describe("DismissRoutineDurationInsight", () => {
  it("dismisses one exact actionable insight and snapshots its evidence", async () => {
    const test = harness();

    const result = await test.useCase.execute(command);

    expect(result).toMatchObject({
      ingestedSequence: 1,
      workspaceId: workspace.id,
      routineId: routine.id,
      insightKey,
      kind: "dismissed",
      routineVersion: 1,
      observedMedianMinutes: 60,
      suggestedExpectedMinutes: 60,
      idempotencyKey: "dismiss-current-insight",
      recordedAt: now,
    });
    expect(test.appended).toEqual([result]);
    expect(test.evidenceCalls).toEqual([
      {
        fromInclusive: new Date("2026-04-14T18:30:00.000Z"),
        throughInclusive: now,
      },
    ]);
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

  it("dismisses an actionable range review with no expected-duration suggestion", async () => {
    const evidence = completions([130, 140, 150]);
    const reviewKey = calculateRoutineDurationInsight(routine, evidence, now).insightKey!;
    const test = harness({ evidence });

    await expect(
      test.useCase.execute({ ...command, insightKey: reviewKey }),
    ).resolves.toMatchObject({
      insightKey: reviewKey,
      kind: "dismissed",
      observedMedianMinutes: 140,
      suggestedExpectedMinutes: null,
    });
  });

  it("replays an exact dismissal before revalidating current state", async () => {
    const prior = feedback({ idempotencyKey: "dismiss-current-insight" });
    const test = harness({ routine: null, evidence: [], initialFeedback: [prior] });

    await expect(test.useCase.execute(command)).resolves.toBe(prior);
    expect(test.operationOrder).toEqual(["workspace", "lock", "replay"]);
    expect(test.clockCount()).toBe(0);
    expect(test.appended).toEqual([]);
  });

  it("rejects reuse of a dismissal idempotency key for different semantics", async () => {
    const test = harness({
      initialFeedback: [feedback({ kind: "reset", idempotencyKey: "dismiss-current-insight" })],
    });

    await expect(test.useCase.execute(command)).rejects.toMatchObject({
      code: "routine_duration_insight.idempotency_conflict",
    });
    expect(test.operationOrder).toEqual(["workspace", "lock", "replay"]);
    expect(test.appended).toEqual([]);
  });

  it("rejects a stale routine version before reading evidence", async () => {
    const test = harness({ routine: { ...routine, version: 2 } });

    await expect(test.useCase.execute(command)).rejects.toMatchObject({
      code: "routine.version_conflict",
    });
    expect(test.operationOrder).toEqual(["workspace", "lock", "replay", "routine"]);
    expect(test.clockCount()).toBe(0);
  });

  it("rejects feedback when the current actionable evidence has another key", async () => {
    const test = harness({ evidence: completions([70, 80, 90]) });

    await expect(test.useCase.execute(command)).rejects.toMatchObject({
      code: "routine_duration_insight.evidence_conflict",
    });
    expect(test.appended).toEqual([]);
  });

  it("rejects another dismissal while the exact insight is already dismissed", async () => {
    const test = harness({ initialFeedback: [feedback()] });

    await expect(
      test.useCase.execute({ ...command, idempotencyKey: "another-dismissal" }),
    ).rejects.toMatchObject({ code: "routine_duration_insight.disposition_conflict" });
    expect(test.appended).toEqual([]);
  });

  it("captures the evidence cutoff after waiting for the activity lock", async () => {
    const afterLock = new Date("2026-07-13T18:31:00.000Z");
    const test = harness({ clockAfterLock: afterLock });

    await test.useCase.execute(command);

    expect(test.evidenceCalls).toEqual([
      {
        fromInclusive: new Date("2026-04-14T18:31:00.000Z"),
        throughInclusive: afterLock,
      },
    ]);
    expect(test.clockCount()).toBe(1);
  });

  it("validates commands before opening the unit of work", async () => {
    const test = harness();

    await expect(test.useCase.execute({ ...command, expectedVersion: 0 })).rejects.toMatchObject({
      code: "routine.expected_version_invalid",
    });
    await expect(test.useCase.execute({ ...command, insightKey: "ABC" })).rejects.toMatchObject({
      code: "routine_duration_insight.insight_key_invalid",
    });
    await expect(test.useCase.execute({ ...command, idempotencyKey: "   " })).rejects.toMatchObject(
      { code: "routine_duration_insight.feedback_idempotency_key_invalid" },
    );
    expect(test.runCount()).toBe(0);
  });

  it("validates tenant scope and routine existence before evidence", async () => {
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
  });
});
