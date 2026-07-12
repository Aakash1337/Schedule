CREATE INDEX "schedule_blocks_workspace_range_order_idx" ON "schedule_blocks" USING btree ("workspace_id","starts_at","ends_at","id");--> statement-breakpoint
CREATE INDEX "work_items_workspace_created_id_idx" ON "work_items" USING btree ("workspace_id","created_at","id");--> statement-breakpoint
CREATE INDEX "work_items_workspace_status_priority_created_id_idx" ON "work_items" USING btree ("workspace_id","status","priority","created_at","id");--> statement-breakpoint
CREATE FUNCTION "prevent_audit_event_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_setting('schedule.allow_audit_event_mutation', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Audit events are append-only.'
    USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "audit_events_prevent_mutation"
BEFORE UPDATE OR DELETE ON "audit_events"
FOR EACH ROW
EXECUTE FUNCTION "prevent_audit_event_mutation"();
