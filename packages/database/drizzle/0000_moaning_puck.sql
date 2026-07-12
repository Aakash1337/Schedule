CREATE TYPE "public"."outbox_status" AS ENUM('pending', 'processing', 'completed', 'dead_letter');--> statement-breakpoint
CREATE TYPE "public"."work_item_priority" AS ENUM('none', 'low', 'medium', 'high', 'urgent');--> statement-breakpoint
CREATE TYPE "public"."work_item_status" AS ENUM('backlog', 'planned', 'in_progress', 'blocked', 'done', 'cancelled');--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"actor_id" uuid,
	"action" varchar(160) NOT NULL,
	"entity_type" varchar(120) NOT NULL,
	"entity_id" uuid NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid,
	"topic" varchar(160) NOT NULL,
	"payload" jsonb NOT NULL,
	"status" "outbox_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_attempts_nonnegative" CHECK ("outbox_events"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "recurrence_series" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"rule" text NOT NULL,
	"local_start" timestamp NOT NULL,
	"time_zone" varchar(80) NOT NULL,
	"duration_minutes" integer NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recurrence_series_workspace_id_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "recurrence_series_duration_positive" CHECK ("recurrence_series"."duration_minutes" > 0)
);
--> statement-breakpoint
CREATE TABLE "schedule_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"work_item_id" uuid,
	"recurrence_series_id" uuid,
	"title" varchar(240),
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"time_zone" varchar(80) NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schedule_blocks_valid_range" CHECK ("schedule_blocks"."ends_at" > "schedule_blocks"."starts_at"),
	CONSTRAINT "schedule_blocks_version_positive" CHECK ("schedule_blocks"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "work_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"title" varchar(240) NOT NULL,
	"description" text,
	"status" "work_item_status" DEFAULT 'backlog' NOT NULL,
	"priority" "work_item_priority" DEFAULT 'none' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_items_workspace_id_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "work_items_version_positive" CHECK ("work_items"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(160) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recurrence_series" ADD CONSTRAINT "recurrence_series_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_blocks" ADD CONSTRAINT "schedule_blocks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_blocks" ADD CONSTRAINT "schedule_blocks_work_item_tenant_fk" FOREIGN KEY ("workspace_id","work_item_id") REFERENCES "public"."work_items"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedule_blocks" ADD CONSTRAINT "schedule_blocks_recurrence_tenant_fk" FOREIGN KEY ("workspace_id","recurrence_series_id") REFERENCES "public"."recurrence_series"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_workspace_occurred_idx" ON "audit_events" USING btree ("workspace_id","occurred_at");--> statement-breakpoint
CREATE INDEX "outbox_claim_idx" ON "outbox_events" USING btree ("status","available_at");--> statement-breakpoint
CREATE UNIQUE INDEX "schedule_blocks_workspace_id_id_uq" ON "schedule_blocks" USING btree ("workspace_id","id");--> statement-breakpoint
CREATE INDEX "schedule_blocks_workspace_range_idx" ON "schedule_blocks" USING btree ("workspace_id","starts_at","ends_at");--> statement-breakpoint
CREATE INDEX "work_items_workspace_status_idx" ON "work_items" USING btree ("workspace_id","status");