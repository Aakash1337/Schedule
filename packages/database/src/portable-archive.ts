import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { link, lstat, mkdir, open, opendir, unlink, type FileHandle } from "node:fs/promises";
import { arch, platform } from "node:os";
import path from "node:path";

import { portableDataPolicyV1 } from "./portable-data.js";
import { withPreparedRestoreArchive } from "./portable-file.js";
import { maximumPortablePayloadBytes } from "./portable-payload.js";

const frameMagic = Buffer.from("SCHEDULE-PORTABLE\0", "ascii");
const frameVersion = 1;
const frameHeaderSize = frameMagic.length + 4 + 4 + 8;
const frameChecksumSize = 32;
const maximumManifestBytes = 256 * 1024;
export const maximumPortableArchiveBytes =
  frameHeaderSize + maximumManifestBytes + maximumPortablePayloadBytes + frameChecksumSize;
export const portableArchiveScavengeAgeMs = 24 * 60 * 60 * 1_000;
export const portableArchiveScavengeLimit = 32;
const portableArchiveScavengeEntryLimit = portableArchiveScavengeLimit * 8;
const temporaryOwnerMarkerSuffix = ".schedule-portable-owner-v1";
const temporaryOwnerMarkerV1 = "schedule-portable-archive-temporary\nversion=1\n";
const publicationIntentionSuffix = ".schedule-portable-publication-v1.intent";
const incompletePublicationHeaderV1 = Buffer.alloc(frameHeaderSize);
Buffer.from("SCHEDULE-PUBLISHING\0", "ascii").copy(incompletePublicationHeaderV1);
incompletePublicationHeaderV1.writeUInt32BE(1, frameHeaderSize - 4);
const incompletePublicationTailV1 = Buffer.from(
  "\nSCHEDULE-PORTABLE-PUBLICATION-INCOMPLETE\nversion=1\n",
  "ascii",
);

function publicationIntentionV1(
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

export const portableArchiveWarningsV1 = [
  "credentials_and_sessions_are_not_included",
  "external_deliveries_and_hosted_sync_state_are_not_included",
  "integrations_and_webhooks_must_be_reconnected",
] as const;

export interface PortableArchiveManifestV1 {
  readonly format: "schedule-portable";
  readonly formatVersion: 1;
  readonly archiveId: string;
  readonly createdAt: string;
  readonly producer: {
    readonly applicationVersion: string;
    readonly platform: string;
    readonly architecture: string;
    readonly postgresVersion: string;
  };
  readonly compatibility: {
    readonly policyRevision: 1;
    readonly schemaSignal: string;
    readonly migrationCount: number;
    readonly latestMigrationTag: string;
    readonly migrationFingerprint: string;
  };
  readonly data: {
    readonly encoding: "postgres-text-ndjson-v1";
    readonly tables: readonly string[];
    readonly sequences: readonly string[];
    readonly contentSignals: Readonly<Record<string, string>>;
    readonly sequenceSignals: Readonly<Record<string, string>>;
    readonly payloadBytes: number;
    readonly payloadSha256: string;
  };
  readonly warnings: typeof portableArchiveWarningsV1;
}

export type PortableArchiveManifestInputV1 = Omit<
  PortableArchiveManifestV1,
  "format" | "formatVersion" | "archiveId" | "createdAt" | "data" | "warnings"
> & {
  readonly archiveId?: string;
  readonly createdAt?: string;
  readonly data: Omit<
    PortableArchiveManifestV1["data"],
    "encoding" | "tables" | "sequences" | "payloadBytes" | "payloadSha256"
  >;
};

export interface PreparedPortableArchive {
  readonly sourcePath: string;
  readonly payloadPath: string;
  readonly manifest: PortableArchiveManifestV1;
  readonly sizeBytes: number;
}

type LinkOperation = (existingPath: string, newPath: string) => Promise<void>;
type UnlinkOperation = (target: string) => Promise<void>;
type DirectorySyncOperation = (parentPath: string, expected: BigIntStats) => Promise<void>;

export interface PortableArchivePublication {
  readonly method: "linked" | "copied";
  readonly parentPath: string;
  readonly parent: BigIntStats;
  readonly temporaryParentPath: string;
  readonly temporaryParent: BigIntStats;
  readonly temporary: BigIntStats;
  readonly destination: BigIntStats;
}

function isStale(metadata: BigIntStats, nowMs: number): boolean {
  return metadata.mtimeMs <= BigInt(Math.floor(nowMs - portableArchiveScavengeAgeMs));
}

function isSafeRegularFile(metadata: BigIntStats): boolean {
  return metadata.isFile() && !metadata.isSymbolicLink();
}

async function readStableRegularFile(filePath: string): Promise<{
  readonly bytes: Buffer;
  readonly metadata: BigIntStats;
} | null> {
  try {
    const before = await lstat(filePath, { bigint: true });
    if (!isSafeRegularFile(before)) return null;
    const file = await open(
      filePath,
      constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
    );
    try {
      const opened = await file.stat({ bigint: true });
      assertSameFile(before, opened, "Portable artifact changed before it could be inspected.");
      if (opened.size > 1024n) return null;
      const bytes = await readExact(file, Number(opened.size), 0, "an ownership marker");
      assertSameFile(
        opened,
        await file.stat({ bigint: true }),
        "Portable artifact changed while it was inspected.",
      );
      return { bytes, metadata: opened };
    } finally {
      await file.close();
    }
  } catch {
    return null;
  }
}

async function unchangedRegularFile(filePath: string, expected: BigIntStats): Promise<boolean> {
  try {
    const current = await lstat(filePath, { bigint: true });
    if (!isSafeRegularFile(current)) return false;
    assertSameFile(expected, current, "Portable artifact path identity changed.");
    return true;
  } catch {
    return false;
  }
}

async function captureParentDirectory(parentPath: string): Promise<BigIntStats> {
  const metadata = await lstat(parentPath, { bigint: true });
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Portable archive parent must be a non-symlink directory.");
  }
  return metadata;
}

async function parentIsUnchanged(parentPath: string, expected: BigIntStats): Promise<boolean> {
  try {
    const current = await lstat(parentPath, { bigint: true });
    if (!current.isDirectory() || current.isSymbolicLink()) return false;
    return expected.dev === current.dev && expected.ino === current.ino;
  } catch {
    return false;
  }
}

function filesystemErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

export function isUnsupportedHardLinkError(error: unknown): boolean {
  return ["ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EPERM", "EXDEV"].includes(
    filesystemErrorCode(error) ?? "",
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  expectedKeys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} has an unsupported field set.`);
  }
}

function assertBoundedString(
  value: unknown,
  label: string,
  maximumLength: number,
): asserts value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximumLength) {
    throw new Error(`${label} must be a non-empty string of at most ${maximumLength} characters.`);
  }
}

function assertExactStringArray(
  value: unknown,
  expected: readonly string[],
  label: string,
): asserts value is string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label} must be a string array.`);
  }
  if (JSON.stringify(value) !== JSON.stringify(expected)) {
    throw new Error(`${label} does not match portable data policy revision 1.`);
  }
}

function assertSignalMap(
  value: unknown,
  keys: readonly string[],
  pattern: RegExp,
  label: string,
): asserts value is Record<string, string> {
  if (
    !isRecord(value) ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())
  ) {
    throw new Error(`${label} must contain exactly the portable policy keys.`);
  }
  for (const [key, signal] of Object.entries(value)) {
    if (typeof signal !== "string" || !pattern.test(signal)) {
      throw new Error(`${label}.${key} is invalid.`);
    }
  }
}

export function assertPortableArchiveManifestV1(
  value: unknown,
): asserts value is PortableArchiveManifestV1 {
  if (!isRecord(value)) throw new Error("Portable archive manifest must be a JSON object.");
  assertExactKeys(
    value,
    [
      "format",
      "formatVersion",
      "archiveId",
      "createdAt",
      "producer",
      "compatibility",
      "data",
      "warnings",
    ],
    "Portable archive manifest",
  );
  if (value.format !== "schedule-portable" || value.formatVersion !== 1) {
    throw new Error("Portable archive format is not supported by this Schedule release.");
  }
  if (
    typeof value.archiveId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.archiveId)
  ) {
    throw new Error("Portable archive identifier is invalid.");
  }
  if (
    typeof value.createdAt !== "string" ||
    Number.isNaN(Date.parse(value.createdAt)) ||
    new Date(value.createdAt).toISOString() !== value.createdAt
  ) {
    throw new Error("Portable archive creation time must be canonical UTC ISO-8601.");
  }

  if (!isRecord(value.producer)) throw new Error("Portable archive producer is invalid.");
  assertExactKeys(
    value.producer,
    ["applicationVersion", "platform", "architecture", "postgresVersion"],
    "Portable archive producer",
  );
  assertBoundedString(value.producer.applicationVersion, "Producer application version", 80);
  assertBoundedString(value.producer.platform, "Producer platform", 40);
  assertBoundedString(value.producer.architecture, "Producer architecture", 40);
  assertBoundedString(value.producer.postgresVersion, "Producer PostgreSQL version", 160);

  if (!isRecord(value.compatibility)) {
    throw new Error("Portable archive compatibility metadata is invalid.");
  }
  assertExactKeys(
    value.compatibility,
    [
      "policyRevision",
      "schemaSignal",
      "migrationCount",
      "latestMigrationTag",
      "migrationFingerprint",
    ],
    "Portable archive compatibility metadata",
  );
  if (value.compatibility.policyRevision !== portableDataPolicyV1.revision) {
    throw new Error("Portable archive data policy is not supported by this Schedule release.");
  }
  if (
    typeof value.compatibility.schemaSignal !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.compatibility.schemaSignal)
  ) {
    throw new Error("Portable archive schema signal is invalid.");
  }
  if (
    !Number.isSafeInteger(value.compatibility.migrationCount) ||
    (value.compatibility.migrationCount as number) < 1
  ) {
    throw new Error("Portable archive migration count is invalid.");
  }
  if (
    typeof value.compatibility.latestMigrationTag !== "string" ||
    !/^\d{4}_[a-z0-9_-]+$/.test(value.compatibility.latestMigrationTag)
  ) {
    throw new Error("Portable archive latest migration tag is invalid.");
  }
  if (
    typeof value.compatibility.migrationFingerprint !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.compatibility.migrationFingerprint)
  ) {
    throw new Error("Portable archive migration fingerprint is invalid.");
  }

  if (!isRecord(value.data)) throw new Error("Portable archive data metadata is invalid.");
  assertExactKeys(
    value.data,
    [
      "encoding",
      "tables",
      "sequences",
      "contentSignals",
      "sequenceSignals",
      "payloadBytes",
      "payloadSha256",
    ],
    "Portable archive data metadata",
  );
  if (value.data.encoding !== "postgres-text-ndjson-v1") {
    throw new Error("Portable archive data encoding is not supported by this Schedule release.");
  }
  assertExactStringArray(value.data.tables, portableDataPolicyV1.includedTables, "Portable tables");
  assertExactStringArray(
    value.data.sequences,
    portableDataPolicyV1.sequences,
    "Portable sequences",
  );
  assertSignalMap(
    value.data.contentSignals,
    portableDataPolicyV1.includedTables,
    /^\d+:[0-9a-f]{32}$/,
    "Portable content signals",
  );
  assertSignalMap(
    value.data.sequenceSignals,
    portableDataPolicyV1.sequences,
    /^-?\d+:(?:true|false)$/,
    "Portable sequence signals",
  );
  if (
    !Number.isSafeInteger(value.data.payloadBytes) ||
    (value.data.payloadBytes as number) < 1 ||
    (value.data.payloadBytes as number) > maximumPortablePayloadBytes
  ) {
    throw new Error("Portable archive payload size is invalid.");
  }
  if (
    typeof value.data.payloadSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.data.payloadSha256)
  ) {
    throw new Error("Portable archive payload checksum is invalid.");
  }
  assertExactStringArray(value.warnings, portableArchiveWarningsV1, "Portable archive warnings");
}

async function writeAll(file: FileHandle, buffer: Buffer, position: number): Promise<number> {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await file.write(
      buffer,
      offset,
      buffer.length - offset,
      position + offset,
    );
    if (bytesWritten === 0) throw new Error("Could not write the complete portable archive.");
    offset += bytesWritten;
  }
  return position + buffer.length;
}

async function readExact(
  file: FileHandle,
  length: number,
  position: number,
  label: string,
): Promise<Buffer> {
  const result = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await file.read(result, offset, length - offset, position + offset);
    if (bytesRead === 0) throw new Error(`Portable archive ended while reading ${label}.`);
    offset += bytesRead;
  }
  return result;
}

async function digestFile(filePath: string): Promise<{ sizeBytes: number; sha256: string }> {
  const metadata = await lstat(filePath, { bigint: true });
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.size <= 0n) {
    throw new Error(`Portable payload must be a non-empty, non-symlink regular file: ${filePath}`);
  }
  if (metadata.size > BigInt(maximumPortablePayloadBytes)) {
    throw new Error(
      `Portable payload exceeds the ${maximumPortablePayloadBytes}-byte safety limit.`,
    );
  }
  const file = await open(
    filePath,
    constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
  );
  try {
    const opened = await file.stat({ bigint: true });
    assertSameFile(metadata, opened, "Portable payload changed before it could be read.");
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    const sizeBytes = Number(opened.size);
    while (position < sizeBytes) {
      const requested = Math.min(buffer.length, sizeBytes - position);
      const { bytesRead } = await file.read(buffer, 0, requested, position);
      if (bytesRead === 0) throw new Error("Portable payload changed while it was being read.");
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    assertSameFile(
      opened,
      await file.stat({ bigint: true }),
      "Portable payload changed while it was being read.",
    );
    return { sizeBytes, sha256: hash.digest("hex") };
  } finally {
    await file.close();
  }
}

function assertSameFile(first: BigIntStats, second: BigIntStats, message: string): void {
  if (
    first.dev !== second.dev ||
    first.ino !== second.ino ||
    first.size !== second.size ||
    first.mtimeNs !== second.mtimeNs ||
    first.ctimeNs !== second.ctimeNs
  ) {
    throw new Error(message);
  }
}

function isSameRegularIdentity(
  first: BigIntStats,
  second: BigIntStats,
  expectedSize: number,
): boolean {
  return (
    isSafeRegularFile(first) &&
    isSafeRegularFile(second) &&
    first.dev === second.dev &&
    first.ino === second.ino &&
    first.size === BigInt(expectedSize) &&
    second.size === BigInt(expectedSize)
  );
}

function isSameIdentity(first: BigIntStats, second: BigIntStats): boolean {
  return first.dev === second.dev && first.ino === second.ino;
}

async function syncParentDirectory(parentPath: string, expected: BigIntStats): Promise<void> {
  if (process.platform === "win32") return;
  const directory = await open(parentPath, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    const opened = await directory.stat({ bigint: true });
    if (!opened.isDirectory() || opened.dev !== expected.dev || opened.ino !== expected.ino) {
      throw new Error("Portable archive parent directory changed before it could be synced.");
    }
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Best-effort, bounded cleanup of stale archive build files bearing the v1 owner marker. */
export async function scavengePortableArchiveTemporaryFiles(
  outputPath: string,
  nowMs = Date.now(),
  maximumCandidates = portableArchiveScavengeLimit,
): Promise<number> {
  const candidateLimit = Number.isSafeInteger(maximumCandidates)
    ? Math.max(0, Math.min(maximumCandidates, portableArchiveScavengeLimit))
    : 0;
  if (!Number.isFinite(nowMs) || candidateLimit === 0) return 0;
  const resolvedOutput = path.resolve(outputPath);
  const parentPath = path.dirname(resolvedOutput);
  let parent: BigIntStats;
  try {
    parent = await captureParentDirectory(parentPath);
  } catch {
    return 0;
  }
  const base = path.basename(resolvedOutput);
  const markerPattern = new RegExp(
    `^\\.${escapeRegularExpression(base)}\\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.tmp${escapeRegularExpression(temporaryOwnerMarkerSuffix)}$`,
    "i",
  );
  let entriesInspected = 0;
  let candidatesExamined = 0;
  let removed = 0;
  try {
    const directory = await opendir(parentPath);
    for await (const entry of directory) {
      if (entriesInspected >= portableArchiveScavengeEntryLimit) break;
      entriesInspected += 1;
      if (!markerPattern.test(entry.name)) continue;
      if (candidatesExamined >= candidateLimit) break;
      candidatesExamined += 1;
      const markerPath = path.join(parentPath, entry.name);
      const marker = await readStableRegularFile(markerPath);
      if (
        marker === null ||
        !isStale(marker.metadata, nowMs) ||
        marker.bytes.toString("utf8") !== temporaryOwnerMarkerV1
      ) {
        continue;
      }
      const temporaryPath = markerPath.slice(0, -temporaryOwnerMarkerSuffix.length);
      let temporaryMetadata: BigIntStats | undefined;
      try {
        temporaryMetadata = await lstat(temporaryPath, { bigint: true });
      } catch (error) {
        if (filesystemErrorCode(error) !== "ENOENT") continue;
      }
      if (
        temporaryMetadata !== undefined &&
        (!isSafeRegularFile(temporaryMetadata) || !isStale(temporaryMetadata, nowMs))
      ) {
        continue;
      }
      if (temporaryMetadata !== undefined) {
        if (
          !(await parentIsUnchanged(parentPath, parent)) ||
          !(await unchangedRegularFile(temporaryPath, temporaryMetadata))
        ) {
          continue;
        }
        try {
          await unlink(temporaryPath);
        } catch {
          continue;
        }
      }
      if (
        !(await parentIsUnchanged(parentPath, parent)) ||
        !(await unchangedRegularFile(markerPath, marker.metadata))
      ) {
        continue;
      }
      try {
        await unlink(markerPath);
        removed += 1;
      } catch {
        // Best effort: a later export can retry this positively owned marker.
      }
    }
  } catch {
    // An unreadable or concurrently changed directory is deliberately preserved.
  }
  return removed;
}

export function createPortableArchiveManifestV1(
  input: PortableArchiveManifestInputV1,
  payload: { readonly sizeBytes: number; readonly sha256: string },
): PortableArchiveManifestV1 {
  const manifest: PortableArchiveManifestV1 = {
    format: "schedule-portable",
    formatVersion: 1,
    archiveId: input.archiveId ?? randomUUID(),
    createdAt: input.createdAt ?? new Date().toISOString(),
    producer: input.producer,
    compatibility: input.compatibility,
    data: {
      encoding: "postgres-text-ndjson-v1",
      tables: portableDataPolicyV1.includedTables,
      sequences: portableDataPolicyV1.sequences,
      contentSignals: input.data.contentSignals,
      sequenceSignals: input.data.sequenceSignals,
      payloadBytes: payload.sizeBytes,
      payloadSha256: payload.sha256,
    },
    warnings: portableArchiveWarningsV1,
  };
  assertPortableArchiveManifestV1(manifest);
  return manifest;
}

export async function writePortableArchive(
  outputPath: string,
  payloadPath: string,
  input: PortableArchiveManifestInputV1,
): Promise<{
  readonly path: string;
  readonly sizeBytes: number;
  readonly manifest: PortableArchiveManifestV1;
}> {
  const resolvedOutput = path.resolve(outputPath);
  const resolvedPayload = path.resolve(payloadPath);
  if (resolvedOutput === resolvedPayload)
    throw new Error("Portable archive output may not replace its payload input.");
  const payload = await digestFile(resolvedPayload);
  const manifest = createPortableArchiveManifestV1(input, payload);
  const manifestBytes = Buffer.from(JSON.stringify(manifest), "utf8");
  if (manifestBytes.length > maximumManifestBytes) {
    throw new Error("Portable archive manifest exceeds its safety limit.");
  }
  const header = Buffer.alloc(frameHeaderSize);
  frameMagic.copy(header, 0);
  header.writeUInt32BE(frameVersion, frameMagic.length);
  header.writeUInt32BE(manifestBytes.length, frameMagic.length + 4);
  header.writeBigUInt64BE(BigInt(payload.sizeBytes), frameMagic.length + 8);
  const archiveSize =
    frameHeaderSize + manifestBytes.length + payload.sizeBytes + frameChecksumSize;

  await mkdir(path.dirname(resolvedOutput), { recursive: true, mode: 0o700 });
  await scavengePortableArchiveTemporaryFiles(resolvedOutput);
  const parentPath = path.dirname(resolvedOutput);
  const parent = await captureParentDirectory(parentPath);
  const temporaryOutput = path.join(
    parentPath,
    `.${path.basename(resolvedOutput)}.${randomUUID()}.tmp`,
  );
  const temporaryMarker = `${temporaryOutput}${temporaryOwnerMarkerSuffix}`;
  let output: FileHandle | undefined;
  let source: FileHandle | undefined;
  let temporaryMarkerCreated = false;
  let temporaryMarkerMetadata: BigIntStats | undefined;
  let temporaryOutputCreated = false;
  let published = false;
  let publication: PortableArchivePublication | undefined;
  let temporaryMetadata: BigIntStats | undefined;
  let operationError: unknown;
  try {
    if (!(await parentIsUnchanged(parentPath, parent))) {
      throw new Error("Portable archive parent directory changed before publication.");
    }
    const marker = await open(temporaryMarker, "wx", 0o600);
    try {
      temporaryMarkerCreated = true;
      await writeAll(marker, Buffer.from(temporaryOwnerMarkerV1, "utf8"), 0);
      await marker.sync();
      temporaryMarkerMetadata = await marker.stat({ bigint: true });
    } finally {
      await marker.close();
    }
    await syncParentDirectory(parentPath, parent);
    if (!(await parentIsUnchanged(parentPath, parent))) {
      throw new Error("Portable archive parent directory changed before publication.");
    }
    output = await open(temporaryOutput, "wx", 0o600);
    temporaryOutputCreated = true;
    const createdTemporaryMetadata = await output.stat({ bigint: true });
    temporaryMetadata = createdTemporaryMetadata;
    source = await open(resolvedPayload, "r");
    const frameHash = createHash("sha256");
    const writtenDumpHash = createHash("sha256");
    frameHash.update(header);
    frameHash.update(manifestBytes);
    let outputPosition = await writeAll(output, header, 0);
    outputPosition = await writeAll(output, manifestBytes, outputPosition);
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let sourcePosition = 0;
    while (sourcePosition < payload.sizeBytes) {
      const requested = Math.min(buffer.length, payload.sizeBytes - sourcePosition);
      const { bytesRead } = await source.read(buffer, 0, requested, sourcePosition);
      if (bytesRead === 0)
        throw new Error("Portable payload changed while the archive was being written.");
      const chunk = buffer.subarray(0, bytesRead);
      frameHash.update(chunk);
      writtenDumpHash.update(chunk);
      outputPosition = await writeAll(output, chunk, outputPosition);
      sourcePosition += bytesRead;
    }
    if (writtenDumpHash.digest("hex") !== payload.sha256) {
      throw new Error("Portable payload changed while the archive was being written.");
    }
    await writeAll(output, frameHash.digest(), outputPosition);
    if (process.platform !== "win32") await output.chmod(0o600);
    await output.sync();
    await output.close();
    output = undefined;
    await source.close();
    source = undefined;
    temporaryMetadata = await lstat(temporaryOutput, { bigint: true });
    if (
      !isSameIdentity(createdTemporaryMetadata, temporaryMetadata) ||
      !isSafeRegularFile(temporaryMetadata) ||
      temporaryMetadata.size !== BigInt(archiveSize) ||
      createdTemporaryMetadata.size !== 0n
    ) {
      throw new Error("Portable archive temporary output changed before publication.");
    }
    if (!(await parentIsUnchanged(parentPath, parent))) {
      throw new Error("Portable archive parent directory changed before publication.");
    }
    publication = await publishPortableArchiveNoReplace(
      temporaryOutput,
      resolvedOutput,
      archiveSize,
    );
    published = true;
  } catch (error) {
    operationError = error;
    if (output !== undefined) {
      try {
        temporaryMetadata = await output.stat({ bigint: true });
      } catch {
        // Preserve the last handle-derived identity; guarded cleanup will revalidate it.
      }
    }
  }
  await Promise.allSettled([source?.close(), output?.close()]);

  let cleanupError: unknown;
  if (temporaryOutputCreated && temporaryMetadata !== undefined) {
    try {
      await finalizePortableArchivePublication(
        temporaryOutput,
        resolvedOutput,
        published,
        publication ?? {
          method: "copied",
          parentPath,
          parent,
          temporaryParentPath: parentPath,
          temporaryParent: parent,
          temporary: temporaryMetadata,
          destination: temporaryMetadata,
        },
      );
    } catch (error) {
      cleanupError = error;
    }
  }
  if (
    temporaryMarkerCreated &&
    temporaryMarkerMetadata !== undefined &&
    cleanupError === undefined
  ) {
    try {
      if (
        await removeUnchangedRegularFile(
          temporaryMarker,
          temporaryMarkerMetadata,
          parentPath,
          parent,
        )
      ) {
        await syncParentDirectory(parentPath, parent);
      }
    } catch {
      // A stale marker with no target is safe and will be scavenged by a later export.
    }
  }
  if (operationError !== undefined && cleanupError !== undefined) {
    throw new AggregateError(
      [operationError, cleanupError],
      "Portable archive publication failed and cleanup was incomplete.",
      { cause: operationError },
    );
  }
  if (operationError !== undefined) throw operationError;
  if (cleanupError !== undefined) throw cleanupError;
  return { path: resolvedOutput, sizeBytes: archiveSize, manifest };
}

interface PortableFrameMetadata {
  readonly header: Buffer;
  readonly manifestBytes: Buffer;
  readonly manifest: PortableArchiveManifestV1;
  readonly payloadOffset: number;
  readonly payloadLength: number;
}

async function readPortableFrameMetadata(
  source: FileHandle,
  sourceSize: number,
): Promise<PortableFrameMetadata> {
  const header = await readExact(source, frameHeaderSize, 0, "the frame header");
  if (!header.subarray(0, frameMagic.length).equals(frameMagic)) {
    throw new Error("File is not a Schedule portable archive.");
  }
  if (header.readUInt32BE(frameMagic.length) !== frameVersion) {
    throw new Error("Schedule portable archive frame version is not supported.");
  }
  const manifestLength = header.readUInt32BE(frameMagic.length + 4);
  const payloadLengthBigInt = header.readBigUInt64BE(frameMagic.length + 8);
  if (manifestLength < 1 || manifestLength > maximumManifestBytes) {
    throw new Error("Portable archive manifest length is invalid.");
  }
  if (payloadLengthBigInt < 1n || payloadLengthBigInt > BigInt(maximumPortablePayloadBytes)) {
    throw new Error("Portable archive payload length is invalid.");
  }
  const payloadLength = Number(payloadLengthBigInt);
  const expectedSize = frameHeaderSize + manifestLength + payloadLength + frameChecksumSize;
  if (sourceSize !== expectedSize) {
    throw new Error("Portable archive length does not match its frame header.");
  }
  const manifestBytes = await readExact(source, manifestLength, frameHeaderSize, "the manifest");
  let parsedManifest: unknown;
  try {
    parsedManifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes));
  } catch (error) {
    throw new Error(`Portable archive manifest is not valid UTF-8 JSON: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  assertPortableArchiveManifestV1(parsedManifest);
  if (parsedManifest.data.payloadBytes !== payloadLength) {
    throw new Error("Portable archive manifest and frame disagree about payload size.");
  }
  return {
    header,
    manifestBytes,
    manifest: parsedManifest,
    payloadOffset: frameHeaderSize + manifestLength,
    payloadLength,
  };
}

async function verifyOpenedPortableArchive(
  source: FileHandle,
  sourceSize: number,
): Promise<PortableFrameMetadata> {
  const frame = await readPortableFrameMetadata(source, sourceSize);
  const { header, manifestBytes, manifest, payloadOffset, payloadLength } = frame;
  const frameHash = createHash("sha256");
  const payloadHash = createHash("sha256");
  frameHash.update(header);
  frameHash.update(manifestBytes);
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let sourcePosition = payloadOffset;
  let payloadBytesRead = 0;
  while (payloadBytesRead < payloadLength) {
    const requested = Math.min(buffer.length, payloadLength - payloadBytesRead);
    const { bytesRead } = await source.read(buffer, 0, requested, sourcePosition);
    if (bytesRead === 0) throw new Error("Portable archive ended inside its data payload.");
    const chunk = buffer.subarray(0, bytesRead);
    frameHash.update(chunk);
    payloadHash.update(chunk);
    payloadBytesRead += bytesRead;
    sourcePosition += bytesRead;
  }
  const storedFrameHash = await readExact(
    source,
    frameChecksumSize,
    sourcePosition,
    "the checksum",
  );
  if (!timingSafeEqual(storedFrameHash, frameHash.digest())) {
    throw new Error("Portable archive checksum verification failed.");
  }
  if (payloadHash.digest("hex") !== manifest.data.payloadSha256) {
    throw new Error("Portable archive data payload checksum verification failed.");
  }
  return frame;
}

interface PublicationIntention {
  readonly path: string;
  readonly metadata: BigIntStats;
  readonly expectedSize: number;
}

async function readPublicationIntention(
  markerPath: string,
  destinationBase: string,
  publicationId: string,
): Promise<PublicationIntention | null> {
  const marker = await readStableRegularFile(markerPath);
  if (marker === null) return null;
  try {
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(marker.bytes),
    );
    if (!isRecord(value)) return null;
    assertExactKeys(
      value,
      ["format", "version", "destination", "expectedSize", "publicationId"],
      "Portable publication intention",
    );
    if (
      value.format !== "schedule-portable-publication" ||
      value.version !== 1 ||
      value.destination !== destinationBase ||
      value.publicationId !== publicationId ||
      !Number.isSafeInteger(value.expectedSize) ||
      (value.expectedSize as number) < frameHeaderSize + frameChecksumSize ||
      (value.expectedSize as number) > maximumPortableArchiveBytes ||
      marker.bytes.toString("utf8") !==
        publicationIntentionV1(destinationBase, value.expectedSize as number, publicationId)
    ) {
      return null;
    }
    return {
      path: markerPath,
      metadata: marker.metadata,
      expectedSize: value.expectedSize as number,
    };
  } catch {
    return null;
  }
}

async function removeUnchangedRegularFile(
  targetPath: string,
  expected: BigIntStats,
  parentPath: string,
  parent: BigIntStats,
  unlinkOperation: UnlinkOperation = unlink,
): Promise<boolean> {
  if (
    !(await parentIsUnchanged(parentPath, parent)) ||
    !(await unchangedRegularFile(targetPath, expected))
  ) {
    return false;
  }
  await unlinkOperation(targetPath);
  return true;
}

async function inspectOwnedIncompletePublication(
  destinationPath: string,
  expectedSize: number | undefined,
): Promise<BigIntStats | null> {
  let before: BigIntStats;
  try {
    before = await lstat(destinationPath, { bigint: true });
  } catch {
    return null;
  }
  if (!isSafeRegularFile(before)) return null;
  const archive = await open(
    destinationPath,
    constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
  );
  try {
    const opened = await archive.stat({ bigint: true });
    assertSameFile(before, opened, "Portable publication changed before inspection.");
    let owned = false;
    if (opened.size >= BigInt(frameHeaderSize)) {
      owned = (await readExact(archive, frameHeaderSize, 0, "the publication marker")).equals(
        incompletePublicationHeaderV1,
      );
    }
    if (!owned && opened.size >= BigInt(incompletePublicationTailV1.length)) {
      const tailPosition = Number(opened.size - BigInt(incompletePublicationTailV1.length));
      if (!Number.isSafeInteger(tailPosition)) return null;
      owned = (
        await readExact(
          archive,
          incompletePublicationTailV1.length,
          tailPosition,
          "the publication marker",
        )
      ).equals(incompletePublicationTailV1);
    }
    if (!owned) return null;
    const size = Number(opened.size);
    if (
      Number.isSafeInteger(size) &&
      size >= frameHeaderSize + frameChecksumSize &&
      size <= maximumPortableArchiveBytes
    ) {
      try {
        await verifyOpenedPortableArchive(archive, size);
        return null;
      } catch {
        // Exact incomplete ownership remains required below.
      }
    }
    if (
      expectedSize !== undefined &&
      opened.size > BigInt(expectedSize + incompletePublicationTailV1.length)
    ) {
      return null;
    }
    assertSameFile(
      opened,
      await archive.stat({ bigint: true }),
      "Portable publication changed during inspection.",
    );
    return opened;
  } catch {
    return null;
  } finally {
    await archive.close();
  }
}

async function isStableValidPortableArchive(
  archivePath: string,
  expected: BigIntStats,
  expectedSize: number,
): Promise<boolean> {
  if (expected.size !== BigInt(expectedSize)) return false;
  try {
    const archive = await open(
      archivePath,
      constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
    );
    try {
      const opened = await archive.stat({ bigint: true });
      assertSameFile(expected, opened, "Portable publication changed before validation.");
      await verifyOpenedPortableArchive(archive, expectedSize);
      assertSameFile(
        opened,
        await archive.stat({ bigint: true }),
        "Portable publication changed during validation.",
      );
      return true;
    } finally {
      await archive.close();
    }
  } catch {
    return false;
  }
}

/** Removes only stale, exact v1-owned publication artifacts using bounded, marker-first scans. */
export async function scavengePortableArchivePartialPublication(
  destinationPath: string,
  nowMs = Date.now(),
  directorySync: DirectorySyncOperation = syncParentDirectory,
): Promise<boolean> {
  if (!Number.isFinite(nowMs)) return false;
  const resolvedDestination = path.resolve(destinationPath);
  const parentPath = path.dirname(resolvedDestination);
  let parent: BigIntStats;
  try {
    parent = await captureParentDirectory(parentPath);
  } catch {
    return false;
  }
  const base = path.basename(resolvedDestination);
  const pattern = new RegExp(
    `^\\.${escapeRegularExpression(base)}\\.([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})${escapeRegularExpression(publicationIntentionSuffix)}$`,
    "i",
  );
  let inspected = 0;
  let candidates = 0;
  try {
    const directory = await opendir(parentPath);
    for await (const entry of directory) {
      if (inspected++ >= portableArchiveScavengeEntryLimit) break;
      const match = pattern.exec(entry.name);
      if (match === null || candidates++ >= portableArchiveScavengeLimit) continue;
      const intention = await readPublicationIntention(
        path.join(parentPath, entry.name),
        base,
        match[1] ?? "",
      );
      if (intention === null || !isStale(intention.metadata, nowMs)) continue;
      let destination: BigIntStats | null = null;
      try {
        const current = await lstat(resolvedDestination, { bigint: true });
        if (!isStale(current, nowMs)) continue;
        if (current.ctimeNs < intention.metadata.ctimeNs) continue;
        if (
          isSafeRegularFile(current) &&
          (await isStableValidPortableArchive(resolvedDestination, current, intention.expectedSize))
        ) {
          if (
            await removeUnchangedRegularFile(intention.path, intention.metadata, parentPath, parent)
          ) {
            await directorySync(parentPath, parent);
          }
          return false;
        }
        destination = await inspectOwnedIncompletePublication(
          resolvedDestination,
          intention.expectedSize,
        );
        if (destination === null) {
          if (
            await removeUnchangedRegularFile(intention.path, intention.metadata, parentPath, parent)
          ) {
            await directorySync(parentPath, parent);
          }
          return false;
        }
      } catch (error) {
        if (filesystemErrorCode(error) !== "ENOENT") continue;
      }
      if (
        destination !== null &&
        !(await removeUnchangedRegularFile(resolvedDestination, destination, parentPath, parent))
      ) {
        continue;
      }
      if (
        !(await removeUnchangedRegularFile(intention.path, intention.metadata, parentPath, parent))
      ) {
        continue;
      }
      await directorySync(parentPath, parent);
      return destination !== null;
    }
  } catch {
    return false;
  }

  // Backward-compatible recovery for durable inline v1 markers created before intentions existed.
  let before: BigIntStats;
  try {
    before = await lstat(resolvedDestination, { bigint: true });
  } catch {
    return false;
  }
  if (!isSafeRegularFile(before) || !isStale(before, nowMs)) return false;
  const owned = await inspectOwnedIncompletePublication(resolvedDestination, undefined);
  if (
    owned === null ||
    !(await removeUnchangedRegularFile(resolvedDestination, owned, parentPath, parent))
  ) {
    return false;
  }
  await directorySync(parentPath, parent);
  return true;
}

async function copyPortableArchiveCrashRecoverable(
  sourcePath: string,
  destinationPath: string,
  expectedSize: number,
  parentPath: string,
  parent: BigIntStats,
  directorySync: DirectorySyncOperation,
): Promise<{ readonly temporary: BigIntStats; readonly destination: BigIntStats }> {
  if (
    !Number.isSafeInteger(expectedSize) ||
    expectedSize < frameHeaderSize + frameChecksumSize ||
    expectedSize > maximumPortableArchiveBytes
  ) {
    throw new Error("Copied portable archive length is invalid.");
  }
  const sourceBefore = await lstat(sourcePath, { bigint: true });
  if (!isSafeRegularFile(sourceBefore) || sourceBefore.size !== BigInt(expectedSize)) {
    throw new Error("Copied portable archive source length is invalid.");
  }
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const source = await open(sourcePath, constants.O_RDONLY | noFollow);
  const publicationId = randomUUID();
  const intentionPath = path.join(
    parentPath,
    `.${path.basename(destinationPath)}.${publicationId}${publicationIntentionSuffix}`,
  );
  let intentionMetadata: BigIntStats | undefined;
  let destination: FileHandle | undefined;
  let destinationMetadata: BigIntStats | undefined;
  let operationError: unknown;
  try {
    assertSameFile(
      sourceBefore,
      await source.stat({ bigint: true }),
      "Portable archive source changed before publication.",
    );
    if (!(await parentIsUnchanged(parentPath, parent))) {
      throw new Error("Portable archive parent directory changed before publication.");
    }
    const intention = await open(intentionPath, "wx", 0o600);
    try {
      await writeAll(
        intention,
        Buffer.from(
          publicationIntentionV1(path.basename(destinationPath), expectedSize, publicationId),
          "utf8",
        ),
        0,
      );
      await intention.sync();
      intentionMetadata = await intention.stat({ bigint: true });
    } finally {
      await intention.close();
    }
    await directorySync(parentPath, parent);
    if (!(await parentIsUnchanged(parentPath, parent))) {
      throw new Error("Portable archive parent directory changed before publication.");
    }
    destination = await open(
      destinationPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | noFollow,
      0o600,
    );
    destinationMetadata = await destination.stat({ bigint: true });
    if (!isSafeRegularFile(destinationMetadata)) {
      throw new Error("Portable archive destination is not a regular file.");
    }
    await writeAll(destination, incompletePublicationHeaderV1, 0);
    await writeAll(destination, incompletePublicationTailV1, expectedSize);
    await destination.sync();

    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = frameHeaderSize;
    while (position < expectedSize) {
      const requested = Math.min(buffer.length, expectedSize - position);
      const { bytesRead } = await source.read(buffer, 0, requested, position);
      if (bytesRead === 0) throw new Error("Portable archive source changed during publication.");
      await writeAll(destination, buffer.subarray(0, bytesRead), position);
      position += bytesRead;
    }
    assertSameFile(
      sourceBefore,
      await source.stat({ bigint: true }),
      "Portable archive source changed during publication.",
    );
    await destination.sync();
    await writeAll(
      destination,
      await readExact(source, frameHeaderSize, 0, "the source frame header"),
      0,
    );
    await destination.sync();
    await destination.truncate(expectedSize);
    if (process.platform !== "win32") await destination.chmod(0o600);
    await destination.sync();
    await verifyOpenedPortableArchive(destination, expectedSize);
    destinationMetadata = await destination.stat({ bigint: true });
    const temporaryMetadata = await source.stat({ bigint: true });
    assertSameFile(
      sourceBefore,
      temporaryMetadata,
      "Portable archive source changed during publication.",
    );
    await directorySync(parentPath, parent);
    if (
      intentionMetadata === undefined ||
      !(await removeUnchangedRegularFile(intentionPath, intentionMetadata, parentPath, parent))
    ) {
      throw new Error("Portable publication intention changed before commit.");
    }
    intentionMetadata = undefined;
    await directorySync(parentPath, parent);
    return { temporary: temporaryMetadata, destination: destinationMetadata };
  } catch (error) {
    operationError = error;
    if (destination !== undefined) {
      try {
        destinationMetadata = await destination.stat({ bigint: true });
      } catch {
        // Preserve the last handle-derived identity; guarded cleanup will revalidate it.
      }
    }
  } finally {
    await Promise.allSettled([source.close(), destination?.close()]);
  }
  if (operationError === undefined) {
    throw new Error("Portable archive copy ended without a publication result.");
  }
  const cleanupErrors: unknown[] = [];
  let namespaceChanged = false;
  if (destinationMetadata !== undefined) {
    try {
      namespaceChanged =
        (await removeUnchangedRegularFile(
          destinationPath,
          destinationMetadata,
          parentPath,
          parent,
        )) || namespaceChanged;
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
  }
  if (intentionMetadata !== undefined) {
    try {
      namespaceChanged =
        (await removeUnchangedRegularFile(intentionPath, intentionMetadata, parentPath, parent)) ||
        namespaceChanged;
    } catch (cleanupError) {
      cleanupErrors.push(cleanupError);
    }
  }
  if (namespaceChanged) {
    await directorySync(parentPath, parent).catch((cleanupError) => {
      cleanupErrors.push(cleanupError);
    });
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      [operationError, ...cleanupErrors],
      "Copied portable archive validation failed and cleanup was incomplete.",
      { cause: operationError },
    );
  }
  throw operationError;
}

/**
 * Publishes without replacement. Hard links are atomic. The portable exclusive-copy fallback writes
 * durable v1 incomplete markers before bytes, commits the real header last, and removes the tail
 * marker only after the completed bytes are durable.
 */
export async function publishPortableArchiveNoReplace(
  temporaryPath: string,
  destinationPath: string,
  expectedSize: number,
  linkOperation: LinkOperation = link,
  directorySync: DirectorySyncOperation = syncParentDirectory,
): Promise<PortableArchivePublication> {
  if (
    !Number.isSafeInteger(expectedSize) ||
    expectedSize < frameHeaderSize + frameChecksumSize ||
    expectedSize > maximumPortableArchiveBytes
  ) {
    throw new Error("Published portable archive length is invalid.");
  }
  await scavengePortableArchivePartialPublication(destinationPath);
  const resolvedTemporary = path.resolve(temporaryPath);
  const resolvedDestination = path.resolve(destinationPath);
  const parentPath = path.dirname(resolvedDestination);
  const parent = await captureParentDirectory(parentPath);
  const temporaryParentPath = path.dirname(resolvedTemporary);
  const temporaryParent = await captureParentDirectory(temporaryParentPath);
  const temporaryBefore = await lstat(resolvedTemporary, { bigint: true });
  if (!isSafeRegularFile(temporaryBefore) || temporaryBefore.size !== BigInt(expectedSize)) {
    throw new Error("Portable archive temporary output is not the expected regular file.");
  }
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const temporaryHandle = await open(resolvedTemporary, constants.O_RDONLY | noFollow);
  let linkedDestination: BigIntStats | undefined;
  try {
    assertSameFile(
      temporaryBefore,
      await temporaryHandle.stat({ bigint: true }),
      "Portable archive temporary output changed before publication.",
    );
    if (!(await parentIsUnchanged(parentPath, parent))) {
      throw new Error("Portable archive parent directory changed before publication.");
    }
    if (!(await parentIsUnchanged(temporaryParentPath, temporaryParent))) {
      throw new Error("Portable archive temporary parent changed before publication.");
    }
    await linkOperation(resolvedTemporary, resolvedDestination);
    const temporaryAfter = await temporaryHandle.stat({ bigint: true });
    const destinationAfter = await lstat(resolvedDestination, { bigint: true });
    if (
      !isSameRegularIdentity(temporaryAfter, destinationAfter, expectedSize) ||
      temporaryAfter.mtimeNs !== temporaryBefore.mtimeNs
    ) {
      throw new Error("Portable archive hard-link destination does not match its source.");
    }
    linkedDestination = destinationAfter;
    await verifyOpenedPortableArchive(temporaryHandle, expectedSize);
    const temporaryVerified = await temporaryHandle.stat({ bigint: true });
    assertSameFile(
      temporaryAfter,
      temporaryVerified,
      "Portable archive temporary output changed during integrity verification.",
    );
    const temporaryPathAfter = await lstat(resolvedTemporary, { bigint: true });
    if (!isSameRegularIdentity(temporaryVerified, temporaryPathAfter, expectedSize)) {
      throw new Error("Portable archive temporary path changed during publication.");
    }
    await directorySync(parentPath, parent);
    return {
      method: "linked",
      parentPath,
      parent,
      temporaryParentPath,
      temporaryParent,
      temporary: temporaryPathAfter,
      destination: linkedDestination,
    };
  } catch (error) {
    if (linkedDestination !== undefined) {
      try {
        if (
          await removeUnchangedRegularFile(
            resolvedDestination,
            linkedDestination,
            parentPath,
            parent,
          )
        ) {
          await directorySync(parentPath, parent);
        }
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          "Portable archive hard-link rollback was incomplete.",
          { cause: cleanupError },
        );
      }
    }
    if (!isUnsupportedHardLinkError(error)) throw error;
  } finally {
    await temporaryHandle.close();
  }

  const copied = await copyPortableArchiveCrashRecoverable(
    resolvedTemporary,
    resolvedDestination,
    expectedSize,
    parentPath,
    parent,
    directorySync,
  );
  return {
    method: "copied",
    parentPath,
    parent,
    temporaryParentPath,
    temporaryParent,
    ...copied,
  };
}

export async function finalizePortableArchivePublication(
  temporaryPath: string,
  destinationPath: string,
  published: boolean,
  publication: PortableArchivePublication,
  unlinkOperation: UnlinkOperation = unlink,
  directorySync: DirectorySyncOperation = syncParentDirectory,
): Promise<void> {
  if (
    published &&
    (!(await parentIsUnchanged(publication.parentPath, publication.parent)) ||
      !(await unchangedRegularFile(destinationPath, publication.destination)))
  ) {
    throw new Error("Portable archive destination changed before publication cleanup.");
  }
  try {
    if (
      !(await removeUnchangedRegularFile(
        temporaryPath,
        publication.temporary,
        publication.temporaryParentPath,
        publication.temporaryParent,
        unlinkOperation,
      ))
    ) {
      throw new Error("Portable archive temporary path changed before cleanup.");
    }
    await directorySync(publication.temporaryParentPath, publication.temporaryParent);
    return;
  } catch (error) {
    if (!published) throw error;
    const errors: unknown[] = [error];
    // Once both names reference published bytes, a cleanup failure becomes an operation failure.
    // Best-effort removal of both names prevents returning success with duplicate archive names.
    for (const [target, metadata] of [
      [destinationPath, publication.destination],
      [temporaryPath, publication.temporary],
    ] as const) {
      try {
        const targetParentPath =
          target === temporaryPath ? publication.temporaryParentPath : publication.parentPath;
        const targetParent =
          target === temporaryPath ? publication.temporaryParent : publication.parent;
        if (
          !(await removeUnchangedRegularFile(
            target,
            metadata,
            targetParentPath,
            targetParent,
            unlinkOperation,
          ))
        ) {
          throw new Error("Portable archive cleanup target changed before removal.", {
            cause: error,
          });
        }
      } catch (cleanupError) {
        errors.push(cleanupError);
      }
    }
    for (const [targetParentPath, targetParent] of [
      [publication.parentPath, publication.parent],
      [publication.temporaryParentPath, publication.temporaryParent],
    ] as const) {
      await directorySync(targetParentPath, targetParent).catch((syncError) => {
        errors.push(syncError);
      });
    }
    throw new AggregateError(errors, "Portable archive publication cleanup failed.", {
      cause: error,
    });
  }
}

async function validateOpenedPortableArchive(
  source: FileHandle,
  metadata: BigIntStats,
): Promise<void> {
  if (metadata.size > BigInt(maximumPortableArchiveBytes)) {
    throw new Error(
      `Portable archive exceeds the ${maximumPortableArchiveBytes}-byte safety limit.`,
    );
  }
  await readPortableFrameMetadata(source, Number(metadata.size));
}

async function extractPortableArchive(
  sourcePath: string,
  snapshotPath: string,
  snapshotSize: number,
): Promise<PreparedPortableArchive> {
  const source = await open(snapshotPath, "r+");
  try {
    const frame = await verifyOpenedPortableArchive(source, snapshotSize);
    const { manifest, payloadOffset, payloadLength } = frame;
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let sourcePosition = payloadOffset;
    let destinationPosition = 0;
    while (destinationPosition < payloadLength) {
      const requested = Math.min(buffer.length, payloadLength - destinationPosition);
      const { bytesRead } = await source.read(buffer, 0, requested, sourcePosition);
      if (bytesRead === 0) throw new Error("Portable archive payload could not be prepared.");
      destinationPosition = await writeAll(
        source,
        buffer.subarray(0, bytesRead),
        destinationPosition,
      );
      sourcePosition += bytesRead;
    }
    await source.truncate(payloadLength);
    await source.sync();
    return { sourcePath, payloadPath: snapshotPath, manifest, sizeBytes: snapshotSize };
  } finally {
    await source.close();
  }
}

/*
 * The generic recovery snapshotter gives the importer immutable private bytes. Portable metadata is
 * inspected on that already-open source before any snapshot write, and the verified snapshot is
 * compacted in place to its payload so import needs only one bounded temporary copy.
 */
export async function withPreparedPortableArchive<Result>(
  archivePath: string,
  operation: (archive: PreparedPortableArchive) => Promise<Result>,
): Promise<Result> {
  return withPreparedRestoreArchive(
    archivePath,
    async ({ sourcePath, snapshotPath, sizeBytes }) => {
      const archive = await extractPortableArchive(sourcePath, snapshotPath, sizeBytes);
      return operation(archive);
    },
    {
      maximumSourceSizeBytes: maximumPortableArchiveBytes,
      validateOpenedSource: validateOpenedPortableArchive,
    },
  );
}

export function currentProducerPlatform(): Pick<
  PortableArchiveManifestV1["producer"],
  "platform" | "architecture"
> {
  return { platform: platform(), architecture: arch() };
}
