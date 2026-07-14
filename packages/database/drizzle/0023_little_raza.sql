CREATE TABLE "work_item_dependencies" (
	"workspace_id" uuid NOT NULL,
	"prerequisite_work_item_id" uuid NOT NULL,
	"dependent_work_item_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "work_item_dependencies_pk" PRIMARY KEY("workspace_id","prerequisite_work_item_id","dependent_work_item_id"),
	CONSTRAINT "work_item_dependencies_not_self" CHECK ("work_item_dependencies"."prerequisite_work_item_id" <> "work_item_dependencies"."dependent_work_item_id")
);
--> statement-breakpoint
ALTER TABLE "work_item_dependencies" ADD CONSTRAINT "work_item_dependencies_prerequisite_tenant_fk" FOREIGN KEY ("workspace_id","prerequisite_work_item_id") REFERENCES "public"."work_items"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_item_dependencies" ADD CONSTRAINT "work_item_dependencies_dependent_tenant_fk" FOREIGN KEY ("workspace_id","dependent_work_item_id") REFERENCES "public"."work_items"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "work_item_dependencies_dependent_idx" ON "work_item_dependencies" USING btree ("workspace_id","dependent_work_item_id","prerequisite_work_item_id");--> statement-breakpoint
CREATE INDEX "work_item_dependencies_list_idx" ON "work_item_dependencies" USING btree ("workspace_id","created_at","prerequisite_work_item_id","dependent_work_item_id");