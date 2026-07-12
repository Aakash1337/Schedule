import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createDatabase, type DatabaseConnection } from "../packages/database/src/index.js";

const sourceDatabaseUrl =
  process.env.DATABASE_URL ?? "postgres://schedule:schedule@127.0.0.1:5432/schedule";
const adminUrl = new URL(sourceDatabaseUrl);
adminUrl.pathname = "/postgres";
const verificationDatabase = `schedule_weekday_verify_${randomUUID().replaceAll("-", "")}`;
const verificationUrl = new URL(sourceDatabaseUrl);
verificationUrl.pathname = `/${verificationDatabase}`;
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../packages/database/drizzle",
);
const admin = createDatabase(adminUrl.toString(), 1);
let verification: DatabaseConnection | undefined;

function hasDatabaseCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

async function expectCheckViolation(action: () => Promise<unknown>, label: string): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (hasDatabaseCode(error, "23514")) return;
    throw error;
  }
  throw new Error(`${label} was accepted by the database`);
}

async function applyMigration(connection: DatabaseConnection, tag: string): Promise<void> {
  const migration = await readFile(path.join(migrationsFolder, `${tag}.sql`), "utf8");
  for (const statement of migration.split("--> statement-breakpoint")) {
    if (statement.trim() !== "") await connection.sql.unsafe(statement);
  }
}

try {
  await admin.sql.unsafe(`CREATE DATABASE "${verificationDatabase}" OWNER schedule`);
  verification = createDatabase(verificationUrl.toString(), 1);

  const journal = JSON.parse(
    await readFile(path.join(migrationsFolder, "meta/_journal.json"), "utf8"),
  ) as { entries?: { idx?: unknown; tag?: unknown }[] };
  if (!Array.isArray(journal.entries)) throw new Error("Migration journal is missing entries");
  const tags = journal.entries.map((entry) => {
    if (typeof entry.idx !== "number" || typeof entry.tag !== "string") {
      throw new Error("Migration journal contains an invalid entry");
    }
    return { idx: entry.idx, tag: entry.tag };
  });

  for (const migration of tags.filter((entry) => entry.idx <= 11)) {
    await applyMigration(verification, migration.tag);
  }
  await verification.sql.unsafe(`
    INSERT INTO workspaces (id, name)
    VALUES ('00000000-0000-0000-0000-000000000012', 'weekday migration verification');
    INSERT INTO routines (
      id, workspace_id, title, minimum_duration_minutes, expected_duration_minutes,
      maximum_duration_minutes, cadence_period, target_completions,
      preferred_weekdays, excluded_weekdays
    ) VALUES (
      '00000000-0000-0000-0000-000000000012',
      '00000000-0000-0000-0000-000000000012',
      'legacy malformed weekdays', 15, 30, 45, 'week', 1,
      ARRAY[[7,1],[1,2]], ARRAY[[2,-1],[3,3]]
    );
  `);

  const migration0012 = tags.find((entry) => entry.idx === 12);
  const migration0013 = tags.find((entry) => entry.idx === 13);
  const migration0014 = tags.find((entry) => entry.idx === 14);
  if (migration0012 === undefined || migration0013 === undefined || migration0014 === undefined) {
    throw new Error("Weekday hardening migrations 0012 through 0014 are missing");
  }
  await applyMigration(verification, migration0012.tag);
  const [normalized] = await verification.sql<
    { preferred: string; excluded: string; preferred_dimensions: number }[]
  >`
    SELECT
      preferred_weekdays::text AS preferred,
      excluded_weekdays::text AS excluded,
      array_ndims(preferred_weekdays)::integer AS preferred_dimensions
    FROM routines
    WHERE id = '00000000-0000-0000-0000-000000000012'
  `;
  assert.deepEqual(normalized, {
    preferred: "{1}",
    excluded: "{2,3}",
    preferred_dimensions: 1,
  });

  await verification.sql.unsafe(`
    INSERT INTO routines (
      id, workspace_id, title, minimum_duration_minutes, expected_duration_minutes,
      maximum_duration_minutes, cadence_period, target_completions,
      preferred_weekdays, excluded_weekdays
    ) VALUES (
      '00000000-0000-0000-0000-000000000013',
      '00000000-0000-0000-0000-000000000012',
      'legacy multidimensional weekdays', 15, 30, 45, 'week', 1,
      ARRAY[[0,1],[4,5]], ARRAY[[2,3]]
    );
  `);
  await applyMigration(verification, migration0013.tag);
  const [flattened] = await verification.sql<
    {
      preferred: string;
      excluded: string;
      preferred_dimensions: number;
      excluded_dimensions: number;
    }[]
  >`
    SELECT
      preferred_weekdays::text AS preferred,
      excluded_weekdays::text AS excluded,
      array_ndims(preferred_weekdays)::integer AS preferred_dimensions,
      array_ndims(excluded_weekdays)::integer AS excluded_dimensions
    FROM routines
    WHERE id = '00000000-0000-0000-0000-000000000013'
  `;
  assert.deepEqual(flattened, {
    preferred: "{0,1,4,5}",
    excluded: "{2,3}",
    preferred_dimensions: 1,
    excluded_dimensions: 1,
  });

  await verification.sql.unsafe(`
    UPDATE routines
    SET
      preferred_weekdays = '[0:2]={0,1,4}'::integer[],
      excluded_weekdays = '[0:1]={2,3}'::integer[]
    WHERE id = '00000000-0000-0000-0000-000000000013';
  `);
  await applyMigration(verification, migration0014.tag);
  const [canonicalBounds] = await verification.sql<
    {
      preferred: string;
      excluded: string;
      preferred_lower_bound: number;
      excluded_lower_bound: number;
    }[]
  >`
    SELECT
      preferred_weekdays::text AS preferred,
      excluded_weekdays::text AS excluded,
      array_lower(preferred_weekdays, 1)::integer AS preferred_lower_bound,
      array_lower(excluded_weekdays, 1)::integer AS excluded_lower_bound
    FROM routines
    WHERE id = '00000000-0000-0000-0000-000000000013'
  `;
  assert.deepEqual(canonicalBounds, {
    preferred: "{0,1,4}",
    excluded: "{2,3}",
    preferred_lower_bound: 1,
    excluded_lower_bound: 1,
  });

  await expectCheckViolation(
    () =>
      verification!.sql.unsafe(
        "UPDATE routines SET preferred_weekdays = ARRAY[1,1] WHERE id = '00000000-0000-0000-0000-000000000013'",
      ),
    "duplicate weekday array",
  );
  await expectCheckViolation(
    () =>
      verification!.sql.unsafe(
        "UPDATE routines SET excluded_weekdays = ARRAY[8] WHERE id = '00000000-0000-0000-0000-000000000013'",
      ),
    "out-of-range weekday array",
  );
  await expectCheckViolation(
    () =>
      verification!.sql.unsafe(
        "UPDATE routines SET preferred_weekdays = ARRAY[2], excluded_weekdays = ARRAY[2] WHERE id = '00000000-0000-0000-0000-000000000013'",
      ),
    "overlapping weekday arrays",
  );
  await expectCheckViolation(
    () =>
      verification!.sql.unsafe(
        "UPDATE routines SET preferred_weekdays = ARRAY[[0,1],[4,5]] WHERE id = '00000000-0000-0000-0000-000000000013'",
      ),
    "multidimensional weekday array",
  );
  await expectCheckViolation(
    () =>
      verification!.sql.unsafe(
        "UPDATE routines SET preferred_weekdays = '[0:1]={0,1}'::integer[] WHERE id = '00000000-0000-0000-0000-000000000013'",
      ),
    "noncanonical lower-bound weekday array",
  );

  console.log("Weekday migration upgrade verification passed in a disposable database.");
} finally {
  await verification?.close();
  await admin.sql.unsafe(`DROP DATABASE IF EXISTS "${verificationDatabase}" WITH (FORCE)`);
  await admin.close();
}
