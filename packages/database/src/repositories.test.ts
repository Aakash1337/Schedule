import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

import {
  activityEventId,
  dailyPlanFitInsightMaximumItemsPerPlan,
  dailyPlanFitInsightFeedbackId,
  dailyPlanId,
  localDate,
  planItemId,
  routineId,
  routineDurationInsightFeedbackId,
  routinePlanningFeedbackId,
  workItemId,
  workspaceId,
  type RoutinePlanningFeedback,
  type RoutineDurationInsightFeedback,
  type DailyPlanFitInsightFeedback,
  type WorkItem,
  type WorkItemDependency,
} from "@schedule/domain";

import type { DatabaseConnection } from "./database.js";
import {
  PostgresIntegrationRequestRepository,
  PostgresIntegrationUnitOfWork,
  PostgresNaturalLanguageProposalRepository,
  PostgresNaturalLanguageProposalUnitOfWork,
  PostgresDailyPlanFitInsightFeedbackRepository,
  PostgresRoutineDurationInsightFeedbackRepository,
  PostgresUnitOfWork,
  PostgresWorkItemDependencyRepository,
  PostgresActivityEventRepository,
  PostgresDailyPlanRepository,
} from "./repositories.js";
import {
  dailyPlanFitInsightFeedbackEvents,
  routineDurationInsightFeedbackEvents,
  routinePlanningFeedbackEvents,
} from "./schema.js";

const requestIdentity = {
  id: "10000000-0000-4000-8000-000000000001",
  workspaceId: workspaceId("20000000-0000-4000-8000-000000000002"),
  credentialId: "30000000-0000-4000-8000-000000000003",
  idempotencyKey: "whatsapp-message-42",
  confirmationId: "40000000-0000-4000-8000-000000000004",
  operation: "work_item.create" as const,
  commandHash: "a".repeat(64),
  createdAt: new Date("2026-07-13T02:00:00.000Z"),
};

const successfulResult = {
  receiptVersion: 1 as const,
  confirmationId: requestIdentity.confirmationId,
  operation: requestIdentity.operation,
  commandHash: requestIdentity.commandHash,
  outcome: {
    type: "work_item.created" as const,
    workItem: {
      id: "50000000-0000-4000-8000-000000000005",
      workspaceId: requestIdentity.workspaceId,
      title: "Send the report",
      description: null,
      status: "backlog" as const,
      priority: "medium" as const,
      planningDurationMinutes: null,
      dueOn: null,
      version: 1,
      createdAt: "2026-07-13T02:00:01.000Z",
      updatedAt: "2026-07-13T02:00:01.000Z",
    },
  },
};

const proposalCommandDisplay = '{"title":"Send the report","type":"work_item.create"}';
const proposalRow = {
  id: "60000000-0000-4000-8000-000000000006",
  workspaceId: requestIdentity.workspaceId,
  requestId: "70000000-0000-4000-8000-000000000007",
  promptHash: "c".repeat(64),
  commandHash: createHash("sha256").update(proposalCommandDisplay).digest("hex"),
  reviewHash: "40ceef00dce6da430703dbbde48ccf4937f68efd7253a5415dbabc4e316b5f81",
  commandDisplay: proposalCommandDisplay,
  command: { type: "work_item.create", title: "Send the report" },
  userSelection: {
    priority: "medium" as const,
    dueOn: localDate("2026-07-20"),
    planningDurationMinutes: 45,
  },
  reviewPriority: "medium" as const,
  reviewDueOn: "2026-07-20",
  reviewPlanningDurationMinutes: 45,
  provider: "ollama",
  model: "gemma4:e4b",
  status: "pending" as const,
  expiresAt: new Date("2026-07-13T02:10:00.000Z"),
  confirmationKeyHash: null,
  resultWorkItemId: null,
  confirmedAt: null,
  cancelledAt: null,
  version: 1,
  createdAt: new Date("2026-07-13T02:00:00.000Z"),
  updatedAt: new Date("2026-07-13T02:00:00.000Z"),
  inserted: true,
} as const;

function requestRow(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  const completedAt = new Date("2026-07-13T02:00:01.000Z");
  return {
    ...requestIdentity,
    status: "succeeded",
    result: successfulResult,
    completedAt,
    updatedAt: completedAt,
    inserted: false,
    ...overrides,
  };
}

function reservationDatabase(row: Readonly<Record<string, unknown>>): DatabaseConnection["db"] {
  const returning = vi.fn().mockResolvedValue([row]);
  const onConflictDoUpdate = vi.fn().mockReturnValue({ returning });
  const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
  return { insert: vi.fn().mockReturnValue({ values }) } as unknown as DatabaseConnection["db"];
}

function proposalInsertDatabase(row: Readonly<Record<string, unknown>>): DatabaseConnection["db"] {
  const returning = vi.fn().mockResolvedValue([row]);
  const onConflictDoUpdate = vi.fn().mockReturnValue({ returning });
  const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
  return { insert: vi.fn().mockReturnValue({ values }) } as unknown as DatabaseConnection["db"];
}

describe("PostgresUnitOfWork", () => {
  it("retries a serialization failure wrapped by the database adapter", async () => {
    const serializationFailure = Object.assign(new Error("serialization failure"), {
      code: "40001",
    });
    const transaction = vi
      .fn()
      .mockRejectedValueOnce(new Error("query failed", { cause: serializationFailure }))
      .mockImplementationOnce(async (operation: (transaction: unknown) => Promise<unknown>) =>
        operation({}),
      );
    const connection = {
      db: { transaction },
    } as unknown as DatabaseConnection;

    await expect(new PostgresUnitOfWork(connection).run(async () => "committed")).resolves.toBe(
      "committed",
    );
    expect(transaction).toHaveBeenCalledTimes(2);
  });

  it("does not retry an unrelated wrapped database failure", async () => {
    const constraintFailure = Object.assign(new Error("constraint failure"), {
      code: "23505",
    });
    const wrapped = new Error("query failed", { cause: constraintFailure });
    const transaction = vi.fn().mockRejectedValue(wrapped);
    const connection = {
      db: { transaction },
    } as unknown as DatabaseConnection;

    await expect(new PostgresUnitOfWork(connection).run(async () => "unused")).rejects.toBe(
      wrapped,
    );
    expect(transaction).toHaveBeenCalledTimes(1);
  });

  it("uses a fresh statement snapshot when read committed is explicitly requested", async () => {
    const transaction = vi
      .fn()
      .mockImplementation(async (operation: (transaction: unknown) => Promise<unknown>) =>
        operation({}),
      );
    const connection = { db: { transaction } } as unknown as DatabaseConnection;

    await expect(
      new PostgresUnitOfWork(connection).run(async () => "committed", {
        isolationLevel: "read_committed",
      }),
    ).resolves.toBe("committed");

    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "read committed",
    });
  });

  it("wires product graph and insight feedback repositories into every transaction", async () => {
    const transaction = vi.fn(async (operation: (transaction: unknown) => Promise<unknown>) =>
      operation({}),
    );
    const connection = { db: { transaction } } as unknown as DatabaseConnection;

    const repositories = await new PostgresUnitOfWork(connection).run(async (context) =>
      Object.keys(context).sort(),
    );

    expect(repositories).toContain("workItemDependencies");
    expect(repositories).toContain("routineDurationInsightFeedback");
  });

  it("persists a work item due date on insert and save", async () => {
    const insertValues = vi.fn().mockResolvedValue(undefined);
    const insert = vi.fn().mockReturnValue({ values: insertValues });
    const returning = vi.fn().mockResolvedValue([{ id: "50000000-0000-4000-8000-000000000005" }]);
    const where = vi.fn().mockReturnValue({ returning });
    const updateSet = vi.fn().mockReturnValue({ where });
    const update = vi.fn().mockReturnValue({ set: updateSet });
    const transaction = vi.fn(async (operation: (database: unknown) => Promise<unknown>) =>
      operation({ insert, update }),
    );
    const connection = { db: { transaction } } as unknown as DatabaseConnection;
    const item = {
      id: workItemId("50000000-0000-4000-8000-000000000005"),
      workspaceId: requestIdentity.workspaceId,
      parentWorkItemId: null,
      title: "Submit the report",
      description: null,
      status: "backlog",
      priority: "medium",
      planningDurationMinutes: 45,
      dueOn: localDate("2026-07-20"),
      version: 1,
      createdAt: new Date("2026-07-13T02:00:01.000Z"),
      updatedAt: new Date("2026-07-13T02:00:01.000Z"),
    } satisfies WorkItem;

    await new PostgresUnitOfWork(connection).run(async ({ workItems }) => {
      await workItems.insert(item);
      await workItems.save(
        { ...item, version: 2, updatedAt: new Date("2026-07-13T03:00:00.000Z") },
        1,
      );
    });

    expect(insertValues).toHaveBeenCalledWith(
      expect.objectContaining({ dueOn: "2026-07-20", parentWorkItemId: null }),
    );
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ dueOn: "2026-07-20", parentWorkItemId: null }),
    );
  });

  it("maps nullable due dates from work item rows", async () => {
    const limit = vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: "50000000-0000-4000-8000-000000000005",
          workspaceId: requestIdentity.workspaceId,
          parentWorkItemId: "50000000-0000-4000-8000-000000000004",
          title: "Submit the report",
          description: null,
          status: "backlog",
          priority: "medium",
          planningDurationMinutes: 45,
          dueOn: "2026-07-20",
          version: 1,
          createdAt: new Date("2026-07-13T02:00:01.000Z"),
          updatedAt: new Date("2026-07-13T02:00:01.000Z"),
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "50000000-0000-4000-8000-000000000005",
          workspaceId: requestIdentity.workspaceId,
          parentWorkItemId: null,
          title: "Submit the report",
          description: null,
          status: "backlog",
          priority: "medium",
          planningDurationMinutes: 45,
          dueOn: null,
          version: 1,
          createdAt: new Date("2026-07-13T02:00:01.000Z"),
          updatedAt: new Date("2026-07-13T02:00:01.000Z"),
        },
      ]);
    const where = vi.fn().mockReturnValue({ limit });
    const from = vi.fn().mockReturnValue({ where });
    const select = vi.fn().mockReturnValue({ from });
    const transaction = vi.fn(async (operation: (database: unknown) => Promise<unknown>) =>
      operation({ select }),
    );
    const connection = { db: { transaction } } as unknown as DatabaseConnection;
    const unitOfWork = new PostgresUnitOfWork(connection);
    const item = workItemId("50000000-0000-4000-8000-000000000005");

    await expect(
      unitOfWork.run(({ workItems }) => workItems.findById(requestIdentity.workspaceId, item)),
    ).resolves.toMatchObject({
      dueOn: "2026-07-20",
      parentWorkItemId: "50000000-0000-4000-8000-000000000004",
    });
    await expect(
      unitOfWork.run(({ workItems }) => workItems.findById(requestIdentity.workspaceId, item)),
    ).resolves.toMatchObject({ dueOn: null });
  });

  it("directly excludes parent work items from planning candidates", async () => {
    const parentId = workItemId("50000000-0000-4000-8000-000000000010");
    const childId = workItemId("50000000-0000-4000-8000-000000000011");
    const unrelatedLeafId = workItemId("50000000-0000-4000-8000-000000000012");
    const candidateRow = (id: string, parentWorkItemId: string | null, title: string) => ({
      id,
      workspaceId: requestIdentity.workspaceId,
      parentWorkItemId,
      title,
      description: null,
      status: "backlog" as const,
      priority: "medium" as const,
      planningDurationMinutes: 30,
      dueOn: null,
      version: 1,
      createdAt: new Date("2026-07-13T02:00:01.000Z"),
      updatedAt: new Date("2026-07-13T02:00:01.000Z"),
    });
    const limit = vi
      .fn()
      .mockResolvedValue([
        candidateRow(childId, parentId, "Child leaf"),
        candidateRow(unrelatedLeafId, null, "Unrelated leaf"),
      ]);
    const orderBy = vi.fn().mockReturnValue({ limit });
    const outerWhere = vi.fn().mockReturnValue({ orderBy });
    const outerFrom = vi.fn().mockReturnValue({ where: outerWhere });
    const childWhere = vi.fn().mockReturnValue({ getSQL: () => sql`select 1` });
    const childFrom = vi.fn().mockReturnValue({ where: childWhere });
    const select = vi
      .fn()
      .mockReturnValueOnce({ from: outerFrom })
      .mockReturnValueOnce({ from: childFrom });
    const transaction = vi.fn(async (operation: (database: unknown) => Promise<unknown>) =>
      operation({ select }),
    );
    const connection = { db: { transaction } } as unknown as DatabaseConnection;

    const candidates = await new PostgresUnitOfWork(connection).run(({ workItems }) =>
      workItems.listPlanningCandidates(requestIdentity.workspaceId),
    );

    expect(candidates.map((candidate) => candidate.id)).toEqual([childId, unrelatedLeafId]);
    expect(candidates).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: parentId })]),
    );
    expect(select).toHaveBeenCalledTimes(2);
    expect(limit).toHaveBeenCalledWith(501);
    const outerPredicate = new PgDialect().sqlToQuery(outerWhere.mock.calls[0]?.[0]);
    const childPredicate = new PgDialect().sqlToQuery(childWhere.mock.calls[0]?.[0]);
    expect(outerPredicate.sql).toContain("not exists (select 1)");
    expect(childPredicate.sql).toContain('"planning_child_work_items"."parent_work_item_id"');
    expect(childPredicate.sql).toContain('"work_items"."id"');
  });
});

const dependencyWorkspace = workspaceId("61000000-0000-4000-8000-000000000001");
const dependencyPrerequisite = workItemId("62000000-0000-4000-8000-000000000002");
const dependencyDependent = workItemId("63000000-0000-4000-8000-000000000003");
const dependencyCreatedAt = new Date("2026-07-14T12:00:00.000Z");

function dependencyRow(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    workspaceId: dependencyWorkspace,
    prerequisiteWorkItemId: dependencyPrerequisite,
    dependentWorkItemId: dependencyDependent,
    createdAt: dependencyCreatedAt,
    ...overrides,
  };
}

const dependency = {
  workspaceId: dependencyWorkspace,
  prerequisiteWorkItemId: dependencyPrerequisite,
  dependentWorkItemId: dependencyDependent,
  createdAt: dependencyCreatedAt,
} satisfies WorkItemDependency;

describe("PostgresWorkItemDependencyRepository", () => {
  it("uses one workspace-scoped advisory key for graph mutations", async () => {
    const execute = vi.fn().mockResolvedValue([]);
    const repository = new PostgresWorkItemDependencyRepository({
      execute,
    } as unknown as DatabaseConnection["db"]);
    const uppercaseWorkspace = workspaceId(dependencyWorkspace.toUpperCase());

    await repository.lockWorkspace(dependencyWorkspace);
    await repository.lockWorkspace(uppercaseWorkspace);

    expect(execute).toHaveBeenCalledTimes(2);
    const dialect = new PgDialect();
    const lowercaseQuery = dialect.sqlToQuery(execute.mock.calls[0]?.[0]);
    const uppercaseQuery = dialect.sqlToQuery(execute.mock.calls[1]?.[0]);
    expect(uppercaseQuery.sql).toBe(lowercaseQuery.sql);
    expect(uppercaseQuery.params).toEqual(lowercaseQuery.params);
    expect(lowercaseQuery.params).toEqual([`${dependencyWorkspace}:work-item-dependencies`]);
  });

  it("finds one tenant-scoped edge and returns a defensive timestamp copy", async () => {
    const limit = vi.fn().mockResolvedValue([dependencyRow()]);
    const where = vi.fn().mockReturnValue({ limit });
    const from = vi.fn().mockReturnValue({ where });
    const select = vi.fn().mockReturnValue({ from });
    const repository = new PostgresWorkItemDependencyRepository({
      select,
    } as unknown as DatabaseConnection["db"]);

    const found = await repository.find(
      dependencyWorkspace,
      dependencyPrerequisite,
      dependencyDependent,
    );

    expect(found).toEqual(dependency);
    expect(found?.createdAt).not.toBe(dependencyCreatedAt);
    expect(limit).toHaveBeenCalledWith(1);
  });

  it("returns null for a missing edge", async () => {
    const limit = vi.fn().mockResolvedValue([]);
    const where = vi.fn().mockReturnValue({ limit });
    const from = vi.fn().mockReturnValue({ where });
    const repository = new PostgresWorkItemDependencyRepository({
      select: vi.fn().mockReturnValue({ from }),
    } as unknown as DatabaseConnection["db"]);

    await expect(
      repository.find(dependencyWorkspace, dependencyPrerequisite, dependencyDependent),
    ).resolves.toBeNull();
  });

  it("paginates dependency edges in stable timestamp and identity order", async () => {
    const offset = vi.fn().mockResolvedValue([dependencyRow()]);
    const limit = vi.fn().mockReturnValue({ offset });
    const orderBy = vi.fn().mockReturnValue({ limit });
    const where = vi.fn().mockReturnValue({ orderBy });
    const from = vi.fn().mockReturnValue({ where });
    const repository = new PostgresWorkItemDependencyRepository({
      select: vi.fn().mockReturnValue({ from }),
    } as unknown as DatabaseConnection["db"]);

    await expect(repository.list(dependencyWorkspace, 25, 50)).resolves.toEqual([dependency]);
    expect(orderBy).toHaveBeenCalledTimes(1);
    expect(orderBy.mock.calls[0]).toHaveLength(3);
    expect(limit).toHaveBeenCalledWith(25);
    expect(offset).toHaveBeenCalledWith(50);
  });

  it("joins prerequisite status and excludes ineligible dependent work from the planner bound", async () => {
    const limit = vi.fn().mockResolvedValue([dependencyRow({ prerequisiteStatus: "done" })]);
    const orderBy = vi.fn().mockReturnValue({ limit });
    const where = vi.fn().mockReturnValue({ orderBy });
    const dependentJoin = vi.fn().mockReturnValue({ where });
    const prerequisiteJoin = vi.fn().mockReturnValue({ innerJoin: dependentJoin });
    const from = vi.fn().mockReturnValue({ innerJoin: prerequisiteJoin });
    const select = vi.fn().mockReturnValue({ from });
    const repository = new PostgresWorkItemDependencyRepository({
      select,
    } as unknown as DatabaseConnection["db"]);

    await expect(repository.listForPlanning(dependencyWorkspace, 2_001)).resolves.toEqual([
      { ...dependency, createdAt: new Date(dependencyCreatedAt), prerequisiteStatus: "done" },
    ]);
    expect(prerequisiteJoin).toHaveBeenCalledTimes(1);
    expect(dependentJoin).toHaveBeenCalledTimes(1);
    const predicate = where.mock.calls[0]?.[0];
    const compiled = new PgDialect().sqlToQuery(predicate);
    expect(compiled.sql).toContain(
      '"dependent_work_items"."planning_duration_minutes" is not null',
    );
    expect(compiled.sql).toContain('"dependent_work_items"."status" in');
    expect(compiled.params).toEqual(expect.arrayContaining(["backlog", "planned", "in_progress"]));
    expect(orderBy.mock.calls[0]).toHaveLength(3);
    expect(limit).toHaveBeenCalledWith(2_001);
  });

  it("loads candidates and relevant dependencies with one bounded ordered statement", async () => {
    const execute = vi.fn().mockResolvedValue([
      {
        rowGroup: 0,
        rowPosition: 1,
        rowKind: "work_item",
        payload: {
          id: dependencyDependent,
          workspaceId: dependencyWorkspace,
          parentWorkItemId: null,
          title: "Publish release notes",
          description: null,
          status: "backlog",
          priority: "high",
          planningDurationMinutes: 30,
          dueOn: "2026-07-20",
          version: 2,
          createdAt: "2026-07-14T11:00:00.000Z",
          updatedAt: "2026-07-14T12:00:00.000Z",
        },
      },
      {
        rowGroup: 1,
        rowPosition: 1,
        rowKind: "dependency",
        payload: {
          workspaceId: dependencyWorkspace,
          prerequisiteWorkItemId: dependencyPrerequisite,
          dependentWorkItemId: dependencyDependent,
          createdAt: dependencyCreatedAt.toISOString(),
          prerequisiteStatus: "done",
        },
      },
    ]);
    const repository = new PostgresWorkItemDependencyRepository({
      execute,
    } as unknown as DatabaseConnection["db"]);

    const graph = await repository.loadPlanningGraph(dependencyWorkspace, 501, 2_001);

    expect(graph.workItems).toEqual([
      expect.objectContaining({
        id: dependencyDependent,
        parentWorkItemId: null,
        planningDurationMinutes: 30,
        dueOn: "2026-07-20",
        createdAt: new Date("2026-07-14T11:00:00.000Z"),
      }),
    ]);
    expect(graph.dependencies).toEqual([
      {
        ...dependency,
        createdAt: new Date(dependencyCreatedAt),
        prerequisiteStatus: "done",
      },
    ]);
    expect(execute).toHaveBeenCalledTimes(1);
    const statement = execute.mock.calls[0]?.[0];
    const compiled = new PgDialect().sqlToQuery(statement);
    expect(compiled.sql).toContain("with candidate_work_items as materialized");
    expect(compiled.sql).toContain('"work_items"."planning_duration_minutes" is not null');
    expect(compiled.sql).toContain(
      "\"work_items\".\"status\" in ('backlog', 'planned', 'in_progress')",
    );
    expect(compiled.sql).toContain('from "work_items" as planning_child_work_items');
    expect(compiled.sql).toContain("inner join candidate_work_items");
    expect(compiled.sql).toContain('inner join "work_items" as prerequisite_work_items');
    expect(compiled.sql).toContain('order by "rowGroup", "rowPosition"');
    expect(compiled.params).toEqual([dependencyWorkspace, 501, dependencyWorkspace, 2_001]);
  });

  it("fails closed when a one-statement graph projection is malformed or unordered", async () => {
    const validWorkItemPayload = {
      id: dependencyDependent,
      workspaceId: dependencyWorkspace,
      parentWorkItemId: null,
      title: "Publish release notes",
      description: null,
      status: "backlog",
      priority: "high",
      planningDurationMinutes: 30,
      dueOn: "2026-07-20",
      version: 2,
      createdAt: "2026-07-14T11:00:00.000Z",
      updatedAt: "2026-07-14T12:00:00.000Z",
    } as const;
    const validDependencyPayload = {
      workspaceId: dependencyWorkspace,
      prerequisiteWorkItemId: dependencyPrerequisite,
      dependentWorkItemId: dependencyDependent,
      createdAt: dependencyCreatedAt.toISOString(),
      prerequisiteStatus: "done",
    } as const;
    const invalidProjections = [
      [
        {
          rowGroup: 1,
          rowPosition: 2,
          rowKind: "dependency",
          payload: validDependencyPayload,
        },
      ],
      [
        {
          rowGroup: 0,
          rowPosition: 1,
          rowKind: "work_item",
          payload: { ...validWorkItemPayload, status: "unsupported" },
        },
      ],
      [
        {
          rowGroup: 1,
          rowPosition: 1,
          rowKind: "dependency",
          payload: { ...validDependencyPayload, prerequisiteStatus: "unsupported" },
        },
      ],
      [
        {
          rowGroup: 0,
          rowPosition: 1,
          rowKind: "work_item",
          payload: { ...validWorkItemPayload, dueOn: "2026-02-30" },
        },
      ],
      [
        {
          rowGroup: 0,
          rowPosition: 1,
          rowKind: "work_item",
          payload: { ...validWorkItemPayload, id: "   " },
        },
      ],
      [
        {
          rowGroup: 1,
          rowPosition: 1,
          rowKind: "dependency",
          payload: { ...validDependencyPayload, workspaceId: "   " },
        },
      ],
      [
        {
          rowGroup: 1,
          rowPosition: 1,
          rowKind: "dependency",
          payload: {
            ...validDependencyPayload,
            dependentWorkItemId: dependencyPrerequisite,
          },
        },
      ],
    ] as const;

    for (const projection of invalidProjections) {
      const execute = vi.fn().mockResolvedValue(projection);
      const repository = new PostgresWorkItemDependencyRepository({
        execute,
      } as unknown as DatabaseConnection["db"]);

      await expect(
        repository.loadPlanningGraph(dependencyWorkspace, 501, 2_001),
      ).rejects.toMatchObject({ code: "planning.work_item_graph_corrupt" });
      expect(execute).toHaveBeenCalledTimes(1);
    }
  });

  it("does not mask database failures while loading a planning graph", async () => {
    const databaseFailure = new Error("database query failed");
    const execute = vi.fn().mockRejectedValue(databaseFailure);
    const repository = new PostgresWorkItemDependencyRepository({
      execute,
    } as unknown as DatabaseConnection["db"]);

    await expect(repository.loadPlanningGraph(dependencyWorkspace, 501, 2_001)).rejects.toBe(
      databaseFailure,
    );
  });

  it("uses a tenant-scoped recursive query for transitive cycle detection", async () => {
    const execute = vi.fn().mockResolvedValue([{ wouldCreateCycle: true }]);
    const repository = new PostgresWorkItemDependencyRepository({
      execute,
    } as unknown as DatabaseConnection["db"]);

    await expect(
      repository.wouldCreateCycle(dependencyWorkspace, dependencyPrerequisite, dependencyDependent),
    ).resolves.toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
    const statement = execute.mock.calls[0]?.[0] as { readonly queryChunks: readonly unknown[] };
    expect(statement.queryChunks.filter((chunk) => chunk === dependencyWorkspace)).toHaveLength(2);
  });

  it("rejects a self-cycle without querying the graph", async () => {
    const execute = vi.fn();
    const repository = new PostgresWorkItemDependencyRepository({
      execute,
    } as unknown as DatabaseConnection["db"]);

    await expect(
      repository.wouldCreateCycle(
        dependencyWorkspace,
        dependencyPrerequisite,
        dependencyPrerequisite,
      ),
    ).resolves.toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it("persists and deletes only the exact directed edge", async () => {
    const values = vi.fn().mockResolvedValue(undefined);
    const insert = vi.fn().mockReturnValue({ values });
    const returning = vi
      .fn()
      .mockResolvedValueOnce([{ prerequisiteWorkItemId: dependencyPrerequisite }])
      .mockResolvedValueOnce([]);
    const where = vi.fn().mockReturnValue({ returning });
    const deleteFrom = vi.fn().mockReturnValue({ where });
    const repository = new PostgresWorkItemDependencyRepository({
      insert,
      delete: deleteFrom,
    } as unknown as DatabaseConnection["db"]);

    await repository.insert(dependency);
    await expect(
      repository.delete(dependencyWorkspace, dependencyPrerequisite, dependencyDependent),
    ).resolves.toBe(true);
    await expect(
      repository.delete(dependencyWorkspace, dependencyPrerequisite, dependencyDependent),
    ).resolves.toBe(false);
    expect(values).toHaveBeenCalledWith(dependency);
    expect(where).toHaveBeenCalledTimes(2);
  });
});

describe("PostgresIntegrationUnitOfWork", () => {
  it("retries serialization failures and exposes the integration repositories together", async () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    const serializationFailure = Object.assign(new Error("serialization failure"), {
      code: "40001",
    });
    const transaction = vi
      .fn()
      .mockRejectedValueOnce(serializationFailure)
      .mockRejectedValueOnce(serializationFailure)
      .mockRejectedValueOnce(serializationFailure)
      .mockRejectedValueOnce(serializationFailure)
      .mockImplementationOnce(async (operation: (transaction: unknown) => Promise<unknown>) =>
        operation({}),
      );
    const connection = { db: { transaction } } as unknown as DatabaseConnection;

    const repositories = await new PostgresIntegrationUnitOfWork(connection).run(async (context) =>
      Object.keys(context).sort(),
    );

    expect(repositories).toEqual([
      "auditEvents",
      "confirmations",
      "credentials",
      "dailyPlans",
      "notificationDeliveries",
      "notificationDeliveryRequests",
      "notifications",
      "requests",
      "scheduleBlocks",
      "workItemDependencies",
      "workItems",
      "workspaces",
    ]);
    expect(transaction).toHaveBeenCalledTimes(5);
    expect(transaction).toHaveBeenLastCalledWith(expect.any(Function), {
      isolationLevel: "serializable",
    });
    random.mockRestore();
  });

  it("uses a fresh statement snapshot after a delivery workspace lock", async () => {
    const transaction = vi.fn(async (operation: (transaction: unknown) => Promise<unknown>) =>
      operation({}),
    );
    const connection = { db: { transaction } } as unknown as DatabaseConnection;

    await expect(
      new PostgresIntegrationUnitOfWork(connection).run(async () => "committed", {
        isolationLevel: "read_committed",
      }),
    ).resolves.toBe("committed");
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "read committed",
    });
  });
});

describe("PostgresNaturalLanguageProposalUnitOfWork", () => {
  it("retries serialization failures and exposes only proposal mutation repositories", async () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    const serializationFailure = Object.assign(new Error("serialization failure"), {
      code: "40001",
    });
    const transaction = vi
      .fn()
      .mockRejectedValueOnce(serializationFailure)
      .mockImplementationOnce(async (operation: (transaction: unknown) => Promise<unknown>) =>
        operation({}),
      );
    const connection = { db: { transaction } } as unknown as DatabaseConnection;

    const repositories = await new PostgresNaturalLanguageProposalUnitOfWork(connection).run(
      async (context) => Object.keys(context).sort(),
    );

    expect(repositories).toEqual(["auditEvents", "proposals", "workItems", "workspaces"]);
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(transaction).toHaveBeenLastCalledWith(expect.any(Function), {
      isolationLevel: "serializable",
    });
    random.mockRestore();
  });

  it("rechecks cancellation after the operation and before transaction commit", async () => {
    const controller = new AbortController();
    const transaction = vi.fn(async (operation: (transaction: unknown) => Promise<unknown>) =>
      operation({}),
    );
    const connection = { db: { transaction } } as unknown as DatabaseConnection;

    await expect(
      new PostgresNaturalLanguageProposalUnitOfWork(connection).run(async () => {
        controller.abort();
        return "must not commit";
      }, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(transaction).toHaveBeenCalledOnce();
  });
});

describe("PostgresNaturalLanguageProposalRepository", () => {
  it("atomically inserts or returns the request winner and validates its command digest", async () => {
    const repository = new PostgresNaturalLanguageProposalRepository(
      proposalInsertDatabase(proposalRow),
    );

    await expect(repository.insertOrFind(proposalRow)).resolves.toMatchObject({
      kind: "inserted",
      proposal: {
        id: proposalRow.id,
        workspaceId: proposalRow.workspaceId,
        command: { type: "work_item.create", title: "Send the report" },
        userSelection: {
          priority: "medium",
          dueOn: "2026-07-20",
          planningDurationMinutes: 45,
        },
      },
    });
  });

  it("fails closed when persisted command JSON does not match its canonical digest", async () => {
    const repository = new PostgresNaturalLanguageProposalRepository(
      proposalInsertDatabase({ ...proposalRow, command: { ...proposalRow.command, extra: true } }),
    );

    await expect(repository.insertOrFind(proposalRow)).rejects.toMatchObject({
      code: "natural_language.confirmation_corrupt",
    });
  });

  it.each([
    ["priority", { reviewPriority: "critical" }],
    ["due date", { reviewDueOn: "2026-02-30" }],
    ["duration", { reviewPlanningDurationMinutes: 43_201 }],
    ["digest", { reviewHash: "f".repeat(64) }],
  ])("fails closed when a persisted review %s is invalid", async (_label, overrides) => {
    const repository = new PostgresNaturalLanguageProposalRepository(
      proposalInsertDatabase({ ...proposalRow, ...overrides }),
    );

    await expect(repository.insertOrFind(proposalRow)).rejects.toMatchObject({
      code: "natural_language.confirmation_corrupt",
    });
  });

  it("takes a tenant-scoped row lock before proposal mutation", async () => {
    const forUpdate = vi.fn().mockResolvedValue([proposalRow]);
    const limit = vi.fn().mockReturnValue({ for: forUpdate });
    const where = vi.fn().mockReturnValue({ limit });
    const from = vi.fn().mockReturnValue({ where });
    const repository = new PostgresNaturalLanguageProposalRepository({
      select: vi.fn().mockReturnValue({ from }),
    } as unknown as DatabaseConnection["db"]);

    await expect(
      repository.findByIdForUpdate(proposalRow.workspaceId, proposalRow.id),
    ).resolves.toMatchObject({ id: proposalRow.id });
    expect(forUpdate).toHaveBeenCalledWith("update");
  });

  it("requires an exact expected version when saving", async () => {
    const returning = vi.fn().mockResolvedValue([]);
    const where = vi.fn().mockReturnValue({ returning });
    const set = vi.fn().mockReturnValue({ where });
    const repository = new PostgresNaturalLanguageProposalRepository({
      update: vi.fn().mockReturnValue({ set }),
    } as unknown as DatabaseConnection["db"]);

    await expect(repository.save(proposalRow, 1)).rejects.toMatchObject({
      code: "natural_language.version_conflict",
    });
  });
});

describe("PostgresIntegrationRequestRepository", () => {
  it("returns a fresh processing reservation", async () => {
    const repository = new PostgresIntegrationRequestRepository(
      reservationDatabase(
        requestRow({
          status: "processing",
          result: null,
          completedAt: null,
          updatedAt: requestIdentity.createdAt,
          inserted: true,
        }),
      ),
    );

    await expect(repository.reserve(requestIdentity)).resolves.toMatchObject({
      kind: "reserved",
      request: { state: "processing", result: null, completedAt: null },
    });
  });

  it("replays only a completed request with the same identity", async () => {
    const repository = new PostgresIntegrationRequestRepository(reservationDatabase(requestRow()));

    await expect(repository.reserve(requestIdentity)).resolves.toMatchObject({
      kind: "replay",
      request: { state: "succeeded", result: successfulResult },
    });
  });

  it("rejects an idempotency key reused for a different command hash", async () => {
    const repository = new PostgresIntegrationRequestRepository(
      reservationDatabase(requestRow({ commandHash: "b".repeat(64) })),
    );

    await expect(repository.reserve(requestIdentity)).rejects.toMatchObject({
      code: "integration.receipt_conflict",
    });
  });

  it("fails closed instead of re-executing a pre-existing processing reservation", async () => {
    const repository = new PostgresIntegrationRequestRepository(
      reservationDatabase(
        requestRow({
          status: "processing",
          result: null,
          completedAt: null,
          inserted: false,
        }),
      ),
    );

    await expect(repository.reserve(requestIdentity)).rejects.toMatchObject({
      code: "integration.receipt_in_progress",
    });
  });
});

const durationEvidenceWorkspace = workspaceId("20000000-0000-4000-8000-000000000002");
const durationEvidenceRoutine = routineId("60000000-0000-4000-8000-000000000006");
const durationEvidenceFrom = new Date("2026-04-14T00:00:00.000Z");
const durationEvidenceThrough = new Date("2026-07-13T12:00:00.000Z");

function activityRow(sequence: number): Readonly<Record<string, unknown>> {
  return {
    id: "70000000-0000-4000-8000-000000000007",
    ingestedSequence: sequence,
    workspaceId: durationEvidenceWorkspace,
    sourceType: "routine",
    routineId: durationEvidenceRoutine,
    workItemId: null,
    planId: null,
    planItemId: null,
    type: "completed",
    occurredAt: new Date("2026-07-12T08:00:00.000Z"),
    localDate: "2026-07-12",
    timeZone: "UTC",
    durationMinutes: 45,
    reason: null,
    referenceEventId: null,
    idempotencyKey: `duration-evidence-${sequence}`,
    metadata: {},
    recordedAt: new Date("2026-07-12T08:01:00.000Z"),
  };
}

function durationEvidenceDatabase(rows: readonly Readonly<Record<string, unknown>>[]) {
  const finalLimit = vi.fn().mockResolvedValue(rows);
  const finalOrderBy = vi.fn().mockReturnValue({ limit: finalLimit });
  const finalWhere = vi.fn().mockReturnValue({ orderBy: finalOrderBy });
  const finalFrom = vi.fn().mockReturnValue({ where: finalWhere });
  const finalSelect = vi.fn().mockReturnValue({ from: finalFrom });
  const withCte = vi.fn().mockReturnValue({ select: finalSelect });
  const candidateFrom = vi.fn().mockReturnValue({ where: vi.fn().mockReturnValue({}) });
  const candidateSelect = vi.fn().mockReturnValue({ from: candidateFrom });
  const cteAs = vi.fn().mockReturnValue({ id: "id" });
  const $with = vi.fn().mockReturnValue({ as: cteAs });
  return {
    database: { $with, select: candidateSelect, with: withCte },
    finalLimit,
    withCte,
  };
}

describe("PostgresActivityEventRepository duration evidence", () => {
  it("locks duration approvals with the same routine-activity advisory key used by append", async () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    const repository = new PostgresActivityEventRepository({
      execute,
    } as unknown as DatabaseConnection["db"]);

    await repository.lockRoutineActivity(durationEvidenceWorkspace, durationEvidenceRoutine);

    expect(execute).toHaveBeenCalledTimes(1);
    const statement = execute.mock.calls[0]?.[0] as {
      readonly queryChunks: readonly unknown[];
    };
    expect(statement.queryChunks[0]).toMatchObject({
      value: ["select pg_advisory_xact_lock(hashtextextended("],
    });
    expect(statement.queryChunks[1]).toBe(
      `${durationEvidenceWorkspace}:routine:${durationEvidenceRoutine}`,
    );
    expect(statement.queryChunks[2]).toMatchObject({ value: [", 0))"] });
  });

  it("uses one bounded CTE query and maps deterministic evidence order", async () => {
    const database = durationEvidenceDatabase([activityRow(42)]);
    const repository = new PostgresActivityEventRepository(
      database.database as unknown as DatabaseConnection["db"],
    );

    await expect(
      repository.listDurationEvidence(
        durationEvidenceWorkspace,
        durationEvidenceRoutine,
        durationEvidenceFrom,
        durationEvidenceThrough,
      ),
    ).resolves.toMatchObject([
      { id: activityEventId("70000000-0000-4000-8000-000000000007"), durationMinutes: 45 },
    ]);
    expect(database.withCte).toHaveBeenCalledTimes(1);
    expect(database.finalLimit).toHaveBeenCalledWith(5_001);
  });

  it("rejects invalid or inverted windows before querying", async () => {
    const database = durationEvidenceDatabase([]);
    const repository = new PostgresActivityEventRepository(
      database.database as unknown as DatabaseConnection["db"],
    );

    await expect(
      repository.listDurationEvidence(
        durationEvidenceWorkspace,
        durationEvidenceRoutine,
        new Date("invalid"),
        durationEvidenceThrough,
      ),
    ).rejects.toMatchObject({ code: "activity.duration_evidence_window_invalid" });
    await expect(
      repository.listDurationEvidence(
        durationEvidenceWorkspace,
        durationEvidenceRoutine,
        durationEvidenceThrough,
        durationEvidenceFrom,
      ),
    ).rejects.toMatchObject({ code: "activity.duration_evidence_window_invalid" });
    expect(database.withCte).not.toHaveBeenCalled();
  });

  it("fails closed when evidence exceeds the local-mode bound", async () => {
    const database = durationEvidenceDatabase(
      Array.from({ length: 5_001 }, (_, index) => activityRow(index + 1)),
    );
    const repository = new PostgresActivityEventRepository(
      database.database as unknown as DatabaseConnection["db"],
    );

    await expect(
      repository.listDurationEvidence(
        durationEvidenceWorkspace,
        durationEvidenceRoutine,
        durationEvidenceFrom,
        durationEvidenceThrough,
      ),
    ).rejects.toMatchObject({ code: "activity.duration_evidence_limit_exceeded" });
  });
});

const feedbackWorkspace = workspaceId("81000000-0000-4000-8000-000000000001");
const feedbackRoutine = routineId("82000000-0000-4000-8000-000000000002");
const feedbackPlan = dailyPlanId("83000000-0000-4000-8000-000000000003");
const feedbackItem = planItemId("84000000-0000-4000-8000-000000000004");
const feedbackEventId = routinePlanningFeedbackId("85000000-0000-4000-8000-000000000005");
const feedbackDate = localDate("2026-07-13");

function feedbackRow(sequence = 17): Readonly<Record<string, unknown>> {
  return {
    id: feedbackEventId,
    ingestedSequence: sequence,
    workspaceId: feedbackWorkspace,
    routineId: feedbackRoutine,
    kind: "not_today",
    effectiveOn: feedbackDate,
    effectiveThrough: feedbackDate,
    timeZone: "America/La_Paz",
    sourcePlanId: feedbackPlan,
    sourcePlanItemId: feedbackItem,
    idempotencyKey: "feedback-db-test",
    recordedAt: new Date("2026-07-13T14:00:00.000Z"),
  };
}

function feedbackQueryDatabase(rows: readonly Readonly<Record<string, unknown>>[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const orderBy = vi.fn().mockReturnValue({ limit });
  const where = vi.fn().mockReturnValue({ orderBy });
  const from = vi.fn().mockReturnValue({ where });
  const selectDistinctOn = vi.fn().mockReturnValue({ from });
  return { database: { selectDistinctOn }, limit, selectDistinctOn };
}

function latestFeedbackQueryDatabase(rows: readonly Readonly<Record<string, unknown>>[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const orderBy = vi.fn().mockReturnValue({ limit });
  const where = vi.fn().mockReturnValue({ orderBy });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  return { database: { select }, limit, orderBy, select };
}

describe("PostgresDailyPlanRepository current-plan batches", () => {
  it("rejects more than 366 distinct dates before querying", async () => {
    const select = vi.fn();
    const repository = new PostgresDailyPlanRepository({
      select,
    } as unknown as DatabaseConnection["db"]);
    const dates = Array.from({ length: 367 }, (_, offset) =>
      localDate(new Date(Date.UTC(2026, 0, offset + 1)).toISOString().slice(0, 10)),
    );

    await expect(
      repository.findCurrentForDates(workspaceId("batch-plan-workspace"), dates),
    ).rejects.toMatchObject({
      code: "planning.current_plan_date_range_too_large",
    });
    expect(select).not.toHaveBeenCalled();
  });

  it("loads multiple dates in four bounded query stages and omits missing dates", async () => {
    const workspace = workspaceId("batch-plan-workspace");
    const firstDate = localDate("2026-07-14");
    const secondDate = localDate("2026-07-15");
    const missingDate = localDate("2026-07-16");
    const firstPlanId = dailyPlanId("batch-plan-first");
    const secondPlanId = dailyPlanId("batch-plan-second");
    const heads = [
      { workspaceId: workspace, localDate: firstDate, currentPlanId: firstPlanId, version: 3 },
      { workspaceId: workspace, localDate: secondDate, currentPlanId: secondPlanId, version: 7 },
    ];
    const planRow = (id: string, date: string, revision: number) => ({
      id,
      workspaceId: workspace,
      localDate: date,
      timeZone: "UTC",
      totalMinutes: 0,
      fitness: 0,
      algorithmVersion: "batch-test",
      configVersion: "batch-test",
      prngVersion: "batch-test",
      seed: `seed-${date}`,
      requestRevision: revision,
      inputHash: "a".repeat(64),
      inputSnapshot: {},
      exclusions: [],
      warnings: [],
      generatedAt: new Date(`${date}T07:00:00.000Z`),
    });
    const wherePredicates: Parameters<PgDialect["sqlToQuery"]>[0][] = [];
    const fromWhere = (rows: readonly unknown[]) => ({
      from: vi.fn().mockReturnValue({
        where: vi.fn((predicate: Parameters<PgDialect["sqlToQuery"]>[0]) => {
          wherePredicates.push(predicate);
          return Promise.resolve(rows);
        }),
      }),
    });
    const itemsFromWhere = {
      from: vi.fn().mockReturnValue({
        where: vi.fn((predicate: Parameters<PgDialect["sqlToQuery"]>[0]) => {
          wherePredicates.push(predicate);
          return { orderBy: vi.fn().mockResolvedValue([]) };
        }),
      }),
    };
    const select = vi
      .fn()
      .mockReturnValueOnce(fromWhere(heads))
      .mockReturnValueOnce(
        fromWhere([planRow(firstPlanId, firstDate, 1), planRow(secondPlanId, secondDate, 2)]),
      )
      .mockReturnValueOnce(itemsFromWhere)
      .mockReturnValueOnce(fromWhere([]));
    const repository = new PostgresDailyPlanRepository({
      select,
    } as unknown as DatabaseConnection["db"]);

    await expect(repository.findCurrentForDates(workspace, [])).resolves.toEqual(new Map());
    const current = await repository.findCurrentForDates(workspace, [
      firstDate,
      secondDate,
      missingDate,
      firstDate,
    ]);

    expect(select).toHaveBeenCalledTimes(4);
    expect(wherePredicates).toHaveLength(4);
    expect(
      wherePredicates.every((predicate) =>
        new PgDialect().sqlToQuery(predicate).params.includes(workspace),
      ),
    ).toBe(true);
    expect([...current.keys()]).toEqual([firstDate, secondDate]);
    expect(current.get(firstDate)).toMatchObject({
      headVersion: 3,
      plan: { id: firstPlanId, date: firstDate, items: [] },
    });
    expect(current.get(secondDate)).toMatchObject({
      headVersion: 7,
      plan: { id: secondPlanId, date: secondDate, items: [] },
    });
    expect(current.has(missingDate)).toBe(false);
  });
});

describe("PostgresDailyPlanRepository Daily Plan Fit evidence", () => {
  it("rejects unbounded history requests before querying", async () => {
    const execute = vi.fn();
    const repository = new PostgresDailyPlanRepository({
      execute,
    } as unknown as DatabaseConnection["db"]);

    await expect(
      repository.listFitEvidence(
        workspaceId("fit-evidence-workspace"),
        localDate("2026-07-14"),
        367,
        90,
      ),
    ).rejects.toMatchObject({ code: "daily_plan_fit_insight.lookback_invalid" });
    await expect(
      repository.listFitEvidence(
        workspaceId("fit-evidence-workspace"),
        localDate("2026-07-14"),
        90,
        367,
      ),
    ).rejects.toMatchObject({ code: "daily_plan_fit_insight.candidate_limit_invalid" });
    expect(execute).not.toHaveBeenCalled();
  });

  it("maps one bounded current-head query and skips malformed target snapshots", async () => {
    const workspace = workspaceId("fit-evidence-workspace");
    const execute = vi.fn().mockResolvedValue([
      {
        planId: "fit-plan-1",
        localDate: "2026-07-13",
        targetMinutes: "180",
        targetTaskCount: "4",
        itemId: "fit-plan-1-item-1",
        scheduledMinutes: 45,
        activityState: "completed",
        lastActivityEventId: "fit-plan-1-event-1",
      },
      {
        planId: "fit-plan-1",
        localDate: "2026-07-13",
        targetMinutes: "180",
        targetTaskCount: "4",
        itemId: "fit-plan-1-item-2",
        scheduledMinutes: 30,
        activityState: "skipped",
        lastActivityEventId: "fit-plan-1-event-2",
      },
      {
        planId: "fit-plan-empty",
        localDate: "2026-07-12",
        targetMinutes: "60",
        targetTaskCount: "2",
        itemId: null,
        scheduledMinutes: null,
        activityState: null,
        lastActivityEventId: null,
      },
      {
        planId: "fit-plan-invalid",
        localDate: "2026-07-11",
        targetMinutes: "18.5",
        targetTaskCount: "4",
        itemId: null,
        scheduledMinutes: null,
        activityState: null,
        lastActivityEventId: null,
      },
    ]);
    const repository = new PostgresDailyPlanRepository({
      execute,
    } as unknown as DatabaseConnection["db"]);

    await expect(
      repository.listFitEvidence(workspace, localDate("2026-07-14"), 90, 90),
    ).resolves.toEqual([
      {
        workspaceId: workspace,
        planId: dailyPlanId("fit-plan-1"),
        date: localDate("2026-07-13"),
        targetMinutes: 180,
        targetTaskCount: 4,
        items: [
          {
            id: planItemId("fit-plan-1-item-1"),
            scheduledMinutes: 45,
            activityState: "completed",
            lastActivityEventId: activityEventId("fit-plan-1-event-1"),
          },
          {
            id: planItemId("fit-plan-1-item-2"),
            scheduledMinutes: 30,
            activityState: "skipped",
            lastActivityEventId: activityEventId("fit-plan-1-event-2"),
          },
        ],
      },
      {
        workspaceId: workspace,
        planId: dailyPlanId("fit-plan-empty"),
        date: localDate("2026-07-12"),
        targetMinutes: 60,
        targetTaskCount: 2,
        items: [],
      },
    ]);
    expect(execute).toHaveBeenCalledTimes(1);
    const query = new PgDialect().sqlToQuery(execute.mock.calls[0]?.[0]);
    expect(query.sql).toContain("with candidate_plans as materialized");
    expect(query.sql).toContain('left join "daily_plan_items"');
    expect(query.params).toEqual(
      expect.arrayContaining([
        workspace,
        "2026-07-14",
        90,
        90 * dailyPlanFitInsightMaximumItemsPerPlan + 1,
      ]),
    );
  });

  it("fails closed when one current plan exceeds the item projection bound", async () => {
    const rows = Array.from({ length: dailyPlanFitInsightMaximumItemsPerPlan + 1 }, (_, index) => ({
      planId: "fit-plan-oversized",
      localDate: "2026-07-13",
      targetMinutes: "180",
      targetTaskCount: "4",
      itemId: `fit-plan-oversized-item-${index}`,
      scheduledMinutes: 30,
      activityState: "completed",
      lastActivityEventId: `fit-plan-oversized-event-${index}`,
    }));
    const repository = new PostgresDailyPlanRepository({
      execute: vi.fn().mockResolvedValue(rows),
    } as unknown as DatabaseConnection["db"]);

    await expect(
      repository.listFitEvidence(
        workspaceId("fit-evidence-workspace"),
        localDate("2026-07-14"),
        90,
        2,
      ),
    ).rejects.toMatchObject({ code: "daily_plan_fit_insight.item_limit_exceeded" });
  });
});

describe("PostgresDailyPlanRepository routine feedback", () => {
  it("locks feedback mutations with a dedicated routine-scoped transaction key", async () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    const repository = new PostgresDailyPlanRepository({
      execute,
    } as unknown as DatabaseConnection["db"]);

    await repository.lockRoutineFeedback(feedbackWorkspace, feedbackRoutine);

    expect(execute).toHaveBeenCalledTimes(1);
    const statement = execute.mock.calls[0]?.[0] as {
      readonly queryChunks: readonly unknown[];
    };
    expect(statement.queryChunks[0]).toMatchObject({
      value: ["select pg_advisory_xact_lock(hashtextextended("],
    });
    expect(statement.queryChunks[1]).toBe(
      `${feedbackWorkspace}:planning-feedback:${feedbackRoutine}`,
    );
    expect(statement.queryChunks[2]).toMatchObject({ value: [", 0))"] });
  });

  it("loads the latest routine feedback without applying an effective-date bound", async () => {
    const database = latestFeedbackQueryDatabase([feedbackRow(42)]);
    const repository = new PostgresDailyPlanRepository(
      database.database as unknown as DatabaseConnection["db"],
    );

    await expect(
      repository.findLatestRoutineFeedback(feedbackWorkspace, feedbackRoutine),
    ).resolves.toMatchObject({
      id: feedbackEventId,
      ingestedSequence: 42,
      routineId: feedbackRoutine,
    });
    expect(database.select).toHaveBeenCalledTimes(1);
    expect(database.orderBy).toHaveBeenCalledTimes(1);
    expect(database.limit).toHaveBeenCalledWith(1);
  });

  it("returns null when a routine has no feedback history", async () => {
    const database = latestFeedbackQueryDatabase([]);
    const repository = new PostgresDailyPlanRepository(
      database.database as unknown as DatabaseConnection["db"],
    );

    await expect(
      repository.findLatestRoutineFeedback(feedbackWorkspace, feedbackRoutine),
    ).resolves.toBeNull();
  });

  it("loads one bounded latest event per routine and maps its allocated sequence", async () => {
    const database = feedbackQueryDatabase([feedbackRow()]);
    const repository = new PostgresDailyPlanRepository(
      database.database as unknown as DatabaseConnection["db"],
    );

    await expect(
      repository.listRoutineFeedbackForPlanning(feedbackWorkspace, feedbackDate),
    ).resolves.toEqual([
      expect.objectContaining({
        id: feedbackEventId,
        ingestedSequence: 17,
        routineId: feedbackRoutine,
        effectiveOn: feedbackDate,
      }),
    ]);
    expect(database.selectDistinctOn).toHaveBeenCalledTimes(1);
    expect(database.limit).toHaveBeenCalledWith(501);
  });

  it("fails closed if persisted feedback exceeds the planner candidate bound", async () => {
    const database = feedbackQueryDatabase(
      Array.from({ length: 501 }, (_, index) => feedbackRow(index + 1)),
    );
    const repository = new PostgresDailyPlanRepository(
      database.database as unknown as DatabaseConnection["db"],
    );

    await expect(
      repository.listRoutineFeedbackForPlanning(feedbackWorkspace, feedbackDate),
    ).rejects.toMatchObject({ code: "planning.feedback_candidate_limit_exceeded" });
  });

  it("lets PostgreSQL allocate ingestion sequence when appending immutable feedback", async () => {
    const returning = vi.fn().mockResolvedValue([feedbackRow(42)]);
    const onConflictDoNothing = vi.fn().mockReturnValue({ returning });
    const values = vi.fn().mockReturnValue({ onConflictDoNothing });
    const database = { insert: vi.fn().mockReturnValue({ values }) };
    const repository = new PostgresDailyPlanRepository(
      database as unknown as DatabaseConnection["db"],
    );
    const feedback: RoutinePlanningFeedback = {
      id: feedbackEventId,
      ingestedSequence: 0,
      workspaceId: feedbackWorkspace,
      routineId: feedbackRoutine,
      kind: "not_today",
      effectiveOn: feedbackDate,
      effectiveThrough: feedbackDate,
      timeZone: "America/La_Paz",
      sourcePlanId: feedbackPlan,
      sourcePlanItemId: feedbackItem,
      idempotencyKey: "feedback-db-test",
      recordedAt: new Date("2026-07-13T14:00:00.000Z"),
    };

    await expect(repository.appendRoutineFeedback(feedback)).resolves.toMatchObject({
      id: feedbackEventId,
      ingestedSequence: 42,
    });
    const persisted = values.mock.calls[0]?.[0] as Readonly<Record<string, unknown>>;
    expect(persisted).not.toHaveProperty("ingestedSequence");
    expect(onConflictDoNothing).toHaveBeenCalledWith({
      target: [
        routinePlanningFeedbackEvents.workspaceId,
        routinePlanningFeedbackEvents.effectiveOn,
        routinePlanningFeedbackEvents.idempotencyKey,
      ],
    });
  });

  it("resolves a concurrent duplicate idempotency key to the equivalent stored event", async () => {
    const returning = vi.fn().mockResolvedValue([]);
    const onConflictDoNothing = vi.fn().mockReturnValue({ returning });
    const values = vi.fn().mockReturnValue({ onConflictDoNothing });
    const limit = vi.fn().mockResolvedValue([feedbackRow(42)]);
    const where = vi.fn().mockReturnValue({ limit });
    const from = vi.fn().mockReturnValue({ where });
    const database = {
      insert: vi.fn().mockReturnValue({ values }),
      select: vi.fn().mockReturnValue({ from }),
    };
    const repository = new PostgresDailyPlanRepository(
      database as unknown as DatabaseConnection["db"],
    );
    const feedback: RoutinePlanningFeedback = {
      id: routinePlanningFeedbackId("85000000-0000-4000-8000-000000000099"),
      ingestedSequence: 0,
      workspaceId: feedbackWorkspace,
      routineId: feedbackRoutine,
      kind: "not_today",
      effectiveOn: feedbackDate,
      effectiveThrough: feedbackDate,
      timeZone: "America/La_Paz",
      sourcePlanId: feedbackPlan,
      sourcePlanItemId: feedbackItem,
      idempotencyKey: "feedback-db-test",
      recordedAt: new Date("2026-07-13T14:05:00.000Z"),
    };

    await expect(repository.appendRoutineFeedback(feedback)).resolves.toMatchObject({
      id: feedbackEventId,
      ingestedSequence: 42,
    });
  });

  it("rejects reuse of a feedback idempotency key for different semantics", async () => {
    const returning = vi.fn().mockResolvedValue([]);
    const onConflictDoNothing = vi.fn().mockReturnValue({ returning });
    const values = vi.fn().mockReturnValue({ onConflictDoNothing });
    const limit = vi.fn().mockResolvedValue([feedbackRow(42)]);
    const where = vi.fn().mockReturnValue({ limit });
    const from = vi.fn().mockReturnValue({ where });
    const database = {
      insert: vi.fn().mockReturnValue({ values }),
      select: vi.fn().mockReturnValue({ from }),
    };
    const repository = new PostgresDailyPlanRepository(
      database as unknown as DatabaseConnection["db"],
    );
    const conflicting: RoutinePlanningFeedback = {
      id: routinePlanningFeedbackId("85000000-0000-4000-8000-000000000099"),
      ingestedSequence: 0,
      workspaceId: feedbackWorkspace,
      routineId: feedbackRoutine,
      kind: "not_this_week",
      effectiveOn: feedbackDate,
      effectiveThrough: localDate("2026-07-19"),
      timeZone: "America/La_Paz",
      sourcePlanId: feedbackPlan,
      sourcePlanItemId: feedbackItem,
      idempotencyKey: "feedback-db-test",
      recordedAt: new Date("2026-07-13T14:05:00.000Z"),
    };

    await expect(repository.appendRoutineFeedback(conflicting)).rejects.toMatchObject({
      code: "planning.idempotency_conflict",
    });
  });
});

const durationFeedbackWorkspace = workspaceId("91000000-0000-4000-8000-000000000001");
const durationFeedbackRoutine = routineId("92000000-0000-4000-8000-000000000002");
const durationFeedbackEventId = routineDurationInsightFeedbackId(
  "93000000-0000-4000-8000-000000000003",
);
const durationFeedbackInsightKey = "a".repeat(64);

function durationFeedbackRow(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    id: durationFeedbackEventId,
    ingestedSequence: 27,
    workspaceId: durationFeedbackWorkspace,
    routineId: durationFeedbackRoutine,
    insightKey: durationFeedbackInsightKey,
    kind: "dismissed",
    routineVersion: 3,
    observedMedianMinutes: 48,
    suggestedExpectedMinutes: 48,
    idempotencyKey: "duration-feedback-db-test",
    recordedAt: new Date("2026-07-13T15:00:00.000Z"),
    ...overrides,
  };
}

function durationFeedback(
  overrides: Partial<RoutineDurationInsightFeedback> = {},
): RoutineDurationInsightFeedback {
  return {
    id: durationFeedbackEventId,
    ingestedSequence: 0,
    workspaceId: durationFeedbackWorkspace,
    routineId: durationFeedbackRoutine,
    insightKey: durationFeedbackInsightKey,
    kind: "dismissed",
    routineVersion: 3,
    observedMedianMinutes: 48,
    suggestedExpectedMinutes: 48,
    idempotencyKey: "duration-feedback-db-test",
    recordedAt: new Date("2026-07-13T15:00:00.000Z"),
    ...overrides,
  };
}

function latestDurationFeedbackDatabase(rows: readonly Readonly<Record<string, unknown>>[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const orderBy = vi.fn().mockReturnValue({ limit });
  const where = vi.fn().mockReturnValue({ orderBy });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  return { database: { select }, limit, orderBy, select };
}

function durationFeedbackByIdempotencyDatabase(rows: readonly Readonly<Record<string, unknown>>[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  return { database: { select }, limit, select };
}

describe("PostgresRoutineDurationInsightFeedbackRepository", () => {
  it("loads the latest exact insight disposition with a deterministic bounded query", async () => {
    const database = latestDurationFeedbackDatabase([durationFeedbackRow()]);
    const repository = new PostgresRoutineDurationInsightFeedbackRepository(
      database.database as unknown as DatabaseConnection["db"],
    );

    await expect(
      repository.findLatestForKey(
        durationFeedbackWorkspace,
        durationFeedbackRoutine,
        durationFeedbackInsightKey,
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        id: durationFeedbackEventId,
        ingestedSequence: 27,
        routineId: durationFeedbackRoutine,
        insightKey: durationFeedbackInsightKey,
        kind: "dismissed",
      }),
    );
    expect(database.select).toHaveBeenCalledTimes(1);
    expect(database.orderBy).toHaveBeenCalledTimes(1);
    expect(database.limit).toHaveBeenCalledWith(1);
  });

  it("returns null for an unknown key and bounds workspace idempotency lookup", async () => {
    const latestDatabase = latestDurationFeedbackDatabase([]);
    const latestRepository = new PostgresRoutineDurationInsightFeedbackRepository(
      latestDatabase.database as unknown as DatabaseConnection["db"],
    );
    await expect(
      latestRepository.findLatestForKey(
        durationFeedbackWorkspace,
        durationFeedbackRoutine,
        durationFeedbackInsightKey,
      ),
    ).resolves.toBeNull();

    const idempotencyDatabase = durationFeedbackByIdempotencyDatabase([durationFeedbackRow()]);
    const idempotencyRepository = new PostgresRoutineDurationInsightFeedbackRepository(
      idempotencyDatabase.database as unknown as DatabaseConnection["db"],
    );
    await expect(
      idempotencyRepository.findByIdempotencyKey(
        durationFeedbackWorkspace,
        "duration-feedback-db-test",
      ),
    ).resolves.toMatchObject({ workspaceId: durationFeedbackWorkspace });
    expect(idempotencyDatabase.limit).toHaveBeenCalledWith(1);
  });

  it("lets PostgreSQL allocate ingestion sequence when appending feedback", async () => {
    const returning = vi.fn().mockResolvedValue([durationFeedbackRow()]);
    const onConflictDoNothing = vi.fn().mockReturnValue({ returning });
    const values = vi.fn().mockReturnValue({ onConflictDoNothing });
    const repository = new PostgresRoutineDurationInsightFeedbackRepository({
      insert: vi.fn().mockReturnValue({ values }),
    } as unknown as DatabaseConnection["db"]);

    await expect(repository.append(durationFeedback())).resolves.toMatchObject({
      id: durationFeedbackEventId,
      ingestedSequence: 27,
    });
    expect(values.mock.calls[0]?.[0]).not.toHaveProperty("ingestedSequence");
    expect(onConflictDoNothing).toHaveBeenCalledWith({
      target: [
        routineDurationInsightFeedbackEvents.workspaceId,
        routineDurationInsightFeedbackEvents.idempotencyKey,
      ],
    });
  });

  it("replays an equivalent concurrent append while ignoring generated fields", async () => {
    const returning = vi.fn().mockResolvedValue([]);
    const onConflictDoNothing = vi.fn().mockReturnValue({ returning });
    const values = vi.fn().mockReturnValue({ onConflictDoNothing });
    const limit = vi.fn().mockResolvedValue([durationFeedbackRow()]);
    const where = vi.fn().mockReturnValue({ limit });
    const from = vi.fn().mockReturnValue({ where });
    const repository = new PostgresRoutineDurationInsightFeedbackRepository({
      insert: vi.fn().mockReturnValue({ values }),
      select: vi.fn().mockReturnValue({ from }),
    } as unknown as DatabaseConnection["db"]);

    await expect(
      repository.append(
        durationFeedback({
          id: routineDurationInsightFeedbackId("93000000-0000-4000-8000-000000000099"),
          recordedAt: new Date("2026-07-13T15:05:00.000Z"),
        }),
      ),
    ).resolves.toMatchObject({ id: durationFeedbackEventId, ingestedSequence: 27 });
  });

  it.each([
    ["routine", { routineId: routineId("92000000-0000-4000-8000-000000000099") }],
    ["insight key", { insightKey: "b".repeat(64) }],
    ["kind", { kind: "reset" as const }],
    ["routine version", { routineVersion: 4 }],
    ["observed median", { observedMedianMinutes: 49 }],
    ["suggested expected", { suggestedExpectedMinutes: null }],
  ])("rejects idempotency reuse with different %s semantics", async (_label, overrides) => {
    const returning = vi.fn().mockResolvedValue([]);
    const onConflictDoNothing = vi.fn().mockReturnValue({ returning });
    const values = vi.fn().mockReturnValue({ onConflictDoNothing });
    const limit = vi.fn().mockResolvedValue([durationFeedbackRow()]);
    const where = vi.fn().mockReturnValue({ limit });
    const from = vi.fn().mockReturnValue({ where });
    const repository = new PostgresRoutineDurationInsightFeedbackRepository({
      insert: vi.fn().mockReturnValue({ values }),
      select: vi.fn().mockReturnValue({ from }),
    } as unknown as DatabaseConnection["db"]);

    await expect(repository.append(durationFeedback(overrides))).rejects.toMatchObject({
      code: "routine_duration_insight.idempotency_conflict",
    });
  });

  it("fails closed when a conflicting append cannot be loaded", async () => {
    const returning = vi.fn().mockResolvedValue([]);
    const onConflictDoNothing = vi.fn().mockReturnValue({ returning });
    const values = vi.fn().mockReturnValue({ onConflictDoNothing });
    const limit = vi.fn().mockResolvedValue([]);
    const where = vi.fn().mockReturnValue({ limit });
    const from = vi.fn().mockReturnValue({ where });
    const repository = new PostgresRoutineDurationInsightFeedbackRepository({
      insert: vi.fn().mockReturnValue({ values }),
      select: vi.fn().mockReturnValue({ from }),
    } as unknown as DatabaseConnection["db"]);

    await expect(repository.append(durationFeedback())).rejects.toMatchObject({
      code: "routine_duration_insight.feedback_write_conflict",
    });
  });
});

const planFitFeedbackWorkspace = workspaceId("94000000-0000-4000-8000-000000000001");
const planFitFeedbackId = dailyPlanFitInsightFeedbackId("95000000-0000-4000-8000-000000000002");
const planFitUsagePlanId = dailyPlanId("95000000-0000-4000-8000-000000000003");
const planFitFeedbackKey = "c".repeat(64);

function planFitFeedbackRow(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    id: planFitFeedbackId,
    ingestedSequence: 31,
    workspaceId: planFitFeedbackWorkspace,
    forDate: "2026-07-14",
    insightKey: planFitFeedbackKey,
    kind: "dismissed",
    planId: null,
    sampleCount: 5,
    typicalPlannedMinutes: 180,
    typicalCompletedMinutes: 90,
    typicalPlannedTaskCount: 4,
    typicalCompletedTaskCount: 2,
    suggestedTargetMinutes: 90,
    suggestedTargetTaskCount: 2,
    appliedTargetMinutes: null,
    appliedTargetTaskCount: null,
    idempotencyKey: "plan-fit-feedback-db-test",
    recordedAt: new Date("2026-07-14T15:00:00.000Z"),
    ...overrides,
  };
}

function planFitFeedback(
  overrides: Partial<DailyPlanFitInsightFeedback> = {},
): DailyPlanFitInsightFeedback {
  return {
    id: planFitFeedbackId,
    ingestedSequence: 0,
    workspaceId: planFitFeedbackWorkspace,
    forDate: localDate("2026-07-14"),
    insightKey: planFitFeedbackKey,
    kind: "dismissed",
    planId: null,
    sampleCount: 5,
    typicalPlannedMinutes: 180,
    typicalCompletedMinutes: 90,
    typicalPlannedTaskCount: 4,
    typicalCompletedTaskCount: 2,
    suggestedTargetMinutes: 90,
    suggestedTargetTaskCount: 2,
    appliedTargetMinutes: null,
    appliedTargetTaskCount: null,
    idempotencyKey: "plan-fit-feedback-db-test",
    recordedAt: new Date("2026-07-14T15:00:00.000Z"),
    ...overrides,
  };
}

describe("PostgresDailyPlanFitInsightFeedbackRepository", () => {
  it("uses one canonical workspace lock and a physical SSI guard across UUID casing", async () => {
    const execute = vi.fn().mockResolvedValue([]);
    const repository = new PostgresDailyPlanFitInsightFeedbackRepository({
      execute,
    } as unknown as DatabaseConnection["db"]);

    await repository.lockWorkspace(workspaceId(planFitFeedbackWorkspace.toUpperCase()));

    const statement = execute.mock.calls[0]?.[0] as { readonly queryChunks: readonly unknown[] };
    expect(statement.queryChunks[1]).toBe(`${planFitFeedbackWorkspace}:daily-plan-fit-feedback`);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("loads the latest exact key and bounded idempotency receipt", async () => {
    const latest = latestDurationFeedbackDatabase([planFitFeedbackRow()]);
    const latestRepository = new PostgresDailyPlanFitInsightFeedbackRepository(
      latest.database as unknown as DatabaseConnection["db"],
    );
    await expect(
      latestRepository.findLatestForKey(planFitFeedbackWorkspace, planFitFeedbackKey),
    ).resolves.toMatchObject({
      id: planFitFeedbackId,
      ingestedSequence: 31,
      forDate: "2026-07-14",
      kind: "dismissed",
    });
    expect(latest.limit).toHaveBeenCalledWith(1);

    const receipt = durationFeedbackByIdempotencyDatabase([planFitFeedbackRow()]);
    const receiptRepository = new PostgresDailyPlanFitInsightFeedbackRepository(
      receipt.database as unknown as DatabaseConnection["db"],
    );
    await expect(
      receiptRepository.findByIdempotencyKey(planFitFeedbackWorkspace, "plan-fit-feedback-db-test"),
    ).resolves.toMatchObject({ insightKey: planFitFeedbackKey });
    expect(receipt.limit).toHaveBeenCalledWith(1);
  });

  it("lists only bounded used events in reverse ingestion order", async () => {
    const limit = vi.fn().mockResolvedValue([
      planFitFeedbackRow({
        kind: "used",
        planId: planFitUsagePlanId,
        appliedTargetMinutes: 105,
        appliedTargetTaskCount: 3,
      }),
    ]);
    const orderBy = vi.fn().mockReturnValue({ limit });
    const where = vi.fn().mockReturnValue({ orderBy });
    const from = vi.fn().mockReturnValue({ where });
    const repository = new PostgresDailyPlanFitInsightFeedbackRepository({
      select: vi.fn().mockReturnValue({ from }),
    } as unknown as DatabaseConnection["db"]);

    await expect(repository.listUsed(planFitFeedbackWorkspace, 5)).resolves.toMatchObject([
      {
        kind: "used",
        planId: planFitUsagePlanId,
        appliedTargetMinutes: 105,
        appliedTargetTaskCount: 3,
      },
    ]);
    expect(limit).toHaveBeenCalledWith(5);
    await expect(repository.listUsed(planFitFeedbackWorkspace, 29)).rejects.toMatchObject({
      code: "daily_plan_fit_insight.usage_limit_invalid",
    });
  });

  it("lets PostgreSQL allocate the sequence and targets workspace idempotency", async () => {
    const returning = vi.fn().mockResolvedValue([planFitFeedbackRow()]);
    const onConflictDoNothing = vi.fn().mockReturnValue({ returning });
    const values = vi.fn().mockReturnValue({ onConflictDoNothing });
    const repository = new PostgresDailyPlanFitInsightFeedbackRepository({
      insert: vi.fn().mockReturnValue({ values }),
    } as unknown as DatabaseConnection["db"]);

    await expect(repository.append(planFitFeedback())).resolves.toMatchObject({
      id: planFitFeedbackId,
      ingestedSequence: 31,
    });
    expect(values.mock.calls[0]?.[0]).not.toHaveProperty("ingestedSequence");
    expect(onConflictDoNothing).toHaveBeenCalledWith({
      target: [
        dailyPlanFitInsightFeedbackEvents.workspaceId,
        dailyPlanFitInsightFeedbackEvents.idempotencyKey,
      ],
    });
  });

  it("replays equivalent feedback but rejects changed semantics", async () => {
    const databaseFor = (rows: readonly Readonly<Record<string, unknown>>[]) => {
      const returning = vi.fn().mockResolvedValue([]);
      const onConflictDoNothing = vi.fn().mockReturnValue({ returning });
      const values = vi.fn().mockReturnValue({ onConflictDoNothing });
      const limit = vi.fn().mockResolvedValue(rows);
      const where = vi.fn().mockReturnValue({ limit });
      const from = vi.fn().mockReturnValue({ where });
      return {
        insert: vi.fn().mockReturnValue({ values }),
        select: vi.fn().mockReturnValue({ from }),
      };
    };
    const replay = new PostgresDailyPlanFitInsightFeedbackRepository(
      databaseFor([planFitFeedbackRow()]) as unknown as DatabaseConnection["db"],
    );
    await expect(
      replay.append(
        planFitFeedback({
          id: dailyPlanFitInsightFeedbackId("95000000-0000-4000-8000-000000000099"),
          recordedAt: new Date("2026-07-14T15:05:00.000Z"),
        }),
      ),
    ).resolves.toMatchObject({ id: planFitFeedbackId, ingestedSequence: 31 });

    const conflict = new PostgresDailyPlanFitInsightFeedbackRepository(
      databaseFor([planFitFeedbackRow()]) as unknown as DatabaseConnection["db"],
    );
    await expect(
      conflict.append(planFitFeedback({ suggestedTargetMinutes: 120 })),
    ).rejects.toMatchObject({ code: "daily_plan_fit_insight.idempotency_conflict" });
  });
});
