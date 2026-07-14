CREATE TYPE "public"."daily_plan_fit_insight_feedback_kind" AS ENUM('dismissed', 'reset');--> statement-breakpoint
CREATE TABLE "daily_plan_fit_insight_feedback_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ingested_sequence" bigserial NOT NULL,
	"workspace_id" uuid NOT NULL,
	"for_date" date NOT NULL,
	"insight_key" varchar(64) NOT NULL,
	"kind" "daily_plan_fit_insight_feedback_kind" NOT NULL,
	"sample_count" integer NOT NULL,
	"typical_planned_minutes" integer NOT NULL,
	"typical_completed_minutes" integer NOT NULL,
	"typical_planned_task_count" integer NOT NULL,
	"typical_completed_task_count" integer NOT NULL,
	"suggested_target_minutes" integer NOT NULL,
	"suggested_target_task_count" integer NOT NULL,
	"idempotency_key" varchar(160) NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "daily_plan_fit_feedback_workspace_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "daily_plan_fit_feedback_workspace_idempotency_uq" UNIQUE("workspace_id","idempotency_key"),
	CONSTRAINT "daily_plan_fit_feedback_key_format" CHECK (char_length("daily_plan_fit_insight_feedback_events"."insight_key") = 64 AND "daily_plan_fit_insight_feedback_events"."insight_key" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "daily_plan_fit_feedback_sample_positive" CHECK ("daily_plan_fit_insight_feedback_events"."sample_count" > 0),
	CONSTRAINT "daily_plan_fit_feedback_planned_minutes_positive" CHECK ("daily_plan_fit_insight_feedback_events"."typical_planned_minutes" > 0),
	CONSTRAINT "daily_plan_fit_feedback_completed_minutes_nonnegative" CHECK ("daily_plan_fit_insight_feedback_events"."typical_completed_minutes" >= 0),
	CONSTRAINT "daily_plan_fit_feedback_planned_tasks_positive" CHECK ("daily_plan_fit_insight_feedback_events"."typical_planned_task_count" > 0),
	CONSTRAINT "daily_plan_fit_feedback_completed_tasks_nonnegative" CHECK ("daily_plan_fit_insight_feedback_events"."typical_completed_task_count" >= 0),
	CONSTRAINT "daily_plan_fit_feedback_suggested_minutes_positive" CHECK ("daily_plan_fit_insight_feedback_events"."suggested_target_minutes" > 0),
	CONSTRAINT "daily_plan_fit_feedback_suggested_tasks_positive" CHECK ("daily_plan_fit_insight_feedback_events"."suggested_target_task_count" > 0),
	CONSTRAINT "daily_plan_fit_feedback_idempotency_canonical" CHECK (char_length("daily_plan_fit_insight_feedback_events"."idempotency_key") > 0 AND "daily_plan_fit_insight_feedback_events"."idempotency_key" = btrim("daily_plan_fit_insight_feedback_events"."idempotency_key")),
	CONSTRAINT "daily_plan_fit_feedback_sequence_positive" CHECK ("daily_plan_fit_insight_feedback_events"."ingested_sequence" > 0)
);
--> statement-breakpoint
ALTER TABLE "daily_plan_fit_insight_feedback_events" ADD CONSTRAINT "daily_plan_fit_insight_feedback_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "daily_plan_fit_feedback_key_sequence_idx" ON "daily_plan_fit_insight_feedback_events" USING btree ("workspace_id","insight_key","ingested_sequence" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE OR REPLACE FUNCTION "prevent_daily_plan_fit_insight_feedback_change"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_setting('schedule.allow_daily_plan_fit_insight_feedback_event_change', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Daily Plan Fit insight feedback events are append-only.' USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "daily_plan_fit_insight_feedback_events_prevent_change"
BEFORE UPDATE OR DELETE ON "daily_plan_fit_insight_feedback_events"
FOR EACH ROW EXECUTE FUNCTION "prevent_daily_plan_fit_insight_feedback_change"();
