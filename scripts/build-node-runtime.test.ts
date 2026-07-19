import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildNodeRuntime } from "./build-node-runtime.js";

const directories: string[] = [];
const repository = path.resolve(import.meta.dirname, "..");
afterEach(async () =>
  Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  ),
);
async function temporary(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "schedule-node-runtime-"));
  directories.push(directory);
  return directory;
}
function u16(value: number): Buffer {
  const result = Buffer.alloc(2);
  result.writeUInt16LE(value);
  return result;
}
function u32(value: number): Buffer {
  const result = Buffer.alloc(4);
  result.writeUInt32LE(value);
  return result;
}
function zip(entries: readonly { name: string; bytes: string; attributes?: number }[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const bytes = Buffer.from(entry.bytes);
    const local = Buffer.concat([
      Buffer.from("PK\x03\x04"),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(bytes.length),
      u32(bytes.length),
      u16(name.length),
      u16(0),
      name,
      bytes,
    ]);
    locals.push(local);
    central.push(
      Buffer.concat([
        Buffer.from("PK\x01\x02"),
        u16(0x0314),
        u16(20),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(bytes.length),
        u32(bytes.length),
        u16(name.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32((entry.attributes ?? 0) >>> 0),
        u32(offset),
        name,
      ]),
    );
    offset += local.length;
  }
  const directory = Buffer.concat(central);
  return Buffer.concat([
    ...locals,
    directory,
    Buffer.from("PK\x05\x06"),
    u16(0),
    u16(0),
    u16(entries.length),
    u16(entries.length),
    u32(directory.length),
    u32(offset),
    u16(0),
  ]);
}
async function lockFor(payload: Buffer): Promise<Record<string, unknown>> {
  const lock = JSON.parse(
    await readFile(path.join(repository, "runtime-sources.lock.json"), "utf8"),
  ) as Record<string, unknown>;
  const artifacts = lock.artifacts as Array<Record<string, unknown>>;
  artifacts.find((artifact) => artifact.id === "node-windows-x64")!.sha256 = createHash("sha256")
    .update(payload)
    .digest("hex");
  return lock;
}
async function writeFixture(
  payload: Buffer,
): Promise<{ sources: string; lock: Record<string, unknown> }> {
  const sources = await temporary();
  const directory = path.join(sources, "windows-x64");
  await (await import("node:fs/promises")).mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "node-v24.18.0-win-x64.zip"), payload);
  return { sources, lock: await lockFor(payload) };
}
const fixture = () =>
  zip([
    { name: "node-v24.18.0-win-x64/node.exe", bytes: "node" },
    { name: "node-v24.18.0-win-x64/LICENSE", bytes: "MIT" },
  ]);
const command = async (_file: string, _arguments: readonly string[]) => "v24.18.0\n";

describe("Node desktop runtime bundles", () => {
  it("builds a minimal deterministic Windows runtime and proves relocation", async () => {
    const input = await writeFixture(fixture());
    const first = path.join(await temporary(), "runtime");
    const second = path.join(await temporary(), "runtime");
    const one = await buildNodeRuntime({
      lock: input.lock as never,
      sourceDirectory: input.sources,
      outputDirectory: first,
      target: "windows",
      command,
    });
    const two = await buildNodeRuntime({
      lock: input.lock as never,
      sourceDirectory: input.sources,
      outputDirectory: second,
      target: "windows",
      command,
    });
    expect(one).toEqual(two);
    await expect(readFile(path.join(first, "node.exe"), "utf8")).resolves.toBe("node");
    await expect(readFile(path.join(first, "node-runtime.provenance.json"), "utf8")).resolves.toBe(
      await readFile(path.join(second, "node-runtime.provenance.json"), "utf8"),
    );
  });

  it("rejects hash, traversal, symlink, missing-layout, and version failures without publishing", async () => {
    const cases = [
      {
        payload: fixture(),
        mutate: (lock: Record<string, unknown>) => {
          (lock.artifacts as Array<Record<string, unknown>>)[0]!.sha256 = "0".repeat(64);
        },
        message: "SHA-256",
      },
      { payload: zip([{ name: "../node.exe", bytes: "bad" }]), message: "unsafe" },
      {
        payload: zip([
          { name: "node-v24.18.0-win-x64/node.exe", bytes: "node", attributes: 0xa000 << 16 },
          { name: "node-v24.18.0-win-x64/LICENSE", bytes: "MIT" },
        ]),
        message: "symlink",
      },
      {
        payload: zip([{ name: "node-v24.18.0-win-x64/LICENSE", bytes: "MIT" }]),
        message: "missing",
      },
      { payload: fixture(), version: "v0.0.0\n", message: "expected" },
    ];
    for (const scenario of cases) {
      const input = await writeFixture(scenario.payload);
      scenario.mutate?.(input.lock);
      const output = path.join(await temporary(), "runtime");
      await expect(
        buildNodeRuntime({
          lock: input.lock as never,
          sourceDirectory: input.sources,
          outputDirectory: output,
          target: "windows",
          command: async () => scenario.version ?? "v24.18.0\n",
        }),
      ).rejects.toThrow(scenario.message);
      await expect(readFile(path.join(output, "node.exe"))).rejects.toThrow();
    }
  });
});
