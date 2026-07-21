-- schedule-migration-review: destructive-data-change
-- schedule-migration-reason: accepted historical identity migrations need the byte bound without rewriting retained identity data
DO $$
BEGIN
	IF NOT EXISTS (
		SELECT 1
		FROM pg_catalog.pg_constraint
		WHERE conrelid = 'public.external_identities'::pg_catalog.regclass
			AND conname = 'external_identities_key_bytes_bounded'
	) THEN
		ALTER TABLE public.external_identities
			ADD CONSTRAINT external_identities_key_bytes_bounded
			CHECK (pg_catalog.octet_length(issuer) + pg_catalog.octet_length(subject) <= 2000)
			NOT VALID;
	END IF;
	IF NOT EXISTS (
		SELECT 1
		FROM public.external_identities
		WHERE pg_catalog.octet_length(issuer) + pg_catalog.octet_length(subject) > 2000
	) THEN
		ALTER TABLE public.external_identities
			VALIDATE CONSTRAINT external_identities_key_bytes_bounded;
	END IF;
END;
$$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS hosted_work_item_sync_states_retention_idx
	ON public.hosted_work_item_sync_states USING btree (updated_at, workspace_id);--> statement-breakpoint
-- schedule-migration-review: destructive-data-change
-- schedule-migration-reason: accepted historical sync migrations need the fail-closed cursor-state implementation
CREATE OR REPLACE FUNCTION public.capture_hosted_work_item_sync_change()
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

	UPDATE public.hosted_work_item_sync_states
	SET head_cursor = head_cursor + 1,
		updated_at = v_recorded_at
	WHERE workspace_id = v_workspace_id
	RETURNING head_cursor INTO v_cursor;
	IF NOT FOUND THEN
		RAISE EXCEPTION 'hosted work item sync state is missing'
			USING ERRCODE = '55000';
	END IF;

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
$$;
