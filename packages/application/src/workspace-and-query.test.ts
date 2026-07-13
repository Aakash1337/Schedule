import { describe, expect, it } from "vitest";

import {
  createCadencePolicy,
  createDailyPlanningRequest,
  createDurationRange,
  createRoutine,
  createStructuredTags,
  createWorkspace,
  generateDailyPlan,
  routineId,
  workspaceId,
  type DailyPlan,
  type Routine,
  type Workspace,
} from "@schedule/domain";

import { CreateWorkspace } from "./create-workspace.js";
import { GetDailyPlan } from "./get-daily-plan.js";
import { GetWorkspace } from "./get-workspace.js";
import { ListRoutines } from "./list-routines.js";
import { ListWorkspaces } from "./list-workspaces.js";
import type { TransactionContext, UnitOfWork } from "./ports.js";

const primaryWorkspace = createWorkspace({
  id: workspaceId("workspace-query-primary"),
  name: "Primary workspace",
  now: new Date("2026-07-01T00:00:00.000Z"),
});
const secondaryWorkspace = createWorkspace({
  id: workspaceId("workspace-query-secondary"),
  name: "Secondary workspace",
  now: new Date("2026-07-01T00:00:00.000Z"),
});
const routine = createRoutine({
  id: routineId("workspace-query-routine"),
  workspaceId: primaryWorkspace.id,
  title: "Read notes",
  tags: createStructuredTags(),
  duration: createDurationRange({ expectedMinutes: 30 }),
  cadence: createCadencePolicy({ period: "week" }),
  now: new Date("2026-07-01T00:00:00.000Z"),
});
const dailyPlan = generateDailyPlan({
  request: createDailyPlanningRequest({
    workspaceId: primaryWorkspace.id,
    date: "2026-07-15",
    timeZone: "UTC",
    availableWindows: [
      {
        startsAt: new Date("2026-07-15T09:00:00.000Z"),
        endsAt: new Date("2026-07-15T10:00:00.000Z"),
      },
    ],
    targetMinutes: 30,
    targetTaskCount: 1,
    seed: "workspace-query-plan",
  }),
  routines: [routine],
  events: [],
  generatedAt: new Date("2026-07-15T08:00:00.000Z"),
});

function harness(
  options: { readonly workspaceExists?: boolean; readonly plan?: DailyPlan | null } = {},
) {
  const workspaces: Workspace[] = [primaryWorkspace, secondaryWorkspace];
  const inserted: Workspace[] = [];
  let runCount = 0;
  let workspacePageArguments: { readonly limit: number; readonly offset: number } | undefined;
  let routinePageArguments:
    | {
        readonly workspaceId: typeof primaryWorkspace.id;
        readonly status: "active" | undefined;
        readonly limit: number;
        readonly offset: number;
      }
    | undefined;
  let planArguments:
    | {
        readonly workspaceId: typeof primaryWorkspace.id;
        readonly date: "2026-07-15";
        readonly requestRevision: number;
      }
    | undefined;

  const context = {
    workspaces: {
      findById: async (id: typeof primaryWorkspace.id) =>
        options.workspaceExists === false
          ? null
          : (workspaces.find((workspace) => workspace.id === id) ?? null),
      list: async (limit: number, offset: number) => {
        workspacePageArguments = { limit, offset };
        return workspaces.slice(offset, offset + limit);
      },
      insert: async (workspace: Workspace) => {
        inserted.push(workspace);
      },
    },
    routines: {
      findById: async () => null,
      list: async (
        workspaceId: typeof primaryWorkspace.id,
        status: "active" | undefined,
        limit: number,
        offset: number,
      ) => {
        routinePageArguments = { workspaceId, status, limit, offset };
        return workspaceId === primaryWorkspace.id ? [routine] : [];
      },
      listPlanningCandidates: async () => [],
      insert: async (_routine: Routine) => undefined,
      save: async () => undefined,
    },
    dailyPlans: {
      findById: async () => null,
      findByRevision: async (
        workspaceId: typeof primaryWorkspace.id,
        date: "2026-07-15",
        requestRevision: number,
      ) => {
        planArguments = { workspaceId, date, requestRevision };
        return options.plan === undefined ? dailyPlan : options.plan;
      },
      insertForRevision: async (plan: DailyPlan) => plan,
      findCurrent: async () => null,
      setItemLock: async () => {
        throw new Error("not used");
      },
      recordItemActivity: async () => {
        throw new Error("not used");
      },
      lockDay: async () => undefined,
      findMutation: async () => null,
      insertMutation: async () => undefined,
    },
    activityEvents: {
      lockRoutineActivity: async () => undefined,
      findById: async () => null,
      listForPlanning: async () => [],
      listDurationEvidence: async () => [],
      append: async (event: never) => event,
      listHistory: async () => ({ items: [], nextCursor: null }),
    },
    workItems: {} as TransactionContext["workItems"],
    scheduleBlocks: {} as TransactionContext["scheduleBlocks"],
    auditEvents: {} as TransactionContext["auditEvents"],
  } satisfies TransactionContext;
  const unitOfWork: UnitOfWork = {
    run: async (operation) => {
      runCount += 1;
      return operation(context);
    },
  };

  return {
    createWorkspace: new CreateWorkspace(unitOfWork, {
      now: () => new Date("2026-07-12T12:00:00.000Z"),
    }),
    getWorkspace: new GetWorkspace(unitOfWork),
    listWorkspaces: new ListWorkspaces(unitOfWork),
    listRoutines: new ListRoutines(unitOfWork),
    getDailyPlan: new GetDailyPlan(unitOfWork),
    inserted: () => inserted,
    runCount: () => runCount,
    workspacePageArguments: () => workspacePageArguments,
    routinePageArguments: () => routinePageArguments,
    planArguments: () => planArguments,
  };
}

describe("workspace and query use cases", () => {
  it("creates a normalized workspace using the application clock", async () => {
    const test = harness();
    const result = await test.createWorkspace.execute({ name: "  New workspace  " });

    expect(result).toMatchObject({
      name: "New workspace",
      createdAt: new Date("2026-07-12T12:00:00.000Z"),
    });
    expect(test.inserted()).toEqual([result]);
  });

  it("gets an existing workspace and reports a missing one", async () => {
    const test = harness();
    await expect(test.getWorkspace.execute({ workspaceId: primaryWorkspace.id })).resolves.toBe(
      primaryWorkspace,
    );
    await expect(
      harness({ workspaceExists: false }).getWorkspace.execute({
        workspaceId: primaryWorkspace.id,
      }),
    ).rejects.toMatchObject({ code: "workspace.not_found" });
  });

  it("lists workspaces with forwarded pagination and defaults", async () => {
    const test = harness();
    await expect(test.listWorkspaces.execute()).resolves.toEqual({
      items: [primaryWorkspace, secondaryWorkspace],
      limit: 20,
      offset: 0,
    });
    expect(test.workspacePageArguments()).toEqual({ limit: 20, offset: 0 });
    await test.listWorkspaces.execute({ limit: 1, offset: 1 });
    expect(test.workspacePageArguments()).toEqual({ limit: 1, offset: 1 });
  });

  it("rejects invalid workspace pagination before opening a transaction", () => {
    for (const query of [{ limit: 0 }, { limit: 21 }, { offset: -1 }, { offset: 1_000_001 }]) {
      const test = harness();
      let thrown: unknown;
      try {
        test.listWorkspaces.execute(query);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toMatchObject({
        code: "limit" in query ? "workspace.limit_invalid" : "workspace.offset_invalid",
      });
      expect(test.runCount()).toBe(0);
    }
  });

  it("scopes routine listing to an existing workspace and forwards its page", async () => {
    const test = harness();
    await expect(
      test.listRoutines.execute({
        workspaceId: primaryWorkspace.id,
        status: "active",
        limit: 25,
        offset: 5,
      }),
    ).resolves.toEqual([routine]);
    expect(test.routinePageArguments()).toEqual({
      workspaceId: primaryWorkspace.id,
      status: "active",
      limit: 25,
      offset: 5,
    });
    await expect(
      harness({ workspaceExists: false }).listRoutines.execute({
        workspaceId: primaryWorkspace.id,
      }),
    ).rejects.toMatchObject({ code: "workspace.not_found" });
  });

  it("rejects invalid routine pagination without calling the routine repository", async () => {
    const test = harness();
    await expect(
      test.listRoutines.execute({ workspaceId: primaryWorkspace.id, limit: 201 }),
    ).rejects.toMatchObject({ code: "routine.list_limit_invalid" });
    await expect(
      test.listRoutines.execute({ workspaceId: primaryWorkspace.id, offset: -1 }),
    ).rejects.toMatchObject({ code: "routine.list_offset_invalid" });
    expect(test.routinePageArguments()).toBeUndefined();
  });

  it("retrieves the exact daily-plan revision and returns null when it is absent", async () => {
    const test = harness();
    await expect(
      test.getDailyPlan.execute({
        workspaceId: primaryWorkspace.id,
        date: "2026-07-15",
        requestRevision: 3,
      }),
    ).resolves.toBe(dailyPlan);
    expect(test.planArguments()).toEqual({
      workspaceId: primaryWorkspace.id,
      date: "2026-07-15",
      requestRevision: 3,
    });
    await expect(
      harness({ plan: null }).getDailyPlan.execute({
        workspaceId: primaryWorkspace.id,
        date: "2026-07-15",
        requestRevision: 4,
      }),
    ).resolves.toBeNull();
  });
});
