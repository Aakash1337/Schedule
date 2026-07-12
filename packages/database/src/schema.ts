import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const workItemStatus = pgEnum("work_item_status", [
  "backlog",
  "planned",
  "in_progress",
  "blocked",
  "done",
  "cancelled",
]);

export const workItemPriority = pgEnum("work_item_priority", [
  "none",
  "low",
  "medium",
  "high",
  "urgent",
]);

export const outboxStatus = pgEnum("outbox_status", [
  "pending",
  "processing",
  "completed",
  "dead_letter",
]);

export const routineStatus = pgEnum("routine_status", ["active", "paused", "archived"]);
export const routinePriority = pgEnum("routine_priority", ["low", "medium", "high", "critical"]);
export const routineEffort = pgEnum("routine_effort", ["quick", "short", "medium", "deep"]);
export const routineEnergy = pgEnum("routine_energy", ["low", "normal", "high"]);
export const routinePreference = pgEnum("routine_preference", [
  "enjoyable",
  "neutral",
  "unpleasant",
]);
export const cadencePeriod = pgEnum("cadence_period", ["day", "week", "month", "rolling_days"]);
export const dailyPlanStatus = pgEnum("daily_plan_status", [
  "generated",
  "accepted",
  "superseded",
  "discarded",
]);
export const activityEventType = pgEnum("activity_event_type", [
  "suggested",
  "accepted",
  "started",
  "completed",
  "skipped",
  "deferred",
  "dismissed",
  "duration_corrected",
  "completion_reversed",
]);
export const planInteractionType = pgEnum("plan_interaction_type", [
  "locked",
  "unlocked",
  "started",
  "completed",
  "skipped",
  "deferred",
  "dismissed",
  "completion_reversed",
]);
export const planItemActivityState = pgEnum("plan_item_activity_state", [
  "pending",
  "started",
  "completed",
  "skipped",
  "deferred",
  "dismissed",
]);
export const planMutationKind = pgEnum("plan_mutation_kind", ["regenerate", "replace"]);

export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 160 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const workItems = pgTable(
  "work_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    title: varchar("title", { length: 240 }).notNull(),
    description: text("description"),
    status: workItemStatus("status").notNull().default("backlog"),
    priority: workItemPriority("priority").notNull().default("none"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("work_items_workspace_id_id_uq").on(table.workspaceId, table.id),
    index("work_items_workspace_status_idx").on(table.workspaceId, table.status),
    index("work_items_workspace_created_id_idx").on(table.workspaceId, table.createdAt, table.id),
    index("work_items_workspace_status_priority_created_id_idx").on(
      table.workspaceId,
      table.status,
      table.priority,
      table.createdAt,
      table.id,
    ),
    check("work_items_version_positive", sql`${table.version} > 0`),
  ],
);

export const recurrenceSeries = pgTable(
  "recurrence_series",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    rule: text("rule").notNull(),
    localStart: timestamp("local_start", { withTimezone: false }).notNull(),
    timeZone: varchar("time_zone", { length: 80 }).notNull(),
    durationMinutes: integer("duration_minutes").notNull(),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("recurrence_series_workspace_id_id_uq").on(table.workspaceId, table.id),
    check("recurrence_series_duration_positive", sql`${table.durationMinutes} > 0`),
  ],
);

export const scheduleBlocks = pgTable(
  "schedule_blocks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    workItemId: uuid("work_item_id"),
    recurrenceSeriesId: uuid("recurrence_series_id"),
    title: varchar("title", { length: 240 }),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    timeZone: varchar("time_zone", { length: 80 }).notNull(),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("schedule_blocks_workspace_id_id_uq").on(table.workspaceId, table.id),
    index("schedule_blocks_workspace_range_idx").on(
      table.workspaceId,
      table.startsAt,
      table.endsAt,
    ),
    index("schedule_blocks_workspace_range_order_idx").on(
      table.workspaceId,
      table.startsAt,
      table.endsAt,
      table.id,
    ),
    foreignKey({
      name: "schedule_blocks_work_item_tenant_fk",
      columns: [table.workspaceId, table.workItemId],
      foreignColumns: [workItems.workspaceId, workItems.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "schedule_blocks_recurrence_tenant_fk",
      columns: [table.workspaceId, table.recurrenceSeriesId],
      foreignColumns: [recurrenceSeries.workspaceId, recurrenceSeries.id],
    }).onDelete("cascade"),
    check("schedule_blocks_valid_range", sql`${table.endsAt} > ${table.startsAt}`),
    check("schedule_blocks_version_positive", sql`${table.version} > 0`),
  ],
);

export const routines = pgTable(
  "routines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    title: varchar("title", { length: 240 }).notNull(),
    description: text("description"),
    status: routineStatus("status").notNull().default("active"),
    priority: routinePriority("priority").notNull().default("medium"),
    effort: routineEffort("effort").notNull().default("medium"),
    energy: routineEnergy("energy").notNull().default("normal"),
    preference: routinePreference("preference").notNull().default("neutral"),
    contexts: text("contexts")
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    categories: text("categories")
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    freeFormTags: text("free_form_tags")
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    minimumDurationMinutes: integer("minimum_duration_minutes").notNull(),
    expectedDurationMinutes: integer("expected_duration_minutes").notNull(),
    maximumDurationMinutes: integer("maximum_duration_minutes").notNull(),
    splittable: boolean("splittable").notNull().default(false),
    minimumSessionMinutes: integer("minimum_session_minutes"),
    overheadMinutes: integer("overhead_minutes").notNull().default(0),
    cadencePeriod: cadencePeriod("cadence_period").notNull(),
    rollingIntervalDays: integer("rolling_interval_days"),
    targetCompletions: integer("target_completions").notNull(),
    minimumCompletions: integer("minimum_completions"),
    maximumCompletions: integer("maximum_completions"),
    minimumSpacingDays: integer("minimum_spacing_days").notNull().default(0),
    preferredWeekdays: integer("preferred_weekdays")
      .array()
      .notNull()
      .default(sql`ARRAY[]::integer[]`),
    excludedWeekdays: integer("excluded_weekdays")
      .array()
      .notNull()
      .default(sql`ARRAY[]::integer[]`),
    discourageConsecutiveDays: boolean("discourage_consecutive_days").notNull().default(false),
    prohibitConsecutiveDays: boolean("prohibit_consecutive_days").notNull().default(false),
    weekStartsOn: integer("week_starts_on").notNull().default(1),
    startsOn: date("starts_on"),
    pausedUntil: date("paused_until"),
    endsOn: date("ends_on"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("routines_workspace_id_id_uq").on(table.workspaceId, table.id),
    index("routines_workspace_status_idx").on(table.workspaceId, table.status),
    index("routines_workspace_cadence_idx").on(table.workspaceId, table.cadencePeriod),
    check(
      "routines_duration_range_valid",
      sql`${table.minimumDurationMinutes} > 0 AND ${table.minimumDurationMinutes} <= ${table.expectedDurationMinutes} AND ${table.expectedDurationMinutes} <= ${table.maximumDurationMinutes}`,
    ),
    check("routines_overhead_nonnegative", sql`${table.overheadMinutes} >= 0`),
    check(
      "routines_split_policy_valid",
      sql`(${table.splittable} AND ${table.minimumSessionMinutes} IS NOT NULL AND ${table.minimumSessionMinutes} > 0 AND ${table.minimumSessionMinutes} <= ${table.minimumDurationMinutes}) OR (NOT ${table.splittable} AND ${table.minimumSessionMinutes} IS NULL)`,
    ),
    check(
      "routines_cadence_counts_valid",
      sql`${table.targetCompletions} > 0 AND (${table.minimumCompletions} IS NULL OR (${table.minimumCompletions} > 0 AND ${table.minimumCompletions} <= ${table.targetCompletions})) AND (${table.maximumCompletions} IS NULL OR ${table.maximumCompletions} >= ${table.targetCompletions})`,
    ),
    check(
      "routines_rolling_interval_valid",
      sql`(${table.cadencePeriod} = 'rolling_days' AND ${table.rollingIntervalDays} IS NOT NULL AND ${table.rollingIntervalDays} > 0) OR (${table.cadencePeriod} <> 'rolling_days' AND ${table.rollingIntervalDays} IS NULL)`,
    ),
    check("routines_spacing_nonnegative", sql`${table.minimumSpacingDays} >= 0`),
    check(
      "routines_preferred_weekdays_valid",
      sql`${table.preferredWeekdays} <@ ARRAY[0, 1, 2, 3, 4, 5, 6]::integer[]`,
    ),
    check(
      "routines_preferred_weekdays_unique",
      sql`schedule_integer_array_is_unique(${table.preferredWeekdays})`,
    ),
    check(
      "routines_preferred_weekdays_one_dimensional",
      sql`cardinality(${table.preferredWeekdays}) = 0 OR (array_ndims(${table.preferredWeekdays}) = 1 AND array_lower(${table.preferredWeekdays}, 1) = 1)`,
    ),
    check(
      "routines_excluded_weekdays_valid",
      sql`${table.excludedWeekdays} <@ ARRAY[0, 1, 2, 3, 4, 5, 6]::integer[]`,
    ),
    check(
      "routines_excluded_weekdays_unique",
      sql`schedule_integer_array_is_unique(${table.excludedWeekdays})`,
    ),
    check(
      "routines_excluded_weekdays_one_dimensional",
      sql`cardinality(${table.excludedWeekdays}) = 0 OR (array_ndims(${table.excludedWeekdays}) = 1 AND array_lower(${table.excludedWeekdays}, 1) = 1)`,
    ),
    check(
      "routines_weekdays_disjoint",
      sql`NOT (${table.preferredWeekdays} && ${table.excludedWeekdays})`,
    ),
    check("routines_week_start_valid", sql`${table.weekStartsOn} BETWEEN 0 AND 6`),
    check(
      "routines_consecutive_policy_valid",
      sql`NOT ${table.prohibitConsecutiveDays} OR ${table.discourageConsecutiveDays}`,
    ),
    check(
      "routines_date_range_valid",
      sql`${table.startsOn} IS NULL OR ${table.endsOn} IS NULL OR ${table.startsOn} <= ${table.endsOn}`,
    ),
    check("routines_version_positive", sql`${table.version} > 0`),
  ],
);

export const dailyPlans = pgTable(
  "daily_plans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    localDate: date("local_date").notNull(),
    timeZone: varchar("time_zone", { length: 80 }).notNull(),
    status: dailyPlanStatus("status").notNull().default("generated"),
    requestRevision: integer("request_revision").notNull(),
    algorithmVersion: varchar("algorithm_version", { length: 120 }).notNull(),
    configVersion: varchar("config_version", { length: 120 }).notNull(),
    prngVersion: varchar("prng_version", { length: 120 }).notNull(),
    seed: varchar("seed", { length: 240 }).notNull(),
    inputHash: varchar("input_hash", { length: 64 }).notNull(),
    inputSnapshot: jsonb("input_snapshot").$type<Record<string, unknown>>().notNull(),
    totalMinutes: integer("total_minutes").notNull(),
    fitness: integer("fitness").notNull(),
    warnings: text("warnings")
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    exclusions: jsonb("exclusions")
      .$type<readonly { routineId: string; title: string; codes: readonly string[] }[]>()
      .notNull()
      .default([]),
    generatedAt: timestamp("generated_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("daily_plans_workspace_id_id_uq").on(table.workspaceId, table.id),
    unique("daily_plans_workspace_date_revision_uq").on(
      table.workspaceId,
      table.localDate,
      table.requestRevision,
    ),
    index("daily_plans_workspace_date_idx").on(table.workspaceId, table.localDate),
    check("daily_plans_revision_positive", sql`${table.requestRevision} > 0`),
    check("daily_plans_minutes_nonnegative", sql`${table.totalMinutes} >= 0`),
    check("daily_plans_input_hash_length", sql`char_length(${table.inputHash}) = 64`),
  ],
);

export const dailyPlanHeads = pgTable(
  "daily_plan_heads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    localDate: date("local_date").notNull(),
    currentPlanId: uuid("current_plan_id").notNull(),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("daily_plan_heads_workspace_date_uq").on(table.workspaceId, table.localDate),
    foreignKey({
      name: "daily_plan_heads_plan_tenant_fk",
      columns: [table.workspaceId, table.currentPlanId],
      foreignColumns: [dailyPlans.workspaceId, dailyPlans.id],
    }).onDelete("cascade"),
    check("daily_plan_heads_version_positive", sql`${table.version} > 0`),
  ],
);

export const activityEvents = pgTable(
  "activity_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ingestedSequence: bigserial("ingested_sequence", { mode: "number" }).notNull(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    routineId: uuid("routine_id").notNull(),
    planId: uuid("plan_id"),
    planItemId: uuid("plan_item_id"),
    type: activityEventType("type").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    localDate: date("local_date").notNull(),
    timeZone: varchar("time_zone", { length: 80 }).notNull(),
    durationMinutes: integer("duration_minutes"),
    reason: varchar("reason", { length: 500 }),
    referenceEventId: uuid("reference_event_id"),
    idempotencyKey: varchar("idempotency_key", { length: 160 }).notNull(),
    metadata: jsonb("metadata")
      .$type<Record<string, string | number | boolean | null>>()
      .notNull()
      .default({}),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("activity_events_workspace_id_id_uq").on(table.workspaceId, table.id),
    unique("activity_events_workspace_plan_item_id_uq").on(
      table.workspaceId,
      table.planId,
      table.planItemId,
      table.id,
    ),
    unique("activity_events_workspace_routine_id_id_uq").on(
      table.workspaceId,
      table.routineId,
      table.id,
    ),
    unique("activity_events_workspace_idempotency_uq").on(table.workspaceId, table.idempotencyKey),
    index("activity_events_routine_occurred_idx").on(
      table.workspaceId,
      table.routineId,
      table.occurredAt,
    ),
    index("activity_events_routine_sequence_idx").on(
      table.workspaceId,
      table.routineId,
      table.ingestedSequence,
    ),
    index("activity_events_workspace_local_date_idx").on(table.workspaceId, table.localDate),
    foreignKey({
      name: "activity_events_routine_tenant_fk",
      columns: [table.workspaceId, table.routineId],
      foreignColumns: [routines.workspaceId, routines.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "activity_events_plan_tenant_fk",
      columns: [table.workspaceId, table.planId],
      foreignColumns: [dailyPlans.workspaceId, dailyPlans.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "activity_events_plan_item_tenant_fk",
      columns: [table.workspaceId, table.planId, table.planItemId],
      foreignColumns: [dailyPlanItems.workspaceId, dailyPlanItems.planId, dailyPlanItems.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "activity_events_reference_tenant_fk",
      columns: [table.workspaceId, table.routineId, table.referenceEventId],
      foreignColumns: [table.workspaceId, table.routineId, table.id],
    }).onDelete("restrict"),
    check(
      "activity_events_duration_positive",
      sql`${table.durationMinutes} IS NULL OR ${table.durationMinutes} > 0`,
    ),
    check(
      "activity_events_reference_policy",
      sql`(${table.type} = 'duration_corrected' AND ${table.referenceEventId} IS NOT NULL AND ${table.durationMinutes} IS NOT NULL) OR (${table.type} = 'completion_reversed' AND ${table.referenceEventId} IS NOT NULL AND ${table.durationMinutes} IS NULL) OR (${table.type} NOT IN ('duration_corrected', 'completion_reversed') AND ${table.referenceEventId} IS NULL)`,
    ),
    check(
      "activity_events_plan_item_requires_plan",
      sql`${table.planItemId} IS NULL OR ${table.planId} IS NOT NULL`,
    ),
  ],
);

export const dailyPlanItems = pgTable(
  "daily_plan_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    planId: uuid("plan_id").notNull(),
    routineId: uuid("routine_id").notNull(),
    titleSnapshot: varchar("title_snapshot", { length: 240 }).notNull(),
    position: integer("position").notNull(),
    windowIndex: integer("window_index").notNull(),
    scheduledMinutes: integer("scheduled_minutes").notNull(),
    partialSession: boolean("partial_session").notNull().default(false),
    score: integer("score").notNull(),
    scoreComponents: jsonb("score_components").$type<Record<string, number>>().notNull(),
    reasons: text("reasons")
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("daily_plan_items_workspace_id_id_uq").on(table.workspaceId, table.id),
    unique("daily_plan_items_workspace_plan_id_uq").on(table.workspaceId, table.planId, table.id),
    unique("daily_plan_items_plan_position_uq").on(table.workspaceId, table.planId, table.position),
    unique("daily_plan_items_plan_routine_uq").on(table.workspaceId, table.planId, table.routineId),
    foreignKey({
      name: "daily_plan_items_plan_tenant_fk",
      columns: [table.workspaceId, table.planId],
      foreignColumns: [dailyPlans.workspaceId, dailyPlans.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "daily_plan_items_routine_tenant_fk",
      columns: [table.workspaceId, table.routineId],
      foreignColumns: [routines.workspaceId, routines.id],
    }).onDelete("restrict"),
    check("daily_plan_items_position_nonnegative", sql`${table.position} >= 0`),
    check("daily_plan_items_window_nonnegative", sql`${table.windowIndex} >= 0`),
    check("daily_plan_items_duration_positive", sql`${table.scheduledMinutes} > 0`),
  ],
);

export const dailyPlanItemStates = pgTable(
  "daily_plan_item_states",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    planId: uuid("plan_id").notNull(),
    itemId: uuid("item_id").notNull(),
    locked: boolean("locked").notNull().default(false),
    activityState: planItemActivityState("activity_state").notNull().default("pending"),
    lastActivityEventId: uuid("last_activity_event_id"),
    activityUpdatedAt: timestamp("activity_updated_at", { withTimezone: true }),
    version: integer("version").notNull().default(1),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("daily_plan_item_states_item_uq").on(table.workspaceId, table.planId, table.itemId),
    foreignKey({
      name: "daily_plan_item_states_item_tenant_fk",
      columns: [table.workspaceId, table.planId, table.itemId],
      foreignColumns: [dailyPlanItems.workspaceId, dailyPlanItems.planId, dailyPlanItems.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "daily_plan_item_states_activity_tenant_fk",
      columns: [table.workspaceId, table.planId, table.itemId, table.lastActivityEventId],
      foreignColumns: [
        activityEvents.workspaceId,
        activityEvents.planId,
        activityEvents.planItemId,
        activityEvents.id,
      ],
    }).onDelete("restrict"),
    check("daily_plan_item_states_version_positive", sql`${table.version} > 0`),
    check(
      "daily_plan_item_states_activity_projection_consistent",
      sql`(${table.activityState} = 'pending' AND ${table.lastActivityEventId} IS NULL AND ${table.activityUpdatedAt} IS NULL) OR (${table.lastActivityEventId} IS NOT NULL AND ${table.activityUpdatedAt} IS NOT NULL)`,
    ),
  ],
);

export const planInteractionEvents = pgTable(
  "plan_interaction_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ingestedSequence: bigserial("ingested_sequence", { mode: "number" }).notNull(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    localDate: date("local_date").notNull(),
    planId: uuid("plan_id").notNull(),
    itemId: uuid("item_id").notNull(),
    type: planInteractionType("type").notNull(),
    activityEventId: uuid("activity_event_id"),
    idempotencyKey: varchar("idempotency_key", { length: 160 }).notNull(),
    payloadHash: varchar("payload_hash", { length: 64 }).notNull(),
    resultHeadVersion: integer("result_head_version").notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    unique("plan_interaction_events_workspace_idempotency_uq").on(
      table.workspaceId,
      table.idempotencyKey,
    ),
    index("plan_interaction_events_day_sequence_idx").on(
      table.workspaceId,
      table.localDate,
      table.ingestedSequence,
    ),
    foreignKey({
      name: "plan_interaction_events_head_tenant_fk",
      columns: [table.workspaceId, table.localDate],
      foreignColumns: [dailyPlanHeads.workspaceId, dailyPlanHeads.localDate],
    }).onDelete("cascade"),
    foreignKey({
      name: "plan_interaction_events_item_tenant_fk",
      columns: [table.workspaceId, table.planId, table.itemId],
      foreignColumns: [dailyPlanItems.workspaceId, dailyPlanItems.planId, dailyPlanItems.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "plan_interaction_events_activity_tenant_fk",
      columns: [table.workspaceId, table.planId, table.itemId, table.activityEventId],
      foreignColumns: [
        activityEvents.workspaceId,
        activityEvents.planId,
        activityEvents.planItemId,
        activityEvents.id,
      ],
    }).onDelete("restrict"),
    check("plan_interaction_events_hash_length", sql`char_length(${table.payloadHash}) = 64`),
    check("plan_interaction_events_head_version_positive", sql`${table.resultHeadVersion} > 0`),
    check(
      "plan_interaction_events_activity_policy",
      sql`(${table.type} IN ('locked', 'unlocked') AND ${table.activityEventId} IS NULL) OR (${table.type} NOT IN ('locked', 'unlocked') AND ${table.activityEventId} IS NOT NULL)`,
    ),
  ],
);

export const planMutations = pgTable(
  "plan_mutations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    localDate: date("local_date").notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 160 }).notNull(),
    payloadHash: varchar("payload_hash", { length: 64 }).notNull(),
    kind: planMutationKind("kind").notNull(),
    sourcePlanId: uuid("source_plan_id").notNull(),
    resultPlanId: uuid("result_plan_id").notNull(),
    resultHeadVersion: integer("result_head_version").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    unique("plan_mutations_workspace_date_idempotency_uq").on(
      table.workspaceId,
      table.localDate,
      table.idempotencyKey,
    ),
    foreignKey({
      name: "plan_mutations_source_plan_tenant_fk",
      columns: [table.workspaceId, table.sourcePlanId],
      foreignColumns: [dailyPlans.workspaceId, dailyPlans.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "plan_mutations_result_plan_tenant_fk",
      columns: [table.workspaceId, table.resultPlanId],
      foreignColumns: [dailyPlans.workspaceId, dailyPlans.id],
    }).onDelete("cascade"),
    check("plan_mutations_hash_length", sql`char_length(${table.payloadHash}) = 64`),
    check("plan_mutations_head_version_positive", sql`${table.resultHeadVersion} > 0`),
  ],
);

export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
    topic: varchar("topic", { length: 160 }).notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: outboxStatus("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("outbox_claim_idx").on(table.status, table.availableAt),
    check("outbox_attempts_nonnegative", sql`${table.attempts} >= 0`),
  ],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    actorId: uuid("actor_id"),
    action: varchar("action", { length: 160 }).notNull(),
    entityType: varchar("entity_type", { length: 120 }).notNull(),
    entityId: uuid("entity_id").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("audit_workspace_occurred_idx").on(table.workspaceId, table.occurredAt)],
);
