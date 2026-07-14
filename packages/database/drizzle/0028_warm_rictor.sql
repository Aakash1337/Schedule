CREATE TYPE "public"."natural_language_proposal_status" AS ENUM('pending', 'confirmed', 'cancelled');--> statement-breakpoint
CREATE TABLE "natural_language_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"request_id" uuid NOT NULL,
	"prompt_hash" varchar(64) NOT NULL,
	"command_hash" varchar(64) NOT NULL,
	"command_display" text NOT NULL,
	"command" jsonb NOT NULL,
	"provider" varchar(40) NOT NULL,
	"model" varchar(120),
	"status" "natural_language_proposal_status" DEFAULT 'pending' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"confirmation_key_hash" varchar(64),
	"result_work_item_id" uuid,
	"confirmed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "natural_language_proposals_workspace_request_uq" UNIQUE("workspace_id","request_id"),
	CONSTRAINT "natural_language_proposals_version_positive" CHECK ("natural_language_proposals"."version" > 0),
	CONSTRAINT "natural_language_proposals_prompt_hash_valid" CHECK ("natural_language_proposals"."prompt_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "natural_language_proposals_command_hash_valid" CHECK ("natural_language_proposals"."command_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "natural_language_proposals_confirmation_hash_valid" CHECK ("natural_language_proposals"."confirmation_key_hash" IS NULL OR "natural_language_proposals"."confirmation_key_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "natural_language_proposals_command_display_bounded" CHECK (char_length("natural_language_proposals"."command_display") BETWEEN 1 AND 1000),
	CONSTRAINT "natural_language_proposals_expiry_after_creation" CHECK ("natural_language_proposals"."expires_at" >= "natural_language_proposals"."created_at" + interval '1 minute' AND "natural_language_proposals"."expires_at" <= "natural_language_proposals"."created_at" + interval '1 hour'),
	CONSTRAINT "natural_language_proposals_updated_after_creation" CHECK ("natural_language_proposals"."updated_at" >= "natural_language_proposals"."created_at"),
	CONSTRAINT "natural_language_proposals_lifecycle_valid" CHECK ((
        ("natural_language_proposals"."status" = 'pending' AND "natural_language_proposals"."confirmation_key_hash" IS NULL AND "natural_language_proposals"."result_work_item_id" IS NULL AND "natural_language_proposals"."confirmed_at" IS NULL AND "natural_language_proposals"."cancelled_at" IS NULL)
        OR
        ("natural_language_proposals"."status" = 'confirmed' AND "natural_language_proposals"."confirmation_key_hash" IS NOT NULL AND "natural_language_proposals"."result_work_item_id" IS NOT NULL AND "natural_language_proposals"."confirmed_at" IS NOT NULL AND "natural_language_proposals"."cancelled_at" IS NULL)
        OR
        ("natural_language_proposals"."status" = 'cancelled' AND "natural_language_proposals"."confirmation_key_hash" IS NULL AND "natural_language_proposals"."result_work_item_id" IS NULL AND "natural_language_proposals"."confirmed_at" IS NULL AND "natural_language_proposals"."cancelled_at" IS NOT NULL)
      )),
	CONSTRAINT "natural_language_proposals_terminal_time_valid" CHECK (("natural_language_proposals"."confirmed_at" IS NULL OR ("natural_language_proposals"."confirmed_at" >= "natural_language_proposals"."created_at" AND "natural_language_proposals"."confirmed_at" <= "natural_language_proposals"."expires_at")) AND ("natural_language_proposals"."cancelled_at" IS NULL OR ("natural_language_proposals"."cancelled_at" >= "natural_language_proposals"."created_at" AND "natural_language_proposals"."cancelled_at" <= "natural_language_proposals"."expires_at")))
);
--> statement-breakpoint
ALTER TABLE "natural_language_proposals" ADD CONSTRAINT "natural_language_proposals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "natural_language_proposals" ADD CONSTRAINT "natural_language_proposals_result_work_item_tenant_fk" FOREIGN KEY ("workspace_id","result_work_item_id") REFERENCES "public"."work_items"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "natural_language_proposals_workspace_status_created_idx" ON "natural_language_proposals" USING btree ("workspace_id","status","created_at","id");--> statement-breakpoint
CREATE INDEX "natural_language_proposals_workspace_expiry_idx" ON "natural_language_proposals" USING btree ("workspace_id","expires_at","id");