ALTER TABLE "plan_mutations" DROP CONSTRAINT "plan_mutations_source_plan_tenant_fk";
--> statement-breakpoint
ALTER TABLE "plan_mutations" DROP CONSTRAINT "plan_mutations_result_plan_tenant_fk";
--> statement-breakpoint
ALTER TABLE "plan_mutations" ADD CONSTRAINT "plan_mutations_source_plan_tenant_fk" FOREIGN KEY ("workspace_id","source_plan_id") REFERENCES "public"."daily_plans"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_mutations" ADD CONSTRAINT "plan_mutations_result_plan_tenant_fk" FOREIGN KEY ("workspace_id","result_plan_id") REFERENCES "public"."daily_plans"("workspace_id","id") ON DELETE cascade ON UPDATE no action;