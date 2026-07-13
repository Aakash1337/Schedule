import { describe, expect, it } from "vitest";

import type { DomainError } from "@schedule/domain";
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
  routineId,
  workspaceId,
  type DailyPlan,
  type Routine,
  type WorkItem,
} from "@schedule/domain";

import { GenerateDailyPlan } from "./generate-daily-plan.js";
import { GetCurrentDailyPlan } from "./get-current-daily-plan.js";
import type { TransactionContext, UnitOfWork } from "./ports.js";
import { SetPlanItemLock } from "./set-plan-item-lock.js";

describe("GenerateDailyPlan", () => {
  const workspace = workspaceId("application-planner-workspace");
  const routine = createRoutine({
    id: routineId("application-planner-routine"),
    workspaceId: workspace,
    title: "Review notes",
    tags: createStructuredTags({ priority: "high" }),
    duration: createDurationRange({ expectedMinutes: 30 }),
    cadence: createCadencePolicy({ period: "day", targetCompletions: 1 }),
    now: new Date("2026-07-01T00:00:00.000Z"),
  });
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
    targetMinutes: 30,
    targetTaskCount: 1,
    seed: "application-plan",
  });

  function harness(
    existing?: DailyPlan,
    routineCandidates: readonly Routine[] = [routine],
    workItemCandidates: readonly WorkItem[] = [],
    workspaceExists = true,
  ) {
    let stored = existing;
    const context = {
      workspaces: {
        findById: async () =>
          workspaceExists
            ? createWorkspace({ id: workspace, name: "Test", now: new Date(0) })
            : null,
        list: async () => [],
        insert: async () => undefined,
        save: async () => undefined,
      },
      routines: {
        findById: async () => routine,
        list: async () => [routine],
        listPlanningCandidates: async () => routineCandidates,
        insert: async () => undefined,
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
        findById: async () => stored ?? null,
        findByRevision: async (_workspaceId, _date, requestRevision) =>
          stored?.requestRevision === requestRevision ? stored : null,
        insertForRevision: async (plan: DailyPlan) => {
          stored ??= plan;
          return stored;
        },
        findCurrent: async () => (stored === undefined ? null : { plan: stored, headVersion: 1 }),
        setItemLock: async (input) => ({
          planId: input.expectedPlanId,
          itemId: input.itemId,
          locked: input.locked,
          headVersion: input.expectedHeadVersion + 1,
        }),
        recordItemActivity: async () => {
          throw new Error("not used");
        },
        lockDay: async () => undefined,
        findMutation: async () => null,
        insertMutation: async () => undefined,
      },
      workItems: {
        listPlanningCandidates: async () => workItemCandidates,
      } as TransactionContext["workItems"],
      scheduleBlocks: {} as TransactionContext["scheduleBlocks"],
      auditEvents: {} as TransactionContext["auditEvents"],
    } satisfies TransactionContext;
    const unitOfWork: UnitOfWork = {
      run: async (operation) => operation(context),
    };
    return {
      useCase: new GenerateDailyPlan(unitOfWork, {
        now: () => new Date("2026-07-15T07:00:00.000Z"),
      }),
      getCurrent: new GetCurrentDailyPlan(unitOfWork),
      setLock: new SetPlanItemLock(unitOfWork, {
        now: () => new Date("2026-07-15T07:05:00.000Z"),
      }),
      getStored: () => stored,
    };
  }

  it("generates and atomically persists a replayable daily plan", async () => {
    const { useCase, getStored } = harness();
    const plan = await useCase.execute({ request });

    expect(plan.items).toHaveLength(1);
    expect(plan.inputHash).toHaveLength(64);
    expect(getStored()).toBe(plan);
  });

  it("rejects reuse of a revision for a different input snapshot", async () => {
    const first = await harness().useCase.execute({ request });
    const conflicting = { ...first, inputHash: "0".repeat(64) };
    const { useCase } = harness(conflicting);

    await expect(useCase.execute({ request })).rejects.toMatchObject<Partial<DomainError>>({
      code: "planning.revision_conflict",
    });
  });

  it("rejects a missing workspace and generic creation after a plan already exists", async () => {
    await expect(
      harness(undefined, [routine], [], false).useCase.execute({ request }),
    ).rejects.toMatchObject<Partial<DomainError>>({ code: "workspace.not_found" });

    const existing = await harness().useCase.execute({ request });
    await expect(
      harness(existing).useCase.execute({ request: { ...request, requestRevision: 2 } }),
    ).rejects.toMatchObject<Partial<DomainError>>({
      code: "planning.revision_creation_conflict",
    });
  });

  it("returns the same persisted plan for an exact deterministic retry", async () => {
    const first = await harness().useCase.execute({ request });
    const { useCase } = harness(first);

    await expect(useCase.execute({ request })).resolves.toBe(first);
  });

  it("rejects a combined routine and work-item candidate pool above 500", async () => {
    const routineCandidates = Array.from({ length: 251 }, () => routine);
    const workItemCandidates = Array.from({ length: 250 }, (_, index) =>
      createWorkItem({
        workspaceId: workspace,
        title: `Plannable work ${index + 1}`,
        planningDurationMinutes: 15,
      }),
    );

    await expect(
      harness(undefined, routineCandidates, workItemCandidates).useCase.execute({ request }),
    ).rejects.toMatchObject<Partial<DomainError>>({ code: "planning.candidate_pool_too_large" });
  });

  it("can exactly retry a later generic revision that was already persisted", async () => {
    const laterRequest = {
      ...request,
      requestRevision: 2,
      seed: "persisted-generic-revision",
    };
    const laterPlan = generateDailyPlan({
      id: dailyPlanId("persisted-generic-plan"),
      request: laterRequest,
      routines: [routine],
      events: [],
      generatedAt: new Date("2026-07-15T07:00:00.000Z"),
    });
    const { useCase } = harness(laterPlan);

    await expect(useCase.execute({ request: laterRequest })).resolves.toBe(laterPlan);
  });

  it("requires mutation endpoints to allocate every revision after the initial plan", async () => {
    const first = await harness().useCase.execute({ request });
    const { useCase } = harness(first);

    await expect(
      useCase.execute({ request: { ...request, requestRevision: 2, seed: "generic-revision-2" } }),
    ).rejects.toMatchObject<Partial<DomainError>>({
      code: "planning.revision_creation_conflict",
    });
  });

  it("requires an initial generic plan to start at revision 1", async () => {
    const { useCase } = harness();

    await expect(
      useCase.execute({ request: { ...request, requestRevision: 2 } }),
    ).rejects.toMatchObject<Partial<DomainError>>({
      code: "planning.revision_creation_conflict",
    });
  });

  it("retrieves current plan state and applies an optimistic item lock", async () => {
    const test = harness();
    const plan = await test.useCase.execute({ request });
    const current = await test.getCurrent.execute({ workspaceId: workspace, date: request.date });
    const item = plan.items[0]!;
    const result = await test.setLock.execute({
      workspaceId: workspace,
      date: request.date,
      expectedPlanId: plan.id,
      itemId: item.id,
      expectedHeadVersion: current.headVersion,
      locked: true,
      idempotencyKey: "lock-item",
    });

    expect(current.plan).toBe(plan);
    expect(result).toEqual({ planId: plan.id, itemId: item.id, locked: true, headVersion: 2 });
  });
});
