-- Compatibility for databases that applied the initial unified-source migration
-- before exclusions acquired their explicit source discriminator.
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

CREATE OR REPLACE FUNCTION "validate_activity_event_reference"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  planned_source "planning_source_type";
  planned_routine uuid;
  planned_work_item uuid;
  referenced_type "activity_event_type";
  referenced_source "planning_source_type";
  referenced_routine uuid;
  referenced_work_item uuid;
BEGIN
  IF NEW."plan_item_id" IS NOT NULL THEN
    SELECT "source_type", "routine_id", "work_item_id"
    INTO planned_source, planned_routine, planned_work_item
    FROM "daily_plan_items"
    WHERE "workspace_id" = NEW."workspace_id"
      AND "plan_id" = NEW."plan_id"
      AND "id" = NEW."plan_item_id";

    IF planned_source IS NULL
      OR planned_source <> NEW."source_type"
      OR planned_routine IS DISTINCT FROM NEW."routine_id"
      OR planned_work_item IS DISTINCT FROM NEW."work_item_id" THEN
      RAISE EXCEPTION 'Plan-linked activity must match its daily plan item source.'
        USING ERRCODE = '23514';
    END IF;
  END IF;

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
$$;
