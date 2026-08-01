import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import type { Sql } from "postgres";

import {
  classifyMigrationLedger,
  inspectMigrationLedger,
  loadMigrationManifest,
  type MigrationLedgerSnapshot,
  type MigrationManifest,
} from "./migration-ledger.js";

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(currentDirectory, "../drizzle");
const primary = "1".repeat(64);
const legacy = "2".repeat(64);
const next = "3".repeat(64);
const crlf = "4".repeat(64);
const manifest: MigrationManifest = {
  schemaVersion: 1,
  entries: [
    {
      tag: "0000_first",
      createdAt: 10,
      sha256: primary,
      compatibleSha256: [legacy],
      crlfSha256: crlf,
    },
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
  it("loads the committed manifest and pins every historical compatibility hash", async () => {
    const loaded = await loadMigrationManifest(migrationsFolder);
    expect(loaded.entries).toHaveLength(46);
    expect(loaded.entries.at(-1)).toMatchObject({
      tag: "0045_mixed_guardsmen",
      createdAt: 1_785_198_344_931,
      sha256: "38de7dec6ea0c3a2eb3e685ec8b6ef295df340b3496f90efecc78a62729689b0",
      compatibleSha256: [],
    });
    expect(loaded.entries.at(-2)).toMatchObject({
      tag: "0044_orphan_dead_letter_cutoff",
      createdAt: 1_785_031_000_000,
      sha256: "42a150793f46b1d750ebe34b6589fe4877ed43820f3f56c4d8fe9d9ef95127d6",
      compatibleSha256: [],
    });
    expect(
      loaded.entries
        .filter((entry) => entry.compatibleSha256.length > 0)
        .map(({ crlfSha256: _crlfSha256, ...entry }) => entry),
    ).toEqual([
      {
        tag: "0004_public_cerise",
        createdAt: 1_783_834_818_322,
        sha256: "4c15b8cd344fe8ad9fad3b5da537e1b4f2cdd925e510afd76ee2712ded6089d0",
        compatibleSha256: [
          "6ab84e9bb63326595061b24584e8fe58f3cf23ba1e6d6786f3777a7347a646f6",
          "690349d1c4e55355661e7acb5ffc1a79b92d3503548d7ef289bbef9367047170",
        ],
      },
      {
        tag: "0024_fast_thundra",
        createdAt: 1_784_019_892_248,
        sha256: "04238c973db454296aed93ba5cb2e86ec6005ffea3611873fb1074364f353f19",
        compatibleSha256: [
          "26f049d219f3962d7298fd4acca87bc0b8ceeeb680bc7df1b65056eb572b38c5",
          "fe5ca493d9ed22bb35395029a713441db2792bcbf8ca0f6e4638a0c37a614d6d",
        ],
      },
      {
        tag: "0031_daffy_bloodstrike",
        createdAt: 1_784_070_583_475,
        sha256: "2d4efadaf90e08aa8279c03794cf6e0fc9905ac4a5d741ff49b625dc26b03cf8",
        compatibleSha256: [
          "34e68d0a3907c79ecbc3f97949c493800d688e84998657d440f155bfa089b8c1",
          "1ce33357c59ca26bd28f93e4ab902bc705279de9b05198f4cbf8e8b3cfc4ae88",
        ],
      },
      {
        tag: "0032_harsh_purifiers",
        createdAt: 1_784_079_639_528,
        sha256: "a66ebeec4f40bed507fb5bd456b7d8e6a26924f8c169f9b01af19795d7154079",
        compatibleSha256: [
          "4b9982a0deb4d00e68b7871ea4c84b2b28c6bdfcf257f8717ec0025c8de5e1e9",
          "849a6143a47c4e606c51cbb1ad583ebc44e5fd37e08a0472e78f433f86d9501a",
        ],
      },
      {
        tag: "0041_hosted_work_item_sync",
        createdAt: 1_784_349_976_452,
        sha256: "70129ffa219c0d9c9fbda5d107fe43b12f0af609b93070e5b769af62cec046ba",
        compatibleSha256: [
          "40064a598eab70d10c7a0090d29f2793417621d39029d7d7b799403d515abd9f",
          "5c4d70031606bfe9eeeb776d7c2085fc6759e9ebff1960674f22fef9efb82e3e",
          "b4c65f84c69c294c5f481b1c36f7906af625016a9fd1300cad6cf7f0a9b885ca",
          "f2890f9d40b00d52f373654ad31df9fdc99af9c0147264ac807fd0ee401148ce",
        ],
      },
    ]);
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
    expect(
      classifyMigrationLedger(manifest, snapshot([{ id: "1", createdAt: "10", hash: crlf }, tail])),
    ).toBe("exact");
  });

  it("loads CRLF migration files against the canonical LF manifest", async () => {
    const folder = await mkdtemp(path.join(os.tmpdir(), "schedule-migration-crlf-"));
    const source = "select 1;\r\n";
    const entry = {
      tag: "0000_migration",
      createdAt: 10,
      sha256: sha256(source.replaceAll("\r\n", "\n")),
      compatibleSha256: [],
    };
    try {
      await mkdir(path.join(folder, "meta"));
      await writeFile(
        path.join(folder, "meta", "_migration_manifest.json"),
        JSON.stringify({ schemaVersion: 1, entries: [entry] }),
      );
      await writeFile(
        path.join(folder, "meta", "_journal.json"),
        JSON.stringify({
          version: "7",
          dialect: "postgresql",
          entries: [
            { idx: 0, version: "7", when: entry.createdAt, tag: entry.tag, breakpoints: true },
          ],
        }),
      );
      await writeFile(path.join(folder, `${entry.tag}.sql`), source);
      const loaded = await loadMigrationManifest(folder);
      const crlfHash = sha256(source);
      expect(loaded.entries[0]?.crlfSha256).toBe(crlfHash);
      expect(
        classifyMigrationLedger(loaded, snapshot([{ id: "1", createdAt: "10", hash: crlfHash }])),
      ).toBe("exact");
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
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

  it("rejects every non-table ledger kind without reading attacker-controlled rows", async () => {
    for (const ledgerKind of ["v", "m", "f", "p", "S", "i"]) {
      let calls = 0;
      const sql = (async () => {
        calls += 1;
        if (calls !== 1) throw new Error("non-table ledger rows must not be read");
        return [{ ledgerKind, hasUserRelations: true }];
      }) as unknown as Sql;

      await expect(inspectMigrationLedger(sql, manifest)).resolves.toBe("divergent");
      expect(calls).toBe(1);
    }
  });

  it("reads rows only after proving the ledger is an ordinary table", async () => {
    let missingCalls = 0;
    const missing = (async () => {
      missingCalls += 1;
      return [{ ledgerKind: null, hasUserRelations: false }];
    }) as unknown as Sql;
    await expect(inspectMigrationLedger(missing, manifest)).resolves.toBe("prefix");
    expect(missingCalls).toBe(1);

    let tableCalls = 0;
    const table = (async () => {
      tableCalls += 1;
      return tableCalls === 1
        ? [{ ledgerKind: "r", hasUserRelations: true }]
        : [{ id: "1", createdAt: "10", hash: primary }];
    }) as unknown as Sql;
    await expect(inspectMigrationLedger(table, manifest)).resolves.toBe("prefix");
    expect(tableCalls).toBe(2);
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
