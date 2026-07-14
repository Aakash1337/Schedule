import { describe, expect, it } from "vitest";

import {
  createWorkspace,
  localDate,
  workItemId,
  workspaceId,
  type WorkItem,
} from "@schedule/domain";

import { CreateWorkItem } from "./create-work-item.js";
import { GetWorkItem } from "./get-work-item.js";
import { ListWorkItems } from "./list-work-items.js";
import type { TransactionContext, UnitOfWork } from "./ports.js";
import { UpdateWorkItem } from "./update-work-item.js";

describe("work item management", () => {
  const workspace = createWorkspace({
    id: workspaceId("work-management-workspace"),
    name: "Test",
    now: new Date("2026-07-01T00:00:00.000Z"),
  });
  const now = new Date("2026-07-15T09:00:00.000Z");

  function harness(options: { workspaceExists?: boolean } = {}) {
    const items: WorkItem[] = [];
    let saves = 0;
    const context = {
      workspaces: {
        findById: async () => (options.workspaceExists === false ? null : workspace),
        list: async () => (options.workspaceExists === false ? [] : [workspace]),
        insert: async () => undefined,
      },
      workItems: {
        findById: async (_workspace, id) => items.find((item) => item.id === id) ?? null,
        list: async (_workspace, status, priority, limit, offset) =>
          items
            .filter(
              (item) =>
                (status === undefined || item.status === status) &&
                (priority === undefined || item.priority === priority),
            )
            .slice(offset, offset + limit),
        listPlanningCandidates: async (_workspace) =>
          items.filter(
            (item) =>
              item.workspaceId === _workspace &&
              item.planningDurationMinutes !== null &&
              !["done", "cancelled"].includes(item.status),
          ),
        insert: async (item: WorkItem) => {
          items.push(item);
        },
        save: async (item: WorkItem, expectedVersion: number) => {
          const index = items.findIndex(
            (candidate) => candidate.id === item.id && candidate.version === expectedVersion,
          );
          if (index < 0) throw new Error("version conflict");
          items[index] = item;
          saves += 1;
        },
      },
      scheduleBlocks: {} as TransactionContext["scheduleBlocks"],
      workItemDependencies: {
        loadPlanningGraph: async () => ({ workItems: [], dependencies: [] }),
      } as TransactionContext["workItemDependencies"],
      auditEvents: {} as TransactionContext["auditEvents"],
      routines: {} as TransactionContext["routines"],
      activityEvents: {} as TransactionContext["activityEvents"],
      dailyPlans: {} as TransactionContext["dailyPlans"],
    } satisfies TransactionContext;
    const unitOfWork: UnitOfWork = { run: async (operation) => operation(context) };
    const clock = { now: () => new Date(now) };
    return {
      create: new CreateWorkItem(unitOfWork, clock),
      get: new GetWorkItem(unitOfWork),
      list: new ListWorkItems(unitOfWork),
      update: new UpdateWorkItem(unitOfWork, clock),
      items,
      saves: () => saves,
    };
  }

  it("creates, retrieves, and filters backlog items", async () => {
    const test = harness();
    const first = await test.create.execute({
      workspaceId: workspace.id,
      title: "Ship MVP",
      status: "planned",
      priority: "urgent",
    });
    await test.create.execute({ workspaceId: workspace.id, title: "Later" });

    await expect(
      test.get.execute({ workspaceId: workspace.id, workItemId: first.id }),
    ).resolves.toBe(first);
    const page = await test.list.execute({
      workspaceId: workspace.id,
      status: "planned",
      priority: "urgent",
      limit: 10,
    });
    expect(page.items).toEqual([first]);
    expect(page).toMatchObject({ limit: 10, offset: 0 });
  });

  it("updates once and does not save a normalized no-op", async () => {
    const test = harness();
    const item = await test.create.execute({ workspaceId: workspace.id, title: "Ship MVP" });
    const updated = await test.update.execute({
      workspaceId: workspace.id,
      workItemId: item.id,
      expectedVersion: 1,
      status: "in_progress",
      priority: "high",
    });
    const noOp = await test.update.execute({
      workspaceId: workspace.id,
      workItemId: item.id,
      expectedVersion: 2,
      title: " Ship MVP ",
    });

    expect(updated).toMatchObject({ status: "in_progress", priority: "high", version: 2 });
    expect(noOp).toBe(updated);
    expect(test.saves()).toBe(1);
  });

  it("persists a planning duration and permits explicitly removing it", async () => {
    const test = harness();
    const item = await test.create.execute({
      workspaceId: workspace.id,
      title: "Prepare release notes",
      planningDurationMinutes: 45,
    });
    const removed = await test.update.execute({
      workspaceId: workspace.id,
      workItemId: item.id,
      expectedVersion: 1,
      planningDurationMinutes: null,
    });

    expect(item.planningDurationMinutes).toBe(45);
    expect(removed).toMatchObject({ planningDurationMinutes: null, version: 2 });
  });

  it("persists a due date and permits explicitly clearing it", async () => {
    const test = harness();
    const item = await test.create.execute({
      workspaceId: workspace.id,
      title: "Submit quarterly return",
      dueOn: localDate("2026-07-31"),
    });
    const cleared = await test.update.execute({
      workspaceId: workspace.id,
      workItemId: item.id,
      expectedVersion: 1,
      dueOn: null,
    });

    expect(item.dueOn).toBe("2026-07-31");
    expect(cleared).toMatchObject({ dueOn: null, version: 2 });
  });

  it("rejects a missing workspace before persistence", async () => {
    const test = harness({ workspaceExists: false });
    await expect(
      test.create.execute({ workspaceId: workspace.id, title: "Orphan" }),
    ).rejects.toMatchObject({ code: "workspace.not_found" });
    expect(test.items).toHaveLength(0);
  });

  it("rejects a work-item update outside an existing workspace", async () => {
    const test = harness({ workspaceExists: false });
    await expect(
      test.update.execute({
        workspaceId: workspace.id,
        workItemId: workItemId("missing-work-item"),
        expectedVersion: 1,
        title: "Not persisted",
      }),
    ).rejects.toMatchObject({ code: "workspace.not_found" });
  });

  it("rejects invalid page bounds without opening a transaction", () => {
    const test = harness();
    expect(() => test.list.execute({ workspaceId: workspace.id, limit: 201 })).toThrow();
  });
});
