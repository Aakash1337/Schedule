import { describe, expect, it, vi } from "vitest";

import {
  activityEventId,
  dailyPlanId,
  localDate,
  planItemId,
  routineId,
  routinePlanningFeedbackId,
  workItemId,
  workspaceId,
  type RoutinePlanningFeedback,
  type WorkItem,
} from "@schedule/domain";

import type { DatabaseConnection } from "./database.js";
import {
  PostgresIntegrationRequestRepository,
  PostgresIntegrationUnitOfWork,
  PostgresUnitOfWork,
  PostgresActivityEventRepository,
  PostgresDailyPlanRepository,
} from "./repositories.js";
import { routinePlanningFeedbackEvents } from "./schema.js";

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
