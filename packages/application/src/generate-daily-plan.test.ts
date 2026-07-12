import { describe, expect, it } from "vitest";

import type { DomainError } from "@schedule/domain";
import {
  createCadencePolicy,
  createDailyPlanningRequest,
  createDurationRange,
  createRoutine,
  createStructuredTags,
  createWorkspace,
  routineId,
  workspaceId,
  type DailyPlan,
} from "@schedule/domain";

import { GenerateDailyPlan } from "./generate-daily-plan.js";
import type { TransactionContext, UnitOfWork } from "./ports.js";

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

  function harness(existing?: DailyPlan) {
    let stored = existing;
    const context = {
      workspaces: {
        findById: async () => createWorkspace({ id: workspace, name: "Test", now: new Date(0) }),
        insert: async () => undefined,
        save: async () => undefined,
      },
      routines: {
        findById: async () => routine,
        list: async () => [routine],
        listPlanningCandidates: async () => [routine],
        insert: async () => undefined,
        save: async () => undefined,
      },
      activityEvents: {
        findById: async () => null,
        listForPlanning: async () => [],
        append: async (event) => event,
        listHistory: async () => ({ items: [], nextCursor: null }),
      },
      dailyPlans: {
        findById: async () => stored ?? null,
        findByRevision: async () => stored ?? null,
        insertForRevision: async (plan: DailyPlan) => {
          stored ??= plan;
          return stored;
        },
      },
      workItems: {} as TransactionContext["workItems"],
      scheduleBlocks: {} as TransactionContext["scheduleBlocks"],
    } satisfies TransactionContext;
    const unitOfWork: UnitOfWork = {
      run: async (operation) => operation(context),
    };
    return {
      useCase: new GenerateDailyPlan(unitOfWork, {
        now: () => new Date("2026-07-15T07:00:00.000Z"),
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
});
