import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  classifyMigrationLedger,
  loadMigrationManifest,
  type MigrationLedgerSnapshot,
  type MigrationManifest,
} from "./migration-ledger.js";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(currentDirectory, "../drizzle");
const primary = "1".repeat(64);
const legacy = "2".repeat(64);
const next = "3".repeat(64);
const manifest: MigrationManifest = {
  schemaVersion: 1,
  entries: [
    { tag: "0000_first", createdAt: 10, sha256: primary, compatibleSha256: [legacy] },
    { tag: "0001_second", createdAt: 20, sha256: next, compatibleSha256: [] },
  ],
};

function snapshot(
  rows: MigrationLedgerSnapshot["rows"],
  options: { exists?: boolean; hasUserRelations?: boolean } = {},
): MigrationLedgerSnapshot {
  return {
    exists: options.exists ?? true,
    hasUserRelations: options.hasUserRelations ?? rows.length > 0,
    rows,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function withMetadataFixture(
  mutate: (fixture: {
    manifest: Record<string, unknown>;
    journal: Record<string, unknown>;
  }) => void,
): Promise<void> {
  const folder = await mkdtemp(path.join(os.tmpdir(), "schedule-migration-ledger-"));
  const sql = ["select 1;\n", "select 2;\n"];
  const manifest = {
    schemaVersion: 1,
    entries: sql.map((source, index) => ({
      tag: `000${index}_migration`,
      createdAt: 10 + index,
      sha256: sha256(source),
      compatibleSha256: [] as string[],
    })),
  };
  const journal = {
    version: "7",
    dialect: "postgresql",
    entries: manifest.entries.map((entry, index) => ({
      idx: index,
      version: "7",
      when: entry.createdAt,
      tag: entry.tag,
      breakpoints: true,
    })),
  };
  mutate({ manifest, journal });
  await mkdir(path.join(folder, "meta"));
  await writeFile(path.join(folder, "meta", "_migration_manifest.json"), JSON.stringify(manifest));
  await writeFile(path.join(folder, "meta", "_journal.json"), JSON.stringify(journal));
  await Promise.all(
    manifest.entries.map((entry, index) =>
      writeFile(path.join(folder, `${String(entry.tag)}.sql`), sql[index] ?? ""),
    ),
  );
  try {
    await expect(loadMigrationManifest(folder)).rejects.toThrow();
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

describe("migration ledger compatibility", () => {
  it("loads the committed manifest and pins the historical 0004 exception", async () => {
    const loaded = await loadMigrationManifest(migrationsFolder);
    expect(loaded.entries).toHaveLength(42);
    expect(loaded.entries[4]).toEqual({
      tag: "0004_public_cerise",
      createdAt: 1_783_834_818_322,
      sha256: "4c15b8cd344fe8ad9fad3b5da537e1b4f2cdd925e510afd76ee2712ded6089d0",
      compatibleSha256: ["6ab84e9bb63326595061b24584e8fe58f3cf23ba1e6d6786f3777a7347a646f6"],
    });
  });

  it("recognizes exact current and exact historical-compatible histories", () => {
    const tail = { id: "2", createdAt: "20", hash: next };
    expect(
      classifyMigrationLedger(
        manifest,
        snapshot([{ id: "1", createdAt: "10", hash: primary }, tail]),
      ),
    ).toBe("exact");
    expect(
      classifyMigrationLedger(
        manifest,
        snapshot([{ id: "1", createdAt: "10", hash: legacy }, tail]),
      ),
    ).toBe("exact");
  });

  it("distinguishes clean prefixes and compatible-history prefixes", () => {
    expect(classifyMigrationLedger(manifest, snapshot([], { exists: false }))).toBe("prefix");
    expect(
      classifyMigrationLedger(manifest, snapshot([], { exists: true, hasUserRelations: false })),
    ).toBe("prefix");
    expect(
      classifyMigrationLedger(manifest, snapshot([{ id: "7", createdAt: "10", hash: legacy }])),
    ).toBe("prefix");
  });

  it("rejects missing ledgers over user relations and every overlapping divergence", () => {
    expect(
      classifyMigrationLedger(manifest, snapshot([], { exists: false, hasUserRelations: true })),
    ).toBe("divergent");
    expect(
      classifyMigrationLedger(manifest, snapshot([], { exists: true, hasUserRelations: true })),
    ).toBe("divergent");
    for (const row of [
      { id: "0", createdAt: "10", hash: primary },
      { id: "1", createdAt: "11", hash: primary },
      { id: "1", createdAt: "10", hash: "f".repeat(64) },
      { id: "1", createdAt: "10", hash: "not-a-hash" },
    ]) {
      expect(classifyMigrationLedger(manifest, snapshot([row]))).toBe("divergent");
    }
    expect(
      classifyMigrationLedger(
        manifest,
        snapshot([
          { id: "2", createdAt: "10", hash: primary },
          { id: "1", createdAt: "20", hash: next },
        ]),
      ),
    ).toBe("divergent");
  });

  it("recognizes an ahead ledger only after its expected prefix matches", () => {
    expect(
      classifyMigrationLedger(
        manifest,
        snapshot([
          { id: "1", createdAt: "10", hash: primary },
          { id: "2", createdAt: "20", hash: next },
          { id: "3", createdAt: "30", hash: "4".repeat(64) },
        ]),
      ),
    ).toBe("ahead");
  });

  it("requires the exact Drizzle journal header", async () => {
    await withMetadataFixture(({ journal }) => {
      journal.version = "6";
    });
    await withMetadataFixture(({ journal }) => {
      journal.dialect = "sqlite";
    });
    await withMetadataFixture(({ journal }) => {
      journal.extra = true;
    });
  });

  it("requires exact Drizzle journal entry keys, types, and version", async () => {
    await withMetadataFixture(({ journal }) => {
      const [entry] = journal.entries as Record<string, unknown>[];
      if (entry !== undefined) entry.idx = "0";
    });
    await withMetadataFixture(({ journal }) => {
      const [entry] = journal.entries as Record<string, unknown>[];
      if (entry !== undefined) entry.version = 7;
    });
    await withMetadataFixture(({ journal }) => {
      const [entry] = journal.entries as Record<string, unknown>[];
      if (entry !== undefined) entry.when = "10";
    });
    await withMetadataFixture(({ journal }) => {
      const [entry] = journal.entries as Record<string, unknown>[];
      if (entry !== undefined) entry.breakpoints = "true";
    });
    await withMetadataFixture(({ journal }) => {
      const [entry] = journal.entries as Record<string, unknown>[];
      if (entry !== undefined) entry.extra = true;
    });
  });

  it("rejects duplicate tags and accepted hashes across manifest entries", async () => {
    await withMetadataFixture(({ manifest, journal }) => {
      const entries = manifest.entries as { tag: string }[];
      const journalEntries = journal.entries as { tag: string }[];
      const first = entries[0];
      const second = entries[1];
      const secondJournal = journalEntries[1];
      if (first !== undefined && second !== undefined && secondJournal !== undefined) {
        second.tag = first.tag;
        secondJournal.tag = first.tag;
      }
    });
    await withMetadataFixture(({ manifest }) => {
      const entries = manifest.entries as {
        sha256: string;
        compatibleSha256: string[];
      }[];
      const first = entries[0];
      const second = entries[1];
      if (first !== undefined && second !== undefined) {
        second.compatibleSha256 = [first.sha256];
      }
    });
  });
});
