import { describe, expect, it } from "vitest";

import type { TransactionContext, UnitOfWork, Workspace } from "@schedule/application";
import { routineId, scheduleBlockId, workItemId, workspaceId } from "@schedule/domain";

import { createProductServices } from "./product-services.js";

describe("createProductServices", () => {
  it("exposes the complete product handler surface and delegates workspace creation", async () => {
    const inserted: Workspace[] = [];
    const context = {
      workspaces: {
        findById: async () => null,
        list: async () => [],
        insert: async (workspace: Workspace) => {
          inserted.push(workspace);
        },
      },
    } as TransactionContext;
    const unitOfWork: UnitOfWork = {
      run: async (operation) => operation(context),
    };
    const services = createProductServices(unitOfWork, {
      now: () => new Date("2026-07-15T12:00:00.000Z"),
    });

    expect(Object.keys(services).sort()).toEqual([
      "createRoutine",
      "createScheduleBlock",
      "createWorkItem",
      "createWorkspace",
      "deleteScheduleBlock",
      "generateDailyPlan",
      "getCurrentDailyPlan",
      "getDailyPlan",
      "getRoutine",
      "getScheduleBlock",
      "getWorkItem",
      "getWorkspace",
      "listRoutineActivity",
      "listRoutines",
      "listScheduleBlocks",
      "listWorkItems",
      "listWorkspaces",
      "recordActivityEvent",
      "recordPlanItemActivity",
      "regenerateDailyPlan",
      "replacePlanItem",
      "setPlanItemLock",
      "updateRoutine",
      "updateScheduleBlock",
      "updateWorkItem",
    ]);

    const created = await services.createWorkspace({ name: "  Local workspace  " });

    expect(created).toMatchObject({ name: "Local workspace" });
    expect(created.createdAt).toEqual(new Date("2026-07-15T12:00:00.000Z"));
    expect(inserted).toEqual([created]);

    const missingWorkspace = workspaceId("missing-workspace");
    await expect(services.listWorkspaces({ limit: 10, offset: 0 })).resolves.toMatchObject({
      items: [],
    });
    await Promise.all([
      expect(services.getWorkspace({ workspaceId: missingWorkspace })).rejects.toMatchObject({
        code: "workspace.not_found",
      }),
      expect(
        services.getRoutine({
          workspaceId: missingWorkspace,
          routineId: routineId("missing-routine"),
        }),
      ).rejects.toMatchObject({ code: "workspace.not_found" }),
      expect(
        services.listRoutines({ workspaceId: missingWorkspace, limit: 10, offset: 0 }),
      ).rejects.toMatchObject({
        code: "workspace.not_found",
      }),
      expect(
        services.getWorkItem({
          workspaceId: missingWorkspace,
          workItemId: workItemId("missing-work"),
        }),
      ).rejects.toMatchObject({ code: "workspace.not_found" }),
      expect(
        services.listWorkItems({ workspaceId: missingWorkspace, limit: 10, offset: 0 }),
      ).rejects.toMatchObject({ code: "workspace.not_found" }),
      expect(
        services.getScheduleBlock({
          workspaceId: missingWorkspace,
          scheduleBlockId: scheduleBlockId("missing-block"),
        }),
      ).rejects.toMatchObject({ code: "workspace.not_found" }),
      expect(
        services.listScheduleBlocks({
          workspaceId: missingWorkspace,
          from: new Date("2026-07-15T00:00:00.000Z"),
          to: new Date("2026-07-16T00:00:00.000Z"),
          limit: 10,
          offset: 0,
        }),
      ).rejects.toMatchObject({ code: "workspace.not_found" }),
    ]);
  });
});
