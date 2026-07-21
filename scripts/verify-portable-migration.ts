import assert from "node:assert/strict";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import path from "node:path";

import { portableDataPolicyV1 } from "../packages/database/src/portable-data.js";
import {
  desktopVerificationClusterToken,
  desktopVerificationDatabaseName,
  desktopVerificationDatabaseOwnershipMarker,
  exportDesktopPortableScheduleData,
} from "../packages/database/src/desktop-portable.js";
import { assertComposeDatabaseReady, repositoryRoot } from "./backup-database.js";
import { withPreparedPortableArchive } from "./portable-archive.js";
import {
  exportPortableScheduleData,
  importPortableScheduleData,
  portableDatabaseSignals,
} from "./portable-database.js";
import {
  cleanupDisposableRecoveryDatabase,
  createDisposableRecoveryPlan,
  databaseAllowsConnections,
  databaseExists,
  databaseIdentity,
  disposableRecoveryDatabaseName,
  errorMessage,
  initializeDisposableRecoveryActiveDatabase,
  quoteIdentifier,
  type DisposableRecoveryPlan,
  type DisposableRecoveryRole,
  rollbackDisposableScheduleDatabase,
  runPsql,
} from "./restore-database.js";

const workspaceId = "10000000-0000-0000-0000-000000000001";
const destinationMarkerId = "20000000-0000-0000-0000-000000000001";
const hash = "a".repeat(64);
const dangerousText = "\\.\nDROP ROLE schedule;\t\\N";
const roles: readonly DisposableRecoveryRole[] = [
  "active",
  "staging",
  "previous",
  "rejected",
  "reference",
];

const portableFixtureSql = `
  BEGIN;
  INSERT INTO public.workspaces (id, name, created_at, updated_at)
  VALUES ('${workspaceId}', 'portable fixture', '2026-07-15T12:00:00Z', '2026-07-15T12:00:00Z');

  SET LOCAL session_replication_role = replica;
  INSERT INTO public.work_items (
    id, workspace_id, title, hosted_sync_cursor, created_at, updated_at
  ) VALUES
    ('10000000-0000-0000-0000-000000000002', '${workspaceId}', 'dependency source', 17, '2026-07-15T12:00:00Z', '2026-07-15T12:00:00Z'),
    ('10000000-0000-0000-0000-000000000003', '${workspaceId}', 'dependency target', 17, '2026-07-15T12:00:00Z', '2026-07-15T12:00:00Z');
  SET LOCAL session_replication_role = origin;

  INSERT INTO public.work_item_dependencies (
    workspace_id, prerequisite_work_item_id, dependent_work_item_id, created_at
  ) VALUES (
    '${workspaceId}', '10000000-0000-0000-0000-000000000002',
    '10000000-0000-0000-0000-000000000003', '2026-07-15T12:00:00Z'
  );
  INSERT INTO public.routines (
    id, workspace_id, title, minimum_duration_minutes, expected_duration_minutes,
    maximum_duration_minutes, cadence_period, target_completions,
    selection_preference_version, created_at, updated_at
  ) VALUES (
    '10000000-0000-0000-0000-000000000004', '${workspaceId}', 'routine', 30, 30,
    30, 'week', 1, 1, '2026-07-15T12:00:00Z', '2026-07-15T12:00:00Z'
  );
  INSERT INTO public.recurrence_series (
    id, workspace_id, rule, local_start, time_zone, duration_minutes, created_at, updated_at
  ) VALUES (
    '10000000-0000-0000-0000-000000000005', '${workspaceId}', 'FREQ=DAILY',
    '2026-07-15 09:00:00', 'UTC', 30, '2026-07-15T12:00:00Z', '2026-07-15T12:00:00Z'
  );
  INSERT INTO public.schedule_blocks (
    id, workspace_id, work_item_id, recurrence_series_id, starts_at, ends_at,
    time_zone, created_at, updated_at
  ) VALUES (
    '10000000-0000-0000-0000-000000000006', '${workspaceId}',
    '10000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000005',
    '2026-07-15T12:00:00Z', '2026-07-15T12:30:00Z', 'UTC',
    '2026-07-15T12:00:00Z', '2026-07-15T12:00:00Z'
  );
  INSERT INTO public.notification_profiles (workspace_id, time_zone, created_at, updated_at)
  VALUES ('${workspaceId}', 'UTC', '2026-07-15T12:00:00Z', '2026-07-15T12:00:00Z');
  INSERT INTO public.notification_rules (
    id, workspace_id, kind, local_minute, created_at, updated_at
  ) VALUES (
    '10000000-0000-0000-0000-000000000013', '${workspaceId}', 'daily_digest', 0,
    '2026-07-15T12:00:00Z', '2026-07-15T12:00:00Z'
  );
  INSERT INTO public.one_off_reminders (
    id, workspace_id, title, scheduled_for, created_at, updated_at
  ) VALUES (
    '10000000-0000-0000-0000-000000000014', '${workspaceId}',
    $portable_value$${dangerousText}$portable_value$,
    '2026-07-16T12:00:00.123456-04:00', '2026-07-15T12:00:00Z', '2026-07-15T12:00:00Z'
  );
  INSERT INTO public.daily_plans (
    id, workspace_id, local_date, time_zone, request_revision, algorithm_version,
    config_version, prng_version, seed, input_hash, input_snapshot, total_minutes,
    fitness, generated_at, created_at, updated_at
  ) VALUES (
    '10000000-0000-0000-0000-000000000007', '${workspaceId}', '2026-07-15', 'UTC',
    1, 'v1', 'v1', 'v1', 'seed', '${hash}', '{}'::jsonb, 30, 1,
    '2026-07-15T12:00:00Z', '2026-07-15T12:00:00Z', '2026-07-15T12:00:00Z'
  );
  INSERT INTO public.daily_plan_heads (
    id, workspace_id, local_date, current_plan_id, created_at, updated_at
  ) VALUES (
    '10000000-0000-0000-0000-000000000008', '${workspaceId}', '2026-07-15',
    '10000000-0000-0000-0000-000000000007', '2026-07-15T12:00:00Z', '2026-07-15T12:00:00Z'
  );
  INSERT INTO public.daily_plan_items (
    id, workspace_id, plan_id, source_type, routine_id, title_snapshot, position,
    window_index, scheduled_minutes, score, score_components, created_at
  ) VALUES (
    '10000000-0000-0000-0000-000000000009', '${workspaceId}',
    '10000000-0000-0000-0000-000000000007', 'routine',
    '10000000-0000-0000-0000-000000000004', 'routine', 0, 0, 30, 1, '{}'::jsonb,
    '2026-07-15T12:00:00Z'
  );
  INSERT INTO public.activity_events (
    id, workspace_id, source_type, routine_id, plan_id, plan_item_id, type,
    occurred_at, local_date, time_zone, duration_minutes, idempotency_key, recorded_at
  ) VALUES (
    '10000000-0000-0000-0000-000000000010', '${workspaceId}', 'routine',
    '10000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000007',
    '10000000-0000-0000-0000-000000000009', 'completed', '2026-07-15T12:00:00Z',
    '2026-07-15', 'UTC', 30, 'activity', '2026-07-15T12:00:00Z'
  );
  INSERT INTO public.daily_plan_item_states (
    id, workspace_id, plan_id, item_id, updated_at
  ) VALUES (
    '10000000-0000-0000-0000-000000000015', '${workspaceId}',
    '10000000-0000-0000-0000-000000000007', '10000000-0000-0000-0000-000000000009',
    '2026-07-15T12:00:00Z'
  );
  INSERT INTO public.routine_planning_feedback_events (
    id, workspace_id, routine_id, kind, effective_on, effective_through, time_zone,
    source_plan_id, source_plan_item_id, idempotency_key, recorded_at
  ) VALUES (
    '10000000-0000-0000-0000-000000000018', '${workspaceId}',
    '10000000-0000-0000-0000-000000000004', 'not_today', '2026-07-15', '2026-07-15',
    'UTC', '10000000-0000-0000-0000-000000000007',
    '10000000-0000-0000-0000-000000000009', 'planning', '2026-07-15T12:00:00Z'
  );
  INSERT INTO public.routine_selection_preference_feedback_events (
    id, workspace_id, routine_id, feedback_version, kind, effective_on, time_zone,
    idempotency_key, recorded_at
  ) VALUES (
    '10000000-0000-0000-0000-000000000019', '${workspaceId}',
    '10000000-0000-0000-0000-000000000004', 1, 'reset', '2026-07-15', 'UTC',
    'selection', '2026-07-15T12:00:00Z'
  );
  INSERT INTO public.routine_duration_insight_feedback_events (
    id, workspace_id, routine_id, insight_key, kind, routine_version,
    observed_median_minutes, idempotency_key, recorded_at
  ) VALUES (
    '10000000-0000-0000-0000-000000000020', '${workspaceId}',
    '10000000-0000-0000-0000-000000000004', '${hash}', 'dismissed', 1, 30,
    'duration', '2026-07-15T12:00:00Z'
  );
  INSERT INTO public.daily_plan_fit_insight_feedback_events (
    id, workspace_id, for_date, insight_key, kind, sample_count,
    typical_planned_minutes, typical_completed_minutes, typical_planned_task_count,
    typical_completed_task_count, suggested_target_minutes, suggested_target_task_count,
    idempotency_key, recorded_at
  ) VALUES (
    '10000000-0000-0000-0000-000000000021', '${workspaceId}', '2026-07-15',
    '${hash}', 'dismissed', 1, 30, 30, 1, 1, 30, 1, 'fit', '2026-07-15T12:00:00Z'
  );
  INSERT INTO public.plan_interaction_events (
    id, workspace_id, local_date, plan_id, item_id, type, idempotency_key,
    payload_hash, result_head_version, recorded_at
  ) VALUES (
    '10000000-0000-0000-0000-000000000016', '${workspaceId}', '2026-07-15',
    '10000000-0000-0000-0000-000000000007', '10000000-0000-0000-0000-000000000009',
    'locked', 'interaction', '${hash}', 1, '2026-07-15T12:00:00Z'
  );
  INSERT INTO public.plan_mutations (
    id, workspace_id, local_date, idempotency_key, payload_hash, kind,
    source_plan_id, result_plan_id, result_head_version, created_at
  ) VALUES (
    '10000000-0000-0000-0000-000000000017', '${workspaceId}', '2026-07-15',
    'mutation', '${hash}', 'feedback', '10000000-0000-0000-0000-000000000007',
    '10000000-0000-0000-0000-000000000007', 1, '2026-07-15T12:00:00Z'
  );
  INSERT INTO public.natural_language_proposals (
    id, workspace_id, request_id, prompt_hash, command_hash, command_display, command,
    provider, status, expires_at, version, created_at, updated_at
  ) VALUES (
    '10000000-0000-0000-0000-000000000011', '${workspaceId}',
    '10000000-0000-0000-0000-000000000022', '${hash}', '${hash}', 'create AI task',
    '{"type":"work_item.create","title":"AI task","exact":123456789012345678901234567890.123456789}'::jsonb,
    'local', 'pending',
    '2026-07-15T12:10:00Z', 1, '2026-07-15T12:00:00Z', '2026-07-15T12:00:00Z'
  );
  INSERT INTO public.webhook_endpoints (
    id, workspace_id, name, url, status, created_at, updated_at
  ) VALUES (
    '10000000-0000-0000-0000-000000000012', '${workspaceId}', 'endpoint',
    'https://example.test/hook', 'active', '2026-07-15T12:00:00Z', '2026-07-15T12:00:00Z'
  );
  INSERT INTO public.webhook_event_subscriptions (
    workspace_id, endpoint_id, event_type, created_at
  ) VALUES (
    '${workspaceId}', '10000000-0000-0000-0000-000000000012',
    'schedule.changed.v1', '2026-07-15T12:00:00Z'
  );
  INSERT INTO public.audit_events (
    id, workspace_id, actor_id, action, entity_type, entity_id, data, occurred_at
  ) VALUES (
    '10000000-0000-0000-0000-000000000023', '${workspaceId}',
    '10000000-0000-0000-0000-000000000024', 'fixture.action', 'fixture',
    '10000000-0000-0000-0000-000000000002', '{}'::jsonb, '2026-07-15T12:00:00Z'
  );

  INSERT INTO public.integration_credentials (
    id, workspace_id, name, secret_digest, scopes, created_at, updated_at
  ) VALUES (
    '10000000-0000-0000-0000-000000000025', '${workspaceId}', 'excluded credential',
    '${hash}', ARRAY['schedule:read'], '2026-07-15T12:00:00Z', '2026-07-15T12:00:00Z'
  );
  INSERT INTO public.webhook_endpoint_secrets (
    id, workspace_id, endpoint_id, version, status, secret_envelope, created_at
  ) VALUES (
    '10000000-0000-0000-0000-000000000026', '${workspaceId}',
    '10000000-0000-0000-0000-000000000012', 1, 'pending',
    jsonb_build_object(
      'version', 'v1', 'masterKeyId', 'fixture', 'nonce', 'abcdefghijklmnop',
      'ciphertext', 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ',
      'tag', 'abcdefghijklmnopqrstuv'
    ), '2026-07-15T12:00:00Z'
  );
  SELECT pg_catalog.setval(
    'public.activity_events_ingested_sequence_seq'::regclass,
    9007199254740993,
    true
  );
  COMMIT;
`;

async function cleanupPlan(plan: DisposableRecoveryPlan): Promise<Error[]> {
  const failures: Error[] = [];
  for (const role of roles) {
    const databaseName = disposableRecoveryDatabaseName(plan, role);
    try {
      if (await databaseExists(databaseName)) {
        await cleanupDisposableRecoveryDatabase(plan, role);
      }
    } catch (error) {
      failures.push(
        new Error(`cleanup ${role} database ${databaseName}: ${errorMessage(error)}`, {
          cause: error,
        }),
      );
    }
  }
  return failures;
}

async function inspectLockedDatabase<Result>(
  databaseName: string,
  operation: () => Promise<Result>,
): Promise<Result> {
  assert.equal(await databaseAllowsConnections(databaseName), false);
  await runPsql(
    "postgres",
    `ALTER DATABASE ${quoteIdentifier(databaseName)} WITH ALLOW_CONNECTIONS true;`,
  );
  try {
    return await operation();
  } finally {
    await runPsql(
      "postgres",
      `ALTER DATABASE ${quoteIdentifier(databaseName)} WITH ALLOW_CONNECTIONS false;`,
    );
  }
}

async function portableRowCounts(databaseName: string): Promise<Record<string, number>> {
  const query = portableDataPolicyV1.includedTables
    .map((table) => `SELECT '${table}=' || count(*)::text FROM public.${quoteIdentifier(table)}`)
    .join("\nUNION ALL\n");
  return Object.fromEntries(
    (await runPsql(databaseName, query, { quiet: true }))
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
      .map((row) => {
        const [table, count] = row.split("=");
        assert.notEqual(table, undefined);
        assert.match(count ?? "", /^\d+$/);
        return [table as string, Number(count)];
      }),
  );
}

async function assertPortableSequenceCoverage(databaseName: string): Promise<void> {
  const includedTables = portableDataPolicyV1.includedTables
    .map((table) => `'${table}'`)
    .join(", ");
  const actual = (
    await runPsql(
      databaseName,
      `SELECT sequence.relname
       FROM pg_catalog.pg_class AS sequence
       JOIN pg_catalog.pg_namespace AS sequence_schema
         ON sequence_schema.oid = sequence.relnamespace
       JOIN pg_catalog.pg_depend AS dependency ON dependency.objid = sequence.oid
       JOIN pg_catalog.pg_class AS owning_table ON owning_table.oid = dependency.refobjid
       JOIN pg_catalog.pg_namespace AS table_schema
         ON table_schema.oid = owning_table.relnamespace
       WHERE sequence.relkind = 'S'
         AND sequence_schema.nspname = 'public'
         AND table_schema.nspname = 'public'
         AND dependency.deptype IN ('a', 'i')
         AND owning_table.relname IN (${includedTables})
       ORDER BY sequence.relname;`,
      { quiet: true },
    )
  )
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  assert.deepEqual(actual, [...portableDataPolicyV1.sequences].sort());
}

async function produceArchive(archivePath: string): Promise<void> {
  const sourcePlan = createDisposableRecoveryPlan();
  const verificationFixtures: string[] = [];
  let failure: unknown;
  try {
    await initializeDisposableRecoveryActiveDatabase(sourcePlan);
    await assertPortableSequenceCoverage(sourcePlan.activeDatabase);
    await runPsql(sourcePlan.activeDatabase, portableFixtureSql);
    const expectedSignals = await portableDatabaseSignals(sourcePlan.activeDatabase);
    await runPsql(
      "postgres",
      `ALTER DATABASE ${quoteIdentifier(sourcePlan.activeDatabase)} SET TIME ZONE 'Pacific/Chatham';`,
    );
    assert.deepEqual(
      await portableDatabaseSignals(sourcePlan.activeDatabase),
      expectedSignals,
      "portable signals must not depend on the database session time zone",
    );
    const rejectedArchive = `${archivePath}.schema-drift`;
    try {
      await runPsql(
        sourcePlan.activeDatabase,
        `ALTER TABLE public.workspaces ENABLE ROW LEVEL SECURITY;
         ALTER TABLE public.workspaces FORCE ROW LEVEL SECURITY;
         CREATE POLICY portable_verifier_drift ON public.workspaces USING (true);`,
      );
      await assert.rejects(
        exportPortableScheduleData(rejectedArchive, sourcePlan.activeDatabase),
        /schema does not exactly match/i,
        "portable export must reject RLS and row-policy schema drift",
      );
    } finally {
      await runPsql(
        sourcePlan.activeDatabase,
        `DROP POLICY IF EXISTS portable_verifier_drift ON public.workspaces;
         ALTER TABLE public.workspaces NO FORCE ROW LEVEL SECURITY;
         ALTER TABLE public.workspaces DISABLE ROW LEVEL SECURITY;`,
      );
      await rm(rejectedArchive, { force: true });
    }
    const systemIdentifier = (
      await runPsql(
        "postgres",
        "SELECT system_identifier::text FROM pg_catalog.pg_control_system();",
        { quiet: true },
      )
    ).trim();
    const clusterToken = desktopVerificationClusterToken(systemIdentifier);
    const nowSeconds = Math.floor(Date.now() / 1_000);
    const markedStale = desktopVerificationDatabaseName(clusterToken, nowSeconds - 30_000);
    const unmarkedStale = desktopVerificationDatabaseName(clusterToken, nowSeconds - 29_000);
    verificationFixtures.push(markedStale, unmarkedStale);
    await runPsql("postgres", `CREATE DATABASE ${quoteIdentifier(markedStale)};`);
    await runPsql(
      "postgres",
      `COMMENT ON DATABASE ${quoteIdentifier(markedStale)} IS '${desktopVerificationDatabaseOwnershipMarker(systemIdentifier, markedStale)}';`,
    );
    await runPsql("postgres", `CREATE DATABASE ${quoteIdentifier(unmarkedStale)};`);

    const databaseUrl = new URL(
      process.env.DATABASE_URL ?? "postgres://schedule:schedule@127.0.0.1:5432/schedule",
    );
    databaseUrl.pathname = `/${sourcePlan.activeDatabase}`;
    const adminDatabaseUrl = new URL(databaseUrl);
    adminDatabaseUrl.pathname = "/postgres";
    const result = await exportDesktopPortableScheduleData(archivePath, {
      databaseUrl: databaseUrl.toString(),
      adminDatabaseUrl: adminDatabaseUrl.toString(),
      nodeExecutable: process.execPath,
      migrationEntrypoint: path.join(repositoryRoot, "packages/database/dist/migrate.js"),
      applicationVersion: "portable-verification",
    });
    assert.ok(result.sizeBytes > 0);
    assert.equal(await databaseExists(markedStale), false, "marked stale verifier was not reaped");
    assert.equal(await databaseExists(unmarkedStale), true, "unmarked database was reaped");
    const manifest = await withPreparedPortableArchive(
      archivePath,
      async ({ manifest }) => manifest,
    );
    assert.equal(manifest.producer.platform, platform());
    assert.deepEqual(manifest.data.contentSignals, expectedSignals.contentSignals);
    assert.deepEqual(manifest.data.sequenceSignals, expectedSignals.sequenceSignals);
  } catch (error) {
    failure = error;
  }
  for (const databaseName of verificationFixtures) {
    try {
      if (await databaseExists(databaseName)) {
        await runPsql(
          "postgres",
          `SELECT pg_catalog.pg_terminate_backend(pid) FROM pg_catalog.pg_stat_activity
           WHERE datname = '${databaseName}' AND pid <> pg_catalog.pg_backend_pid();`,
        );
        await runPsql("postgres", `DROP DATABASE ${quoteIdentifier(databaseName)};`);
      }
    } catch (error) {
      failure =
        failure === undefined
          ? error
          : new AggregateError([failure, error], "Portable verifier fixture cleanup failed.");
    }
  }
  const cleanupFailures = await cleanupPlan(sourcePlan);
  if (failure !== undefined || cleanupFailures.length > 0) {
    throw new AggregateError(
      [failure, ...cleanupFailures].filter(
        (item): item is NonNullable<typeof item> => item !== undefined,
      ),
      "Portable archive producer verification failed.",
      failure === undefined ? undefined : { cause: failure },
    );
  }
}

async function consumeArchive(archivePath: string): Promise<void> {
  const targetPlan = createDisposableRecoveryPlan();
  let failure: unknown;
  try {
    await initializeDisposableRecoveryActiveDatabase(targetPlan);
    await runPsql(
      targetPlan.activeDatabase,
      `INSERT INTO public.workspaces (id, name) VALUES ('${destinationMarkerId}', 'destination before import');`,
    );
    const originalIdentity = await databaseIdentity(targetPlan.activeDatabase);
    assert.notEqual(originalIdentity, null);
    const archiveManifest = await withPreparedPortableArchive(
      archivePath,
      async ({ manifest }) => manifest,
    );
    const result = await importPortableScheduleData(archivePath, {
      activeDatabase: targetPlan.activeDatabase,
      stagingDatabase: targetPlan.stagingDatabase,
      previousDatabase: targetPlan.previousDatabase,
    });
    assert.deepEqual(result, {
      activeDatabase: targetPlan.activeDatabase,
      previousDatabase: targetPlan.previousDatabase,
      archiveId: archiveManifest.archiveId,
    });
    assert.notEqual(await databaseIdentity(targetPlan.activeDatabase), originalIdentity);
    assert.equal(await databaseIdentity(targetPlan.previousDatabase), originalIdentity);
    assert.equal(await databaseAllowsConnections(targetPlan.previousDatabase), false);

    const signals = await portableDatabaseSignals(targetPlan.activeDatabase);
    assert.deepEqual(signals.contentSignals, archiveManifest.data.contentSignals);
    assert.deepEqual(signals.sequenceSignals, archiveManifest.data.sequenceSignals);
    const counts = await portableRowCounts(targetPlan.activeDatabase);
    for (const table of portableDataPolicyV1.includedTables) {
      assert.ok((counts[table] ?? 0) > 0, `portable fixture table is empty after import: ${table}`);
    }
    const normalized = (
      await runPsql(
        targetPlan.activeDatabase,
        `SELECT
          (SELECT bool_and(hosted_sync_cursor = 0) FROM public.work_items)::text || '|' ||
          (SELECT status::text || ':' || (cancelled_at = expires_at)::text FROM public.natural_language_proposals WHERE id = '10000000-0000-0000-0000-000000000011') || '|' ||
          (SELECT (actor_id IS NULL)::text FROM public.audit_events WHERE id = '10000000-0000-0000-0000-000000000023') || '|' ||
          (SELECT status::text FROM public.webhook_endpoints WHERE id = '10000000-0000-0000-0000-000000000012') || '|' ||
          (SELECT count(*)::text FROM public.integration_credentials) || '|' ||
          (SELECT count(*)::text FROM public.webhook_endpoint_secrets);`,
      )
    ).trim();
    assert.equal(normalized, "true|cancelled:true|true|revoked|0|0");
    assert.equal(
      (
        await runPsql(
          targetPlan.activeDatabase,
          `SELECT encode(convert_to(title, 'UTF8'), 'hex')
           FROM public.one_off_reminders
           WHERE id = '10000000-0000-0000-0000-000000000014';`,
        )
      ).trim(),
      Buffer.from(dangerousText, "utf8").toString("hex"),
    );
    await inspectLockedDatabase(targetPlan.previousDatabase, async () => {
      assert.equal(
        (
          await runPsql(
            targetPlan.previousDatabase,
            `SELECT name FROM public.workspaces WHERE id = '${destinationMarkerId}';`,
          )
        ).trim(),
        "destination before import",
      );
    });

    const importedIdentity = await databaseIdentity(targetPlan.activeDatabase);
    const rollback = await rollbackDisposableScheduleDatabase(targetPlan);
    assert.deepEqual(rollback, {
      activeDatabase: targetPlan.activeDatabase,
      rejectedDatabase: targetPlan.rejectedDatabase,
    });
    assert.equal(await databaseIdentity(targetPlan.activeDatabase), originalIdentity);
    assert.equal(await databaseIdentity(targetPlan.rejectedDatabase), importedIdentity);
    assert.equal(
      (
        await runPsql(
          targetPlan.activeDatabase,
          `SELECT name FROM public.workspaces WHERE id = '${destinationMarkerId}';`,
        )
      ).trim(),
      "destination before import",
    );
    await inspectLockedDatabase(targetPlan.rejectedDatabase, async () => {
      assert.equal(
        (
          await runPsql(
            targetPlan.rejectedDatabase,
            "SELECT count(*)::text FROM public.natural_language_proposals;",
          )
        ).trim(),
        "1",
      );
    });
  } catch (error) {
    failure = error;
  }
  const cleanupFailures = await cleanupPlan(targetPlan);
  if (failure !== undefined || cleanupFailures.length > 0) {
    throw new AggregateError(
      [failure, ...cleanupFailures].filter(
        (item): item is NonNullable<typeof item> => item !== undefined,
      ),
      "Portable archive consumer verification failed.",
      failure === undefined ? undefined : { cause: failure },
    );
  }
}

function parseMode(
  args: readonly string[],
):
  | { readonly kind: "roundtrip" }
  | { readonly kind: "export" | "import"; readonly archivePath: string } {
  const normalized = args.filter((arg) => arg !== "--");
  if (normalized.length === 0) return { kind: "roundtrip" };
  if (
    normalized.length === 2 &&
    (normalized[0] === "--export" || normalized[0] === "--import") &&
    normalized[1] !== undefined
  ) {
    return { kind: normalized[0].slice(2) as "export" | "import", archivePath: normalized[1] };
  }
  throw new Error(
    "Usage: pnpm verify:portable-migration [-- --export|--import <archive.schedule>]",
  );
}

const mode = parseMode(process.argv.slice(2));
await assertComposeDatabaseReady("postgres");
if (mode.kind === "export") {
  await produceArchive(path.resolve(mode.archivePath));
  console.log(`Portable migration producer verification passed: ${path.resolve(mode.archivePath)}`);
} else if (mode.kind === "import") {
  await consumeArchive(path.resolve(mode.archivePath));
  console.log(
    `Portable migration consumer and rollback verification passed: ${path.resolve(mode.archivePath)}`,
  );
} else {
  const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "schedule-portable-verify-"));
  const archivePath = path.join(temporaryDirectory, "cross-environment.schedule");
  let failure: unknown;
  try {
    await chmod(temporaryDirectory, 0o700);
    await produceArchive(archivePath);
    await consumeArchive(archivePath);
  } catch (error) {
    failure = error;
  }
  let cleanupFailure: unknown;
  try {
    await rm(temporaryDirectory, { recursive: true, force: true });
  } catch (error) {
    cleanupFailure = error;
  }
  if (failure !== undefined || cleanupFailure !== undefined) {
    throw new AggregateError(
      [failure, cleanupFailure].filter(
        (item): item is NonNullable<typeof item> => item !== undefined,
      ),
      "Portable migration round-trip verification failed.",
      failure === undefined ? undefined : { cause: failure },
    );
  }
  console.log(
    "Portable migration verification passed every durable table, AI/behavior history, exclusions, normalization, replacement, and rollback.",
  );
}
