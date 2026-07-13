CREATE TYPE "public"."planning_source_type" AS ENUM('routine', 'work_item');--> statement-breakpoint
ALTER TABLE "activity_events" DROP CONSTRAINT "activity_events_reference_tenant_fk";--> statement-breakpoint
ALTER TABLE "activity_events" DROP CONSTRAINT "activity_events_workspace_routine_id_id_uq";--> statement-breakpoint
ALTER TABLE "activity_events" ALTER COLUMN "routine_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "daily_plan_items" ALTER COLUMN "routine_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "activity_events" ADD COLUMN "source_type" "planning_source_type";--> statement-breakpoint
ALTER TABLE "activity_events" ADD COLUMN "work_item_id" uuid;--> statement-breakpoint
ALTER TABLE "daily_plan_items" ADD COLUMN "source_type" "planning_source_type";--> statement-breakpoint
ALTER TABLE "daily_plan_items" ADD COLUMN "work_item_id" uuid;--> statement-breakpoint
ALTER TABLE "work_items" ADD COLUMN "planning_duration_minutes" integer;--> statement-breakpoint

-- Every row written before unified candidates was routine-backed.
SELECT set_config('schedule.allow_activity_event_mutation', 'on', true);--> statement-breakpoint
UPDATE "activity_events" SET "source_type" = 'routine' WHERE "source_type" IS NULL;--> statement-breakpoint
UPDATE "daily_plan_items" SET "source_type" = 'routine' WHERE "source_type" IS NULL;--> statement-breakpoint
UPDATE "daily_plans"
SET "exclusions" = COALESCE((
  SELECT jsonb_agg(
    CASE
      WHEN "entry" ? 'sourceType' THEN "entry"
      ELSE jsonb_build_object(
        'sourceType', 'routine',
        'routineId', "entry"->'routineId',
        'workItemId', NULL,
        'title', "entry"->'title',
        'codes', "entry"->'codes'
      )
    END
  )
  FROM jsonb_array_elements("exclusions") AS "entries"("entry")
), '[]'::jsonb)
WHERE EXISTS (
  SELECT 1 FROM jsonb_array_elements("exclusions") AS "entries"("entry")
  WHERE NOT ("entry" ? 'sourceType')
);--> statement-breakpoint
ALTER TABLE "activity_events" ALTER COLUMN "source_type" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "daily_plan_items" ALTER COLUMN "source_type" SET NOT NULL;--> statement-breakpoint

DROP TRIGGER "activity_events_validate_reference" ON "activity_events";--> statement-breakpoint
DROP FUNCTION "validate_activity_event_reference"();--> statement-breakpoint
DROP INDEX "activity_events_single_reversal_idx";--> statement-breakpoint
CREATE FUNCTION "validate_activity_event_reference"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  referenced_type "activity_event_type";
  referenced_source "planning_source_type";
  referenced_routine uuid;
  referenced_work_item uuid;
BEGIN
  IF NEW."reference_event_id" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT "type", "source_type", "routine_id", "work_item_id"
  INTO referenced_type, referenced_source, referenced_routine, referenced_work_item
  FROM "activity_events"
  WHERE "workspace_id" = NEW."workspace_id"
    AND "id" = NEW."reference_event_id";

  IF referenced_type IS NULL
    OR referenced_source <> NEW."source_type"
    OR referenced_routine IS DISTINCT FROM NEW."routine_id"
    OR referenced_work_item IS DISTINCT FROM NEW."work_item_id" THEN
    RAISE EXCEPTION 'Referenced activity event does not exist for the same workspace and source.'
      USING ERRCODE = '23503';
  END IF;

  IF NEW."type" IN ('duration_corrected', 'completion_reversed')
    AND referenced_type <> 'completed' THEN
    RAISE EXCEPTION 'Activity corrections and reversals must reference a completion event.'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "activity_events_validate_reference"
BEFORE INSERT ON "activity_events"
FOR EACH ROW
EXECUTE FUNCTION "validate_activity_event_reference"();--> statement-breakpoint
CREATE UNIQUE INDEX "activity_events_single_reversal_idx"
ON "activity_events" ("workspace_id", "reference_event_id")
WHERE "type" = 'completion_reversed';--> statement-breakpoint

ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_work_item_tenant_fk" FOREIGN KEY ("workspace_id","work_item_id") REFERENCES "public"."work_items"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_reference_tenant_fk" FOREIGN KEY ("workspace_id","reference_event_id") REFERENCES "public"."activity_events"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_plan_items" ADD CONSTRAINT "daily_plan_items_work_item_tenant_fk" FOREIGN KEY ("workspace_id","work_item_id") REFERENCES "public"."work_items"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_events_work_item_occurred_idx" ON "activity_events" USING btree ("workspace_id","work_item_id","occurred_at");--> statement-breakpoint
CREATE INDEX "activity_events_work_item_sequence_idx" ON "activity_events" USING btree ("workspace_id","work_item_id","ingested_sequence");--> statement-breakpoint
ALTER TABLE "daily_plan_items" ADD CONSTRAINT "daily_plan_items_plan_work_item_uq" UNIQUE("workspace_id","plan_id","work_item_id");--> statement-breakpoint
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_source_valid" CHECK (("activity_events"."source_type" = 'routine' AND "activity_events"."routine_id" IS NOT NULL AND "activity_events"."work_item_id" IS NULL) OR ("activity_events"."source_type" = 'work_item' AND "activity_events"."work_item_id" IS NOT NULL AND "activity_events"."routine_id" IS NULL));--> statement-breakpoint
ALTER TABLE "daily_plan_items" ADD CONSTRAINT "daily_plan_items_source_valid" CHECK (("daily_plan_items"."source_type" = 'routine' AND "daily_plan_items"."routine_id" IS NOT NULL AND "daily_plan_items"."work_item_id" IS NULL) OR ("daily_plan_items"."source_type" = 'work_item' AND "daily_plan_items"."work_item_id" IS NOT NULL AND "daily_plan_items"."routine_id" IS NULL));--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_planning_duration_positive" CHECK ("work_items"."planning_duration_minutes" IS NULL OR "work_items"."planning_duration_minutes" > 0);
