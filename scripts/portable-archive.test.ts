import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  truncate,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { portableDataPolicyV1 } from "../packages/database/src/portable-data.js";
import {
  type PortableArchiveManifestInputV1,
  finalizePortableArchivePublication,
  maximumPortableArchiveBytes,
  portableArchiveScavengeAgeMs,
  publishPortableArchiveNoReplace,
  scavengePortableArchivePartialPublication,
  scavengePortableArchiveTemporaryFiles,
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

const archiveTemporaryOwnerMarker = "schedule-portable-archive-temporary\nversion=1\n";
const publicationIntentionSuffix = ".schedule-portable-publication-v1.intent";

function publicationIntention(
  destination: string,
  expectedSize: number,
  publicationId: string,
): string {
  return `${JSON.stringify({
    format: "schedule-portable-publication",
    version: 1,
    destination,
    expectedSize,
    publicationId,
  })}\n`;
}

function incompletePublicationHeader(): Buffer {
  const header = Buffer.alloc(Buffer.byteLength("SCHEDULE-PORTABLE\0", "ascii") + 16);
  Buffer.from("SCHEDULE-PUBLISHING\0", "ascii").copy(header);
  header.writeUInt32BE(1, header.length - 4);
  return header;
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

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath);
    return true;
  } catch (error) {
    return !(
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    );
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
  }, 30_000);

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
      expect(
        (await readdir(directory)).filter((entry) =>
          entry.startsWith(`.${path.basename(archivePath)}.`),
        ),
      ).toEqual([]);
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

  it("falls back to a validated exclusive copy when hard links are unsupported", async () => {
    await inTemporaryDirectory(async (directory) => {
      const payloadPath = path.join(directory, "portable-data.ndjson");
      const sourceArchive = path.join(directory, "source.schedule");
      const copiedArchive = path.join(directory, "copied.schedule");
      const invalidCopy = path.join(directory, "invalid-copy.schedule");
      const occupiedArchive = path.join(directory, "occupied.schedule");
      await writeFile(payloadPath, '["schedule-portable-data",1]\n["end",1]\n');
      const source = await writePortableArchive(sourceArchive, payloadPath, manifestInput());
      const unsupportedLink = async (): Promise<void> => {
        throw Object.assign(new Error("unsupported"), { code: "ENOTSUP" });
      };

      await expect(
        publishPortableArchiveNoReplace(
          sourceArchive,
          copiedArchive,
          source.sizeBytes,
          unsupportedLink,
        ),
      ).resolves.toMatchObject({ method: "copied" });
      expect(await readFile(copiedArchive)).toEqual(await readFile(sourceArchive));

      await expect(
        publishPortableArchiveNoReplace(
          sourceArchive,
          invalidCopy,
          source.sizeBytes + 1,
          unsupportedLink,
        ),
      ).rejects.toThrow(/expected regular file|length/);
      await expect(readFile(invalidCopy)).rejects.toMatchObject({ code: "ENOENT" });

      await writeFile(occupiedArchive, "user-owned");
      await expect(
        publishPortableArchiveNoReplace(
          sourceArchive,
          occupiedArchive,
          source.sizeBytes,
          unsupportedLink,
        ),
      ).rejects.toMatchObject({ code: "EEXIST" });
      expect(await readFile(occupiedArchive, "utf8")).toBe("user-owned");

      const corruptSource = path.join(directory, "corrupt-source.schedule");
      const rejectedCopy = path.join(directory, "rejected-copy.schedule");
      await writeFile(corruptSource, Buffer.alloc(128));
      await expect(
        publishPortableArchiveNoReplace(corruptSource, rejectedCopy, 128, unsupportedLink),
      ).rejects.toThrow(/Schedule portable archive|frame|manifest/);
      await expect(readFile(rejectedCopy)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("reclaims a stale owned partial fallback before retry but preserves fresh and completed paths", async () => {
    await inTemporaryDirectory(async (directory) => {
      const payloadPath = path.join(directory, "portable-data.ndjson");
      const sourceArchive = path.join(directory, "source.schedule");
      const stalePartial = path.join(directory, "stale-partial.schedule");
      const staleTailPartial = path.join(directory, "stale-tail-partial.schedule");
      const freshPartial = path.join(directory, "fresh-partial.schedule");
      const completed = path.join(directory, "completed.schedule");
      await writeFile(payloadPath, '["schedule-portable-data",1]\n["end",1]\n');
      const source = await writePortableArchive(sourceArchive, payloadPath, manifestInput());
      const unsupportedLink = async (): Promise<void> => {
        throw Object.assign(new Error("unsupported"), { code: "ENOTSUP" });
      };
      await writeFile(stalePartial, incompletePublicationHeader());
      const old = new Date(Date.now() - portableArchiveScavengeAgeMs - 1_000);
      await utimes(stalePartial, old, old);

      await expect(
        publishPortableArchiveNoReplace(
          sourceArchive,
          stalePartial,
          source.sizeBytes,
          unsupportedLink,
        ),
      ).resolves.toMatchObject({ method: "copied" });
      expect(await readFile(stalePartial)).toEqual(await readFile(sourceArchive));

      await writeFile(
        staleTailPartial,
        Buffer.concat([
          await readFile(sourceArchive),
          Buffer.from("\nSCHEDULE-PORTABLE-PUBLICATION-INCOMPLETE\nversion=1\n", "ascii"),
        ]),
      );
      await utimes(staleTailPartial, old, old);
      await expect(
        publishPortableArchiveNoReplace(
          sourceArchive,
          staleTailPartial,
          source.sizeBytes,
          unsupportedLink,
        ),
      ).resolves.toMatchObject({ method: "copied" });
      expect(await readFile(staleTailPartial)).toEqual(await readFile(sourceArchive));

      await writeFile(freshPartial, incompletePublicationHeader());
      await expect(
        publishPortableArchiveNoReplace(
          sourceArchive,
          freshPartial,
          source.sizeBytes,
          unsupportedLink,
        ),
      ).rejects.toMatchObject({ code: "EEXIST" });
      expect(await readFile(freshPartial)).toEqual(incompletePublicationHeader());

      await writeFile(completed, await readFile(sourceArchive));
      await utimes(completed, old, old);
      await expect(
        publishPortableArchiveNoReplace(
          sourceArchive,
          completed,
          source.sizeBytes,
          unsupportedLink,
        ),
      ).rejects.toMatchObject({ code: "EEXIST" });
      expect(await readFile(completed)).toEqual(await readFile(sourceArchive));
    });
  });

  it("preserves an unmarked creation-gap file and clears only its stale intention", async () => {
    await inTemporaryDirectory(async (directory) => {
      const payload = path.join(directory, "payload.ndjson");
      const source = path.join(directory, "source.schedule");
      const destination = path.join(directory, "gap.schedule");
      const id = "00000000-0000-4000-8000-000000000111";
      const marker = path.join(directory, `.gap.schedule.${id}${publicationIntentionSuffix}`);
      await writeFile(payload, '["schedule-portable-data",1]\n["end",1]\n');
      const archive = await writePortableArchive(source, payload, manifestInput());
      const torn = incompletePublicationHeader().subarray(0, 7);
      await writeFile(marker, publicationIntention("gap.schedule", archive.sizeBytes, id));
      await writeFile(destination, torn);
      const old = new Date(Date.now() - portableArchiveScavengeAgeMs - 1_000);
      await utimes(marker, old, old);
      await utimes(destination, old, old);
      const unsupported = async (): Promise<void> => {
        throw Object.assign(new Error("unsupported"), { code: "ENOTSUP" });
      };

      await expect(
        publishPortableArchiveNoReplace(source, destination, archive.sizeBytes, unsupported),
      ).rejects.toMatchObject({ code: "EEXIST" });
      expect(await readFile(destination)).toEqual(torn);
      await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });

      const malformedDestination = path.join(directory, "malformed.schedule");
      const malformedMarker = path.join(
        directory,
        `.malformed.schedule.${id}${publicationIntentionSuffix}`,
      );
      await writeFile(malformedDestination, "user-owned");
      await writeFile(malformedMarker, "not an intention");
      await utimes(malformedDestination, old, old);
      await utimes(malformedMarker, old, old);
      await expect(
        publishPortableArchiveNoReplace(
          source,
          malformedDestination,
          archive.sizeBytes,
          unsupported,
        ),
      ).rejects.toMatchObject({ code: "EEXIST" });
      expect(await readFile(malformedDestination, "utf8")).toBe("user-owned");
      expect(await readFile(malformedMarker, "utf8")).toBe("not an intention");

      const freshDestination = path.join(directory, "fresh-gap.schedule");
      const freshMarker = path.join(
        directory,
        `.fresh-gap.schedule.${id}${publicationIntentionSuffix}`,
      );
      await writeFile(freshDestination, incompletePublicationHeader().subarray(0, 3));
      await writeFile(
        freshMarker,
        publicationIntention("fresh-gap.schedule", archive.sizeBytes, id),
      );
      await utimes(freshDestination, old, old);
      await expect(
        publishPortableArchiveNoReplace(source, freshDestination, archive.sizeBytes, unsupported),
      ).rejects.toMatchObject({ code: "EEXIST" });
      expect(await readFile(freshDestination)).toEqual(
        incompletePublicationHeader().subarray(0, 3),
      );
      await expect(readFile(freshMarker)).resolves.toBeDefined();
    });
  });

  it("clears a stale exact intention beside a valid archive without replacing the archive", async () => {
    await inTemporaryDirectory(async (directory) => {
      const payload = path.join(directory, "payload.ndjson");
      const destination = path.join(directory, "completed.schedule");
      const id = "00000000-0000-4000-8000-000000000112";
      const marker = path.join(directory, `.completed.schedule.${id}${publicationIntentionSuffix}`);
      await writeFile(payload, '["schedule-portable-data",1]\n["end",1]\n');
      const archive = await writePortableArchive(destination, payload, manifestInput());
      const expected = await readFile(destination);
      await writeFile(marker, publicationIntention("completed.schedule", archive.sizeBytes, id));
      const old = new Date(Date.now() - portableArchiveScavengeAgeMs - 1_000);
      await utimes(marker, old, old);
      await utimes(destination, old, old);

      await expect(scavengePortableArchivePartialPublication(destination)).resolves.toBe(false);
      expect(await readFile(destination)).toEqual(expected);
      await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("rejects a hard-link source substitution without deleting the substituted leaf", async () => {
    await inTemporaryDirectory(async (directory) => {
      const payload = path.join(directory, "payload.ndjson");
      const source = path.join(directory, "source.schedule");
      const original = path.join(directory, "original.schedule");
      const destination = path.join(directory, "destination.schedule");
      await writeFile(payload, '["schedule-portable-data",1]\n["end",1]\n');
      const archive = await writePortableArchive(source, payload, manifestInput());
      const replacement = Buffer.alloc(archive.sizeBytes, 0x5a);
      const substitute = async (existing: string, published: string): Promise<void> => {
        await rename(existing, original);
        await writeFile(existing, replacement);
        await link(existing, published);
      };

      await expect(
        publishPortableArchiveNoReplace(source, destination, archive.sizeBytes, substitute),
      ).rejects.toThrow(/does not match/);
      expect(await readFile(source)).toEqual(replacement);
      expect(await readFile(destination)).toEqual(replacement);
      await expect(withPreparedPortableArchive(original, async () => undefined)).resolves.toBe(
        undefined,
      );
    });
  });

  it("routes durable namespace syncs around fallback creation and commit", async () => {
    await inTemporaryDirectory(async (directory) => {
      const payload = path.join(directory, "payload.ndjson");
      const source = path.join(directory, "source.schedule");
      const destination = path.join(directory, "destination.schedule");
      await writeFile(payload, '["schedule-portable-data",1]\n["end",1]\n');
      const archive = await writePortableArchive(source, payload, manifestInput());
      const unsupported = async (): Promise<void> => {
        throw Object.assign(new Error("unsupported"), { code: "ENOTSUP" });
      };
      const states: Array<{ marker: boolean; destination: boolean }> = [];
      const sync = async (): Promise<void> => {
        const entries = await readdir(directory);
        states.push({
          marker: entries.some((entry) => entry.endsWith(publicationIntentionSuffix)),
          destination: entries.includes("destination.schedule"),
        });
      };

      await publishPortableArchiveNoReplace(
        source,
        destination,
        archive.sizeBytes,
        unsupported,
        sync,
      );
      expect(states).toEqual([
        { marker: true, destination: false },
        { marker: true, destination: true },
        { marker: false, destination: true },
      ]);
    });
  });

  it("does not remove a destination substituted after its durable intention", async () => {
    await inTemporaryDirectory(async (directory) => {
      const live = path.join(directory, "live");
      await mkdir(live);
      const payload = path.join(live, "payload.ndjson");
      const source = path.join(live, "source.schedule");
      const destination = path.join(live, "destination.schedule");
      await writeFile(payload, '["schedule-portable-data",1]\n["end",1]\n');
      const archive = await writePortableArchive(source, payload, manifestInput());
      const unsupported = async (): Promise<void> => {
        throw Object.assign(new Error("unsupported"), { code: "ENOTSUP" });
      };
      let swapped = false;
      const swapOnFirstSync = async (): Promise<void> => {
        if (swapped) return;
        swapped = true;
        await writeFile(destination, "replacement destination");
      };

      await expect(
        publishPortableArchiveNoReplace(
          source,
          destination,
          archive.sizeBytes,
          unsupported,
          swapOnFirstSync,
        ),
      ).rejects.toMatchObject({ code: "EEXIST" });
      await expect(readFile(destination, "utf8")).resolves.toBe("replacement destination");
      const entries = await readdir(live);
      expect(entries.some((entry) => entry.endsWith(publicationIntentionSuffix))).toBe(false);
    });
  });

  it("bounds sibling-temp scavenging and preserves fresh, unmarked, malformed, and linked entries", async () => {
    await inTemporaryDirectory(async (directory) => {
      const output = path.join(directory, "result.schedule");
      const old = new Date(Date.now() - portableArchiveScavengeAgeMs - 1_000);
      const artifact = async (
        id: string,
        marker: string | null,
        stale: boolean,
      ): Promise<{ temporary: string; owner: string }> => {
        const temporary = path.join(directory, `.result.schedule.${id}.tmp`);
        const owner = `${temporary}.schedule-portable-owner-v1`;
        await writeFile(temporary, "partial");
        if (marker !== null) await writeFile(owner, marker);
        if (stale) {
          await utimes(temporary, old, old);
          if (marker !== null) await utimes(owner, old, old);
        }
        return { temporary, owner };
      };
      const first = await artifact(
        "00000000-0000-4000-8000-000000000001",
        archiveTemporaryOwnerMarker,
        true,
      );
      const second = await artifact(
        "00000000-0000-4000-8000-000000000002",
        archiveTemporaryOwnerMarker,
        true,
      );

      await expect(scavengePortableArchiveTemporaryFiles(output, Date.now(), 1)).resolves.toBe(1);
      const remainingOwned = await Promise.all(
        [first, second].map(({ temporary }) => pathExists(temporary)),
      );
      expect(remainingOwned.filter((exists) => !exists)).toHaveLength(1);

      const fresh = await artifact(
        "00000000-0000-4000-8000-000000000003",
        archiveTemporaryOwnerMarker,
        false,
      );
      const unmarked = await artifact("00000000-0000-4000-8000-000000000004", null, true);
      const malformed = await artifact("00000000-0000-4000-8000-000000000005", "not-owned", true);
      const linked = await artifact(
        "00000000-0000-4000-8000-000000000006",
        archiveTemporaryOwnerMarker,
        true,
      );
      await rm(linked.temporary);
      const linkedTarget = path.join(directory, "linked-target");
      await mkdir(linkedTarget);
      await symlink(
        linkedTarget,
        linked.temporary,
        process.platform === "win32" ? "junction" : "dir",
      );

      for (const preserved of [fresh, unmarked, malformed]) {
        await expect(readFile(preserved.temporary)).resolves.toBeDefined();
      }
      await expect(readdir(linked.temporary)).resolves.toEqual([]);
      await expect(
        scavengePortableArchiveTemporaryFiles(output, Date.now(), Number.MAX_SAFE_INTEGER),
      ).resolves.toBeGreaterThanOrEqual(1);
    });
  });

  it("does not fall back for ordinary hard-link failures", async () => {
    await inTemporaryDirectory(async (directory) => {
      const payload = path.join(directory, "payload.ndjson");
      const source = path.join(directory, "source.schedule");
      const destination = path.join(directory, "destination.schedule");
      await writeFile(payload, '["schedule-portable-data",1]\n["end",1]\n');
      const archive = await writePortableArchive(source, payload, manifestInput());
      const deniedLink = async (): Promise<void> => {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      };
      await expect(
        publishPortableArchiveNoReplace(source, destination, archive.sizeBytes, deniedLink),
      ).rejects.toMatchObject({ code: "EACCES" });
      await expect(readFile(destination)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("removes both publication names after a post-link temporary cleanup failure", async () => {
    await inTemporaryDirectory(async (directory) => {
      const temporary = path.join(directory, "temporary.schedule");
      const published = path.join(directory, "published.schedule");
      await writeFile(temporary, "archive");
      await writeFile(published, "archive");
      const parent = await lstat(directory, { bigint: true });
      const state = {
        method: "copied" as const,
        parentPath: directory,
        parent,
        temporaryParentPath: directory,
        temporaryParent: parent,
        temporary: await lstat(temporary, { bigint: true }),
        destination: await lstat(published, { bigint: true }),
      };
      const calls: string[] = [];
      let temporaryAttempts = 0;
      const remove = async (target: string): Promise<void> => {
        calls.push(target);
        if (target === temporary && temporaryAttempts++ === 0) {
          throw new Error("temporary unlink failed");
        }
        await rm(target);
      };
      await expect(
        finalizePortableArchivePublication(
          temporary,
          published,
          true,
          state,
          remove,
          async () => undefined,
        ),
      ).rejects.toThrow(/cleanup failed/);
      expect(calls).toEqual([temporary, published, temporary]);
    });
  });

  it("preserves both names when the published destination is substituted before finalize", async () => {
    await inTemporaryDirectory(async (directory) => {
      const payload = path.join(directory, "payload.ndjson");
      const temporary = path.join(directory, "temporary.schedule");
      const published = path.join(directory, "published.schedule");
      const moved = path.join(directory, "moved-published.schedule");
      await writeFile(payload, '["schedule-portable-data",1]\n["end",1]\n');
      const archive = await writePortableArchive(temporary, payload, manifestInput());
      const state = await publishPortableArchiveNoReplace(temporary, published, archive.sizeBytes);
      await rename(published, moved);
      await writeFile(published, "user replacement");

      await expect(
        finalizePortableArchivePublication(temporary, published, true, state),
      ).rejects.toThrow(/destination changed/);
      await expect(readFile(temporary)).resolves.toEqual(await readFile(moved));
      await expect(readFile(published, "utf8")).resolves.toBe("user replacement");
    });
  });

  it("preserves replacement paths when the publication parent is swapped before finalize", async () => {
    await inTemporaryDirectory(async (directory) => {
      const live = path.join(directory, "live");
      const moved = path.join(directory, "moved");
      await mkdir(live);
      const payload = path.join(live, "payload.ndjson");
      const temporary = path.join(live, "temporary.schedule");
      const published = path.join(live, "published.schedule");
      await writeFile(payload, '["schedule-portable-data",1]\n["end",1]\n');
      const archive = await writePortableArchive(temporary, payload, manifestInput());
      const state = await publishPortableArchiveNoReplace(temporary, published, archive.sizeBytes);
      await rename(live, moved);
      await mkdir(live);
      await writeFile(temporary, "replacement temporary");
      await writeFile(published, "replacement published");

      await expect(
        finalizePortableArchivePublication(temporary, published, true, state),
      ).rejects.toThrow(/destination changed/);
      await expect(readFile(temporary, "utf8")).resolves.toBe("replacement temporary");
      await expect(readFile(published, "utf8")).resolves.toBe("replacement published");
      await expect(readFile(path.join(moved, "temporary.schedule"))).resolves.toBeDefined();
      await expect(readFile(path.join(moved, "published.schedule"))).resolves.toBeDefined();
    });
  });

  it("requests private POSIX permissions", async () => {
    if (process.platform === "win32") return;
    await inTemporaryDirectory(async (directory) => {
      const payloadPath = path.join(directory, "portable-data.ndjson");
      const archivePath = path.join(directory, "schedule.schedule");
      await writeFile(payloadPath, '["schedule-portable-data",1]\n["end",1]\n');
      await writePortableArchive(archivePath, payloadPath, manifestInput("linux"));
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
