import { mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import {
  portableCanonicalSessionStatements,
  portableExportScavengeAgeMs,
  runPortableExport,
  scavengePortableExportTemporaryDirectories,
} from "./portable-export.js";

const exportOwnerMarker = "schedule-portable-export-temporary\nversion=1\n";

async function createExportArtifact(
  root: string,
  suffix: string,
  options: { readonly marker?: string; readonly payload?: boolean; readonly stale?: boolean } = {},
): Promise<string> {
  const directory = path.join(root, `schedule-portable-export-${suffix}`);
  await mkdir(directory);
  if (options.marker !== undefined) {
    await writeFile(path.join(directory, ".schedule-portable-export-owner-v1"), options.marker);
  }
  if (options.payload) await writeFile(path.join(directory, "portable-data.ndjson"), "payload");
  if (options.stale) {
    const old = new Date(Date.now() - portableExportScavengeAgeMs - 1_000);
    for (const entry of await readdir(directory))
      await utimes(path.join(directory, entry), old, old);
    await utimes(directory, old, old);
  }
  return directory;
}

describe("portable export orchestration", () => {
  it("pins every canonical PostgreSQL serialization setting", () => {
    expect(portableCanonicalSessionStatements).toEqual([
      "SET LOCAL TIME ZONE 'UTC'",
      "SET LOCAL DateStyle = 'ISO, YMD'",
      "SET LOCAL IntervalStyle = 'postgres'",
      "SET LOCAL bytea_output = 'hex'",
      "SET LOCAL extra_float_digits = 3",
    ]);
  });
  it("runs verification before publication and cleanup after publication", async () => {
    const calls: string[] = [];
    await expect(
      runPortableExport({
        prepareSource: async () => {
          calls.push("source");
          return "source";
        },
        createVerification: async () => {
          calls.push("verification");
          return "verification";
        },
        writeArchive: async () => {
          calls.push("archive");
          return { path: "archive.schedule", sizeBytes: 1, manifest: {} };
        },
        cleanupVerification: async () => {
          calls.push("verification");
        },
        cleanupSource: async () => {
          calls.push("source");
        },
        removeArchive: async () => {
          calls.push("archive");
        },
      }),
    ).resolves.toMatchObject({ sizeBytes: 1 });
    expect(calls).toEqual(["source", "verification", "archive", "verification", "source"]);
  });
  it("cleans allocations when source preparation fails", async () => {
    let cleaned = false;
    await expect(
      runPortableExport({
        prepareSource: async () => {
          throw new Error("no source");
        },
        createVerification: async () => "never",
        writeArchive: async () => ({ path: "never", sizeBytes: 1, manifest: {} }),
        cleanupVerification: async () => undefined,
        cleanupSource: async () => undefined,
        removeArchive: async () => undefined,
        cleanup: async () => {
          cleaned = true;
        },
      }),
    ).rejects.toThrow("no source");
    expect(cleaned).toBe(true);
  });

  it("attempts global cleanup when verification allocation fails before returning", async () => {
    const calls: string[] = [];
    await expect(
      runPortableExport({
        prepareSource: async () => "source",
        createVerification: async () => {
          calls.push("create");
          throw new Error("migration secret");
        },
        writeArchive: async () => ({ path: "never", sizeBytes: 1, manifest: {} }),
        cleanupVerification: async () => {
          calls.push("returned verification");
        },
        cleanupSource: async () => {
          calls.push("source");
        },
        removeArchive: async () => {
          calls.push("archive");
        },
        cleanup: async () => {
          calls.push("global");
        },
      }),
    ).rejects.toThrow("migration secret");
    expect(calls).toEqual(["create", "source", "global"]);
  });

  it("scavenges only stale, flat, v1-owned export directories", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "schedule-export-scavenge-test-"));
    try {
      const stale = await createExportArtifact(root, "Ab1234", {
        marker: exportOwnerMarker,
        payload: true,
        stale: true,
      });
      const fresh = await createExportArtifact(root, "Ab1235", {
        marker: exportOwnerMarker,
        payload: true,
      });
      const unmarked = await createExportArtifact(root, "Ab1236", {
        payload: true,
        stale: true,
      });
      const malformed = await createExportArtifact(root, "Ab1237", {
        marker: "not-owned",
        payload: true,
        stale: true,
      });
      const unexpected = await createExportArtifact(root, "Ab1238", {
        marker: exportOwnerMarker,
        payload: true,
        stale: true,
      });
      await writeFile(path.join(unexpected, "surprise"), "preserve the directory");
      const old = new Date(Date.now() - portableExportScavengeAgeMs - 1_000);
      await utimes(path.join(unexpected, "surprise"), old, old);
      await utimes(unexpected, old, old);
      const linkTarget = path.join(root, "link-target");
      await mkdir(linkTarget);
      const linked = path.join(root, "schedule-portable-export-Ab1239");
      await symlink(linkTarget, linked, process.platform === "win32" ? "junction" : "dir");

      await expect(scavengePortableExportTemporaryDirectories(root)).resolves.toBe(1);
      await expect(readdir(stale)).rejects.toMatchObject({ code: "ENOENT" });
      for (const preserved of [fresh, unmarked, malformed, unexpected, linked]) {
        await expect(readdir(preserved)).resolves.toBeDefined();
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("bounds export-directory scavenging even when a larger count is requested", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "schedule-export-bound-test-"));
    try {
      await createExportArtifact(root, "Cd1234", {
        marker: exportOwnerMarker,
        stale: true,
      });
      await createExportArtifact(root, "Cd1235", {
        marker: exportOwnerMarker,
        stale: true,
      });
      await expect(scavengePortableExportTemporaryDirectories(root, Date.now(), 1)).resolves.toBe(
        1,
      );
      expect(
        (await readdir(root)).filter((entry) => entry.startsWith("schedule-portable")),
      ).toHaveLength(1);
      await expect(
        scavengePortableExportTemporaryDirectories(root, Date.now(), Number.POSITIVE_INFINITY),
      ).resolves.toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves stale candidates whose apparent owner marker is a symlink", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "schedule-export-symlink-marker-test-"));
    try {
      const markerTarget = path.join(root, "marker-target");
      await writeFile(markerTarget, exportOwnerMarker);
      const candidate = path.join(root, "schedule-portable-export-Ef1234");
      await mkdir(candidate);
      await symlink(
        markerTarget,
        path.join(candidate, ".schedule-portable-export-owner-v1"),
        process.platform === "win32" ? "file" : undefined,
      );
      const payload = path.join(candidate, "portable-data.ndjson");
      await writeFile(payload, "payload");
      const old = new Date(Date.now() - portableExportScavengeAgeMs - 1_000);
      await utimes(payload, old, old);
      await utimes(candidate, old, old);

      await expect(scavengePortableExportTemporaryDirectories(root)).resolves.toBe(0);
      await expect(readdir(candidate)).resolves.toEqual(
        expect.arrayContaining([".schedule-portable-export-owner-v1", "portable-data.ndjson"]),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
