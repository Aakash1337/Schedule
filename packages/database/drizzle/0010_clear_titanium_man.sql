ALTER TABLE "daily_plan_item_states" DROP CONSTRAINT "daily_plan_item_states_activity_projection_consistent";--> statement-breakpoint
ALTER TABLE "daily_plan_item_states" DROP CONSTRAINT "daily_plan_item_states_activity_tenant_fk";
--> statement-breakpoint
ALTER TABLE "plan_interaction_events" DROP CONSTRAINT "plan_interaction_events_activity_tenant_fk";
--> statement-breakpoint
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_workspace_plan_item_id_uq" UNIQUE("workspace_id","plan_id","plan_item_id","id");--> statement-breakpoint
ALTER TABLE "daily_plan_item_states" ADD CONSTRAINT "daily_plan_item_states_activity_tenant_fk" FOREIGN KEY ("workspace_id","plan_id","item_id","last_activity_event_id") REFERENCES "public"."activity_events"("workspace_id","plan_id","plan_item_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_interaction_events" ADD CONSTRAINT "plan_interaction_events_activity_tenant_fk" FOREIGN KEY ("workspace_id","plan_id","item_id","activity_event_id") REFERENCES "public"."activity_events"("workspace_id","plan_id","plan_item_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_plan_item_states" ADD CONSTRAINT "daily_plan_item_states_activity_projection_consistent" CHECK (("daily_plan_item_states"."activity_state" = 'pending' AND "daily_plan_item_states"."last_activity_event_id" IS NULL AND "daily_plan_item_states"."activity_updated_at" IS NULL) OR ("daily_plan_item_states"."last_activity_event_id" IS NOT NULL AND "daily_plan_item_states"."activity_updated_at" IS NOT NULL));--> statement-breakpoint
CREATE OR REPLACE FUNCTION "validate_activity_event_reference"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  referenced_type "activity_event_type";
  referenced_plan_id uuid;
  referenced_plan_item_id uuid;
BEGIN
  IF NEW."reference_event_id" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT "type", "plan_id", "plan_item_id"
  INTO referenced_type, referenced_plan_id, referenced_plan_item_id
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

  IF NEW."type" = 'completion_reversed'
    AND referenced_plan_item_id IS NOT NULL
    AND (
      NEW."plan_id" IS DISTINCT FROM referenced_plan_id
      OR NEW."plan_item_id" IS DISTINCT FROM referenced_plan_item_id
    ) THEN
    RAISE EXCEPTION 'A plan item reversal must reference that exact plan item completion.'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE FUNCTION "validate_plan_item_activity_projection"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  referenced_type "activity_event_type";
BEGIN
  IF NEW."last_activity_event_id" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT "type"
  INTO referenced_type
  FROM "activity_events"
  WHERE "workspace_id" = NEW."workspace_id"
    AND "plan_id" = NEW."plan_id"
    AND "plan_item_id" = NEW."item_id"
    AND "id" = NEW."last_activity_event_id";

  IF referenced_type IS NULL THEN
    RAISE EXCEPTION 'Projected plan item activity event does not match this plan item.'
      USING ERRCODE = '23503';
  END IF;

  IF (NEW."activity_state" = 'pending' AND referenced_type <> 'completion_reversed')
    OR (NEW."activity_state" <> 'pending' AND referenced_type::text <> NEW."activity_state"::text) THEN
    RAISE EXCEPTION 'Projected plan item activity state does not match its event type.'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "daily_plan_item_states_validate_activity"
BEFORE INSERT OR UPDATE OF "activity_state", "last_activity_event_id", "activity_updated_at"
ON "daily_plan_item_states"
FOR EACH ROW
EXECUTE FUNCTION "validate_plan_item_activity_projection"();--> statement-breakpoint
CREATE FUNCTION "validate_plan_interaction_activity"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  referenced_type "activity_event_type";
BEGIN
  IF NEW."activity_event_id" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT "type"
  INTO referenced_type
  FROM "activity_events"
  WHERE "workspace_id" = NEW."workspace_id"
    AND "plan_id" = NEW."plan_id"
    AND "plan_item_id" = NEW."item_id"
    AND "id" = NEW."activity_event_id";

  IF referenced_type IS NULL THEN
    RAISE EXCEPTION 'Plan interaction activity event does not match this plan item.'
      USING ERRCODE = '23503';
  END IF;

  IF referenced_type::text <> NEW."type"::text THEN
    RAISE EXCEPTION 'Plan interaction type does not match its activity event.'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "plan_interaction_events_validate_activity"
BEFORE INSERT OR UPDATE OF "type", "activity_event_id", "plan_id", "item_id"
ON "plan_interaction_events"
FOR EACH ROW
EXECUTE FUNCTION "validate_plan_interaction_activity"();
