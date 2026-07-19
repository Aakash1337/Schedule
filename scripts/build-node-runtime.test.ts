import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildDesktopRuntime,
  hashTree,
  type DesktopRuntimeBuildOptions,
} from "./build-desktop-runtime.js";
import { buildNodeRuntime, parseNodeRuntimeArguments } from "./build-node-runtime.js";

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
async function linuxLockFor(payload: Buffer): Promise<Record<string, unknown>> {
  const lock = JSON.parse(
    await readFile(path.join(repository, "runtime-sources.lock.json"), "utf8"),
  ) as Record<string, unknown>;
  const artifacts = lock.artifacts as Array<Record<string, unknown>>;
  artifacts.find((artifact) => artifact.id === "node-linux-x64")!.sha256 = createHash("sha256")
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
async function desktopAssemblerFixture(
  root: string,
  node: string,
): Promise<DesktopRuntimeBuildOptions> {
  const api = path.join(root, "api");
  const worker = path.join(root, "worker");
  const postgres = path.join(root, "postgres");
  await Promise.all([
    mkdir(path.join(api, "dist"), { recursive: true }),
    mkdir(path.join(api, "node_modules", "@schedule", "database", "dist"), { recursive: true }),
    mkdir(path.join(api, "node_modules", "@schedule", "database", "drizzle", "meta"), {
      recursive: true,
    }),
    mkdir(path.join(worker, "dist"), { recursive: true }),
    mkdir(path.join(postgres, "bin"), { recursive: true }),
    mkdir(path.join(postgres, "lib"), { recursive: true }),
    mkdir(path.join(postgres, "share", "extension"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(api, "dist", "server.js"), "api"),
    writeFile(
      path.join(api, "node_modules", "@schedule", "database", "dist", "migrate.js"),
      "migrate",
    ),
    writeFile(
      path.join(api, "node_modules", "@schedule", "database", "drizzle", "meta", "_journal.json"),
      "[]",
    ),
    writeFile(path.join(worker, "dist", "index.js"), "worker"),
    ...["initdb", "pg_ctl", "pg_dump", "pg_isready", "pg_restore", "postgres", "psql"].map((tool) =>
      writeFile(path.join(postgres, "bin", tool), tool),
    ),
    writeFile(path.join(postgres, "share", "postgresql.conf.sample"), "config"),
    writeFile(
      path.join(postgres, "share", "extension", "pgcrypto.control"),
      "default_version = '1.3'\n",
    ),
    writeFile(path.join(postgres, "share", "extension", "pgcrypto--1.3.sql"), "extension"),
    writeFile(path.join(postgres, "lib", "pgcrypto.so"), "library"),
  ]);
  const pin = async (directory: string, version: string) => ({
    version,
    sha256: await hashTree(directory),
  });
  return {
    outputDirectory: path.join(root, "assembled"),
    target: { os: "linux", arch: "x86_64" },
    postgresqlMajor: 17,
    apiDeploymentDirectory: api,
    workerDeploymentDirectory: worker,
    nodeRuntimeDirectory: node,
    postgresqlRuntimeDirectory: postgres,
    sources: {
      api: await pin(api, "1.0.0"),
      worker: await pin(worker, "1.0.0"),
      node: await pin(node, "24.18.0"),
      postgresql: await pin(postgres, "17.10"),
    },
  };
}

describe("Node desktop runtime bundles", () => {
  it("accepts one pnpm sentinel but rejects unknown, duplicate, and odd CLI arguments", () => {
    const valid = [
      "--lock",
      "lock.json",
      "--sources",
      "sources",
      "--output",
      "output",
      "--target",
      "linux",
    ];
    expect(parseNodeRuntimeArguments(valid)).toEqual({
      lockPath: "lock.json",
      sources: "sources",
      output: "output",
      target: "linux",
    });
    expect(parseNodeRuntimeArguments(["--", ...valid])).toEqual(parseNodeRuntimeArguments(valid));
    for (const invalid of [
      ["--", "--", ...valid],
      ["--lock", "first", "--lock", "second", "--output", "output", "--target", "linux"],
      ["--lock", "lock", "--unknown", "value", "--output", "output", "--target", "linux"],
      valid.slice(0, -1),
    ])
      expect(() => parseNodeRuntimeArguments(invalid)).toThrow();
  });

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
    expect(await hashTree(first)).toBe(one.checksum);
    await expect(readFile(path.join(first, "node.exe"), "utf8")).resolves.toBe("node");
    await expect(readFile(path.join(first, "node-runtime.provenance.json"), "utf8")).resolves.toBe(
      await readFile(path.join(second, "node-runtime.provenance.json"), "utf8"),
    );
  });

  it("flattens selected Linux tar files while allowing unrelated archive symlinks", async () => {
    const payload = Buffer.from("linux fixture archive");
    const sources = await temporary();
    const sourceDirectory = path.join(sources, "linux-x64");
    await mkdir(sourceDirectory, { recursive: true });
    const sourceArchive = path.join(sourceDirectory, "node-v24.18.0-linux-x64.tar.xz");
    await writeFile(sourceArchive, payload);
    const output = path.join(await temporary(), "node runtime");
    let verifiedArchive: string | undefined;
    const selected = ["node-v24.18.0-linux-x64/bin/node", "node-v24.18.0-linux-x64/LICENSE"];
    const archiveListing =
      "lrwxrwxrwx root/root 0 2026-01-01 node-v24.18.0-linux-x64/bin/npm -> ../lib/node_modules/npm/bin/npm-cli.js\n" +
      "-rwxr-xr-x root/root 4 2026-01-01 node-v24.18.0-linux-x64/bin/node\n" +
      "-rw-r--r-- root/root 3 2026-01-01 node-v24.18.0-linux-x64/LICENSE\n";
    const tar = async (file: string, arguments_: readonly string[]) => {
      if (file !== "tar") return "v24.18.0\n";
      if (arguments_[0] === "-tvJf") {
        verifiedArchive = arguments_[1];
        expect(verifiedArchive).not.toBe(sourceArchive);
        expect(arguments_.slice(2)).toEqual(selected);
        await writeFile(sourceArchive, "swapped after verification");
        return archiveListing
          .split("\n")
          .filter((line) => selected.some((name) => line.endsWith(name)))
          .join("\n");
      }
      expect(arguments_[1]).toBe(verifiedArchive);
      expect(arguments_.slice(-2)).toEqual(selected);
      await expect(readFile(arguments_[1]!)).resolves.toEqual(payload);
      const staging = arguments_[arguments_.indexOf("-C") + 1]!;
      await mkdir(path.join(staging, "node-v24.18.0-linux-x64", "bin"), { recursive: true });
      await Promise.all([
        writeFile(path.join(staging, "node-v24.18.0-linux-x64", "bin", "node"), "node"),
        writeFile(path.join(staging, "node-v24.18.0-linux-x64", "LICENSE"), "MIT"),
      ]);
      return "";
    };
    await buildNodeRuntime({
      lock: (await linuxLockFor(payload)) as never,
      sourceDirectory: sources,
      outputDirectory: output,
      target: "linux",
      command: tar,
    });
    await expect(readFile(path.join(output, "node"), "utf8")).resolves.toBe("node");
    await expect(readFile(path.join(output, "bin", "node"))).rejects.toThrow();
    expect(
      (await readdir(path.dirname(output))).filter((name) =>
        name.startsWith(".node-runtime-archive-"),
      ),
    ).toEqual([]);
    const manifest = await buildDesktopRuntime(
      await desktopAssemblerFixture(await temporary(), output),
    );
    expect(manifest.components.find((component) => component.name === "node")?.launch.path).toBe(
      "node/node",
    );
    const provenance = JSON.parse(
      await readFile(path.join(output, "node-runtime.provenance.json"), "utf8"),
    ) as { licenses: Array<{ path: string; sha256: string }> };
    expect(provenance.licenses).toEqual([
      { path: "LICENSE", sha256: createHash("sha256").update("MIT").digest("hex") },
    ]);
  });

  it("rejects Linux tar link entries before extraction or publication", async () => {
    const payload = Buffer.from("malicious linux fixture archive");
    const sources = await temporary();
    const sourceDirectory = path.join(sources, "linux-x64");
    await mkdir(sourceDirectory, { recursive: true });
    await writeFile(path.join(sourceDirectory, "node-v24.18.0-linux-x64.tar.xz"), payload);
    const output = path.join(await temporary(), "runtime");
    await expect(
      buildNodeRuntime({
        lock: (await linuxLockFor(payload)) as never,
        sourceDirectory: sources,
        outputDirectory: output,
        target: "linux",
        command: async () =>
          "lrwxrwxrwx root/root 0 2026-01-01 node-v24.18.0-linux-x64/bin/node -> /tmp/node\n",
      }),
    ).rejects.toThrow("regular files");
    await expect(readFile(path.join(output, "node"))).rejects.toThrow();
    expect(
      (await readdir(path.dirname(output))).filter((name) =>
        name.startsWith(".node-runtime-archive-"),
      ),
    ).toEqual([]);
  });

  it("removes a partially written private Linux archive when its writer fails", async () => {
    const payload = Buffer.from("writer failure fixture archive");
    const sources = await temporary();
    const sourceDirectory = path.join(sources, "linux-x64");
    await mkdir(sourceDirectory, { recursive: true });
    await writeFile(path.join(sourceDirectory, "node-v24.18.0-linux-x64.tar.xz"), payload);
    const output = path.join(await temporary(), "runtime");
    let privateDirectory: string | undefined;
    await expect(
      buildNodeRuntime({
        lock: (await linuxLockFor(payload)) as never,
        sourceDirectory: sources,
        outputDirectory: output,
        target: "linux",
        writeVerifiedArchive: async (archive) => {
          privateDirectory = path.dirname(archive);
          await writeFile(archive, "partial");
          throw new Error("simulated private archive write failure");
        },
      }),
    ).rejects.toThrow("simulated private archive write failure");
    await expect(readdir(privateDirectory!)).rejects.toThrow();
    expect(
      (await readdir(path.dirname(output))).filter((name) =>
        name.startsWith(".node-runtime-archive-"),
      ),
    ).toEqual([]);
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
