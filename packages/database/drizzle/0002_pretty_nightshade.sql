ALTER TABLE "activity_events" DROP CONSTRAINT "activity_events_reference_policy";--> statement-breakpoint
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_reference_policy" CHECK (("activity_events"."type" = 'duration_corrected' AND "activity_events"."reference_event_id" IS NOT NULL AND "activity_events"."duration_minutes" IS NOT NULL) OR ("activity_events"."type" = 'completion_reversed' AND "activity_events"."reference_event_id" IS NOT NULL AND "activity_events"."duration_minutes" IS NULL) OR ("activity_events"."type" NOT IN ('duration_corrected', 'completion_reversed') AND "activity_events"."reference_event_id" IS NULL));--> statement-breakpoint
CREATE FUNCTION "validate_activity_event_reference"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  referenced_type "activity_event_type";
BEGIN
  IF NEW."reference_event_id" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT "type"
  INTO referenced_type
  FROM "activity_events"
  WHERE "workspace_id" = NEW."workspace_id"
    AND "routine_id" = NEW."routine_id"
    AND "id" = NEW."reference_event_id";

  IF referenced_type IS NULL THEN
    RAISE EXCEPTION 'Referenced activity event does not exist in this workspace and routine.'
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
ON "activity_events" ("workspace_id", "routine_id", "reference_event_id")
WHERE "type" = 'completion_reversed';--> statement-breakpoint
CREATE FUNCTION "prevent_activity_event_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_setting('schedule.allow_activity_event_mutation', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Activity events are append-only. Record a correction or reversal instead.'
    USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "activity_events_prevent_mutation"
BEFORE UPDATE OR DELETE ON "activity_events"
FOR EACH ROW
EXECUTE FUNCTION "prevent_activity_event_mutation"();
