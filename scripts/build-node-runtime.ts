/** Build the minimal, relocatable Node runtime consumed by build-desktop-runtime. */
import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  parseRuntimeSourceLock,
  type RuntimeSourceArtifact,
  type RuntimeSourceLock,
} from "./acquire-desktop-runtime-sources.js";

const execFile = promisify(execFileCallback);
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;
const PROVENANCE = "node-runtime.provenance.json";

type Target = "windows" | "linux";
type Command = (file: string, arguments_: readonly string[], cwd?: string) => Promise<string>;

export interface BuildNodeRuntimeOptions {
  readonly lock: RuntimeSourceLock;
  readonly sourceDirectory: string;
  readonly outputDirectory: string;
  readonly target: Target;
  /** Test seam. Production uses the platform tar executable without a shell. */
  readonly command?: Command;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}
function safePath(value: string): boolean {
  return (
    value.length > 0 &&
    !value.includes("\\") &&
    !value.startsWith("/") &&
    !value.split("/").some((part) => part === "" || part === "." || part === "..") &&
    /^[A-Za-z0-9._/@-]+$/u.test(value)
  );
}
function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}
function artifactFor(lock: RuntimeSourceLock, target: Target): RuntimeSourceArtifact {
  const id = `node-${target}-x64`;
  const artifact = parseRuntimeSourceLock(lock).artifacts.find((candidate) => candidate.id === id);
  if (artifact === undefined) throw new Error(`The runtime source lock does not pin ${id}.`);
  return artifact;
}
function archivePath(sourceDirectory: string, artifact: RuntimeSourceArtifact): string {
  return path.join(
    sourceDirectory,
    `${artifact.target.os}-${artifact.target.arch}`,
    path.posix.basename(new URL(artifact.url).pathname),
  );
}
function expectedFiles(artifact: RuntimeSourceArtifact): readonly string[] {
  const root = artifact.extractedRoot;
  return artifact.target.os === "windows"
    ? [`${root}/node.exe`, `${root}/LICENSE`]
    : [`${root}/bin/node`, `${root}/LICENSE`];
}
function outputFile(relative: string, target: Target): string {
  const root = relative.split("/").slice(1);
  return target === "windows" ? root.join("/") : root.join("/");
}
function assertArchiveSize(bytes: Uint8Array, artifact: RuntimeSourceArtifact): void {
  if (bytes.byteLength > Math.min(MAX_ARCHIVE_BYTES, artifact.maxBytes))
    throw new Error("Node runtime archive exceeds its locked byte limit.");
  if (sha256(bytes) !== artifact.sha256)
    throw new Error("Node runtime archive SHA-256 does not match lock.");
}

type ZipEntry = Readonly<{
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  offset: number;
}>;
function u16(bytes: Uint8Array, at: number): number {
  return bytes[at]! | (bytes[at + 1]! << 8);
}
function u32(bytes: Uint8Array, at: number): number {
  return (u16(bytes, at) | (u16(bytes, at + 2) << 16)) >>> 0;
}
/** Parse central directory ourselves; Node's official ZIP is limited to stored/deflated regular files. */
function zipEntries(bytes: Uint8Array): readonly ZipEntry[] {
  const floor = Math.max(0, bytes.length - 65_557);
  let eocd = -1;
  for (let at = bytes.length - 22; at >= floor; at -= 1)
    if (u32(bytes, at) === 0x06054b50) {
      eocd = at;
      break;
    }
  if (eocd < 0 || u16(bytes, eocd + 4) !== 0 || u16(bytes, eocd + 6) !== 0)
    throw new Error("Node ZIP is malformed or multi-disk.");
  const count = u16(bytes, eocd + 10);
  const directorySize = u32(bytes, eocd + 12);
  let at = u32(bytes, eocd + 16);
  if (at + directorySize > eocd) throw new Error("Node ZIP central directory is invalid.");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const entries: ZipEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    if (u32(bytes, at) !== 0x02014b50)
      throw new Error("Node ZIP central directory entry is invalid.");
    const flags = u16(bytes, at + 8);
    const method = u16(bytes, at + 10);
    const compressedSize = u32(bytes, at + 20);
    const size = u32(bytes, at + 24);
    const nameLength = u16(bytes, at + 28);
    const extraLength = u16(bytes, at + 30);
    const commentLength = u16(bytes, at + 32);
    const externalAttributes = u32(bytes, at + 38);
    const offset = u32(bytes, at + 42);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    const safeName = name.endsWith("/") ? safePath(name.slice(0, -1)) : safePath(name);
    if ((flags & 1) !== 0 || !safeName || (method !== 0 && method !== 8))
      throw new Error(`Node ZIP contains an encrypted, unsafe, or unsupported entry: ${name}.`);
    const unixType = (externalAttributes >>> 16) & 0xf000;
    if (unixType === 0xa000) throw new Error("Node ZIP symlink entries are not supported.");
    entries.push(Object.freeze({ name, method, compressedSize, size, offset }));
    at += 46 + nameLength + extraLength + commentLength;
  }
  return Object.freeze(entries);
}
async function inflateZip(bytes: Uint8Array, entry: ZipEntry): Promise<Uint8Array> {
  if (u32(bytes, entry.offset) !== 0x04034b50) throw new Error("Node ZIP local header is invalid.");
  const nameLength = u16(bytes, entry.offset + 26);
  const extraLength = u16(bytes, entry.offset + 28);
  const payload = bytes.subarray(
    entry.offset + 30 + nameLength + extraLength,
    entry.offset + 30 + nameLength + extraLength + entry.compressedSize,
  );
  if (payload.byteLength !== entry.compressedSize)
    throw new Error("Node ZIP payload is truncated.");
  const result = entry.method === 0 ? payload : (await import("node:zlib")).inflateRawSync(payload);
  if (result.byteLength !== entry.size) throw new Error("Node ZIP entry size is invalid.");
  return result;
}
async function extractZip(
  bytes: Uint8Array,
  artifact: RuntimeSourceArtifact,
  staging: string,
): Promise<void> {
  const wanted = new Set(expectedFiles(artifact));
  const entries = zipEntries(bytes);
  for (const wantedFile of wanted)
    if (!entries.some((entry) => entry.name === wantedFile))
      throw new Error(`Node ZIP is missing ${wantedFile}.`);
  for (const entry of entries) {
    if (!wanted.has(entry.name)) continue;
    const bytes_ = await inflateZip(bytes, entry);
    const relative = outputFile(entry.name, "windows");
    const destination = path.join(staging, ...relative.split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, bytes_, { mode: entry.name.endsWith(".exe") ? 0o755 : 0o644 });
  }
}
function tarNames(listing: string, artifact: RuntimeSourceArtifact): readonly string[] {
  const expected = new Set(expectedFiles(artifact));
  const names: string[] = [];
  for (const line of listing.split(/\r?\n/u).filter(Boolean)) {
    const type = line[0];
    if (type === "l" || type === "h" || type === "b" || type === "c" || type === "p")
      throw new Error("Node tar archive contains a link or special entry.");
    const name = (line.trim().split(/\s+/u).at(-1) ?? "").replace(/\/$/u, "");
    if (!safePath(name)) throw new Error("Node tar archive contains an unsafe path.");
    if (type !== "d") names.push(name);
  }
  for (const file of expected)
    if (!names.includes(file)) throw new Error(`Node tar is missing ${file}.`);
  return Object.freeze(names);
}
async function defaultCommand(
  file: string,
  arguments_: readonly string[],
  cwd?: string,
): Promise<string> {
  const result = await execFile(file, [...arguments_], {
    cwd,
    windowsHide: true,
    maxBuffer: 4 * 1024 * 1024,
  });
  return result.stdout;
}
async function extractTar(
  archive: string,
  artifact: RuntimeSourceArtifact,
  staging: string,
  command: Command,
): Promise<void> {
  const listing = await command("tar", ["-tvJf", archive]);
  tarNames(listing, artifact);
  await command("tar", [
    "-xJf",
    archive,
    "-C",
    staging,
    "--no-same-owner",
    "--no-same-permissions",
    ...expectedFiles(artifact),
  ]);
  for (const expected of expectedFiles(artifact)) {
    const extracted = path.join(staging, ...expected.split("/"));
    const target = path.join(staging, ...outputFile(expected, "linux").split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await rename(extracted, target);
  }
  await rm(path.join(staging, artifact.extractedRoot), { recursive: true, force: true });
}
async function checksumTree(root: string): Promise<string> {
  const paths: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await (
      await import("node:fs/promises")
    ).readdir(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile()))
        throw new Error("Runtime output contains an unsafe entry.");
      if (entry.isDirectory()) await visit(full);
      else paths.push(path.relative(root, full).split(path.sep).join("/"));
    }
  };
  await visit(root);
  paths.sort();
  const digest = createHash("sha256");
  for (const relative of paths)
    digest
      .update(relative)
      .update("\0")
      .update(await readFile(path.join(root, ...relative.split("/"))))
      .update("\0");
  return digest.digest("hex");
}
async function runNode(binary: string, version: string, command: Command): Promise<void> {
  const result = (await command(binary, ["--version"])).trim();
  if (result !== `v${version}`)
    throw new Error(`Node runtime reported ${result}, expected v${version}.`);
}

/** Hashes before extraction, writes only required runtime files, then proves a relocated runtime launches. */
export async function buildNodeRuntime(
  options: BuildNodeRuntimeOptions,
): Promise<{ checksum: string }> {
  const lock = parseRuntimeSourceLock(options.lock);
  const artifact = artifactFor(lock, options.target);
  const archive = archivePath(path.resolve(options.sourceDirectory), artifact);
  const archiveEntry = await lstat(archive).catch(() => null);
  if (
    archiveEntry === null ||
    !archiveEntry.isFile() ||
    archiveEntry.isSymbolicLink() ||
    archiveEntry.size > Math.min(MAX_ARCHIVE_BYTES, artifact.maxBytes)
  )
    throw new Error("Node runtime archive is missing, linked, or exceeds its locked byte limit.");
  const archiveBytes = await readFile(archive);
  assertArchiveSize(archiveBytes, artifact);
  const output = path.resolve(options.outputDirectory);
  const sources = path.resolve(options.sourceDirectory);
  if (contains(sources, output) || contains(output, sources))
    throw new Error("Node runtime output and source archive directory must be disjoint.");
  const parent = path.dirname(output);
  const staging = path.join(parent, `.${path.basename(output)}.${randomUUID()}.staging`);
  const command = options.command ?? defaultCommand;
  await mkdir(parent, { recursive: true });
  await rm(staging, { recursive: true, force: true });
  try {
    await mkdir(staging, { mode: 0o700 });
    if (options.target === "windows") await extractZip(archiveBytes, artifact, staging);
    else await extractTar(archive, artifact, staging, command);
    const binary = path.join(
      staging,
      ...(options.target === "windows" ? ["node.exe"] : ["bin", "node"]),
    );
    const entry = await lstat(binary).catch(() => null);
    if (entry === null || !entry.isFile() || entry.isSymbolicLink())
      throw new Error("Node runtime executable is missing or unsafe.");
    await chmod(binary, 0o755);
    const checksum = await checksumTree(staging);
    await writeFile(
      path.join(staging, PROVENANCE),
      `${JSON.stringify({ schemaVersion: 1, source: { url: artifact.url, version: artifact.version, sha256: artifact.sha256 }, checksum }, null, 2)}\n`,
    );
    const relocation = await mkdtemp(path.join(parent, "Schedule Node Runtime relocation "));
    try {
      await cp(staging, relocation, { recursive: true, dereference: false });
      await runNode(
        path.join(relocation, path.relative(staging, binary)),
        artifact.version,
        command,
      );
    } finally {
      await rm(relocation, { recursive: true, force: true });
    }
    await rm(output, { recursive: true, force: true });
    await rename(staging, output);
    return Object.freeze({ checksum });
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

function cli(arguments_: readonly string[]): {
  lockPath: string;
  sources: string;
  output: string;
  target: Target;
} {
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    if (key === undefined || value === undefined || !key.startsWith("--"))
      throw new Error("Arguments must be --name value pairs.");
    values.set(key.slice(2), value);
  }
  const required = (key: string) => {
    const value = values.get(key);
    if (!value) throw new Error(`--${key} is required.`);
    return value;
  };
  const target = required("target");
  if (target !== "windows" && target !== "linux")
    throw new Error("--target must be windows or linux.");
  return {
    lockPath: required("lock"),
    sources: required("sources"),
    output: required("output"),
    target,
  };
}
if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  const options = cli(process.argv.slice(2));
  const result = await buildNodeRuntime({
    ...options,
    lock: JSON.parse(await readFile(options.lockPath, "utf8")) as RuntimeSourceLock,
    sourceDirectory: options.sources,
    outputDirectory: options.output,
  });
  process.stdout.write(`Node runtime assembled. SCHEDULE_NODE_RUNTIME_SHA256=${result.checksum}\n`);
}
