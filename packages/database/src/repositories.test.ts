import { describe, expect, it, vi } from "vitest";

import { workspaceId } from "@schedule/domain";

import type { DatabaseConnection } from "./database.js";
import {
  PostgresIntegrationRequestRepository,
  PostgresIntegrationUnitOfWork,
  PostgresUnitOfWork,
} from "./repositories.js";

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
