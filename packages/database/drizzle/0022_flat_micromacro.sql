CREATE TYPE "public"."routine_duration_insight_feedback_kind" AS ENUM('dismissed', 'reset');--> statement-breakpoint
CREATE TABLE "routine_duration_insight_feedback_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ingested_sequence" bigserial NOT NULL,
	"workspace_id" uuid NOT NULL,
	"routine_id" uuid NOT NULL,
	"insight_key" varchar(64) NOT NULL,
	"kind" "routine_duration_insight_feedback_kind" NOT NULL,
	"routine_version" integer NOT NULL,
	"observed_median_minutes" integer NOT NULL,
	"suggested_expected_minutes" integer,
	"idempotency_key" varchar(160) NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "duration_insight_feedback_workspace_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "duration_insight_feedback_workspace_idempotency_uq" UNIQUE("workspace_id","idempotency_key"),
	CONSTRAINT "duration_insight_feedback_key_format" CHECK (char_length("routine_duration_insight_feedback_events"."insight_key") = 64 AND "routine_duration_insight_feedback_events"."insight_key" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "duration_insight_feedback_version_positive" CHECK ("routine_duration_insight_feedback_events"."routine_version" > 0),
	CONSTRAINT "duration_insight_feedback_observed_positive" CHECK ("routine_duration_insight_feedback_events"."observed_median_minutes" > 0),
	CONSTRAINT "duration_insight_feedback_suggested_positive" CHECK ("routine_duration_insight_feedback_events"."suggested_expected_minutes" IS NULL OR "routine_duration_insight_feedback_events"."suggested_expected_minutes" > 0),
	CONSTRAINT "duration_insight_feedback_idempotency_canonical" CHECK (char_length("routine_duration_insight_feedback_events"."idempotency_key") > 0 AND "routine_duration_insight_feedback_events"."idempotency_key" = btrim("routine_duration_insight_feedback_events"."idempotency_key")),
	CONSTRAINT "duration_insight_feedback_sequence_positive" CHECK ("routine_duration_insight_feedback_events"."ingested_sequence" > 0)
);
--> statement-breakpoint
ALTER TABLE "routine_duration_insight_feedback_events" ADD CONSTRAINT "duration_insight_feedback_workspace_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_duration_insight_feedback_events" ADD CONSTRAINT "duration_insight_feedback_routine_tenant_fk" FOREIGN KEY ("workspace_id","routine_id") REFERENCES "public"."routines"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "duration_insight_feedback_key_sequence_idx" ON "routine_duration_insight_feedback_events" USING btree ("workspace_id","routine_id","insight_key","ingested_sequence" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE FUNCTION "prevent_routine_duration_insight_feedback_event_change"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_setting('schedule.allow_routine_duration_insight_feedback_event_change', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Routine duration insight feedback events are append-only.' USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "routine_duration_insight_feedback_events_prevent_change"
BEFORE UPDATE OR DELETE ON "routine_duration_insight_feedback_events"
FOR EACH ROW EXECUTE FUNCTION "prevent_routine_duration_insight_feedback_event_change"();
