import { describe, expect, it } from "vitest";

import {
  createCadencePolicy,
  createDailyPlanningRequest,
  createDurationRange,
  createRoutine,
  createStructuredTags,
  dailyPlanId,
  generateDailyPlan,
  routineId,
  workspaceId,
  type DailyPlan,
  type Routine,
} from "@schedule/domain";

import { DailyPlanAlternatives } from "./daily-plan-alternatives.js";
import type { PlanMutationRecord, TransactionContext, UnitOfWork } from "./ports.js";

describe("DailyPlanAlternatives", () => {
  const workspace = workspaceId("alternative-application-workspace");
  const date = "2026-07-15";

  function routine(name: string, priority: "low" | "medium" | "high" | "critical"): Routine {
    return createRoutine({
      id: routineId(`alternative-${name}`),
      workspaceId: workspace,
      title: name,
      tags: createStructuredTags({ priority }),
      duration: createDurationRange({ expectedMinutes: 30 }),
      cadence: createCadencePolicy({ period: "week", targetCompletions: 3 }),
      now: new Date("2026-07-01T00:00:00.000Z"),
    });
  }

  const routines = [
    routine("locked", "critical"),
    routine("current", "high"),
    routine("candidate-a", "high"),
    routine("candidate-b", "medium"),
    routine("candidate-c", "low"),
  ];
  const sourceRequest = createDailyPlanningRequest({
    workspaceId: workspace,
    date,
    timeZone: "UTC",
    availableWindows: [
      {
        startsAt: new Date("2026-07-15T08:00:00.000Z"),
        endsAt: new Date("2026-07-15T09:00:00.000Z"),
      },
    ],
    targetMinutes: 60,
    maximumMinutes: 60,
    targetTaskCount: 2,
    maximumTaskCount: 2,
    seed: "alternative-source",
  });
  const commandRequest = createDailyPlanningRequest({
    ...sourceRequest,
    seed: "alternative-next",
    requestRevision: 1,
  });

  function harness() {
    const generated = generateDailyPlan({
      id: dailyPlanId("alternative-source-plan"),
      request: sourceRequest,
      routines: routines.slice(0, 2),
      events: [],
      generatedAt: new Date("2026-07-15T07:00:00.000Z"),
    });
    let current: DailyPlan = {
      ...generated,
      items: generated.items.map((item, index) => ({ ...item, locked: index === 0 })),
    };
    let headVersion = 4;
    let candidates = routines;
    let inserts = 0;
    let invalidations = 0;
    const mutations: PlanMutationRecord[] = [];
    const context = {
      routines: {
        listPlanningCandidates: async () => candidates,
      } as TransactionContext["routines"],
      workItemDependencies: {
        loadPlanningGraph: async () => ({ workItems: [], dependencies: [] }),
      } as TransactionContext["workItemDependencies"],
      activityEvents: {
        listForPlanning: async () => [],
      } as TransactionContext["activityEvents"],
      routineSelectionPreferenceFeedback: {
        listForPlanning: async () => [],
      } as TransactionContext["routineSelectionPreferenceFeedback"],
      dailyPlans: {
        lockDay: async () => undefined,
        findCurrent: async () => ({ plan: current, headVersion }),
        listRoutineFeedbackForPlanning: async () => [],
        findMutation: async (_workspace, requestedDate, key) =>
          mutations.find(
            (mutation) => mutation.date === requestedDate && mutation.idempotencyKey === key,
          ) ?? null,
        findById: async (_workspace, id) => (current.id === id ? current : null),
        insertForRevision: async (plan: DailyPlan) => {
          inserts += 1;
          current = plan;
          return plan;
        },
        insertMutation: async (mutation: PlanMutationRecord) => {
          mutations.push(mutation);
          headVersion = mutation.resultHeadVersion;
        },
      } as TransactionContext["dailyPlans"],
      notifications: {
        lockWorkspace: async () => undefined,
        deleteIntentsForTarget: async () => {
          invalidations += 1;
          return 0;
        },
      } as TransactionContext["notifications"],
    } as TransactionContext;
    const unitOfWork: UnitOfWork = {
      run: async (operation) => operation(context),
    };
    return {
      service: new DailyPlanAlternatives(unitOfWork, {
        now: () => new Date("2026-07-15T07:30:00.000Z"),
      }),
      source: current,
      headVersion: () => headVersion,
      inserts: () => inserts,
      invalidations: () => invalidations,
      mutations,
      setCandidates: (next: readonly Routine[]) => {
        candidates = next;
      },
    };
  }

  it("previews bounded deterministic choices without changing persisted state", async () => {
    const test = harness();
    const command = {
      workspaceId: workspace,
      expectedPlanId: test.source.id,
      expectedHeadVersion: 4,
      request: commandRequest,
    };
    const first = await test.service.preview(command);
    const second = await test.service.preview(command);

    expect(first).toEqual(second);
    expect(first.sourcePlanId).toBe(test.source.id);
    expect(first.sourceHeadVersion).toBe(4);
    expect(first.alternatives.length).toBeGreaterThan(0);
    expect(first.alternatives.length).toBeLessThanOrEqual(3);
    expect(test.inserts()).toBe(0);
    expect(test.invalidations()).toBe(0);
    expect(test.mutations).toHaveLength(0);
  });

  it("selects exactly once, preserves a locked anchor, and replays after the head advances", async () => {
    const test = harness();
    const fence = {
      workspaceId: workspace,
      expectedPlanId: test.source.id,
      expectedHeadVersion: 4,
      request: commandRequest,
    };
    const preview = await test.service.preview(fence);
    const candidateKey = preview.alternatives[0]!.candidateKey;
    const command = { ...fence, candidateKey, idempotencyKey: "alternative-selection" };

    const selected = await test.service.select(command);
    const replayed = await test.service.select(command);

    expect(selected).toEqual(replayed);
    expect(selected.headVersion).toBe(5);
    expect(selected.plan.requestRevision).toBe(2);
    expect(selected.plan.items.some((item) => item.locked)).toBe(true);
    expect(selected.plan.items.find((item) => item.locked)?.routineId).toBe(
      test.source.items.find((item) => item.locked)?.routineId,
    );
    expect(test.headVersion()).toBe(5);
    expect(test.inserts()).toBe(1);
    expect(test.invalidations()).toBe(1);
    expect(test.mutations).toMatchObject([
      {
        kind: "alternative_select",
        sourcePlanId: test.source.id,
        resultHeadVersion: 5,
      },
    ]);
  });

  it("rejects a candidate that is no longer offered before writing anything", async () => {
    const test = harness();
    const fence = {
      workspaceId: workspace,
      expectedPlanId: test.source.id,
      expectedHeadVersion: 4,
      request: commandRequest,
    };
    const preview = await test.service.preview(fence);
    const candidateKey = preview.alternatives[0]!.candidateKey;
    test.setCandidates(routines.slice(0, 2));

    await expect(
      test.service.select({
        ...fence,
        candidateKey,
        idempotencyKey: "stale-alternative-selection",
      }),
    ).rejects.toMatchObject({ code: "planning.alternative_stale" });
    expect(test.inserts()).toBe(0);
    expect(test.invalidations()).toBe(0);
    expect(test.mutations).toHaveLength(0);
  });
});
