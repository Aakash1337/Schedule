CREATE TYPE "public"."notification_kind" AS ENUM('daily_digest', 'daily_follow_up', 'plan_window_open', 'schedule_block_lead', 'work_item_due', 'one_off');--> statement-breakpoint
CREATE TYPE "public"."notification_local_time_resolution" AS ENUM('exact', 'gap_later', 'overlap_earlier');--> statement-breakpoint
CREATE TYPE "public"."notification_quiet_hours_policy" AS ENUM('skip', 'next_allowed');--> statement-breakpoint
CREATE TYPE "public"."notification_rule_kind" AS ENUM('daily_digest', 'daily_follow_up', 'plan_window_open', 'schedule_block_lead', 'work_item_due');--> statement-breakpoint
CREATE TYPE "public"."notification_target_type" AS ENUM('workspace', 'daily_plan', 'schedule_block', 'work_item', 'one_off');--> statement-breakpoint
CREATE TABLE "notification_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"rule_id" uuid,
	"rule_kind" "notification_rule_kind",
	"one_off_reminder_id" uuid,
	"kind" "notification_kind" NOT NULL,
	"occurrence_key" varchar(200) NOT NULL,
	"target_type" "notification_target_type" NOT NULL,
	"daily_plan_id" uuid,
	"schedule_block_id" uuid,
	"work_item_id" uuid,
	"title_snapshot" varchar(240),
	"scheduled_for" timestamp with time zone NOT NULL,
	"local_date" date NOT NULL,
	"priority" integer NOT NULL,
	"policy_snapshot" jsonb NOT NULL,
	"local_time_resolution" "notification_local_time_resolution" NOT NULL,
	"adjusted_for_quiet_hours" boolean DEFAULT false NOT NULL,
	"caught_up" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_intents_workspace_id_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "notification_intents_workspace_occurrence_uq" UNIQUE("workspace_id","occurrence_key"),
	CONSTRAINT "notification_intents_source_valid" CHECK ((
        ("notification_intents"."kind" = 'one_off' AND "notification_intents"."rule_id" IS NULL AND "notification_intents"."rule_kind" IS NULL AND "notification_intents"."one_off_reminder_id" IS NOT NULL)
        OR
        ("notification_intents"."kind" <> 'one_off' AND "notification_intents"."rule_id" IS NOT NULL AND "notification_intents"."rule_kind" IS NOT NULL AND "notification_intents"."kind"::text = "notification_intents"."rule_kind"::text AND "notification_intents"."one_off_reminder_id" IS NULL)
      )),
	CONSTRAINT "notification_intents_target_valid" CHECK ((
        ("notification_intents"."kind" = 'daily_digest' AND "notification_intents"."target_type" = 'workspace' AND "notification_intents"."daily_plan_id" IS NULL AND "notification_intents"."schedule_block_id" IS NULL AND "notification_intents"."work_item_id" IS NULL)
        OR
        ("notification_intents"."kind" IN ('daily_follow_up', 'plan_window_open') AND "notification_intents"."target_type" = 'daily_plan' AND "notification_intents"."daily_plan_id" IS NOT NULL AND "notification_intents"."schedule_block_id" IS NULL AND "notification_intents"."work_item_id" IS NULL)
        OR
        ("notification_intents"."kind" = 'schedule_block_lead' AND "notification_intents"."target_type" = 'schedule_block' AND "notification_intents"."daily_plan_id" IS NULL AND "notification_intents"."schedule_block_id" IS NOT NULL AND "notification_intents"."work_item_id" IS NULL)
        OR
        ("notification_intents"."kind" = 'work_item_due' AND "notification_intents"."target_type" = 'work_item' AND "notification_intents"."daily_plan_id" IS NULL AND "notification_intents"."schedule_block_id" IS NULL AND "notification_intents"."work_item_id" IS NOT NULL)
        OR
        ("notification_intents"."kind" = 'one_off' AND "notification_intents"."target_type" = 'one_off' AND "notification_intents"."daily_plan_id" IS NULL AND "notification_intents"."schedule_block_id" IS NULL AND "notification_intents"."work_item_id" IS NULL)
      )),
	CONSTRAINT "notification_intents_occurrence_nonempty" CHECK (char_length(btrim("notification_intents"."occurrence_key")) > 0),
	CONSTRAINT "notification_intents_priority_range" CHECK ("notification_intents"."priority" BETWEEN 0 AND 100),
	CONSTRAINT "notification_intents_policy_snapshot_valid" CHECK (jsonb_typeof("notification_intents"."policy_snapshot") = 'object' AND octet_length("notification_intents"."policy_snapshot"::text) <= 4096)
);
--> statement-breakpoint
CREATE TABLE "notification_profiles" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"time_zone" varchar(80) NOT NULL,
	"quiet_hours_start_minute" integer,
	"quiet_hours_end_minute" integer,
	"quiet_hours_policy" "notification_quiet_hours_policy" DEFAULT 'next_allowed' NOT NULL,
	"catch_up_window_minutes" integer DEFAULT 60 NOT NULL,
	"daily_intent_limit" integer DEFAULT 12 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_profiles_quiet_hours_pair" CHECK (("notification_profiles"."quiet_hours_start_minute" IS NULL) = ("notification_profiles"."quiet_hours_end_minute" IS NULL)),
	CONSTRAINT "notification_profiles_quiet_start_range" CHECK ("notification_profiles"."quiet_hours_start_minute" IS NULL OR "notification_profiles"."quiet_hours_start_minute" BETWEEN 0 AND 1439),
	CONSTRAINT "notification_profiles_quiet_end_range" CHECK ("notification_profiles"."quiet_hours_end_minute" IS NULL OR "notification_profiles"."quiet_hours_end_minute" BETWEEN 0 AND 1439),
	CONSTRAINT "notification_profiles_catch_up_range" CHECK ("notification_profiles"."catch_up_window_minutes" BETWEEN 0 AND 10080),
	CONSTRAINT "notification_profiles_daily_limit_range" CHECK ("notification_profiles"."daily_intent_limit" BETWEEN 1 AND 100),
	CONSTRAINT "notification_profiles_version_positive" CHECK ("notification_profiles"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "notification_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" "notification_rule_kind" NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"local_minute" integer,
	"lead_minutes" integer,
	"cooldown_minutes" integer DEFAULT 0 NOT NULL,
	"priority" integer DEFAULT 50 NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_rules_workspace_id_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "notification_rules_workspace_id_kind_uq" UNIQUE("workspace_id","id","kind"),
	CONSTRAINT "notification_rules_configuration_valid" CHECK ((
        ("notification_rules"."kind" IN ('daily_digest', 'daily_follow_up', 'work_item_due') AND "notification_rules"."local_minute" BETWEEN 0 AND 1439 AND "notification_rules"."lead_minutes" IS NULL)
        OR
        ("notification_rules"."kind" IN ('plan_window_open', 'schedule_block_lead') AND "notification_rules"."local_minute" IS NULL AND "notification_rules"."lead_minutes" BETWEEN 0 AND 10080)
      )),
	CONSTRAINT "notification_rules_cooldown_range" CHECK ("notification_rules"."cooldown_minutes" BETWEEN 0 AND 10080),
	CONSTRAINT "notification_rules_priority_range" CHECK ("notification_rules"."priority" BETWEEN 0 AND 100),
	CONSTRAINT "notification_rules_version_positive" CHECK ("notification_rules"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "one_off_reminders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"title" varchar(240) NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"cancelled_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "one_off_reminders_workspace_id_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "one_off_reminders_title_nonempty" CHECK (char_length(btrim("one_off_reminders"."title")) > 0),
	CONSTRAINT "one_off_reminders_cancellation_valid" CHECK ("one_off_reminders"."cancelled_at" IS NULL OR "one_off_reminders"."cancelled_at" >= "one_off_reminders"."created_at"),
	CONSTRAINT "one_off_reminders_version_positive" CHECK ("one_off_reminders"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "notification_intents" ADD CONSTRAINT "notification_intents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_intents" ADD CONSTRAINT "notification_intents_rule_tenant_kind_fk" FOREIGN KEY ("workspace_id","rule_id","rule_kind") REFERENCES "public"."notification_rules"("workspace_id","id","kind") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_intents" ADD CONSTRAINT "notification_intents_one_off_tenant_fk" FOREIGN KEY ("workspace_id","one_off_reminder_id") REFERENCES "public"."one_off_reminders"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_intents" ADD CONSTRAINT "notification_intents_daily_plan_tenant_fk" FOREIGN KEY ("workspace_id","daily_plan_id") REFERENCES "public"."daily_plans"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_intents" ADD CONSTRAINT "notification_intents_schedule_block_tenant_fk" FOREIGN KEY ("workspace_id","schedule_block_id") REFERENCES "public"."schedule_blocks"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_intents" ADD CONSTRAINT "notification_intents_work_item_tenant_fk" FOREIGN KEY ("workspace_id","work_item_id") REFERENCES "public"."work_items"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_profiles" ADD CONSTRAINT "notification_profiles_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_rules" ADD CONSTRAINT "notification_rules_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "one_off_reminders" ADD CONSTRAINT "one_off_reminders_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "notification_intents_workspace_schedule_idx" ON "notification_intents" USING btree ("workspace_id","scheduled_for","id");--> statement-breakpoint
CREATE INDEX "notification_intents_workspace_rule_schedule_idx" ON "notification_intents" USING btree ("workspace_id","rule_id","scheduled_for");--> statement-breakpoint
CREATE INDEX "notification_rules_workspace_kind_idx" ON "notification_rules" USING btree ("workspace_id","kind","id");--> statement-breakpoint
CREATE INDEX "one_off_reminders_workspace_schedule_idx" ON "one_off_reminders" USING btree ("workspace_id","scheduled_for","id");--> statement-breakpoint
CREATE INDEX "work_items_workspace_due_id_idx" ON "work_items" USING btree ("workspace_id","due_on","id");
