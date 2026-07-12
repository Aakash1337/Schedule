import { describe, expect, it } from "vitest";

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
});
