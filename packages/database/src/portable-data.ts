/**
 * Versioned boundary for data that may move between independent Schedule installations.
 *
 * The portable archive deliberately contains user-authored product state and durable history,
 * while identity bindings, credentials, delivery queues, and hosted synchronization journals stay
 * local to the environment that created them.
 */
export const portableDataPolicyV1 = {
  revision: 1,
  includedTables: [
    "activity_events",
    "audit_events",
    "daily_plan_fit_insight_feedback_events",
    "daily_plan_heads",
    "daily_plan_item_states",
    "daily_plan_items",
    "daily_plans",
    "natural_language_proposals",
    "notification_profiles",
    "notification_rules",
    "one_off_reminders",
    "plan_interaction_events",
    "plan_mutations",
    "recurrence_series",
    "routine_duration_insight_feedback_events",
    "routine_group_memberships",
    "routine_groups",
    "routine_planning_feedback_events",
    "routine_selection_preference_feedback_events",
    "routines",
    "schedule_blocks",
    "webhook_endpoints",
    "webhook_event_subscriptions",
    "work_item_dependencies",
    "work_items",
    "workspaces",
  ],
  sequences: [
    "activity_events_ingested_sequence_seq",
    "daily_plan_fit_insight_feedback_events_ingested_sequence_seq",
    "plan_interaction_events_ingested_sequence_seq",
    "routine_duration_insight_feedback_events_ingested_sequence_seq",
    "routine_planning_feedback_events_ingested_sequence_seq",
    "routine_select_pref_events_ingested_sequence_seq",
  ],
  excludedTables: [
    { name: "browser_sessions", reason: "environment_identity" },
    { name: "external_identities", reason: "environment_identity" },
    { name: "hosted_login_transactions", reason: "transient_authorization" },
    { name: "hosted_work_item_sync_capability", reason: "environment_sync_state" },
    { name: "hosted_work_item_sync_changes", reason: "environment_sync_state" },
    { name: "hosted_work_item_sync_states", reason: "environment_sync_state" },
    { name: "integration_confirmations", reason: "transient_authorization" },
    { name: "integration_credentials", reason: "credential" },
    { name: "integration_requests", reason: "external_delivery_state" },
    { name: "notification_delivery_attempts", reason: "external_delivery_state" },
    { name: "notification_delivery_commands", reason: "external_delivery_state" },
    { name: "notification_delivery_requests", reason: "external_delivery_state" },
    { name: "notification_intents", reason: "derived_runtime_state" },
    { name: "outbox_events", reason: "external_delivery_state" },
    { name: "users", reason: "environment_identity" },
    { name: "webhook_deliveries", reason: "external_delivery_state" },
    { name: "webhook_endpoint_secrets", reason: "credential" },
    { name: "workspace_memberships", reason: "environment_identity" },
  ],
  normalizations: [
    "reset_hosted_sync_cursors",
    "remove_audit_actor_bindings",
    "cancel_pending_ai_proposals",
    "revoke_webhooks_without_migrated_secrets",
  ],
} as const;

export type PortableDataTableV1 = (typeof portableDataPolicyV1.includedTables)[number];
export type PortableDataExclusionReasonV1 =
  (typeof portableDataPolicyV1.excludedTables)[number]["reason"];
