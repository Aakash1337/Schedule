import { describe, expect, it, vi } from "vitest";

import type { DatabaseConnection } from "./database.js";
import { PostgresUnitOfWork } from "./repositories.js";

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
