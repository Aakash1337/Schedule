import { describe, expect, it } from "vitest";

import {
  assertExactStatus,
  assertNormalMigration,
  databaseUrlFor,
  disposableDatabaseName,
  parseMigrationLedgerVerifierArguments,
  runProcess,
} from "./verify-migration-ledger.js";

describe("migration-ledger verifier seams", () => {
  it("accepts no arguments and rejects all other invocations", () => {
    expect(() => parseMigrationLedgerVerifierArguments([])).not.toThrow();
    expect(() => parseMigrationLedgerVerifierArguments(["--status"])).toThrow(/Usage/u);
  });

  it("uses nonce-bound names and preserves URL credentials without exposing a target override", () => {
    const name = disposableDatabaseName("a".repeat(32));
    expect(name).toBe(`schedule_ledger_verify_${"a".repeat(32)}`);
    expect(
      databaseUrlFor("postgres://user:secret@example.test:5433/source?sslmode=require", name),
    ).toBe(`postgres://user:secret@example.test:5433/${name}?sslmode=require`);
    expect(() => disposableDatabaseName("DROP DATABASE")).toThrow(/identifier/u);
    expect(() => databaseUrlFor("https://example.test/database", name)).toThrow(/PostgreSQL/u);
    expect(() => databaseUrlFor("postgres://example.test/database", "production")).toThrow(
      /identifier/u,
    );
  });

  it("enforces the exact fixed process contracts", () => {
    expect(() =>
      assertExactStatus(
        { code: 0, stdout: "SCHEDULE_MIGRATION_STATUS_V1 exact\n", stderr: "" },
        "SCHEDULE_MIGRATION_STATUS_V1 exact\n",
      ),
    ).not.toThrow();
    expect(() =>
      assertExactStatus(
        { code: 0, stdout: "SCHEDULE_MIGRATION_STATUS_V1 prefix\n", stderr: "" },
        "SCHEDULE_MIGRATION_STATUS_V1 exact\n",
      ),
    ).toThrow(/canonical/u);
    expect(() =>
      assertNormalMigration(
        { code: 1, stdout: "", stderr: "Database migration compatibility check failed.\n" },
        1,
      ),
    ).not.toThrow();
    expect(() => assertNormalMigration({ code: 1, stdout: "secret", stderr: "" }, 1)).toThrow(
      /stdout/u,
    );
  });

  it("captures a bounded child process without PostgreSQL", async () => {
    await expect(
      runProcess(process.execPath, ["-e", "process.stdout.write('ok')"], process.env, 1_000),
    ).resolves.toEqual({ code: 0, stdout: "ok", stderr: "" });
    await expect(
      runProcess(process.execPath, ["-e", "setTimeout(() => {}, 1000)"], process.env, 20),
    ).rejects.toThrow(/deadline/u);
    await expect(
      runProcess(
        process.execPath,
        ["-e", "process.stdout.write('x'.repeat(5000))"],
        process.env,
        1_000,
      ),
    ).rejects.toThrow(/output limit/u);
  });
});
