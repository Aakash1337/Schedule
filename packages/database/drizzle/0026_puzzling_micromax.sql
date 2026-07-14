CREATE TYPE "public"."notification_delivery_attempt_outcome" AS ENUM('delivered', 'retryable_failure', 'permanent_failure', 'lease_expired');--> statement-breakpoint
CREATE TYPE "public"."notification_delivery_request_operation" AS ENUM('claim', 'receipt');--> statement-breakpoint
CREATE TYPE "public"."notification_delivery_status" AS ENUM('pending', 'processing', 'delivered', 'dead_letter', 'invalidated');--> statement-breakpoint
CREATE TABLE "notification_delivery_attempts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"delivery_id" uuid NOT NULL,
	"credential_id" uuid NOT NULL,
	"attempt_number" integer NOT NULL,
	"claimed_at" timestamp with time zone NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"outcome" "notification_delivery_attempt_outcome",
	"failure_code" varchar(80),
	"retry_after_seconds" integer,
	"completed_at" timestamp with time zone,
	CONSTRAINT "notification_delivery_attempts_workspace_delivery_number_uq" UNIQUE("workspace_id","delivery_id","attempt_number"),
	CONSTRAINT "notification_delivery_attempts_number_positive" CHECK ("notification_delivery_attempts"."attempt_number" > 0),
	CONSTRAINT "notification_delivery_attempts_lease_after_claim" CHECK ("notification_delivery_attempts"."lease_expires_at" > "notification_delivery_attempts"."claimed_at"),
	CONSTRAINT "notification_delivery_attempts_failure_code_valid" CHECK ("notification_delivery_attempts"."failure_code" IS NULL OR "notification_delivery_attempts"."failure_code" ~ '^[a-z0-9][a-z0-9._-]{0,79}$'),
	CONSTRAINT "notification_delivery_attempts_outcome_valid" CHECK ((
        ("notification_delivery_attempts"."outcome" IS NULL AND "notification_delivery_attempts"."failure_code" IS NULL AND "notification_delivery_attempts"."retry_after_seconds" IS NULL AND "notification_delivery_attempts"."completed_at" IS NULL)
        OR
        ("notification_delivery_attempts"."outcome" IN ('delivered', 'lease_expired') AND "notification_delivery_attempts"."failure_code" IS NULL AND "notification_delivery_attempts"."retry_after_seconds" IS NULL AND "notification_delivery_attempts"."completed_at" IS NOT NULL)
        OR
        ("notification_delivery_attempts"."outcome" = 'retryable_failure' AND "notification_delivery_attempts"."failure_code" IS NOT NULL AND "notification_delivery_attempts"."retry_after_seconds" BETWEEN 0 AND 60 AND "notification_delivery_attempts"."completed_at" IS NOT NULL)
        OR
        ("notification_delivery_attempts"."outcome" = 'permanent_failure' AND "notification_delivery_attempts"."failure_code" IS NOT NULL AND "notification_delivery_attempts"."retry_after_seconds" IS NULL AND "notification_delivery_attempts"."completed_at" IS NOT NULL)
      )),
	CONSTRAINT "notification_delivery_attempts_completion_after_claim" CHECK ("notification_delivery_attempts"."completed_at" IS NULL OR "notification_delivery_attempts"."completed_at" >= "notification_delivery_attempts"."claimed_at")
);
--> statement-breakpoint
CREATE TABLE "notification_delivery_commands" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"intent_id" uuid NOT NULL,
	"occurrence_key" varchar(200) NOT NULL,
	"kind" "notification_kind" NOT NULL,
	"target_type" "notification_target_type" NOT NULL,
	"title_snapshot" varchar(240),
	"scheduled_for" timestamp with time zone NOT NULL,
	"local_date" date NOT NULL,
	"priority" integer NOT NULL,
	"status" "notification_delivery_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone NOT NULL,
	"current_claim_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"last_failure_code" varchar(80),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_delivery_commands_workspace_id_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "notification_delivery_commands_workspace_intent_uq" UNIQUE("workspace_id","intent_id"),
	CONSTRAINT "notification_delivery_commands_workspace_occurrence_uq" UNIQUE("workspace_id","occurrence_key"),
	CONSTRAINT "notification_delivery_commands_occurrence_nonempty" CHECK (char_length(btrim("notification_delivery_commands"."occurrence_key")) > 0),
	CONSTRAINT "notification_delivery_commands_priority_range" CHECK ("notification_delivery_commands"."priority" BETWEEN 0 AND 100),
	CONSTRAINT "notification_delivery_commands_attempts_nonnegative" CHECK ("notification_delivery_commands"."attempts" >= 0),
	CONSTRAINT "notification_delivery_commands_failure_code_valid" CHECK ("notification_delivery_commands"."last_failure_code" IS NULL OR "notification_delivery_commands"."last_failure_code" ~ '^[a-z0-9][a-z0-9._-]{0,79}$'),
	CONSTRAINT "notification_delivery_commands_state_valid" CHECK ((
        ("notification_delivery_commands"."status" = 'pending' AND "notification_delivery_commands"."current_claim_token" IS NULL AND "notification_delivery_commands"."lease_expires_at" IS NULL AND "notification_delivery_commands"."completed_at" IS NULL)
        OR
        ("notification_delivery_commands"."status" = 'processing' AND "notification_delivery_commands"."current_claim_token" IS NOT NULL AND "notification_delivery_commands"."lease_expires_at" IS NOT NULL AND "notification_delivery_commands"."completed_at" IS NULL)
        OR
        ("notification_delivery_commands"."status" IN ('delivered', 'dead_letter') AND "notification_delivery_commands"."current_claim_token" IS NULL AND "notification_delivery_commands"."lease_expires_at" IS NULL AND "notification_delivery_commands"."completed_at" IS NOT NULL)
        OR
        ("notification_delivery_commands"."status" = 'invalidated' AND "notification_delivery_commands"."completed_at" IS NOT NULL AND (("notification_delivery_commands"."current_claim_token" IS NULL AND "notification_delivery_commands"."lease_expires_at" IS NULL) OR ("notification_delivery_commands"."current_claim_token" IS NOT NULL AND "notification_delivery_commands"."lease_expires_at" IS NOT NULL)))
      )),
	CONSTRAINT "notification_delivery_commands_timestamps_valid" CHECK ("notification_delivery_commands"."updated_at" >= "notification_delivery_commands"."created_at" AND ("notification_delivery_commands"."completed_at" IS NULL OR "notification_delivery_commands"."completed_at" >= "notification_delivery_commands"."created_at"))
);
--> statement-breakpoint
CREATE TABLE "notification_delivery_requests" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"credential_id" uuid NOT NULL,
	"idempotency_key" varchar(160) NOT NULL,
	"operation" "notification_delivery_request_operation" NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"status" "integration_request_status" DEFAULT 'processing' NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "notification_delivery_requests_credential_key_uq" UNIQUE("credential_id","idempotency_key"),
	CONSTRAINT "notification_delivery_requests_key_nonempty" CHECK (char_length(btrim("notification_delivery_requests"."idempotency_key")) > 0),
	CONSTRAINT "notification_delivery_requests_hash_valid" CHECK ("notification_delivery_requests"."request_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "notification_delivery_requests_result_bounded" CHECK ("notification_delivery_requests"."result" IS NULL OR (jsonb_typeof("notification_delivery_requests"."result") = 'object' AND octet_length("notification_delivery_requests"."result"::text) <= 16384)),
	CONSTRAINT "notification_delivery_requests_state_valid" CHECK ((
        ("notification_delivery_requests"."status" = 'processing' AND "notification_delivery_requests"."result" IS NULL AND "notification_delivery_requests"."completed_at" IS NULL)
        OR
        ("notification_delivery_requests"."status" = 'succeeded' AND "notification_delivery_requests"."result" IS NOT NULL AND "notification_delivery_requests"."completed_at" IS NOT NULL)
      )),
	CONSTRAINT "notification_delivery_requests_timestamps_valid" CHECK ("notification_delivery_requests"."updated_at" >= "notification_delivery_requests"."created_at" AND ("notification_delivery_requests"."completed_at" IS NULL OR "notification_delivery_requests"."completed_at" >= "notification_delivery_requests"."created_at"))
);
--> statement-breakpoint
ALTER TABLE "integration_credentials" DROP CONSTRAINT "integration_credentials_scopes_allowed";--> statement-breakpoint
ALTER TABLE "integration_credentials" DROP CONSTRAINT "integration_credentials_scopes_unique";--> statement-breakpoint
ALTER TABLE "notification_delivery_attempts" ADD CONSTRAINT "notification_delivery_attempts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_delivery_attempts" ADD CONSTRAINT "notification_delivery_attempts_command_tenant_fk" FOREIGN KEY ("workspace_id","delivery_id") REFERENCES "public"."notification_delivery_commands"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_delivery_attempts" ADD CONSTRAINT "notification_delivery_attempts_credential_tenant_fk" FOREIGN KEY ("workspace_id","credential_id") REFERENCES "public"."integration_credentials"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_delivery_commands" ADD CONSTRAINT "notification_delivery_commands_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_delivery_requests" ADD CONSTRAINT "notification_delivery_requests_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_delivery_requests" ADD CONSTRAINT "notification_delivery_requests_credential_tenant_fk" FOREIGN KEY ("workspace_id","credential_id") REFERENCES "public"."integration_credentials"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_delivery_attempts_workspace_claimed_idx" ON "notification_delivery_attempts" USING btree ("workspace_id","claimed_at","id");--> statement-breakpoint
CREATE INDEX "notification_delivery_commands_claim_idx" ON "notification_delivery_commands" USING btree ("workspace_id","status","available_at","scheduled_for");--> statement-breakpoint
CREATE INDEX "notification_delivery_commands_recovery_idx" ON "notification_delivery_commands" USING btree ("workspace_id","lease_expires_at","id") WHERE "notification_delivery_commands"."status" IN ('processing', 'invalidated') AND "notification_delivery_commands"."lease_expires_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "notification_delivery_requests_workspace_created_idx" ON "notification_delivery_requests" USING btree ("workspace_id","created_at","id");--> statement-breakpoint
ALTER TABLE "integration_credentials" ADD CONSTRAINT "integration_credentials_scopes_allowed" CHECK ("integration_credentials"."scopes" <@ ARRAY['schedule:read', 'schedule:write', 'schedule:delivery']::text[]);--> statement-breakpoint
ALTER TABLE "integration_credentials" ADD CONSTRAINT "integration_credentials_scopes_unique" CHECK (cardinality("integration_credentials"."scopes") = (CASE WHEN 'schedule:read' = ANY("integration_credentials"."scopes") THEN 1 ELSE 0 END + CASE WHEN 'schedule:write' = ANY("integration_credentials"."scopes") THEN 1 ELSE 0 END + CASE WHEN 'schedule:delivery' = ANY("integration_credentials"."scopes") THEN 1 ELSE 0 END));