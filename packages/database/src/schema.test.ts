import { readFileSync } from "node:fs";

import { getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  activityEvents,
  browserSessionRevocationReason,
  browserSessions,
  dailyPlanFitInsightFeedbackEvents,
  dailyPlanFitInsightFeedbackKind,
  dailyPlanHeads,
  dailyPlanItemStates,
  dailyPlanItems,
  dailyPlans,
  externalIdentities,
  hostedLoginTransactions,
  hostedUsers,
  hostedUserStatus,
  integrationConfirmations,
  integrationCredentials,
  integrationRequests,
  naturalLanguageProposalStatus,
  naturalLanguageProposals,
  notificationDeliveryAttemptOutcome,
  notificationDeliveryAttempts,
  notificationDeliveryCommands,
  notificationDeliveryRequests,
  notificationDeliveryRequestOperation,
  notificationDeliveryStatus,
  notificationIntents,
  notificationKind,
  notificationLocalTimeResolution,
  notificationProfiles,
  notificationQuietHoursPolicy,
  notificationRuleKind,
  notificationRules,
  notificationTargetType,
  oneOffReminders,
  outboxEvents,
  planInteractionEvents,
  planMutationKind,
  planMutations,
  routineDurationInsightFeedbackEvents,
  routineDurationInsightFeedbackKind,
  routineGroupMemberships,
  routineGroups,
  routinePlanningFeedbackEvents,
  routinePlanningFeedbackKind,
  routineSelectionPreferenceFeedbackEvents,
  routineSelectionPreferenceFeedbackKind,
  routines,
  scheduleBlocks,
  workItemDependencies,
  workItems,
  workspaces,
  workspaceMemberships,
  workspaceMembershipStatus,
  webhookDeliveries,
  webhookEndpointSecrets,
  webhookEndpoints,
  webhookEventSubscriptions,
} from "./schema.js";

describe("database schema", () => {
  it("uses stable table names for core infrastructure", () => {
    expect(getTableName(workspaces)).toBe("workspaces");
    expect(getTableName(workItems)).toBe("work_items");
    expect(getTableName(workItemDependencies)).toBe("work_item_dependencies");
    expect(getTableName(scheduleBlocks)).toBe("schedule_blocks");
    expect(getTableName(outboxEvents)).toBe("outbox_events");
    expect(getTableName(routines)).toBe("routines");
    expect(getTableName(routineGroups)).toBe("routine_groups");
    expect(getTableName(routineGroupMemberships)).toBe("routine_group_memberships");
    expect(getTableName(activityEvents)).toBe("activity_events");
    expect(getTableName(dailyPlans)).toBe("daily_plans");
    expect(getTableName(dailyPlanItems)).toBe("daily_plan_items");
    expect(getTableName(dailyPlanFitInsightFeedbackEvents)).toBe(
      "daily_plan_fit_insight_feedback_events",
    );
    expect(getTableName(dailyPlanHeads)).toBe("daily_plan_heads");
    expect(getTableName(dailyPlanItemStates)).toBe("daily_plan_item_states");
    expect(getTableName(planInteractionEvents)).toBe("plan_interaction_events");
    expect(getTableName(planMutations)).toBe("plan_mutations");
    expect(getTableName(routineDurationInsightFeedbackEvents)).toBe(
      "routine_duration_insight_feedback_events",
    );
    expect(getTableName(routinePlanningFeedbackEvents)).toBe("routine_planning_feedback_events");
    expect(getTableName(routineSelectionPreferenceFeedbackEvents)).toBe(
      "routine_selection_preference_feedback_events",
    );
    expect(getTableName(integrationCredentials)).toBe("integration_credentials");
    expect(getTableName(integrationConfirmations)).toBe("integration_confirmations");
    expect(getTableName(integrationRequests)).toBe("integration_requests");
    expect(getTableName(naturalLanguageProposals)).toBe("natural_language_proposals");
    expect(getTableName(notificationProfiles)).toBe("notification_profiles");
    expect(getTableName(notificationRules)).toBe("notification_rules");
    expect(getTableName(oneOffReminders)).toBe("one_off_reminders");
    expect(getTableName(notificationIntents)).toBe("notification_intents");
    expect(getTableName(notificationDeliveryCommands)).toBe("notification_delivery_commands");
    expect(getTableName(notificationDeliveryAttempts)).toBe("notification_delivery_attempts");
    expect(getTableName(notificationDeliveryRequests)).toBe("notification_delivery_requests");
    expect(getTableName(webhookEndpoints)).toBe("webhook_endpoints");
    expect(getTableName(webhookEndpointSecrets)).toBe("webhook_endpoint_secrets");
    expect(getTableName(webhookDeliveries)).toBe("webhook_deliveries");
    expect(getTableName(webhookEventSubscriptions)).toBe("webhook_event_subscriptions");
    expect(getTableName(hostedUsers)).toBe("users");
    expect(getTableName(externalIdentities)).toBe("external_identities");
    expect(getTableName(browserSessions)).toBe("browser_sessions");
    expect(getTableName(hostedLoginTransactions)).toBe("hosted_login_transactions");
    expect(getTableName(workspaceMemberships)).toBe("workspace_memberships");
  });

  it("persists only bounded hosted login coordination material", () => {
    const transactions = getTableConfig(hostedLoginTransactions);
    expect(transactions.uniqueConstraints.map((constraint) => constraint.getName())).toEqual(
      expect.arrayContaining([
        "hosted_login_transactions_state_digest_uq",
        "hosted_login_transactions_browser_binding_digest_uq",
      ]),
    );
    expect(transactions.indexes.map((constraint) => constraint.config.name)).toContain(
      "hosted_login_transactions_expiry_idx",
    );
    expect(transactions.checks.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        "hosted_login_transactions_digests_valid",
        "hosted_login_transactions_oidc_values_valid",
        "hosted_login_transactions_lifecycle_valid",
        "hosted_login_transactions_version_positive",
      ]),
    );
    expect(hostedLoginTransactions).not.toHaveProperty("state");
    expect(hostedLoginTransactions).not.toHaveProperty("browserBinding");
    expect(hostedLoginTransactions).not.toHaveProperty("pkceVerifier");
  });

  it("migrates hosted login coordination without plaintext bearer columns", () => {
    const migration = readFileSync(
      new URL("../drizzle/0036_romantic_justice.sql", import.meta.url),
      "utf8",
    );
    expect(migration).toContain('CREATE TABLE "hosted_login_transactions"');
    expect(migration).toContain('"state_digest" varchar(64) NOT NULL');
    expect(migration).toContain('"browser_binding_digest" varchar(64) NOT NULL');
    expect(migration).toContain('"protected_pkce_verifier" varchar(2048) NOT NULL');
    expect(migration).toContain("\"pkce_method\" varchar(4) DEFAULT 'S256' NOT NULL");
    expect(migration).not.toContain('\n\t"state" ');
    expect(migration).not.toContain('\n\t"browser_binding" ');
    expect(migration).not.toContain('\n\t"pkce_verifier" ');
  });

  it("persists a provider-neutral hosted identity and binary membership boundary", () => {
    expect(hostedUserStatus.enumValues).toEqual(["active", "disabled"]);
    expect(browserSessionRevocationReason.enumValues).toEqual([
      "signed_out",
      "rotated",
      "user_disabled",
      "administrative",
    ]);
    expect(workspaceMembershipStatus.enumValues).toEqual(["active", "revoked"]);

    const users = getTableConfig(hostedUsers);
    expect(users.checks.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        "users_lifecycle_valid",
        "users_timestamps_valid",
        "users_version_positive",
      ]),
    );

    const identities = getTableConfig(externalIdentities);
    expect(identities.indexes.map((constraint) => constraint.config.name)).toEqual(
      expect.arrayContaining([
        "external_identities_exact_binding_uq",
        "external_identities_user_idx",
      ]),
    );

    const sessions = getTableConfig(browserSessions);
    expect(sessions.uniqueConstraints.map((constraint) => constraint.getName())).toContain(
      "browser_sessions_secret_digest_uq",
    );
    expect(sessions.checks.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        "browser_sessions_digest_valid",
        "browser_sessions_idle_timeout_valid",
        "browser_sessions_expiry_valid",
        "browser_sessions_revocation_valid",
        "browser_sessions_version_positive",
      ]),
    );

    const memberships = getTableConfig(workspaceMemberships);
    expect(memberships.primaryKeys.map((constraint) => constraint.getName())).toContain(
      "workspace_memberships_pk",
    );
    expect(memberships.indexes.map((constraint) => constraint.config.name)).toContain(
      "workspace_memberships_user_status_workspace_idx",
    );
    expect(memberships.checks.map((constraint) => constraint.name)).toContain(
      "workspace_memberships_lifecycle_valid",
    );
  });

  it("migrates hosted identity without attaching ownership to workspace data", () => {
    const migration = readFileSync(
      new URL("../drizzle/0031_daffy_bloodstrike.sql", import.meta.url),
      "utf8",
    );

    expect(migration).toContain('CREATE TABLE "users"');
    expect(migration).toContain('CREATE TABLE "external_identities"');
    expect(migration).toContain('CREATE TABLE "browser_sessions"');
    expect(migration).toContain('CREATE TABLE "workspace_memberships"');
    expect(migration).toContain('CREATE UNIQUE INDEX "external_identities_exact_binding_uq"');
    expect(migration).toContain('"issuer" collate "C"');
    expect(migration).not.toContain('ALTER TABLE "workspaces" ADD COLUMN "user_id"');
  });

  it("migrates the bounded hosted membership discovery index", () => {
    const migration = readFileSync(
      new URL("../drizzle/0037_spooky_maelstrom.sql", import.meta.url),
      "utf8",
    );
    expect(migration).toContain('CREATE INDEX "workspace_memberships_user_status_workspace_idx"');
    expect(migration).toContain('("user_id","status","workspace_id")');
  });

  it("enforces a tenant-scoped, non-cascading work-item hierarchy", () => {
    const workItem = getTableConfig(workItems);

    expect(workItem.foreignKeys.map((constraint) => constraint.getName())).toContain(
      "work_items_parent_tenant_fk",
    );
    expect(workItem.checks.map((constraint) => constraint.name)).toContain(
      "work_items_parent_not_self",
    );
    expect(workItem.indexes.map((constraint) => constraint.config.name)).toContain(
      "work_items_workspace_parent_created_id_idx",
    );
  });

  it("migrates existing work items into the hierarchy as roots", () => {
    const migration = readFileSync(
      new URL("../drizzle/0029_needy_vampiro.sql", import.meta.url),
      "utf8",
    );

    expect(migration).toContain('ADD COLUMN "parent_work_item_id" uuid');
    expect(migration).toContain('CONSTRAINT "work_items_parent_tenant_fk"');
    expect(migration).toContain("ON DELETE restrict");
    expect(migration).toContain('CREATE INDEX "work_items_workspace_parent_created_id_idx"');
    expect(migration).toContain('CONSTRAINT "work_items_parent_not_self"');
    expect(migration).not.toContain('UPDATE "work_items"');
  });

  it("fences provider-neutral notification delivery and exact request replay", () => {
    expect(notificationDeliveryStatus.enumValues).toEqual([
      "pending",
      "processing",
      "delivered",
      "dead_letter",
      "invalidated",
    ]);
    expect(notificationDeliveryAttemptOutcome.enumValues).toEqual([
      "delivered",
      "retryable_failure",
      "permanent_failure",
      "lease_expired",
    ]);
    expect(notificationDeliveryRequestOperation.enumValues).toEqual(["claim", "receipt"]);

    const command = getTableConfig(notificationDeliveryCommands);
    expect(command.columns.find((column) => column.name === "redrive_requested_at")).toBeDefined();
    expect(command.uniqueConstraints.map((constraint) => constraint.getName())).toEqual(
      expect.arrayContaining([
        "notification_delivery_commands_workspace_intent_uq",
        "notification_delivery_commands_workspace_occurrence_uq",
      ]),
    );
    expect(command.checks.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        "notification_delivery_commands_state_valid",
        "notification_delivery_commands_redrive_authorization_valid",
        "notification_delivery_commands_failure_code_valid",
        "notification_delivery_commands_timestamps_valid",
      ]),
    );
    expect(command.indexes.map((constraint) => constraint.config.name)).toEqual(
      expect.arrayContaining([
        "notification_delivery_commands_claim_idx",
        "notification_delivery_commands_recovery_idx",
        "notification_delivery_commands_workspace_schedule_idx",
      ]),
    );

    const attempt = getTableConfig(notificationDeliveryAttempts);
    expect(attempt.foreignKeys.map((constraint) => constraint.getName())).toEqual(
      expect.arrayContaining([
        "notification_delivery_attempts_command_tenant_fk",
        "notification_delivery_attempts_credential_tenant_fk",
      ]),
    );
    expect(attempt.checks.map((constraint) => constraint.name)).toContain(
      "notification_delivery_attempts_outcome_valid",
    );

    const request = getTableConfig(notificationDeliveryRequests);
    expect(request.foreignKeys.map((constraint) => constraint.getName())).toContain(
      "notification_delivery_requests_credential_tenant_fk",
    );
    expect(request.checks.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        "notification_delivery_requests_hash_valid",
        "notification_delivery_requests_result_bounded",
        "notification_delivery_requests_state_valid",
      ]),
    );
  });

  it("migrates the least-privilege delivery scope and lifecycle tables", () => {
    const migration = readFileSync(
      new URL("../drizzle/0026_puzzling_micromax.sql", import.meta.url),
      "utf8",
    );

    expect(migration).toContain("'schedule:delivery'");
    expect(migration).toContain('CREATE TABLE "notification_delivery_commands"');
    expect(migration).toContain('CREATE TABLE "notification_delivery_attempts"');
    expect(migration).toContain('CREATE TABLE "notification_delivery_requests"');
    expect(migration).toContain('CREATE INDEX "notification_delivery_commands_recovery_idx"');
  });

  it("persists the one-use exhausted-attempt redrive authorization", () => {
    const migration = readFileSync(
      new URL("../drizzle/0043_typical_layla_miller.sql", import.meta.url),
      "utf8",
    );
    expect(migration).toContain('ADD COLUMN "redrive_requested_at"');
    expect(migration).toContain("notification_delivery_commands_redrive_authorization_valid");
    expect(migration).not.toContain("source-deleted dead letters");
  });

  it("cuts off orphan dead letters in an append-only follow-up migration", () => {
    const migration = readFileSync(
      new URL("../drizzle/0044_orphan_dead_letter_cutoff.sql", import.meta.url),
      "utf8",
    );
    expect(migration).toContain("source-deleted dead letters must be permanently ineligible");
    expect(migration).toContain("command.\"status\" = 'dead_letter'");
    expect(migration).toContain('intent."workspace_id" = command."workspace_id"');
  });

  it("constrains deterministic notification policy and immutable intent sources", () => {
    expect(notificationQuietHoursPolicy.enumValues).toEqual(["skip", "next_allowed"]);
    expect(notificationRuleKind.enumValues).toEqual([
      "daily_digest",
      "daily_follow_up",
      "plan_window_open",
      "schedule_block_lead",
      "work_item_due",
    ]);
    expect(notificationKind.enumValues).toEqual([...notificationRuleKind.enumValues, "one_off"]);
    expect(notificationTargetType.enumValues).toEqual([
      "workspace",
      "daily_plan",
      "schedule_block",
      "work_item",
      "one_off",
    ]);
    expect(notificationLocalTimeResolution.enumValues).toEqual([
      "exact",
      "gap_later",
      "overlap_earlier",
    ]);

    const profile = getTableConfig(notificationProfiles);
    expect(profile.checks.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        "notification_profiles_quiet_hours_pair",
        "notification_profiles_quiet_start_range",
        "notification_profiles_quiet_end_range",
        "notification_profiles_catch_up_range",
        "notification_profiles_daily_limit_range",
        "notification_profiles_version_positive",
      ]),
    );

    const rule = getTableConfig(notificationRules);
    expect(rule.uniqueConstraints.map((constraint) => constraint.getName())).toContain(
      "notification_rules_workspace_id_id_uq",
    );
    expect(rule.uniqueConstraints.map((constraint) => constraint.getName())).toContain(
      "notification_rules_workspace_id_kind_uq",
    );
    expect(rule.checks.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        "notification_rules_configuration_valid",
        "notification_rules_cooldown_range",
        "notification_rules_priority_range",
        "notification_rules_version_positive",
      ]),
    );

    const oneOff = getTableConfig(oneOffReminders);
    expect(oneOff.uniqueConstraints.map((constraint) => constraint.getName())).toContain(
      "one_off_reminders_workspace_id_id_uq",
    );
    expect(oneOff.checks.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        "one_off_reminders_title_nonempty",
        "one_off_reminders_cancellation_valid",
        "one_off_reminders_version_positive",
      ]),
    );

    const intent = getTableConfig(notificationIntents);
    expect(intent.uniqueConstraints.map((constraint) => constraint.getName())).toEqual(
      expect.arrayContaining([
        "notification_intents_workspace_id_id_uq",
        "notification_intents_workspace_occurrence_uq",
      ]),
    );
    expect(intent.foreignKeys.map((constraint) => constraint.getName())).toEqual(
      expect.arrayContaining([
        "notification_intents_rule_tenant_kind_fk",
        "notification_intents_one_off_tenant_fk",
        "notification_intents_daily_plan_tenant_fk",
        "notification_intents_schedule_block_tenant_fk",
        "notification_intents_work_item_tenant_fk",
      ]),
    );
    expect(intent.indexes.map((constraint) => constraint.config.name)).toEqual(
      expect.arrayContaining([
        "notification_intents_workspace_schedule_idx",
        "notification_intents_workspace_rule_schedule_idx",
        "notification_intents_workspace_daily_plan_idx",
        "notification_intents_workspace_schedule_block_idx",
        "notification_intents_workspace_work_item_idx",
        "notification_intents_workspace_one_off_idx",
      ]),
    );
    expect(intent.checks.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        "notification_intents_source_valid",
        "notification_intents_target_valid",
        "notification_intents_occurrence_nonempty",
        "notification_intents_priority_range",
        "notification_intents_policy_snapshot_valid",
      ]),
    );
  });

  it("indexes due-work notification scans by tenant, date, and stable id", () => {
    expect(getTableConfig(workItems).indexes.map((constraint) => constraint.config.name)).toContain(
      "work_items_workspace_due_id_idx",
    );
  });

  it("tenant-binds the explicit schedule event subscription allowlist", () => {
    const config = getTableConfig(webhookEventSubscriptions);

    expect(config.primaryKeys.map((constraint) => constraint.getName())).toContain(
      "webhook_event_subscriptions_pk",
    );
    expect(config.foreignKeys.map((constraint) => constraint.getName())).toContain(
      "webhook_event_subscriptions_endpoint_tenant_fk",
    );
    expect(config.indexes.map((constraint) => constraint.config.name)).toContain(
      "webhook_event_subscriptions_workspace_event_idx",
    );
    expect(config.checks.map((constraint) => constraint.name)).toContain(
      "webhook_event_subscriptions_event_type_allowed",
    );
  });

  it("tenant-binds encrypted signing material and immutable exact-body deliveries", () => {
    const endpointConfig = getTableConfig(webhookEndpoints);
    const secretConfig = getTableConfig(webhookEndpointSecrets);
    const deliveryConfig = getTableConfig(webhookDeliveries);
    const outboxConfig = getTableConfig(outboxEvents);

    expect(endpointConfig.checks.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        "webhook_endpoints_url_https",
        "webhook_endpoints_revocation_consistent",
      ]),
    );
    expect(secretConfig.columns.map((column) => column.name)).toContain("secret_envelope");
    expect(secretConfig.columns.map((column) => column.name)).not.toContain("secret");
    expect(secretConfig.indexes.map((constraint) => constraint.config.name)).toEqual(
      expect.arrayContaining([
        "webhook_endpoint_secrets_one_active_uq",
        "webhook_endpoint_secrets_one_pending_uq",
      ]),
    );
    expect(secretConfig.checks.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        "webhook_endpoint_secrets_version_positive",
        "webhook_endpoint_secrets_envelope_shape",
        "webhook_endpoint_secrets_lifecycle_consistent",
      ]),
    );
    expect(deliveryConfig.foreignKeys.map((constraint) => constraint.getName())).toEqual(
      expect.arrayContaining([
        "webhook_deliveries_endpoint_tenant_fk",
        "webhook_deliveries_secret_tenant_fk",
      ]),
    );
    expect(deliveryConfig.checks.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        "webhook_deliveries_raw_body_json_bounded",
        "webhook_deliveries_body_sha256_matches",
      ]),
    );
    expect(outboxConfig.foreignKeys.map((constraint) => constraint.getName())).toContain(
      "outbox_events_webhook_delivery_tenant_fk",
    );
    expect(outboxConfig.checks.map((constraint) => constraint.name)).toContain(
      "outbox_events_webhook_delivery_payload",
    );
  });

  it("stores only credential digests and constrains the settled gateway scopes", () => {
    const config = getTableConfig(integrationCredentials);
    const columnNames = config.columns.map((column) => column.name);
    const checkNames = config.checks.map((constraint) => constraint.name);

    expect(columnNames).toContain("secret_digest");
    expect(columnNames).not.toContain("secret");
    expect(checkNames).toEqual(
      expect.arrayContaining([
        "integration_credentials_secret_digest_length",
        "integration_credentials_secret_digest_format",
        "integration_credentials_scopes_nonempty",
        "integration_credentials_scopes_allowed",
        "integration_credentials_scopes_unique",
        "integration_credentials_revocation_consistent",
        "integration_credentials_version_positive",
      ]),
    );
  });

  it("tenant-binds one-time confirmations and durable request receipts", () => {
    const confirmationConfig = getTableConfig(integrationConfirmations);
    const requestConfig = getTableConfig(integrationRequests);

    expect(confirmationConfig.foreignKeys.map((constraint) => constraint.getName())).toContain(
      "integration_confirmations_credential_tenant_fk",
    );
    expect(confirmationConfig.checks.map((constraint) => constraint.name)).toContain(
      "integration_confirmations_command_binding_valid",
    );
    expect(requestConfig.foreignKeys.map((constraint) => constraint.getName())).toEqual(
      expect.arrayContaining([
        "integration_requests_credential_tenant_fk",
        "integration_requests_confirmation_tenant_fk",
      ]),
    );
    expect(requestConfig.checks.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        "integration_requests_command_hash_length",
        "integration_requests_status_result_consistent",
        "integration_requests_completion_after_creation",
      ]),
    );
  });

  it("constrains private, expiring, tenant-bound natural-language proposals", () => {
    const config = getTableConfig(naturalLanguageProposals);
    const columnNames = config.columns.map((column) => column.name);

    expect(naturalLanguageProposalStatus.enumValues).toEqual(["pending", "confirmed", "cancelled"]);
    expect(columnNames).toContain("prompt_hash");
    expect(columnNames).toEqual(
      expect.arrayContaining([
        "review_priority",
        "review_due_on",
        "review_planning_duration_minutes",
        "review_hash",
        "model_suggestions_hash",
        "model_suggestions",
        "result_schedule_block_id",
        "result_routine_id",
      ]),
    );
    expect(columnNames).not.toEqual(expect.arrayContaining(["prompt", "summary", "warnings"]));
    expect(config.uniqueConstraints.map((constraint) => constraint.name)).toContain(
      "natural_language_proposals_workspace_request_uq",
    );
    expect(config.foreignKeys.map((constraint) => constraint.getName())).toEqual(
      expect.arrayContaining([
        "natural_language_proposals_result_work_item_tenant_fk",
        "natural_language_proposals_result_schedule_block_tenant_fk",
        "natural_language_proposals_result_routine_tenant_fk",
      ]),
    );
    expect(config.indexes.map((constraint) => constraint.config.name)).toEqual(
      expect.arrayContaining([
        "natural_language_proposals_workspace_status_created_idx",
        "natural_language_proposals_workspace_expiry_idx",
      ]),
    );
    expect(config.checks.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        "natural_language_proposals_prompt_hash_valid",
        "natural_language_proposals_command_hash_valid",
        "natural_language_proposals_review_hash_valid",
        "natural_language_proposals_model_suggestions_hash_valid",
        "natural_language_proposals_review_duration_valid",
        "natural_language_proposals_model_suggestions_object",
        "natural_language_proposals_expiry_after_creation",
        "natural_language_proposals_lifecycle_valid",
        "natural_language_proposals_terminal_time_valid",
      ]),
    );
  });

  it("migrates natural-language proposal lifecycle and retention boundaries", () => {
    const migration = readFileSync(
      new URL("../drizzle/0028_warm_rictor.sql", import.meta.url),
      "utf8",
    );

    expect(migration).toContain('CREATE TABLE "natural_language_proposals"');
    expect(migration).not.toContain('"prompt" text');
    expect(migration).not.toContain('"summary"');
    expect(migration).toContain("interval '1 hour'");
    expect(migration).toContain(
      'CONSTRAINT "natural_language_proposals_result_work_item_tenant_fk"',
    );
    expect(migration).toContain('CREATE INDEX "natural_language_proposals_workspace_expiry_idx"');
  });

  it("migrates user-authored natural-language review fields without widening model commands", () => {
    const migration = readFileSync(
      new URL("../drizzle/0032_harsh_purifiers.sql", import.meta.url),
      "utf8",
    );

    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "review_priority" "work_item_priority"');
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "review_hash" varchar(64)');
    expect(migration).toContain("65f7aef345c4f828788d1f4b3d779476b02a9599c31b1442ac7a4b3dbd670805");
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "review_due_on" date');
    expect(migration).toContain(
      'ADD COLUMN IF NOT EXISTS "review_planning_duration_minutes" integer',
    );
    expect(migration).toContain("natural-language proposal review columns have incompatible types");
    expect(migration).toContain(
      'DROP CONSTRAINT IF EXISTS "natural_language_proposals_review_hash_valid"',
    );
    expect(migration).toContain('"review_planning_duration_minutes" <= 43200');
    expect(migration).not.toContain('ALTER COLUMN "command"');
  });

  it("migrates nullable structured model suggestions independently of the command", () => {
    const migration = readFileSync(
      new URL("../drizzle/0038_smooth_ender_wiggin.sql", import.meta.url),
      "utf8",
    );

    expect(migration).toContain('ADD COLUMN "model_suggestions" jsonb');
    expect(migration).toContain('ADD COLUMN "model_suggestions_hash" varchar(64)');
    expect(migration).toContain("model_suggestions_hash_valid");
    expect(migration).toContain('"model_suggestions" IS NULL OR jsonb_typeof');
    expect(migration).not.toContain('ALTER COLUMN "command"');
  });

  it("migrates command-typed calendar-block proposal results", () => {
    const migration = readFileSync(
      new URL("../drizzle/0039_lively_smiling_tiger.sql", import.meta.url),
      "utf8",
    );

    expect(migration).toContain('ADD COLUMN "result_schedule_block_id" uuid');
    expect(migration).toContain(
      'CONSTRAINT "natural_language_proposals_result_schedule_block_tenant_fk"',
    );
    expect(migration).toContain("= 'schedule_block.create'");
    expect(migration).toContain("CHECK (COALESCE((");
    expect(migration).toContain('"result_work_item_id" IS NULL');
    expect(migration).toContain('"result_schedule_block_id" IS NOT NULL');
  });

  it("migrates command-typed routine proposal results with a tenant boundary", () => {
    const migration = readFileSync(
      new URL("../drizzle/0040_dusty_shinko_yamashiro.sql", import.meta.url),
      "utf8",
    );

    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "result_routine_id" uuid');
    expect(migration).toContain('CONSTRAINT "natural_language_proposals_result_routine_tenant_fk"');
    expect(migration).toContain('REFERENCES "public"."routines"("workspace_id","id")');
    expect(migration).toContain(
      'DROP CONSTRAINT IF EXISTS "natural_language_proposals_lifecycle_valid"',
    );
    expect(migration).toContain(
      'DROP CONSTRAINT IF EXISTS "natural_language_proposals_command_display_bounded"',
    );
    expect(migration).toContain('"command_display") BETWEEN 1 AND 64000');
    expect(migration).toContain(
      '"command"->>\'type\') = \'work_item.create\' AND "natural_language_proposals"."result_work_item_id" IS NOT NULL AND "natural_language_proposals"."result_schedule_block_id" IS NULL AND "natural_language_proposals"."result_routine_id" IS NULL',
    );
    expect(migration).toContain(
      '"command"->>\'type\') = \'schedule_block.create\' AND "natural_language_proposals"."result_work_item_id" IS NULL AND "natural_language_proposals"."result_schedule_block_id" IS NOT NULL AND "natural_language_proposals"."result_routine_id" IS NULL',
    );
    expect(migration).toContain(
      '"command"->>\'type\') = \'routine.create\' AND "natural_language_proposals"."result_work_item_id" IS NULL AND "natural_language_proposals"."result_schedule_block_id" IS NULL AND "natural_language_proposals"."result_routine_id" IS NOT NULL',
    );
  });

  it("constrains routine weekday arrays at the database boundary", () => {
    const checkNames = getTableConfig(routines).checks.map((constraint) => constraint.name);

    expect(checkNames).toEqual(
      expect.arrayContaining([
        "routines_preferred_weekdays_valid",
        "routines_preferred_weekdays_unique",
        "routines_preferred_weekdays_one_dimensional",
        "routines_excluded_weekdays_valid",
        "routines_excluded_weekdays_unique",
        "routines_excluded_weekdays_one_dimensional",
        "routines_weekdays_disjoint",
      ]),
    );
  });

  it("stores tenant-bound routine groups with many-to-many cascade-only membership", () => {
    const groupConfig = getTableConfig(routineGroups);
    const membershipConfig = getTableConfig(routineGroupMemberships);
    const migration = readFileSync(
      new URL("../drizzle/0045_mixed_guardsmen.sql", import.meta.url),
      "utf8",
    );

    expect(groupConfig.uniqueConstraints.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        "routine_groups_workspace_id_id_uq",
        "routine_groups_workspace_name_uq",
      ]),
    );
    expect(groupConfig.checks.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        "routine_groups_name_nonempty",
        "routine_groups_normalized_name_nonempty",
        "routine_groups_description_valid",
        "routine_groups_version_positive",
      ]),
    );
    expect(membershipConfig.primaryKeys[0]?.getName()).toBe("routine_group_memberships_pk");
    expect(membershipConfig.foreignKeys.map((constraint) => constraint.getName())).toEqual(
      expect.arrayContaining([
        "routine_group_memberships_group_tenant_fk",
        "routine_group_memberships_routine_tenant_fk",
      ]),
    );
    expect(
      membershipConfig.foreignKeys.map((constraint) => ({
        name: constraint.getName(),
        onDelete: constraint.onDelete,
      })),
    ).toEqual(
      expect.arrayContaining([
        { name: "routine_group_memberships_group_tenant_fk", onDelete: "cascade" },
        { name: "routine_group_memberships_routine_tenant_fk", onDelete: "cascade" },
      ]),
    );
    expect(migration).toContain('CREATE TABLE "routine_groups"');
    expect(migration).toContain('CREATE TABLE "routine_group_memberships"');
    expect(migration).toContain(
      'ALTER TYPE "public"."plan_mutation_kind" ADD VALUE \'add_routine\'',
    );
    expect(migration).toContain(
      'CONSTRAINT "routine_group_memberships_group_tenant_fk" FOREIGN KEY ("workspace_id","group_id") REFERENCES "public"."routine_groups"("workspace_id","id") ON DELETE cascade',
    );
    expect(migration).toContain(
      'CONSTRAINT "routine_group_memberships_routine_tenant_fk" FOREIGN KEY ("workspace_id","routine_id") REFERENCES "public"."routines"("workspace_id","id") ON DELETE cascade',
    );
  });

  it("models unified planner sources with tenant-scoped foreign keys", () => {
    const itemConfig = getTableConfig(dailyPlanItems);
    const activityConfig = getTableConfig(activityEvents);
    const workItemConfig = getTableConfig(workItems);

    expect(itemConfig.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(["source_type", "routine_id", "work_item_id"]),
    );
    expect(activityConfig.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(["source_type", "routine_id", "work_item_id"]),
    );
    expect(workItemConfig.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(["planning_duration_minutes", "due_on"]),
    );
    expect(itemConfig.checks.map((constraint) => constraint.name)).toContain(
      "daily_plan_items_source_valid",
    );
    expect(activityConfig.checks.map((constraint) => constraint.name)).toContain(
      "activity_events_source_valid",
    );
    expect(itemConfig.foreignKeys.map((constraint) => constraint.getName())).toContain(
      "daily_plan_items_work_item_tenant_fk",
    );
    expect(activityConfig.foreignKeys.map((constraint) => constraint.getName())).toContain(
      "activity_events_work_item_tenant_fk",
    );
  });

  it("stores tenant-bound directed work-item dependency edges", () => {
    const config = getTableConfig(workItemDependencies);

    expect(config.columns.map((column) => column.name)).toEqual([
      "workspace_id",
      "prerequisite_work_item_id",
      "dependent_work_item_id",
      "created_at",
    ]);
    expect(config.primaryKeys.map((constraint) => constraint.getName())).toContain(
      "work_item_dependencies_pk",
    );
    expect(config.foreignKeys.map((constraint) => constraint.getName())).toEqual(
      expect.arrayContaining([
        "work_item_dependencies_prerequisite_tenant_fk",
        "work_item_dependencies_dependent_tenant_fk",
      ]),
    );
    expect(
      config.foreignKeys.map((constraint) => ({
        name: constraint.getName(),
        onDelete: constraint.onDelete,
      })),
    ).toEqual(
      expect.arrayContaining([
        {
          name: "work_item_dependencies_prerequisite_tenant_fk",
          onDelete: "cascade",
        },
        { name: "work_item_dependencies_dependent_tenant_fk", onDelete: "cascade" },
      ]),
    );
    expect(config.indexes.map((constraint) => constraint.config.name)).toEqual(
      expect.arrayContaining([
        "work_item_dependencies_dependent_idx",
        "work_item_dependencies_list_idx",
      ]),
    );
    expect(config.checks.map((constraint) => constraint.name)).toContain(
      "work_item_dependencies_not_self",
    );
  });

  it("stores tenant-bound immutable routine planning feedback with strict horizon policy", () => {
    const config = getTableConfig(routinePlanningFeedbackEvents);

    expect(routinePlanningFeedbackKind.enumValues).toEqual(["not_today", "not_this_week", "reset"]);
    expect(planMutationKind.enumValues).toEqual([
      "regenerate",
      "replace",
      "add_routine",
      "feedback",
      "feedback_reset",
      "alternative_select",
    ]);
    expect(config.foreignKeys.map((constraint) => constraint.getName())).toEqual(
      expect.arrayContaining([
        "routine_planning_feedback_events_routine_tenant_fk",
        "routine_planning_feedback_events_plan_tenant_fk",
        "routine_planning_feedback_events_source_routine_item_fk",
      ]),
    );
    expect(
      config.uniqueConstraints
        .find(
          (constraint) =>
            constraint.getName() ===
            "routine_planning_feedback_events_workspace_date_idempotency_uq",
        )
        ?.columns.map((column) => column.name),
    ).toEqual(["workspace_id", "effective_on", "idempotency_key"]);
    expect(
      getTableConfig(dailyPlanItems)
        .uniqueConstraints.find(
          (constraint) => constraint.getName() === "daily_plan_items_feedback_provenance_uq",
        )
        ?.columns.map((column) => column.name),
    ).toEqual(["workspace_id", "plan_id", "id", "routine_id"]);
    expect(config.indexes.map((constraint) => constraint.config.name)).toEqual(
      expect.arrayContaining([
        "routine_planning_feedback_events_routine_sequence_idx",
        "routine_planning_feedback_events_effective_date_idx",
      ]),
    );
    expect(
      config.indexes
        .find(
          (constraint) =>
            constraint.config.name === "routine_planning_feedback_events_routine_sequence_idx",
        )
        ?.config.columns.map((column) => ({
          name: "name" in column ? column.name : null,
          order: "indexConfig" in column ? column.indexConfig.order : null,
        })),
    ).toEqual([
      { name: "workspace_id", order: "asc" },
      { name: "routine_id", order: "asc" },
      { name: "ingested_sequence", order: "desc" },
      { name: "id", order: "desc" },
    ]);
    expect(config.checks.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        "routine_planning_feedback_events_kind_policy",
        "routine_planning_feedback_events_timezone_nonempty",
        "routine_planning_feedback_events_idempotency_nonempty",
        "routine_planning_feedback_events_sequence_positive",
      ]),
    );
  });

  it("migrates routine feedback as append-only database history", () => {
    const migration = readFileSync(
      new URL("../drizzle/0020_chief_old_lace.sql", import.meta.url),
      "utf8",
    );

    expect(migration).toContain('CREATE TRIGGER "routine_planning_feedback_events_prevent_change"');
    expect(migration).toContain('BEFORE UPDATE OR DELETE ON "routine_planning_feedback_events"');
    expect(migration).toContain(
      '"routine_planning_feedback_events_routine_sequence_idx" ON "routine_planning_feedback_events" USING btree ("workspace_id","routine_id","ingested_sequence" DESC NULLS LAST,"id" DESC NULLS LAST)',
    );
    expect(migration).toContain(
      'FOREIGN KEY ("workspace_id","source_plan_id","source_plan_item_id","routine_id") REFERENCES "public"."daily_plan_items"("workspace_id","plan_id","id","routine_id")',
    );
  });

  it("stores append-only routine selection preferences behind an independent version fence", () => {
    const config = getTableConfig(routineSelectionPreferenceFeedbackEvents);
    expect(routineSelectionPreferenceFeedbackKind.enumValues).toEqual([
      "more_often",
      "less_often",
      "reset",
    ]);
    expect(config.foreignKeys.map((constraint) => constraint.getName())).toEqual(
      expect.arrayContaining([
        "routine_select_pref_events_workspace_fk",
        "routine_select_pref_events_routine_fk",
        "routine_select_pref_events_plan_fk",
        "routine_select_pref_events_source_item_fk",
      ]),
    );
    expect(config.checks.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        "routine_select_pref_events_source_valid",
        "routine_select_pref_events_reset_item_null",
        "routine_select_pref_events_version_positive",
      ]),
    );
    expect(config.indexes.map((constraint) => constraint.config.name)).toContain(
      "routine_select_pref_events_planning_idx",
    );
    const migration = readFileSync(
      new URL("../drizzle/0034_majestic_maverick.sql", import.meta.url),
      "utf8",
    );
    expect(migration).toContain(
      'ADD COLUMN "selection_preference_version" integer DEFAULT 0 NOT NULL',
    );
    expect(migration).toContain(
      'CREATE TRIGGER "routine_selection_preference_feedback_events_prevent_change"',
    );
    expect(migration).toContain(
      'ALTER SEQUENCE "routine_selection_preference_feedback_eve_ingested_sequence_seq" RENAME TO "routine_select_pref_events_ingested_sequence_seq"',
    );
    expect(migration).toContain(
      'BEFORE UPDATE OR DELETE ON "routine_selection_preference_feedback_events"',
    );
  });

  it("stores tenant-bound immutable routine-duration insight feedback", () => {
    const config = getTableConfig(routineDurationInsightFeedbackEvents);

    expect(routineDurationInsightFeedbackKind.enumValues).toEqual(["dismissed", "reset"]);
    expect(config.foreignKeys.map((constraint) => constraint.getName())).toEqual(
      expect.arrayContaining([
        "duration_insight_feedback_workspace_fk",
        "duration_insight_feedback_routine_tenant_fk",
      ]),
    );
    expect(
      config.uniqueConstraints
        .find(
          (constraint) =>
            constraint.getName() === "duration_insight_feedback_workspace_idempotency_uq",
        )
        ?.columns.map((column) => column.name),
    ).toEqual(["workspace_id", "idempotency_key"]);
    expect(
      config.indexes
        .find(
          (constraint) => constraint.config.name === "duration_insight_feedback_key_sequence_idx",
        )
        ?.config.columns.map((column) => ({
          name: "name" in column ? column.name : null,
          order: "indexConfig" in column ? column.indexConfig.order : null,
        })),
    ).toEqual([
      { name: "workspace_id", order: "asc" },
      { name: "routine_id", order: "asc" },
      { name: "insight_key", order: "asc" },
      { name: "ingested_sequence", order: "desc" },
      { name: "id", order: "desc" },
    ]);
    expect(config.checks.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        "duration_insight_feedback_key_format",
        "duration_insight_feedback_version_positive",
        "duration_insight_feedback_observed_positive",
        "duration_insight_feedback_suggested_positive",
        "duration_insight_feedback_idempotency_canonical",
        "duration_insight_feedback_sequence_positive",
      ]),
    );
  });

  it("migrates duration-insight feedback as append-only database history", () => {
    const migration = readFileSync(
      new URL("../drizzle/0022_flat_micromacro.sql", import.meta.url),
      "utf8",
    );

    expect(migration).toContain(
      "CREATE TYPE \"public\".\"routine_duration_insight_feedback_kind\" AS ENUM('dismissed', 'reset')",
    );
    expect(migration).toContain(
      'FOREIGN KEY ("workspace_id","routine_id") REFERENCES "public"."routines"("workspace_id","id")',
    );
    expect(migration).toContain(
      '"duration_insight_feedback_workspace_idempotency_uq" UNIQUE("workspace_id","idempotency_key")',
    );
    expect(migration).toContain(
      '"duration_insight_feedback_key_sequence_idx" ON "routine_duration_insight_feedback_events" USING btree ("workspace_id","routine_id","insight_key","ingested_sequence" DESC NULLS LAST,"id" DESC NULLS LAST)',
    );
    expect(migration).toContain(
      'CREATE TRIGGER "routine_duration_insight_feedback_events_prevent_change"',
    );
    expect(migration).toContain(
      'BEFORE UPDATE OR DELETE ON "routine_duration_insight_feedback_events"',
    );
  });

  it("stores and migrates append-only Daily Plan Fit feedback", () => {
    const config = getTableConfig(dailyPlanFitInsightFeedbackEvents);
    expect(dailyPlanFitInsightFeedbackKind.enumValues).toEqual(["dismissed", "reset", "used"]);
    expect(
      config.uniqueConstraints
        .find(
          (constraint) =>
            constraint.getName() === "daily_plan_fit_feedback_workspace_idempotency_uq",
        )
        ?.columns.map((column) => column.name),
    ).toEqual(["workspace_id", "idempotency_key"]);
    expect(config.checks.map((constraint) => constraint.name)).toEqual(
      expect.arrayContaining([
        "daily_plan_fit_feedback_key_format",
        "daily_plan_fit_feedback_sample_positive",
        "daily_plan_fit_feedback_completed_minutes_nonnegative",
        "daily_plan_fit_feedback_completed_tasks_nonnegative",
        "daily_plan_fit_feedback_usage_shape_valid",
        "daily_plan_fit_feedback_applied_minutes_positive",
        "daily_plan_fit_feedback_applied_tasks_positive",
        "daily_plan_fit_feedback_idempotency_canonical",
        "daily_plan_fit_feedback_sequence_positive",
      ]),
    );

    const migration = readFileSync(
      new URL("../drizzle/0030_exotic_the_anarchist.sql", import.meta.url),
      "utf8",
    );
    expect(migration).toContain(
      "CREATE TYPE \"public\".\"daily_plan_fit_insight_feedback_kind\" AS ENUM('dismissed', 'reset')",
    );
    expect(migration).toContain(
      '"daily_plan_fit_feedback_workspace_idempotency_uq" UNIQUE("workspace_id","idempotency_key")',
    );
    expect(migration).toContain(
      'CREATE TRIGGER "daily_plan_fit_insight_feedback_events_prevent_change"',
    );
    expect(migration).toContain(
      'BEFORE UPDATE OR DELETE ON "daily_plan_fit_insight_feedback_events"',
    );

    const usageMigration = readFileSync(
      new URL("../drizzle/0035_zippy_stone_men.sql", import.meta.url),
      "utf8",
    );
    expect(usageMigration).toContain(
      'ALTER TYPE "public"."daily_plan_fit_insight_feedback_kind" ADD VALUE \'used\'',
    );
    expect(usageMigration).toContain(
      'CONSTRAINT "daily_plan_fit_feedback_plan_tenant_fk" FOREIGN KEY ("workspace_id","plan_id")',
    );
    expect(usageMigration).toContain('CREATE UNIQUE INDEX "daily_plan_fit_feedback_used_plan_uq"');
    expect(usageMigration).toContain('CREATE INDEX "daily_plan_fit_feedback_kind_sequence_idx"');
    expect(usageMigration).toContain(
      '"daily_plan_fit_insight_feedback_events"."kind"::text = \'used\'',
    );
  });

  it("migrates dependency edges with tenant isolation and cascading cleanup", () => {
    const migration = readFileSync(
      new URL("../drizzle/0023_little_raza.sql", import.meta.url),
      "utf8",
    );

    expect(migration).toContain(
      'CONSTRAINT "work_item_dependencies_pk" PRIMARY KEY("workspace_id","prerequisite_work_item_id","dependent_work_item_id")',
    );
    expect(migration).toContain(
      'CONSTRAINT "work_item_dependencies_not_self" CHECK ("work_item_dependencies"."prerequisite_work_item_id" <> "work_item_dependencies"."dependent_work_item_id")',
    );
    expect(migration).toContain(
      'CONSTRAINT "work_item_dependencies_prerequisite_tenant_fk" FOREIGN KEY ("workspace_id","prerequisite_work_item_id") REFERENCES "public"."work_items"("workspace_id","id") ON DELETE cascade',
    );
    expect(migration).toContain(
      'CONSTRAINT "work_item_dependencies_dependent_tenant_fk" FOREIGN KEY ("workspace_id","dependent_work_item_id") REFERENCES "public"."work_items"("workspace_id","id") ON DELETE cascade',
    );
    expect(migration).toContain(
      '"work_item_dependencies_list_idx" ON "work_item_dependencies" USING btree ("workspace_id","created_at","prerequisite_work_item_id","dependent_work_item_id")',
    );
  });
});
