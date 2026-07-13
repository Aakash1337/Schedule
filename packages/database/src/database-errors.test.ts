import { describe, expect, it } from "vitest";

import { DrizzleQueryError } from "drizzle-orm";

import { databaseErrorCode, databaseErrorConstraint } from "./database-errors.js";

describe("database adapter errors", () => {
  it("finds PostgreSQL metadata through nested adapter causes", () => {
    const postgresError = Object.assign(new Error("database failure"), {
      code: "40001",
      constraint_name: "activity_events_single_reversal_idx",
    });
    const wrapped = new Error("query failed", {
      cause: new Error("adapter failed", { cause: postgresError }),
    });

    expect(databaseErrorCode(wrapped)).toBe("40001");
    expect(databaseErrorConstraint(wrapped)).toBe("activity_events_single_reversal_idx");
  });

  it("stops safely when a malformed cause chain contains a cycle", () => {
    const cyclic: { cause?: unknown } = {};
    cyclic.cause = cyclic;

    expect(databaseErrorCode(cyclic)).toBeUndefined();
    expect(databaseErrorConstraint(cyclic)).toBeUndefined();
  });

  it("prefers a nested PostgreSQL SQLSTATE over generic adapter metadata", () => {
    const postgresError = Object.assign(new Error("serialization failure"), { code: "40001" });
    const wrapped = Object.assign(
      new DrizzleQueryError("insert into integration_requests ...", [], postgresError),
      { code: "QUERY_FAILED" },
    );

    expect(databaseErrorCode(wrapped)).toBe("40001");
  });
});
