import { createHash } from "node:crypto";
import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireRuntimeSources,
  parseRuntimeSourceLock,
  type FetchImplementation,
  type RuntimeSourceLock,
} from "./acquire-desktop-runtime-sources.js";

const temporaryDirectories: string[] = [];
const repositoryRoot = path.resolve(import.meta.dirname, "..");
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function rawLock(): Promise<{ artifacts: Array<Record<string, unknown>> }> {
  return JSON.parse(
    await readFile(path.join(repositoryRoot, "runtime-sources.lock.json"), "utf8"),
  ) as { artifacts: Array<Record<string, unknown>> };
}
async function fixtureLock(payload: Uint8Array): Promise<RuntimeSourceLock> {
  const raw = await rawLock();
  const hash = createHash("sha256").update(payload).digest("hex");
  for (const artifact of raw.artifacts) artifact.sha256 = hash;
  return parseRuntimeSourceLock(raw);
}
async function output(): Promise<string> {
  const value = await mkdtemp(path.join(os.tmpdir(), "schedule-runtime-sources-"));
  temporaryDirectories.push(value);
  return value;
}
function response(payload: Uint8Array, status = 200, headers?: Record<string, string>): Response {
  const init: ResponseInit = { status };
  if (headers !== undefined) init.headers = headers;
  return new Response(Buffer.from(payload), init);
}
function streamResponse(status: number, location?: string, onCancel?: () => void): Response {
  const source: UnderlyingSource<Uint8Array> = {};
  if (onCancel !== undefined) source.cancel = onCancel;
  const init: ResponseInit = { status };
  if (location !== undefined) init.headers = { location };
  return new Response(new ReadableStream(source), init);
}
async function settle(promise: Promise<unknown>): Promise<unknown> {
  try {
    return await promise;
  } catch (error) {
    return error;
  }
}

describe("desktop runtime source acquisition", () => {
  it("rejects malformed schema, IDs, archive fields, and fixed upstream specifications", async () => {
    const cases: Array<
      (lock: Record<string, unknown> & { artifacts: Array<Record<string, unknown>> }) => void
    > = [
      (lock) => {
        delete lock.schemaVersion;
      },
      (lock) => {
        lock.untrusted = true;
      },
      (lock) => {
        delete (lock.artifacts[0]!.target as Record<string, unknown>).arch;
      },
      (lock) => {
        (lock.artifacts[0]!.target as Record<string, unknown>).extra = true;
      },
      (lock) => {
        lock.artifacts[0]!.target = { os: "darwin", arch: "x64" };
      },
      (lock) => {
        lock.artifacts[0]!.target = { os: "windows", arch: "arm64" };
      },
      (lock) => {
        lock.artifacts[0]!.version = 24;
      },
      (lock) => {
        [lock.artifacts[0]!.id, lock.artifacts[1]!.id] = [
          lock.artifacts[1]!.id,
          lock.artifacts[0]!.id,
        ];
      },
      (lock) => {
        lock.artifacts[1]!.id = "missing-required-id";
      },
      (lock) => {
        lock.artifacts[0]!.sha256 = "not-a-hash";
      },
      (lock) => {
        lock.artifacts[0]!.maxBytes = 0;
      },
      (lock) => {
        lock.artifacts[0]!.extractedRoot = "../escape";
      },
      (lock) => {
        lock.artifacts[0]!.url =
          "https://user:pass@nodejs.org/dist/v24.18.0/node-v24.18.0-win-x64.zip";
      },
      (lock) => {
        lock.artifacts[0]!.url =
          "https://nodejs.org/dist/v24.18.0/node-v24.18.0-win-x64.zip?untrusted=1";
      },
      (lock) => {
        lock.artifacts[0]!.url =
          "https://nodejs.org/dist/v24.18.0/node-v24.18.0-win-x64.zip#fragment";
      },
      (lock) => {
        lock.artifacts[0]!.url = "https://nodejs.org/download/v24.18.0/node-v24.18.0-win-x64.zip";
      },
      (lock) => {
        lock.artifacts[0]!.extractedRoot = "node-v24.18.0-win-x86";
      },
      (lock) => {
        lock.artifacts[1]!.url =
          "https://ftp.postgresql.org/pub/source/v17.10/postgresql-17.10.tar.xz";
      },
      (lock) => {
        lock.artifacts[1]!.extractedRoot = "postgresql-17.9";
      },
      (lock) => {
        lock.artifacts[1]!.url =
          "https://ftp.postgresql.org/pub/source/v17.10/not-postgresql-17.10.tar.gz";
      },
      (lock) => {
        lock.artifacts.pop();
      },
    ];
    for (const mutate of cases) {
      const lock = (await rawLock()) as Record<string, unknown> & {
        artifacts: Array<Record<string, unknown>>;
      };
      mutate(lock);
      expect(() => parseRuntimeSourceLock(lock)).toThrow();
    }
  });

  it("rejects a publish-time collision after verification reaches the link boundary", async () => {
    const payload = new TextEncoder().encode("collision fixture");
    const lock = await fixtureLock(payload);
    const directory = await output();
    const finalPath = path.join(directory, "windows-x64", "node-v24.18.0-win-x64.zip");
    await expect(
      acquireRuntimeSources({
        lock,
        outputDirectory: directory,
        fetchImplementation: async () => response(payload),
        afterVerification: async () => {
          await writeFile(finalPath, "late collision");
        },
      }),
    ).rejects.toThrow(/EEXIST|already exists/u);
    await expect(readFile(finalPath, "utf8")).resolves.toBe("late collision");
  });

  it("streams matching local responses into both target layouts and returns their final paths", async () => {
    const payload = new TextEncoder().encode("verified fixture archive");
    const lock = await fixtureLock(payload);
    const directory = await output();
    const archives = await acquireRuntimeSources({
      lock,
      outputDirectory: directory,
      fetchImplementation: async () =>
        response(payload, 200, { "content-length": String(payload.byteLength) }),
    });
    expect(archives).toHaveLength(4);
    expect(archives.filter((value) => value.includes("windows-x64")).length).toBe(2);
    expect(archives.filter((value) => value.includes("linux-x64")).length).toBe(2);
    await expect(readFile(archives[0]!)).resolves.toEqual(Buffer.from(payload));
  });

  it("allows only same-origin approved relative redirects and cancels redirect bodies", async () => {
    const payload = new TextEncoder().encode("redirect fixture");
    const lock = await fixtureLock(payload);
    const directory = await output();
    let calls = 0;
    let cancelled = 0;
    const fetchImplementation: FetchImplementation = async () => {
      calls += 1;
      return calls === 1
        ? streamResponse(302, "node-v24.18.0-win-x64.zip", () => {
            cancelled += 1;
          })
        : response(payload);
    };
    await acquireRuntimeSources({ lock, outputDirectory: directory, fetchImplementation });
    expect(calls).toBe(5);
    expect(cancelled).toBe(1);
  });

  it("rejects missing, cross-origin, and over-bound redirects", async () => {
    const payload = new TextEncoder().encode("redirect failure");
    const lock = await fixtureLock(payload);
    const scenarios: Array<FetchImplementation> = [
      async () => streamResponse(302),
      async () => streamResponse(302, "https://example.invalid/archive"),
      async () => streamResponse(302, "node-v24.18.0-win-x64.zip"),
    ];
    for (const fetchImplementation of scenarios)
      await expect(
        acquireRuntimeSources({ lock, outputDirectory: await output(), fetchImplementation }),
      ).rejects.toThrow("redirect");
  });

  it("rejects malformed, oversized, and truncated content lengths before publishing", async () => {
    const payload = new TextEncoder().encode("small archive");
    const lock = await fixtureLock(payload);
    const cases = [
      { headers: { "content-length": "not-a-number" }, error: "invalid" },
      { headers: { "content-length": "999999999" }, error: "oversized" },
      { headers: { "content-length": String(payload.byteLength + 1) }, error: "truncated" },
    ];
    for (const current of cases)
      await expect(
        acquireRuntimeSources({
          lock,
          outputDirectory: await output(),
          fetchImplementation: async () => response(payload, 200, current.headers),
        }),
      ).rejects.toThrow(current.error);
  });

  it("cleans failed partials, scavenges crash orphans, and permits a clean retry", async () => {
    const payload = new TextEncoder().encode("retry fixture");
    const lock = await fixtureLock(payload);
    const directory = await output();
    await expect(
      acquireRuntimeSources({
        lock,
        outputDirectory: directory,
        fetchImplementation: async () => response(new TextEncoder().encode("wrong")),
      }),
    ).rejects.toThrow("SHA-256");
    expect(
      (await readdir(path.join(directory, "windows-x64"))).filter((name) =>
        name.endsWith(".partial"),
      ),
    ).toEqual([]);
    const orphan = path.join(
      directory,
      "windows-x64",
      ".node-windows-x64.00000000-0000-0000-0000-000000000000.partial",
    );
    await writeFile(orphan, "orphan");
    await acquireRuntimeSources({
      lock,
      outputDirectory: directory,
      fetchImplementation: async () => response(payload),
    });
    await expect(readFile(orphan)).rejects.toThrow();
  });

  it("rolls back earlier archives when a later artifact fails so the batch can retry", async () => {
    const payload = new TextEncoder().encode("batch retry fixture");
    const lock = await fixtureLock(payload);
    const directory = await output();
    let calls = 0;
    await expect(
      acquireRuntimeSources({
        lock,
        outputDirectory: directory,
        fetchImplementation: async () => {
          calls += 1;
          return response(calls === 2 ? new TextEncoder().encode("wrong") : payload);
        },
      }),
    ).rejects.toThrow("SHA-256");
    await expect(
      lstat(path.join(directory, "windows-x64", "node-v24.18.0-win-x64.zip")),
    ).rejects.toThrow();

    const archives = await acquireRuntimeSources({
      lock,
      outputDirectory: directory,
      fetchImplementation: async () => response(payload),
    });
    expect(archives).toHaveLength(4);
  });

  it("handles a verified temporary pathname swap without publishing malicious bytes", async () => {
    const payload = new TextEncoder().encode("swap fixture");
    const lock = await fixtureLock(payload);
    const directory = await output();
    const finalPath = path.join(directory, "windows-x64", "node-v24.18.0-win-x64.zip");
    let blockedByOpenHandle = false;
    const result = acquireRuntimeSources({
      lock,
      outputDirectory: directory,
      fetchImplementation: async () => response(payload),
      afterVerification: async (temporary) => {
        if (process.platform === "win32") {
          try {
            await rm(temporary, { maxRetries: 0, retryDelay: 0 });
            await writeFile(temporary, "malicious");
          } catch {
            blockedByOpenHandle = true;
          }
        } else {
          await rm(temporary);
          await writeFile(temporary, "malicious");
        }
      },
    });
    const outcome = await settle(result);
    if (process.platform === "win32") {
      if (blockedByOpenHandle) {
        expect(outcome).not.toBeInstanceOf(Error);
        await expect(readFile(finalPath, "utf8")).resolves.toBe(Buffer.from(payload).toString());
      } else {
        expect(outcome).toBeInstanceOf(Error);
        expect((outcome as Error).message).toContain("temporary file changed");
        await expect(readFile(finalPath)).rejects.toThrow();
      }
    } else {
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toContain("temporary file changed");
      await expect(readFile(finalPath)).rejects.toThrow();
    }
  });

  it("handles target replacement through a link without an escaped or malicious final write", async () => {
    const payload = new TextEncoder().encode("hierarchy fixture");
    const lock = await fixtureLock(payload);
    const directory = await output();
    const escaped = await output();
    const finalName = "node-v24.18.0-win-x64.zip";
    const finalPath = path.join(directory, "windows-x64", finalName);
    const escapedFinal = path.join(escaped, finalName);
    let replacementBlocked = false;
    let attempted = false;
    const result = acquireRuntimeSources({
      lock,
      outputDirectory: directory,
      fetchImplementation: async () => response(payload),
      afterVerification: async () => {
        if (attempted) return;
        attempted = true;
        const target = path.join(directory, "windows-x64");
        try {
          await rename(target, path.join(directory, "displaced"));
        } catch {
          replacementBlocked = true;
          return;
        }
        try {
          await symlink(escaped, target, "dir");
        } catch {
          await rename(path.join(directory, "displaced"), target);
          replacementBlocked = true;
          return;
        }
        if ((await realpath(target)) !== (await realpath(escaped))) {
          await rm(target, { recursive: true, force: true });
          await rename(path.join(directory, "displaced"), target);
          replacementBlocked = true;
        }
      },
    });
    const outcome = await settle(result);
    if (replacementBlocked) {
      expect(outcome).not.toBeInstanceOf(Error);
      await expect(readFile(finalPath, "utf8")).resolves.toBe(Buffer.from(payload).toString());
    } else {
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toContain("hierarchy");
      await expect(readFile(finalPath)).rejects.toThrow();
    }
    await expect(readFile(escapedFinal)).rejects.toThrow();
  });

  it("rejects an ancestor link while creating the output hierarchy componentwise", async () => {
    const payload = new TextEncoder().encode("creation hierarchy fixture");
    const lock = await fixtureLock(payload);
    const root = await output();
    const escaped = await output();
    const linked = path.join(root, "linked");
    await symlink(escaped, linked, "dir");
    await expect(
      acquireRuntimeSources({
        lock,
        outputDirectory: path.join(linked, "runtime"),
        fetchImplementation: async () => response(payload),
      }),
    ).rejects.toThrow("hierarchy");
    await expect(readFile(path.join(escaped, "runtime"))).rejects.toThrow();
  });
});
