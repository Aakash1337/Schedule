import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const migrationPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../drizzle/0018_fancy_human_torch.sql",
);
const automaticEventsMigrationPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../drizzle/0019_conscious_prima.sql",
);

describe("webhook persistence migration guards", () => {
  it("makes deliveries immutable for both direct writes and deletes", async () => {
    const migration = await readFile(migrationPath, "utf8");

    expect(migration).toContain('CREATE FUNCTION "public".prevent_webhook_delivery_mutation()');
    expect(migration).toContain('BEFORE UPDATE OR DELETE ON "webhook_deliveries"');
  });

  it("guards encrypted secret material and permits only lifecycle transitions", async () => {
    const migration = await readFile(migrationPath, "utf8");

    expect(migration).toContain(
      'CREATE FUNCTION "public".enforce_webhook_endpoint_secret_lifecycle()',
    );
    expect(migration).toContain("NEW.secret_envelope IS DISTINCT FROM OLD.secret_envelope");
    expect(migration).toContain("OLD.status = 'pending'");
    expect(migration).toContain("OLD.status = 'active'");
  });

  it("makes endpoint identity immutable and revocation terminal", async () => {
    const migration = await readFile(migrationPath, "utf8");

    expect(migration).toContain('CREATE FUNCTION "public".enforce_webhook_endpoint_lifecycle()');
    expect(migration).toContain("NEW.url IS DISTINCT FROM OLD.url");
    expect(migration).toContain("webhook endpoint revocation is terminal");
  });
});

describe("automatic schedule webhook migration guards", () => {
  it("stores an exact tenant-bound opt-in allowlist", async () => {
    const migration = await readFile(automaticEventsMigrationPath, "utf8");

    expect(migration).toContain('CREATE TABLE "webhook_event_subscriptions"');
    expect(migration).toContain('PRIMARY KEY("workspace_id","endpoint_id","event_type")');
    expect(migration).toContain(
      'CONSTRAINT "webhook_event_subscriptions_endpoint_tenant_fk" FOREIGN KEY ("workspace_id","endpoint_id")',
    );
    expect(migration).toContain(
      'CHECK ("webhook_event_subscriptions"."event_type" = \'schedule.changed.v1\')',
    );
  });

  it("uses a schema-qualified trigger with a constrained search path and endpoint-first locks", async () => {
    const migration = await readFile(automaticEventsMigrationPath, "utf8");

    expect(migration).toContain(
      'CREATE FUNCTION "public".enqueue_schedule_changed_webhooks() RETURNS trigger',
    );
    expect(migration).toContain("SET search_path = pg_catalog");
    expect(migration).not.toContain("SET search_path = pg_catalog, public");
    expect(migration).toContain("FROM public.webhook_endpoints AS endpoint");
    expect(migration).toContain("FROM public.webhook_event_subscriptions AS subscription");
    expect(migration).toContain("FROM public.webhook_endpoint_secrets AS secret");
    expect(migration).toContain("FOR SHARE OF endpoint");
    expect(migration).toContain("FOR SHARE OF subscription");
    expect(migration).toContain("FOR SHARE OF secret");
    expect(migration).toContain('AFTER INSERT OR UPDATE ON "daily_plan_heads"');
    expect(migration).toContain(
      'CREATE FUNCTION "public".enforce_daily_plan_head_event_version() RETURNS trigger',
    );
    expect(migration).toContain('BEFORE UPDATE ON "daily_plan_heads"');
    expect(migration).toContain("NEW.version < OLD.version");
    expect(migration).toContain("NEW.current_plan_id IS DISTINCT FROM OLD.current_plan_id");
  });

  it("no-ops for irrelevant head updates and deduplicates deterministic event IDs", async () => {
    const migration = await readFile(automaticEventsMigrationPath, "utf8");

    expect(migration).toContain("NEW.version IS NOT DISTINCT FROM OLD.version");
    expect(migration).toContain("'schedule.changed.v1:'");
    expect(migration).toContain("|| NEW.local_date::text || ':'");
    expect(migration).toContain("|| NEW.version::text");
    expect(migration).toContain("ON CONFLICT (workspace_id, endpoint_id, event_id) DO NOTHING");
  });

  it("builds one privacy-thin exact body and atomically queues and audits each delivery", async () => {
    const migration = await readFile(automaticEventsMigrationPath, "utf8");
    const bodyStart = migration.indexOf("v_raw_body := pg_catalog.format(");
    const bodyEnd = migration.indexOf("-- Lock in the same endpoint-first order", bodyStart);
    const bodyBuilder = migration.slice(bodyStart, bodyEnd);

    expect(bodyBuilder).toContain(
      '{"specversion":"1.0","id":%s,"type":"schedule.changed.v1","time":%s,"data":{"workspaceId":%s,"date":%s,"headVersion":%s}}',
    );
    expect(bodyBuilder).not.toMatch(/title|content|reason|metadata|planId|itemId/i);
    expect(migration).toContain("pg_catalog.encode(public.digest(v_raw_body, 'sha256'), 'hex')");
    expect(migration).toMatch(
      /body_sha256,\s+created_at\s+\)[\s\S]*pg_catalog\.encode\(public\.digest\(v_raw_body, 'sha256'\), 'hex'\),\s+v_event_occurred_at/,
    );
    expect(migration).toMatch(
      /webhook_delivery_id,\s+available_at,\s+created_at\s+\)[\s\S]*delivery\.id,\s+v_event_occurred_at,\s+v_event_occurred_at/,
    );
    expect(migration).toMatch(
      /entity_id,\s+data,\s+occurred_at\s+\)[\s\S]*'outboxEventId', outbox\.id::text[\s\S]*v_event_occurred_at/,
    );
    expect(migration).toContain("INSERT INTO public.webhook_deliveries");
    expect(migration).toContain("INSERT INTO public.outbox_events");
    expect(migration).toContain("'webhook.delivery.v1'");
    expect(migration).toContain("INSERT INTO public.audit_events");
    expect(migration).toContain("'webhook.delivery.enqueued'");
  });
});
