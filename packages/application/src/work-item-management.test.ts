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
import { ListWorkItemChildren } from "./list-work-item-children.js";
import { ListWorkItems } from "./list-work-items.js";
import type { AuditEventRecord, TransactionContext, UnitOfWork } from "./ports.js";
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
    const invalidatedTargets: string[] = [];
    const auditEvents: AuditEventRecord[] = [];
    const context = {
      workspaces: {
        findById: async () => (options.workspaceExists === false ? null : workspace),
        list: async () => (options.workspaceExists === false ? [] : [workspace]),
        insert: async () => undefined,
      },
      workItems: {
        findById: async (_workspace, id) => items.find((item) => item.id === id) ?? null,
        list: async (_workspace, status, priority, limit, offset, parentWorkItemId) =>
          items
            .filter(
              (item) =>
                item.workspaceId === _workspace &&
                (status === undefined || item.status === status) &&
                (priority === undefined || item.priority === priority) &&
                (parentWorkItemId === undefined || item.parentWorkItemId === parentWorkItemId),
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
      notifications: {
        lockWorkspace: async () => undefined,
        deleteIntentsForTarget: async (_workspace, targetType, targetId) => {
          invalidatedTargets.push(`${targetType}:${targetId}`);
          return 0;
        },
      } as TransactionContext["notifications"],
      scheduleBlocks: {} as TransactionContext["scheduleBlocks"],
      workItemDependencies: {
        lockWorkspace: async () => undefined,
        loadPlanningGraph: async () => ({ workItems: [], dependencies: [] }),
      } as TransactionContext["workItemDependencies"],
      auditEvents: {
        append: async (event) => {
          auditEvents.push(event);
        },
      },
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
      listChildren: new ListWorkItemChildren(unitOfWork),
      update: new UpdateWorkItem(unitOfWork, clock),
      items,
      saves: () => saves,
      invalidatedTargets,
      auditEvents,
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
    expect(test.invalidatedTargets).toEqual([`work_item:${item.id}`]);
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

  it("creates and lists direct subtasks with a tenant-scoped parent audit", async () => {
    const test = harness();
    const parent = await test.create.execute({ workspaceId: workspace.id, title: "Release" });
    const child = await test.create.execute({
      workspaceId: workspace.id,
      parentWorkItemId: parent.id,
      title: "Write notes",
    });
    const grandchild = await test.create.execute({
      workspaceId: workspace.id,
      parentWorkItemId: child.id,
      title: "Proofread notes",
    });

    await expect(
      test.listChildren.execute({
        workspaceId: workspace.id,
        parentWorkItemId: parent.id,
      }),
    ).resolves.toMatchObject({ items: [child], limit: 100, offset: 0 });
    expect(grandchild.parentWorkItemId).toBe(child.id);
    expect(test.auditEvents).toMatchObject([
      {
        action: "work_item_hierarchy.parent_assigned",
        entityId: child.id,
        data: { parentWorkItemId: parent.id },
      },
      {
        action: "work_item_hierarchy.parent_assigned",
        entityId: grandchild.id,
        data: { parentWorkItemId: child.id },
      },
    ]);
  });

  it("reparents and detaches a subtask without changing either parent's version", async () => {
    const test = harness();
    const firstParent = await test.create.execute({
      workspaceId: workspace.id,
      title: "First parent",
    });
    const nextParent = await test.create.execute({
      workspaceId: workspace.id,
      title: "Next parent",
    });
    const child = await test.create.execute({
      workspaceId: workspace.id,
      parentWorkItemId: firstParent.id,
      title: "Child",
    });
    const reparented = await test.update.execute({
      workspaceId: workspace.id,
      workItemId: child.id,
      expectedVersion: child.version,
      parentWorkItemId: nextParent.id,
    });
    const detached = await test.update.execute({
      workspaceId: workspace.id,
      workItemId: child.id,
      expectedVersion: reparented.version,
      parentWorkItemId: null,
    });

    expect(reparented).toMatchObject({ parentWorkItemId: nextParent.id, version: 2 });
    expect(detached).toMatchObject({ parentWorkItemId: null, version: 3 });
    expect(firstParent.version).toBe(1);
    expect(nextParent.version).toBe(1);
    expect(test.auditEvents.slice(-2).map((event) => event.action)).toEqual([
      "work_item_hierarchy.parent_changed",
      "work_item_hierarchy.parent_removed",
    ]);
  });

  it("rejects missing parents, self-parenting, and descendant cycles", async () => {
    const test = harness();
    await expect(
      test.create.execute({
        workspaceId: workspace.id,
        parentWorkItemId: workItemId("missing-parent"),
        title: "Orphan",
      }),
    ).rejects.toMatchObject({ code: "work_item.not_found" });

    const root = await test.create.execute({ workspaceId: workspace.id, title: "Root" });
    const child = await test.create.execute({
      workspaceId: workspace.id,
      parentWorkItemId: root.id,
      title: "Child",
    });
    const grandchild = await test.create.execute({
      workspaceId: workspace.id,
      parentWorkItemId: child.id,
      title: "Grandchild",
    });

    await expect(
      test.update.execute({
        workspaceId: workspace.id,
        workItemId: root.id,
        expectedVersion: root.version,
        parentWorkItemId: grandchild.id,
      }),
    ).rejects.toMatchObject({ code: "work_item_hierarchy.cycle_conflict" });
    await expect(
      test.update.execute({
        workspaceId: workspace.id,
        workItemId: child.id,
        expectedVersion: child.version,
        parentWorkItemId: workItemId(child.id.toUpperCase()),
      }),
    ).rejects.toMatchObject({ code: "work_item_hierarchy.self_reference_invalid" });
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
