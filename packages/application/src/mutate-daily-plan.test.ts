import { describe, expect, it } from "vitest";

import {
  createCadencePolicy,
  createDailyPlanningRequest,
  createDurationRange,
  createRoutine,
  createStructuredTags,
  createWorkItem,
  createWorkspace,
  dailyPlanId,
  generateDailyPlan,
  planItemId,
  routineId,
  workspaceId,
  type DailyPlan,
  type Routine,
  type WorkItem,
} from "@schedule/domain";

import { MutateDailyPlan } from "./mutate-daily-plan.js";
import type { PlanMutationRecord, TransactionContext, UnitOfWork } from "./ports.js";

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
    const mutations: PlanMutationRecord[] = [];
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
        findById: async () => null,
        listForPlanning: async () => [],
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
        setItemLock: async () => {
          throw new Error("not used");
        },
        recordItemActivity: async () => {
          throw new Error("not used");
        },
        lockDay: async () => undefined,
        findMutation: async (_workspace, date, key) =>
          mutations.find((mutation) => mutation.date === date && mutation.idempotencyKey === key) ??
          null,
        insertMutation: async (mutation: PlanMutationRecord) => {
          mutations.push(mutation);
        },
      },
      workItems: {
        listPlanningCandidates: async () => options.workItemCandidates ?? [],
      } as TransactionContext["workItems"],
      scheduleBlocks: {} as TransactionContext["scheduleBlocks"],
      auditEvents: {} as TransactionContext["auditEvents"],
    } satisfies TransactionContext;
    const unitOfWork: UnitOfWork = { run: async (operation) => operation(context) };
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
