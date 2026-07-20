import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { parsePortableCommand, readMigrationIdentity } from "./portable-database.js";

describe("portable database identity and safety", () => {
  it("uses a stable canonical migration fingerprint", async () => {
    const first = await readMigrationIdentity();
    const second = await readMigrationIdentity();
    expect(first).toEqual(second);
    expect(first.count).toBeGreaterThan(0);
    expect(first.latestTag).toMatch(/^\d{4}_/);
    expect(first.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("treats archive content only as typed data instead of restore SQL", async () => {
    const source = await readFile(new URL("./portable-database.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/\bpg_restore\b/);
    expect(source).toContain("pg_catalog.jsonb_array_elements($1::pg_catalog.jsonb)");
    expect(source).toContain("session_replication_role = replica");
    expect(source).toContain("SET LOCAL TIME ZONE 'UTC'");
  });
});

describe("portable migration CLI", () => {
  it("requires explicit replacement confirmation for import", () => {
    expect(parsePortableCommand(["export"])).toEqual({ kind: "export" });
    expect(parsePortableCommand(["export", "--output", "backup.schedule"])).toEqual({
      kind: "export",
      outputPath: "backup.schedule",
    });
    expect(
      parsePortableCommand(["import", "backup.schedule", "--confirm=replace-schedule"]),
    ).toEqual({ kind: "import", archivePath: "backup.schedule" });
    expect(() => parsePortableCommand(["import", "backup.schedule"])).toThrow(/Usage/);
  });
});
