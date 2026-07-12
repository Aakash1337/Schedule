CREATE TYPE "public"."plan_interaction_type" AS ENUM('locked', 'unlocked');--> statement-breakpoint
CREATE TABLE "daily_plan_heads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"local_date" date NOT NULL,
	"current_plan_id" uuid NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_plan_heads_workspace_date_uq" UNIQUE("workspace_id","local_date"),
	CONSTRAINT "daily_plan_heads_version_positive" CHECK ("daily_plan_heads"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "daily_plan_item_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"locked" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "daily_plan_item_states_item_uq" UNIQUE("workspace_id","plan_id","item_id"),
	CONSTRAINT "daily_plan_item_states_version_positive" CHECK ("daily_plan_item_states"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "plan_interaction_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ingested_sequence" bigserial NOT NULL,
	"workspace_id" uuid NOT NULL,
	"local_date" date NOT NULL,
	"plan_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"type" "plan_interaction_type" NOT NULL,
	"idempotency_key" varchar(160) NOT NULL,
	"payload_hash" varchar(64) NOT NULL,
	"result_head_version" integer NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "plan_interaction_events_workspace_idempotency_uq" UNIQUE("workspace_id","idempotency_key"),
	CONSTRAINT "plan_interaction_events_hash_length" CHECK (char_length("plan_interaction_events"."payload_hash") = 64),
	CONSTRAINT "plan_interaction_events_head_version_positive" CHECK ("plan_interaction_events"."result_head_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "daily_plan_heads" ADD CONSTRAINT "daily_plan_heads_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_plan_heads" ADD CONSTRAINT "daily_plan_heads_plan_tenant_fk" FOREIGN KEY ("workspace_id","current_plan_id") REFERENCES "public"."daily_plans"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_plan_items" ADD CONSTRAINT "daily_plan_items_workspace_plan_id_uq" UNIQUE("workspace_id","plan_id","id");--> statement-breakpoint
ALTER TABLE "daily_plan_item_states" ADD CONSTRAINT "daily_plan_item_states_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_plan_item_states" ADD CONSTRAINT "daily_plan_item_states_item_tenant_fk" FOREIGN KEY ("workspace_id","plan_id","item_id") REFERENCES "public"."daily_plan_items"("workspace_id","plan_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_interaction_events" ADD CONSTRAINT "plan_interaction_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_interaction_events" ADD CONSTRAINT "plan_interaction_events_head_tenant_fk" FOREIGN KEY ("workspace_id","local_date") REFERENCES "public"."daily_plan_heads"("workspace_id","local_date") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_interaction_events" ADD CONSTRAINT "plan_interaction_events_item_tenant_fk" FOREIGN KEY ("workspace_id","plan_id","item_id") REFERENCES "public"."daily_plan_items"("workspace_id","plan_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "plan_interaction_events_day_sequence_idx" ON "plan_interaction_events" USING btree ("workspace_id","local_date","ingested_sequence");--> statement-breakpoint
INSERT INTO "daily_plan_heads" ("workspace_id", "local_date", "current_plan_id", "version", "created_at", "updated_at")
SELECT DISTINCT ON ("workspace_id", "local_date")
  "workspace_id", "local_date", "id", 1, "created_at", "updated_at"
FROM "daily_plans"
ORDER BY "workspace_id", "local_date", "request_revision" DESC, "generated_at" DESC, "id" DESC;--> statement-breakpoint
INSERT INTO "daily_plan_item_states" ("workspace_id", "plan_id", "item_id", "locked", "version", "updated_at")
SELECT "workspace_id", "plan_id", "id", false, 1, "created_at"
FROM "daily_plan_items";--> statement-breakpoint
CREATE FUNCTION "prevent_plan_interaction_event_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_setting('schedule.allow_plan_interaction_event_mutation', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Plan interaction events are append-only.' USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "plan_interaction_events_prevent_mutation"
BEFORE UPDATE OR DELETE ON "plan_interaction_events"
FOR EACH ROW
EXECUTE FUNCTION "prevent_plan_interaction_event_mutation"();
