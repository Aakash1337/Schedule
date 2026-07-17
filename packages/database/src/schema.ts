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

import type { NaturalLanguageProposalModelSuggestions } from "@schedule/application";

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
export const routinePlanningFeedbackKind = pgEnum("routine_planning_feedback_kind", [
  "not_today",
  "not_this_week",
  "reset",
]);
export const routineSelectionPreferenceFeedbackKind = pgEnum(
  "routine_selection_preference_feedback_kind",
  ["more_often", "less_often", "reset"],
);
export const routineDurationInsightFeedbackKind = pgEnum("routine_duration_insight_feedback_kind", [
  "dismissed",
  "reset",
]);
export const dailyPlanFitInsightFeedbackKind = pgEnum("daily_plan_fit_insight_feedback_kind", [
  "dismissed",
  "reset",
  "used",
]);
export const planMutationKind = pgEnum("plan_mutation_kind", [
  "regenerate",
  "replace",
  "feedback",
  "feedback_reset",
  "alternative_select",
]);
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
export const notificationQuietHoursPolicy = pgEnum("notification_quiet_hours_policy", [
  "skip",
  "next_allowed",
]);
export const notificationRuleKind = pgEnum("notification_rule_kind", [
  "daily_digest",
  "daily_follow_up",
  "plan_window_open",
  "schedule_block_lead",
  "work_item_due",
]);
export const notificationKind = pgEnum("notification_kind", [
  "daily_digest",
  "daily_follow_up",
  "plan_window_open",
  "schedule_block_lead",
  "work_item_due",
  "one_off",
]);
export const notificationTargetType = pgEnum("notification_target_type", [
  "workspace",
  "daily_plan",
  "schedule_block",
  "work_item",
  "one_off",
]);
export const notificationLocalTimeResolution = pgEnum("notification_local_time_resolution", [
  "exact",
  "gap_later",
  "overlap_earlier",
]);
export const notificationDeliveryStatus = pgEnum("notification_delivery_status", [
  "pending",
  "processing",
  "delivered",
  "dead_letter",
  "invalidated",
]);
export const notificationDeliveryAttemptOutcome = pgEnum("notification_delivery_attempt_outcome", [
  "delivered",
  "retryable_failure",
  "permanent_failure",
  "lease_expired",
]);
export const notificationDeliveryRequestOperation = pgEnum(
  "notification_delivery_request_operation",
  ["claim", "receipt"],
);
export const naturalLanguageProposalStatus = pgEnum("natural_language_proposal_status", [
  "pending",
  "confirmed",
  "cancelled",
]);
export const hostedUserStatus = pgEnum("hosted_user_status", ["active", "disabled"]);
export const browserSessionRevocationReason = pgEnum("browser_session_revocation_reason", [
  "signed_out",
  "rotated",
  "user_disabled",
  "administrative",
]);
export const workspaceMembershipStatus = pgEnum("workspace_membership_status", [
  "active",
  "revoked",
]);

export const workspaces = pgTable("workspaces", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: varchar("name", { length: 160 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Provider-neutral hosted principals. No profile or provider claims are persisted here. */
export const hostedUsers = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    status: hostedUserStatus("status").notNull().default("active"),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("users_status_idx").on(table.status, table.id),
    check(
      "users_lifecycle_valid",
      sql`(
        (${table.status} = 'active' and ${table.disabledAt} is null)
        or (${table.status} = 'disabled' and ${table.disabledAt} is not null)
      )`,
    ),
    check(
      "users_timestamps_valid",
      sql`${table.updatedAt} >= ${table.createdAt}
        and (${table.disabledAt} is null or ${table.disabledAt} >= ${table.createdAt})`,
    ),
    check("users_version_positive", sql`${table.version} > 0`),
  ],
);

/** Exact issuer/subject bindings. Email, display claims, and provider tokens are excluded. */
export const externalIdentities = pgTable(
  "external_identities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => hostedUsers.id, { onDelete: "cascade" }),
    issuer: varchar("issuer", { length: 2_048 }).notNull(),
    subject: varchar("subject", { length: 512 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("external_identities_exact_binding_uq").on(
      sql`${table.issuer} collate "C"`,
      sql`${table.subject} collate "C"`,
    ),
    index("external_identities_user_idx").on(table.userId, table.id),
    check("external_identities_issuer_nonempty", sql`char_length(${table.issuer}) > 0`),
    check("external_identities_subject_nonempty", sql`char_length(${table.subject}) > 0`),
    check(
      "external_identities_key_bytes_bounded",
      sql`octet_length(${table.issuer}) + octet_length(${table.subject}) <= 2000`,
    ),
  ],
);

/** Browser sessions persist only a selector and peppered HMAC digest, never a bearer secret. */
export const browserSessions = pgTable(
  "browser_sessions",
  {
    id: uuid("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => hostedUsers.id, { onDelete: "cascade" }),
    secretDigest: varchar("secret_digest", { length: 64 }).notNull(),
    idleTimeoutSeconds: integer("idle_timeout_seconds").notNull(),
    issuedAt: timestamp("issued_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    idleExpiresAt: timestamp("idle_expires_at", { withTimezone: true }).notNull(),
    absoluteExpiresAt: timestamp("absolute_expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    revocationReason: browserSessionRevocationReason("revocation_reason"),
    version: integer("version").notNull().default(1),
  },
  (table) => [
    unique("browser_sessions_secret_digest_uq").on(table.secretDigest),
    index("browser_sessions_user_active_idx").on(
      table.userId,
      table.revokedAt,
      table.idleExpiresAt,
      table.absoluteExpiresAt,
    ),
    check("browser_sessions_digest_valid", sql`${table.secretDigest} ~ '^[0-9a-f]{64}$'`),
    check(
      "browser_sessions_idle_timeout_valid",
      sql`${table.idleTimeoutSeconds} between 60 and 2592000`,
    ),
    check(
      "browser_sessions_expiry_valid",
      sql`${table.issuedAt} <= ${table.lastSeenAt}
        and ${table.lastSeenAt} < ${table.idleExpiresAt}
        and ${table.idleExpiresAt} <= ${table.absoluteExpiresAt}`,
    ),
    check(
      "browser_sessions_revocation_valid",
      sql`(
        ${table.revokedAt} is null and ${table.revocationReason} is null
      ) or (
        ${table.revokedAt} is not null and ${table.revocationReason} is not null
        and ${table.revokedAt} >= ${table.issuedAt}
      )`,
    ),
    check("browser_sessions_version_positive", sql`${table.version} > 0`),
  ],
);

/**
 * Short-lived pre-authentication transactions. Authorization state and browser-binding bearer
 * values are represented only by peppered HMAC digests; PKCE verifiers are authenticated
 * ciphertext and are removed after the bounded expiry window.
 */
export const hostedLoginTransactions = pgTable(
  "hosted_login_transactions",
  {
    id: uuid("id").primaryKey(),
    stateDigest: varchar("state_digest", { length: 64 }).notNull(),
    browserBindingDigest: varchar("browser_binding_digest", { length: 64 }).notNull(),
    issuer: varchar("issuer", { length: 2_048 }).notNull(),
    clientId: varchar("client_id", { length: 512 }).notNull(),
    redirectUri: varchar("redirect_uri", { length: 2_048 }).notNull(),
    returnToPath: varchar("return_to_path", { length: 2_048 }).notNull(),
    nonce: varchar("nonce", { length: 43 }).notNull(),
    pkceChallenge: varchar("pkce_challenge", { length: 43 }).notNull(),
    pkceMethod: varchar("pkce_method", { length: 4 }).notNull().default("S256"),
    protectedPkceVerifier: varchar("protected_pkce_verifier", { length: 2_048 }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    version: integer("version").notNull().default(1),
  },
  (table) => [
    unique("hosted_login_transactions_state_digest_uq").on(table.stateDigest),
    unique("hosted_login_transactions_browser_binding_digest_uq").on(table.browserBindingDigest),
    index("hosted_login_transactions_expiry_idx").on(table.expiresAt, table.id),
    check(
      "hosted_login_transactions_digests_valid",
      sql`${table.stateDigest} ~ '^[0-9a-f]{64}$'
        and ${table.browserBindingDigest} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "hosted_login_transactions_oidc_values_valid",
      sql`char_length(${table.issuer}) > 0
        and char_length(${table.clientId}) > 0
        and char_length(${table.redirectUri}) > 0
        and char_length(${table.returnToPath}) > 0
        and ${table.nonce} ~ '^[A-Za-z0-9_-]{43}$'
        and ${table.pkceChallenge} ~ '^[A-Za-z0-9_-]{43}$'
        and ${table.pkceMethod} = 'S256'
        and char_length(${table.protectedPkceVerifier}) > 0`,
    ),
    check(
      "hosted_login_transactions_lifecycle_valid",
      sql`${table.expiresAt} >= ${table.createdAt} + interval '60 seconds'
        and ${table.expiresAt} <= ${table.createdAt} + interval '15 minutes'
        and (${table.consumedAt} is null or (
          ${table.consumedAt} >= ${table.createdAt}
          and ${table.consumedAt} < ${table.expiresAt}
        ))`,
    ),
    check("hosted_login_transactions_version_positive", sql`${table.version} > 0`),
  ],
);

/** Binary hosted authorization boundary; roles remain deliberately out of scope. */
export const workspaceMemberships = pgTable(
  "workspace_memberships",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => hostedUsers.id, { onDelete: "cascade" }),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    status: workspaceMembershipStatus("status").notNull().default("active"),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: "workspace_memberships_pk", columns: [table.userId, table.workspaceId] }),
    index("workspace_memberships_workspace_status_idx").on(
      table.workspaceId,
      table.status,
      table.userId,
    ),
    index("workspace_memberships_user_status_workspace_idx").on(
      table.userId,
      table.status,
      table.workspaceId,
    ),
    check(
      "workspace_memberships_lifecycle_valid",
      sql`(
        (${table.status} = 'active' and ${table.revokedAt} is null)
        or (${table.status} = 'revoked' and ${table.revokedAt} is not null)
      )`,
    ),
    check(
      "workspace_memberships_timestamps_valid",
      sql`${table.updatedAt} >= ${table.createdAt}
        and (${table.revokedAt} is null or ${table.revokedAt} >= ${table.createdAt})`,
    ),
    check("workspace_memberships_version_positive", sql`${table.version} > 0`),
  ],
);

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
      sql`${table.scopes} <@ ARRAY['schedule:read', 'schedule:write', 'schedule:delivery']::text[]`,
    ),
    check(
      "integration_credentials_scopes_unique",
      sql`cardinality(${table.scopes}) = (CASE WHEN 'schedule:read' = ANY(${table.scopes}) THEN 1 ELSE 0 END + CASE WHEN 'schedule:write' = ANY(${table.scopes}) THEN 1 ELSE 0 END + CASE WHEN 'schedule:delivery' = ANY(${table.scopes}) THEN 1 ELSE 0 END)`,
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
    parentWorkItemId: uuid("parent_work_item_id"),
    title: varchar("title", { length: 240 }).notNull(),
    description: text("description"),
    status: workItemStatus("status").notNull().default("backlog"),
    priority: workItemPriority("priority").notNull().default("none"),
    planningDurationMinutes: integer("planning_duration_minutes"),
    dueOn: date("due_on"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("work_items_workspace_id_id_uq").on(table.workspaceId, table.id),
    index("work_items_workspace_parent_created_id_idx").on(
      table.workspaceId,
      table.parentWorkItemId,
      table.createdAt,
      table.id,
    ),
    index("work_items_workspace_status_idx").on(table.workspaceId, table.status),
    index("work_items_workspace_created_id_idx").on(table.workspaceId, table.createdAt, table.id),
    index("work_items_workspace_due_id_idx").on(table.workspaceId, table.dueOn, table.id),
    index("work_items_workspace_status_priority_created_id_idx").on(
      table.workspaceId,
      table.status,
      table.priority,
      table.createdAt,
      table.id,
    ),
    foreignKey({
      name: "work_items_parent_tenant_fk",
      columns: [table.workspaceId, table.parentWorkItemId],
      foreignColumns: [table.workspaceId, table.id],
    }).onDelete("restrict"),
    check(
      "work_items_parent_not_self",
      sql`${table.parentWorkItemId} IS NULL OR ${table.parentWorkItemId} <> ${table.id}`,
    ),
    check("work_items_version_positive", sql`${table.version} > 0`),
    check(
      "work_items_planning_duration_positive",
      sql`${table.planningDurationMinutes} IS NULL OR ${table.planningDurationMinutes} > 0`,
    ),
  ],
);

/**
 * Expiring local-model proposals. Raw user prompts are deliberately represented only by a digest.
 * Confirmation always executes the exact stored, canonical command.
 */
export const naturalLanguageProposals = pgTable(
  "natural_language_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    requestId: uuid("request_id").notNull(),
    promptHash: varchar("prompt_hash", { length: 64 }).notNull(),
    commandHash: varchar("command_hash", { length: 64 }).notNull(),
    reviewHash: varchar("review_hash", { length: 64 })
      .notNull()
      .default("65f7aef345c4f828788d1f4b3d779476b02a9599c31b1442ac7a4b3dbd670805"),
    modelSuggestionsHash: varchar("model_suggestions_hash", { length: 64 })
      .notNull()
      .default("74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b"),
    commandDisplay: text("command_display").notNull(),
    command: jsonb("command").$type<Readonly<Record<string, unknown>>>().notNull(),
    modelSuggestions: jsonb(
      "model_suggestions",
    ).$type<NaturalLanguageProposalModelSuggestions | null>(),
    reviewPriority: workItemPriority("review_priority").notNull().default("none"),
    reviewDueOn: date("review_due_on"),
    reviewPlanningDurationMinutes: integer("review_planning_duration_minutes"),
    provider: varchar("provider", { length: 40 }).notNull(),
    model: varchar("model", { length: 120 }),
    status: naturalLanguageProposalStatus("status").notNull().default("pending"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    confirmationKeyHash: varchar("confirmation_key_hash", { length: 64 }),
    resultWorkItemId: uuid("result_work_item_id"),
    resultScheduleBlockId: uuid("result_schedule_block_id"),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    unique("natural_language_proposals_workspace_request_uq").on(
      table.workspaceId,
      table.requestId,
    ),
    index("natural_language_proposals_workspace_status_created_idx").on(
      table.workspaceId,
      table.status,
      table.createdAt,
      table.id,
    ),
    index("natural_language_proposals_workspace_expiry_idx").on(
      table.workspaceId,
      table.expiresAt,
      table.id,
    ),
    foreignKey({
      name: "natural_language_proposals_result_work_item_tenant_fk",
      columns: [table.workspaceId, table.resultWorkItemId],
      foreignColumns: [workItems.workspaceId, workItems.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "natural_language_proposals_result_schedule_block_tenant_fk",
      columns: [table.workspaceId, table.resultScheduleBlockId],
      foreignColumns: [scheduleBlocks.workspaceId, scheduleBlocks.id],
    }).onDelete("restrict"),
    check("natural_language_proposals_version_positive", sql`${table.version} > 0`),
    check(
      "natural_language_proposals_prompt_hash_valid",
      sql`${table.promptHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "natural_language_proposals_command_hash_valid",
      sql`${table.commandHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "natural_language_proposals_review_hash_valid",
      sql`${table.reviewHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "natural_language_proposals_model_suggestions_hash_valid",
      sql`${table.modelSuggestionsHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "natural_language_proposals_confirmation_hash_valid",
      sql`${table.confirmationKeyHash} IS NULL OR ${table.confirmationKeyHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "natural_language_proposals_command_display_bounded",
      sql`char_length(${table.commandDisplay}) BETWEEN 1 AND 1000`,
    ),
    check(
      "natural_language_proposals_model_suggestions_object",
      sql`${table.modelSuggestions} IS NULL OR jsonb_typeof(${table.modelSuggestions}) = 'object'`,
    ),
    check(
      "natural_language_proposals_review_duration_valid",
      sql`${table.reviewPlanningDurationMinutes} IS NULL OR (${table.reviewPlanningDurationMinutes} > 0 AND ${table.reviewPlanningDurationMinutes} <= 43200)`,
    ),
    check(
      "natural_language_proposals_expiry_after_creation",
      sql`${table.expiresAt} >= ${table.createdAt} + interval '1 minute' AND ${table.expiresAt} <= ${table.createdAt} + interval '1 hour'`,
    ),
    check(
      "natural_language_proposals_updated_after_creation",
      sql`${table.updatedAt} >= ${table.createdAt}`,
    ),
    check(
      "natural_language_proposals_lifecycle_valid",
      sql`COALESCE((
        (${table.status} = 'pending' AND ${table.confirmationKeyHash} IS NULL AND ${table.resultWorkItemId} IS NULL AND ${table.resultScheduleBlockId} IS NULL AND ${table.confirmedAt} IS NULL AND ${table.cancelledAt} IS NULL)
        OR
        (${table.status} = 'confirmed' AND ${table.confirmationKeyHash} IS NOT NULL AND ${table.confirmedAt} IS NOT NULL AND ${table.cancelledAt} IS NULL AND (
          ((${table.command}->>'type') = 'work_item.create' AND ${table.resultWorkItemId} IS NOT NULL AND ${table.resultScheduleBlockId} IS NULL)
          OR
          ((${table.command}->>'type') = 'schedule_block.create' AND ${table.resultWorkItemId} IS NULL AND ${table.resultScheduleBlockId} IS NOT NULL)
        ))
        OR
        (${table.status} = 'cancelled' AND ${table.confirmationKeyHash} IS NULL AND ${table.resultWorkItemId} IS NULL AND ${table.resultScheduleBlockId} IS NULL AND ${table.confirmedAt} IS NULL AND ${table.cancelledAt} IS NOT NULL)
      ), false)`,
    ),
    check(
      "natural_language_proposals_terminal_time_valid",
      sql`(${table.confirmedAt} IS NULL OR (${table.confirmedAt} >= ${table.createdAt} AND ${table.confirmedAt} <= ${table.expiresAt})) AND (${table.cancelledAt} IS NULL OR (${table.cancelledAt} >= ${table.createdAt} AND ${table.cancelledAt} <= ${table.expiresAt}))`,
    ),
  ],
);

/** Tenant-scoped directed edges between one-time work items. */
export const workItemDependencies = pgTable(
  "work_item_dependencies",
  {
    workspaceId: uuid("workspace_id").notNull(),
    prerequisiteWorkItemId: uuid("prerequisite_work_item_id").notNull(),
    dependentWorkItemId: uuid("dependent_work_item_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      name: "work_item_dependencies_pk",
      columns: [table.workspaceId, table.prerequisiteWorkItemId, table.dependentWorkItemId],
    }),
    index("work_item_dependencies_dependent_idx").on(
      table.workspaceId,
      table.dependentWorkItemId,
      table.prerequisiteWorkItemId,
    ),
    index("work_item_dependencies_list_idx").on(
      table.workspaceId,
      table.createdAt,
      table.prerequisiteWorkItemId,
      table.dependentWorkItemId,
    ),
    foreignKey({
      name: "work_item_dependencies_prerequisite_tenant_fk",
      columns: [table.workspaceId, table.prerequisiteWorkItemId],
      foreignColumns: [workItems.workspaceId, workItems.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "work_item_dependencies_dependent_tenant_fk",
      columns: [table.workspaceId, table.dependentWorkItemId],
      foreignColumns: [workItems.workspaceId, workItems.id],
    }).onDelete("cascade"),
    check(
      "work_item_dependencies_not_self",
      sql`${table.prerequisiteWorkItemId} <> ${table.dependentWorkItemId}`,
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

export const notificationProfiles = pgTable(
  "notification_profiles",
  {
    workspaceId: uuid("workspace_id")
      .primaryKey()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(true),
    timeZone: varchar("time_zone", { length: 80 }).notNull(),
    quietHoursStartMinute: integer("quiet_hours_start_minute"),
    quietHoursEndMinute: integer("quiet_hours_end_minute"),
    quietHoursPolicy: notificationQuietHoursPolicy("quiet_hours_policy")
      .notNull()
      .default("next_allowed"),
    catchUpWindowMinutes: integer("catch_up_window_minutes").notNull().default(60),
    dailyIntentLimit: integer("daily_intent_limit").notNull().default(12),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      "notification_profiles_quiet_hours_pair",
      sql`(${table.quietHoursStartMinute} IS NULL) = (${table.quietHoursEndMinute} IS NULL)`,
    ),
    check(
      "notification_profiles_quiet_start_range",
      sql`${table.quietHoursStartMinute} IS NULL OR ${table.quietHoursStartMinute} BETWEEN 0 AND 1439`,
    ),
    check(
      "notification_profiles_quiet_end_range",
      sql`${table.quietHoursEndMinute} IS NULL OR ${table.quietHoursEndMinute} BETWEEN 0 AND 1439`,
    ),
    check(
      "notification_profiles_catch_up_range",
      sql`${table.catchUpWindowMinutes} BETWEEN 0 AND 10080`,
    ),
    check(
      "notification_profiles_daily_limit_range",
      sql`${table.dailyIntentLimit} BETWEEN 1 AND 100`,
    ),
    check("notification_profiles_version_positive", sql`${table.version} > 0`),
  ],
);

export const notificationRules = pgTable(
  "notification_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    kind: notificationRuleKind("kind").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    localMinute: integer("local_minute"),
    leadMinutes: integer("lead_minutes"),
    cooldownMinutes: integer("cooldown_minutes").notNull().default(0),
    priority: integer("priority").notNull().default(50),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("notification_rules_workspace_id_id_uq").on(table.workspaceId, table.id),
    unique("notification_rules_workspace_id_kind_uq").on(table.workspaceId, table.id, table.kind),
    index("notification_rules_workspace_kind_idx").on(table.workspaceId, table.kind, table.id),
    check(
      "notification_rules_configuration_valid",
      sql`(
        (${table.kind} IN ('daily_digest', 'daily_follow_up', 'work_item_due') AND ${table.localMinute} BETWEEN 0 AND 1439 AND ${table.leadMinutes} IS NULL)
        OR
        (${table.kind} IN ('plan_window_open', 'schedule_block_lead') AND ${table.localMinute} IS NULL AND ${table.leadMinutes} BETWEEN 0 AND 10080)
      )`,
    ),
    check("notification_rules_cooldown_range", sql`${table.cooldownMinutes} BETWEEN 0 AND 10080`),
    check("notification_rules_priority_range", sql`${table.priority} BETWEEN 0 AND 100`),
    check("notification_rules_version_positive", sql`${table.version} > 0`),
  ],
);

export const oneOffReminders = pgTable(
  "one_off_reminders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    title: varchar("title", { length: 240 }).notNull(),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("one_off_reminders_workspace_id_id_uq").on(table.workspaceId, table.id),
    index("one_off_reminders_workspace_schedule_idx").on(
      table.workspaceId,
      table.scheduledFor,
      table.id,
    ),
    check("one_off_reminders_title_nonempty", sql`char_length(btrim(${table.title})) > 0`),
    check(
      "one_off_reminders_cancellation_valid",
      sql`${table.cancelledAt} IS NULL OR ${table.cancelledAt} >= ${table.createdAt}`,
    ),
    check("one_off_reminders_version_positive", sql`${table.version} > 0`),
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
    /** Independent optimistic-concurrency head for append-only selection preference feedback. */
    selectionPreferenceVersion: integer("selection_preference_version").notNull().default(0),
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
      "routines_selection_preference_version_nonnegative",
      sql`${table.selectionPreferenceVersion} >= 0`,
    ),
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

export const notificationIntents = pgTable(
  "notification_intents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    ruleId: uuid("rule_id"),
    ruleKind: notificationRuleKind("rule_kind"),
    oneOffReminderId: uuid("one_off_reminder_id"),
    kind: notificationKind("kind").notNull(),
    occurrenceKey: varchar("occurrence_key", { length: 200 }).notNull(),
    targetType: notificationTargetType("target_type").notNull(),
    dailyPlanId: uuid("daily_plan_id"),
    scheduleBlockId: uuid("schedule_block_id"),
    workItemId: uuid("work_item_id"),
    titleSnapshot: varchar("title_snapshot", { length: 240 }),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
    localDate: date("local_date").notNull(),
    priority: integer("priority").notNull(),
    policySnapshot: jsonb("policy_snapshot")
      .$type<Record<string, string | number | boolean | null>>()
      .notNull(),
    localTimeResolution: notificationLocalTimeResolution("local_time_resolution").notNull(),
    adjustedForQuietHours: boolean("adjusted_for_quiet_hours").notNull().default(false),
    caughtUp: boolean("caught_up").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("notification_intents_workspace_id_id_uq").on(table.workspaceId, table.id),
    unique("notification_intents_workspace_occurrence_uq").on(
      table.workspaceId,
      table.occurrenceKey,
    ),
    index("notification_intents_workspace_schedule_idx").on(
      table.workspaceId,
      table.scheduledFor,
      table.id,
    ),
    index("notification_intents_workspace_rule_schedule_idx").on(
      table.workspaceId,
      table.ruleId,
      table.scheduledFor,
    ),
    index("notification_intents_workspace_daily_plan_idx")
      .on(table.workspaceId, table.dailyPlanId)
      .where(sql`${table.dailyPlanId} is not null`),
    index("notification_intents_workspace_schedule_block_idx")
      .on(table.workspaceId, table.scheduleBlockId)
      .where(sql`${table.scheduleBlockId} is not null`),
    index("notification_intents_workspace_work_item_idx")
      .on(table.workspaceId, table.workItemId)
      .where(sql`${table.workItemId} is not null`),
    index("notification_intents_workspace_one_off_idx")
      .on(table.workspaceId, table.oneOffReminderId)
      .where(sql`${table.oneOffReminderId} is not null`),
    foreignKey({
      name: "notification_intents_rule_tenant_kind_fk",
      columns: [table.workspaceId, table.ruleId, table.ruleKind],
      foreignColumns: [notificationRules.workspaceId, notificationRules.id, notificationRules.kind],
    }).onDelete("restrict"),
    foreignKey({
      name: "notification_intents_one_off_tenant_fk",
      columns: [table.workspaceId, table.oneOffReminderId],
      foreignColumns: [oneOffReminders.workspaceId, oneOffReminders.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "notification_intents_daily_plan_tenant_fk",
      columns: [table.workspaceId, table.dailyPlanId],
      foreignColumns: [dailyPlans.workspaceId, dailyPlans.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "notification_intents_schedule_block_tenant_fk",
      columns: [table.workspaceId, table.scheduleBlockId],
      foreignColumns: [scheduleBlocks.workspaceId, scheduleBlocks.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "notification_intents_work_item_tenant_fk",
      columns: [table.workspaceId, table.workItemId],
      foreignColumns: [workItems.workspaceId, workItems.id],
    }).onDelete("cascade"),
    check(
      "notification_intents_source_valid",
      sql`(
        (${table.kind} = 'one_off' AND ${table.ruleId} IS NULL AND ${table.ruleKind} IS NULL AND ${table.oneOffReminderId} IS NOT NULL)
        OR
        (${table.kind} <> 'one_off' AND ${table.ruleId} IS NOT NULL AND ${table.ruleKind} IS NOT NULL AND ${table.kind}::text = ${table.ruleKind}::text AND ${table.oneOffReminderId} IS NULL)
      )`,
    ),
    check(
      "notification_intents_target_valid",
      sql`(
        (${table.kind} = 'daily_digest' AND ${table.targetType} = 'workspace' AND ${table.dailyPlanId} IS NULL AND ${table.scheduleBlockId} IS NULL AND ${table.workItemId} IS NULL)
        OR
        (${table.kind} IN ('daily_follow_up', 'plan_window_open') AND ${table.targetType} = 'daily_plan' AND ${table.dailyPlanId} IS NOT NULL AND ${table.scheduleBlockId} IS NULL AND ${table.workItemId} IS NULL)
        OR
        (${table.kind} = 'schedule_block_lead' AND ${table.targetType} = 'schedule_block' AND ${table.dailyPlanId} IS NULL AND ${table.scheduleBlockId} IS NOT NULL AND ${table.workItemId} IS NULL)
        OR
        (${table.kind} = 'work_item_due' AND ${table.targetType} = 'work_item' AND ${table.dailyPlanId} IS NULL AND ${table.scheduleBlockId} IS NULL AND ${table.workItemId} IS NOT NULL)
        OR
        (${table.kind} = 'one_off' AND ${table.targetType} = 'one_off' AND ${table.dailyPlanId} IS NULL AND ${table.scheduleBlockId} IS NULL AND ${table.workItemId} IS NULL)
      )`,
    ),
    check(
      "notification_intents_occurrence_nonempty",
      sql`char_length(btrim(${table.occurrenceKey})) > 0`,
    ),
    check("notification_intents_priority_range", sql`${table.priority} BETWEEN 0 AND 100`),
    check(
      "notification_intents_policy_snapshot_valid",
      sql`jsonb_typeof(${table.policySnapshot}) = 'object' AND octet_length(${table.policySnapshot}::text) <= 4096`,
    ),
  ],
);

/**
 * Provider-neutral delivery commands created lazily from due notification intents.
 *
 * The source intent ID and occurrence key are durable snapshots rather than foreign
 * keys: policy or target invalidation may delete the mutable pending intent while
 * this command remains as the exact-once delivery and audit boundary.
 */
export const notificationDeliveryCommands = pgTable(
  "notification_delivery_commands",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    intentId: uuid("intent_id").notNull(),
    occurrenceKey: varchar("occurrence_key", { length: 200 }).notNull(),
    kind: notificationKind("kind").notNull(),
    targetType: notificationTargetType("target_type").notNull(),
    titleSnapshot: varchar("title_snapshot", { length: 240 }),
    scheduledFor: timestamp("scheduled_for", { withTimezone: true }).notNull(),
    localDate: date("local_date").notNull(),
    priority: integer("priority").notNull(),
    status: notificationDeliveryStatus("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull(),
    currentClaimToken: uuid("current_claim_token"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    lastFailureCode: varchar("last_failure_code", { length: 80 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique("notification_delivery_commands_workspace_id_id_uq").on(table.workspaceId, table.id),
    unique("notification_delivery_commands_workspace_intent_uq").on(
      table.workspaceId,
      table.intentId,
    ),
    unique("notification_delivery_commands_workspace_occurrence_uq").on(
      table.workspaceId,
      table.occurrenceKey,
    ),
    index("notification_delivery_commands_claim_idx").on(
      table.workspaceId,
      table.status,
      table.availableAt,
      table.scheduledFor,
    ),
    index("notification_delivery_commands_workspace_schedule_idx").on(
      table.workspaceId,
      table.scheduledFor,
      table.id,
    ),
    index("notification_delivery_commands_recovery_idx")
      .on(table.workspaceId, table.leaseExpiresAt, table.id)
      .where(
        sql`${table.status} IN ('processing', 'invalidated') AND ${table.leaseExpiresAt} IS NOT NULL`,
      ),
    check(
      "notification_delivery_commands_occurrence_nonempty",
      sql`char_length(btrim(${table.occurrenceKey})) > 0`,
    ),
    check(
      "notification_delivery_commands_priority_range",
      sql`${table.priority} BETWEEN 0 AND 100`,
    ),
    check("notification_delivery_commands_attempts_nonnegative", sql`${table.attempts} >= 0`),
    check(
      "notification_delivery_commands_failure_code_valid",
      sql`${table.lastFailureCode} IS NULL OR ${table.lastFailureCode} ~ '^[a-z0-9][a-z0-9._-]{0,79}$'`,
    ),
    check(
      "notification_delivery_commands_state_valid",
      sql`(
        (${table.status} = 'pending' AND ${table.currentClaimToken} IS NULL AND ${table.leaseExpiresAt} IS NULL AND ${table.completedAt} IS NULL)
        OR
        (${table.status} = 'processing' AND ${table.currentClaimToken} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL AND ${table.completedAt} IS NULL)
        OR
        (${table.status} IN ('delivered', 'dead_letter') AND ${table.currentClaimToken} IS NULL AND ${table.leaseExpiresAt} IS NULL AND ${table.completedAt} IS NOT NULL)
        OR
        (${table.status} = 'invalidated' AND ${table.completedAt} IS NOT NULL AND ((${table.currentClaimToken} IS NULL AND ${table.leaseExpiresAt} IS NULL) OR (${table.currentClaimToken} IS NOT NULL AND ${table.leaseExpiresAt} IS NOT NULL)))
      )`,
    ),
    check(
      "notification_delivery_commands_timestamps_valid",
      sql`${table.updatedAt} >= ${table.createdAt} AND (${table.completedAt} IS NULL OR ${table.completedAt} >= ${table.createdAt})`,
    ),
  ],
);

/** Immutable claim attempts and bounded provider-neutral outcomes. */
export const notificationDeliveryAttempts = pgTable(
  "notification_delivery_attempts",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    deliveryId: uuid("delivery_id").notNull(),
    credentialId: uuid("credential_id").notNull(),
    attemptNumber: integer("attempt_number").notNull(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull(),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }).notNull(),
    outcome: notificationDeliveryAttemptOutcome("outcome"),
    failureCode: varchar("failure_code", { length: 80 }),
    retryAfterSeconds: integer("retry_after_seconds"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    unique("notification_delivery_attempts_workspace_delivery_number_uq").on(
      table.workspaceId,
      table.deliveryId,
      table.attemptNumber,
    ),
    index("notification_delivery_attempts_workspace_claimed_idx").on(
      table.workspaceId,
      table.claimedAt,
      table.id,
    ),
    foreignKey({
      name: "notification_delivery_attempts_command_tenant_fk",
      columns: [table.workspaceId, table.deliveryId],
      foreignColumns: [notificationDeliveryCommands.workspaceId, notificationDeliveryCommands.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "notification_delivery_attempts_credential_tenant_fk",
      columns: [table.workspaceId, table.credentialId],
      foreignColumns: [integrationCredentials.workspaceId, integrationCredentials.id],
    }).onDelete("restrict"),
    check("notification_delivery_attempts_number_positive", sql`${table.attemptNumber} > 0`),
    check(
      "notification_delivery_attempts_lease_after_claim",
      sql`${table.leaseExpiresAt} > ${table.claimedAt}`,
    ),
    check(
      "notification_delivery_attempts_failure_code_valid",
      sql`${table.failureCode} IS NULL OR ${table.failureCode} ~ '^[a-z0-9][a-z0-9._-]{0,79}$'`,
    ),
    check(
      "notification_delivery_attempts_outcome_valid",
      sql`(
        (${table.outcome} IS NULL AND ${table.failureCode} IS NULL AND ${table.retryAfterSeconds} IS NULL AND ${table.completedAt} IS NULL)
        OR
        (${table.outcome} IN ('delivered', 'lease_expired') AND ${table.failureCode} IS NULL AND ${table.retryAfterSeconds} IS NULL AND ${table.completedAt} IS NOT NULL)
        OR
        (${table.outcome} = 'retryable_failure' AND ${table.failureCode} IS NOT NULL AND ${table.retryAfterSeconds} BETWEEN 0 AND 60 AND ${table.completedAt} IS NOT NULL)
        OR
        (${table.outcome} = 'permanent_failure' AND ${table.failureCode} IS NOT NULL AND ${table.retryAfterSeconds} IS NULL AND ${table.completedAt} IS NOT NULL)
      )`,
    ),
    check(
      "notification_delivery_attempts_completion_after_claim",
      sql`${table.completedAt} IS NULL OR ${table.completedAt} >= ${table.claimedAt}`,
    ),
  ],
);

/** Durable exact-replay records for delivery claim and receipt requests. */
export const notificationDeliveryRequests = pgTable(
  "notification_delivery_requests",
  {
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    credentialId: uuid("credential_id").notNull(),
    idempotencyKey: varchar("idempotency_key", { length: 160 }).notNull(),
    operation: notificationDeliveryRequestOperation("operation").notNull(),
    requestHash: varchar("request_hash", { length: 64 }).notNull(),
    status: integrationRequestStatus("status").notNull().default("processing"),
    result: jsonb("result").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    unique("notification_delivery_requests_credential_key_uq").on(
      table.credentialId,
      table.idempotencyKey,
    ),
    index("notification_delivery_requests_workspace_created_idx").on(
      table.workspaceId,
      table.createdAt,
      table.id,
    ),
    foreignKey({
      name: "notification_delivery_requests_credential_tenant_fk",
      columns: [table.workspaceId, table.credentialId],
      foreignColumns: [integrationCredentials.workspaceId, integrationCredentials.id],
    }).onDelete("cascade"),
    check(
      "notification_delivery_requests_key_nonempty",
      sql`char_length(btrim(${table.idempotencyKey})) > 0`,
    ),
    check(
      "notification_delivery_requests_hash_valid",
      sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      "notification_delivery_requests_result_bounded",
      sql`${table.result} IS NULL OR (jsonb_typeof(${table.result}) = 'object' AND octet_length(${table.result}::text) <= 16384)`,
    ),
    check(
      "notification_delivery_requests_state_valid",
      sql`(
        (${table.status} = 'processing' AND ${table.result} IS NULL AND ${table.completedAt} IS NULL)
        OR
        (${table.status} = 'succeeded' AND ${table.result} IS NOT NULL AND ${table.completedAt} IS NOT NULL)
      )`,
    ),
    check(
      "notification_delivery_requests_timestamps_valid",
      sql`${table.updatedAt} >= ${table.createdAt} AND (${table.completedAt} IS NULL OR ${table.completedAt} >= ${table.createdAt})`,
    ),
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
    unique("daily_plan_items_feedback_provenance_uq").on(
      table.workspaceId,
      table.planId,
      table.id,
      table.routineId,
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

/**
 * Immutable user-authored planning feedback for a routine.
 *
 * The latest event by ingestion sequence is the complete projection for a
 * routine. A reset deliberately has no effective-through date so expired or
 * older suppressions cannot become active again.
 */
export const routinePlanningFeedbackEvents = pgTable(
  "routine_planning_feedback_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ingestedSequence: bigserial("ingested_sequence", { mode: "number" }).notNull(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    routineId: uuid("routine_id").notNull(),
    kind: routinePlanningFeedbackKind("kind").notNull(),
    effectiveOn: date("effective_on").notNull(),
    effectiveThrough: date("effective_through"),
    timeZone: varchar("time_zone", { length: 80 }).notNull(),
    sourcePlanId: uuid("source_plan_id").notNull(),
    sourcePlanItemId: uuid("source_plan_item_id"),
    idempotencyKey: varchar("idempotency_key", { length: 160 }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    unique("routine_planning_feedback_events_workspace_id_id_uq").on(table.workspaceId, table.id),
    unique("routine_planning_feedback_events_workspace_date_idempotency_uq").on(
      table.workspaceId,
      table.effectiveOn,
      table.idempotencyKey,
    ),
    index("routine_planning_feedback_events_routine_sequence_idx").on(
      table.workspaceId,
      table.routineId,
      table.ingestedSequence.desc(),
      table.id.desc(),
    ),
    index("routine_planning_feedback_events_effective_date_idx").on(
      table.workspaceId,
      table.effectiveOn,
    ),
    foreignKey({
      name: "routine_planning_feedback_events_routine_tenant_fk",
      columns: [table.workspaceId, table.routineId],
      foreignColumns: [routines.workspaceId, routines.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "routine_planning_feedback_events_plan_tenant_fk",
      columns: [table.workspaceId, table.sourcePlanId],
      foreignColumns: [dailyPlans.workspaceId, dailyPlans.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "routine_planning_feedback_events_source_routine_item_fk",
      columns: [table.workspaceId, table.sourcePlanId, table.sourcePlanItemId, table.routineId],
      foreignColumns: [
        dailyPlanItems.workspaceId,
        dailyPlanItems.planId,
        dailyPlanItems.id,
        dailyPlanItems.routineId,
      ],
    }).onDelete("restrict"),
    check(
      "routine_planning_feedback_events_kind_policy",
      sql`(${table.kind} = 'reset' AND ${table.effectiveThrough} IS NULL AND ${table.sourcePlanItemId} IS NULL) OR (${table.kind} = 'not_today' AND ${table.effectiveThrough} = ${table.effectiveOn} AND ${table.sourcePlanItemId} IS NOT NULL) OR (${table.kind} = 'not_this_week' AND ${table.effectiveThrough} >= ${table.effectiveOn} AND ${table.effectiveThrough} <= (${table.effectiveOn} + 6) AND ${table.sourcePlanItemId} IS NOT NULL)`,
    ),
    check(
      "routine_planning_feedback_events_timezone_nonempty",
      sql`char_length(btrim(${table.timeZone})) > 0`,
    ),
    check(
      "routine_planning_feedback_events_idempotency_nonempty",
      sql`char_length(btrim(${table.idempotencyKey})) > 0`,
    ),
    check("routine_planning_feedback_events_sequence_positive", sql`${table.ingestedSequence} > 0`),
  ],
);

/**
 * Immutable, user-authored ranking feedback for future routine selection.
 *
 * The routine-held selection-preference version is the optimistic fence for
 * this event stream. Provenance is deliberately optional: this preference can
 * be recorded directly from the routine catalogue without a current plan.
 */
export const routineSelectionPreferenceFeedbackEvents = pgTable(
  "routine_selection_preference_feedback_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ingestedSequence: bigserial("ingested_sequence", { mode: "number" }).notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    routineId: uuid("routine_id").notNull(),
    feedbackVersion: integer("feedback_version").notNull(),
    kind: routineSelectionPreferenceFeedbackKind("kind").notNull(),
    effectiveOn: date("effective_on").notNull(),
    timeZone: varchar("time_zone", { length: 80 }).notNull(),
    sourcePlanId: uuid("source_plan_id"),
    sourcePlanItemId: uuid("source_plan_item_id"),
    idempotencyKey: varchar("idempotency_key", { length: 160 }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    unique("routine_select_pref_events_workspace_id_uq").on(table.workspaceId, table.id),
    unique("routine_select_pref_events_workspace_key_uq").on(
      table.workspaceId,
      table.idempotencyKey,
    ),
    unique("routine_select_pref_events_routine_version_uq").on(
      table.workspaceId,
      table.routineId,
      table.feedbackVersion,
    ),
    index("routine_select_pref_events_planning_idx").on(
      table.workspaceId,
      table.routineId,
      table.effectiveOn,
      table.ingestedSequence.desc(),
      table.id.desc(),
    ),
    foreignKey({
      name: "routine_select_pref_events_workspace_fk",
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "routine_select_pref_events_routine_fk",
      columns: [table.workspaceId, table.routineId],
      foreignColumns: [routines.workspaceId, routines.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "routine_select_pref_events_plan_fk",
      columns: [table.workspaceId, table.sourcePlanId],
      foreignColumns: [dailyPlans.workspaceId, dailyPlans.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "routine_select_pref_events_source_item_fk",
      columns: [table.workspaceId, table.sourcePlanId, table.sourcePlanItemId, table.routineId],
      foreignColumns: [
        dailyPlanItems.workspaceId,
        dailyPlanItems.planId,
        dailyPlanItems.id,
        dailyPlanItems.routineId,
      ],
    }).onDelete("restrict"),
    check(
      "routine_select_pref_events_source_valid",
      sql`${table.sourcePlanItemId} IS NULL OR ${table.sourcePlanId} IS NOT NULL`,
    ),
    check(
      "routine_select_pref_events_reset_item_null",
      sql`${table.kind} <> 'reset' OR ${table.sourcePlanItemId} IS NULL`,
    ),
    check(
      "routine_select_pref_events_timezone_nonempty",
      sql`char_length(btrim(${table.timeZone})) > 0`,
    ),
    check(
      "routine_select_pref_events_key_nonempty",
      sql`char_length(btrim(${table.idempotencyKey})) > 0`,
    ),
    check("routine_select_pref_events_sequence_positive", sql`${table.ingestedSequence} > 0`),
    check("routine_select_pref_events_version_positive", sql`${table.feedbackVersion} > 0`),
  ],
);

/**
 * Immutable user feedback about one exact routine-duration insight.
 *
 * `insightKey` identifies the evidence-backed insight that was shown to the
 * user. The latest event for that key is its complete dismissed/reset
 * projection, while the workspace-scoped idempotency key makes commands safe
 * to retry across routines.
 */
export const routineDurationInsightFeedbackEvents = pgTable(
  "routine_duration_insight_feedback_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ingestedSequence: bigserial("ingested_sequence", { mode: "number" }).notNull(),
    workspaceId: uuid("workspace_id").notNull(),
    routineId: uuid("routine_id").notNull(),
    insightKey: varchar("insight_key", { length: 64 }).notNull(),
    kind: routineDurationInsightFeedbackKind("kind").notNull(),
    routineVersion: integer("routine_version").notNull(),
    observedMedianMinutes: integer("observed_median_minutes").notNull(),
    suggestedExpectedMinutes: integer("suggested_expected_minutes"),
    idempotencyKey: varchar("idempotency_key", { length: 160 }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    unique("duration_insight_feedback_workspace_id_uq").on(table.workspaceId, table.id),
    unique("duration_insight_feedback_workspace_idempotency_uq").on(
      table.workspaceId,
      table.idempotencyKey,
    ),
    index("duration_insight_feedback_key_sequence_idx").on(
      table.workspaceId,
      table.routineId,
      table.insightKey,
      table.ingestedSequence.desc(),
      table.id.desc(),
    ),
    foreignKey({
      name: "duration_insight_feedback_workspace_fk",
      columns: [table.workspaceId],
      foreignColumns: [workspaces.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "duration_insight_feedback_routine_tenant_fk",
      columns: [table.workspaceId, table.routineId],
      foreignColumns: [routines.workspaceId, routines.id],
    }).onDelete("restrict"),
    check(
      "duration_insight_feedback_key_format",
      sql`char_length(${table.insightKey}) = 64 AND ${table.insightKey} ~ '^[0-9a-f]{64}$'`,
    ),
    check("duration_insight_feedback_version_positive", sql`${table.routineVersion} > 0`),
    check("duration_insight_feedback_observed_positive", sql`${table.observedMedianMinutes} > 0`),
    check(
      "duration_insight_feedback_suggested_positive",
      sql`${table.suggestedExpectedMinutes} IS NULL OR ${table.suggestedExpectedMinutes} > 0`,
    ),
    check(
      "duration_insight_feedback_idempotency_canonical",
      sql`char_length(${table.idempotencyKey}) > 0 AND ${table.idempotencyKey} = btrim(${table.idempotencyKey})`,
    ),
    check("duration_insight_feedback_sequence_positive", sql`${table.ingestedSequence} > 0`),
  ],
);

/** Immutable user feedback for one exact workspace-level Daily Plan Fit evidence hash. */
export const dailyPlanFitInsightFeedbackEvents = pgTable(
  "daily_plan_fit_insight_feedback_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ingestedSequence: bigserial("ingested_sequence", { mode: "number" }).notNull(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    forDate: date("for_date").notNull(),
    insightKey: varchar("insight_key", { length: 64 }).notNull(),
    kind: dailyPlanFitInsightFeedbackKind("kind").notNull(),
    planId: uuid("plan_id"),
    sampleCount: integer("sample_count").notNull(),
    typicalPlannedMinutes: integer("typical_planned_minutes").notNull(),
    typicalCompletedMinutes: integer("typical_completed_minutes").notNull(),
    typicalPlannedTaskCount: integer("typical_planned_task_count").notNull(),
    typicalCompletedTaskCount: integer("typical_completed_task_count").notNull(),
    suggestedTargetMinutes: integer("suggested_target_minutes").notNull(),
    suggestedTargetTaskCount: integer("suggested_target_task_count").notNull(),
    appliedTargetMinutes: integer("applied_target_minutes"),
    appliedTargetTaskCount: integer("applied_target_task_count"),
    idempotencyKey: varchar("idempotency_key", { length: 160 }).notNull(),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
  },
  (table) => [
    unique("daily_plan_fit_feedback_workspace_id_uq").on(table.workspaceId, table.id),
    unique("daily_plan_fit_feedback_workspace_idempotency_uq").on(
      table.workspaceId,
      table.idempotencyKey,
    ),
    index("daily_plan_fit_feedback_key_sequence_idx").on(
      table.workspaceId,
      table.insightKey,
      table.ingestedSequence.desc(),
      table.id.desc(),
    ),
    index("daily_plan_fit_feedback_kind_sequence_idx").on(
      table.workspaceId,
      table.kind,
      table.ingestedSequence.desc(),
      table.id.desc(),
    ),
    uniqueIndex("daily_plan_fit_feedback_used_plan_uq")
      .on(table.workspaceId, table.planId)
      .where(sql`${table.planId} is not null`),
    foreignKey({
      name: "daily_plan_fit_feedback_plan_tenant_fk",
      columns: [table.workspaceId, table.planId],
      foreignColumns: [dailyPlans.workspaceId, dailyPlans.id],
    }).onDelete("restrict"),
    check(
      "daily_plan_fit_feedback_key_format",
      sql`char_length(${table.insightKey}) = 64 AND ${table.insightKey} ~ '^[0-9a-f]{64}$'`,
    ),
    check("daily_plan_fit_feedback_sample_positive", sql`${table.sampleCount} > 0`),
    check(
      "daily_plan_fit_feedback_planned_minutes_positive",
      sql`${table.typicalPlannedMinutes} > 0`,
    ),
    check(
      "daily_plan_fit_feedback_completed_minutes_nonnegative",
      sql`${table.typicalCompletedMinutes} >= 0`,
    ),
    check(
      "daily_plan_fit_feedback_planned_tasks_positive",
      sql`${table.typicalPlannedTaskCount} > 0`,
    ),
    check(
      "daily_plan_fit_feedback_completed_tasks_nonnegative",
      sql`${table.typicalCompletedTaskCount} >= 0`,
    ),
    check(
      "daily_plan_fit_feedback_suggested_minutes_positive",
      sql`${table.suggestedTargetMinutes} > 0`,
    ),
    check(
      "daily_plan_fit_feedback_suggested_tasks_positive",
      sql`${table.suggestedTargetTaskCount} > 0`,
    ),
    check(
      "daily_plan_fit_feedback_usage_shape_valid",
      sql`(
        ${table.kind}::text = 'used'
        AND ${table.planId} IS NOT NULL
        AND ${table.appliedTargetMinutes} IS NOT NULL
        AND ${table.appliedTargetTaskCount} IS NOT NULL
      ) OR (
        ${table.kind}::text IN ('dismissed', 'reset')
        AND ${table.planId} IS NULL
        AND ${table.appliedTargetMinutes} IS NULL
        AND ${table.appliedTargetTaskCount} IS NULL
      )`,
    ),
    check(
      "daily_plan_fit_feedback_applied_minutes_positive",
      sql`${table.appliedTargetMinutes} IS NULL OR ${table.appliedTargetMinutes} > 0`,
    ),
    check(
      "daily_plan_fit_feedback_applied_tasks_positive",
      sql`${table.appliedTargetTaskCount} IS NULL OR ${table.appliedTargetTaskCount} > 0`,
    ),
    check(
      "daily_plan_fit_feedback_idempotency_canonical",
      sql`char_length(${table.idempotencyKey}) > 0 AND ${table.idempotencyKey} = btrim(${table.idempotencyKey})`,
    ),
    check("daily_plan_fit_feedback_sequence_positive", sql`${table.ingestedSequence} > 0`),
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
