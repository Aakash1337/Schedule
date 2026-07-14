import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

import {
  activityEventId,
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
  type WorkItem,
  type WorkItemDependency,
} from "@schedule/domain";

import type { DatabaseConnection } from "./database.js";
import {
  PostgresIntegrationRequestRepository,
  PostgresIntegrationUnitOfWork,
  PostgresRoutineDurationInsightFeedbackRepository,
  PostgresUnitOfWork,
  PostgresWorkItemDependencyRepository,
  PostgresActivityEventRepository,
  PostgresDailyPlanRepository,
} from "./repositories.js";
import { routineDurationInsightFeedbackEvents, routinePlanningFeedbackEvents } from "./schema.js";

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

    expect(insertValues).toHaveBeenCalledWith(expect.objectContaining({ dueOn: "2026-07-20" }));
    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({ dueOn: "2026-07-20" }));
  });

  it("maps nullable due dates from work item rows", async () => {
    const limit = vi
      .fn()
      .mockResolvedValueOnce([
        {
          id: "50000000-0000-4000-8000-000000000005",
          workspaceId: requestIdentity.workspaceId,
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
    ).resolves.toMatchObject({ dueOn: "2026-07-20" });
    await expect(
      unitOfWork.run(({ workItems }) => workItems.findById(requestIdentity.workspaceId, item)),
    ).resolves.toMatchObject({ dueOn: null });
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
    expect(compiled.sql).toContain("inner join candidate_work_items");
    expect(compiled.sql).toContain('inner join "work_items" as prerequisite_work_items');
    expect(compiled.sql).toContain('order by "rowGroup", "rowPosition"');
    expect(compiled.params).toEqual([dependencyWorkspace, 501, dependencyWorkspace, 2_001]);
  });

  it("fails closed when a one-statement graph projection is malformed or unordered", async () => {
    const validWorkItemPayload = {
      id: dependencyDependent,
      workspaceId: dependencyWorkspace,
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
      "notifications",
      "requests",
      "scheduleBlocks",
      "workItems",
      "workspaces",
    ]);
    expect(transaction).toHaveBeenCalledTimes(5);
    expect(transaction).toHaveBeenLastCalledWith(expect.any(Function), {
      isolationLevel: "serializable",
    });
    random.mockRestore();
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
