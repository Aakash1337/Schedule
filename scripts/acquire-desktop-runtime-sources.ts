/** Download only committed runtime archives. Extraction and execution are separate release steps. */
import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, realpath, rm, unlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const MAX_REDIRECTS = 3;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_ORPHANS = 64;
const REQUIRED = [
  ["node-windows-x64", "node", "windows", "runtime-binary", "zip"],
  ["postgresql-windows-x64-source", "postgresql", "windows", "source", "tar.gz"],
  ["node-linux-x64", "node", "linux", "runtime-binary", "tar.xz"],
  ["postgresql-linux-x64-source", "postgresql", "linux", "source", "tar.gz"],
] as const;

type Target = Readonly<{ os: "windows" | "linux"; arch: "x64" }>;
type Component = "node" | "postgresql";
type Kind = "runtime-binary" | "source";
type Format = "zip" | "tar.gz" | "tar.xz";
type Identity = Readonly<{ dev: number | bigint; ino: number | bigint }>;
type DirectoryLease = Readonly<{
  path: string;
  real: string;
  chain: readonly Readonly<{ path: string; identity: Identity }>[];
}>;

export interface RuntimeSourceArtifact {
  readonly id: string;
  readonly component: Component;
  readonly version: string;
  readonly target: Target;
  readonly kind: Kind;
  readonly url: string;
  readonly sha256: string;
  readonly format: Format;
  readonly extractedRoot: string;
  readonly maxBytes: number;
}
export interface RuntimeSourceLock {
  readonly schemaVersion: 1;
  readonly artifacts: readonly RuntimeSourceArtifact[];
}
export type FetchImplementation = (input: string, init: RequestInit) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index])
  );
}
function identity(stat: Awaited<ReturnType<typeof lstat>>): Identity {
  return { dev: stat.dev, ino: stat.ino };
}
function sameIdentity(left: Identity, right: Identity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}
function safeRoot(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value) && value !== "." && value !== "..";
}
function expectedSpec(id: string): (typeof REQUIRED)[number] | undefined {
  return REQUIRED.find(([expected]) => expected === id);
}

function archiveFileName(artifact: RuntimeSourceArtifact): string {
  const name = path.posix.basename(new URL(artifact.url).pathname);
  if (!/^[A-Za-z0-9._-]{1,180}$/u.test(name))
    throw new Error(`Runtime source ${artifact.id} has an unsafe archive name.`);
  return name;
}

function assertExpectedArtifact(artifact: RuntimeSourceArtifact): void {
  const spec = expectedSpec(artifact.id);
  if (
    spec === undefined ||
    artifact.component !== spec[1] ||
    artifact.target.os !== spec[2] ||
    artifact.target.arch !== "x64" ||
    artifact.kind !== spec[3] ||
    artifact.format !== spec[4]
  )
    throw new Error("Runtime source lock artifact does not match its required specification.");
  const url = new URL(artifact.url);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
    throw new Error(`Runtime source ${artifact.id} does not use a canonical official HTTPS URL.`);
  const platform = artifact.target.os === "windows" ? "win" : "linux";
  const file = archiveFileName(artifact);
  if (artifact.component === "node") {
    const expected = `node-v${artifact.version}-${platform}-x64.${artifact.format}`;
    if (
      url.origin !== "https://nodejs.org" ||
      url.pathname !== `/dist/v${artifact.version}/${expected}` ||
      file !== expected ||
      artifact.extractedRoot !== `node-v${artifact.version}-${platform}-x64`
    )
      throw new Error(`Runtime source ${artifact.id} is not the required Node release archive.`);
  } else {
    const expected = `postgresql-${artifact.version}.tar.gz`;
    if (
      url.origin !== "https://ftp.postgresql.org" ||
      url.pathname !== `/pub/source/v${artifact.version}/${expected}` ||
      file !== expected ||
      artifact.extractedRoot !== `postgresql-${artifact.version}`
    )
      throw new Error(
        `Runtime source ${artifact.id} is not the required PostgreSQL source archive.`,
      );
  }
}

/** Parse only the exact v1 lock layout. The committed hash values are the archive trust anchor. */
export function parseRuntimeSourceLock(value: unknown): RuntimeSourceLock {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["schemaVersion", "artifacts"]) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.artifacts)
  )
    throw new Error("Runtime source lock must be a canonical schema version 1 object.");
  const ids = new Set<string>();
  const artifacts = value.artifacts.map((candidate): RuntimeSourceArtifact => {
    if (
      !isRecord(candidate) ||
      !exactKeys(candidate, [
        "id",
        "component",
        "version",
        "target",
        "kind",
        "url",
        "sha256",
        "format",
        "extractedRoot",
        "maxBytes",
      ])
    )
      throw new Error("Runtime source lock contains an unknown or missing artifact field.");
    const target = candidate.target;
    if (
      !isRecord(target) ||
      !exactKeys(target, ["os", "arch"]) ||
      (target.os !== "windows" && target.os !== "linux") ||
      target.arch !== "x64"
    )
      throw new Error("Runtime source lock target is invalid.");
    const artifact = candidate as unknown as RuntimeSourceArtifact;
    if (
      typeof artifact.id !== "string" ||
      !/^[a-z0-9-]{1,80}$/u.test(artifact.id) ||
      ids.has(artifact.id) ||
      (artifact.component !== "node" && artifact.component !== "postgresql") ||
      typeof artifact.version !== "string" ||
      !/^\d+\.\d+(?:\.\d+)?$/u.test(artifact.version) ||
      (artifact.kind !== "runtime-binary" && artifact.kind !== "source") ||
      typeof artifact.url !== "string" ||
      !/^[a-f0-9]{64}$/u.test(artifact.sha256) ||
      !["zip", "tar.gz", "tar.xz"].includes(artifact.format) ||
      !safeRoot(artifact.extractedRoot) ||
      !Number.isSafeInteger(artifact.maxBytes) ||
      artifact.maxBytes < 1 ||
      artifact.maxBytes > 512 * 1024 * 1024
    )
      throw new Error("Runtime source lock contains malformed artifact data.");
    ids.add(artifact.id);
    const frozen = Object.freeze({
      ...artifact,
      target: Object.freeze({ os: target.os, arch: target.arch }),
    }) as RuntimeSourceArtifact;
    assertExpectedArtifact(frozen);
    return frozen;
  });
  if (artifacts.length !== REQUIRED.length || !REQUIRED.every(([id]) => ids.has(id)))
    throw new Error("Runtime source lock must pin exactly the supported Windows/Linux x64 inputs.");
  return Object.freeze({ schemaVersion: 1, artifacts: Object.freeze(artifacts) });
}

async function trustedDirectory(
  directory: string,
  parent?: DirectoryLease,
): Promise<DirectoryLease> {
  const resolved = path.resolve(directory);
  if (parent !== undefined && !contains(parent.path, resolved))
    throw new Error("Runtime source target escapes its trusted output root.");
  const segments = resolved.slice(path.parse(resolved).root.length).split(path.sep).filter(Boolean);
  let current = path.parse(resolved).root;
  let previousReal: string | undefined;
  const chain: Array<{ path: string; identity: Identity }> = [];
  for (const segment of segments) {
    current = path.join(current, segment);
    const entry = await lstat(current);
    if (!entry.isDirectory() || entry.isSymbolicLink())
      throw new Error("Runtime source output hierarchy contains a link or non-directory.");
    const actual = await realpath(current);
    if (previousReal !== undefined && !contains(previousReal, actual))
      throw new Error("Runtime source output hierarchy escaped through a link or junction.");
    previousReal = actual;
    chain.push({ path: current, identity: identity(entry) });
  }
  const real = await realpath(resolved);
  if (parent !== undefined && !contains(parent.real, real))
    throw new Error("Runtime source target escaped its trusted output root.");
  return Object.freeze({ path: resolved, real, chain: Object.freeze(chain) });
}
async function createDirectoryComponentwise(
  directory: string,
  parent?: DirectoryLease,
): Promise<void> {
  const resolved = path.resolve(directory);
  if (parent !== undefined && !contains(parent.path, resolved))
    throw new Error("Runtime source target escapes its trusted output root.");
  const segments = resolved.slice(path.parse(resolved).root.length).split(path.sep).filter(Boolean);
  let current = path.parse(resolved).root;
  let previousReal: string | undefined;
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (!isRecord(error) || error.code !== "EEXIST") throw error;
    }
    const entry = await lstat(current);
    if (!entry.isDirectory() || entry.isSymbolicLink())
      throw new Error("Runtime source output hierarchy contains a link or non-directory.");
    const actual = await realpath(current);
    if (previousReal !== undefined && !contains(previousReal, actual))
      throw new Error("Runtime source output hierarchy escaped through a link or junction.");
    previousReal = actual;
  }
}
async function validateLease(lease: DirectoryLease): Promise<void> {
  for (const expected of lease.chain) {
    const entry = await lstat(expected.path).catch(() => null);
    if (
      entry === null ||
      !entry.isDirectory() ||
      entry.isSymbolicLink() ||
      !sameIdentity(identity(entry), expected.identity) ||
      (await realpath(expected.path).catch(() => "")) === ""
    )
      throw new Error("Runtime source output hierarchy changed during acquisition.");
  }
  if ((await realpath(lease.path)) !== lease.real)
    throw new Error("Runtime source output hierarchy escaped during acquisition.");
}

function redirectIsAllowed(next: URL, source: URL): boolean {
  if (
    next.origin !== source.origin ||
    next.protocol !== "https:" ||
    next.username ||
    next.password ||
    next.search ||
    next.hash
  )
    return false;
  const prefix =
    source.origin === "https://nodejs.org"
      ? `/dist/${source.pathname.split("/")[2]}/`
      : path.posix.dirname(source.pathname) + "/";
  return next.pathname.startsWith(prefix) && /^[A-Za-z0-9._/-]+$/u.test(next.pathname);
}
async function cancelBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}
async function fetchWithBoundedRedirects(
  source: URL,
  fetchImplementation: FetchImplementation,
  signal: AbortSignal,
): Promise<Response> {
  let current = source;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const response = await fetchImplementation(current.href, { redirect: "manual", signal });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    await cancelBody(response);
    if (location === null || redirects === MAX_REDIRECTS)
      throw new Error("Runtime source redirect is missing or exceeds the bound.");
    const next = new URL(location, current);
    if (!redirectIsAllowed(next, source))
      throw new Error("Runtime source redirect left its approved artifact origin or path.");
    current = next;
  }
  throw new Error("Runtime source redirect exceeds the bound.");
}

async function writeVerifiedResponse(
  response: Response,
  artifact: RuntimeSourceArtifact,
  temporaryPath: string,
) {
  if (response.status !== 200 || response.body === null)
    throw new Error(`Runtime source ${artifact.id} did not return a complete archive.`);
  const length = response.headers.get("content-length");
  if (
    response.headers.get("content-encoding") !== null &&
    response.headers.get("content-encoding") !== "identity"
  )
    throw new Error(`Runtime source ${artifact.id} used an unsupported content encoding.`);
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > artifact.maxBytes))
    throw new Error(`Runtime source ${artifact.id} has an invalid or oversized content length.`);
  const handle = await open(temporaryPath, "wx", 0o600);
  const digest = createHash("sha256");
  let bytes = 0;
  try {
    for await (const value of response.body as unknown as AsyncIterable<Uint8Array>) {
      const chunk = Buffer.from(value);
      bytes += chunk.byteLength;
      if (bytes > artifact.maxBytes)
        throw new Error(`Runtime source ${artifact.id} exceeds its byte limit.`);
      digest.update(chunk);
      let offset = 0;
      while (offset < chunk.byteLength) {
        const result = await handle.write(chunk, offset, chunk.byteLength - offset);
        offset += result.bytesWritten;
      }
    }
    if (length !== null && bytes !== Number(length))
      throw new Error(`Runtime source ${artifact.id} was truncated.`);
    if (digest.digest("hex") !== artifact.sha256)
      throw new Error(`Runtime source ${artifact.id} does not match its committed SHA-256.`);
    return { handle, identity: identity(await handle.stat()) };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
async function scavengeOrphans(directory: string, id: string): Promise<void> {
  const { readdir } = await import("node:fs/promises");
  const names = await readdir(directory);
  const pattern = new RegExp(`^\\.${id}\\.[0-9a-f-]{36}\\.partial$`, "u");
  const matches = names.filter((name) => pattern.test(name));
  if (matches.length > MAX_ORPHANS) throw new Error("Too many stale runtime source partial files.");
  for (const name of matches) {
    const candidate = path.join(directory, name);
    const entry = await lstat(candidate);
    if (!entry.isFile() || entry.isSymbolicLink())
      throw new Error("Runtime source partial is unsafe.");
    await unlink(candidate);
  }
}

export interface AcquireRuntimeSourcesOptions {
  readonly lock: RuntimeSourceLock;
  readonly outputDirectory: string;
  readonly fetchImplementation?: FetchImplementation;
  readonly timeoutMs?: number;
  /** Test-only synchronization seam; production callers omit it. */ readonly afterVerification?: (
    temporaryPath: string,
  ) => Promise<void> | void;
}

/** Fetch all pins; crash orphan partials are scavenged and only matching files are published. */
export async function acquireRuntimeSources(
  options: AcquireRuntimeSourcesOptions,
): Promise<readonly string[]> {
  const lock = parseRuntimeSourceLock(options.lock);
  const outputDirectory = path.resolve(options.outputDirectory);
  await createDirectoryComponentwise(outputDirectory);
  const outputLease = await trustedDirectory(outputDirectory);
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DEFAULT_TIMEOUT_MS)
    throw new Error("Runtime source timeout is invalid.");
  const results: string[] = [];
  try {
    for (const artifact of lock.artifacts) {
      await validateLease(outputLease);
      const targetPath = path.join(
        outputLease.path,
        `${artifact.target.os}-${artifact.target.arch}`,
      );
      await createDirectoryComponentwise(targetPath, outputLease);
      const targetLease = await trustedDirectory(targetPath, outputLease);
      await scavengeOrphans(targetLease.path, artifact.id);
      const finalPath = path.join(targetLease.path, archiveFileName(artifact));
      if (await lstat(finalPath).catch(() => null))
        throw new Error(`Runtime source archive already exists: ${artifact.id}`);
      const temporaryPath = path.join(targetLease.path, `.${artifact.id}.${randomUUID()}.partial`);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let published = false;
      try {
        const response = await fetchWithBoundedRedirects(
          new URL(artifact.url),
          fetchImplementation,
          controller.signal,
        );
        const verified = await writeVerifiedResponse(response, artifact, temporaryPath);
        try {
          await options.afterVerification?.(temporaryPath);
          await validateLease(targetLease);
          const temporary = await lstat(temporaryPath);
          if (
            !temporary.isFile() ||
            temporary.isSymbolicLink() ||
            !sameIdentity(identity(temporary), verified.identity)
          )
            throw new Error("Runtime source temporary file changed after verification.");
          await link(temporaryPath, finalPath);
          published = true;
          const final = await lstat(finalPath);
          if (
            !final.isFile() ||
            final.isSymbolicLink() ||
            !sameIdentity(identity(final), verified.identity)
          )
            throw new Error("Runtime source published file differs from verified temporary file.");
          await validateLease(targetLease);
          await unlink(temporaryPath);
          results.push(finalPath);
        } finally {
          await verified.handle.close();
        }
      } catch (error) {
        if (published) await unlink(finalPath).catch(() => undefined);
        await rm(temporaryPath, { force: true });
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }
  } catch (error) {
    await Promise.all(results.map((finalPath) => unlink(finalPath).catch(() => undefined)));
    throw error;
  }
  return Object.freeze(results);
}

function argumentsToOptions(arguments_: readonly string[]): {
  lockPath: string;
  outputDirectory: string;
} {
  if (arguments_.length !== 4 || arguments_[0] !== "--lock" || arguments_[2] !== "--output")
    throw new Error("Usage: --lock runtime-sources.lock.json --output directory");
  const [lockPath, outputDirectory] = [arguments_[1], arguments_[3]];
  if (!lockPath || !outputDirectory)
    throw new Error("A lock path and output directory are required.");
  return { lockPath, outputDirectory };
}
if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  const options = argumentsToOptions(process.argv.slice(2));
  const raw = await readFile(options.lockPath, "utf8");
  const archives = await acquireRuntimeSources({
    lock: parseRuntimeSourceLock(JSON.parse(raw) as unknown),
    outputDirectory: options.outputDirectory,
  });
  process.stdout.write(
    `Verified ${archives.length} desktop runtime source archives. Extraction is intentionally not performed.\n`,
  );
}
