import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  unlink,
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
  return new Response(payload, { status, headers });
}
function streamResponse(status: number, location?: string, onCancel?: () => void): Response {
  return new Response(new ReadableStream({ cancel: onCancel }), {
    status,
    headers: location === undefined ? undefined : { location },
  });
}

describe("desktop runtime source acquisition", () => {
  it("rejects malformed target/schema fields and IDs that do not match their fixed specifications", async () => {
    const cases: Array<(lock: { artifacts: Array<Record<string, unknown>> }) => void> = [
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
        lock.artifacts[0]!.extra = true;
      },
    ];
    for (const mutate of cases) {
      const lock = await rawLock();
      mutate(lock);
      expect(() => parseRuntimeSourceLock(lock)).toThrow();
    }
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
        ? streamResponse(302, "node-v24.17.0-win-x64.zip", () => {
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
      async () => streamResponse(302, "node-v24.17.0-win-x64.zip"),
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

  it("rejects a publish collision and a swapped verified temporary pathname", async () => {
    const payload = new TextEncoder().encode("swap fixture");
    const lock = await fixtureLock(payload);
    const directory = await output();
    await mkdir(path.join(directory, "windows-x64"));
    await writeFile(path.join(directory, "windows-x64", "node-v24.17.0-win-x64.zip"), "existing");
    await expect(
      acquireRuntimeSources({
        lock,
        outputDirectory: directory,
        fetchImplementation: async () => response(payload),
      }),
    ).rejects.toThrow("already exists");
    await unlink(path.join(directory, "windows-x64", "node-v24.17.0-win-x64.zip"));
    await expect(
      acquireRuntimeSources({
        lock,
        outputDirectory: directory,
        fetchImplementation: async () => response(payload),
        afterVerification: async (temporary) => {
          await rm(temporary);
          await writeFile(temporary, payload);
        },
      }),
    ).rejects.toThrow("temporary file changed");
  });

  it("rejects a target replacement through a link before a verified archive can publish", async () => {
    const payload = new TextEncoder().encode("hierarchy fixture");
    const lock = await fixtureLock(payload);
    const directory = await output();
    const escaped = await output();
    await expect(
      acquireRuntimeSources({
        lock,
        outputDirectory: directory,
        fetchImplementation: async () => response(payload),
        afterVerification: async () => {
          const target = path.join(directory, "windows-x64");
          const displaced = path.join(directory, "displaced");
          try {
            await rename(target, displaced);
          } catch {
            // Windows refuses this replacement while the verified temporary handle is open.
            throw new Error("target replacement blocked");
          }
          await symlink(escaped, target, process.platform === "win32" ? "junction" : "dir");
        },
      }),
    ).rejects.toThrow(/hierarchy|target replacement blocked/u);
  });
});
