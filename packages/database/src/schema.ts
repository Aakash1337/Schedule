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
  primaryKey,
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

/** The immutable source behind a planned item or activity event. */
export const planningSourceType = pgEnum("planning_source_type", ["routine", "work_item"]);

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
export const integrationRequestStatus = pgEnum("integration_request_status", [
  "processing",
  "succeeded",
]);
export const webhookEndpointStatus = pgEnum("webhook_endpoint_status", ["active", "revoked"]);
export const webhookSecretStatus = pgEnum("webhook_secret_status", [
  "pending",
  "active",
  "retired",
]);

export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 160 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Provider-neutral credentials for trusted automation clients.
 *
 * `secretDigest` is deliberately the only persisted secret material. The
 * plaintext bearer secret exists only at provisioning/authentication
 * boundaries outside this package.
 */
export const integrationCredentials = pgTable(
  "integration_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 160 }).notNull(),
    secretDigest: varchar("secret_digest", { length: 64 }).notNull(),
    scopes: text("scopes").array().notNull(),
    active: boolean("active").notNull().default(true),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("integration_credentials_workspace_id_id_uq").on(table.workspaceId, table.id),
    index("integration_credentials_workspace_active_idx").on(
      table.workspaceId,
      table.active,
      table.expiresAt,
    ),
    check("integration_credentials_name_nonempty", sql`char_length(trim(${table.name})) > 0`),
    check(
      "integration_credentials_secret_digest_length",
      sql`char_length(${table.secretDigest}) = 64`,
    ),
    check(
      "integration_credentials_secret_digest_format",
      sql`${table.secretDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check("integration_credentials_scopes_nonempty", sql`cardinality(${table.scopes}) > 0`),
    check(
      "integration_credentials_scopes_allowed",
      sql`${table.scopes} <@ ARRAY['schedule:read', 'schedule:write']::text[]`,
    ),
    check(
      "integration_credentials_scopes_unique",
      sql`cardinality(${table.scopes}) = (CASE WHEN 'schedule:read' = ANY(${table.scopes}) THEN 1 ELSE 0 END + CASE WHEN 'schedule:write' = ANY(${table.scopes}) THEN 1 ELSE 0 END)`,
    ),
    check(
      "integration_credentials_scopes_one_dimensional",
      sql`array_ndims(${table.scopes}) = 1 AND array_lower(${table.scopes}, 1) = 1`,
    ),
    check(
      "integration_credentials_scopes_no_empty",
      sql`array_position(${table.scopes}, '') IS NULL`,
    ),
    check(
      "integration_credentials_revocation_consistent",
      sql`(${table.active} AND ${table.revokedAt} IS NULL) OR (NOT ${table.active} AND ${table.revokedAt} IS NOT NULL)`,
    ),
    check(
      "integration_credentials_expiry_after_creation",
      sql`${table.expiresAt} IS NULL OR ${table.expiresAt} > ${table.createdAt}`,
    ),
    check(
      "integration_credentials_revocation_after_creation",
      sql`${table.revokedAt} IS NULL OR ${table.revokedAt} >= ${table.createdAt}`,
    ),
    check(
      "integration_credentials_updated_after_creation",
      sql`${table.updatedAt} >= ${table.createdAt}`,
    ),
    check("integration_credentials_version_positive", sql`${table.version} > 0`),
  ],
);

/** One-time confirmation challenges for operations requiring explicit consent. */
export const integrationConfirmations = pgTable(
  "integration_confirmations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    credentialId: uuid("credential_id").notNull(),
    requestId: varchar("request_id", { length: 160 }).notNull(),
    commandHash: varchar("command_hash", { length: 64 }).notNull(),
    commandKind: varchar("command_kind", { length: 160 }).notNull(),
    command: jsonb("command").$type<Record<string, unknown>>().notNull(),
    summary: varchar("summary", { length: 500 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("integration_confirmations_tenant_credential_id_uq").on(
      table.workspaceId,
      table.credentialId,
      table.id,
    ),
    unique("integration_confirmations_command_binding_uq").on(
      table.workspaceId,
      table.credentialId,
      table.id,
      table.commandKind,
      table.commandHash,
    ),
    unique("integration_confirmations_credential_request_uq").on(
      table.credentialId,
      table.requestId,
    ),
    index("integration_confirmations_workspace_expiry_idx").on(table.workspaceId, table.expiresAt),
    index("integration_confirmations_credential_expiry_idx").on(
      table.credentialId,
      table.expiresAt,
      table.consumedAt,
    ),
    foreignKey({
      name: "integration_confirmations_credential_tenant_fk",
      columns: [table.workspaceId, table.credentialId],
      foreignColumns: [integrationCredentials.workspaceId, integrationCredentials.id],
    }).onDelete("cascade"),
    check(
      "integration_confirmations_request_id_nonempty",
      sql`char_length(trim(${table.requestId})) > 0`,
    ),
    check(
      "integration_confirmations_command_hash_length",
      sql`char_length(${table.commandHash}) = 64`,
    ),
    check(
      "integration_confirmations_command_kind_nonempty",
      sql`char_length(trim(${table.commandKind})) > 0`,
    ),
    check(
      "integration_confirmations_command_binding_valid",
      sql`jsonb_typeof(${table.command}) = 'object' AND ${table.command}->>'type' = ${table.commandKind}`,
    ),
    check(
      "integration_confirmations_summary_nonempty",
      sql`char_length(trim(${table.summary})) > 0`,
    ),
    check(
      "integration_confirmations_expiry_after_creation",
      sql`${table.expiresAt} > ${table.createdAt}`,
    ),
    check(
      "integration_confirmations_consumption_after_creation",
      sql`${table.consumedAt} IS NULL OR ${table.consumedAt} >= ${table.createdAt}`,
    ),
    check(
      "integration_confirmations_updated_after_creation",
      sql`${table.updatedAt} >= ${table.createdAt}`,
    ),
  ],
);

/** Durable idempotency receipts for state-changing integration requests. */
export const integrationRequests = pgTable(
  "integration_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    credentialId: uuid("credential_id").notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 160 }).notNull(),
    confirmationId: uuid("confirmation_id").notNull(),
    commandHash: varchar("command_hash", { length: 64 }).notNull(),
    operation: varchar("operation", { length: 160 }).notNull(),
    status: integrationRequestStatus("status").notNull().default("processing"),
    result: jsonb("result").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("integration_requests_credential_idempotency_uq").on(
      table.credentialId,
      table.idempotencyKey,
    ),
    index("integration_requests_workspace_created_idx").on(
      table.workspaceId,
      table.createdAt,
      table.id,
    ),
    index("integration_requests_credential_status_idx").on(table.credentialId, table.status),
    foreignKey({
      name: "integration_requests_credential_tenant_fk",
      columns: [table.workspaceId, table.credentialId],
      foreignColumns: [integrationCredentials.workspaceId, integrationCredentials.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "integration_requests_confirmation_tenant_fk",
      columns: [
        table.workspaceId,
        table.credentialId,
        table.confirmationId,
        table.operation,
        table.commandHash,
      ],
      foreignColumns: [
        integrationConfirmations.workspaceId,
        integrationConfirmations.credentialId,
        integrationConfirmations.id,
        integrationConfirmations.commandKind,
        integrationConfirmations.commandHash,
      ],
    }).onDelete("restrict"),
    check(
      "integration_requests_idempotency_key_nonempty",
      sql`char_length(trim(${table.idempotencyKey})) > 0`,
    ),
    check("integration_requests_command_hash_length", sql`char_length(${table.commandHash}) = 64`),
    check(
      "integration_requests_operation_nonempty",
      sql`char_length(trim(${table.operation})) > 0`,
    ),
    check(
      "integration_requests_status_result_consistent",
      sql`(${table.status} = 'processing' AND ${table.result} IS NULL AND ${table.completedAt} IS NULL) OR (${table.status} = 'succeeded' AND jsonb_typeof(${table.result}) = 'object' AND ${table.result}->>'confirmationId' = ${table.confirmationId}::text AND ${table.result}->>'operation' = ${table.operation} AND ${table.result}->>'commandHash' = ${table.commandHash} AND ${table.completedAt} IS NOT NULL)`,
    ),
    check(
      "integration_requests_completion_after_creation",
      sql`${table.completedAt} IS NULL OR ${table.completedAt} >= ${table.createdAt}`,
    ),
    check(
      "integration_requests_updated_after_creation",
      sql`${table.updatedAt} >= ${table.createdAt}`,
    ),
  ],
);

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
    planningDurationMinutes: integer("planning_duration_minutes"),
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
    check(
      "work_items_planning_duration_positive",
      sql`${table.planningDurationMinutes} IS NULL OR ${table.planningDurationMinutes} > 0`,
    ),
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
      .$type<
        readonly {
          sourceType: "routine" | "work_item";
          routineId: string | null;
          workItemId: string | null;
          title: string;
          codes: readonly string[];
        }[]
      >()
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
    sourceType: planningSourceType("source_type").notNull(),
    routineId: uuid("routine_id"),
    workItemId: uuid("work_item_id"),
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
    index("activity_events_work_item_occurred_idx").on(
      table.workspaceId,
      table.workItemId,
      table.occurredAt,
    ),
    index("activity_events_work_item_sequence_idx").on(
      table.workspaceId,
      table.workItemId,
      table.ingestedSequence,
    ),
    index("activity_events_workspace_local_date_idx").on(table.workspaceId, table.localDate),
    foreignKey({
      name: "activity_events_routine_tenant_fk",
      columns: [table.workspaceId, table.routineId],
      foreignColumns: [routines.workspaceId, routines.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "activity_events_work_item_tenant_fk",
      columns: [table.workspaceId, table.workItemId],
      foreignColumns: [workItems.workspaceId, workItems.id],
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
      columns: [table.workspaceId, table.referenceEventId],
      foreignColumns: [table.workspaceId, table.id],
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
    check(
      "activity_events_source_valid",
      sql`(${table.sourceType} = 'routine' AND ${table.routineId} IS NOT NULL AND ${table.workItemId} IS NULL) OR (${table.sourceType} = 'work_item' AND ${table.workItemId} IS NOT NULL AND ${table.routineId} IS NULL)`,
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
    sourceType: planningSourceType("source_type").notNull(),
    routineId: uuid("routine_id"),
    workItemId: uuid("work_item_id"),
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
    unique("daily_plan_items_plan_work_item_uq").on(
      table.workspaceId,
      table.planId,
      table.workItemId,
    ),
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
    foreignKey({
      name: "daily_plan_items_work_item_tenant_fk",
      columns: [table.workspaceId, table.workItemId],
      foreignColumns: [workItems.workspaceId, workItems.id],
    }).onDelete("restrict"),
    check("daily_plan_items_position_nonnegative", sql`${table.position} >= 0`),
    check("daily_plan_items_window_nonnegative", sql`${table.windowIndex} >= 0`),
    check("daily_plan_items_duration_positive", sql`${table.scheduledMinutes} > 0`),
    check(
      "daily_plan_items_source_valid",
      sql`(${table.sourceType} = 'routine' AND ${table.routineId} IS NOT NULL AND ${table.workItemId} IS NULL) OR (${table.sourceType} = 'work_item' AND ${table.workItemId} IS NOT NULL AND ${table.routineId} IS NULL)`,
    ),
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

/** A workspace-controlled HTTPS destination for signed outbound events. */
export const webhookEndpoints = pgTable(
  "webhook_endpoints",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 160 }).notNull(),
    url: varchar("url", { length: 2_048 }).notNull(),
    status: webhookEndpointStatus("status").notNull().default("active"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("webhook_endpoints_workspace_id_id_uq").on(table.workspaceId, table.id),
    index("webhook_endpoints_workspace_status_idx").on(table.workspaceId, table.status),
    check("webhook_endpoints_name_nonempty", sql`char_length(trim(${table.name})) > 0`),
    check("webhook_endpoints_name_printable", sql`${table.name} !~ '[[:cntrl:]]'`),
    check("webhook_endpoints_url_https", sql`${table.url} ~ '^https://[^[:space:]]+$'`),
    check(
      "webhook_endpoints_revocation_consistent",
      sql`(${table.status} = 'active' and ${table.revokedAt} is null) or (${table.status} = 'revoked' and ${table.revokedAt} is not null)`,
    ),
    check(
      "webhook_endpoints_revocation_after_creation",
      sql`${table.revokedAt} is null or ${table.revokedAt} >= ${table.createdAt}`,
    ),
    check(
      "webhook_endpoints_updated_after_creation",
      sql`${table.updatedAt} >= ${table.createdAt}`,
    ),
  ],
);

/** Explicit opt-in event types for an outbound webhook endpoint. */
export const webhookEventSubscriptions = pgTable(
  "webhook_event_subscriptions",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    endpointId: uuid("endpoint_id").notNull(),
    eventType: varchar("event_type", { length: 160 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      name: "webhook_event_subscriptions_pk",
      columns: [table.workspaceId, table.endpointId, table.eventType],
    }),
    foreignKey({
      name: "webhook_event_subscriptions_endpoint_tenant_fk",
      columns: [table.workspaceId, table.endpointId],
      foreignColumns: [webhookEndpoints.workspaceId, webhookEndpoints.id],
    }).onDelete("cascade"),
    index("webhook_event_subscriptions_workspace_event_idx").on(
      table.workspaceId,
      table.eventType,
      table.endpointId,
    ),
    check(
      "webhook_event_subscriptions_event_type_allowed",
      sql`${table.eventType} = 'schedule.changed.v1'`,
    ),
  ],
);

/**
 * Webhook signing material is always an authenticated encrypted envelope.
 * No plaintext signing secret column exists in the database schema.
 */
export const webhookEndpointSecrets = pgTable(
  "webhook_endpoint_secrets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    endpointId: uuid("endpoint_id").notNull(),
    version: integer("version").notNull(),
    status: webhookSecretStatus("status").notNull().default("pending"),
    secretEnvelope: jsonb("secret_envelope").$type<Record<string, string>>().notNull(),
    activatedAt: timestamp("activated_at", { withTimezone: true }),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("webhook_endpoint_secrets_workspace_endpoint_id_uq").on(
      table.workspaceId,
      table.endpointId,
      table.id,
    ),
    unique("webhook_endpoint_secrets_workspace_endpoint_version_uq").on(
      table.workspaceId,
      table.endpointId,
      table.version,
    ),
    uniqueIndex("webhook_endpoint_secrets_one_active_uq")
      .on(table.workspaceId, table.endpointId)
      .where(sql`${table.status} = 'active'`),
    uniqueIndex("webhook_endpoint_secrets_one_pending_uq")
      .on(table.workspaceId, table.endpointId)
      .where(sql`${table.status} = 'pending'`),
    index("webhook_endpoint_secrets_workspace_status_idx").on(table.workspaceId, table.status),
    foreignKey({
      name: "webhook_endpoint_secrets_endpoint_tenant_fk",
      columns: [table.workspaceId, table.endpointId],
      foreignColumns: [webhookEndpoints.workspaceId, webhookEndpoints.id],
    }).onDelete("cascade"),
    check("webhook_endpoint_secrets_version_positive", sql`${table.version} > 0`),
    check(
      "webhook_endpoint_secrets_envelope_shape",
      sql`
        jsonb_typeof(${table.secretEnvelope}) = 'object'
        and ${table.secretEnvelope} ?& array['version', 'masterKeyId', 'nonce', 'ciphertext', 'tag']
        and (${table.secretEnvelope} - 'version' - 'masterKeyId' - 'nonce' - 'ciphertext' - 'tag') = '{}'::jsonb
        and ${table.secretEnvelope}->>'version' = 'v1'
        and jsonb_typeof(${table.secretEnvelope}->'masterKeyId') = 'string'
        and jsonb_typeof(${table.secretEnvelope}->'nonce') = 'string'
        and jsonb_typeof(${table.secretEnvelope}->'ciphertext') = 'string'
        and jsonb_typeof(${table.secretEnvelope}->'tag') = 'string'
        and ${table.secretEnvelope}->>'masterKeyId' ~ '^[a-z][a-z0-9_-]{0,31}$'
        and ${table.secretEnvelope}->>'nonce' ~ '^[A-Za-z0-9_-]{16}$'
        and ${table.secretEnvelope}->>'ciphertext' ~ '^[A-Za-z0-9_-]{43}$'
        and ${table.secretEnvelope}->>'tag' ~ '^[A-Za-z0-9_-]{22}$'
      `,
    ),
    check(
      "webhook_endpoint_secrets_lifecycle_consistent",
      sql`
        (${table.status} = 'pending' and ${table.activatedAt} is null and ${table.retiredAt} is null)
        or (${table.status} = 'active' and ${table.activatedAt} is not null and ${table.retiredAt} is null)
        or (${table.status} = 'retired' and ${table.retiredAt} is not null)
      `,
    ),
    check(
      "webhook_endpoint_secrets_activation_after_creation",
      sql`${table.activatedAt} is null or ${table.activatedAt} >= ${table.createdAt}`,
    ),
    check(
      "webhook_endpoint_secrets_retirement_after_creation",
      sql`${table.retiredAt} is null or ${table.retiredAt} >= ${table.createdAt}`,
    ),
    check(
      "webhook_endpoint_secrets_retirement_after_activation",
      sql`${table.activatedAt} is null or ${table.retiredAt} is null or ${table.retiredAt} >= ${table.activatedAt}`,
    ),
  ],
);

/** Immutable exact-byte payloads for webhook attempts. */
export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    endpointId: uuid("endpoint_id").notNull(),
    secretId: uuid("secret_id").notNull(),
    eventId: varchar("event_id", { length: 160 }).notNull(),
    eventType: varchar("event_type", { length: 160 }).notNull(),
    eventOccurredAt: timestamp("event_occurred_at", { withTimezone: true }).notNull(),
    rawBody: text("raw_body").notNull(),
    bodySha256: varchar("body_sha256", { length: 64 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("webhook_deliveries_workspace_id_id_uq").on(table.workspaceId, table.id),
    unique("webhook_deliveries_workspace_endpoint_event_uq").on(
      table.workspaceId,
      table.endpointId,
      table.eventId,
    ),
    index("webhook_deliveries_workspace_created_idx").on(
      table.workspaceId,
      table.createdAt,
      table.id,
    ),
    foreignKey({
      name: "webhook_deliveries_endpoint_tenant_fk",
      columns: [table.workspaceId, table.endpointId],
      foreignColumns: [webhookEndpoints.workspaceId, webhookEndpoints.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "webhook_deliveries_secret_tenant_fk",
      columns: [table.workspaceId, table.endpointId, table.secretId],
      foreignColumns: [
        webhookEndpointSecrets.workspaceId,
        webhookEndpointSecrets.endpointId,
        webhookEndpointSecrets.id,
      ],
    }).onDelete("restrict"),
    check("webhook_deliveries_event_id_nonempty", sql`char_length(trim(${table.eventId})) > 0`),
    check("webhook_deliveries_event_type_nonempty", sql`char_length(trim(${table.eventType})) > 0`),
    check(
      "webhook_deliveries_raw_body_json_bounded",
      sql`octet_length(${table.rawBody}) between 2 and 1048576 and jsonb_typeof(${table.rawBody}::jsonb) in ('object', 'array')`,
    ),
    check(
      "webhook_deliveries_body_sha256_matches",
      sql`${table.bodySha256} = encode(digest(${table.rawBody}, 'sha256'), 'hex')`,
    ),
    check(
      "webhook_deliveries_event_time_not_future",
      sql`${table.eventOccurredAt} <= ${table.createdAt} + interval '5 minutes'`,
    ),
  ],
);

export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
    topic: varchar("topic", { length: 160 }).notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    webhookDeliveryId: uuid("webhook_delivery_id"),
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
    uniqueIndex("outbox_events_webhook_delivery_uq")
      .on(table.webhookDeliveryId)
      .where(sql`${table.webhookDeliveryId} is not null`),
    foreignKey({
      name: "outbox_events_webhook_delivery_tenant_fk",
      columns: [table.workspaceId, table.webhookDeliveryId],
      foreignColumns: [webhookDeliveries.workspaceId, webhookDeliveries.id],
    }).onDelete("cascade"),
    check("outbox_attempts_nonnegative", sql`${table.attempts} >= 0`),
    check(
      "outbox_events_webhook_delivery_payload",
      sql`
        (${table.topic} = 'webhook.delivery.v1'
          and ${table.workspaceId} is not null
          and ${table.webhookDeliveryId} is not null
          and ${table.payload} = jsonb_build_object('deliveryId', ${table.webhookDeliveryId}::text))
        or (${table.topic} <> 'webhook.delivery.v1' and ${table.webhookDeliveryId} is null)
      `,
    ),
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
