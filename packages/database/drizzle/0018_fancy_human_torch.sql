CREATE EXTENSION IF NOT EXISTS pgcrypto;--> statement-breakpoint
CREATE TYPE "public"."webhook_endpoint_status" AS ENUM('active', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."webhook_secret_status" AS ENUM('pending', 'active', 'retired');--> statement-breakpoint
CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"secret_id" uuid NOT NULL,
	"event_id" varchar(160) NOT NULL,
	"event_type" varchar(160) NOT NULL,
	"event_occurred_at" timestamp with time zone NOT NULL,
	"raw_body" text NOT NULL,
	"body_sha256" varchar(64) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_deliveries_workspace_id_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "webhook_deliveries_workspace_endpoint_event_uq" UNIQUE("workspace_id","endpoint_id","event_id"),
	CONSTRAINT "webhook_deliveries_event_id_nonempty" CHECK (char_length(trim("webhook_deliveries"."event_id")) > 0),
	CONSTRAINT "webhook_deliveries_event_type_nonempty" CHECK (char_length(trim("webhook_deliveries"."event_type")) > 0),
	CONSTRAINT "webhook_deliveries_raw_body_json_bounded" CHECK (octet_length("webhook_deliveries"."raw_body") between 2 and 1048576 and jsonb_typeof("webhook_deliveries"."raw_body"::jsonb) in ('object', 'array')),
	CONSTRAINT "webhook_deliveries_body_sha256_matches" CHECK ("webhook_deliveries"."body_sha256" = encode(digest("webhook_deliveries"."raw_body", 'sha256'), 'hex')),
	CONSTRAINT "webhook_deliveries_event_time_not_future" CHECK ("webhook_deliveries"."event_occurred_at" <= "webhook_deliveries"."created_at" + interval '5 minutes')
);
--> statement-breakpoint
CREATE TABLE "webhook_endpoint_secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" "webhook_secret_status" DEFAULT 'pending' NOT NULL,
	"secret_envelope" jsonb NOT NULL,
	"activated_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_endpoint_secrets_workspace_endpoint_id_uq" UNIQUE("workspace_id","endpoint_id","id"),
	CONSTRAINT "webhook_endpoint_secrets_workspace_endpoint_version_uq" UNIQUE("workspace_id","endpoint_id","version"),
	CONSTRAINT "webhook_endpoint_secrets_version_positive" CHECK ("webhook_endpoint_secrets"."version" > 0),
	CONSTRAINT "webhook_endpoint_secrets_envelope_shape" CHECK (
        jsonb_typeof("webhook_endpoint_secrets"."secret_envelope") = 'object'
        and "webhook_endpoint_secrets"."secret_envelope" ?& array['version', 'masterKeyId', 'nonce', 'ciphertext', 'tag']
        and ("webhook_endpoint_secrets"."secret_envelope" - 'version' - 'masterKeyId' - 'nonce' - 'ciphertext' - 'tag') = '{}'::jsonb
        and "webhook_endpoint_secrets"."secret_envelope"->>'version' = 'v1'
        and jsonb_typeof("webhook_endpoint_secrets"."secret_envelope"->'masterKeyId') = 'string'
        and jsonb_typeof("webhook_endpoint_secrets"."secret_envelope"->'nonce') = 'string'
        and jsonb_typeof("webhook_endpoint_secrets"."secret_envelope"->'ciphertext') = 'string'
        and jsonb_typeof("webhook_endpoint_secrets"."secret_envelope"->'tag') = 'string'
        and "webhook_endpoint_secrets"."secret_envelope"->>'masterKeyId' ~ '^[a-z][a-z0-9_-]{0,31}$'
        and "webhook_endpoint_secrets"."secret_envelope"->>'nonce' ~ '^[A-Za-z0-9_-]{16}$'
        and "webhook_endpoint_secrets"."secret_envelope"->>'ciphertext' ~ '^[A-Za-z0-9_-]{43}$'
        and "webhook_endpoint_secrets"."secret_envelope"->>'tag' ~ '^[A-Za-z0-9_-]{22}$'
      ),
	CONSTRAINT "webhook_endpoint_secrets_lifecycle_consistent" CHECK (
        ("webhook_endpoint_secrets"."status" = 'pending' and "webhook_endpoint_secrets"."activated_at" is null and "webhook_endpoint_secrets"."retired_at" is null)
        or ("webhook_endpoint_secrets"."status" = 'active' and "webhook_endpoint_secrets"."activated_at" is not null and "webhook_endpoint_secrets"."retired_at" is null)
        or ("webhook_endpoint_secrets"."status" = 'retired' and "webhook_endpoint_secrets"."retired_at" is not null)
      ),
	CONSTRAINT "webhook_endpoint_secrets_activation_after_creation" CHECK ("webhook_endpoint_secrets"."activated_at" is null or "webhook_endpoint_secrets"."activated_at" >= "webhook_endpoint_secrets"."created_at"),
	CONSTRAINT "webhook_endpoint_secrets_retirement_after_creation" CHECK ("webhook_endpoint_secrets"."retired_at" is null or "webhook_endpoint_secrets"."retired_at" >= "webhook_endpoint_secrets"."created_at"),
	CONSTRAINT "webhook_endpoint_secrets_retirement_after_activation" CHECK ("webhook_endpoint_secrets"."activated_at" is null or "webhook_endpoint_secrets"."retired_at" is null or "webhook_endpoint_secrets"."retired_at" >= "webhook_endpoint_secrets"."activated_at")
);
--> statement-breakpoint
CREATE TABLE "webhook_endpoints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" varchar(160) NOT NULL,
	"url" varchar(2048) NOT NULL,
	"status" "webhook_endpoint_status" DEFAULT 'active' NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_endpoints_workspace_id_id_uq" UNIQUE("workspace_id","id"),
	CONSTRAINT "webhook_endpoints_name_nonempty" CHECK (char_length(trim("webhook_endpoints"."name")) > 0),
	CONSTRAINT "webhook_endpoints_name_printable" CHECK ("webhook_endpoints"."name" !~ '[[:cntrl:]]'),
	CONSTRAINT "webhook_endpoints_url_https" CHECK ("webhook_endpoints"."url" ~ '^https://[^[:space:]]+$'),
	CONSTRAINT "webhook_endpoints_revocation_consistent" CHECK (("webhook_endpoints"."status" = 'active' and "webhook_endpoints"."revoked_at" is null) or ("webhook_endpoints"."status" = 'revoked' and "webhook_endpoints"."revoked_at" is not null)),
	CONSTRAINT "webhook_endpoints_revocation_after_creation" CHECK ("webhook_endpoints"."revoked_at" is null or "webhook_endpoints"."revoked_at" >= "webhook_endpoints"."created_at"),
	CONSTRAINT "webhook_endpoints_updated_after_creation" CHECK ("webhook_endpoints"."updated_at" >= "webhook_endpoints"."created_at")
);
--> statement-breakpoint
ALTER TABLE "outbox_events" ADD COLUMN "webhook_delivery_id" uuid;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_tenant_fk" FOREIGN KEY ("workspace_id","endpoint_id") REFERENCES "public"."webhook_endpoints"("workspace_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_secret_tenant_fk" FOREIGN KEY ("workspace_id","endpoint_id","secret_id") REFERENCES "public"."webhook_endpoint_secrets"("workspace_id","endpoint_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoint_secrets" ADD CONSTRAINT "webhook_endpoint_secrets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoint_secrets" ADD CONSTRAINT "webhook_endpoint_secrets_endpoint_tenant_fk" FOREIGN KEY ("workspace_id","endpoint_id") REFERENCES "public"."webhook_endpoints"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_endpoints" ADD CONSTRAINT "webhook_endpoints_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "webhook_deliveries_workspace_created_idx" ON "webhook_deliveries" USING btree ("workspace_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_endpoint_secrets_one_active_uq" ON "webhook_endpoint_secrets" USING btree ("workspace_id","endpoint_id") WHERE "webhook_endpoint_secrets"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_endpoint_secrets_one_pending_uq" ON "webhook_endpoint_secrets" USING btree ("workspace_id","endpoint_id") WHERE "webhook_endpoint_secrets"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "webhook_endpoint_secrets_workspace_status_idx" ON "webhook_endpoint_secrets" USING btree ("workspace_id","status");--> statement-breakpoint
CREATE INDEX "webhook_endpoints_workspace_status_idx" ON "webhook_endpoints" USING btree ("workspace_id","status");--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_webhook_delivery_tenant_fk" FOREIGN KEY ("workspace_id","webhook_delivery_id") REFERENCES "public"."webhook_deliveries"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_events_webhook_delivery_uq" ON "outbox_events" USING btree ("webhook_delivery_id") WHERE "outbox_events"."webhook_delivery_id" is not null;--> statement-breakpoint
ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_webhook_delivery_payload" CHECK (
        ("outbox_events"."topic" = 'webhook.delivery.v1'
          and "outbox_events"."workspace_id" is not null
          and "outbox_events"."webhook_delivery_id" is not null
          and "outbox_events"."payload" = jsonb_build_object('deliveryId', "outbox_events"."webhook_delivery_id"::text))
        or ("outbox_events"."topic" <> 'webhook.delivery.v1' and "outbox_events"."webhook_delivery_id" is null)
      );
--> statement-breakpoint
CREATE FUNCTION "public".prevent_webhook_delivery_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'webhook_deliveries are immutable';
END;
$$;--> statement-breakpoint
CREATE TRIGGER webhook_deliveries_immutable_mutation
BEFORE UPDATE OR DELETE ON "webhook_deliveries"
FOR EACH ROW EXECUTE FUNCTION "public".prevent_webhook_delivery_mutation();--> statement-breakpoint
CREATE FUNCTION "public".enforce_webhook_endpoint_secret_lifecycle() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.endpoint_id IS DISTINCT FROM OLD.endpoint_id
    OR NEW.version IS DISTINCT FROM OLD.version
    OR NEW.secret_envelope IS DISTINCT FROM OLD.secret_envelope
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'webhook endpoint secret identity and encrypted material are immutable';
  END IF;

  IF OLD.status = 'pending'
    AND NEW.status = 'active'
    AND OLD.activated_at IS NULL
    AND OLD.retired_at IS NULL
    AND NEW.activated_at IS NOT NULL
    AND NEW.retired_at IS NULL THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'pending'
    AND NEW.status = 'retired'
    AND OLD.activated_at IS NULL
    AND OLD.retired_at IS NULL
    AND NEW.activated_at IS NULL
    AND NEW.retired_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'active'
    AND NEW.status = 'retired'
    AND NEW.activated_at IS NOT DISTINCT FROM OLD.activated_at
    AND OLD.retired_at IS NULL
    AND NEW.retired_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'invalid webhook endpoint secret lifecycle transition';
END;
$$;--> statement-breakpoint
CREATE TRIGGER webhook_endpoint_secrets_lifecycle_guard
BEFORE UPDATE ON "webhook_endpoint_secrets"
FOR EACH ROW EXECUTE FUNCTION "public".enforce_webhook_endpoint_secret_lifecycle();--> statement-breakpoint
CREATE FUNCTION "public".enforce_webhook_endpoint_lifecycle() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
    OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id
    OR NEW.name IS DISTINCT FROM OLD.name
    OR NEW.url IS DISTINCT FROM OLD.url
    OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'webhook endpoint identity and destination are immutable';
  END IF;

  IF OLD.status <> 'active'
    OR NEW.status <> 'revoked'
    OR OLD.revoked_at IS NOT NULL
    OR NEW.revoked_at IS NULL
    OR NEW.updated_at < OLD.updated_at THEN
    RAISE EXCEPTION 'webhook endpoint revocation is terminal';
  END IF;

  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER webhook_endpoints_lifecycle_guard
BEFORE UPDATE ON "webhook_endpoints"
FOR EACH ROW EXECUTE FUNCTION "public".enforce_webhook_endpoint_lifecycle();
