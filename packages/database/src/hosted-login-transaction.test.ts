import { describe, expect, it, vi } from "vitest";

import type { DatabaseConnection } from "./database.js";
import { PostgresHostedLoginTransactionUnitOfWork } from "./hosted-login-transaction.js";

describe("PostgresHostedLoginTransactionUnitOfWork", () => {
  it("keeps pre-authentication repositories in a separate transaction context", async () => {
    const transaction = vi.fn(
      async (operation: (database: unknown) => Promise<unknown>, options: unknown) => ({
        result: await operation({}),
        options,
      }),
    );
    const connection = { db: { transaction } } as unknown as DatabaseConnection;

    const result = await new PostgresHostedLoginTransactionUnitOfWork(connection).run(
      async (context) => Object.keys(context).sort(),
      { isolationLevel: "read_committed" },
    );

    expect(result).toEqual({
      result: ["time", "transactions"],
      options: { isolationLevel: "read committed" },
    });
  });

  it("retries serialization failures without retrying unrelated failures", async () => {
    const serializationFailure = Object.assign(new Error("serialization failure"), {
      code: "40001",
    });
    const transaction = vi
      .fn()
      .mockRejectedValueOnce(new Error("query failed", { cause: serializationFailure }))
      .mockImplementationOnce(async (operation: (database: unknown) => Promise<unknown>) =>
        operation({}),
      );
    const connection = { db: { transaction } } as unknown as DatabaseConnection;

    await expect(
      new PostgresHostedLoginTransactionUnitOfWork(connection).run(async () => "committed"),
    ).resolves.toBe("committed");
    expect(transaction).toHaveBeenCalledTimes(2);

    const constraintFailure = Object.assign(new Error("constraint failure"), { code: "23505" });
    const wrapped = new Error("query failed", { cause: constraintFailure });
    transaction.mockReset().mockRejectedValue(wrapped);
    await expect(
      new PostgresHostedLoginTransactionUnitOfWork(connection).run(async () => "unused"),
    ).rejects.toBe(wrapped);
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});
