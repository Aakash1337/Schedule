CREATE TYPE "public"."activity_event_type" AS ENUM('suggested', 'accepted', 'started', 'completed', 'skipped', 'deferred', 'dismissed', 'duration_corrected', 'completion_reversed');--> statement-breakpoint
CREATE TYPE "public"."cadence_period" AS ENUM('day', 'week', 'month', 'rolling_days');--> statement-breakpoint
CREATE TYPE "public"."daily_plan_status" AS ENUM('generated', 'accepted', 'superseded', 'discarded');--> statement-breakpoint
CREATE TYPE "public"."routine_effort" AS ENUM('quick', 'short', 'medium', 'deep');--> statement-breakpoint
CREATE TYPE "public"."routine_energy" AS ENUM('low', 'normal', 'high');--> statement-breakpoint
CREATE TYPE "public"."routine_preference" AS ENUM('enjoyable', 'neutral', 'unpleasant');--> statement-breakpoint
CREATE TYPE "public"."routine_priority" AS ENUM('low', 'medium', 'high', 'critical');--> statement-breakpoint
CREATE TYPE "public"."routine_status" AS ENUM('active', 'paused', 'archived');--> statement-breakpoint
CREATE TABLE "activity_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"routine_id" uuid NOT NULL,
	"plan_id" uuid,
	"type" "activity_event_type" NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"local_date" date NOT NULL,
	"time_zone" varchar(80) NOT NULL,
	"duration_minutes" integer,
	"reason" varchar(500),
	"reference_event_id" uuid,
	"idempotency_key" varchar(160) NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activity_events_workspace_id_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "activity_events_workspace_routine_id_id_uq" UNIQUE("workspace_id","routine_id","id"),
	CONSTRAINT "activity_events_workspace_idempotency_uq" UNIQUE("workspace_id","idempotency_key"),
	CONSTRAINT "activity_events_duration_positive" CHECK ("activity_events"."duration_minutes" IS NULL OR "activity_events"."duration_minutes" > 0),
	CONSTRAINT "activity_events_reference_policy" CHECK (("activity_events"."type" = 'duration_corrected' AND "activity_events"."reference_event_id" IS NOT NULL AND "activity_events"."duration_minutes" IS NOT NULL) OR ("activity_events"."type" = 'completion_reversed' AND "activity_events"."reference_event_id" IS NOT NULL AND "activity_events"."duration_minutes" IS NULL) OR ("activity_events"."type" NOT IN ('duration_corrected', 'completion_reversed')))
);
--> statement-breakpoint
CREATE TABLE "daily_plan_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"routine_id" uuid NOT NULL,
	"title_snapshot" varchar(240) NOT NULL,
	"position" integer NOT NULL,
	"window_index" integer NOT NULL,
	"scheduled_minutes" integer NOT NULL,
	"partial_session" boolean DEFAULT false NOT NULL,
	"score" integer NOT NULL,
	"score_components" jsonb NOT NULL,
	"reasons" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_plan_items_workspace_id_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "daily_plan_items_plan_position_uq" UNIQUE("workspace_id","plan_id","position"),
	CONSTRAINT "daily_plan_items_plan_routine_uq" UNIQUE("workspace_id","plan_id","routine_id"),
	CONSTRAINT "daily_plan_items_position_nonnegative" CHECK ("daily_plan_items"."position" >= 0),
	CONSTRAINT "daily_plan_items_window_nonnegative" CHECK ("daily_plan_items"."window_index" >= 0),
	CONSTRAINT "daily_plan_items_duration_positive" CHECK ("daily_plan_items"."scheduled_minutes" > 0)
);
--> statement-breakpoint
CREATE TABLE "daily_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"local_date" date NOT NULL,
	"time_zone" varchar(80) NOT NULL,
	"status" "daily_plan_status" DEFAULT 'generated' NOT NULL,
	"request_revision" integer NOT NULL,
	"algorithm_version" varchar(120) NOT NULL,
	"config_version" varchar(120) NOT NULL,
	"prng_version" varchar(120) NOT NULL,
	"seed" varchar(240) NOT NULL,
	"input_hash" varchar(64) NOT NULL,
	"input_snapshot" jsonb NOT NULL,
	"total_minutes" integer NOT NULL,
	"fitness" integer NOT NULL,
	"warnings" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"generated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_plans_workspace_id_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "daily_plans_workspace_date_revision_uq" UNIQUE("workspace_id","local_date","request_revision"),
	CONSTRAINT "daily_plans_revision_positive" CHECK ("daily_plans"."request_revision" > 0),
	CONSTRAINT "daily_plans_minutes_nonnegative" CHECK ("daily_plans"."total_minutes" >= 0),
	CONSTRAINT "daily_plans_input_hash_length" CHECK (char_length("daily_plans"."input_hash") = 64)
);
--> statement-breakpoint
CREATE TABLE "routines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"title" varchar(240) NOT NULL,
	"description" text,
	"status" "routine_status" DEFAULT 'active' NOT NULL,
	"priority" "routine_priority" DEFAULT 'medium' NOT NULL,
	"effort" "routine_effort" DEFAULT 'medium' NOT NULL,
	"energy" "routine_energy" DEFAULT 'normal' NOT NULL,
	"preference" "routine_preference" DEFAULT 'neutral' NOT NULL,
	"contexts" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"categories" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"free_form_tags" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"minimum_duration_minutes" integer NOT NULL,
	"expected_duration_minutes" integer NOT NULL,
	"maximum_duration_minutes" integer NOT NULL,
	"splittable" boolean DEFAULT false NOT NULL,
	"minimum_session_minutes" integer,
	"overhead_minutes" integer DEFAULT 0 NOT NULL,
	"cadence_period" "cadence_period" NOT NULL,
	"rolling_interval_days" integer,
	"target_completions" integer NOT NULL,
	"minimum_completions" integer,
	"maximum_completions" integer,
	"minimum_spacing_days" integer DEFAULT 0 NOT NULL,
	"preferred_weekdays" integer[] DEFAULT ARRAY[]::integer[] NOT NULL,
	"excluded_weekdays" integer[] DEFAULT ARRAY[]::integer[] NOT NULL,
	"discourage_consecutive_days" boolean DEFAULT false NOT NULL,
	"prohibit_consecutive_days" boolean DEFAULT false NOT NULL,
	"week_starts_on" integer DEFAULT 1 NOT NULL,
	"starts_on" date,
	"paused_until" date,
	"ends_on" date,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "routines_workspace_id_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "routines_duration_range_valid" CHECK ("routines"."minimum_duration_minutes" > 0 AND "routines"."minimum_duration_minutes" <= "routines"."expected_duration_minutes" AND "routines"."expected_duration_minutes" <= "routines"."maximum_duration_minutes"),
	CONSTRAINT "routines_overhead_nonnegative" CHECK ("routines"."overhead_minutes" >= 0),
	CONSTRAINT "routines_split_policy_valid" CHECK (("routines"."splittable" AND "routines"."minimum_session_minutes" IS NOT NULL AND "routines"."minimum_session_minutes" > 0 AND "routines"."minimum_session_minutes" <= "routines"."minimum_duration_minutes") OR (NOT "routines"."splittable" AND "routines"."minimum_session_minutes" IS NULL)),
	CONSTRAINT "routines_cadence_counts_valid" CHECK ("routines"."target_completions" > 0 AND ("routines"."minimum_completions" IS NULL OR ("routines"."minimum_completions" > 0 AND "routines"."minimum_completions" <= "routines"."target_completions")) AND ("routines"."maximum_completions" IS NULL OR "routines"."maximum_completions" >= "routines"."target_completions")),
	CONSTRAINT "routines_rolling_interval_valid" CHECK (("routines"."cadence_period" = 'rolling_days' AND "routines"."rolling_interval_days" IS NOT NULL AND "routines"."rolling_interval_days" > 0) OR ("routines"."cadence_period" <> 'rolling_days' AND "routines"."rolling_interval_days" IS NULL)),
	CONSTRAINT "routines_spacing_nonnegative" CHECK ("routines"."minimum_spacing_days" >= 0),
	CONSTRAINT "routines_week_start_valid" CHECK ("routines"."week_starts_on" BETWEEN 0 AND 6),
	CONSTRAINT "routines_consecutive_policy_valid" CHECK (NOT "routines"."prohibit_consecutive_days" OR "routines"."discourage_consecutive_days"),
	CONSTRAINT "routines_date_range_valid" CHECK ("routines"."starts_on" IS NULL OR "routines"."ends_on" IS NULL OR "routines"."starts_on" <= "routines"."ends_on"),
	CONSTRAINT "routines_version_positive" CHECK ("routines"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "schedule_blocks" DROP CONSTRAINT "schedule_blocks_work_item_tenant_fk";
--> statement-breakpoint
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_routine_tenant_fk" FOREIGN KEY ("workspace_id","routine_id") REFERENCES "public"."routines"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_plan_tenant_fk" FOREIGN KEY ("workspace_id","plan_id") REFERENCES "public"."daily_plans"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_reference_tenant_fk" FOREIGN KEY ("workspace_id","routine_id","reference_event_id") REFERENCES "public"."activity_events"("workspace_id","routine_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_plan_items" ADD CONSTRAINT "daily_plan_items_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_plan_items" ADD CONSTRAINT "daily_plan_items_plan_tenant_fk" FOREIGN KEY ("workspace_id","plan_id") REFERENCES "public"."daily_plans"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_plan_items" ADD CONSTRAINT "daily_plan_items_routine_tenant_fk" FOREIGN KEY ("workspace_id","routine_id") REFERENCES "public"."routines"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_plans" ADD CONSTRAINT "daily_plans_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_events_routine_occurred_idx" ON "activity_events" USING btree ("workspace_id","routine_id","occurred_at");--> statement-breakpoint
CREATE INDEX "activity_events_workspace_local_date_idx" ON "activity_events" USING btree ("workspace_id","local_date");--> statement-breakpoint
CREATE INDEX "daily_plans_workspace_date_idx" ON "daily_plans" USING btree ("workspace_id","local_date");--> statement-breakpoint
CREATE INDEX "routines_workspace_status_idx" ON "routines" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "routines_workspace_cadence_idx" ON "routines" USING btree ("workspace_id","cadence_period");--> statement-breakpoint
ALTER TABLE "schedule_blocks" ADD CONSTRAINT "schedule_blocks_work_item_tenant_fk" FOREIGN KEY ("workspace_id","work_item_id") REFERENCES "public"."work_items"("workspace_id","id") ON DELETE restrict ON UPDATE no action;