ALTER TYPE "public"."plan_mutation_kind" ADD VALUE 'add_routine';--> statement-breakpoint
CREATE TABLE "routine_group_memberships" (
	"workspace_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"routine_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "routine_group_memberships_pk" PRIMARY KEY("workspace_id","group_id","routine_id")
);
--> statement-breakpoint
CREATE TABLE "routine_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" varchar(80) NOT NULL,
	"normalized_name" varchar(80) NOT NULL,
	"description" varchar(500),
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "routine_groups_workspace_id_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "routine_groups_workspace_name_uq" UNIQUE("workspace_id","normalized_name"),
	CONSTRAINT "routine_groups_name_nonempty" CHECK (char_length(btrim("routine_groups"."name")) BETWEEN 1 AND 80),
	CONSTRAINT "routine_groups_normalized_name_nonempty" CHECK (char_length(btrim("routine_groups"."normalized_name")) BETWEEN 1 AND 80),
	CONSTRAINT "routine_groups_description_valid" CHECK ("routine_groups"."description" IS NULL OR char_length(btrim("routine_groups"."description")) BETWEEN 1 AND 500),
	CONSTRAINT "routine_groups_version_positive" CHECK ("routine_groups"."version" > 0)
);
--> statement-breakpoint
ALTER TABLE "routine_group_memberships" ADD CONSTRAINT "routine_group_memberships_group_tenant_fk" FOREIGN KEY ("workspace_id","group_id") REFERENCES "public"."routine_groups"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_group_memberships" ADD CONSTRAINT "routine_group_memberships_routine_tenant_fk" FOREIGN KEY ("workspace_id","routine_id") REFERENCES "public"."routines"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "routine_groups" ADD CONSTRAINT "routine_groups_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "routine_group_memberships_routine_idx" ON "routine_group_memberships" USING btree ("workspace_id","routine_id","group_id");--> statement-breakpoint
CREATE INDEX "routine_groups_workspace_created_idx" ON "routine_groups" USING btree ("workspace_id","created_at","id");
