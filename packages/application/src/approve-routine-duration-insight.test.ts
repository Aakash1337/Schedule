import { describe, expect, it } from "vitest";

import {
  activityEventId,
  createCadencePolicy,
  createDurationRange,
  createRoutine,
  createStructuredTags,
  createWorkspace,
  recordActivityEvent,
  routineId,
  workspaceId,
  type ActivityEvent,
  type DurationRange,
  type Routine,
} from "@schedule/domain";

import { ApproveRoutineDurationInsight } from "./approve-routine-duration-insight.js";
import type { TransactionContext, UnitOfWork, UnitOfWorkOptions } from "./ports.js";

const now = new Date("2026-07-13T18:30:00.000Z");
const workspace = createWorkspace({
  id: workspaceId("duration-approval-workspace"),
  name: "Duration approval",
  now: new Date("2026-01-01T00:00:00.000Z"),
});
const routine = createRoutine({
  id: routineId("duration-approval-routine"),
  workspaceId: workspace.id,
  title: "Language practice",
  tags: createStructuredTags({ priority: "medium" }),
  duration: createDurationRange({
    expectedMinutes: 30,
    minimumMinutes: 10,
    maximumMinutes: 120,
    splittable: true,
    minimumSessionMinutes: 5,
    overheadMinutes: 3,
  }),
  cadence: createCadencePolicy({ period: "week", targetCompletions: 3 }),
  now: new Date("2026-01-01T00:00:00.000Z"),
});

function completions(durations: readonly number[]): readonly ActivityEvent[] {
  return durations.map((durationMinutes, index) =>
    recordActivityEvent({
      id: activityEventId(`duration-approval-event-${index}-${durationMinutes}`),
      workspaceId: workspace.id,
      routineId: routine.id,
      type: "completed",
      occurredAt: new Date(`2026-07-${String(10 + index).padStart(2, "0")}T10:00:00.000Z`),
      timeZone: "UTC",
      durationMinutes,
      idempotencyKey: `duration-approval-${index}-${durationMinutes}`,
      recordedAt: new Date(`2026-07-${String(10 + index).padStart(2, "0")}T10:01:00.000Z`),
    }),
  );
}

function proposedDuration(overrides: Partial<DurationRange> = {}): DurationRange {
  return {
    ...routine.duration,
    expectedMinutes: 60,
    ...overrides,
  };
}

function harness(
  options: {
    workspaceExists?: boolean;
    routineExists?: boolean;
    evidence?: readonly ActivityEvent[];
    clockNow?: Date;
    clockAfterLock?: Date;
  } = {},
) {
  let stored: Routine | null = options.routineExists === false ? null : routine;
  let routineFindCount = 0;
  let evidenceReadCount = 0;
  let clockCount = 0;
  let currentClockNow = options.clockNow ?? now;
  let unitOfWorkOptions: UnitOfWorkOptions | undefined;
  const operationOrder: string[] = [];
  const lockCalls: Array<{
    workspaceId: typeof workspace.id;
    routineId: typeof routine.id;
  }> = [];
  const evidenceCalls: Array<{
    workspaceId: typeof workspace.id;
    routineId: typeof routine.id;
    fromInclusive: Date;
    throughInclusive: Date;
  }> = [];
  const saves: Array<{ routine: Routine; expectedVersion: number }> = [];
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
        routineFindCount += 1;
        return stored;
      },
      list: async () => [],
      listPlanningCandidates: async () => [],
      insert: async () => undefined,
      save: async (candidate: Routine, expectedVersion: number) => {
        operationOrder.push("save");
        saves.push({ routine: candidate, expectedVersion });
        stored = candidate;
      },
    },
    activityEvents: {
      lockRoutineActivity: async (receivedWorkspaceId, receivedRoutineId) => {
        operationOrder.push("lock");
        lockCalls.push({
          workspaceId: receivedWorkspaceId,
          routineId: receivedRoutineId,
        });
        if (options.clockAfterLock !== undefined) {
          currentClockNow = options.clockAfterLock;
        }
      },
      findById: async () => null,
      listForPlanning: async () => [],
      listDurationEvidence: async (
        receivedWorkspaceId: typeof workspace.id,
        receivedRoutineId: typeof routine.id,
        fromInclusive: Date,
        throughInclusive: Date,
      ) => {
        operationOrder.push("evidence");
        evidenceReadCount += 1;
        evidenceCalls.push({
          workspaceId: receivedWorkspaceId,
          routineId: receivedRoutineId,
          fromInclusive,
          throughInclusive,
        });
        return options.evidence ?? completions([50, 60, 70]);
      },
      append: async (event: ActivityEvent) => event,
      listHistory: async () => ({ items: [], nextCursor: null }),
    },
    workItems: {} as TransactionContext["workItems"],
    scheduleBlocks: {} as TransactionContext["scheduleBlocks"],
    dailyPlans: {} as TransactionContext["dailyPlans"],
    auditEvents: {} as TransactionContext["auditEvents"],
  } satisfies TransactionContext;
  const unitOfWork: UnitOfWork = {
    run: async (operation, receivedOptions) => {
      unitOfWorkOptions = receivedOptions;
      return operation(context);
    },
  };
  const useCase = new ApproveRoutineDurationInsight(unitOfWork, {
    now: () => {
      operationOrder.push("clock");
      clockCount += 1;
      return new Date(currentClockNow.getTime());
    },
  });

  return {
    useCase,
    stored: () => stored,
    saves,
    lockCalls,
    operationOrder,
    evidenceCalls,
    evidenceReadCount: () => evidenceReadCount,
    routineFindCount: () => routineFindCount,
    clockCount: () => clockCount,
    unitOfWorkOptions: () => unitOfWorkOptions,
  };
}

const command = {
  workspaceId: workspace.id,
  routineId: routine.id,
  expectedVersion: 1,
  duration: proposedDuration(),
} as const;

describe("ApproveRoutineDurationInsight", () => {
  it("atomically revalidates the current suggestion and saves only its expected duration", async () => {
    const test = harness();

    const updated = await test.useCase.execute(command);

    expect(updated).toMatchObject({
      version: 2,
      duration: proposedDuration(),
      updatedAt: now,
    });
    expect(test.stored()).toBe(updated);
    expect(test.saves).toEqual([{ routine: updated, expectedVersion: 1 }]);
    expect(test.evidenceCalls).toEqual([
      {
        workspaceId: workspace.id,
        routineId: routine.id,
        fromInclusive: new Date("2026-04-14T18:30:00.000Z"),
        throughInclusive: now,
      },
    ]);
    expect(test.lockCalls).toEqual([{ workspaceId: workspace.id, routineId: routine.id }]);
    expect(test.operationOrder).toEqual([
      "workspace",
      "lock",
      "routine",
      "clock",
      "evidence",
      "save",
    ]);
    expect(test.clockCount()).toBe(1);
    expect(test.unitOfWorkOptions()).toEqual({ isolationLevel: "read_committed" });
  });

  it("captures the evidence cutoff after waiting for the activity lock", async () => {
    const beforeLock = new Date("2026-07-13T18:30:00.000Z");
    const afterLock = new Date("2026-07-13T18:31:00.000Z");
    const test = harness({ clockNow: beforeLock, clockAfterLock: afterLock });

    const updated = await test.useCase.execute(command);

    expect(updated.updatedAt).toEqual(afterLock);
    expect(test.evidenceCalls).toEqual([
      {
        workspaceId: workspace.id,
        routineId: routine.id,
        fromInclusive: new Date("2026-04-14T18:31:00.000Z"),
        throughInclusive: afterLock,
      },
    ]);
    expect(test.operationOrder).toEqual([
      "workspace",
      "lock",
      "routine",
      "clock",
      "evidence",
      "save",
    ]);
    expect(test.clockCount()).toBe(1);
  });

  it("rejects a stale routine version before reading evidence", async () => {
    const test = harness();

    await expect(test.useCase.execute({ ...command, expectedVersion: 2 })).rejects.toMatchObject({
      code: "routine.version_conflict",
    });
    expect(test.evidenceReadCount()).toBe(0);
    expect(test.saves).toEqual([]);
  });

  it.each([
    ["no longer suggests a change", [29, 30, 31]],
    ["now suggests a different duration", [70, 80, 90]],
  ])("rejects approval when the evidence %s", async (_label, durations) => {
    const test = harness({ evidence: completions(durations) });

    await expect(test.useCase.execute(command)).rejects.toMatchObject({
      code: "routine_duration_insight.evidence_conflict",
    });
    expect(test.evidenceReadCount()).toBe(1);
    expect(test.saves).toEqual([]);
  });

  it.each([
    ["minimum", { minimumMinutes: 11 }],
    ["maximum", { maximumMinutes: 119 }],
    ["splitting", { splittable: false, minimumSessionMinutes: null }],
    ["minimum session", { minimumSessionMinutes: 6 }],
    ["overhead", { overheadMinutes: 4 }],
  ] satisfies ReadonlyArray<readonly [string, Partial<DurationRange>]>)(
    "rejects approval that changes the user-owned %s setting",
    async (_label, changes) => {
      const test = harness();

      await expect(
        test.useCase.execute({ ...command, duration: proposedDuration(changes) }),
      ).rejects.toMatchObject({ code: "routine_duration_insight.approval_scope_invalid" });
      expect(test.evidenceReadCount()).toBe(0);
      expect(test.saves).toEqual([]);
    },
  );

  it("validates tenant scope and routine existence before reading evidence", async () => {
    const missingWorkspace = harness({ workspaceExists: false });
    await expect(missingWorkspace.useCase.execute(command)).rejects.toMatchObject({
      code: "workspace.not_found",
    });
    expect(missingWorkspace.routineFindCount()).toBe(0);
    expect(missingWorkspace.evidenceReadCount()).toBe(0);
    expect(missingWorkspace.lockCalls).toEqual([]);
    expect(missingWorkspace.operationOrder).toEqual(["workspace"]);
    expect(missingWorkspace.clockCount()).toBe(0);

    const missingRoutine = harness({ routineExists: false });
    await expect(missingRoutine.useCase.execute(command)).rejects.toMatchObject({
      code: "routine.not_found",
    });
    expect(missingRoutine.routineFindCount()).toBe(1);
    expect(missingRoutine.evidenceReadCount()).toBe(0);
    expect(missingRoutine.lockCalls).toEqual([
      { workspaceId: workspace.id, routineId: routine.id },
    ]);
    expect(missingRoutine.operationOrder).toEqual(["workspace", "lock", "routine"]);
    expect(missingRoutine.clockCount()).toBe(0);
  });

  it("rejects an invalid expected version before opening the unit of work", async () => {
    const test = harness();

    await expect(test.useCase.execute({ ...command, expectedVersion: 0 })).rejects.toMatchObject({
      code: "routine.expected_version_invalid",
    });
    expect(test.routineFindCount()).toBe(0);
    expect(test.clockCount()).toBe(0);
    expect(test.lockCalls).toEqual([]);
    expect(test.operationOrder).toEqual([]);
  });
});
