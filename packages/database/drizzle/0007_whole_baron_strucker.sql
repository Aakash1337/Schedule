CREATE TYPE "public"."plan_mutation_kind" AS ENUM('regenerate', 'replace');--> statement-breakpoint
CREATE TABLE "plan_mutations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"local_date" date NOT NULL,
	"idempotency_key" varchar(160) NOT NULL,
	"payload_hash" varchar(64) NOT NULL,
	"kind" "plan_mutation_kind" NOT NULL,
	"source_plan_id" uuid NOT NULL,
	"result_plan_id" uuid NOT NULL,
	"result_head_version" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "plan_mutations_workspace_date_idempotency_uq" UNIQUE("workspace_id","local_date","idempotency_key"),
	CONSTRAINT "plan_mutations_hash_length" CHECK (char_length("plan_mutations"."payload_hash") = 64),
	CONSTRAINT "plan_mutations_head_version_positive" CHECK ("plan_mutations"."result_head_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "plan_mutations" ADD CONSTRAINT "plan_mutations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_mutations" ADD CONSTRAINT "plan_mutations_source_plan_tenant_fk" FOREIGN KEY ("workspace_id","source_plan_id") REFERENCES "public"."daily_plans"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plan_mutations" ADD CONSTRAINT "plan_mutations_result_plan_tenant_fk" FOREIGN KEY ("workspace_id","result_plan_id") REFERENCES "public"."daily_plans"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE FUNCTION "prevent_plan_mutation_change"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_setting('schedule.allow_plan_mutation_change', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Plan mutations are append-only.' USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "plan_mutations_prevent_change"
BEFORE UPDATE OR DELETE ON "plan_mutations"
FOR EACH ROW EXECUTE FUNCTION "prevent_plan_mutation_change"();
