import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { portableDataPolicyV1 } from "../packages/database/src/portable-data.js";
import {
  type PortableArchiveManifestInputV1,
  maximumPortableArchiveBytes,
  withPreparedPortableArchive,
  writePortableArchive,
} from "./portable-archive.js";

function signals(keys: readonly string[], signal: string): Record<string, string> {
  return Object.fromEntries(keys.map((key) => [key, signal]));
}

function manifestInput(platform = "win32"): PortableArchiveManifestInputV1 {
  return {
    archiveId: "7af562df-1c35-4b1f-8d56-3b9523cc9719",
    createdAt: "2026-07-20T12:34:56.789Z",
    producer: {
      applicationVersion: "0.1.0",
      platform,
      architecture: "x64",
      postgresVersion: "pg_dump (PostgreSQL) 17.10",
    },
    compatibility: {
      policyRevision: 1,
      schemaSignal: "a".repeat(64),
      migrationCount: 42,
      latestMigrationTag: "0041_hosted_work_item_sync",
      migrationFingerprint: "b".repeat(64),
    },
    data: {
      contentSignals: signals(portableDataPolicyV1.includedTables, `0:${"c".repeat(32)}`),
      sequenceSignals: signals(portableDataPolicyV1.sequences, "1:false"),
    },
  };
}

async function inTemporaryDirectory<Result>(
  operation: (directory: string) => Promise<Result>,
): Promise<Result> {
  const directory = await mkdtemp(path.join(tmpdir(), "schedule-portable-unit-"));
  try {
    return await operation(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("Schedule portable archive", () => {
  it.each(["win32", "linux"])(
    "round-trips a %s-produced archive without OS assumptions",
    async (sourcePlatform) => {
      await inTemporaryDirectory(async (directory) => {
        const payloadPath = path.join(directory, "portable-data.ndjson");
        const archivePath = path.join(directory, "schedule.schedule");
        const payload = Buffer.from('["schedule-portable-data",1]\n["end",1]\n', "utf8");
        await writeFile(payloadPath, payload);

        const written = await writePortableArchive(
          archivePath,
          payloadPath,
          manifestInput(sourcePlatform),
        );
        expect(written.manifest.producer.platform).toBe(sourcePlatform);
        await expect(
          withPreparedPortableArchive(archivePath, async ({ payloadPath: extracted, manifest }) => {
            expect(manifest.data.tables).toEqual(portableDataPolicyV1.includedTables);
            expect(manifest.data.encoding).toBe("postgres-text-ndjson-v1");
            expect(path.basename(extracted)).toBe("archive.dump");
            expect(await readFile(extracted)).toEqual(payload);
            return manifest.archiveId;
          }),
        ).resolves.toBe("7af562df-1c35-4b1f-8d56-3b9523cc9719");
      });
    },
  );

  it("round-trips a payload spanning multiple compaction chunks", async () => {
    await inTemporaryDirectory(async (directory) => {
      const payloadPath = path.join(directory, "portable-data.ndjson");
      const archivePath = path.join(directory, "schedule.schedule");
      const payload = Buffer.concat([
        Buffer.from('["schedule-portable-data",1]\n', "utf8"),
        Buffer.alloc(2 * 1024 * 1024 + 137, 0x61),
        Buffer.from('\n["end",1]\n', "utf8"),
      ]);
      await writeFile(payloadPath, payload);
      await writePortableArchive(archivePath, payloadPath, manifestInput());

      await withPreparedPortableArchive(archivePath, async ({ payloadPath: extracted }) => {
        expect(await readFile(extracted)).toEqual(payload);
      });
    });
  }, 15_000);

  it("rejects corruption before exposing database bytes", async () => {
    await inTemporaryDirectory(async (directory) => {
      const payloadPath = path.join(directory, "portable-data.ndjson");
      const archivePath = path.join(directory, "schedule.schedule");
      await writeFile(payloadPath, '["schedule-portable-data",1]\n["end",1]\n');
      await writePortableArchive(archivePath, payloadPath, manifestInput());
      const bytes = await readFile(archivePath);
      bytes[bytes.length - 33] = (bytes[bytes.length - 33] ?? 0) ^ 0xff;
      await writeFile(archivePath, bytes);

      let invoked = false;
      await expect(
        withPreparedPortableArchive(archivePath, () => {
          invoked = true;
          return Promise.resolve();
        }),
      ).rejects.toThrow(/checksum/);
      expect(invoked).toBe(false);
    });
  });

  it("rejects truncation, symlinks, and accidental overwrite", async () => {
    await inTemporaryDirectory(async (directory) => {
      const payloadPath = path.join(directory, "portable-data.ndjson");
      const archivePath = path.join(directory, "schedule.schedule");
      const linkPath = path.join(directory, "linked.schedule");
      const linkTarget = path.join(directory, "link-target");
      await writeFile(payloadPath, '["schedule-portable-data",1]\n["end",1]\n');
      await writePortableArchive(archivePath, payloadPath, manifestInput());
      await expect(
        writePortableArchive(archivePath, payloadPath, manifestInput()),
      ).rejects.toMatchObject({
        code: "EEXIST",
      });
      await writeFile(archivePath, (await readFile(archivePath)).subarray(0, 40));
      await expect(withPreparedPortableArchive(archivePath, async () => undefined)).rejects.toThrow(
        /length|ended/,
      );

      await rm(archivePath);
      await writePortableArchive(archivePath, payloadPath, manifestInput());
      await mkdir(linkTarget);
      await symlink(linkTarget, linkPath, process.platform === "win32" ? "junction" : "dir");
      await expect(withPreparedPortableArchive(linkPath, async () => undefined)).rejects.toThrow(
        /non-symlink/,
      );
    });
  });

  it("requests private POSIX permissions", async () => {
    if (process.platform === "win32") return;
    await inTemporaryDirectory(async (directory) => {
      const payloadPath = path.join(directory, "portable-data.ndjson");
      const archivePath = path.join(directory, "schedule.schedule");
      await writeFile(payloadPath, '["schedule-portable-data",1]\n["end",1]\n');
      await writePortableArchive(archivePath, payloadPath, manifestInput("linux"));
      await chmod(archivePath, 0o600);
      const { mode } = await import("node:fs/promises").then(({ stat }) => stat(archivePath));
      expect(mode & 0o777).toBe(0o600);
    });
  });

  it("rejects malformed and oversized sources before exposing snapshot bytes", async () => {
    await inTemporaryDirectory(async (directory) => {
      const malformedPath = path.join(directory, "malformed.schedule");
      const oversizedPath = path.join(directory, "oversized.schedule");
      const operation = async () => {
        throw new Error("operation must not run");
      };
      await writeFile(malformedPath, Buffer.alloc(64));
      await truncate(malformedPath, 64 * 1024 * 1024);
      await writeFile(oversizedPath, "x");
      await truncate(oversizedPath, maximumPortableArchiveBytes + 1);

      await expect(withPreparedPortableArchive(malformedPath, operation)).rejects.toThrow(
        /not a Schedule portable archive/,
      );
      await expect(withPreparedPortableArchive(oversizedPath, operation)).rejects.toThrow(
        /safety limit/,
      );
    });
  });
});
