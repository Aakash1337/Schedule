import { access, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  expectedScheduleTables,
  parseArchiveCatalog,
  repositoryRoot,
  withPreparedRestoreArchive,
} from "./backup-database.js";

const baselineTables = [
  "audit_events",
  "outbox_events",
  "recurrence_series",
  "schedule_blocks",
  "webhook_deliveries",
  "webhook_endpoint_secrets",
  "webhook_endpoints",
  "webhook_event_subscriptions",
  "work_items",
  "workspaces",
] as const;

const hostedSyncTables = [
  "hosted_work_item_sync_capability",
  "hosted_work_item_sync_changes",
  "hosted_work_item_sync_states",
] as const;
const hostedSyncFunctions = [
  "capture_hosted_work_item_sync_change",
  "protect_hosted_work_item_sync_capability",
  "protect_hosted_work_item_sync_change_mutation",
  "protect_hosted_work_item_sync_state_write",
  "initialize_hosted_work_item_sync_state",
  "protect_hosted_work_item_sync_state_delete",
] as const;
const hostedSyncTriggers = [
  ["work_items", "work_items_capture_hosted_sync_change"],
  ["hosted_work_item_sync_capability", "hosted_work_item_sync_capability_guard"],
  ["hosted_work_item_sync_changes", "hosted_work_item_sync_changes_append_only"],
  ["hosted_work_item_sync_states", "hosted_work_item_sync_states_write_guard"],
  ["workspaces", "workspaces_initialize_hosted_sync_state"],
  ["hosted_work_item_sync_states", "hosted_work_item_sync_states_delete_guard"],
] as const;

function supportedCatalogLines(): string[] {
  const lines = ["1; 0 0 SCHEMA - public schedule", "2; 0 0 SCHEMA - drizzle schedule"];
  for (const table of baselineTables) {
    lines.push(`10; 0 0 TABLE public ${table} schedule`);
    lines.push(`11; 0 0 TABLE DATA public ${table} schedule`);
  }
  lines.push("20; 0 0 TABLE drizzle __drizzle_migrations schedule");
  lines.push("21; 0 0 TABLE DATA drizzle __drizzle_migrations schedule");
  lines.push("22; 0 0 SEQUENCE drizzle __drizzle_migrations_id_seq schedule");
  lines.push("23; 0 0 SEQUENCE SET drizzle __drizzle_migrations_id_seq schedule");
  return lines;
}

function hostedSyncCatalogLines(): string[] {
  const lines = supportedCatalogLines();
  for (const table of hostedSyncTables) {
    lines.push(`30; 0 0 TABLE public ${table} schedule`);
    lines.push(`31; 0 0 TABLE DATA public ${table} schedule`);
  }
  for (const name of hostedSyncFunctions) {
    lines.push(`40; 0 0 FUNCTION public ${name}() schedule`);
  }
  for (const [table, name] of hostedSyncTriggers) {
    lines.push(`50; 0 0 TRIGGER public ${table} ${name} schedule`);
  }
  return lines;
}

async function inTemporaryDirectory<Result>(
  operation: (directory: string) => Promise<Result>,
): Promise<Result> {
  const directory = await mkdtemp(path.join(tmpdir(), "schedule-backup-unit-"));
  try {
    return await operation(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("restore archive snapshots", () => {
  it("uses immutable private bytes and removes the snapshot after success", async () => {
    await inTemporaryDirectory(async (directory) => {
      const sourcePath = path.join(directory, "source.dump");
      await writeFile(sourcePath, "original archive bytes", { mode: 0o600 });
      let snapshotPath = "";

      await expect(
        withPreparedRestoreArchive(sourcePath, async (archive) => {
          snapshotPath = archive.snapshotPath;
          expect(archive.sourcePath).toBe(path.resolve(sourcePath));
          expect(archive.sizeBytes).toBe(Buffer.byteLength("original archive bytes"));
          await writeFile(sourcePath, "replacement bytes");
          expect(await readFile(archive.snapshotPath, "utf8")).toBe("original archive bytes");
          if (process.platform !== "win32") {
            expect((await stat(path.dirname(archive.snapshotPath))).mode & 0o777).toBe(0o700);
            expect((await stat(archive.snapshotPath)).mode & 0o777).toBe(0o600);
          }
        }),
      ).resolves.toBeUndefined();

      await expect(access(snapshotPath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("removes the private snapshot when the prepared operation fails", async () => {
    await inTemporaryDirectory(async (directory) => {
      const sourcePath = path.join(directory, "source.dump");
      await writeFile(sourcePath, "archive bytes");
      const failure = new Error("simulated restore failure");
      let snapshotPath = "";

      await expect(
        withPreparedRestoreArchive(sourcePath, async (archive) => {
          snapshotPath = archive.snapshotPath;
          throw failure;
        }),
      ).rejects.toBe(failure);
      await expect(access(snapshotPath)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("rejects empty files, directories, and symbolic links before invoking restore work", async () => {
    await inTemporaryDirectory(async (directory) => {
      const emptyPath = path.join(directory, "empty.dump");
      const directoryPath = path.join(directory, "archive-directory");
      const linkPath = path.join(directory, "archive-link.dump");
      await writeFile(emptyPath, "");
      await mkdir(directoryPath);
      await symlink(directoryPath, linkPath, process.platform === "win32" ? "junction" : "dir");
      const operation = vi.fn(async () => undefined);

      await expect(withPreparedRestoreArchive(emptyPath, operation)).rejects.toThrow(/non-empty/);
      await expect(withPreparedRestoreArchive(directoryPath, operation)).rejects.toThrow(
        /regular file/,
      );
      await expect(withPreparedRestoreArchive(linkPath, operation)).rejects.toThrow(/non-symlink/);
      expect(operation).not.toHaveBeenCalled();
    });
  });

  it("enforces a caller size limit before copying an archive", async () => {
    await inTemporaryDirectory(async (directory) => {
      const sourcePath = path.join(directory, "source.dump");
      await writeFile(sourcePath, "12345");
      const operation = vi.fn(async () => undefined);

      await expect(
        withPreparedRestoreArchive(sourcePath, operation, { maximumSourceSizeBytes: 4 }),
      ).rejects.toThrow(/4-byte safety limit/);
      expect(operation).not.toHaveBeenCalled();

      await expect(
        withPreparedRestoreArchive(
          sourcePath,
          async ({ sizeBytes }) => {
            expect(sizeBytes).toBe(5);
          },
          { maximumSourceSizeBytes: 5 },
        ),
      ).resolves.toBeUndefined();
    });
  });

  it("runs format-specific validation on the opened source before snapshot work", async () => {
    await inTemporaryDirectory(async (directory) => {
      const sourcePath = path.join(directory, "source.dump");
      await writeFile(sourcePath, "invalid format");
      const validationFailure = new Error("unsupported archive frame");
      const operation = vi.fn(async () => undefined);
      const validateOpenedSource = vi.fn(async () => {
        throw validationFailure;
      });

      await expect(
        withPreparedRestoreArchive(sourcePath, operation, { validateOpenedSource }),
      ).rejects.toBe(validationFailure);
      expect(validateOpenedSource).toHaveBeenCalledOnce();
      expect(operation).not.toHaveBeenCalled();
    });
  });
});

describe("Schedule archive catalogs", () => {
  it("keeps the current database allowlist aligned with the latest migration snapshot", async () => {
    const journal = JSON.parse(
      await readFile(
        path.join(repositoryRoot, "packages", "database", "drizzle", "meta", "_journal.json"),
        "utf8",
      ),
    ) as { entries?: { idx?: unknown; tag?: unknown }[] };
    const latest = journal.entries?.at(-1);
    expect(latest).toBeDefined();
    expect(latest?.idx).toEqual(expect.any(Number));
    expect(latest?.tag).toEqual(expect.any(String));

    const migrationNumber = String(latest?.idx).padStart(4, "0");
    const snapshot = JSON.parse(
      await readFile(
        path.join(
          repositoryRoot,
          "packages",
          "database",
          "drizzle",
          "meta",
          `${migrationNumber}_snapshot.json`,
        ),
        "utf8",
      ),
    ) as { tables?: Record<string, { name?: unknown; schema?: unknown }> };
    const snapshotTables = Object.values(snapshot.tables ?? {})
      .filter((table) => table.schema === "" || table.schema === "public")
      .map((table) => table.name)
      .filter((name): name is string => typeof name === "string")
      .sort();

    expect([...expectedScheduleTables].sort()).toEqual(snapshotTables);
  });

  it("accepts a complete pre-hosted-sync catalog", () => {
    expect(parseArchiveCatalog(supportedCatalogLines().join("\n"))).toEqual({
      tables: [...baselineTables].sort(),
      sequences: [{ schema: "drizzle", name: "__drizzle_migrations_id_seq" }],
    });
  });

  it("accepts a hosted-sync catalog with all required functions and triggers", () => {
    expect(parseArchiveCatalog(hostedSyncCatalogLines().join("\n"))).toEqual({
      tables: [...baselineTables, ...hostedSyncTables].sort(),
      sequences: [{ schema: "drizzle", name: "__drizzle_migrations_id_seq" }],
    });
  });

  it("rejects a hosted-sync catalog with a missing function", () => {
    const lines = hostedSyncCatalogLines().filter(
      (line) => !line.includes("FUNCTION public initialize_hosted_work_item_sync_state()"),
    );

    expect(() => parseArchiveCatalog(lines.join("\n"))).toThrow(
      /missing hosted work-item sync functions: initialize_hosted_work_item_sync_state/,
    );
  });

  it("rejects a hosted-sync catalog with a missing trigger", () => {
    const lines = hostedSyncCatalogLines().filter(
      (line) => !line.includes("hosted_work_item_sync_changes_append_only"),
    );

    expect(() => parseArchiveCatalog(lines.join("\n"))).toThrow(
      /missing hosted work-item sync triggers: hosted_work_item_sync_changes\.hosted_work_item_sync_changes_append_only/,
    );
  });

  it.each([
    {
      name: "unexpected user schema",
      mutate: (lines: string[]) => [...lines, "30; 0 0 SCHEMA - injected schedule"],
      error: /unexpected user schemas/,
    },
    {
      name: "missing table data",
      mutate: (lines: string[]) =>
        lines.filter((line) => !line.includes("TABLE DATA public workspaces")),
      error: /definitions and data sections/,
    },
    {
      name: "missing migration ledger",
      mutate: (lines: string[]) => lines.filter((line) => !line.includes("__drizzle_migrations")),
      error: /missing the Drizzle migration ledger/,
    },
    {
      name: "unexpected Drizzle table",
      mutate: (lines: string[]) => [
        ...lines,
        "30; 0 0 TABLE drizzle injected schedule",
        "31; 0 0 TABLE DATA drizzle injected schedule",
      ],
      error: /unexpected Drizzle tables/,
    },
    {
      name: "missing baseline table",
      mutate: (lines: string[]) => lines.filter((line) => !line.includes("public workspaces")),
      error: /missing baseline tables: workspaces/,
    },
    {
      name: "missing sequence state",
      mutate: (lines: string[]) => lines.filter((line) => !line.includes("SEQUENCE SET")),
      error: /value-set sections are incomplete/,
    },
    {
      name: "missing baseline sequence",
      mutate: (lines: string[]) =>
        lines.filter((line) => !line.includes("__drizzle_migrations_id_seq")),
      error: /missing baseline Schedule sequences/,
    },
  ])("rejects $name", ({ mutate, error }) => {
    expect(() => parseArchiveCatalog(mutate(supportedCatalogLines()).join("\n"))).toThrow(error);
  });
});
