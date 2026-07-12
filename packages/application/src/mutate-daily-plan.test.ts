import { describe, expect, it } from "vitest";

import {
  createCadencePolicy,
  createDailyPlanningRequest,
  createDurationRange,
  createRoutine,
  createStructuredTags,
  createWorkspace,
  dailyPlanId,
  generateDailyPlan,
  routineId,
  workspaceId,
  type DailyPlan,
  type Routine,
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

  function harness() {
    const generated = generateDailyPlan({
      id: dailyPlanId("mutation-source"),
      request,
      routines: routines.slice(0, 2),
      events: [],
      generatedAt: new Date("2026-07-15T07:00:00.000Z"),
    });
    let current: DailyPlan = {
      ...generated,
      items: generated.items.map((item, index) => ({ ...item, locked: index === 0 })),
    };
    let headVersion = 2;
    const mutations: PlanMutationRecord[] = [];
    const context = {
      workspaces: {
        findById: async () => createWorkspace({ id: workspace, name: "Test" }),
        insert: async () => undefined,
      },
      routines: {
        findById: async () => null,
        list: async () => routines,
        listPlanningCandidates: async () => routines,
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
        findById: async (_workspace, id) => (id === current.id ? current : null),
        findByRevision: async () => null,
        insertForRevision: async (plan: DailyPlan) => {
          current = plan;
          headVersion += 1;
          return plan;
        },
        findCurrent: async () => ({ plan: current, headVersion }),
        setItemLock: async () => {
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
      workItems: {} as TransactionContext["workItems"],
      scheduleBlocks: {} as TransactionContext["scheduleBlocks"],
    } satisfies TransactionContext;
    const unitOfWork: UnitOfWork = { run: async (operation) => operation(context) };
    return {
      useCase: new MutateDailyPlan(unitOfWork, {
        now: () => new Date("2026-07-15T07:30:00.000Z"),
      }),
      source: current,
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
});
