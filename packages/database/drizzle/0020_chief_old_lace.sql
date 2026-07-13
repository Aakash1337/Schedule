CREATE TYPE "public"."routine_planning_feedback_kind" AS ENUM('not_today', 'not_this_week', 'reset');--> statement-breakpoint
ALTER TYPE "public"."plan_mutation_kind" ADD VALUE 'feedback';--> statement-breakpoint
ALTER TYPE "public"."plan_mutation_kind" ADD VALUE 'feedback_reset';--> statement-breakpoint
CREATE TABLE "routine_planning_feedback_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ingested_sequence" bigserial NOT NULL,
	"workspace_id" uuid NOT NULL,
	"routine_id" uuid NOT NULL,
	"kind" "routine_planning_feedback_kind" NOT NULL,
	"effective_on" date NOT NULL,
	"effective_through" date,
	"time_zone" varchar(80) NOT NULL,
	"source_plan_id" uuid NOT NULL,
	"source_plan_item_id" uuid,
	"idempotency_key" varchar(160) NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "routine_planning_feedback_events_workspace_id_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "routine_planning_feedback_events_workspace_date_idempotency_uq" UNIQUE("workspace_id","effective_on","idempotency_key"),
	CONSTRAINT "routine_planning_feedback_events_kind_policy" CHECK (("routine_planning_feedback_events"."kind" = 'reset' AND "routine_planning_feedback_events"."effective_through" IS NULL AND "routine_planning_feedback_events"."source_plan_item_id" IS NULL) OR ("routine_planning_feedback_events"."kind" = 'not_today' AND "routine_planning_feedback_events"."effective_through" = "routine_planning_feedback_events"."effective_on" AND "routine_planning_feedback_events"."source_plan_item_id" IS NOT NULL) OR ("routine_planning_feedback_events"."kind" = 'not_this_week' AND "routine_planning_feedback_events"."effective_through" >= "routine_planning_feedback_events"."effective_on" AND "routine_planning_feedback_events"."effective_through" <= ("routine_planning_feedback_events"."effective_on" + 6) AND "routine_planning_feedback_events"."source_plan_item_id" IS NOT NULL)),
	CONSTRAINT "routine_planning_feedback_events_timezone_nonempty" CHECK (char_length(btrim("routine_planning_feedback_events"."time_zone")) > 0),
	CONSTRAINT "routine_planning_feedback_events_idempotency_nonempty" CHECK (char_length(btrim("routine_planning_feedback_events"."idempotency_key")) > 0),
	CONSTRAINT "routine_planning_feedback_events_sequence_positive" CHECK ("routine_planning_feedback_events"."ingested_sequence" > 0)
);
--> statement-breakpoint
ALTER TABLE "routine_planning_feedback_events" ADD CONSTRAINT "routine_planning_feedback_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_planning_feedback_events" ADD CONSTRAINT "routine_planning_feedback_events_routine_tenant_fk" FOREIGN KEY ("workspace_id","routine_id") REFERENCES "public"."routines"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_planning_feedback_events" ADD CONSTRAINT "routine_planning_feedback_events_plan_tenant_fk" FOREIGN KEY ("workspace_id","source_plan_id") REFERENCES "public"."daily_plans"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_plan_items" ADD CONSTRAINT "daily_plan_items_feedback_provenance_uq" UNIQUE("workspace_id","plan_id","id","routine_id");--> statement-breakpoint
ALTER TABLE "routine_planning_feedback_events" ADD CONSTRAINT "routine_planning_feedback_events_source_routine_item_fk" FOREIGN KEY ("workspace_id","source_plan_id","source_plan_item_id","routine_id") REFERENCES "public"."daily_plan_items"("workspace_id","plan_id","id","routine_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "routine_planning_feedback_events_routine_sequence_idx" ON "routine_planning_feedback_events" USING btree ("workspace_id","routine_id","ingested_sequence" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "routine_planning_feedback_events_effective_date_idx" ON "routine_planning_feedback_events" USING btree ("workspace_id","effective_on");--> statement-breakpoint
CREATE FUNCTION "prevent_routine_planning_feedback_event_change"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_setting('schedule.allow_routine_planning_feedback_event_change', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Routine planning feedback events are append-only.' USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "routine_planning_feedback_events_prevent_change"
BEFORE UPDATE OR DELETE ON "routine_planning_feedback_events"
FOR EACH ROW EXECUTE FUNCTION "prevent_routine_planning_feedback_event_change"();
