import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  assertCompatiblePortableArchiveManifest,
  assertExpectedPortableArchiveId,
  assertExpectedPortableArchiveSha256,
  importPortableScheduleData,
  portablePromotionOperations,
  runJournaledPortablePromotion,
} from "./portable-import.js";
import type { PortableMigrationIdentity } from "./portable-export.js";
import {
  writePortableArchive,
  type PortableArchiveManifestInputV1,
  type PortableArchiveManifestV1,
} from "./portable-archive.js";
import { portableDataPolicyV1 } from "./portable-data.js";

const migration: PortableMigrationIdentity = {
  count: 2,
  latestTag: "0002_test",
  fingerprint: "a".repeat(64),
};

const manifest = {
  compatibility: {
    schemaSignal: "b".repeat(64),
    migrationCount: migration.count,
    latestMigrationTag: migration.latestTag,
    migrationFingerprint: migration.fingerprint,
  },
} as PortableArchiveManifestV1;

describe("portable import core", () => {
  it("requires exact schema and migration compatibility", () => {
    expect(() =>
      assertCompatiblePortableArchiveManifest(manifest, "b".repeat(64), migration),
    ).not.toThrow();
    expect(() =>
      assertCompatiblePortableArchiveManifest(manifest, "c".repeat(64), migration),
    ).toThrow(/incompatible Schedule schema/);
    expect(() =>
      assertCompatiblePortableArchiveManifest(manifest, "b".repeat(64), {
        ...migration,
        fingerprint: "c".repeat(64),
      }),
    ).toThrow(/incompatible Schedule schema/);
  });

  it("binds import to the archive identity confirmed by the desktop", () => {
    const archiveId = "01234567-89ab-4cde-8fab-0123456789ab";
    expect(() => assertExpectedPortableArchiveId(archiveId, archiveId)).not.toThrow();
    expect(() =>
      assertExpectedPortableArchiveId(archiveId, "11234567-89ab-4cde-8fab-0123456789ab"),
    ).toThrow(/identity changed/);
    const sha256 = "a".repeat(64);
    expect(() => assertExpectedPortableArchiveSha256(sha256, sha256)).not.toThrow();
    expect(() => assertExpectedPortableArchiveSha256(sha256, "b".repeat(64))).toThrow(
      /bytes changed/,
    );
  });

  it("rejects replaced bytes with the same archive ID before database mutation", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "schedule-import-binding-"));
    const payloadA = path.join(directory, "a.payload");
    const payloadB = path.join(directory, "b.payload");
    const archiveA = path.join(directory, "a.schedule");
    const archiveB = path.join(directory, "b.schedule");
    const archiveId = "01234567-89ab-4cde-8fab-0123456789ab";
    const contentSignal = `0:${"d".repeat(32)}`;
    const input: PortableArchiveManifestInputV1 = {
      archiveId,
      createdAt: "2026-07-21T00:00:00.000Z",
      producer: {
        applicationVersion: "0.1.0",
        platform: "win32",
        architecture: "x64",
        postgresVersion: "pg_dump (PostgreSQL) 17.10",
      },
      compatibility: {
        policyRevision: 1,
        schemaSignal: "b".repeat(64),
        migrationCount: migration.count,
        latestMigrationTag: migration.latestTag,
        migrationFingerprint: migration.fingerprint,
      },
      data: {
        contentSignals: Object.fromEntries(
          portableDataPolicyV1.includedTables.map((table) => [table, contentSignal]),
        ) as Record<(typeof portableDataPolicyV1.includedTables)[number], string>,
        sequenceSignals: Object.fromEntries(
          portableDataPolicyV1.sequences.map((sequence) => [sequence, "1:false"]),
        ) as Record<(typeof portableDataPolicyV1.sequences)[number], string>,
      },
    };
    try {
      await writeFile(payloadA, "first payload");
      await writeFile(payloadB, "replacement payload");
      await writePortableArchive(archiveA, payloadA, input);
      await writePortableArchive(archiveB, payloadB, input);
      const expectedArchiveSha256 = createHash("sha256")
        .update(await readFile(archiveA))
        .digest("hex");
      const assertActiveDatabase = vi.fn();
      await expect(
        importPortableScheduleData(
          {
            archivePath: archiveB,
            expectedArchiveId: archiveId,
            expectedArchiveSha256,
            activeDatabase: "schedule",
            stagingDatabase: `schedule_restore_${"a".repeat(32)}`,
            previousDatabase: `schedule_previous_${"b".repeat(32)}`,
          },
          {
            assertDatabaseName: () => undefined,
            assertActiveDatabase,
            schemaSignal: vi.fn(),
            migrationIdentity: vi.fn(),
            columnCatalog: vi.fn(),
            prepareStagingDatabase: vi.fn(),
            signalsMatch: vi.fn(),
            promoteStagingDatabase: vi.fn(),
            databaseIdentity: vi.fn(),
            cleanupStagingAfterFailure: vi.fn(),
          },
        ),
      ).rejects.toThrow(/bytes changed/);
      expect(assertActiveDatabase).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("journals every independently committed promotion operation before and after it", async () => {
    const events: string[] = [];
    await runJournaledPortablePromotion({
      writePhase: async (phase) => {
        events.push(`journal:${phase}`);
      },
      run: async (operation) => {
        events.push(`operation:${operation}`);
      },
    });
    expect(events).toEqual(
      portablePromotionOperations.flatMap((operation) => [
        `journal:before-${operation}`,
        `operation:${operation}`,
        `journal:after-${operation}`,
      ]),
    );
  });

  it.each(
    portablePromotionOperations.flatMap((operation) => [
      `before-${operation}`,
      `after-operation:${operation}`,
      `after-${operation}`,
    ]),
  )("has a deterministic crash seam at %s", async (faultPoint) => {
    const events: string[] = [];
    await expect(
      runJournaledPortablePromotion({
        writePhase: async (phase) => {
          events.push(`journal:${phase}`);
        },
        run: async (operation) => {
          events.push(`operation:${operation}`);
        },
        fault: (point) => {
          events.push(`fault:${point}`);
          if (point === faultPoint) throw new Error("injected crash");
        },
      }),
    ).rejects.toThrow("injected crash");
    expect(events.at(-1)).toBe(`fault:${faultPoint}`);
    const operation = faultPoint.replace(/^before-|^after-operation:|^after-/, "");
    expect(events.includes(`operation:${operation}`)).toBe(!faultPoint.startsWith("before-"));
  });
});
