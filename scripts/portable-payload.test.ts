import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  portableDataPolicyV1,
  type PortableDataTableV1,
} from "../packages/database/src/portable-data.js";
import {
  type PortableColumnMap,
  readPortablePayload,
  writePortablePayload,
} from "./portable-payload.js";

async function inTemporaryDirectory<Result>(
  operation: (directory: string) => Promise<Result>,
): Promise<Result> {
  const directory = await mkdtemp(path.join(tmpdir(), "schedule-portable-payload-unit-"));
  try {
    return await operation(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function columns(): PortableColumnMap {
  return Object.fromEntries(
    portableDataPolicyV1.includedTables.map((table) => [
      table,
      [
        { name: "id", type: "uuid" },
        { name: "value", type: "text" },
      ],
    ]),
  ) as unknown as PortableColumnMap;
}

function contentSignals(count: number): Record<string, string> {
  return Object.fromEntries(
    portableDataPolicyV1.includedTables.map((table) => [table, `${count}:${"a".repeat(32)}`]),
  );
}

function sequenceSignals(): Record<string, string> {
  return Object.fromEntries(portableDataPolicyV1.sequences.map((sequence) => [sequence, "9:true"]));
}

describe("portable typed-text payload", () => {
  it("round-trips every table as non-executable typed values", async () => {
    await inTemporaryDirectory(async (directory) => {
      const payloadPath = path.join(directory, "portable-data.ndjson");
      const tableColumns = columns();
      const dangerousValue = "\\.\nDROP ROLE schedule;\t\\N\r\n'quoted'";
      await writePortablePayload(payloadPath, {
        columns: tableColumns,
        rows: async function* (table: PortableDataTableV1) {
          yield [
            `00000000-0000-0000-0000-${table.length.toString().padStart(12, "0")}`,
            dangerousValue,
          ];
        },
        sequenceSignals: async () => sequenceSignals(),
      });

      const consumed: (readonly (string | null)[])[] = [];
      await readPortablePayload(
        payloadPath,
        {
          columns: tableColumns,
          contentSignals: contentSignals(1),
          sequenceSignals: sequenceSignals(),
        },
        {
          consumeRow: async (_table, values) => {
            consumed.push(values);
          },
        },
      );
      expect(consumed).toHaveLength(portableDataPolicyV1.includedTables.length);
      expect(consumed[0]).toEqual(["00000000-0000-0000-0000-000000000015", dangerousValue]);
    });
  });

  it("rejects reordered tables, malformed rows, and trailing records", async () => {
    await inTemporaryDirectory(async (directory) => {
      const payloadPath = path.join(directory, "portable-data.ndjson");
      const tableColumns = columns();
      await writePortablePayload(payloadPath, {
        columns: tableColumns,
        rows: async function* () {
          yield [null, "value"];
        },
        sequenceSignals: async () => sequenceSignals(),
      });
      const original = await readFile(payloadPath, "utf8");
      const expected = {
        columns: tableColumns,
        contentSignals: contentSignals(1),
        sequenceSignals: sequenceSignals(),
      };

      await writeFile(
        payloadPath,
        original.replace('"table","activity_events"', '"table","audit_events"'),
      );
      await expect(readPortablePayload(payloadPath, expected)).rejects.toThrow(/activity_events/);

      await writeFile(payloadPath, original.replace('["row",[null,"value"]]', '["row",[1]]'));
      await expect(readPortablePayload(payloadPath, expected)).rejects.toThrow(/typed column list/);

      await writeFile(payloadPath, `${original}["row",[]]\n`);
      await expect(readPortablePayload(payloadPath, expected)).rejects.toThrow(/trailing/);
    });
  });
});
