import assert from "node:assert/strict";

import { buildApp } from "../apps/api/src/app.js";
import { createProductServices } from "../apps/api/src/product-services.js";
import { createDatabase, PostgresUnitOfWork } from "../packages/database/src/index.js";
import { expectConstraint } from "./lib/postgres-assertions.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://schedule:schedule@127.0.0.1:5432/schedule";
const connection = createDatabase(databaseUrl, 6);
const fixedNow = new Date("2026-07-20T08:00:00.000Z");
const app = await buildApp({
  productServices: createProductServices(new PostgresUnitOfWork(connection), {
    now: () => new Date(fixedNow),
  }),
  productApiAccess: { mode: "local_unauthenticated" },
});
const workspaceIds: string[] = [];

async function createWorkspace(name: string): Promise<string> {
  const response = await app.inject({ method: "POST", url: "/v1/workspaces", payload: { name } });
  assert.equal(response.statusCode, 201, response.body);
  const id = response.json<{ id: string }>().id;
  workspaceIds.push(id);
  return id;
}

async function removeWorkspaces(): Promise<void> {
  if (workspaceIds.length === 0) return;
  await connection.sql.begin(async (sql) => {
    await sql`select set_config('schedule.allow_activity_event_mutation', 'on', true)`;
    await sql`select set_config('schedule.allow_audit_event_mutation', 'on', true)`;
    await sql`select set_config('schedule.allow_plan_interaction_event_mutation', 'on', true)`;
    await sql`select set_config('schedule.allow_plan_mutation_change', 'on', true)`;
    await sql`select set_config('schedule.allow_routine_planning_feedback_event_change', 'on', true)`;
    await sql`select set_config('schedule.allow_routine_duration_insight_feedback_event_change', 'on', true)`;
    await sql`select set_config('schedule.allow_daily_plan_fit_insight_feedback_event_change', 'on', true)`;
    await sql`delete from workspaces where id = any(${workspaceIds})`;
  });
}

try {
  const workspaceId = await createWorkspace("Notification core verification");
  const isolatedWorkspaceId = await createWorkspace("Notification tenant isolation verification");

  const profileResponse = await app.inject({
    method: "PUT",
    url: `/v1/workspaces/${workspaceId}/notification-profile`,
    payload: {
      expectedVersion: null,
      timeZone: "UTC",
      quietHoursStartMinute: 1320,
      quietHoursEndMinute: 420,
      quietHoursPolicy: "next_allowed",
      catchUpWindowMinutes: 60,
      dailyIntentLimit: 20,
    },
  });
  assert.equal(profileResponse.statusCode, 200, profileResponse.body);
  assert.equal(profileResponse.json<{ version: number }>().version, 1);

  const workItemResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${workspaceId}/work-items`,
    payload: {
      title: "Notification verification task",
      priority: "high",
      dueOn: "2026-07-20",
      planningDurationMinutes: 30,
    },
  });
  assert.equal(workItemResponse.statusCode, 201, workItemResponse.body);
  const workItemId = workItemResponse.json<{ id: string }>().id;
  const remainingWorkItemResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${workspaceId}/work-items`,
    payload: {
      title: "Remaining notification verification task",
      priority: "medium",
      planningDurationMinutes: 30,
    },
  });
  assert.equal(remainingWorkItemResponse.statusCode, 201, remainingWorkItemResponse.body);

  const planResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${workspaceId}/plans`,
    payload: {
      date: "2026-07-20",
      timeZone: "UTC",
      availableWindows: [
        {
          startsAt: "2026-07-20T10:00:00.000Z",
          endsAt: "2026-07-20T11:00:00.000Z",
        },
      ],
      targetMinutes: 60,
      targetTaskCount: 2,
      availableContexts: [],
      seed: "notification-core-verification",
      requestRevision: 1,
    },
  });
  assert.equal(planResponse.statusCode, 200, planResponse.body);
  const plan = planResponse.json<{
    id: string;
    items: { id: string; workItemId: string | null }[];
  }>();
  assert.equal(plan.items.length, 2);
  const planId = plan.id;
  const duePlanItem = plan.items.find((item) => item.workItemId === workItemId);
  assert.ok(duePlanItem !== undefined);

  const blockResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${workspaceId}/schedule-blocks`,
    payload: {
      workItemId,
      title: "Notification verification block",
      startsAt: "2026-07-20T11:00:00.000Z",
      endsAt: "2026-07-20T11:30:00.000Z",
      timeZone: "UTC",
    },
  });
  assert.equal(blockResponse.statusCode, 201, blockResponse.body);
  const blockId = blockResponse.json<{ id: string }>().id;

  const rulePayloads = [
    { kind: "daily_digest", localMinute: 540 },
    { kind: "daily_follow_up", localMinute: 1080 },
    { kind: "plan_window_open", leadMinutes: 10 },
    { kind: "schedule_block_lead", leadMinutes: 15 },
    { kind: "work_item_due", localMinute: 720 },
  ] as const;
  const ruleIds: string[] = [];
  for (const payload of rulePayloads) {
    const response = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceId}/notification-rules`,
      payload,
    });
    assert.equal(response.statusCode, 201, response.body);
    ruleIds.push(response.json<{ id: string }>().id);
  }

  const reminderResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${workspaceId}/one-off-reminders`,
    payload: {
      title: "Explicit notification verification",
      scheduledFor: "2026-07-20T13:00:00.000Z",
    },
  });
  assert.equal(reminderResponse.statusCode, 201, reminderResponse.body);
  const reminderId = reminderResponse.json<{ id: string }>().id;

  const [outboxBefore] = await connection.sql<{ count: number }[]>`
    select count(*)::integer as count from outbox_events where workspace_id = ${workspaceId}
  `;
  assert.ok(outboxBefore !== undefined);

  const materializationRequest = {
    method: "POST" as const,
    url: `/v1/workspaces/${workspaceId}/notification-intents/materializations`,
    payload: {
      from: "2026-07-20T08:00:00.000Z",
      through: "2026-07-21T00:00:00.000Z",
    },
  };
  const [first, second] = await Promise.all([
    app.inject(materializationRequest),
    app.inject(materializationRequest),
  ]);
  assert.equal(first.statusCode, 200, first.body);
  assert.equal(second.statusCode, 200, second.body);
  const firstResult = first.json<{ created: unknown[]; existing: unknown[] }>();
  const secondResult = second.json<{ created: unknown[]; existing: unknown[] }>();
  assert.equal(firstResult.created.length + secondResult.created.length, 6);
  assert.equal(firstResult.existing.length + secondResult.existing.length, 6);

  const listResponse = await app.inject({
    method: "GET",
    url: `/v1/workspaces/${workspaceId}/notification-intents?from=2026-07-20T08%3A00%3A00.000Z&to=2026-07-21T00%3A00%3A00.000Z&limit=100&offset=0`,
  });
  assert.equal(listResponse.statusCode, 200, listResponse.body);
  const intents = listResponse.json<{
    items: { id: string; kind: string; occurrenceKey: string; scheduledFor: string }[];
  }>().items;
  assert.equal(intents.length, 6);
  assert.equal(new Set(intents.map((intent) => intent.occurrenceKey)).size, 6);
  assert.deepEqual(
    intents.map((intent) => intent.kind).sort(),
    [
      "daily_digest",
      "daily_follow_up",
      "one_off",
      "plan_window_open",
      "schedule_block_lead",
      "work_item_due",
    ].sort(),
  );

  const replay = await app.inject(materializationRequest);
  assert.equal(replay.statusCode, 200, replay.body);
  assert.equal(replay.json<{ created: unknown[] }>().created.length, 0);
  assert.equal(replay.json<{ existing: unknown[] }>().existing.length, 6);

  const updateReminder = await app.inject({
    method: "PATCH",
    url: `/v1/workspaces/${workspaceId}/one-off-reminders/${reminderId}`,
    payload: { expectedVersion: 1, title: "Updated explicit verification" },
  });
  assert.equal(updateReminder.statusCode, 200, updateReminder.body);
  const [oneOffAfterUpdate] = await connection.sql<{ count: number }[]>`
    select count(*)::integer as count
    from notification_intents
    where workspace_id = ${workspaceId} and one_off_reminder_id = ${reminderId}
  `;
  assert.equal(oneOffAfterUpdate?.count, 0, "one-off updates must invalidate pending intents");
  const rematerializeOneOff = await app.inject(materializationRequest);
  assert.equal(rematerializeOneOff.statusCode, 200, rematerializeOneOff.body);
  assert.equal(rematerializeOneOff.json<{ created: unknown[] }>().created.length, 1);

  const updateRule = await app.inject({
    method: "PATCH",
    url: `/v1/workspaces/${workspaceId}/notification-rules/${ruleIds[0]!}`,
    payload: { expectedVersion: 1, priority: 55 },
  });
  assert.equal(updateRule.statusCode, 200, updateRule.body);
  const [ruleIntentAfterUpdate] = await connection.sql<{ count: number }[]>`
    select count(*)::integer as count
    from notification_intents
    where workspace_id = ${workspaceId} and rule_id = ${ruleIds[0]!}
  `;
  assert.equal(ruleIntentAfterUpdate?.count, 0, "rule updates must invalidate pending intents");
  const rematerializeRule = await app.inject(materializationRequest);
  assert.equal(rematerializeRule.statusCode, 200, rematerializeRule.body);
  assert.equal(rematerializeRule.json<{ created: unknown[] }>().created.length, 1);

  const updateProfile = await app.inject({
    method: "PUT",
    url: `/v1/workspaces/${workspaceId}/notification-profile`,
    payload: {
      expectedVersion: 1,
      timeZone: "UTC",
      quietHoursStartMinute: 1320,
      quietHoursEndMinute: 420,
      quietHoursPolicy: "next_allowed",
      catchUpWindowMinutes: 60,
      dailyIntentLimit: 19,
    },
  });
  assert.equal(updateProfile.statusCode, 200, updateProfile.body);
  const [afterProfileUpdate] = await connection.sql<{ count: number }[]>`
    select count(*)::integer as count
    from notification_intents where workspace_id = ${workspaceId}
  `;
  assert.equal(afterProfileUpdate?.count, 0, "profile updates must invalidate all pending intents");
  const rematerializeProfile = await app.inject(materializationRequest);
  assert.equal(rematerializeProfile.statusCode, 200, rematerializeProfile.body);
  assert.equal(rematerializeProfile.json<{ created: unknown[] }>().created.length, 6);

  const disableProfile = await app.inject({
    method: "PUT",
    url: `/v1/workspaces/${workspaceId}/notification-profile`,
    payload: {
      expectedVersion: 2,
      enabled: false,
      timeZone: "UTC",
      quietHoursStartMinute: 1320,
      quietHoursEndMinute: 420,
      quietHoursPolicy: "next_allowed",
      catchUpWindowMinutes: 60,
      dailyIntentLimit: 19,
    },
  });
  assert.equal(disableProfile.statusCode, 200, disableProfile.body);
  assert.equal(disableProfile.json<{ version: number }>().version, 3);
  const [afterProfileDisable] = await connection.sql<{ count: number }[]>`
    select count(*)::integer as count from notification_intents where workspace_id = ${workspaceId}
  `;
  assert.equal(
    afterProfileDisable?.count,
    0,
    "disabling a profile must invalidate pending intents",
  );
  const materializeWhileDisabled = await app.inject(materializationRequest);
  assert.equal(materializeWhileDisabled.statusCode, 200, materializeWhileDisabled.body);
  assert.equal(materializeWhileDisabled.json<{ created: unknown[] }>().created.length, 0);
  assert.equal(materializeWhileDisabled.json<{ existing: unknown[] }>().existing.length, 0);

  const reenableProfile = await app.inject({
    method: "PUT",
    url: `/v1/workspaces/${workspaceId}/notification-profile`,
    payload: {
      expectedVersion: 3,
      enabled: true,
      timeZone: "UTC",
      quietHoursStartMinute: 1320,
      quietHoursEndMinute: 420,
      quietHoursPolicy: "next_allowed",
      catchUpWindowMinutes: 60,
      dailyIntentLimit: 19,
    },
  });
  assert.equal(reenableProfile.statusCode, 200, reenableProfile.body);
  const rematerializeAfterEnable = await app.inject(materializationRequest);
  assert.equal(rematerializeAfterEnable.statusCode, 200, rematerializeAfterEnable.body);
  assert.equal(rematerializeAfterEnable.json<{ created: unknown[] }>().created.length, 6);

  const updateBlock = await app.inject({
    method: "PATCH",
    url: `/v1/workspaces/${workspaceId}/schedule-blocks/${blockId}`,
    payload: { expectedVersion: 1, title: "Updated notification verification block" },
  });
  assert.equal(updateBlock.statusCode, 200, updateBlock.body);
  const [blockIntentAfterUpdate] = await connection.sql<{ count: number }[]>`
    select count(*)::integer as count from notification_intents
    where workspace_id = ${workspaceId} and schedule_block_id = ${blockId}
  `;
  assert.equal(blockIntentAfterUpdate?.count, 0, "schedule-block updates must invalidate intents");
  const rematerializeBlock = await app.inject(materializationRequest);
  assert.equal(rematerializeBlock.statusCode, 200, rematerializeBlock.body);
  assert.equal(rematerializeBlock.json<{ created: unknown[] }>().created.length, 1);

  const updateWorkItem = await app.inject({
    method: "PATCH",
    url: `/v1/workspaces/${workspaceId}/work-items/${workItemId}`,
    payload: { expectedVersion: 1, priority: "urgent" },
  });
  assert.equal(updateWorkItem.statusCode, 200, updateWorkItem.body);
  const [workItemIntentAfterUpdate] = await connection.sql<{ count: number }[]>`
    select count(*)::integer as count from notification_intents
    where workspace_id = ${workspaceId} and work_item_id = ${workItemId}
  `;
  assert.equal(workItemIntentAfterUpdate?.count, 0, "work-item updates must invalidate intents");
  const rematerializeWorkItem = await app.inject(materializationRequest);
  assert.equal(rematerializeWorkItem.statusCode, 200, rematerializeWorkItem.body);
  assert.equal(rematerializeWorkItem.json<{ created: unknown[] }>().created.length, 1);

  const completePlanItemRequest = {
    method: "POST",
    url: `/v1/workspaces/${workspaceId}/plans/2026-07-20/items/${duePlanItem.id}/activity-events`,
    headers: { "idempotency-key": "notification-core-completion" },
    payload: {
      expectedPlanId: planId,
      expectedHeadVersion: 1,
      type: "completed",
      occurredAt: "2026-07-20T12:30:00.000Z",
      timeZone: "UTC",
      durationMinutes: 30,
    },
  } as const;
  const completePlanItem = await app.inject(completePlanItemRequest);
  assert.equal(completePlanItem.statusCode, 200, completePlanItem.body);
  const planIntentKinds = await connection.sql<{ kind: string; count: number }[]>`
    select kind, count(*)::integer as count from notification_intents
    where workspace_id = ${workspaceId} and daily_plan_id = ${planId}
    group by kind order by kind
  `;
  assert.deepEqual(
    [...planIntentKinds],
    [{ kind: "plan_window_open", count: 1 }],
    "terminal activity must remove only the plan follow-up intent",
  );
  const [dueIntentAfterCompletion] = await connection.sql<{ count: number }[]>`
    select count(*)::integer as count from notification_intents
    where workspace_id = ${workspaceId} and work_item_id = ${workItemId}
  `;
  assert.equal(
    dueIntentAfterCompletion?.count,
    0,
    "completing a work-backed plan item must invalidate its due reminder",
  );
  const rematerializeRemainingFollowUp = await app.inject(materializationRequest);
  assert.equal(rematerializeRemainingFollowUp.statusCode, 200, rematerializeRemainingFollowUp.body);
  assert.equal(rematerializeRemainingFollowUp.json<{ created: unknown[] }>().created.length, 1);
  const replayCompletion = await app.inject(completePlanItemRequest);
  assert.equal(replayCompletion.statusCode, 200, replayCompletion.body);
  assert.deepEqual(replayCompletion.json(), completePlanItem.json());
  const [followUpAfterReplay] = await connection.sql<{ count: number }[]>`
    select count(*)::integer as count from notification_intents
    where workspace_id = ${workspaceId} and daily_plan_id = ${planId}
      and kind = 'daily_follow_up'
  `;
  assert.equal(
    followUpAfterReplay?.count,
    1,
    "an idempotent activity replay must preserve a newly rematerialized follow-up",
  );

  const [outboxAfter] = await connection.sql<{ count: number }[]>`
    select count(*)::integer as count from outbox_events where workspace_id = ${workspaceId}
  `;
  assert.deepEqual(
    outboxAfter,
    outboxBefore,
    "notification materialization must not enqueue delivery",
  );

  await expectConstraint(
    () =>
      connection.sql`
        insert into notification_profiles (
          workspace_id, time_zone, quiet_hours_start_minute, quiet_hours_end_minute
        ) values (${isolatedWorkspaceId}, 'UTC', 1320, null)
      `,
    "23514",
    "notification_profiles_quiet_hours_pair",
  );
  await expectConstraint(
    () =>
      connection.sql`
        insert into notification_rules (
          workspace_id, kind, local_minute, lead_minutes
        ) values (${isolatedWorkspaceId}, 'daily_digest', null, 15)
      `,
    "23514",
    "notification_rules_configuration_valid",
  );
  await expectConstraint(
    () =>
      connection.sql`
        insert into notification_intents (
          workspace_id, rule_id, rule_kind, kind, occurrence_key, target_type, scheduled_for,
          local_date, priority, policy_snapshot, local_time_resolution
        ) values (
          ${isolatedWorkspaceId}, ${ruleIds[0]!}, 'daily_digest', 'daily_digest', 'cross-tenant-occurrence',
          'workspace', '2026-07-20T14:00:00.000Z', '2026-07-20', 50, '{}'::jsonb, 'exact'
        )
      `,
    "23503",
    "notification_intents_rule_tenant_kind_fk",
  );
  await expectConstraint(
    () =>
      connection.sql`
        insert into notification_intents (
          workspace_id, one_off_reminder_id, kind, occurrence_key, target_type, scheduled_for,
          local_date, priority, policy_snapshot, local_time_resolution
        ) values (
          ${isolatedWorkspaceId}, ${reminderId}, 'one_off', 'cross-tenant-one-off',
          'one_off', '2026-07-20T14:00:00.000Z', '2026-07-20', 100, '{}'::jsonb, 'exact'
        )
      `,
    "23503",
    "notification_intents_one_off_tenant_fk",
  );
  await expectConstraint(
    () =>
      connection.sql`
        insert into notification_intents (
          workspace_id, rule_id, rule_kind, kind, occurrence_key, target_type, work_item_id,
          scheduled_for, local_date, priority, policy_snapshot, local_time_resolution
        ) values (
          ${workspaceId}, ${ruleIds[0]!}, 'work_item_due', 'work_item_due',
          'mismatched-rule-kind', 'work_item', ${workItemId}, '2026-07-20T14:00:00.000Z',
          '2026-07-20', 50, '{}'::jsonb, 'exact'
        )
      `,
    "23503",
    "notification_intents_rule_tenant_kind_fk",
  );
  const [isolatedWorkItemRule] = await connection.sql<{ id: string }[]>`
    insert into notification_rules (workspace_id, kind, local_minute)
    values (${isolatedWorkspaceId}, 'work_item_due', 720)
    returning id::text
  `;
  assert.ok(isolatedWorkItemRule !== undefined);
  await expectConstraint(
    () =>
      connection.sql`
        insert into notification_intents (
          workspace_id, rule_id, rule_kind, kind, occurrence_key, target_type, work_item_id,
          scheduled_for, local_date, priority, policy_snapshot, local_time_resolution
        ) values (
          ${isolatedWorkspaceId}, ${isolatedWorkItemRule.id}, 'work_item_due', 'work_item_due',
          'cross-tenant-work-item-target', 'work_item', ${workItemId},
          '2026-07-20T14:00:00.000Z', '2026-07-20', 50, '{}'::jsonb, 'exact'
        )
      `,
    "23503",
    "notification_intents_work_item_tenant_fk",
  );
  const [isolatedPlanRule] = await connection.sql<{ id: string }[]>`
    insert into notification_rules (workspace_id, kind, lead_minutes)
    values (${isolatedWorkspaceId}, 'plan_window_open', 10)
    returning id::text
  `;
  assert.ok(isolatedPlanRule !== undefined);
  await expectConstraint(
    () =>
      connection.sql`
        insert into notification_intents (
          workspace_id, rule_id, rule_kind, kind, occurrence_key, target_type, daily_plan_id,
          scheduled_for, local_date, priority, policy_snapshot, local_time_resolution
        ) values (
          ${isolatedWorkspaceId}, ${isolatedPlanRule.id}, 'plan_window_open', 'plan_window_open',
          'cross-tenant-daily-plan-target', 'daily_plan', ${planId},
          '2026-07-20T14:00:00.000Z', '2026-07-20', 50, '{}'::jsonb, 'exact'
        )
      `,
    "23503",
    "notification_intents_daily_plan_tenant_fk",
  );
  const [isolatedBlockRule] = await connection.sql<{ id: string }[]>`
    insert into notification_rules (workspace_id, kind, lead_minutes)
    values (${isolatedWorkspaceId}, 'schedule_block_lead', 15)
    returning id::text
  `;
  assert.ok(isolatedBlockRule !== undefined);
  await expectConstraint(
    () =>
      connection.sql`
        insert into notification_intents (
          workspace_id, rule_id, rule_kind, kind, occurrence_key, target_type, schedule_block_id,
          scheduled_for, local_date, priority, policy_snapshot, local_time_resolution
        ) values (
          ${isolatedWorkspaceId}, ${isolatedBlockRule.id}, 'schedule_block_lead',
          'schedule_block_lead', 'cross-tenant-schedule-block-target', 'schedule_block', ${blockId},
          '2026-07-20T14:00:00.000Z', '2026-07-20', 50, '{}'::jsonb, 'exact'
        )
      `,
    "23503",
    "notification_intents_schedule_block_tenant_fk",
  );
  await expectConstraint(
    () =>
      connection.sql`
        insert into notification_intents (
          workspace_id, rule_id, rule_kind, kind, occurrence_key, target_type, work_item_id,
          scheduled_for, local_date, priority, policy_snapshot, local_time_resolution
        ) values (
          ${workspaceId}, ${ruleIds[0]!}, 'daily_digest', 'daily_digest',
          'malformed-kind-target', 'work_item', ${workItemId},
          '2026-07-20T14:00:00.000Z', '2026-07-20', 50, '{}'::jsonb, 'exact'
        )
      `,
    "23514",
    "notification_intents_target_valid",
  );
  await expectConstraint(
    () =>
      connection.sql`
        insert into notification_intents (
          workspace_id, rule_id, one_off_reminder_id, kind, occurrence_key, target_type,
          scheduled_for, local_date, priority, policy_snapshot, local_time_resolution
        ) values (
          ${workspaceId}, ${ruleIds[0]!}, ${reminderId}, 'one_off', 'malformed-source-shape',
          'one_off', '2026-07-20T14:00:00.000Z', '2026-07-20', 100, '{}'::jsonb, 'exact'
        )
      `,
    "23514",
    "notification_intents_source_valid",
  );
  await expectConstraint(
    () =>
      connection.sql`
        delete from notification_rules
        where workspace_id = ${workspaceId} and id = ${ruleIds[0]!}
      `,
    "23503",
    "notification_intents_rule_tenant_kind_fk",
  );
  await expectConstraint(
    () =>
      connection.sql`
        delete from one_off_reminders
        where workspace_id = ${workspaceId} and id = ${reminderId}
      `,
    "23503",
    "notification_intents_one_off_tenant_fk",
  );
  const existingIntent = intents[0]!;
  await expectConstraint(
    () =>
      connection.sql`
        insert into notification_intents (
          workspace_id, rule_id, rule_kind, kind, occurrence_key, target_type, scheduled_for,
          local_date, priority, policy_snapshot, local_time_resolution
        ) values (
          ${workspaceId}, ${ruleIds[0]!}, 'daily_digest', 'daily_digest', ${existingIntent.occurrenceKey},
          'workspace', '2026-07-20T14:00:00.000Z', '2026-07-20', 50, '{}'::jsonb, 'exact'
        )
      `,
    "23505",
    "notification_intents_workspace_occurrence_uq",
  );

  const deleteBlock = await app.inject({
    method: "DELETE",
    url: `/v1/workspaces/${workspaceId}/schedule-blocks/${blockId}`,
    payload: { expectedVersion: 2 },
  });
  assert.equal(deleteBlock.statusCode, 204, deleteBlock.body);
  const [remainingBlockIntent] = await connection.sql<{ count: number }[]>`
    select count(*)::integer as count
    from notification_intents
    where workspace_id = ${workspaceId} and schedule_block_id = ${blockId}
  `;
  assert.equal(remainingBlockIntent?.count, 0, "deleting a target must cascade its pending intent");

  const [cascadeWorkItem] = await connection.sql<{ id: string }[]>`
    insert into work_items (workspace_id, title, due_on)
    values (${workspaceId}, 'Cascade-only notification target', '2026-07-20')
    returning id::text
  `;
  assert.ok(cascadeWorkItem !== undefined);
  await connection.sql`
    insert into notification_intents (
      workspace_id, rule_id, rule_kind, kind, occurrence_key, target_type, work_item_id,
      scheduled_for, local_date, priority, policy_snapshot, local_time_resolution
    ) values (
      ${workspaceId}, ${ruleIds[4]!}, 'work_item_due', 'work_item_due', 'cascade-work-item-intent',
      'work_item', ${cascadeWorkItem.id}, '2026-07-20T14:00:00.000Z', '2026-07-20', 50,
      '{}'::jsonb, 'exact'
    )
  `;
  await connection.sql`delete from work_items where id = ${cascadeWorkItem.id}`;
  const [remainingWorkItemIntent] = await connection.sql<{ count: number }[]>`
    select count(*)::integer as count from notification_intents
    where workspace_id = ${workspaceId} and work_item_id = ${cascadeWorkItem.id}
  `;
  assert.equal(remainingWorkItemIntent?.count, 0, "work-item deletion must cascade its intent");

  await connection.sql.begin(async (sql) => {
    await sql`select set_config('schedule.allow_activity_event_mutation', 'on', true)`;
    await sql`select set_config('schedule.allow_plan_interaction_event_mutation', 'on', true)`;
    await sql`delete from daily_plan_item_states where workspace_id = ${workspaceId} and plan_id = ${planId}`;
    await sql`delete from plan_interaction_events where workspace_id = ${workspaceId} and plan_id = ${planId}`;
    await sql`delete from activity_events where workspace_id = ${workspaceId} and plan_id = ${planId}`;
    await sql`delete from daily_plans where workspace_id = ${workspaceId} and id = ${planId}`;
  });
  const [remainingPlanIntents] = await connection.sql<{ count: number }[]>`
    select count(*)::integer as count from notification_intents
    where workspace_id = ${workspaceId} and daily_plan_id = ${planId}
  `;
  assert.equal(remainingPlanIntents?.count, 0, "daily-plan deletion must cascade its intents");

  const sourceLimitWorkspaceId = await createWorkspace("Notification source limit verification");
  const sourceLimitProfile = await app.inject({
    method: "PUT",
    url: `/v1/workspaces/${sourceLimitWorkspaceId}/notification-profile`,
    payload: {
      expectedVersion: null,
      timeZone: "UTC",
      quietHoursStartMinute: null,
      quietHoursEndMinute: null,
      quietHoursPolicy: "next_allowed",
      catchUpWindowMinutes: 0,
      dailyIntentLimit: 100,
    },
  });
  assert.equal(sourceLimitProfile.statusCode, 200, sourceLimitProfile.body);
  await connection.sql`
    insert into one_off_reminders (workspace_id, title, scheduled_for)
    select
      ${sourceLimitWorkspaceId},
      'Source limit ' || source::text,
      '2026-07-20T13:00:00.000Z'::timestamptz + source * interval '1 millisecond'
    from generate_series(1, 5001) as source
  `;
  const sourceLimitResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${sourceLimitWorkspaceId}/notification-intents/materializations`,
    payload: {
      from: "2026-07-20T08:00:00.000Z",
      through: "2026-07-21T00:00:00.000Z",
    },
  });
  assert.equal(sourceLimitResponse.statusCode, 422, sourceLimitResponse.body);
  assert.equal(
    sourceLimitResponse.json<{ error: { code: string } }>().error.code,
    "notification.materialization_source_limit",
  );

  const candidateLimitWorkspaceId = await createWorkspace(
    "Notification candidate limit verification",
  );
  const candidateLimitProfile = await app.inject({
    method: "PUT",
    url: `/v1/workspaces/${candidateLimitWorkspaceId}/notification-profile`,
    payload: {
      expectedVersion: null,
      timeZone: "UTC",
      quietHoursStartMinute: null,
      quietHoursEndMinute: null,
      quietHoursPolicy: "next_allowed",
      catchUpWindowMinutes: 0,
      dailyIntentLimit: 100,
    },
  });
  assert.equal(candidateLimitProfile.statusCode, 200, candidateLimitProfile.body);
  const candidateWindowStart = Date.parse("2026-07-20T09:00:00.000Z");
  const candidatePlan = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${candidateLimitWorkspaceId}/plans`,
    payload: {
      date: "2026-07-20",
      timeZone: "UTC",
      availableWindows: Array.from({ length: 64 }, (_, index) => ({
        startsAt: new Date(candidateWindowStart + index * 5 * 60_000).toISOString(),
        endsAt: new Date(candidateWindowStart + (index * 5 + 2) * 60_000).toISOString(),
      })),
      targetMinutes: 30,
      targetTaskCount: 1,
      availableContexts: [],
      seed: "notification-candidate-limit",
      requestRevision: 1,
    },
  });
  assert.equal(candidatePlan.statusCode, 200, candidatePlan.body);
  await connection.sql`
    insert into notification_rules (workspace_id, kind, lead_minutes)
    select ${candidateLimitWorkspaceId}, 'plan_window_open', 0
    from generate_series(1, 100)
  `;
  await connection.sql`
    insert into one_off_reminders (workspace_id, title, scheduled_for)
    select
      ${candidateLimitWorkspaceId},
      'Candidate limit ' || source::text,
      '2026-07-20T13:00:00.000Z'::timestamptz + source * interval '1 millisecond'
    from generate_series(1, 5000) as source
  `;
  const candidateLimitResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${candidateLimitWorkspaceId}/notification-intents/materializations`,
    payload: {
      from: "2026-07-20T08:00:00.000Z",
      through: "2026-07-21T00:00:00.000Z",
    },
  });
  assert.equal(candidateLimitResponse.statusCode, 422, candidateLimitResponse.body);
  assert.equal(
    candidateLimitResponse.json<{ error: { code: string } }>().error.code,
    "notification.materialization_candidate_limit",
  );

  console.log(
    "Notification policy core verification passed: six source kinds, concurrent exact-once materialization, source and target invalidation, replay-safe selective terminal cleanup, fail-closed production query/candidate limits, exhaustive tenant/target constraints, target deletion cleanup, and no delivery side effects.",
  );
} finally {
  await removeWorkspaces();
  await app.close();
  await connection.close();
}
