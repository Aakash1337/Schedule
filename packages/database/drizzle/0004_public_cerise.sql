ALTER TABLE "activity_events" ADD COLUMN "ingested_sequence" bigint;--> statement-breakpoint
CREATE SEQUENCE "activity_events_ingested_sequence_seq";--> statement-breakpoint
SELECT set_config('schedule.allow_activity_event_mutation', 'on', true);--> statement-breakpoint
WITH ranked_events AS (
  SELECT "id", row_number() OVER (ORDER BY "recorded_at", "id") AS "sequence"
  FROM "activity_events"
)
UPDATE "activity_events"
SET "ingested_sequence" = ranked_events."sequence"
FROM ranked_events
WHERE "activity_events"."id" = ranked_events."id";--> statement-breakpoint
SELECT set_config('schedule.allow_activity_event_mutation', 'off', true);--> statement-breakpoint
SELECT setval(
  'activity_events_ingested_sequence_seq',
  GREATEST(COALESCE((SELECT MAX("ingested_sequence") FROM "activity_events"), 0) + 1, 1),
  false
);--> statement-breakpoint
ALTER SEQUENCE "activity_events_ingested_sequence_seq"
OWNED BY "activity_events"."ingested_sequence";--> statement-breakpoint
ALTER TABLE "activity_events"
ALTER COLUMN "ingested_sequence" SET DEFAULT nextval('activity_events_ingested_sequence_seq'),
ALTER COLUMN "ingested_sequence" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "activity_events_routine_sequence_idx" ON "activity_events" USING btree ("workspace_id","routine_id","ingested_sequence");
