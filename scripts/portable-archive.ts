import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { chmod, lstat, mkdir, open, rm, stat, type FileHandle } from "node:fs/promises";
import { arch, platform } from "node:os";
import path from "node:path";

import { portableDataPolicyV1 } from "../packages/database/src/portable-data.js";
import { withPreparedRestoreArchive } from "./backup-database.js";
import { maximumPortablePayloadBytes } from "./portable-payload.js";

const frameMagic = Buffer.from("SCHEDULE-PORTABLE\0", "ascii");
const frameVersion = 1;
const frameHeaderSize = frameMagic.length + 4 + 4 + 8;
const frameChecksumSize = 32;
const maximumManifestBytes = 256 * 1024;
export const maximumPortableArchiveBytes =
  frameHeaderSize + maximumManifestBytes + maximumPortablePayloadBytes + frameChecksumSize;

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

  await mkdir(path.dirname(resolvedOutput), { recursive: true, mode: 0o700 });
  let output: FileHandle | undefined;
  let source: FileHandle | undefined;
  let outputCreated = false;
  let completed = false;
  try {
    output = await open(resolvedOutput, "wx", 0o600);
    outputCreated = true;
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
    await output.sync();
    completed = true;
  } finally {
    await Promise.allSettled([source?.close(), output?.close()]);
    if (!completed && outputCreated) await rm(resolvedOutput, { force: true });
  }
  if (process.platform !== "win32") await chmod(resolvedOutput, 0o600);
  return { path: resolvedOutput, sizeBytes: (await stat(resolvedOutput)).size, manifest };
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
    const frame = await readPortableFrameMetadata(source, snapshotSize);
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
    const calculatedFrameHash = frameHash.digest();
    if (!timingSafeEqual(storedFrameHash, calculatedFrameHash)) {
      throw new Error("Portable archive checksum verification failed.");
    }
    if (payloadHash.digest("hex") !== manifest.data.payloadSha256) {
      throw new Error("Portable archive data payload checksum verification failed.");
    }

    sourcePosition = payloadOffset;
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
