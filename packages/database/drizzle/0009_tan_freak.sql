CREATE TYPE "public"."plan_item_activity_state" AS ENUM('pending', 'started', 'completed', 'skipped', 'deferred', 'dismissed');--> statement-breakpoint
ALTER TABLE "plan_interaction_events" ALTER COLUMN "type" TYPE text USING "type"::text;--> statement-breakpoint
DROP TYPE "public"."plan_interaction_type";--> statement-breakpoint
CREATE TYPE "public"."plan_interaction_type" AS ENUM('locked', 'unlocked', 'started', 'completed', 'skipped', 'deferred', 'dismissed', 'completion_reversed');--> statement-breakpoint
ALTER TABLE "plan_interaction_events" ALTER COLUMN "type" TYPE "public"."plan_interaction_type" USING "type"::"public"."plan_interaction_type";--> statement-breakpoint
ALTER TABLE "activity_events" ADD COLUMN "plan_item_id" uuid;--> statement-breakpoint
ALTER TABLE "daily_plan_item_states" ADD COLUMN "activity_state" "plan_item_activity_state" DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "daily_plan_item_states" ADD COLUMN "last_activity_event_id" uuid;--> statement-breakpoint
ALTER TABLE "daily_plan_item_states" ADD COLUMN "activity_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "plan_interaction_events" ADD COLUMN "activity_event_id" uuid;--> statement-breakpoint
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_plan_item_tenant_fk" FOREIGN KEY ("workspace_id","plan_id","plan_item_id") REFERENCES "public"."daily_plan_items"("workspace_id","plan_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_plan_item_states" ADD CONSTRAINT "daily_plan_item_states_activity_tenant_fk" FOREIGN KEY ("workspace_id","last_activity_event_id") REFERENCES "public"."activity_events"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_interaction_events" ADD CONSTRAINT "plan_interaction_events_activity_tenant_fk" FOREIGN KEY ("workspace_id","activity_event_id") REFERENCES "public"."activity_events"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_plan_item_requires_plan" CHECK ("activity_events"."plan_item_id" IS NULL OR "activity_events"."plan_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "daily_plan_item_states" ADD CONSTRAINT "daily_plan_item_states_activity_projection_consistent" CHECK (("daily_plan_item_states"."activity_state" = 'pending' AND "daily_plan_item_states"."last_activity_event_id" IS NULL AND "daily_plan_item_states"."activity_updated_at" IS NULL) OR ("daily_plan_item_states"."last_activity_event_id" IS NOT NULL AND "daily_plan_item_states"."activity_updated_at" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "plan_interaction_events" ADD CONSTRAINT "plan_interaction_events_activity_policy" CHECK (("plan_interaction_events"."type" IN ('locked', 'unlocked') AND "plan_interaction_events"."activity_event_id" IS NULL) OR ("plan_interaction_events"."type" NOT IN ('locked', 'unlocked') AND "plan_interaction_events"."activity_event_id" IS NOT NULL));
