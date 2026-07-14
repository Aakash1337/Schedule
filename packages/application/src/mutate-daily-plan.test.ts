import { describe, expect, it } from "vitest";

import {
  createCadencePolicy,
  createDailyPlanningRequest,
  createDurationRange,
  createRoutine,
  createRoutinePlanningFeedback,
  createStructuredTags,
  createWorkItem,
  createWorkItemDependency,
  createWorkspace,
  dailyPlanId,
  generateDailyPlan,
  planItemId,
  routineId,
  routinePlanningFeedbackId,
  workItemId,
  workspaceId,
  type DailyPlan,
  type PlanningWorkItemDependency,
  type Routine,
  type RoutinePlanningFeedback,
  type WorkItem,
} from "@schedule/domain";

import { MutateDailyPlan } from "./mutate-daily-plan.js";
import type {
  PlanMutationRecord,
  TransactionContext,
  UnitOfWork,
  UnitOfWorkOptions,
} from "./ports.js";

describe("MutateDailyPlan", () => {
  const workspace = workspaceId("mutation-workspace");
  const routines = ["locked", "original", "alternative"].map((name) =>
    createRoutine({
      id: routineId(name),
      workspaceId: workspace,
      title: name,
      tags: createStructuredTags(),
      duration: createDurationRange({ expectedMinutes: 30 }),
      cadence: createCadencePolicy({ period: "week" }),
      now: new Date("2026-07-01T00:00:00.000Z"),
    }),
  );
  const request = createDailyPlanningRequest({
    workspaceId: workspace,
    date: "2026-07-15",
    timeZone: "UTC",
    availableWindows: [
      {
        startsAt: new Date("2026-07-15T08:00:00.000Z"),
        endsAt: new Date("2026-07-15T09:00:00.000Z"),
      },
    ],
    targetMinutes: 60,
    targetTaskCount: 2,
    seed: "source",
  });

  function harness(
    options: {
      readonly routineCandidates?: readonly Routine[];
      readonly workItemCandidates?: readonly WorkItem[];
      readonly workItemDependencies?: readonly PlanningWorkItemDependency[];
    } = {},
  ) {
    const generated = generateDailyPlan({
      id: dailyPlanId("mutation-source"),
      request,
      routines: routines.slice(0, 2),
      events: [],
      generatedAt: new Date("2026-07-15T07:00:00.000Z"),
    });
    let current: DailyPlan | null = {
      ...generated,
      items: generated.items.map((item, index) => ({ ...item, locked: index === 0 })),
    };
    let headVersion = 2;
    let feedbackLockCount = 0;
    let dependencyLockCount = 0;
    const planningGraphLoads: Array<{ workItemLimit: number; dependencyLimit: number }> = [];
    const mutations: PlanMutationRecord[] = [];
    const routineFeedback: RoutinePlanningFeedback[] = [];
    const invalidatedTargets: string[] = [];
    let unitOfWorkOptions: UnitOfWorkOptions | undefined;
    const context = {
      workspaces: {
        findById: async () => createWorkspace({ id: workspace, name: "Test" }),
        list: async () => [],
        insert: async () => undefined,
      },
      routines: {
        findById: async () => null,
        list: async () => routines,
        listPlanningCandidates: async () => options.routineCandidates ?? routines,
        insert: async (_routine: Routine) => undefined,
        save: async () => undefined,
      },
      activityEvents: {
        lockRoutineActivity: async () => undefined,
        findById: async () => null,
        listForPlanning: async () => [],
        listDurationEvidence: async () => [],
        append: async (event) => event,
        listHistory: async () => ({ items: [], nextCursor: null }),
      },
      dailyPlans: {
        findById: async (_workspace, id) => (current?.id === id ? current : null),
        findByRevision: async () => null,
        insertForRevision: async (plan: DailyPlan) => {
          current = plan;
          headVersion += 1;
          return plan;
        },
        findCurrent: async () => (current === null ? null : { plan: current, headVersion }),
        findCurrentForDates: async (_workspaceId, dates) =>
          current === null || !dates.includes(current.date)
            ? new Map()
            : new Map([[current.date, { plan: current, headVersion }]]),
        setItemLock: async () => {
          throw new Error("not used");
        },
        recordItemActivity: async () => {
          throw new Error("not used");
        },
        lockDay: async () => undefined,
        lockRoutineFeedback: async () => {
          feedbackLockCount += 1;
        },
        findLatestRoutineFeedback: async (_workspace, routine) =>
          routineFeedback
            .filter((entry) => entry.routineId === routine)
            .sort(
              (left, right) =>
                right.ingestedSequence - left.ingestedSequence || right.id.localeCompare(left.id),
            )[0] ?? null,
        findMutation: async (_workspace, date, key) =>
          mutations.find((mutation) => mutation.date === date && mutation.idempotencyKey === key) ??
          null,
        insertMutation: async (mutation: PlanMutationRecord) => {
          mutations.push(mutation);
        },
        listRoutineFeedbackForPlanning: async () => routineFeedback,
        appendRoutineFeedback: async (feedback: RoutinePlanningFeedback) => {
          const persisted = { ...feedback, ingestedSequence: routineFeedback.length + 1 };
          routineFeedback.push(persisted);
          return persisted;
        },
      },
      workItems: {
        listPlanningCandidates: async () => {
          throw new Error("separate work-item candidate reads are forbidden");
        },
      } as TransactionContext["workItems"],
      workItemDependencies: {
        lockWorkspace: async () => {
          dependencyLockCount += 1;
        },
        listForPlanning: async () => {
          throw new Error("separate dependency planning reads are forbidden");
        },
        loadPlanningGraph: async (_workspaceId, workItemLimit, dependencyLimit) => {
          planningGraphLoads.push({ workItemLimit, dependencyLimit });
          return {
            workItems: options.workItemCandidates ?? [],
            dependencies: options.workItemDependencies ?? [],
          };
        },
      } as TransactionContext["workItemDependencies"],
      scheduleBlocks: {} as TransactionContext["scheduleBlocks"],
      notifications: {
        lockWorkspace: async () => undefined,
        deleteIntentsForTarget: async (_workspaceId, targetType, targetId) => {
          invalidatedTargets.push(`${targetType}:${targetId}`);
          return 0;
        },
      } as TransactionContext["notifications"],
      auditEvents: {} as TransactionContext["auditEvents"],
    } satisfies TransactionContext;
    const unitOfWork: UnitOfWork = {
      run: async (operation, options) => {
        unitOfWorkOptions = options;
        return operation(context);
      },
    };
    return {
      useCase: new MutateDailyPlan(unitOfWork, {
        now: () => new Date("2026-07-15T07:30:00.000Z"),
      }),
      source: current,
      current: () => {
        if (current === null) throw new Error("No current plan.");
        return current;
      },
      setCurrent: (plan: DailyPlan) => {
        current = plan;
      },
      clearCurrent: () => {
        current = null;
      },
      setHeadVersion: (value: number) => {
        headVersion = value;
      },
      mutations: () => mutations,
      routineFeedback: () => routineFeedback,
      feedbackLockCount: () => feedbackLockCount,
      dependencyLockCount: () => dependencyLockCount,
      planningGraphLoads,
      invalidatedTargets,
      unitOfWorkOptions: () => unitOfWorkOptions,
    };
  }

  it("carries locks into a server-allocated immutable revision and replays idempotently", async () => {
    const test = harness();
    const command = {
      workspaceId: workspace,
      expectedPlanId: test.source.id,
      expectedHeadVersion: 2,
      request: { ...request, seed: "regenerated" },
      idempotencyKey: "regenerate-once",
    };
    const first = await test.useCase.regenerate(command);
    const retry = await test.useCase.regenerate({
      ...command,
      request: { ...command.request, requestRevision: 999 },
    });

    expect(first.plan.requestRevision).toBe(2);
    expect(first.headVersion).toBe(3);
    expect(first.plan.items.some((item) => item.locked)).toBe(true);
    expect(retry).toEqual(first);
    expect(test.unitOfWorkOptions()).toBeUndefined();
    expect(test.invalidatedTargets).toEqual([`daily_plan:${test.source.id}`]);
  });

  it("loads dependencies during regeneration and excludes an unmet unlocked dependent", async () => {
    const dependent = createWorkItem({
      id: workItemId("mutation-dependent-work"),
      workspaceId: workspace,
      title: "Publish after approval",
      planningDurationMinutes: 30,
    });
    const dependency = {
      ...createWorkItemDependency({
        workspaceId: workspace,
        prerequisiteWorkItemId: workItemId("mutation-prerequisite-work"),
        dependentWorkItemId: dependent.id,
        createdAt: new Date("2026-07-14T12:00:00.000Z"),
      }),
      prerequisiteStatus: "in_progress" as const,
    };
    const test = harness({
      routineCandidates: routines.slice(0, 2),
      workItemCandidates: [dependent],
      workItemDependencies: [dependency],
    });

    const result = await test.useCase.regenerate({
      workspaceId: workspace,
      expectedPlanId: test.source.id,
      expectedHeadVersion: 2,
      request: { ...request, seed: "dependency-regeneration" },
      idempotencyKey: "dependency-regeneration",
    });

    expect(result.plan.items.some((item) => item.workItemId === dependent.id)).toBe(false);
    expect(result.plan.exclusions).toContainEqual(
      expect.objectContaining({
        workItemId: dependent.id,
        codes: ["work_item_dependency_unsatisfied"],
      }),
    );
    expect(test.dependencyLockCount()).toBe(0);
    expect(test.planningGraphLoads).toEqual([{ workItemLimit: 501, dependencyLimit: 2_001 }]);
  });

  it("fails closed when regeneration dependency data exceeds 2,000 relevant rows", async () => {
    const dependent = createWorkItem({
      id: workItemId("mutation-bounded-dependent"),
      workspaceId: workspace,
      title: "Bounded dependency work",
      planningDurationMinutes: 30,
    });
    const dependency = {
      ...createWorkItemDependency({
        workspaceId: workspace,
        prerequisiteWorkItemId: workItemId("mutation-bounded-prerequisite"),
        dependentWorkItemId: dependent.id,
        createdAt: new Date("2026-07-14T12:00:00.000Z"),
      }),
      prerequisiteStatus: "backlog" as const,
    };
    const test = harness({
      workItemCandidates: [dependent],
      workItemDependencies: Array.from({ length: 2_001 }, () => dependency),
    });

    await expect(
      test.useCase.regenerate({
        workspaceId: workspace,
        expectedPlanId: test.source.id,
        expectedHeadVersion: 2,
        request: { ...request, seed: "bounded-dependency-regeneration" },
        idempotencyKey: "bounded-dependency-regeneration",
      }),
    ).rejects.toMatchObject({ code: "planning.work_item_dependency_pool_too_large" });
    expect(test.mutations()).toEqual([]);
  });

  it("replaces one unlocked item, preserves its sibling, and replays the allocated revision", async () => {
    const test = harness();
    const target = test.source.items.find((item) => !item.locked)!;
    const retained = test.source.items.find((item) => item.locked)!;
    const command = {
      workspaceId: workspace,
      expectedPlanId: test.source.id,
      expectedHeadVersion: 2,
      targetItemId: target.id,
      request: { ...request, seed: "replace-target" },
      idempotencyKey: "replace-once",
    };

    const first = await test.useCase.replace(command);
    const replay = await test.useCase.replace({
      ...command,
      request: { ...command.request, requestRevision: 999 },
    });

    expect(first.headVersion).toBe(3);
    expect(first.plan.items.some((item) => item.routineId === target.routineId)).toBe(false);
    expect(first.plan.items.find((item) => item.routineId === retained.routineId)).toMatchObject({
      locked: true,
      position: retained.position,
      scheduledMinutes: retained.scheduledMinutes,
    });
    expect(replay).toEqual(first);
    expect(test.mutations()).toHaveLength(1);
  });

  it("records routine-only weekly feedback, replans immediately, and replays idempotently", async () => {
    const test = harness();
    const target = test.source.items.find((item) => !item.locked)!;
    const retained = test.source.items.find((item) => item.locked)!;
    const command = {
      workspaceId: workspace,
      expectedPlanId: test.source.id,
      expectedHeadVersion: 2,
      targetItemId: target.id,
      kind: "not_this_week" as const,
      request: { ...request, seed: "feedback-week" },
      idempotencyKey: "feedback-week-once",
    };

    const first = await test.useCase.applyRoutineFeedback(command);
    const retry = await test.useCase.applyRoutineFeedback({
      ...command,
      request: { ...command.request, requestRevision: 999 },
    });

    expect(first.headVersion).toBe(3);
    expect(first.plan.items.some((item) => item.routineId === target.routineId)).toBe(false);
    expect(first.plan.items.some((item) => item.routineId === retained.routineId)).toBe(true);
    expect(first.plan.exclusions).toContainEqual(
      expect.objectContaining({
        routineId: target.routineId,
        codes: expect.arrayContaining(["feedback_not_this_week"]),
      }),
    );
    expect(test.routineFeedback()).toHaveLength(1);
    expect(test.routineFeedback()[0]).toMatchObject({
      routineId: target.routineId,
      kind: "not_this_week",
      effectiveOn: request.date,
      timeZone: request.timeZone,
      sourcePlanId: test.source.id,
      sourcePlanItemId: target.id,
    });
    expect(retry).toEqual(first);
    expect(test.unitOfWorkOptions()).toEqual({ isolationLevel: "read_committed" });
  });

  it("uses one combined graph during feedback and keeps an unmet dependent out of freed capacity", async () => {
    const dependent = createWorkItem({
      id: workItemId("feedback-dependent-work"),
      workspaceId: workspace,
      title: "Publish after prerequisite",
      planningDurationMinutes: 30,
    });
    const dependency = {
      ...createWorkItemDependency({
        workspaceId: workspace,
        prerequisiteWorkItemId: workItemId("feedback-prerequisite-work"),
        dependentWorkItemId: dependent.id,
        createdAt: new Date("2026-07-14T12:00:00.000Z"),
      }),
      prerequisiteStatus: "in_progress" as const,
    };
    const test = harness({
      routineCandidates: routines.slice(0, 2),
      workItemCandidates: [dependent],
      workItemDependencies: [dependency],
    });
    const target = test.source.items.find((item) => !item.locked)!;

    const result = await test.useCase.applyRoutineFeedback({
      workspaceId: workspace,
      expectedPlanId: test.source.id,
      expectedHeadVersion: 2,
      targetItemId: target.id,
      kind: "not_today",
      request: { ...request, seed: "dependency-feedback" },
      idempotencyKey: "dependency-feedback",
    });

    expect(result.plan.items.some((item) => item.workItemId === dependent.id)).toBe(false);
    expect(result.plan.exclusions).toContainEqual(
      expect.objectContaining({
        workItemId: dependent.id,
        codes: ["work_item_dependency_unsatisfied"],
      }),
    );
    expect(test.planningGraphLoads).toEqual([{ workItemLimit: 501, dependencyLimit: 2_001 }]);
    expect(test.unitOfWorkOptions()).toEqual({ isolationLevel: "read_committed" });
  });

  it("appends a reset and replans without resurrecting the prior suppression", async () => {
    const test = harness();
    const target = test.source.items.find((item) => !item.locked)!;
    const suppressed = await test.useCase.applyRoutineFeedback({
      workspaceId: workspace,
      expectedPlanId: test.source.id,
      expectedHeadVersion: 2,
      targetItemId: target.id,
      kind: "not_today",
      request: { ...request, seed: "feedback-today" },
      idempotencyKey: "feedback-today",
    });

    const reset = await test.useCase.resetRoutineFeedback({
      workspaceId: workspace,
      expectedPlanId: suppressed.plan.id,
      expectedHeadVersion: suppressed.headVersion,
      routineId: target.routineId!,
      request: { ...request, seed: "feedback-reset" },
      idempotencyKey: "feedback-reset",
    });

    expect(reset.headVersion).toBe(4);
    expect(
      reset.plan.exclusions.some(
        (exclusion) =>
          exclusion.routineId === target.routineId &&
          exclusion.codes.some((code) => code.startsWith("feedback_")),
      ),
    ).toBe(false);
    expect(test.routineFeedback().map((entry) => entry.kind)).toEqual(["not_today", "reset"]);
    expect(test.routineFeedback()[1]).toMatchObject({ sourcePlanItemId: null });
  });

  it("uses one combined graph during feedback reset and still excludes an unmet dependent", async () => {
    const dependent = createWorkItem({
      id: workItemId("feedback-reset-dependent-work"),
      workspaceId: workspace,
      title: "Ship after prerequisite",
      planningDurationMinutes: 30,
    });
    const dependency = {
      ...createWorkItemDependency({
        workspaceId: workspace,
        prerequisiteWorkItemId: workItemId("feedback-reset-prerequisite-work"),
        dependentWorkItemId: dependent.id,
        createdAt: new Date("2026-07-14T12:00:00.000Z"),
      }),
      prerequisiteStatus: "backlog" as const,
    };
    const test = harness({
      routineCandidates: routines.slice(0, 2),
      workItemCandidates: [dependent],
      workItemDependencies: [dependency],
    });
    const target = test.source.items.find((item) => !item.locked)!;
    const suppressed = await test.useCase.applyRoutineFeedback({
      workspaceId: workspace,
      expectedPlanId: test.source.id,
      expectedHeadVersion: 2,
      targetItemId: target.id,
      kind: "not_today",
      request: { ...request, seed: "dependency-feedback-reset-source" },
      idempotencyKey: "dependency-feedback-reset-source",
    });
    test.planningGraphLoads.length = 0;

    const reset = await test.useCase.resetRoutineFeedback({
      workspaceId: workspace,
      expectedPlanId: suppressed.plan.id,
      expectedHeadVersion: suppressed.headVersion,
      routineId: target.routineId!,
      request: { ...request, seed: "dependency-feedback-reset" },
      idempotencyKey: "dependency-feedback-reset",
    });

    expect(reset.plan.items.some((item) => item.workItemId === dependent.id)).toBe(false);
    expect(reset.plan.exclusions).toContainEqual(
      expect.objectContaining({
        workItemId: dependent.id,
        codes: ["work_item_dependency_unsatisfied"],
      }),
    );
    expect(test.planningGraphLoads).toEqual([{ workItemLimit: 501, dependencyLimit: 2_001 }]);
    expect(test.unitOfWorkOptions()).toEqual({ isolationLevel: "read_committed" });
  });

  it("rejects routine feedback from a plan that observed an older cross-date feedback head", async () => {
    const test = harness();
    const target = test.source.items.find((item) => !item.locked)!;
    test.routineFeedback().push(
      createRoutinePlanningFeedback({
        ingestedSequence: 1,
        workspaceId: workspace,
        routineId: target.routineId!,
        kind: "reset",
        effectiveOn: "2026-07-16",
        weekStartsOn: 1,
        timeZone: "UTC",
        sourcePlanId: test.source.id,
        sourcePlanItemId: null,
        idempotencyKey: "newer-date-reset",
        recordedAt: new Date("2026-07-16T07:00:00.000Z"),
      }),
    );

    await expect(
      test.useCase.applyRoutineFeedback({
        workspaceId: workspace,
        expectedPlanId: test.source.id,
        expectedHeadVersion: 2,
        targetItemId: target.id,
        kind: "not_this_week",
        request: { ...request, seed: "stale-cross-date-feedback" },
        idempotencyKey: "stale-cross-date-feedback",
      }),
    ).rejects.toMatchObject({ code: "planning.feedback_head_conflict" });
    expect(test.routineFeedback()).toHaveLength(1);
  });

  it("compares the complete canonical feedback head when ingestion sequences tie", async () => {
    const test = harness();
    const target = test.source.items.find((item) => !item.locked)!;
    const older = createRoutinePlanningFeedback({
      id: routinePlanningFeedbackId("85000000-0000-4000-8000-000000000001"),
      ingestedSequence: 1,
      workspaceId: workspace,
      routineId: target.routineId!,
      kind: "reset",
      effectiveOn: request.date,
      weekStartsOn: 1,
      timeZone: "UTC",
      sourcePlanId: test.source.id,
      sourcePlanItemId: null,
      idempotencyKey: "same-sequence-older",
      recordedAt: new Date("2026-07-15T07:05:00.000Z"),
    });
    const newer = {
      ...older,
      id: routinePlanningFeedbackId("95000000-0000-4000-8000-000000000001"),
      idempotencyKey: "same-sequence-newer",
      recordedAt: new Date("2026-07-15T07:10:00.000Z"),
    };
    const snapshot = test.source.inputSnapshot as Readonly<Record<string, unknown>>;
    test.setCurrent({
      ...test.source,
      inputSnapshot: {
        ...snapshot,
        routineFeedback: JSON.parse(JSON.stringify([older])) as never,
      },
    });
    test.routineFeedback().push(older, newer);

    await expect(
      test.useCase.resetRoutineFeedback({
        workspaceId: workspace,
        expectedPlanId: test.source.id,
        expectedHeadVersion: 2,
        routineId: target.routineId!,
        request: { ...request, seed: "same-sequence-conflict" },
        idempotencyKey: "same-sequence-conflict",
      }),
    ).rejects.toMatchObject({ code: "planning.feedback_head_conflict" });
  });

  it("replays an accepted feedback command after the routine feedback head advances", async () => {
    const test = harness();
    const target = test.source.items.find((item) => !item.locked)!;
    const command = {
      workspaceId: workspace,
      expectedPlanId: test.source.id,
      expectedHeadVersion: 2,
      targetItemId: target.id,
      kind: "not_today" as const,
      request: { ...request, seed: "replay-after-advance" },
      idempotencyKey: "replay-after-advance",
    };
    const accepted = await test.useCase.applyRoutineFeedback(command);
    const locksAfterAcceptance = test.feedbackLockCount();
    test.routineFeedback().push(
      createRoutinePlanningFeedback({
        ingestedSequence: 2,
        workspaceId: workspace,
        routineId: target.routineId!,
        kind: "reset",
        effectiveOn: "2026-07-16",
        weekStartsOn: 1,
        timeZone: "UTC",
        sourcePlanId: accepted.plan.id,
        sourcePlanItemId: null,
        idempotencyKey: "newer-feedback-head",
        recordedAt: new Date("2026-07-16T07:00:00.000Z"),
      }),
    );

    await expect(
      test.useCase.applyRoutineFeedback({
        ...command,
        request: { ...command.request, requestRevision: 999 },
      }),
    ).resolves.toEqual(accepted);
    expect(test.feedbackLockCount()).toBe(locksAfterAcceptance);
    expect(test.routineFeedback()).toHaveLength(2);
  });

  it("accepts a legacy source snapshot with no feedback collection when no global head exists", async () => {
    const test = harness();
    const target = test.source.items.find((item) => !item.locked)!;
    const snapshot = test.source.inputSnapshot as Readonly<Record<string, unknown>>;
    const { routineFeedback: _legacyMissingField, ...legacySnapshot } = snapshot;
    void _legacyMissingField;
    test.setCurrent({
      ...test.source,
      algorithmVersion: "deterministic-planner-v2",
      inputSnapshot: legacySnapshot as never,
    });

    await expect(
      test.useCase.applyRoutineFeedback({
        workspaceId: workspace,
        expectedPlanId: test.source.id,
        expectedHeadVersion: 2,
        targetItemId: target.id,
        kind: "not_today",
        request: { ...request, seed: "legacy-feedback-snapshot" },
        idempotencyKey: "legacy-feedback-snapshot",
      }),
    ).resolves.toMatchObject({ headVersion: 3 });
  });

  it("fails closed when a source plan contains malformed feedback-head metadata", async () => {
    const test = harness();
    const target = test.source.items.find((item) => !item.locked)!;
    const snapshot = test.source.inputSnapshot as Readonly<Record<string, unknown>>;
    test.setCurrent({
      ...test.source,
      inputSnapshot: {
        ...snapshot,
        routineFeedback: [
          {
            id: "malformed-feedback",
            routineId: target.routineId,
            ingestedSequence: 0,
          },
        ],
      } as never,
    });

    await expect(
      test.useCase.resetRoutineFeedback({
        workspaceId: workspace,
        expectedPlanId: test.source.id,
        expectedHeadVersion: 2,
        routineId: target.routineId!,
        request: { ...request, seed: "malformed-feedback-head" },
        idempotencyKey: "malformed-feedback-head",
      }),
    ).rejects.toMatchObject({ code: "planning.feedback_snapshot_invalid" });
  });

  it("rejects feedback for locked, started, or non-routine items", async () => {
    const locked = harness();
    const lockedTarget = locked.source.items.find((item) => item.locked)!;
    const base = {
      workspaceId: workspace,
      expectedPlanId: locked.source.id,
      expectedHeadVersion: 2,
      kind: "not_today" as const,
      request: { ...request, seed: "feedback-guard" },
      idempotencyKey: "feedback-guard",
    };
    await expect(
      locked.useCase.applyRoutineFeedback({ ...base, targetItemId: lockedTarget.id }),
    ).rejects.toMatchObject({ code: "planning.item_locked" });

    const started = harness();
    const startedTarget = started.source.items.find((item) => !item.locked)!;
    started.setCurrent({
      ...started.source,
      items: started.source.items.map((item) =>
        item.id === startedTarget.id ? { ...item, activityState: "started" } : item,
      ),
    });
    await expect(
      started.useCase.applyRoutineFeedback({
        ...base,
        targetItemId: startedTarget.id,
        idempotencyKey: "feedback-started",
      }),
    ).rejects.toMatchObject({ code: "planning.feedback_item_not_pending" });

    const workItem = harness();
    const workItemTarget = workItem.source.items.find((item) => !item.locked)!;
    workItem.setCurrent({
      ...workItem.source,
      items: workItem.source.items.map((item) =>
        item.id === workItemTarget.id
          ? {
              ...item,
              sourceType: "work_item",
              routineId: null,
              workItemId: "feedback-work-item" as never,
            }
          : item,
      ),
    } as DailyPlan);
    await expect(
      workItem.useCase.applyRoutineFeedback({
        ...base,
        targetItemId: workItemTarget.id,
        idempotencyKey: "feedback-work-item",
      }),
    ).rejects.toMatchObject({ code: "planning.feedback_routine_required" });
  });

  it("does not carry a terminal locked item into a regenerated revision", async () => {
    const test = harness();
    const terminal = test.source.items.find((item) => item.locked)!;
    test.setCurrent({
      ...test.source,
      items: test.source.items.map((item) =>
        item.id === terminal.id ? { ...item, activityState: "completed", locked: true } : item,
      ),
    });

    const result = await test.useCase.regenerate({
      workspaceId: workspace,
      expectedPlanId: test.source.id,
      expectedHeadVersion: 2,
      request: { ...request, seed: "terminal-regeneration" },
      idempotencyKey: "terminal-regeneration",
    });

    expect(result.plan.items.some((item) => item.routineId === terminal.routineId)).toBe(false);
    expect(result.plan.items.every((item) => item.activityState === "pending")).toBe(true);
  });

  it("replaces an item when its sibling is terminal without retaining that sibling", async () => {
    const test = harness();
    const terminalSibling = test.source.items.find((item) => item.locked)!;
    const target = test.source.items.find((item) => !item.locked)!;
    test.setCurrent({
      ...test.source,
      items: test.source.items.map((item) =>
        item.id === terminalSibling.id ? { ...item, activityState: "skipped", locked: true } : item,
      ),
    });

    const result = await test.useCase.replace({
      workspaceId: workspace,
      expectedPlanId: test.source.id,
      expectedHeadVersion: 2,
      targetItemId: target.id,
      request: { ...request, seed: "terminal-sibling-replacement" },
      idempotencyKey: "terminal-sibling-replacement",
    });

    expect(result.plan.items.some((item) => item.routineId === terminalSibling.routineId)).toBe(
      false,
    );
    expect(result.plan.items.some((item) => item.routineId === target.routineId)).toBe(false);
  });

  it("defensively rejects malformed persisted routine and work-item source identities", async () => {
    const routineSource = harness();
    const routineTarget = routineSource.source.items.find((item) => !item.locked)!;
    routineSource.setCurrent({
      ...routineSource.source,
      items: routineSource.source.items.map((item) =>
        item.id === routineTarget.id ? { ...item, routineId: null } : item,
      ),
    } as DailyPlan);
    await expect(
      routineSource.useCase.replace({
        workspaceId: workspace,
        expectedPlanId: routineSource.source.id,
        expectedHeadVersion: 2,
        targetItemId: routineTarget.id,
        request: { ...request, seed: "malformed-routine-source" },
        idempotencyKey: "malformed-routine-source",
      }),
    ).rejects.toMatchObject({ code: "planning.source_invalid" });

    const workItemSource = harness();
    const workItemTarget = workItemSource.source.items.find((item) => !item.locked)!;
    workItemSource.setCurrent({
      ...workItemSource.source,
      items: workItemSource.source.items.map((item) =>
        item.id === workItemTarget.id
          ? { ...item, sourceType: "work_item", routineId: null, workItemId: null }
          : item,
      ),
    } as DailyPlan);
    await expect(
      workItemSource.useCase.replace({
        workspaceId: workspace,
        expectedPlanId: workItemSource.source.id,
        expectedHeadVersion: 2,
        targetItemId: workItemTarget.id,
        request: { ...request, seed: "malformed-work-item-source" },
        idempotencyKey: "malformed-work-item-source",
      }),
    ).rejects.toMatchObject({ code: "planning.source_invalid" });
  });

  it("excludes a valid work-item source when replacing it", async () => {
    const test = harness();
    const target = test.source.items.find((item) => !item.locked)!;
    test.setCurrent({
      ...test.source,
      items: test.source.items.map((item) =>
        item.id === target.id
          ? {
              ...item,
              sourceType: "work_item",
              routineId: null,
              workItemId: "replacement-work-item" as never,
            }
          : item,
      ),
    } as DailyPlan);

    await expect(
      test.useCase.replace({
        workspaceId: workspace,
        expectedPlanId: test.source.id,
        expectedHeadVersion: 2,
        targetItemId: target.id,
        request: { ...request, seed: "valid-work-item-source" },
        idempotencyKey: "valid-work-item-source",
      }),
    ).resolves.toMatchObject({ headVersion: 3 });
  });

  it("rejects mutations without a current plan or with a mismatched request scope", async () => {
    const missing = harness();
    missing.clearCurrent();
    await expect(
      missing.useCase.regenerate({
        workspaceId: workspace,
        expectedPlanId: missing.source.id,
        expectedHeadVersion: 2,
        request: { ...request, seed: "missing-current" },
        idempotencyKey: "missing-current",
      }),
    ).rejects.toMatchObject({ code: "planning.current_not_found" });

    const mismatched = harness();
    await expect(
      mismatched.useCase.regenerate({
        workspaceId: workspace,
        expectedPlanId: mismatched.source.id,
        expectedHeadVersion: 2,
        request: {
          ...request,
          workspaceId: workspaceId("different-workspace"),
          seed: "wrong-scope",
        },
        idempotencyKey: "wrong-scope",
      }),
    ).rejects.toMatchObject({ code: "planning.source_mismatch" });
  });

  it.each(["regenerate", "replace"] as const)(
    "rejects a combined candidate pool above 500 during %s",
    async (operation) => {
      const test = harness({
        routineCandidates: Array.from({ length: 251 }, () => routines[0]!),
        workItemCandidates: Array.from({ length: 250 }, (_, index) =>
          createWorkItem({
            workspaceId: workspace,
            title: `Candidate work ${index + 1}`,
            planningDurationMinutes: 15,
          }),
        ),
      });
      const command = {
        workspaceId: workspace,
        expectedPlanId: test.source.id,
        expectedHeadVersion: 2,
        request: { ...request, seed: `too-many-${operation}` },
        idempotencyKey: `too-many-${operation}`,
      };

      const result =
        operation === "regenerate"
          ? test.useCase.regenerate(command)
          : test.useCase.replace({
              ...command,
              targetItemId: test.source.items.find((item) => !item.locked)!.id,
            });
      await expect(result).rejects.toMatchObject({ code: "planning.candidate_pool_too_large" });
    },
  );

  it("rejects stale heads, conflicting mutation keys, and invalid replacement targets", async () => {
    const test = harness();
    const target = test.source.items.find((item) => !item.locked)!;
    const base = {
      workspaceId: workspace,
      expectedPlanId: test.source.id,
      expectedHeadVersion: 2,
      targetItemId: target.id,
      request: { ...request, seed: "mutation-guards" },
      idempotencyKey: "shared-key",
    };

    test.setHeadVersion(3);
    await expect(test.useCase.replace(base)).rejects.toMatchObject({
      code: "planning.head_conflict",
    });
    test.setHeadVersion(2);
    await test.useCase.replace(base);
    await expect(
      test.useCase.replace({ ...base, request: { ...base.request, seed: "other-payload" } }),
    ).rejects.toMatchObject({ code: "planning.idempotency_conflict" });
    await expect(
      test.useCase.replace({
        ...base,
        idempotencyKey: "unknown-target",
        expectedPlanId: test.current().id,
        expectedHeadVersion: 3,
        targetItemId: planItemId("not-an-item"),
      }),
    ).rejects.toMatchObject({ code: "planning.item_not_found" });
    await expect(
      test.useCase.replace({
        ...base,
        idempotencyKey: "locked-target",
        expectedPlanId: test.current().id,
        expectedHeadVersion: 3,
        targetItemId: test.current().items.find((item) => item.locked)!.id,
      }),
    ).rejects.toMatchObject({ code: "planning.item_locked" });
  });
});
