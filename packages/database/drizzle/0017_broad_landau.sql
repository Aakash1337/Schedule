CREATE TYPE "public"."integration_request_status" AS ENUM('processing', 'succeeded');--> statement-breakpoint
CREATE TABLE "integration_confirmations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"credential_id" uuid NOT NULL,
	"request_id" varchar(160) NOT NULL,
	"command_hash" varchar(64) NOT NULL,
	"command_kind" varchar(160) NOT NULL,
	"command" jsonb NOT NULL,
	"summary" varchar(500) NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_confirmations_tenant_credential_id_uq" UNIQUE("workspace_id","credential_id","id"),
	CONSTRAINT "integration_confirmations_command_binding_uq" UNIQUE("workspace_id","credential_id","id","command_kind","command_hash"),
	CONSTRAINT "integration_confirmations_credential_request_uq" UNIQUE("credential_id","request_id"),
	CONSTRAINT "integration_confirmations_request_id_nonempty" CHECK (char_length(trim("integration_confirmations"."request_id")) > 0),
	CONSTRAINT "integration_confirmations_command_hash_length" CHECK (char_length("integration_confirmations"."command_hash") = 64),
	CONSTRAINT "integration_confirmations_command_kind_nonempty" CHECK (char_length(trim("integration_confirmations"."command_kind")) > 0),
	CONSTRAINT "integration_confirmations_command_binding_valid" CHECK (jsonb_typeof("integration_confirmations"."command") = 'object' AND "integration_confirmations"."command"->>'type' = "integration_confirmations"."command_kind"),
	CONSTRAINT "integration_confirmations_summary_nonempty" CHECK (char_length(trim("integration_confirmations"."summary")) > 0),
	CONSTRAINT "integration_confirmations_expiry_after_creation" CHECK ("integration_confirmations"."expires_at" > "integration_confirmations"."created_at"),
	CONSTRAINT "integration_confirmations_consumption_after_creation" CHECK ("integration_confirmations"."consumed_at" IS NULL OR "integration_confirmations"."consumed_at" >= "integration_confirmations"."created_at"),
	CONSTRAINT "integration_confirmations_updated_after_creation" CHECK ("integration_confirmations"."updated_at" >= "integration_confirmations"."created_at")
);
--> statement-breakpoint
CREATE TABLE "integration_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" varchar(160) NOT NULL,
	"secret_digest" varchar(64) NOT NULL,
	"scopes" text[] NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_credentials_workspace_id_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "integration_credentials_name_nonempty" CHECK (char_length(trim("integration_credentials"."name")) > 0),
	CONSTRAINT "integration_credentials_secret_digest_length" CHECK (char_length("integration_credentials"."secret_digest") = 64),
	CONSTRAINT "integration_credentials_secret_digest_format" CHECK ("integration_credentials"."secret_digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "integration_credentials_scopes_nonempty" CHECK (cardinality("integration_credentials"."scopes") > 0),
	CONSTRAINT "integration_credentials_scopes_allowed" CHECK ("integration_credentials"."scopes" <@ ARRAY['schedule:read', 'schedule:write']::text[]),
	CONSTRAINT "integration_credentials_scopes_unique" CHECK (cardinality("integration_credentials"."scopes") = (CASE WHEN 'schedule:read' = ANY("integration_credentials"."scopes") THEN 1 ELSE 0 END + CASE WHEN 'schedule:write' = ANY("integration_credentials"."scopes") THEN 1 ELSE 0 END)),
	CONSTRAINT "integration_credentials_scopes_one_dimensional" CHECK (array_ndims("integration_credentials"."scopes") = 1 AND array_lower("integration_credentials"."scopes", 1) = 1),
	CONSTRAINT "integration_credentials_scopes_no_empty" CHECK (array_position("integration_credentials"."scopes", '') IS NULL),
	CONSTRAINT "integration_credentials_revocation_consistent" CHECK (("integration_credentials"."active" AND "integration_credentials"."revoked_at" IS NULL) OR (NOT "integration_credentials"."active" AND "integration_credentials"."revoked_at" IS NOT NULL)),
	CONSTRAINT "integration_credentials_expiry_after_creation" CHECK ("integration_credentials"."expires_at" IS NULL OR "integration_credentials"."expires_at" > "integration_credentials"."created_at"),
	CONSTRAINT "integration_credentials_revocation_after_creation" CHECK ("integration_credentials"."revoked_at" IS NULL OR "integration_credentials"."revoked_at" >= "integration_credentials"."created_at"),
	CONSTRAINT "integration_credentials_updated_after_creation" CHECK ("integration_credentials"."updated_at" >= "integration_credentials"."created_at"),
	CONSTRAINT "integration_credentials_version_positive" CHECK ("integration_credentials"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "integration_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"credential_id" uuid NOT NULL,
	"idempotency_key" varchar(160) NOT NULL,
	"confirmation_id" uuid NOT NULL,
	"command_hash" varchar(64) NOT NULL,
	"operation" varchar(160) NOT NULL,
	"status" "integration_request_status" DEFAULT 'processing' NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_requests_credential_idempotency_uq" UNIQUE("credential_id","idempotency_key"),
	CONSTRAINT "integration_requests_idempotency_key_nonempty" CHECK (char_length(trim("integration_requests"."idempotency_key")) > 0),
	CONSTRAINT "integration_requests_command_hash_length" CHECK (char_length("integration_requests"."command_hash") = 64),
	CONSTRAINT "integration_requests_operation_nonempty" CHECK (char_length(trim("integration_requests"."operation")) > 0),
	CONSTRAINT "integration_requests_status_result_consistent" CHECK (("integration_requests"."status" = 'processing' AND "integration_requests"."result" IS NULL AND "integration_requests"."completed_at" IS NULL) OR ("integration_requests"."status" = 'succeeded' AND jsonb_typeof("integration_requests"."result") = 'object' AND "integration_requests"."result"->>'confirmationId' = "integration_requests"."confirmation_id"::text AND "integration_requests"."result"->>'operation' = "integration_requests"."operation" AND "integration_requests"."result"->>'commandHash' = "integration_requests"."command_hash" AND "integration_requests"."completed_at" IS NOT NULL)),
	CONSTRAINT "integration_requests_completion_after_creation" CHECK ("integration_requests"."completed_at" IS NULL OR "integration_requests"."completed_at" >= "integration_requests"."created_at"),
	CONSTRAINT "integration_requests_updated_after_creation" CHECK ("integration_requests"."updated_at" >= "integration_requests"."created_at")
);
--> statement-breakpoint
ALTER TABLE "integration_confirmations" ADD CONSTRAINT "integration_confirmations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_confirmations" ADD CONSTRAINT "integration_confirmations_credential_tenant_fk" FOREIGN KEY ("workspace_id","credential_id") REFERENCES "public"."integration_credentials"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_credentials" ADD CONSTRAINT "integration_credentials_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_requests" ADD CONSTRAINT "integration_requests_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_requests" ADD CONSTRAINT "integration_requests_credential_tenant_fk" FOREIGN KEY ("workspace_id","credential_id") REFERENCES "public"."integration_credentials"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_requests" ADD CONSTRAINT "integration_requests_confirmation_tenant_fk" FOREIGN KEY ("workspace_id","credential_id","confirmation_id","operation","command_hash") REFERENCES "public"."integration_confirmations"("workspace_id","credential_id","id","command_kind","command_hash") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "integration_confirmations_workspace_expiry_idx" ON "integration_confirmations" USING btree ("workspace_id","expires_at");--> statement-breakpoint
CREATE INDEX "integration_confirmations_credential_expiry_idx" ON "integration_confirmations" USING btree ("credential_id","expires_at","consumed_at");--> statement-breakpoint
CREATE INDEX "integration_credentials_workspace_active_idx" ON "integration_credentials" USING btree ("workspace_id","active","expires_at");--> statement-breakpoint
CREATE INDEX "integration_requests_workspace_created_idx" ON "integration_requests" USING btree ("workspace_id","created_at","id");--> statement-breakpoint
CREATE INDEX "integration_requests_credential_status_idx" ON "integration_requests" USING btree ("credential_id","status");