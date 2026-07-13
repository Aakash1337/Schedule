import { readFileSync } from "node:fs";

import { getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  activityEvents,
  dailyPlanHeads,
  dailyPlanItemStates,
  dailyPlanItems,
  dailyPlans,
  integrationConfirmations,
  integrationCredentials,
  integrationRequests,
  outboxEvents,
  planInteractionEvents,
  planMutationKind,
  planMutations,
  routineDurationInsightFeedbackEvents,
  routineDurationInsightFeedbackKind,
  routinePlanningFeedbackEvents,
  routinePlanningFeedbackKind,
  routines,
  scheduleBlocks,
  workItems,
  workspaces,
  webhookDeliveries,
  webhookEndpointSecrets,
  webhookEndpoints,
  webhookEventSubscriptions,
} from "./schema.js";

describe("database schema", () => {
  it("uses stable table names for core infrastructure", () => {
    expect(getTableName(workspaces)).toBe("workspaces");
    expect(getTableName(workItems)).toBe("work_items");
    expect(getTableName(scheduleBlocks)).toBe("schedule_blocks");
    expect(getTableName(outboxEvents)).toBe("outbox_events");
    expect(getTableName(routines)).toBe("routines");
    expect(getTableName(activityEvents)).toBe("activity_events");
    expect(getTableName(dailyPlans)).toBe("daily_plans");
    expect(getTableName(dailyPlanItems)).toBe("daily_plan_items");
    expect(getTableName(dailyPlanHeads)).toBe("daily_plan_heads");
    expect(getTableName(dailyPlanItemStates)).toBe("daily_plan_item_states");
    expect(getTableName(planInteractionEvents)).toBe("plan_interaction_events");
    expect(getTableName(planMutations)).toBe("plan_mutations");
    expect(getTableName(routineDurationInsightFeedbackEvents)).toBe(
      "routine_duration_insight_feedback_events",
    );
    expect(getTableName(routinePlanningFeedbackEvents)).toBe("routine_planning_feedback_events");
    expect(getTableName(integrationCredentials)).toBe("integration_credentials");
    expect(getTableName(integrationConfirmations)).toBe("integration_confirmations");
    expect(getTableName(integrationRequests)).toBe("integration_requests");
    expect(getTableName(webhookEndpoints)).toBe("webhook_endpoints");
    expect(getTableName(webhookEndpointSecrets)).toBe("webhook_endpoint_secrets");
    expect(getTableName(webhookDeliveries)).toBe("webhook_deliveries");
    expect(getTableName(webhookEventSubscriptions)).toBe("webhook_event_subscriptions");
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

  it("stores tenant-bound immutable routine planning feedback with strict horizon policy", () => {
    const config = getTableConfig(routinePlanningFeedbackEvents);

    expect(routinePlanningFeedbackKind.enumValues).toEqual(["not_today", "not_this_week", "reset"]);
    expect(planMutationKind.enumValues).toEqual([
      "regenerate",
      "replace",
      "feedback",
      "feedback_reset",
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
});
