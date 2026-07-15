CREATE TYPE "public"."routine_selection_preference_feedback_kind" AS ENUM('more_often', 'less_often', 'reset');--> statement-breakpoint
CREATE TABLE "routine_selection_preference_feedback_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ingested_sequence" bigserial NOT NULL,
	"workspace_id" uuid NOT NULL,
	"routine_id" uuid NOT NULL,
	"feedback_version" integer NOT NULL,
	"kind" "routine_selection_preference_feedback_kind" NOT NULL,
	"effective_on" date NOT NULL,
	"time_zone" varchar(80) NOT NULL,
	"source_plan_id" uuid,
	"source_plan_item_id" uuid,
	"idempotency_key" varchar(160) NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "routine_select_pref_events_workspace_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "routine_select_pref_events_workspace_key_uq" UNIQUE("workspace_id","idempotency_key"),
	CONSTRAINT "routine_select_pref_events_routine_version_uq" UNIQUE("workspace_id","routine_id","feedback_version"),
	CONSTRAINT "routine_select_pref_events_source_valid" CHECK ("routine_selection_preference_feedback_events"."source_plan_item_id" IS NULL OR "routine_selection_preference_feedback_events"."source_plan_id" IS NOT NULL),
	CONSTRAINT "routine_select_pref_events_reset_item_null" CHECK ("routine_selection_preference_feedback_events"."kind" <> 'reset' OR "routine_selection_preference_feedback_events"."source_plan_item_id" IS NULL),
	CONSTRAINT "routine_select_pref_events_timezone_nonempty" CHECK (char_length(btrim("routine_selection_preference_feedback_events"."time_zone")) > 0),
	CONSTRAINT "routine_select_pref_events_key_nonempty" CHECK (char_length(btrim("routine_selection_preference_feedback_events"."idempotency_key")) > 0),
	CONSTRAINT "routine_select_pref_events_sequence_positive" CHECK ("routine_selection_preference_feedback_events"."ingested_sequence" > 0),
	CONSTRAINT "routine_select_pref_events_version_positive" CHECK ("routine_selection_preference_feedback_events"."feedback_version" > 0)
);
--> statement-breakpoint
ALTER SEQUENCE "routine_selection_preference_feedback_eve_ingested_sequence_seq" RENAME TO "routine_select_pref_events_ingested_sequence_seq";--> statement-breakpoint
ALTER TABLE "routines" ADD COLUMN "selection_preference_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "routine_selection_preference_feedback_events" ADD CONSTRAINT "routine_select_pref_events_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_selection_preference_feedback_events" ADD CONSTRAINT "routine_select_pref_events_routine_fk" FOREIGN KEY ("workspace_id","routine_id") REFERENCES "public"."routines"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_selection_preference_feedback_events" ADD CONSTRAINT "routine_select_pref_events_plan_fk" FOREIGN KEY ("workspace_id","source_plan_id") REFERENCES "public"."daily_plans"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_selection_preference_feedback_events" ADD CONSTRAINT "routine_select_pref_events_source_item_fk" FOREIGN KEY ("workspace_id","source_plan_id","source_plan_item_id","routine_id") REFERENCES "public"."daily_plan_items"("workspace_id","plan_id","id","routine_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "routine_select_pref_events_planning_idx" ON "routine_selection_preference_feedback_events" USING btree ("workspace_id","routine_id","effective_on","ingested_sequence" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "routines" ADD CONSTRAINT "routines_selection_preference_version_nonnegative" CHECK ("routines"."selection_preference_version" >= 0);
--> statement-breakpoint
CREATE FUNCTION "prevent_routine_selection_preference_feedback_event_change"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_setting('schedule.allow_routine_selection_preference_feedback_event_change', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Routine selection preference feedback events are append-only.' USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "routine_selection_preference_feedback_events_prevent_change"
BEFORE UPDATE OR DELETE ON "routine_selection_preference_feedback_events"
FOR EACH ROW EXECUTE FUNCTION "prevent_routine_selection_preference_feedback_event_change"();
