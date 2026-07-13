CREATE TABLE "webhook_event_subscriptions" (
	"workspace_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"event_type" varchar(160) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_event_subscriptions_pk" PRIMARY KEY("workspace_id","endpoint_id","event_type"),
	CONSTRAINT "webhook_event_subscriptions_event_type_allowed" CHECK ("webhook_event_subscriptions"."event_type" = 'schedule.changed.v1')
);
--> statement-breakpoint
ALTER TABLE "webhook_event_subscriptions" ADD CONSTRAINT "webhook_event_subscriptions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_event_subscriptions" ADD CONSTRAINT "webhook_event_subscriptions_endpoint_tenant_fk" FOREIGN KEY ("workspace_id","endpoint_id") REFERENCES "public"."webhook_endpoints"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "webhook_event_subscriptions_workspace_event_idx" ON "webhook_event_subscriptions" USING btree ("workspace_id","event_type","endpoint_id");--> statement-breakpoint
CREATE FUNCTION "public".enforce_daily_plan_head_event_version() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
  IF NEW.version < OLD.version THEN
    RAISE EXCEPTION 'daily plan head version cannot decrease';
  END IF;

  IF NEW.current_plan_id IS DISTINCT FROM OLD.current_plan_id
    AND NEW.version IS NOT DISTINCT FROM OLD.version THEN
    RAISE EXCEPTION 'daily plan head current plan change requires a version advance';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER daily_plan_heads_event_version_guard
BEFORE UPDATE ON "daily_plan_heads"
FOR EACH ROW EXECUTE FUNCTION "public".enforce_daily_plan_head_event_version();--> statement-breakpoint
CREATE FUNCTION "public".enqueue_schedule_changed_webhooks() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
  v_event_id text;
  v_event_occurred_at timestamptz;
  v_event_time text;
  v_raw_body text;
  target record;
  v_delivery_id uuid;
  v_outbox_event_id uuid;
  v_audit_event_id uuid;
  v_inserted_count integer;
BEGIN
  IF TG_OP = 'UPDATE'
    AND NEW.version IS NOT DISTINCT FROM OLD.version THEN
    RETURN NULL;
  END IF;

  v_event_id := 'schedule.changed.v1:'
    || NEW.workspace_id::text || ':'
    || NEW.local_date::text || ':'
    || NEW.version::text;
  v_event_occurred_at := pg_catalog.clock_timestamp();
  v_event_time := pg_catalog.to_char(
    v_event_occurred_at AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
  );
  v_raw_body := pg_catalog.format(
    '{"specversion":"1.0","id":%s,"type":"schedule.changed.v1","time":%s,"data":{"workspaceId":%s,"date":%s,"headVersion":%s}}',
    pg_catalog.to_json(v_event_id)::text,
    pg_catalog.to_json(v_event_time)::text,
    pg_catalog.to_json(NEW.workspace_id::text)::text,
    pg_catalog.to_json(NEW.local_date::text)::text,
    NEW.version::text
  );

  -- Lock in the same endpoint-first order used by lifecycle/subscription APIs.
  -- SHARE conflicts with revocation/rotation/replacement while allowing fanout
  -- from independent daily-plan transactions to proceed concurrently.
  PERFORM endpoint.id
  FROM public.webhook_endpoints AS endpoint
  WHERE endpoint.workspace_id = NEW.workspace_id
    AND endpoint.status = 'active'
    AND EXISTS (
      SELECT 1
      FROM public.webhook_event_subscriptions AS subscription
      WHERE subscription.workspace_id = endpoint.workspace_id
        AND subscription.endpoint_id = endpoint.id
        AND subscription.event_type = 'schedule.changed.v1'
    )
    AND EXISTS (
      SELECT 1
      FROM public.webhook_endpoint_secrets AS secret
      WHERE secret.workspace_id = endpoint.workspace_id
        AND secret.endpoint_id = endpoint.id
        AND secret.status = 'active'
    )
  ORDER BY endpoint.id
  FOR SHARE OF endpoint;

  PERFORM subscription.endpoint_id
  FROM public.webhook_event_subscriptions AS subscription
  WHERE subscription.workspace_id = NEW.workspace_id
    AND subscription.event_type = 'schedule.changed.v1'
  ORDER BY subscription.endpoint_id
  FOR SHARE OF subscription;

  PERFORM secret.id
  FROM public.webhook_endpoint_secrets AS secret
  JOIN public.webhook_event_subscriptions AS subscription
    ON subscription.workspace_id = secret.workspace_id
    AND subscription.endpoint_id = secret.endpoint_id
    AND subscription.event_type = 'schedule.changed.v1'
  JOIN public.webhook_endpoints AS endpoint
    ON endpoint.workspace_id = secret.workspace_id
    AND endpoint.id = secret.endpoint_id
    AND endpoint.status = 'active'
  WHERE secret.workspace_id = NEW.workspace_id
    AND secret.status = 'active'
  ORDER BY secret.endpoint_id, secret.id
  FOR SHARE OF secret;

  FOR target IN
    SELECT endpoint.id AS endpoint_id, secret.id AS secret_id
    FROM public.webhook_event_subscriptions AS subscription
    JOIN public.webhook_endpoints AS endpoint
      ON endpoint.workspace_id = subscription.workspace_id
      AND endpoint.id = subscription.endpoint_id
      AND endpoint.status = 'active'
    JOIN public.webhook_endpoint_secrets AS secret
      ON secret.workspace_id = endpoint.workspace_id
      AND secret.endpoint_id = endpoint.id
      AND secret.status = 'active'
    WHERE subscription.workspace_id = NEW.workspace_id
      AND subscription.event_type = 'schedule.changed.v1'
    ORDER BY endpoint.id
  LOOP
    v_delivery_id := pg_catalog.gen_random_uuid();
    v_outbox_event_id := pg_catalog.gen_random_uuid();
    v_audit_event_id := pg_catalog.gen_random_uuid();

    WITH delivery AS (
      INSERT INTO public.webhook_deliveries (
        id,
        workspace_id,
        endpoint_id,
        secret_id,
        event_id,
        event_type,
        event_occurred_at,
        raw_body,
        body_sha256,
        created_at
      )
      VALUES (
        v_delivery_id,
        NEW.workspace_id,
        target.endpoint_id,
        target.secret_id,
        v_event_id,
        'schedule.changed.v1',
        v_event_occurred_at,
        v_raw_body,
        pg_catalog.encode(public.digest(v_raw_body, 'sha256'), 'hex'),
        v_event_occurred_at
      )
      ON CONFLICT (workspace_id, endpoint_id, event_id) DO NOTHING
      RETURNING id, workspace_id, endpoint_id, event_id, event_type
    ), outbox AS (
      INSERT INTO public.outbox_events (
        id,
        workspace_id,
        topic,
        payload,
        webhook_delivery_id,
        available_at,
        created_at
      )
      SELECT
        v_outbox_event_id,
        delivery.workspace_id,
        'webhook.delivery.v1',
        pg_catalog.jsonb_build_object('deliveryId', delivery.id::text),
        delivery.id,
        v_event_occurred_at,
        v_event_occurred_at
      FROM delivery
      RETURNING id, webhook_delivery_id
    ), audit AS (
      INSERT INTO public.audit_events (
        id,
        workspace_id,
        actor_id,
        action,
        entity_type,
        entity_id,
        data,
        occurred_at
      )
      SELECT
        v_audit_event_id,
        delivery.workspace_id,
        NULL,
        'webhook.delivery.enqueued',
        'webhook_delivery',
        delivery.id,
        pg_catalog.jsonb_build_object(
          'endpointId', delivery.endpoint_id::text,
          'eventId', delivery.event_id,
          'eventType', delivery.event_type,
          'outboxEventId', outbox.id::text
        ),
        v_event_occurred_at
      FROM delivery
      JOIN outbox ON outbox.webhook_delivery_id = delivery.id
      RETURNING id
    )
    SELECT count(*)::integer INTO v_inserted_count FROM audit;
  END LOOP;

  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER daily_plan_heads_schedule_changed_webhooks
AFTER INSERT OR UPDATE ON "daily_plan_heads"
FOR EACH ROW EXECUTE FUNCTION "public".enqueue_schedule_changed_webhooks();
