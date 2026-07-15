import { afterEach, describe, expect, it, vi } from "vitest";

import { createDatabase, withDatabaseOperationDeadline } from "./database.js";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("database operation deadlines", () => {
  it("returns a completed operation before its deadline", async () => {
    await expect(withDatabaseOperationDeadline(Promise.resolve("ready"), 100)).resolves.toBe(
      "ready",
    );
  });

  it("bounds a stalled operation with a fixed timeout failure", async () => {
    vi.useFakeTimers();
    const operation = new Promise<never>(() => undefined);

    const result = withDatabaseOperationDeadline(operation, 25);
    const rejection = expect(result).rejects.toThrow("Database operation exceeded its deadline.");
    await vi.advanceTimersByTimeAsync(25);

    await rejection;
  });

  it("rejects invalid statement deadlines before creating a pool", () => {
    expect(() => createDatabase("postgres://unused", 1, { statementTimeoutMs: 0 })).toThrow(
      /positive 32-bit integer/,
    );
  });
});
