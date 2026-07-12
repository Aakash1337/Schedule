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
  type Routine,
} from "@schedule/domain";

import { GetRoutine } from "./get-routine.js";
import { ListRoutineActivity } from "./list-routine-activity.js";
import type { ActivityHistoryCursor, TransactionContext, UnitOfWork } from "./ports.js";
import { UpdateRoutine } from "./update-routine.js";

describe("routine management", () => {
  const workspace = createWorkspace({
    id: workspaceId("routine-management-workspace"),
    name: "Test workspace",
    now: new Date("2026-07-01T00:00:00.000Z"),
  });
  const original = createRoutine({
    id: routineId("routine-management-routine"),
    workspaceId: workspace.id,
    title: "Review notes",
    tags: createStructuredTags({ priority: "medium" }),
    duration: createDurationRange({ expectedMinutes: 30 }),
    cadence: createCadencePolicy({ period: "week", targetCompletions: 3 }),
    now: new Date("2026-07-01T00:00:00.000Z"),
  });
  const event = recordActivityEvent({
    id: activityEventId("routine-management-event"),
    workspaceId: workspace.id,
    routineId: original.id,
    type: "completed",
    occurredAt: new Date("2026-07-10T10:00:00.000Z"),
    timeZone: "UTC",
    idempotencyKey: "routine-management-event",
    recordedAt: new Date("2026-07-10T10:01:00.000Z"),
  });

  function harness(options: { workspaceExists?: boolean; routineExists?: boolean } = {}) {
    let stored: Routine | null = options.routineExists === false ? null : original;
    let saveCount = 0;
    let historyArguments: { limit: number; cursor: ActivityHistoryCursor | undefined } | undefined;
    const context = {
      workspaces: {
        findById: async () => (options.workspaceExists === false ? null : workspace),
        insert: async () => undefined,
      },
      routines: {
        findById: async () => stored,
        list: async () => (stored === null ? [] : [stored]),
        listPlanningCandidates: async () => (stored === null ? [] : [stored]),
        insert: async (routine: Routine) => {
          stored = routine;
        },
        save: async (routine: Routine) => {
          saveCount += 1;
          stored = routine;
        },
      },
      activityEvents: {
        findById: async () => event,
        listForPlanning: async () => [event],
        append: async (candidate: ActivityEvent) => candidate,
        listHistory: async (
          _workspaceId: typeof workspace.id,
          _routineId: typeof original.id,
          limit: number,
          cursor?: ActivityHistoryCursor,
        ) => {
          historyArguments = { limit, cursor };
          return { items: [event], nextCursor: null };
        },
      },
      workItems: {} as TransactionContext["workItems"],
      scheduleBlocks: {} as TransactionContext["scheduleBlocks"],
      dailyPlans: {} as TransactionContext["dailyPlans"],
    } satisfies TransactionContext;
    const unitOfWork: UnitOfWork = { run: async (operation) => operation(context) };
    const clock = { now: () => new Date("2026-07-12T12:00:00.000Z") };
    return {
      getRoutine: new GetRoutine(unitOfWork),
      updateRoutine: new UpdateRoutine(unitOfWork, clock),
      listActivity: new ListRoutineActivity(unitOfWork),
      stored: () => stored,
      saveCount: () => saveCount,
      historyArguments: () => historyArguments,
    };
  }

  it("gets and atomically updates a scoped routine", async () => {
    const test = harness();
    expect(
      await test.getRoutine.execute({ workspaceId: workspace.id, routineId: original.id }),
    ).toBe(original);

    const updated = await test.updateRoutine.execute({
      workspaceId: workspace.id,
      routineId: original.id,
      expectedVersion: 1,
      title: "Review the notes",
      status: "paused",
    });

    expect(updated).toMatchObject({ title: "Review the notes", status: "paused", version: 2 });
    expect(updated.updatedAt).toEqual(new Date("2026-07-12T12:00:00.000Z"));
    expect(test.stored()).toBe(updated);
    expect(test.saveCount()).toBe(1);
  });

  it("preserves the version and avoids a write for a semantic no-op", async () => {
    const test = harness();
    const result = await test.updateRoutine.execute({
      workspaceId: workspace.id,
      routineId: original.id,
      expectedVersion: 1,
      title: " Review notes ",
    });

    expect(result).toBe(original);
    expect(result.version).toBe(1);
    expect(test.saveCount()).toBe(0);
  });

  it("rejects stale versions before saving", async () => {
    const test = harness();
    await expect(
      test.updateRoutine.execute({
        workspaceId: workspace.id,
        routineId: original.id,
        expectedVersion: 2,
        status: "archived",
      }),
    ).rejects.toMatchObject({ code: "routine.version_conflict" });
    expect(test.saveCount()).toBe(0);
  });

  it("passes a bounded stable cursor to routine history storage", async () => {
    const test = harness();
    const cursor = { watermark: 42, before: 31 };
    const page = await test.listActivity.execute({
      workspaceId: workspace.id,
      routineId: original.id,
      limit: 25,
      cursor,
    });

    expect(page.items).toEqual([event]);
    expect(test.historyArguments()).toEqual({ limit: 25, cursor });
  });

  it("reports missing workspaces and routines consistently", async () => {
    const noWorkspace = harness({ workspaceExists: false });
    await expect(
      noWorkspace.getRoutine.execute({ workspaceId: workspace.id, routineId: original.id }),
    ).rejects.toMatchObject({ code: "workspace.not_found" });
    await expect(
      noWorkspace.listActivity.execute({ workspaceId: workspace.id, routineId: original.id }),
    ).rejects.toMatchObject({ code: "workspace.not_found" });

    const noRoutine = harness({ routineExists: false });
    await expect(
      noRoutine.listActivity.execute({ workspaceId: workspace.id, routineId: original.id }),
    ).rejects.toMatchObject({ code: "routine.not_found" });
  });
});
