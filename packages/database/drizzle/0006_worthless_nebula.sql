ALTER TABLE "daily_plan_heads" DROP CONSTRAINT "daily_plan_heads_plan_tenant_fk";
--> statement-breakpoint
ALTER TABLE "daily_plan_heads" ADD CONSTRAINT "daily_plan_heads_plan_tenant_fk" FOREIGN KEY ("workspace_id","current_plan_id") REFERENCES "public"."daily_plans"("workspace_id","id") ON DELETE cascade ON UPDATE no action;