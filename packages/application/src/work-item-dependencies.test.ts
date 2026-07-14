import { describe, expect, it } from "vitest";

import {
  createWorkItem,
  createWorkItemDependency,
  createWorkspace,
  workItemId,
  workspaceId,
  type WorkItem,
  type WorkItemDependency,
} from "@schedule/domain";

import { AddWorkItemDependency } from "./add-work-item-dependency.js";
import { ListWorkItemDependencies } from "./list-work-item-dependencies.js";
import type {
  AuditEventRecord,
  TransactionContext,
  UnitOfWork,
  UnitOfWorkOptions,
} from "./ports.js";
import { RemoveWorkItemDependency } from "./remove-work-item-dependency.js";

const workspace = createWorkspace({
  id: workspaceId("71000000-0000-4000-8000-000000000001"),
  name: "Dependency tests",
  now: new Date("2026-07-01T00:00:00.000Z"),
});
const prerequisite = createWorkItem({
  id: workItemId("72000000-0000-4000-8000-000000000001"),
  workspaceId: workspace.id,
  title: "Write draft",
  planningDurationMinutes: 30,
  now: new Date("2026-07-01T00:00:00.000Z"),
});
const dependent = createWorkItem({
  id: workItemId("72000000-0000-4000-8000-000000000002"),
  workspaceId: workspace.id,
  title: "Publish draft",
  planningDurationMinutes: 30,
  now: new Date("2026-07-01T00:00:00.000Z"),
});

const command = {
  workspaceId: workspace.id,
  prerequisiteWorkItemId: prerequisite.id,
  dependentWorkItemId: dependent.id,
} as const;

function harness(
  options: {
    workspaceExists?: boolean;
    items?: readonly WorkItem[];
    initialDependencies?: readonly WorkItemDependency[];
    wouldCreateCycle?: boolean;
    deleteResult?: boolean;
  } = {},
) {
  const items = options.items ?? [prerequisite, dependent];
  const dependencies = [...(options.initialDependencies ?? [])];
  const auditEvents: AuditEventRecord[] = [];
  const operationOrder: string[] = [];
  let graphLocked = false;
  let transactionRuns = 0;
  let insertCount = 0;
  let deleteCount = 0;
  let cycleReadCount = 0;
  let clockCount = 0;
  let unitOfWorkOptions: UnitOfWorkOptions | undefined;

  function requireGraphLock(operation: string): void {
    if (!graphLocked) throw new Error(`${operation} ran without the workspace dependency lock`);
    operationOrder.push(operation);
  }

  const context = {
    workspaces: {
      findById: async () => {
        operationOrder.push("workspace");
        return options.workspaceExists === false ? null : workspace;
      },
      list: async () => [],
      insert: async () => undefined,
    },
    workItems: {
      findById: async (receivedWorkspaceId, id) => {
        requireGraphLock(`item:${id}`);
        return (
          items.find((item) => item.workspaceId === receivedWorkspaceId && item.id === id) ?? null
        );
      },
    } as TransactionContext["workItems"],
    workItemDependencies: {
      lockWorkspace: async (receivedWorkspaceId) => {
        expect(receivedWorkspaceId).toBe(workspace.id);
        operationOrder.push("lock");
        graphLocked = true;
      },
      find: async (receivedWorkspaceId, prerequisiteWorkItemId, dependentWorkItemId) => {
        requireGraphLock("find");
        return (
          dependencies.find(
            (dependency) =>
              dependency.workspaceId === receivedWorkspaceId &&
              dependency.prerequisiteWorkItemId === prerequisiteWorkItemId &&
              dependency.dependentWorkItemId === dependentWorkItemId,
          ) ?? null
        );
      },
      list: async (receivedWorkspaceId, limit, offset) => {
        operationOrder.push("list");
        return dependencies
          .filter((dependency) => dependency.workspaceId === receivedWorkspaceId)
          .slice(offset, offset + limit);
      },
      listForPlanning: async () => [],
      loadPlanningGraph: async () => ({ workItems: [], dependencies: [] }),
      wouldCreateCycle: async () => {
        requireGraphLock("cycle");
        cycleReadCount += 1;
        return options.wouldCreateCycle ?? false;
      },
      insert: async (dependency) => {
        requireGraphLock("insert");
        insertCount += 1;
        dependencies.push(dependency);
      },
      delete: async (receivedWorkspaceId, prerequisiteWorkItemId, dependentWorkItemId) => {
        requireGraphLock("delete");
        deleteCount += 1;
        if (options.deleteResult === false) return false;
        const index = dependencies.findIndex(
          (dependency) =>
            dependency.workspaceId === receivedWorkspaceId &&
            dependency.prerequisiteWorkItemId === prerequisiteWorkItemId &&
            dependency.dependentWorkItemId === dependentWorkItemId,
        );
        if (index < 0) return false;
        dependencies.splice(index, 1);
        return true;
      },
    },
    auditEvents: {
      append: async (event: AuditEventRecord) => {
        operationOrder.push("audit");
        auditEvents.push(event);
      },
    },
    routines: {} as TransactionContext["routines"],
    activityEvents: {} as TransactionContext["activityEvents"],
    routineDurationInsightFeedback: {} as TransactionContext["routineDurationInsightFeedback"],
    scheduleBlocks: {} as TransactionContext["scheduleBlocks"],
    dailyPlans: {} as TransactionContext["dailyPlans"],
  } satisfies TransactionContext;
  const unitOfWork: UnitOfWork = {
    run: async (operation, receivedOptions) => {
      transactionRuns += 1;
      graphLocked = false;
      unitOfWorkOptions = receivedOptions;
      return operation(context);
    },
  };
  const clock = {
    now: () => {
      clockCount += 1;
      return new Date(`2026-07-14T${String(8 + clockCount).padStart(2, "0")}:00:00.000Z`);
    },
  };
  return {
    add: new AddWorkItemDependency(unitOfWork, clock),
    remove: new RemoveWorkItemDependency(unitOfWork, clock),
    list: new ListWorkItemDependencies(unitOfWork),
    dependencies,
    auditEvents,
    operationOrder,
    transactionRuns: () => transactionRuns,
    insertCount: () => insertCount,
    deleteCount: () => deleteCount,
    cycleReadCount: () => cycleReadCount,
    clockCount: () => clockCount,
    unitOfWorkOptions: () => unitOfWorkOptions,
  };
}

describe("work item dependencies", () => {
  it("adds a dependency after locking and verifying both tenant-scoped work items", async () => {
    const test = harness();

    const result = await test.add.execute(command);

    expect(result).toEqual({ dependency: test.dependencies[0], created: true });
    expect(result.dependency).toMatchObject(command);
    expect(result.dependency.createdAt).toEqual(new Date("2026-07-14T09:00:00.000Z"));
    expect(test.operationOrder).toEqual([
      "lock",
      "workspace",
      `item:${prerequisite.id}`,
      `item:${dependent.id}`,
      "find",
      "cycle",
      "insert",
      "audit",
    ]);
    expect(test.auditEvents).toEqual([
      {
        workspaceId: workspace.id,
        action: "work_item_dependency.added",
        entityType: "work_item_dependency",
        entityId: dependent.id,
        data: {
          prerequisiteWorkItemId: prerequisite.id,
          dependentWorkItemId: dependent.id,
          createdAt: "2026-07-14T09:00:00.000Z",
        },
        occurredAt: new Date("2026-07-14T09:00:00.000Z"),
      },
    ]);
    expect(test.unitOfWorkOptions()).toEqual({ isolationLevel: "read_committed" });
  });

  it("returns the exact stored dependency on duplicate add without another change", async () => {
    const existing = createWorkItemDependency({ ...command, createdAt: new Date(0) });
    const test = harness({ initialDependencies: [existing] });

    await expect(test.add.execute(command)).resolves.toEqual({
      dependency: existing,
      created: false,
    });
    expect(test.insertCount()).toBe(0);
    expect(test.cycleReadCount()).toBe(0);
    expect(test.clockCount()).toBe(0);
    expect(test.auditEvents).toEqual([]);
  });

  it("rejects a transitive cycle without writing or auditing", async () => {
    const test = harness({ wouldCreateCycle: true });

    await expect(test.add.execute(command)).rejects.toMatchObject({
      code: "work_item_dependency.cycle_conflict",
    });
    expect(test.insertCount()).toBe(0);
    expect(test.auditEvents).toEqual([]);
    expect(test.clockCount()).toBe(0);
  });

  it("rejects a missing or cross-tenant endpoint after taking the graph lock", async () => {
    const test = harness({ items: [prerequisite] });

    await expect(test.add.execute(command)).rejects.toMatchObject({ code: "work_item.not_found" });
    expect(test.operationOrder.slice(0, 2)).toEqual(["lock", "workspace"]);
    expect(test.insertCount()).toBe(0);
  });

  it("locks before rejecting a missing workspace", async () => {
    const test = harness({ workspaceExists: false });

    await expect(test.add.execute(command)).rejects.toMatchObject({ code: "workspace.not_found" });
    expect(test.operationOrder).toEqual(["lock", "workspace"]);
    expect(test.insertCount()).toBe(0);
  });

  it("rejects self-reference before opening a transaction", async () => {
    const test = harness();

    expect(() =>
      test.add.execute({
        ...command,
        dependentWorkItemId: command.prerequisiteWorkItemId,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "work_item_dependency.self_reference_invalid" }),
    );
    expect(test.transactionRuns()).toBe(0);
  });

  it("rejects a mixed-case add self-reference before opening a transaction", () => {
    const test = harness();

    expect(() =>
      test.add.execute({
        workspaceId: workspace.id,
        prerequisiteWorkItemId: workItemId("abcdef00-0000-4000-8000-000000000001"),
        dependentWorkItemId: workItemId("ABCDEF00-0000-4000-8000-000000000001"),
      }),
    ).toThrowError(
      expect.objectContaining({ code: "work_item_dependency.self_reference_invalid" }),
    );
    expect(test.transactionRuns()).toBe(0);
  });

  it("removes an existing dependency once and audits only the real change", async () => {
    const existing = createWorkItemDependency({ ...command, createdAt: new Date(0) });
    const test = harness({ initialDependencies: [existing] });

    await test.remove.execute(command);
    await test.remove.execute(command);

    expect(test.dependencies).toEqual([]);
    expect(test.deleteCount()).toBe(1);
    expect(test.clockCount()).toBe(1);
    expect(test.auditEvents).toHaveLength(1);
    expect(test.auditEvents[0]).toMatchObject({
      action: "work_item_dependency.removed",
      entityType: "work_item_dependency",
      entityId: dependent.id,
      data: {
        prerequisiteWorkItemId: prerequisite.id,
        dependentWorkItemId: dependent.id,
        createdAt: "1970-01-01T00:00:00.000Z",
      },
    });
    expect(test.unitOfWorkOptions()).toEqual({ isolationLevel: "read_committed" });
  });

  it("rejects a self-referential remove before opening a transaction", () => {
    const test = harness();

    expect(() =>
      test.remove.execute({
        ...command,
        prerequisiteWorkItemId: command.dependentWorkItemId,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "work_item_dependency.self_reference_invalid" }),
    );
    expect(test.transactionRuns()).toBe(0);
  });

  it("rejects a mixed-case remove self-reference before opening a transaction", () => {
    const test = harness();

    expect(() =>
      test.remove.execute({
        workspaceId: workspace.id,
        prerequisiteWorkItemId: workItemId("fedcba00-0000-4000-8000-000000000001"),
        dependentWorkItemId: workItemId("FEDCBA00-0000-4000-8000-000000000001"),
      }),
    ).toThrowError(
      expect.objectContaining({ code: "work_item_dependency.self_reference_invalid" }),
    );
    expect(test.transactionRuns()).toBe(0);
  });

  it("does not audit when a locked delete loses an already-absent edge", async () => {
    const existing = createWorkItemDependency({ ...command, createdAt: new Date(0) });
    const test = harness({ initialDependencies: [existing], deleteResult: false });

    await test.remove.execute(command);

    expect(test.deleteCount()).toBe(1);
    expect(test.clockCount()).toBe(0);
    expect(test.auditEvents).toEqual([]);
  });

  it("lists a workspace-scoped dependency page from one read-only snapshot", async () => {
    const existing = createWorkItemDependency({ ...command, createdAt: new Date(0) });
    const test = harness({ initialDependencies: [existing] });

    await expect(
      test.list.execute({ workspaceId: workspace.id, limit: 20, offset: 0 }),
    ).resolves.toEqual({ items: [existing], limit: 20, offset: 0 });
    expect(test.operationOrder).toEqual(["workspace", "list"]);
  });

  it("validates dependency page bounds before opening a transaction", async () => {
    const test = harness();

    expect(() => test.list.execute({ workspaceId: workspace.id, limit: 201 })).toThrowError(
      expect.objectContaining({ code: "work_item_dependency.limit_invalid" }),
    );
    expect(() => test.list.execute({ workspaceId: workspace.id, offset: -1 })).toThrowError(
      expect.objectContaining({ code: "work_item_dependency.offset_invalid" }),
    );
    expect(test.transactionRuns()).toBe(0);
  });
});
