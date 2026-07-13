import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { migrate } from "drizzle-orm/postgres-js/migrator";

import { createDatabase, type DatabaseConnection } from "../src/index.js";

export async function verifyPlanStateMigrations(): Promise<void> {
  interface MigrationEntry {
    readonly idx: number;
    readonly version: string;
    readonly when: number;
    readonly tag: string;
    readonly breakpoints: boolean;
  }

  interface MigrationJournal {
    readonly version: string;
    readonly dialect: string;
    readonly entries: readonly MigrationEntry[];
  }

  const sourceDatabaseUrl =
    process.env.DATABASE_URL ?? "postgres://schedule:schedule@127.0.0.1:5432/schedule";
  const verificationDatabase = `schedule_plan_state_verify_${randomUUID().replaceAll("-", "")}`;
  const verificationDatabasePattern = /^schedule_plan_state_verify_[a-f0-9]{32}$/;
  const adminUrl = new URL(sourceDatabaseUrl);
  adminUrl.pathname = "/postgres";
  const verificationUrl = new URL(sourceDatabaseUrl);
  verificationUrl.pathname = `/${verificationDatabase}`;
  const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../drizzle");
  const admin = createDatabase(adminUrl.toString(), 1);
  let verification: DatabaseConnection | undefined;
  let verificationFailure: unknown;
  let historicalMigrationsFolder: string | undefined;

  const workspaceId = "00000000-0000-0000-0000-000000000100";
  const routineId = "00000000-0000-0000-0000-000000000101";
  const lowEventId = "00000000-0000-0000-0000-000000000102";
  const highEventId = "00000000-0000-0000-0000-000000000103";
  const newEventId = "00000000-0000-0000-0000-000000000104";
  const firstPlanId = "00000000-0000-0000-0000-000000000201";
  const secondPlanId = "00000000-0000-0000-0000-000000000202";
  const firstItemId = "00000000-0000-0000-0000-000000000301";
  const secondItemId = "00000000-0000-0000-0000-000000000302";

  function quotedVerificationDatabase(): string {
    if (!verificationDatabasePattern.test(verificationDatabase)) {
      throw new Error(`Unsafe disposable database identifier: ${verificationDatabase}`);
    }
    return `"${verificationDatabase}"`;
  }

  function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error));
  }

  function hasDatabaseCode(error: unknown, code: string): boolean {
    return (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === code
    );
  }

  async function expectDatabaseError(
    action: () => Promise<unknown>,
    code: string,
    label: string,
  ): Promise<void> {
    try {
      await action();
    } catch (error) {
      if (hasDatabaseCode(error, code)) return;
      throw error;
    }
    throw new Error(`${label} was accepted by the database`);
  }

  async function migrationJournal(): Promise<MigrationJournal> {
    const journal = JSON.parse(
      await readFile(path.join(migrationsFolder, "meta/_journal.json"), "utf8"),
    ) as Partial<MigrationJournal>;
    if (!Array.isArray(journal.entries)) throw new Error("Migration journal is missing entries");
    const entries = journal.entries.map((entry) => {
      if (
        typeof entry.idx !== "number" ||
        typeof entry.version !== "string" ||
        typeof entry.when !== "number" ||
        typeof entry.tag !== "string" ||
        typeof entry.breakpoints !== "boolean"
      ) {
        throw new Error("Migration journal contains an invalid entry");
      }
      return entry;
    });
    entries.forEach((entry, index) => {
      if (entry.idx !== index) throw new Error("Migration journal indices are not contiguous");
    });
    if (typeof journal.version !== "string" || journal.dialect !== "postgresql") {
      throw new Error("Migration journal header is invalid");
    }
    return { version: journal.version, dialect: journal.dialect, entries };
  }

  async function prepareHistoricalMigrations(journal: MigrationJournal): Promise<string> {
    const folder = await mkdtemp(path.join(tmpdir(), "schedule-plan-state-migrations-"));
    const metadataFolder = path.join(folder, "meta");
    await mkdir(metadataFolder, { recursive: true });
    const entries = journal.entries.filter((entry) => entry.idx <= 3);
    await writeFile(
      path.join(metadataFolder, "_journal.json"),
      `${JSON.stringify({ ...journal, entries }, null, 2)}\n`,
      "utf8",
    );
    await Promise.all(
      entries.map((entry) =>
        copyFile(
          path.join(migrationsFolder, `${entry.tag}.sql`),
          path.join(folder, `${entry.tag}.sql`),
        ),
      ),
    );
    return folder;
  }

  async function seedLegacyData(connection: DatabaseConnection): Promise<void> {
    await connection.sql.unsafe(`
      INSERT INTO workspaces (id, name)
      VALUES ('${workspaceId}', 'plan-state migration verification');

      INSERT INTO routines (
        id, workspace_id, title, minimum_duration_minutes, expected_duration_minutes,
        maximum_duration_minutes, cadence_period, target_completions
      ) VALUES (
        '${routineId}', '${workspaceId}', 'historical migration routine',
        15, 30, 45, 'week', 2
      );

      INSERT INTO activity_events (
        id, workspace_id, routine_id, type, occurred_at, local_date, time_zone,
        duration_minutes, idempotency_key, recorded_at
      ) VALUES
        (
          '${highEventId}', '${workspaceId}', '${routineId}', 'completed',
          '2026-01-02T12:00:00Z', '2026-01-02', 'UTC', 30,
          'historical-high-event', '2026-01-03T12:00:00Z'
        ),
        (
          '${lowEventId}', '${workspaceId}', '${routineId}', 'completed',
          '2026-01-01T12:00:00Z', '2026-01-01', 'UTC', 30,
          'historical-low-event', '2026-01-03T12:00:00Z'
        );

      INSERT INTO daily_plans (
        id, workspace_id, local_date, time_zone, request_revision, algorithm_version,
        config_version, prng_version, seed, input_hash, input_snapshot, total_minutes,
        fitness, generated_at, created_at, updated_at
      ) VALUES
        (
          '${firstPlanId}', '${workspaceId}', '2026-01-04', 'UTC', 1,
          'historical-v1', 'historical-v1', 'historical-v1', 'first-seed',
          '${"a".repeat(64)}', '{}'::jsonb, 30, 10, '2026-01-04T09:00:00Z',
          '2026-01-04T09:01:00Z', '2026-01-04T09:02:00Z'
        ),
        (
          '${secondPlanId}', '${workspaceId}', '2026-01-04', 'UTC', 2,
          'historical-v1', 'historical-v1', 'historical-v1', 'second-seed',
          '${"b".repeat(64)}', '{}'::jsonb, 30, 20, '2026-01-04T08:00:00Z',
          '2026-01-04T08:01:00Z', '2026-01-04T08:02:00Z'
        );

      INSERT INTO daily_plan_items (
        id, workspace_id, plan_id, routine_id, title_snapshot, position,
        window_index, scheduled_minutes, score, score_components, created_at
      ) VALUES
        (
          '${firstItemId}', '${workspaceId}', '${firstPlanId}', '${routineId}',
          'first historical item', 0, 0, 30, 10, '{}'::jsonb, '2026-01-04T08:00:00Z'
        ),
        (
          '${secondItemId}', '${workspaceId}', '${secondPlanId}', '${routineId}',
          'second historical item', 0, 0, 30, 20, '{}'::jsonb, '2026-01-04T09:00:00Z'
        );
    `);
  }

  try {
    await admin.sql.unsafe(`CREATE DATABASE ${quotedVerificationDatabase()} OWNER schedule`);
    verification = createDatabase(verificationUrl.toString(), 1);

    const journal = await migrationJournal();
    const entries = journal.entries;
    const migration0004 = entries.find((entry) => entry.idx === 4);
    const migration0005 = entries.find((entry) => entry.idx === 5);
    if (!migration0004 || !migration0005 || entries.length < 6) {
      throw new Error("Historical plan-state migrations 0004 and 0005 are missing");
    }

    historicalMigrationsFolder = await prepareHistoricalMigrations(journal);
    await migrate(verification.db, { migrationsFolder: historicalMigrationsFolder });
    const [historicalLedger] = await verification.sql<{ count: number; latest: string }[]>`
      SELECT count(*)::integer AS count, max(created_at)::text AS latest
      FROM drizzle.__drizzle_migrations
    `;
    assert.deepEqual(historicalLedger, {
      count: 4,
      latest: String(entries[3]?.when),
    });
    await rm(historicalMigrationsFolder, { recursive: true, force: true });
    historicalMigrationsFolder = undefined;
    await verification.sql`SET client_min_messages = warning`;
    await seedLegacyData(verification);

    const migration0004Sql = await readFile(
      path.join(migrationsFolder, `${migration0004.tag}.sql`),
      "utf8",
    );
    const bypassOn = migration0004Sql.indexOf(
      "set_config('schedule.allow_activity_event_mutation', 'on', true)",
    );
    const backfill = migration0004Sql.indexOf('UPDATE "activity_events"');
    const bypassOff = migration0004Sql.indexOf(
      "set_config('schedule.allow_activity_event_mutation', 'off', true)",
    );
    assert.ok(
      bypassOn >= 0 && bypassOn < backfill && backfill < bypassOff,
      "migration 0004 must scope its append-only bypass around only the historical backfill",
    );

    await migrate(verification.db, { migrationsFolder });
    const ledger = await verification.sql<{ hash: string; created_at: string }[]>`
      SELECT hash, created_at::text AS created_at
      FROM drizzle.__drizzle_migrations
      ORDER BY created_at, id
    `;
    assert.equal(ledger.length, entries.length);
    assert.deepEqual(ledger[4], {
      hash: createHash("sha256").update(migration0004Sql).digest("hex"),
      created_at: String(migration0004.when),
    });

    const sequencedEvents = await verification.sql<{ id: string; sequence: string }[]>`
      SELECT id, ingested_sequence::text AS sequence
      FROM activity_events
      ORDER BY ingested_sequence
    `;
    assert.deepEqual(
      [...sequencedEvents],
      [
        { id: lowEventId, sequence: "1" },
        { id: highEventId, sequence: "2" },
      ],
    );
    const [backfillSequence] = await verification.sql<{ value: string; is_called: boolean }[]>`
      SELECT last_value::text AS value, is_called
      FROM activity_events_ingested_sequence_seq
    `;
    assert.deepEqual(backfillSequence, { value: "3", is_called: false });
    const [catalogState] = await verification.sql<
      {
        sequence_not_null: boolean;
        owned_sequence: string | null;
        sequence_index_exists: boolean;
        revision_unique_exists: boolean;
      }[]
    >`
      SELECT
        attribute.attnotnull AS sequence_not_null,
        pg_get_serial_sequence('public.activity_events', 'ingested_sequence') AS owned_sequence,
        EXISTS(
          SELECT 1 FROM pg_indexes
          WHERE schemaname = 'public'
            AND indexname = 'activity_events_routine_sequence_idx'
        ) AS sequence_index_exists,
        EXISTS(
          SELECT 1
          FROM pg_constraint
          WHERE conrelid = 'public.daily_plans'::regclass
            AND conname = 'daily_plans_workspace_date_revision_uq'
            AND contype = 'u'
        ) AS revision_unique_exists
      FROM pg_attribute AS attribute
      WHERE attribute.attrelid = 'public.activity_events'::regclass
        AND attribute.attname = 'ingested_sequence'
        AND NOT attribute.attisdropped
    `;
    assert.deepEqual(catalogState, {
      sequence_not_null: true,
      owned_sequence: "public.activity_events_ingested_sequence_seq",
      sequence_index_exists: true,
      revision_unique_exists: true,
    });

    const [newEvent] = await verification.sql<{ sequence: string }[]>`
      INSERT INTO activity_events (
        id, workspace_id, routine_id, type, occurred_at, local_date, time_zone,
        duration_minutes, idempotency_key, recorded_at
      ) VALUES (
        ${newEventId}, ${workspaceId}, ${routineId}, 'completed',
        '2026-01-05T12:00:00Z', '2026-01-05', 'UTC', 30,
        'historical-new-event', '2026-01-05T12:00:00Z'
      )
      RETURNING ingested_sequence::text AS sequence
    `;
    assert.deepEqual(newEvent, { sequence: "3" });
    await expectDatabaseError(
      () =>
        verification!.sql`
          UPDATE activity_events SET metadata = '{"mutated":true}'::jsonb WHERE id = ${lowEventId}
        `,
      "55000",
      "post-backfill activity mutation",
    );

    const [head] = await verification.sql<
      {
        workspace_id: string;
        local_date: string;
        current_plan_id: string;
        version: number;
        created_at: string;
        updated_at: string;
      }[]
    >`
      SELECT workspace_id, local_date::text AS local_date, current_plan_id, version,
        created_at::text AS created_at, updated_at::text AS updated_at
      FROM daily_plan_heads
    `;
    assert.deepEqual(head, {
      workspace_id: workspaceId,
      local_date: "2026-01-04",
      current_plan_id: secondPlanId,
      version: 1,
      created_at: "2026-01-04 08:01:00+00",
      updated_at: "2026-01-04 08:02:00+00",
    });
    const itemStates = await verification.sql<
      { plan_id: string; item_id: string; locked: boolean; version: number; updated_at: string }[]
    >`
      SELECT plan_id, item_id, locked, version, updated_at::text AS updated_at
      FROM daily_plan_item_states
      ORDER BY plan_id
    `;
    assert.deepEqual(
      [...itemStates],
      [
        {
          plan_id: firstPlanId,
          item_id: firstItemId,
          locked: false,
          version: 1,
          updated_at: "2026-01-04 08:00:00+00",
        },
        {
          plan_id: secondPlanId,
          item_id: secondItemId,
          locked: false,
          version: 1,
          updated_at: "2026-01-04 09:00:00+00",
        },
      ],
    );

    const projectedStates = await verification.sql<
      {
        item_id: string;
        activity_state: string;
        last_activity_event_id: string | null;
        activity_updated_at: string | null;
      }[]
    >`
      SELECT item_id, activity_state::text AS activity_state,
        last_activity_event_id, activity_updated_at::text AS activity_updated_at
      FROM daily_plan_item_states
      ORDER BY item_id
    `;
    assert.deepEqual(
      [...projectedStates],
      [
        {
          item_id: firstItemId,
          activity_state: "pending",
          last_activity_event_id: null,
          activity_updated_at: null,
        },
        {
          item_id: secondItemId,
          activity_state: "pending",
          last_activity_event_id: null,
          activity_updated_at: null,
        },
      ],
    );
  } catch (error) {
    verificationFailure = error;
  }

  const cleanupFailures: Error[] = [];
  if (historicalMigrationsFolder !== undefined) {
    try {
      await rm(historicalMigrationsFolder, { recursive: true, force: true });
    } catch (error) {
      cleanupFailures.push(asError(error));
    }
  }
  try {
    await verification?.close();
  } catch (error) {
    cleanupFailures.push(asError(error));
  }
  try {
    await admin.sql.unsafe(`DROP DATABASE IF EXISTS ${quotedVerificationDatabase()} WITH (FORCE)`);
    const [remaining] = await admin.sql<{ exists: boolean }[]>`
      SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = ${verificationDatabase}) AS exists
    `;
    assert.equal(remaining?.exists, false, "historical migration database must be removed");
  } catch (error) {
    cleanupFailures.push(asError(error));
  }
  try {
    await admin.close();
  } catch (error) {
    cleanupFailures.push(asError(error));
  }

  if (cleanupFailures.length > 0) {
    throw new AggregateError(
      verificationFailure === undefined
        ? cleanupFailures
        : [verificationFailure, ...cleanupFailures],
      verificationFailure === undefined
        ? "Historical migration verification cleanup failed."
        : "Historical migration verification and cleanup both failed.",
      verificationFailure === undefined ? undefined : { cause: verificationFailure },
    );
  }
  if (verificationFailure !== undefined) throw verificationFailure;
  console.log(
    "Plan-state migration upgrade verification passed activity sequence and plan-state backfills.",
  );
}
