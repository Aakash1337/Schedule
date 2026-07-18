ALTER TYPE "public"."daily_plan_fit_insight_feedback_kind" ADD VALUE 'used';--> statement-breakpoint
ALTER TABLE "daily_plan_fit_insight_feedback_events" ADD COLUMN "plan_id" uuid;--> statement-breakpoint
ALTER TABLE "daily_plan_fit_insight_feedback_events" ADD COLUMN "applied_target_minutes" integer;--> statement-breakpoint
ALTER TABLE "daily_plan_fit_insight_feedback_events" ADD COLUMN "applied_target_task_count" integer;--> statement-breakpoint
ALTER TABLE "daily_plan_fit_insight_feedback_events" ADD CONSTRAINT "daily_plan_fit_feedback_plan_tenant_fk" FOREIGN KEY ("workspace_id","plan_id") REFERENCES "public"."daily_plans"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "daily_plan_fit_feedback_kind_sequence_idx" ON "daily_plan_fit_insight_feedback_events" USING btree ("workspace_id","kind","ingested_sequence" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "daily_plan_fit_feedback_used_plan_uq" ON "daily_plan_fit_insight_feedback_events" USING btree ("workspace_id","plan_id") WHERE "daily_plan_fit_insight_feedback_events"."plan_id" is not null;--> statement-breakpoint
ALTER TABLE "daily_plan_fit_insight_feedback_events" ADD CONSTRAINT "daily_plan_fit_feedback_usage_shape_valid" CHECK ((
        "daily_plan_fit_insight_feedback_events"."kind"::text = 'used'
        AND "daily_plan_fit_insight_feedback_events"."plan_id" IS NOT NULL
        AND "daily_plan_fit_insight_feedback_events"."applied_target_minutes" IS NOT NULL
        AND "daily_plan_fit_insight_feedback_events"."applied_target_task_count" IS NOT NULL
      ) OR (
        "daily_plan_fit_insight_feedback_events"."kind"::text IN ('dismissed', 'reset')
        AND "daily_plan_fit_insight_feedback_events"."plan_id" IS NULL
        AND "daily_plan_fit_insight_feedback_events"."applied_target_minutes" IS NULL
        AND "daily_plan_fit_insight_feedback_events"."applied_target_task_count" IS NULL
      ));--> statement-breakpoint
ALTER TABLE "daily_plan_fit_insight_feedback_events" ADD CONSTRAINT "daily_plan_fit_feedback_applied_minutes_positive" CHECK ("daily_plan_fit_insight_feedback_events"."applied_target_minutes" IS NULL OR "daily_plan_fit_insight_feedback_events"."applied_target_minutes" > 0);--> statement-breakpoint
ALTER TABLE "daily_plan_fit_insight_feedback_events" ADD CONSTRAINT "daily_plan_fit_feedback_applied_tasks_positive" CHECK ("daily_plan_fit_insight_feedback_events"."applied_target_task_count" IS NULL OR "daily_plan_fit_insight_feedback_events"."applied_target_task_count" > 0);