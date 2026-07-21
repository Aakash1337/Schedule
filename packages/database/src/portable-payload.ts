import { constants, type BigIntStats } from "node:fs";
import { chmod, lstat, mkdir, open, rm, stat, type FileHandle } from "node:fs/promises";
import path from "node:path";

import { portableDataPolicyV1, type PortableDataTableV1 } from "./portable-data.js";

export const maximumPortablePayloadBytes = 512 * 1024 * 1024;
const maximumPortableLineBytes = 16 * 1024 * 1024;
const payloadHeader = ["schedule-portable-data", 1] as const;

export interface PortableColumnDescriptor {
  readonly name: string;
  readonly type: string;
}

export type PortableColumnMap = Readonly<
  Record<PortableDataTableV1, readonly PortableColumnDescriptor[]>
>;

export type PortableTextValue = string | null;

export interface PortablePayloadConsumer {
  readonly beginTable?: (
    table: PortableDataTableV1,
    columns: readonly PortableColumnDescriptor[],
  ) => Promise<void>;
  readonly consumeRow?: (
    table: PortableDataTableV1,
    values: readonly PortableTextValue[],
  ) => Promise<void>;
  readonly endTable?: (table: PortableDataTableV1, rowCount: number) => Promise<void>;
}

export interface PortablePayloadExpectations {
  readonly columns: PortableColumnMap;
  readonly contentSignals: Readonly<Record<string, string>>;
  readonly sequenceSignals: Readonly<Record<string, string>>;
}

export interface PortablePayloadSource {
  readonly columns: PortableColumnMap;
  readonly rows: (
    table: PortableDataTableV1,
    columns: readonly PortableColumnDescriptor[],
  ) => AsyncIterable<readonly PortableTextValue[]>;
  readonly sequenceSignals: () => Promise<Readonly<Record<string, string>>>;
}

function sameFile(first: BigIntStats, second: BigIntStats): boolean {
  return (
    first.dev === second.dev &&
    first.ino === second.ino &&
    first.size === second.size &&
    first.mtimeNs === second.mtimeNs &&
    first.ctimeNs === second.ctimeNs
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertColumns(
  value: unknown,
  expected: readonly PortableColumnDescriptor[],
  table: PortableDataTableV1,
): void {
  if (!Array.isArray(value)) throw new Error(`Portable table ${table} columns are invalid.`);
  const parsed = value.map((column) => {
    if (!isRecord(column) || Object.keys(column).sort().join(",") !== "name,type") {
      throw new Error(`Portable table ${table} column metadata is invalid.`);
    }
    if (
      typeof column.name !== "string" ||
      !/^[a-z_][a-z0-9_]*$/.test(column.name) ||
      typeof column.type !== "string" ||
      column.type.length < 1 ||
      column.type.length > 160
    ) {
      throw new Error(`Portable table ${table} column metadata is invalid.`);
    }
    return { name: column.name, type: column.type };
  });
  if (JSON.stringify(parsed) !== JSON.stringify(expected)) {
    throw new Error(`Portable table ${table} columns do not match the local schema.`);
  }
}

function assertRowValues(
  value: unknown,
  columns: readonly PortableColumnDescriptor[],
  table: PortableDataTableV1,
): asserts value is PortableTextValue[] {
  if (
    !Array.isArray(value) ||
    value.length !== columns.length ||
    value.some((item) => item !== null && typeof item !== "string")
  ) {
    throw new Error(`Portable table ${table} row does not match its typed column list.`);
  }
}

function expectedRowCount(signal: string | undefined, table: PortableDataTableV1): number {
  const match = /^(\d+):[0-9a-f]{32}$/.exec(signal ?? "");
  const count = match?.[1] === undefined ? Number.NaN : Number(match[1]);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`Portable table ${table} content signal is invalid.`);
  }
  return count;
}

function parseSequenceSignal(signal: string | undefined, sequence: string): [string, boolean] {
  const match = /^(-?\d+):(true|false)$/.exec(signal ?? "");
  if (match?.[1] === undefined || match[2] === undefined) {
    throw new Error(`Portable sequence ${sequence} signal is invalid.`);
  }
  return [match[1], match[2] === "true"];
}

async function writeAll(file: FileHandle, bytes: Buffer, position: number): Promise<number> {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await file.write(
      bytes,
      offset,
      bytes.length - offset,
      position + offset,
    );
    if (bytesWritten === 0) throw new Error("Could not write the complete portable data payload.");
    offset += bytesWritten;
  }
  return position + bytes.length;
}

function encodeLine(value: unknown): Buffer {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
  if (bytes.length > maximumPortableLineBytes) {
    throw new Error(
      `Portable data line exceeds the ${maximumPortableLineBytes}-byte safety limit.`,
    );
  }
  return bytes;
}

export async function writePortablePayload(
  outputPath: string,
  source: PortablePayloadSource,
): Promise<{
  readonly path: string;
  readonly sizeBytes: number;
  readonly rowCounts: Readonly<Record<string, number>>;
  readonly sequenceSignals: Readonly<Record<string, string>>;
}> {
  const resolved = path.resolve(outputPath);
  await mkdir(path.dirname(resolved), { recursive: true, mode: 0o700 });
  let file: FileHandle | undefined;
  let created = false;
  let completed = false;
  let position = 0;
  const rowCounts: Record<string, number> = {};
  let writtenSequenceSignals: Readonly<Record<string, string>> | undefined;

  const writeLine = async (value: unknown): Promise<void> => {
    if (file === undefined) throw new Error("Portable data payload is not open.");
    const line = encodeLine(value);
    if (position + line.length > maximumPortablePayloadBytes) {
      throw new Error(
        `Portable data payload exceeds the ${maximumPortablePayloadBytes}-byte safety limit.`,
      );
    }
    position = await writeAll(file, line, position);
  };

  try {
    file = await open(resolved, "wx", 0o600);
    created = true;
    await writeLine(payloadHeader);
    for (const table of portableDataPolicyV1.includedTables) {
      const columns = source.columns[table];
      if (!Array.isArray(columns) || columns.length === 0) {
        throw new Error(`Portable table ${table} has no column metadata.`);
      }
      await writeLine(["table", table, columns]);
      let rowCount = 0;
      for await (const values of source.rows(table, columns)) {
        assertRowValues(values, columns, table);
        await writeLine(["row", values]);
        rowCount += 1;
        if (!Number.isSafeInteger(rowCount)) {
          throw new Error(`Portable table ${table} row count exceeds the safety limit.`);
        }
      }
      await writeLine(["end-table", table, rowCount]);
      rowCounts[table] = rowCount;
    }
    const sequenceSignals = await source.sequenceSignals();
    writtenSequenceSignals = sequenceSignals;
    for (const sequence of portableDataPolicyV1.sequences) {
      const [lastValue, isCalled] = parseSequenceSignal(sequenceSignals[sequence], sequence);
      await writeLine(["sequence", sequence, lastValue, isCalled]);
    }
    await writeLine(["end", 1]);
    await file.sync();
    completed = true;
  } finally {
    await file?.close();
    if (!completed && created) await rm(resolved, { force: true });
  }
  if (process.platform !== "win32") await chmod(resolved, 0o600);
  if (writtenSequenceSignals === undefined) {
    throw new Error("Portable data payload sequence state was not written.");
  }
  return {
    path: resolved,
    sizeBytes: (await stat(resolved)).size,
    rowCounts,
    sequenceSignals: writtenSequenceSignals,
  };
}

async function* boundedUtf8Lines(filePath: string): AsyncGenerator<string> {
  const pathMetadata = await lstat(filePath, { bigint: true });
  if (
    pathMetadata.isSymbolicLink() ||
    !pathMetadata.isFile() ||
    pathMetadata.size <= 0n ||
    pathMetadata.size > BigInt(maximumPortablePayloadBytes)
  ) {
    throw new Error("Portable data payload must be a bounded, non-empty regular file.");
  }
  const file = await open(
    filePath,
    constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
  );
  const opened = await file.stat({ bigint: true });
  if (!sameFile(pathMetadata, opened)) {
    await file.close();
    throw new Error("Portable data payload changed before it could be read.");
  }
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  let fragments: Buffer[] = [];
  let lineBytes = 0;
  try {
    while (position < Number(opened.size)) {
      const requested = Math.min(buffer.length, Number(opened.size) - position);
      const { bytesRead } = await file.read(buffer, 0, requested, position);
      if (bytesRead === 0) throw new Error("Portable data payload changed while it was read.");
      let start = 0;
      for (let index = 0; index < bytesRead; index += 1) {
        if (buffer[index] !== 0x0a) continue;
        const fragment = Buffer.from(buffer.subarray(start, index));
        fragments.push(fragment);
        lineBytes += fragment.length;
        if (lineBytes > maximumPortableLineBytes) {
          throw new Error(
            `Portable data line exceeds the ${maximumPortableLineBytes}-byte safety limit.`,
          );
        }
        yield decoder.decode(Buffer.concat(fragments, lineBytes));
        fragments = [];
        lineBytes = 0;
        start = index + 1;
      }
      if (start < bytesRead) {
        const fragment = Buffer.from(buffer.subarray(start, bytesRead));
        fragments.push(fragment);
        lineBytes += fragment.length;
        if (lineBytes > maximumPortableLineBytes) {
          throw new Error(
            `Portable data line exceeds the ${maximumPortableLineBytes}-byte safety limit.`,
          );
        }
      }
      position += bytesRead;
    }
    if (lineBytes !== 0 || fragments.length !== 0) {
      throw new Error("Portable data payload has an unterminated final line.");
    }
    if (!sameFile(opened, await file.stat({ bigint: true }))) {
      throw new Error("Portable data payload changed while it was read.");
    }
  } finally {
    await file.close();
  }
}

function parseLine(line: string): unknown[] {
  if (line.length === 0) throw new Error("Portable data payload contains an empty line.");
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch (error) {
    throw new Error("Portable data payload contains invalid JSON.", { cause: error });
  }
  if (!Array.isArray(value)) throw new Error("Portable data payload record must be an array.");
  return value;
}

export async function readPortablePayload(
  payloadPath: string,
  expected: PortablePayloadExpectations,
  consumer: PortablePayloadConsumer = {},
): Promise<void> {
  const iterator = boundedUtf8Lines(path.resolve(payloadPath))[Symbol.asyncIterator]();
  const nextRecord = async (): Promise<unknown[]> => {
    const result = await iterator.next();
    if (result.done) throw new Error("Portable data payload ended unexpectedly.");
    return parseLine(result.value);
  };

  if (JSON.stringify(await nextRecord()) !== JSON.stringify(payloadHeader)) {
    throw new Error("Portable data payload header is not supported.");
  }
  for (const table of portableDataPolicyV1.includedTables) {
    const columns = expected.columns[table];
    const tableHeader = await nextRecord();
    if (tableHeader.length !== 3 || tableHeader[0] !== "table" || tableHeader[1] !== table) {
      throw new Error(`Portable data payload is missing table ${table}.`);
    }
    assertColumns(tableHeader[2], columns, table);
    await consumer.beginTable?.(table, columns);
    let rowCount = 0;
    for (;;) {
      const record = await nextRecord();
      if (record[0] === "row") {
        if (record.length !== 2) throw new Error(`Portable table ${table} row record is invalid.`);
        assertRowValues(record[1], columns, table);
        await consumer.consumeRow?.(table, record[1]);
        rowCount += 1;
        if (!Number.isSafeInteger(rowCount)) {
          throw new Error(`Portable table ${table} row count exceeds the safety limit.`);
        }
        continue;
      }
      if (
        record.length !== 3 ||
        record[0] !== "end-table" ||
        record[1] !== table ||
        record[2] !== rowCount
      ) {
        throw new Error(`Portable table ${table} terminator is invalid.`);
      }
      break;
    }
    if (rowCount !== expectedRowCount(expected.contentSignals[table], table)) {
      throw new Error(`Portable table ${table} row count does not match the archive manifest.`);
    }
    await consumer.endTable?.(table, rowCount);
  }
  for (const sequence of portableDataPolicyV1.sequences) {
    const [lastValue, isCalled] = parseSequenceSignal(expected.sequenceSignals[sequence], sequence);
    const record = await nextRecord();
    if (
      record.length !== 4 ||
      record[0] !== "sequence" ||
      record[1] !== sequence ||
      record[2] !== lastValue ||
      record[3] !== isCalled
    ) {
      throw new Error(`Portable sequence ${sequence} does not match the archive manifest.`);
    }
  }
  if (JSON.stringify(await nextRecord()) !== JSON.stringify(["end", 1])) {
    throw new Error("Portable data payload terminator is invalid.");
  }
  const trailing = await iterator.next();
  if (!trailing.done) throw new Error("Portable data payload contains trailing records.");
}
