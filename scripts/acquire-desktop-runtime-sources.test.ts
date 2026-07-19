import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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

async function fixtureLock(payload: Uint8Array): Promise<RuntimeSourceLock> {
  const raw = JSON.parse(
    await readFile(path.join(repositoryRoot, "runtime-sources.lock.json"), "utf8"),
  ) as {
    artifacts: Array<Record<string, unknown>>;
  };
  const sha256 = createHash("sha256").update(payload).digest("hex");
  for (const artifact of raw.artifacts) artifact.sha256 = sha256;
  return parseRuntimeSourceLock(raw);
}

function responseFor(
  payload: Uint8Array,
  options: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return new Response(payload, { status: options.status ?? 200, headers: options.headers });
}

describe("desktop runtime source acquisition", () => {
  it("accepts exactly the committed source-lock shape", async () => {
    const raw = JSON.parse(
      await readFile(path.join(repositoryRoot, "runtime-sources.lock.json"), "utf8"),
    ) as unknown;
    expect(parseRuntimeSourceLock(raw).artifacts).toHaveLength(4);
    expect(() => parseRuntimeSourceLock({ ...(raw as object), untrusted: true })).toThrow(
      "canonical",
    );
    const bad = structuredClone(raw) as { artifacts: Array<Record<string, unknown>> };
    bad.artifacts[0]!.url = "http://example.invalid/node.zip";
    expect(() => parseRuntimeSourceLock(bad)).toThrow("approved official HTTPS origin");
  });

  it("streams only matching local responses into no-replace target directories", async () => {
    const payload = new TextEncoder().encode("verified fixture archive");
    const lock = await fixtureLock(payload);
    const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "schedule-runtime-sources-"));
    temporaryDirectories.push(outputDirectory);
    const calls: string[] = [];
    const fetchImplementation: FetchImplementation = async (url) => {
      calls.push(url);
      return responseFor(payload, { headers: { "content-length": String(payload.byteLength) } });
    };
    const archives = await acquireRuntimeSources({ lock, outputDirectory, fetchImplementation });
    expect(archives).toHaveLength(4);
    expect(calls).toHaveLength(4);
    await expect(readFile(archives[0]!)).resolves.toEqual(Buffer.from(payload));
    await expect(
      acquireRuntimeSources({ lock, outputDirectory, fetchImplementation }),
    ).rejects.toThrow("already exists");
  });

  it("rejects redirects off approved origins, oversized data, and hash mismatches", async () => {
    const payload = new TextEncoder().encode("small archive");
    const lock = await fixtureLock(payload);
    const outputDirectory = await mkdtemp(
      path.join(os.tmpdir(), "schedule-runtime-sources-reject-"),
    );
    temporaryDirectories.push(outputDirectory);
    const redirect: FetchImplementation = async () =>
      responseFor(new Uint8Array(), {
        status: 302,
        headers: { location: "https://example.invalid/archive" },
      });
    await expect(
      acquireRuntimeSources({ lock, outputDirectory, fetchImplementation: redirect }),
    ).rejects.toThrow("approved official HTTPS origin");
    const oversized = structuredClone(lock) as { artifacts: Array<{ maxBytes: number }> };
    oversized.artifacts[0]!.maxBytes = 1;
    await expect(
      acquireRuntimeSources({
        lock: parseRuntimeSourceLock(oversized),
        outputDirectory,
        fetchImplementation: async () => responseFor(payload),
      }),
    ).rejects.toThrow("byte limit");
    await expect(
      acquireRuntimeSources({
        lock,
        outputDirectory,
        fetchImplementation: async () => responseFor(new TextEncoder().encode("wrong")),
      }),
    ).rejects.toThrow("committed SHA-256");
  });
});
