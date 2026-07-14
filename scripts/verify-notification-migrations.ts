import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createDatabase, type DatabaseConnection } from "../packages/database/src/index.js";
import { expectConstraint } from "./lib/postgres-assertions.js";

const sourceDatabaseUrl =
  process.env.DATABASE_URL ?? "postgres://schedule:schedule@127.0.0.1:5432/schedule";
const adminUrl = new URL(sourceDatabaseUrl);
adminUrl.pathname = "/postgres";
const verificationDatabase = `schedule_notification_verify_${randomUUID().replaceAll("-", "")}`;
const verificationUrl = new URL(sourceDatabaseUrl);
verificationUrl.pathname = `/${verificationDatabase}`;
const migrationsFolder = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../packages/database/drizzle",
);
const admin = createDatabase(adminUrl.toString(), 1);
let verification: DatabaseConnection | undefined;

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
  if (!Array.isArray(journal.entries)) throw new Error("Migration journal is missing entries.");
  const entries = journal.entries.map((entry) => {
    if (typeof entry.idx !== "number" || typeof entry.tag !== "string") {
      throw new Error("Migration journal contains an invalid entry.");
    }
    return { idx: entry.idx, tag: entry.tag };
  });
  const notificationMigration = entries.find((entry) => entry.idx === 24);
  if (notificationMigration === undefined) {
    throw new Error("Notification policy migration 0024 is missing from the journal.");
  }
  const notificationIndexMigration = entries.find((entry) => entry.idx === 25);
  if (notificationIndexMigration === undefined) {
    throw new Error("Notification target-index migration 0025 is missing from the journal.");
  }
  const deliveryMigration = entries.find((entry) => entry.idx === 26);
  if (deliveryMigration === undefined) {
    throw new Error("Notification delivery migration 0026 is missing from the journal.");
  }
  const deliveryHistoryMigration = entries.find((entry) => entry.idx === 27);
  if (deliveryHistoryMigration === undefined) {
    throw new Error("Notification delivery-history migration 0027 is missing from the journal.");
  }
  for (const migration of entries.filter((entry) => entry.idx < 24)) {
    await applyMigration(verification, migration.tag);
  }

  const legacyWorkspaceId = "00000000-0000-4000-8000-000000000024";
  const legacyWorkItemId = "00000000-0000-4000-8000-000000000025";
  const isolatedWorkspaceId = "00000000-0000-4000-8000-000000000026";
  const reminderId = "00000000-0000-4000-8000-000000000027";
  const legacyPlanId = "00000000-0000-4000-8000-000000000028";
  const legacyBlockId = "00000000-0000-4000-8000-000000000029";
  await verification.sql`
    insert into workspaces (id, name) values (${legacyWorkspaceId}, 'Notification migration legacy')
  `;
  await verification.sql`
    insert into work_items (id, workspace_id, title, due_on)
    values (${legacyWorkItemId}, ${legacyWorkspaceId}, 'Legacy due item', '2026-07-20')
  `;
  await verification.sql`
    insert into workspaces (id, name) values (${isolatedWorkspaceId}, 'Notification migration isolation')
  `;
  await verification.sql`
    insert into daily_plans (
      id, workspace_id, local_date, time_zone, request_revision, algorithm_version, config_version,
      prng_version, seed, input_hash, input_snapshot, total_minutes, fitness, generated_at
    ) values (
      ${legacyPlanId}, ${legacyWorkspaceId}, '2026-07-20', 'UTC', 1, 'legacy', 'legacy',
      'legacy', 'legacy', ${"a".repeat(64)}, '{}'::jsonb, 0, 0, '2026-07-20T08:00:00.000Z'
    )
  `;
  await verification.sql`
    insert into schedule_blocks (id, workspace_id, title, starts_at, ends_at, time_zone)
    values (
      ${legacyBlockId}, ${legacyWorkspaceId}, 'Legacy block',
      '2026-07-20T11:00:00.000Z', '2026-07-20T11:30:00.000Z', 'UTC'
    )
  `;
  const [before] = await verification.sql<{ notification_profiles: string | null }[]>`
    select to_regclass('public.notification_profiles')::text as notification_profiles
  `;
  assert.equal(before?.notification_profiles, null);

  await applyMigration(verification, notificationMigration.tag);
  const [beforeTargetIndexes] = await verification.sql<{ target_index: string | null }[]>`
    select to_regclass('public.notification_intents_workspace_daily_plan_idx')::text as target_index
  `;
  assert.equal(
    beforeTargetIndexes?.target_index,
    null,
    "target indexes must remain a separately deployable post-0024 migration",
  );
  const [preserved] = await verification.sql<
    {
      workspace_count: number;
      work_item_count: number;
      plan_count: number;
      block_count: number;
    }[]
  >`
    select
      (select count(*)::integer from workspaces where id = ${legacyWorkspaceId}) as workspace_count,
      (select count(*)::integer from work_items where id = ${legacyWorkItemId}) as work_item_count,
      (select count(*)::integer from daily_plans where id = ${legacyPlanId}) as plan_count,
      (select count(*)::integer from schedule_blocks where id = ${legacyBlockId}) as block_count
  `;
  assert.deepEqual(preserved, {
    workspace_count: 1,
    work_item_count: 1,
    plan_count: 1,
    block_count: 1,
  });
  const tables = await verification.sql<{ table_name: string }[]>`
    select table_name
    from information_schema.tables
    where table_schema = 'public'
      and table_name = any(${[
        "notification_profiles",
        "notification_rules",
        "one_off_reminders",
        "notification_intents",
      ]})
    order by table_name
  `;
  assert.deepEqual(
    tables.map((row) => row.table_name),
    ["notification_intents", "notification_profiles", "notification_rules", "one_off_reminders"],
  );
  const [emptyPolicy] = await verification.sql<
    {
      profiles: number;
      rules: number;
      reminders: number;
      intents: number;
    }[]
  >`
    select
      (select count(*)::integer from notification_profiles) as profiles,
      (select count(*)::integer from notification_rules) as rules,
      (select count(*)::integer from one_off_reminders) as reminders,
      (select count(*)::integer from notification_intents) as intents
  `;
  assert.deepEqual(emptyPolicy, { profiles: 0, rules: 0, reminders: 0, intents: 0 });

  await verification.sql`
    insert into notification_profiles (
      workspace_id, time_zone, quiet_hours_start_minute, quiet_hours_end_minute
    ) values (${legacyWorkspaceId}, 'UTC', 1320, 420)
  `;
  await verification.sql`
    insert into one_off_reminders (id, workspace_id, title, scheduled_for)
    values (${reminderId}, ${legacyWorkspaceId}, 'Migration one-off', '2026-07-20T12:00:00.000Z')
  `;
  const [rule] = await verification.sql<{ id: string }[]>`
    insert into notification_rules (workspace_id, kind, local_minute)
    values (${legacyWorkspaceId}, 'daily_digest', 540)
    returning id::text
  `;
  assert.ok(rule !== undefined);
  const [intent] = await verification.sql<{ id: string }[]>`
    insert into notification_intents (
      workspace_id, rule_id, rule_kind, kind, occurrence_key, target_type, scheduled_for,
      local_date, priority, policy_snapshot, local_time_resolution
    ) values (
      ${legacyWorkspaceId}, ${rule.id}, 'daily_digest', 'daily_digest', 'migration-verification-occurrence',
      'workspace', '2026-07-20T09:00:00.000Z', '2026-07-20', 50,
      '{"profileVersion":1,"ruleVersion":1}'::jsonb, 'exact'
    )
    returning id::text
  `;
  assert.ok(intent !== undefined);
  const [planRule] = await verification.sql<{ id: string }[]>`
    insert into notification_rules (workspace_id, kind, lead_minutes)
    values (${legacyWorkspaceId}, 'plan_window_open', 10)
    returning id::text
  `;
  const [blockRule] = await verification.sql<{ id: string }[]>`
    insert into notification_rules (workspace_id, kind, lead_minutes)
    values (${legacyWorkspaceId}, 'schedule_block_lead', 15)
    returning id::text
  `;
  const [dueRule] = await verification.sql<{ id: string }[]>`
    insert into notification_rules (workspace_id, kind, local_minute)
    values (${legacyWorkspaceId}, 'work_item_due', 720)
    returning id::text
  `;
  assert.ok(planRule !== undefined && blockRule !== undefined && dueRule !== undefined);
  await verification.sql`
    insert into notification_intents (
      workspace_id, one_off_reminder_id, kind, occurrence_key, target_type, scheduled_for,
      local_date, priority, policy_snapshot, local_time_resolution
    ) values (
      ${legacyWorkspaceId}, ${reminderId}, 'one_off', 'migration-one-off-valid', 'one_off',
      '2026-07-20T12:00:00.000Z', '2026-07-20', 100, '{}'::jsonb, 'exact'
    )
  `;
  await verification.sql`
    insert into notification_intents (
      workspace_id, rule_id, rule_kind, kind, occurrence_key, target_type, daily_plan_id,
      scheduled_for, local_date, priority, policy_snapshot, local_time_resolution
    ) values (
      ${legacyWorkspaceId}, ${planRule.id}, 'plan_window_open', 'plan_window_open',
      'migration-plan-valid', 'daily_plan', ${legacyPlanId}, '2026-07-20T09:50:00.000Z',
      '2026-07-20', 50, '{}'::jsonb, 'exact'
    )
  `;
  await verification.sql`
    insert into notification_intents (
      workspace_id, rule_id, rule_kind, kind, occurrence_key, target_type, schedule_block_id,
      scheduled_for, local_date, priority, policy_snapshot, local_time_resolution
    ) values (
      ${legacyWorkspaceId}, ${blockRule.id}, 'schedule_block_lead', 'schedule_block_lead',
      'migration-block-valid', 'schedule_block', ${legacyBlockId}, '2026-07-20T10:45:00.000Z',
      '2026-07-20', 50, '{}'::jsonb, 'exact'
    )
  `;
  await verification.sql`
    insert into notification_intents (
      workspace_id, rule_id, rule_kind, kind, occurrence_key, target_type, work_item_id,
      scheduled_for, local_date, priority, policy_snapshot, local_time_resolution
    ) values (
      ${legacyWorkspaceId}, ${dueRule.id}, 'work_item_due', 'work_item_due',
      'migration-work-valid', 'work_item', ${legacyWorkItemId}, '2026-07-20T12:00:00.000Z',
      '2026-07-20', 50, '{}'::jsonb, 'exact'
    )
  `;

  await expectConstraint(
    () =>
      verification!.sql`
        update notification_profiles
        set quiet_hours_end_minute = null
        where workspace_id = ${legacyWorkspaceId}
      `,
    "23514",
    "notification_profiles_quiet_hours_pair",
  );
  await expectConstraint(
    () =>
      verification!.sql`
        insert into notification_rules (workspace_id, kind, local_minute, lead_minutes)
        values (${legacyWorkspaceId}, 'schedule_block_lead', 540, 15)
      `,
    "23514",
    "notification_rules_configuration_valid",
  );
  await expectConstraint(
    () =>
      verification!.sql`
        insert into notification_intents (
          workspace_id, rule_id, rule_kind, kind, occurrence_key, target_type, scheduled_for,
          local_date, priority, policy_snapshot, local_time_resolution
        ) values (
          ${legacyWorkspaceId}, ${rule.id}, 'daily_digest', 'daily_digest', 'migration-verification-occurrence',
          'workspace', '2026-07-20T10:00:00.000Z', '2026-07-20', 50, '{}'::jsonb, 'exact'
        )
      `,
    "23505",
    "notification_intents_workspace_occurrence_uq",
  );

  await expectConstraint(
    () =>
      verification!.sql`
        insert into notification_intents (
          workspace_id, one_off_reminder_id, kind, occurrence_key, target_type, scheduled_for,
          local_date, priority, policy_snapshot, local_time_resolution
        ) values (
          ${isolatedWorkspaceId}, ${reminderId}, 'one_off', 'migration-cross-tenant-one-off',
          'one_off', '2026-07-20T10:00:00.000Z', '2026-07-20', 100, '{}'::jsonb, 'exact'
        )
      `,
    "23503",
    "notification_intents_one_off_tenant_fk",
  );
  await expectConstraint(
    () =>
      verification!.sql`
        insert into notification_intents (
          workspace_id, rule_id, rule_kind, kind, occurrence_key, target_type, work_item_id,
          scheduled_for, local_date, priority, policy_snapshot, local_time_resolution
        ) values (
          ${legacyWorkspaceId}, ${rule.id}, 'work_item_due', 'work_item_due',
          'migration-mismatched-rule-kind', 'work_item', ${legacyWorkItemId},
          '2026-07-20T10:00:00.000Z', '2026-07-20', 50, '{}'::jsonb, 'exact'
        )
      `,
    "23503",
    "notification_intents_rule_tenant_kind_fk",
  );
  const [workItemRule] = await verification.sql<{ id: string }[]>`
    insert into notification_rules (workspace_id, kind, local_minute)
    values (${isolatedWorkspaceId}, 'work_item_due', 720)
    returning id::text
  `;
  assert.ok(workItemRule !== undefined);
  await expectConstraint(
    () =>
      verification!.sql`
        insert into notification_intents (
          workspace_id, rule_id, rule_kind, kind, occurrence_key, target_type, work_item_id,
          scheduled_for, local_date, priority, policy_snapshot, local_time_resolution
        ) values (
          ${isolatedWorkspaceId}, ${workItemRule.id}, 'work_item_due', 'work_item_due',
          'migration-cross-tenant-target', 'work_item', ${legacyWorkItemId},
          '2026-07-20T10:00:00.000Z', '2026-07-20', 50, '{}'::jsonb, 'exact'
        )
      `,
    "23503",
    "notification_intents_work_item_tenant_fk",
  );
  const [isolatedPlanRule] = await verification.sql<{ id: string }[]>`
    insert into notification_rules (workspace_id, kind, lead_minutes)
    values (${isolatedWorkspaceId}, 'plan_window_open', 10)
    returning id::text
  `;
  assert.ok(isolatedPlanRule !== undefined);
  await expectConstraint(
    () =>
      verification!.sql`
        insert into notification_intents (
          workspace_id, rule_id, rule_kind, kind, occurrence_key, target_type, daily_plan_id,
          scheduled_for, local_date, priority, policy_snapshot, local_time_resolution
        ) values (
          ${isolatedWorkspaceId}, ${isolatedPlanRule.id}, 'plan_window_open', 'plan_window_open',
          'migration-cross-plan-target', 'daily_plan', ${legacyPlanId},
          '2026-07-20T10:00:00.000Z', '2026-07-20', 50, '{}'::jsonb, 'exact'
        )
      `,
    "23503",
    "notification_intents_daily_plan_tenant_fk",
  );
  const [isolatedBlockRule] = await verification.sql<{ id: string }[]>`
    insert into notification_rules (workspace_id, kind, lead_minutes)
    values (${isolatedWorkspaceId}, 'schedule_block_lead', 15)
    returning id::text
  `;
  assert.ok(isolatedBlockRule !== undefined);
  await expectConstraint(
    () =>
      verification!.sql`
        insert into notification_intents (
          workspace_id, rule_id, rule_kind, kind, occurrence_key, target_type, schedule_block_id,
          scheduled_for, local_date, priority, policy_snapshot, local_time_resolution
        ) values (
          ${isolatedWorkspaceId}, ${isolatedBlockRule.id}, 'schedule_block_lead',
          'schedule_block_lead', 'migration-cross-block-target', 'schedule_block', ${legacyBlockId},
          '2026-07-20T10:00:00.000Z', '2026-07-20', 50, '{}'::jsonb, 'exact'
        )
      `,
    "23503",
    "notification_intents_schedule_block_tenant_fk",
  );
  await expectConstraint(
    () =>
      verification!.sql`
        insert into notification_intents (
          workspace_id, rule_id, rule_kind, kind, occurrence_key, target_type, work_item_id,
          scheduled_for, local_date, priority, policy_snapshot, local_time_resolution
        ) values (
          ${legacyWorkspaceId}, ${rule.id}, 'daily_digest', 'daily_digest',
          'migration-malformed-target', 'work_item', ${legacyWorkItemId},
          '2026-07-20T10:00:00.000Z', '2026-07-20', 50, '{}'::jsonb, 'exact'
        )
      `,
    "23514",
    "notification_intents_target_valid",
  );
  await expectConstraint(
    () =>
      verification!.sql`
        insert into notification_intents (
          workspace_id, rule_id, one_off_reminder_id, kind, occurrence_key, target_type,
          scheduled_for, local_date, priority, policy_snapshot, local_time_resolution
        ) values (
          ${legacyWorkspaceId}, ${rule.id}, ${reminderId}, 'one_off',
          'migration-malformed-source', 'one_off', '2026-07-20T10:00:00.000Z',
          '2026-07-20', 100, '{}'::jsonb, 'exact'
        )
      `,
    "23514",
    "notification_intents_source_valid",
  );
  await expectConstraint(
    () => verification!.sql`delete from notification_rules where id = ${rule.id}`,
    "23503",
    "notification_intents_rule_tenant_kind_fk",
  );
  await expectConstraint(
    () => verification!.sql`delete from one_off_reminders where id = ${reminderId}`,
    "23503",
    "notification_intents_one_off_tenant_fk",
  );

  await verification.sql`delete from daily_plans where id = ${legacyPlanId}`;
  await verification.sql`delete from schedule_blocks where id = ${legacyBlockId}`;
  await verification.sql`delete from work_items where id = ${legacyWorkItemId}`;
  const [cascades] = await verification.sql<{ plan: number; block: number; work_item: number }[]>`
    select
      (select count(*)::integer from notification_intents where daily_plan_id = ${legacyPlanId}) as plan,
      (select count(*)::integer from notification_intents where schedule_block_id = ${legacyBlockId}) as block,
      (select count(*)::integer from notification_intents where work_item_id = ${legacyWorkItemId}) as work_item
  `;
  assert.deepEqual(cascades, { plan: 0, block: 0, work_item: 0 });
  await applyMigration(verification, notificationIndexMigration.tag);
  const installedIndexes = await verification.sql<{ indexname: string; indexdef: string }[]>`
    select indexname, indexdef from pg_indexes
    where schemaname = 'public' and indexname in (
      'work_items_workspace_due_id_idx',
      'notification_intents_workspace_daily_plan_idx',
      'notification_intents_workspace_schedule_block_idx',
      'notification_intents_workspace_work_item_idx',
      'notification_intents_workspace_one_off_idx'
    )
  `;
  const indexByName = new Map(installedIndexes.map((index) => [index.indexname, index.indexdef]));
  assert.ok(
    indexByName.has("work_items_workspace_due_id_idx"),
    "notification due-work scan index must be installed",
  );
  for (const [indexName, targetColumn] of [
    ["notification_intents_workspace_daily_plan_idx", "daily_plan_id"],
    ["notification_intents_workspace_schedule_block_idx", "schedule_block_id"],
    ["notification_intents_workspace_work_item_idx", "work_item_id"],
    ["notification_intents_workspace_one_off_idx", "one_off_reminder_id"],
  ] as const) {
    const definition = indexByName.get(indexName);
    assert.ok(definition !== undefined, `${indexName} must be installed`);
    assert.match(
      definition,
      new RegExp(
        `\\(workspace_id, ${targetColumn}\\).*WHERE \\(${targetColumn} IS NOT NULL\\)$`,
        "i",
      ),
      `${indexName} must be a tenant-scoped partial target index`,
    );
  }

  const legacyCredentialId = "00000000-0000-4000-8000-000000000030";
  const deliveryCredentialId = "00000000-0000-4000-8000-000000000031";
  await verification.sql`
    insert into integration_credentials (
      id, workspace_id, name, secret_digest, scopes
    ) values (
      ${legacyCredentialId}, ${legacyWorkspaceId}, 'Pre-delivery credential', ${"b".repeat(64)},
      array['schedule:read', 'schedule:write']::text[]
    )
  `;
  const [beforeDelivery] = await verification.sql<
    {
      commands: string | null;
      attempts: string | null;
      requests: string | null;
    }[]
  >`
    select
      to_regclass('public.notification_delivery_commands')::text as commands,
      to_regclass('public.notification_delivery_attempts')::text as attempts,
      to_regclass('public.notification_delivery_requests')::text as requests
  `;
  assert.deepEqual(beforeDelivery, { commands: null, attempts: null, requests: null });

  await applyMigration(verification, deliveryMigration.tag);
  const [deliveryUpgrade] = await verification.sql<
    {
      legacy_credentials: number;
      intents: number;
      commands: string | null;
      attempts: string | null;
      requests: string | null;
    }[]
  >`
    select
      (select count(*)::integer from integration_credentials where id = ${legacyCredentialId}) as legacy_credentials,
      (select count(*)::integer from notification_intents where id = ${intent.id}) as intents,
      to_regclass('public.notification_delivery_commands')::text as commands,
      to_regclass('public.notification_delivery_attempts')::text as attempts,
      to_regclass('public.notification_delivery_requests')::text as requests
  `;
  assert.deepEqual(deliveryUpgrade, {
    legacy_credentials: 1,
    intents: 1,
    commands: "notification_delivery_commands",
    attempts: "notification_delivery_attempts",
    requests: "notification_delivery_requests",
  });
  const [deliveryRecoveryIndex] = await verification.sql<{ indexdef: string }[]>`
    select indexdef from pg_indexes
    where schemaname = 'public' and indexname = 'notification_delivery_commands_recovery_idx'
  `;
  assert.ok(deliveryRecoveryIndex !== undefined, "delivery recovery index must be installed");
  const deliveryRecoveryIndexDefinition = deliveryRecoveryIndex.indexdef
    .toLowerCase()
    .replaceAll('"', "");
  assert.ok(
    deliveryRecoveryIndexDefinition.includes("using btree (workspace_id, lease_expires_at, id)"),
    "delivery recovery index must preserve workspace/expiry/id key order",
  );
  for (const fragment of ["processing", "invalidated"]) {
    assert.ok(
      deliveryRecoveryIndexDefinition.includes(fragment),
      `delivery recovery index must include ${fragment}`,
    );
  }
  await verification.sql`
    insert into integration_credentials (
      id, workspace_id, name, secret_digest, scopes
    ) values (
      ${deliveryCredentialId}, ${legacyWorkspaceId}, 'Delivery-only credential', ${"c".repeat(64)},
      array['schedule:delivery']::text[]
    )
  `;
  await verification.sql`
    insert into notification_delivery_commands (
      id, workspace_id, intent_id, occurrence_key, kind, target_type, scheduled_for,
      local_date, priority, available_at, created_at, updated_at
    ) values (
      ${intent.id}, ${legacyWorkspaceId}, ${intent.id}, 'migration-verification-occurrence',
      'daily_digest', 'workspace', '2026-07-20T09:00:00.000Z', '2026-07-20', 50,
      '2026-07-20T09:00:00.000Z', '2026-07-20T08:00:00.000Z', '2026-07-20T08:00:00.000Z'
    )
  `;
  await expectConstraint(
    () =>
      verification!.sql`
        insert into notification_delivery_commands (
          id, workspace_id, intent_id, occurrence_key, kind, target_type, scheduled_for,
          local_date, priority, available_at
        ) values (
          '00000000-0000-4000-8000-000000000032', ${legacyWorkspaceId},
          '00000000-0000-4000-8000-000000000032', 'migration-verification-occurrence',
          'daily_digest', 'workspace', '2026-07-20T09:00:00.000Z', '2026-07-20', 50,
          '2026-07-20T09:00:00.000Z'
        )
      `,
    "23505",
    "notification_delivery_commands_workspace_occurrence_uq",
  );

  const [beforeHistoryIndex] = await verification.sql<{ index_name: string | null }[]>`
    select to_regclass('public.notification_delivery_commands_workspace_schedule_idx')::text as index_name
  `;
  assert.equal(
    beforeHistoryIndex?.index_name,
    null,
    "the product history index must remain a separately deployable post-0026 migration",
  );
  await applyMigration(verification, deliveryHistoryMigration.tag);
  const [historyUpgrade] = await verification.sql<
    { indexdef: string; commands: number; legacy_credentials: number }[]
  >`
    select
      indexdef,
      (select count(*)::integer from notification_delivery_commands where id = ${intent.id}) as commands,
      (select count(*)::integer from integration_credentials where id = ${legacyCredentialId}) as legacy_credentials
    from pg_indexes
    where schemaname = 'public'
      and indexname = 'notification_delivery_commands_workspace_schedule_idx'
  `;
  assert.ok(historyUpgrade !== undefined, "delivery history index must be installed");
  assert.ok(
    historyUpgrade.indexdef
      .toLowerCase()
      .replaceAll('"', "")
      .includes("using btree (workspace_id, scheduled_for, id)"),
    "delivery history index must preserve workspace/schedule/id key order",
  );
  assert.equal(historyUpgrade.commands, 1, "the delivery command must survive the index upgrade");
  assert.equal(
    historyUpgrade.legacy_credentials,
    1,
    "legacy credentials must survive the history index upgrade",
  );

  console.log(
    "Notification migration verification passed with populated policy and delivery upgrades through 0027, target indexes, legacy preservation, and exhaustive tenant constraints.",
  );
} finally {
  await verification?.close();
  await admin.sql.unsafe(`DROP DATABASE IF EXISTS "${verificationDatabase}" WITH (FORCE)`);
  await admin.close();
}
