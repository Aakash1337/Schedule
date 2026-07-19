/** Download only the committed desktop runtime source archives; extraction is intentionally separate. */
import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, rm, unlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const OFFICIAL_ORIGINS = new Set(["https://nodejs.org", "https://ftp.postgresql.org"]);
const MAX_REDIRECTS = 3;
const DEFAULT_TIMEOUT_MS = 60_000;

type Target = Readonly<{ os: "windows" | "linux"; arch: "x64" }>;
export interface RuntimeSourceArtifact {
  readonly id: string;
  readonly component: "node" | "postgresql";
  readonly version: string;
  readonly target: Target;
  readonly kind: "runtime-binary" | "source";
  readonly url: string;
  readonly sha256: string;
  readonly format: "zip" | "tar.gz" | "tar.xz";
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
    actual.length === keys.length &&
    actual.every((key, index) => key === keys.slice().sort()[index])
  );
}

function safeRoot(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value) && value !== "." && value !== "..";
}

function assertOfficialArtifact(artifact: RuntimeSourceArtifact): void {
  const url = new URL(artifact.url);
  if (
    url.protocol !== "https:" ||
    !OFFICIAL_ORIGINS.has(url.origin) ||
    url.username ||
    url.password
  ) {
    throw new Error(
      `Runtime source ${artifact.id} does not use an approved official HTTPS origin.`,
    );
  }
  const expectedFile = path.posix.basename(url.pathname);
  const expectedExtension = artifact.format === "zip" ? ".zip" : `.${artifact.format}`;
  if (!expectedFile.endsWith(expectedExtension) || url.search || url.hash) {
    throw new Error(`Runtime source ${artifact.id} has an invalid archive URL.`);
  }
  if (artifact.component === "node") {
    const platform = artifact.target.os === "windows" ? "win" : "linux";
    if (
      url.origin !== "https://nodejs.org" ||
      artifact.kind !== "runtime-binary" ||
      artifact.extractedRoot !== `node-v${artifact.version}-${platform}-x64` ||
      expectedFile !== `node-v${artifact.version}-${platform}-x64${expectedExtension}`
    )
      throw new Error(`Runtime source ${artifact.id} is not a supported Node x64 release archive.`);
  } else if (
    url.origin !== "https://ftp.postgresql.org" ||
    artifact.kind !== "source" ||
    artifact.format !== "tar.gz" ||
    artifact.extractedRoot !== `postgresql-${artifact.version}` ||
    expectedFile !== `postgresql-${artifact.version}.tar.gz` ||
    url.pathname !== `/pub/source/v${artifact.version}/${expectedFile}`
  )
    throw new Error(`Runtime source ${artifact.id} is not a supported PostgreSQL source archive.`);
}

/** Parse only the canonical v1 lock shape. The checked-in lock is the hash trust anchor. */
export function parseRuntimeSourceLock(value: unknown): RuntimeSourceLock {
  if (
    !isRecord(value) ||
    !exactKeys(value, ["schemaVersion", "artifacts"]) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.artifacts)
  ) {
    throw new Error("Runtime source lock must be a canonical schema version 1 object.");
  }
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
    ) {
      throw new Error("Runtime source lock contains an unknown or missing artifact field.");
    }
    const target = candidate.target;
    if (
      !isRecord(target) ||
      !exactKeys(target, ["os", "arch"]) ||
      (target.os !== "windows" && target.os !== "linux") ||
      target.arch !== "x64"
    ) {
      throw new Error("Runtime source lock target is invalid.");
    }
    const artifact = candidate as unknown as RuntimeSourceArtifact;
    if (
      typeof artifact.id !== "string" ||
      !/^[a-z0-9-]{1,80}$/u.test(artifact.id) ||
      ids.has(artifact.id) ||
      (artifact.component !== "node" && artifact.component !== "postgresql") ||
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
    assertOfficialArtifact(artifact);
    return Object.freeze({
      ...artifact,
      target: Object.freeze({ os: target.os, arch: target.arch }),
    }) as RuntimeSourceArtifact;
  });
  const required = [
    "node-windows-x64",
    "postgresql-windows-x64-source",
    "node-linux-x64",
    "postgresql-linux-x64-source",
  ];
  if (artifacts.length !== required.length || !required.every((id) => ids.has(id)))
    throw new Error("Runtime source lock must pin exactly the supported Windows/Linux x64 inputs.");
  return Object.freeze({ schemaVersion: 1, artifacts: Object.freeze(artifacts) });
}

function archiveFileName(artifact: RuntimeSourceArtifact): string {
  const name = path.posix.basename(new URL(artifact.url).pathname);
  if (!/^[A-Za-z0-9._-]{1,180}$/u.test(name))
    throw new Error(`Runtime source ${artifact.id} has an unsafe archive name.`);
  return name;
}

async function fetchWithBoundedRedirects(
  url: string,
  fetchImplementation: FetchImplementation,
  signal: AbortSignal,
): Promise<Response> {
  let current = new URL(url);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    if (current.protocol !== "https:" || !OFFICIAL_ORIGINS.has(current.origin))
      throw new Error("Runtime source redirect left an approved official HTTPS origin.");
    const response = await fetchImplementation(current.href, { redirect: "manual", signal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (location === null || redirects === MAX_REDIRECTS)
        throw new Error("Runtime source redirect is missing or exceeds the bound.");
      current = new URL(location, current);
      continue;
    }
    return response;
  }
  throw new Error("Runtime source redirect exceeds the bound.");
}

async function writeVerifiedResponse(
  response: Response,
  artifact: RuntimeSourceArtifact,
  temporaryPath: string,
): Promise<void> {
  if (response.status !== 200 || response.body === null)
    throw new Error(`Runtime source ${artifact.id} did not return a complete archive.`);
  const encoding = response.headers.get("content-encoding");
  if (encoding !== null && encoding !== "identity")
    throw new Error(`Runtime source ${artifact.id} used an unsupported content encoding.`);
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/u.test(length) || Number(length) > artifact.maxBytes))
    throw new Error(`Runtime source ${artifact.id} exceeds its byte limit.`);
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
        const written = await handle.write(chunk, offset, chunk.byteLength - offset);
        offset += written.bytesWritten;
      }
    }
    if (length !== null && bytes !== Number(length))
      throw new Error(`Runtime source ${artifact.id} was truncated.`);
    if (digest.digest("hex") !== artifact.sha256)
      throw new Error(`Runtime source ${artifact.id} does not match its committed SHA-256.`);
  } finally {
    await handle.close();
  }
}

export interface AcquireRuntimeSourcesOptions {
  readonly lock: RuntimeSourceLock;
  readonly outputDirectory: string;
  readonly fetchImplementation?: FetchImplementation;
  readonly timeoutMs?: number;
}

/** Fetch every pinned archive to a no-replace, verified-only publication directory. */
export async function acquireRuntimeSources(
  options: AcquireRuntimeSourcesOptions,
): Promise<readonly string[]> {
  const lock = parseRuntimeSourceLock(options.lock);
  const outputDirectory = path.resolve(options.outputDirectory);
  const parent = await lstat(outputDirectory).catch(() => null);
  if (parent !== null && (!parent.isDirectory() || parent.isSymbolicLink()))
    throw new Error("Runtime source output must be a non-symlink directory.");
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const outputEntry = await lstat(outputDirectory);
  if (!outputEntry.isDirectory() || outputEntry.isSymbolicLink())
    throw new Error("Runtime source output must be a non-symlink directory.");
  const fetchImplementation = options.fetchImplementation ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > DEFAULT_TIMEOUT_MS)
    throw new Error("Runtime source timeout is invalid.");
  const results: string[] = [];
  for (const artifact of lock.artifacts) {
    const targetDirectory = path.join(
      outputDirectory,
      `${artifact.target.os}-${artifact.target.arch}`,
    );
    await mkdir(targetDirectory, { recursive: true, mode: 0o700 });
    const targetEntry = await lstat(targetDirectory);
    if (!targetEntry.isDirectory() || targetEntry.isSymbolicLink())
      throw new Error("Runtime source target directory is unsafe.");
    const finalPath = path.join(targetDirectory, archiveFileName(artifact));
    if (await lstat(finalPath).catch(() => null))
      throw new Error(`Runtime source archive already exists: ${artifact.id}`);
    const temporaryPath = path.join(targetDirectory, `.${artifact.id}.${randomUUID()}.partial`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchWithBoundedRedirects(
        artifact.url,
        fetchImplementation,
        controller.signal,
      );
      await writeVerifiedResponse(response, artifact, temporaryPath);
      await link(temporaryPath, finalPath); // creates the final path without replacing a concurrent publisher
      await unlink(temporaryPath);
      results.push(finalPath);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    } finally {
      clearTimeout(timer);
    }
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
