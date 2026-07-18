CREATE TYPE "public"."hosted_work_item_sync_change_kind" AS ENUM('upsert', 'delete');--> statement-breakpoint
CREATE TABLE "hosted_work_item_sync_capability" (
	"singleton" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"capture_enabled" boolean DEFAULT false NOT NULL,
	"enabled_at" timestamp with time zone,
	CONSTRAINT "hosted_work_item_sync_capability_singleton" CHECK ("hosted_work_item_sync_capability"."singleton"),
	CONSTRAINT "hosted_work_item_sync_capability_lifecycle" CHECK ((not "hosted_work_item_sync_capability"."capture_enabled" and "hosted_work_item_sync_capability"."enabled_at" is null) or ("hosted_work_item_sync_capability"."capture_enabled" and "hosted_work_item_sync_capability"."enabled_at" is not null))
);--> statement-breakpoint
CREATE TABLE "hosted_work_item_sync_changes" (
	"workspace_id" uuid NOT NULL,
	"cursor" bigint NOT NULL,
	"kind" "hosted_work_item_sync_change_kind" NOT NULL,
	"work_item_id" uuid NOT NULL,
	"parent_work_item_id" uuid,
	"title" varchar(240),
	"description" text,
	"status" "work_item_status",
	"priority" "work_item_priority",
	"planning_duration_minutes" integer,
	"due_on" date,
	"version" integer,
	"item_created_at" timestamp with time zone,
	"item_updated_at" timestamp with time zone,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hosted_work_item_sync_changes_pk" PRIMARY KEY("workspace_id","cursor"),
	CONSTRAINT "hosted_work_item_sync_changes_cursor_positive" CHECK ("hosted_work_item_sync_changes"."cursor" > 0),
	CONSTRAINT "hosted_work_item_sync_changes_planning_duration_positive" CHECK ("hosted_work_item_sync_changes"."planning_duration_minutes" is null or "hosted_work_item_sync_changes"."planning_duration_minutes" > 0),
	CONSTRAINT "hosted_work_item_sync_changes_shape_valid" CHECK ((
        "hosted_work_item_sync_changes"."kind" = 'upsert'
        and "hosted_work_item_sync_changes"."title" is not null
        and "hosted_work_item_sync_changes"."status" is not null
        and "hosted_work_item_sync_changes"."priority" is not null
        and "hosted_work_item_sync_changes"."version" is not null
        and "hosted_work_item_sync_changes"."version" > 0
        and "hosted_work_item_sync_changes"."item_created_at" is not null
        and "hosted_work_item_sync_changes"."item_updated_at" is not null
      ) or (
        "hosted_work_item_sync_changes"."kind" = 'delete'
        and "hosted_work_item_sync_changes"."parent_work_item_id" is null
        and "hosted_work_item_sync_changes"."title" is null
        and "hosted_work_item_sync_changes"."description" is null
        and "hosted_work_item_sync_changes"."status" is null
        and "hosted_work_item_sync_changes"."priority" is null
        and "hosted_work_item_sync_changes"."planning_duration_minutes" is null
        and "hosted_work_item_sync_changes"."due_on" is null
        and "hosted_work_item_sync_changes"."version" is null
        and "hosted_work_item_sync_changes"."item_created_at" is null
        and "hosted_work_item_sync_changes"."item_updated_at" is null
      ))
);
--> statement-breakpoint
CREATE TABLE "hosted_work_item_sync_states" (
	"workspace_id" uuid PRIMARY KEY NOT NULL,
	"head_cursor" bigint DEFAULT 0 NOT NULL,
	"minimum_cursor" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hosted_work_item_sync_states_head_nonnegative" CHECK ("hosted_work_item_sync_states"."head_cursor" >= 0),
	CONSTRAINT "hosted_work_item_sync_states_minimum_nonnegative" CHECK ("hosted_work_item_sync_states"."minimum_cursor" >= 0),
	CONSTRAINT "hosted_work_item_sync_states_range_valid" CHECK ("hosted_work_item_sync_states"."minimum_cursor" <= "hosted_work_item_sync_states"."head_cursor")
);
--> statement-breakpoint
ALTER TABLE "work_items" ADD COLUMN "hosted_sync_cursor" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "hosted_work_item_sync_changes" ADD CONSTRAINT "hosted_work_item_sync_changes_state_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."hosted_work_item_sync_states"("workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hosted_work_item_sync_states" ADD CONSTRAINT "hosted_work_item_sync_states_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_hosted_sync_cursor_nonnegative" CHECK ("work_items"."hosted_sync_cursor" >= 0);--> statement-breakpoint
CREATE INDEX "hosted_work_item_sync_states_retention_idx" ON "hosted_work_item_sync_states" USING btree ("updated_at","workspace_id");--> statement-breakpoint
INSERT INTO public.hosted_work_item_sync_states (
	workspace_id,
	head_cursor,
	minimum_cursor,
	updated_at
)
SELECT id, 0, 0, pg_catalog.clock_timestamp()
FROM public.workspaces
ON CONFLICT (workspace_id) DO NOTHING;--> statement-breakpoint
INSERT INTO public.hosted_work_item_sync_capability (
	singleton,
	capture_enabled,
	enabled_at
)
VALUES (true, false, NULL);--> statement-breakpoint
CREATE FUNCTION public.capture_hosted_work_item_sync_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
DECLARE
	v_workspace_id uuid;
	v_cursor bigint;
	v_recorded_at timestamptz := pg_catalog.clock_timestamp();
	v_capture_enabled boolean;
BEGIN
	IF TG_OP = 'INSERT' AND NEW.hosted_sync_cursor <> 0 THEN
		RAISE EXCEPTION 'work item sync cursor is managed internally'
			USING ERRCODE = '23514', CONSTRAINT = 'work_items_hosted_sync_cursor_managed';
	END IF;
	IF TG_OP = 'UPDATE' THEN
		IF pg_catalog.pg_trigger_depth() > 1 THEN
			IF NEW.hosted_sync_cursor IS DISTINCT FROM OLD.hosted_sync_cursor
				AND ROW(
					NEW.id, NEW.workspace_id, NEW.parent_work_item_id, NEW.title, NEW.description,
					NEW.status, NEW.priority, NEW.planning_duration_minutes, NEW.due_on,
					NEW.version, NEW.created_at, NEW.updated_at
				) IS NOT DISTINCT FROM ROW(
					OLD.id, OLD.workspace_id, OLD.parent_work_item_id, OLD.title, OLD.description,
					OLD.status, OLD.priority, OLD.planning_duration_minutes, OLD.due_on,
					OLD.version, OLD.created_at, OLD.updated_at
				) THEN
				RETURN NULL;
			END IF;
			RAISE EXCEPTION 'unexpected nested work item sync mutation'
				USING ERRCODE = '55000';
		END IF;
		IF NEW.id IS DISTINCT FROM OLD.id OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
			RAISE EXCEPTION 'work item sync identity is immutable'
				USING ERRCODE = '23514', CONSTRAINT = 'work_items_hosted_sync_identity_immutable';
		END IF;
		IF NEW.hosted_sync_cursor IS DISTINCT FROM OLD.hosted_sync_cursor THEN
			RAISE EXCEPTION 'work item sync cursor is managed internally'
				USING ERRCODE = '23514', CONSTRAINT = 'work_items_hosted_sync_cursor_managed';
		END IF;
		IF NEW IS NOT DISTINCT FROM OLD THEN
			RETURN NULL;
		END IF;
	END IF;

	v_workspace_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.workspace_id ELSE NEW.workspace_id END;
	IF TG_OP = 'DELETE' AND NOT EXISTS (
		SELECT 1 FROM public.workspaces WHERE id = v_workspace_id
	) THEN
		RETURN NULL;
	END IF;

	SELECT capability.capture_enabled
	INTO v_capture_enabled
	FROM public.hosted_work_item_sync_capability AS capability
	WHERE capability.singleton;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'hosted work item sync capability state is missing'
			USING ERRCODE = '55000';
	END IF;
	IF NOT v_capture_enabled THEN
		SELECT capability.capture_enabled
		INTO v_capture_enabled
		FROM public.hosted_work_item_sync_capability AS capability
		WHERE capability.singleton
		FOR SHARE;
		IF NOT FOUND THEN
			RAISE EXCEPTION 'hosted work item sync capability state is missing'
				USING ERRCODE = '55000';
		END IF;
		IF NOT v_capture_enabled THEN
			RETURN NULL;
		END IF;
	END IF;

	INSERT INTO public.hosted_work_item_sync_states (
		workspace_id,
		head_cursor,
		minimum_cursor,
		updated_at
	)
	VALUES (v_workspace_id, 1, 0, v_recorded_at)
	ON CONFLICT (workspace_id) DO UPDATE
	SET head_cursor = public.hosted_work_item_sync_states.head_cursor + 1,
		updated_at = EXCLUDED.updated_at
	RETURNING head_cursor INTO v_cursor;

	IF TG_OP = 'DELETE' THEN
		INSERT INTO public.hosted_work_item_sync_changes (
			workspace_id,
			cursor,
			kind,
			work_item_id,
			recorded_at
		)
		VALUES (v_workspace_id, v_cursor, 'delete', OLD.id, v_recorded_at);
		RETURN NULL;
	END IF;

	INSERT INTO public.hosted_work_item_sync_changes (
		workspace_id,
		cursor,
		kind,
		work_item_id,
		parent_work_item_id,
		title,
		description,
		status,
		priority,
		planning_duration_minutes,
		due_on,
		version,
		item_created_at,
		item_updated_at,
		recorded_at
	)
	VALUES (
		v_workspace_id,
		v_cursor,
		'upsert',
		NEW.id,
		NEW.parent_work_item_id,
		NEW.title,
		NEW.description,
		NEW.status,
		NEW.priority,
		NEW.planning_duration_minutes,
		NEW.due_on,
		NEW.version,
		NEW.created_at,
		NEW.updated_at,
		v_recorded_at
	);
	UPDATE public.work_items
	SET hosted_sync_cursor = v_cursor
	WHERE workspace_id = NEW.workspace_id
		AND id = NEW.id
		AND hosted_sync_cursor = NEW.hosted_sync_cursor;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'work item sync cursor stamp failed'
			USING ERRCODE = '55000';
	END IF;
	RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER work_items_capture_hosted_sync_change
AFTER INSERT OR UPDATE OR DELETE ON public.work_items
FOR EACH ROW
EXECUTE FUNCTION public.capture_hosted_work_item_sync_change();--> statement-breakpoint
CREATE FUNCTION public.protect_hosted_work_item_sync_capability()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
	IF TG_OP = 'UPDATE'
		AND OLD.singleton
		AND NEW.singleton
		AND NOT OLD.capture_enabled
		AND NEW.capture_enabled
		AND OLD.enabled_at IS NULL
		AND NEW.enabled_at IS NOT NULL THEN
		RETURN NEW;
	END IF;
	RAISE EXCEPTION 'hosted work item sync capture capability is immutable after enrollment'
		USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint
CREATE TRIGGER hosted_work_item_sync_capability_guard
BEFORE INSERT OR UPDATE OR DELETE ON public.hosted_work_item_sync_capability
FOR EACH ROW
EXECUTE FUNCTION public.protect_hosted_work_item_sync_capability();--> statement-breakpoint
CREATE FUNCTION public.protect_hosted_work_item_sync_change_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
	IF TG_OP = 'INSERT' AND pg_catalog.pg_trigger_depth() > 1 THEN
		RETURN NEW;
	END IF;
	IF TG_OP = 'DELETE' AND (
		NOT EXISTS (
			SELECT 1
			FROM public.hosted_work_item_sync_states
			WHERE workspace_id = OLD.workspace_id
		) OR EXISTS (
			SELECT 1
			FROM public.hosted_work_item_sync_states
			WHERE workspace_id = OLD.workspace_id
				AND minimum_cursor >= OLD.cursor
		)
	) THEN
		RETURN OLD;
	END IF;
	RAISE EXCEPTION 'hosted work item sync changes are immutable while retained'
		USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint
CREATE TRIGGER hosted_work_item_sync_changes_append_only
BEFORE INSERT OR UPDATE OR DELETE ON public.hosted_work_item_sync_changes
FOR EACH ROW
EXECUTE FUNCTION public.protect_hosted_work_item_sync_change_mutation();--> statement-breakpoint
CREATE FUNCTION public.protect_hosted_work_item_sync_state_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
	IF TG_OP = 'INSERT' THEN
		IF pg_catalog.pg_trigger_depth() > 1
			AND NEW.head_cursor IN (0, 1)
			AND NEW.minimum_cursor = 0 THEN
			RETURN NEW;
		END IF;
	ELSIF NEW.workspace_id IS NOT DISTINCT FROM OLD.workspace_id THEN
		IF pg_catalog.pg_trigger_depth() > 1
			AND NEW.head_cursor = OLD.head_cursor + 1
			AND NEW.minimum_cursor = OLD.minimum_cursor THEN
			RETURN NEW;
		END IF;
		IF NEW.head_cursor = OLD.head_cursor
			AND NEW.minimum_cursor > OLD.minimum_cursor
			AND (
				SELECT pg_catalog.count(*)
				FROM public.hosted_work_item_sync_changes
				WHERE workspace_id = OLD.workspace_id
					AND cursor > OLD.minimum_cursor
					AND cursor <= NEW.minimum_cursor
					AND recorded_at < pg_catalog.clock_timestamp() - INTERVAL '30 days'
			) = NEW.minimum_cursor - OLD.minimum_cursor THEN
			RETURN NEW;
		END IF;
	END IF;
	RAISE EXCEPTION 'hosted work item sync state transition is not allowed'
		USING ERRCODE = '55000';
END;
$$;--> statement-breakpoint
CREATE TRIGGER hosted_work_item_sync_states_write_guard
BEFORE INSERT OR UPDATE ON public.hosted_work_item_sync_states
FOR EACH ROW
EXECUTE FUNCTION public.protect_hosted_work_item_sync_state_write();--> statement-breakpoint
CREATE FUNCTION public.initialize_hosted_work_item_sync_state()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
	INSERT INTO public.hosted_work_item_sync_states (
		workspace_id,
		head_cursor,
		minimum_cursor,
		updated_at
	)
	VALUES (NEW.id, 0, 0, pg_catalog.clock_timestamp())
	ON CONFLICT (workspace_id) DO NOTHING;
	RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER workspaces_initialize_hosted_sync_state
AFTER INSERT ON public.workspaces
FOR EACH ROW
EXECUTE FUNCTION public.initialize_hosted_work_item_sync_state();--> statement-breakpoint
CREATE FUNCTION public.protect_hosted_work_item_sync_state_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog
AS $$
BEGIN
	IF EXISTS (SELECT 1 FROM public.workspaces WHERE id = OLD.workspace_id) THEN
		RAISE EXCEPTION 'hosted work item sync state cannot be deleted independently'
			USING ERRCODE = '55000';
	END IF;
	RETURN OLD;
END;
$$;--> statement-breakpoint
CREATE TRIGGER hosted_work_item_sync_states_delete_guard
BEFORE DELETE ON public.hosted_work_item_sync_states
FOR EACH ROW
EXECUTE FUNCTION public.protect_hosted_work_item_sync_state_delete();
