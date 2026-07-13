import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { DatabaseConnection } from "./database.js";
import {
  SCHEDULE_CHANGED_WEBHOOK_EVENT_TYPE,
  WEBHOOK_DELIVERY_TOPIC,
  activatePendingWebhookSecret,
  createWebhookEndpoint,
  enqueueWebhookTestDelivery,
  getWebhookEventSubscriptions,
  listWebhookEventSubscriptions,
  listWebhookDeadLetters,
  loadWebhookDispatchRecord,
  prepareWebhookSecretRotation,
  redriveWebhookDelivery,
  replaceWebhookEventSubscriptions,
  revokeWebhookEndpoint,
} from "./webhooks.js";

interface CapturedQuery {
  readonly text: string;
  readonly values: readonly unknown[];
}

type QueryRows = readonly Record<string, unknown>[];
type TaggedQuery = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<QueryRows>;

function createConnection(rows: readonly QueryRows[]): {
  readonly connection: DatabaseConnection;
  readonly captures: CapturedQuery[];
} {
  const queuedRows = [...rows];
  const captures: CapturedQuery[] = [];
  const query = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
    captures.push({ text: strings.join("?").replaceAll(/\s+/g, " ").trim(), values });
    return queuedRows.shift() ?? [];
  }) as TaggedQuery;
  const sql = Object.assign(query, {
    begin: async (operation: (tx: TaggedQuery) => Promise<unknown>) => operation(query),
  });
  return {
    connection: { db: {}, sql, close: async () => undefined } as unknown as DatabaseConnection,
    captures,
  };
}

const workspaceId = "00000000-0000-0000-0000-000000000001";
const endpointId = "00000000-0000-0000-0000-000000000002";
const secretId = "00000000-0000-0000-0000-000000000003";
const deliveryId = "00000000-0000-0000-0000-000000000004";
const outboxEventId = "00000000-0000-0000-0000-000000000005";
const now = new Date("2026-07-13T12:00:00.000Z");
const envelope = {
  version: "v1" as const,
  masterKeyId: "key-2026-07",
  nonce: "AbCdEfGhIjKlMnOp",
  ciphertext: "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcDe",
  tag: "AbCdEfGhIjKlMnOpQrStUv",
};

const endpointRow = {
  id: endpointId,
  workspace_id: workspaceId,
  name: "Hermes",
  url: "https://hooks.example.com/schedule",
  status: "active" as const,
  revoked_at: null,
  created_at: now,
  updated_at: now,
};

const secretRow = {
  id: secretId,
  workspace_id: workspaceId,
  endpoint_id: endpointId,
  version: 1,
  status: "pending" as const,
  secret_envelope: envelope,
  activated_at: null,
  retired_at: null,
  created_at: now,
};

describe("webhook persistence", () => {
  it("atomically provisions HTTPS endpoints with an active encrypted version-one secret", async () => {
    const { connection, captures } = createConnection([[endpointRow]]);

    await expect(
      createWebhookEndpoint(connection, {
        workspaceId,
        endpointId,
        secretId,
        name: endpointRow.name,
        url: endpointRow.url,
        secretEnvelope: envelope,
      }),
    ).resolves.toMatchObject({
      id: endpointId,
      workspaceId,
      name: endpointRow.name,
      url: endpointRow.url,
    });
    await expect(
      createWebhookEndpoint(connection, {
        workspaceId,
        endpointId,
        secretId,
        name: endpointRow.name,
        url: "http://example.test/hook",
        secretEnvelope: envelope,
      }),
    ).rejects.toThrow(/HTTPS/);
    await expect(
      createWebhookEndpoint(connection, {
        workspaceId,
        endpointId,
        secretId,
        name: endpointRow.name,
        url: "https://token@example.test/hook",
        secretEnvelope: envelope,
      }),
    ).rejects.toThrow(/credentials/);
    await expect(
      createWebhookEndpoint(connection, {
        workspaceId,
        endpointId,
        secretId,
        name: endpointRow.name,
        url: "https://receiver.home.arpa/hook",
        secretEnvelope: envelope,
      }),
    ).rejects.toThrow(/local\/reserved hostname/);
    expect(captures[0]?.text).toContain("insert into webhook_endpoints");
    expect(captures[0]?.text).toContain("insert into webhook_endpoint_secrets");
    expect(captures[0]?.text).toContain("'webhook.endpoint.created'");
    expect(captures[0]?.text).toContain("'secretId', ?::text");
    expect(captures[0]?.text).toContain("'masterKeyId', ?::text");
  });

  it("reads active endpoint subscription state without destinations or secrets", async () => {
    const stateRow = {
      workspace_id: workspaceId,
      endpoint_id: endpointId,
      event_types: [SCHEDULE_CHANGED_WEBHOOK_EVENT_TYPE],
    };
    const one = createConnection([[stateRow]]);
    await expect(
      getWebhookEventSubscriptions(one.connection, { workspaceId, endpointId }),
    ).resolves.toEqual([SCHEDULE_CHANGED_WEBHOOK_EVENT_TYPE]);
    expect(one.captures[0]?.text).toContain("endpoint.status = 'active'");
    expect(one.captures[0]?.text).not.toContain("endpoint.url");
    expect(one.captures[0]?.text).not.toContain("secret");

    const missing = createConnection([[]]);
    await expect(
      getWebhookEventSubscriptions(missing.connection, { workspaceId, endpointId }),
    ).resolves.toBeNull();

    const listed = createConnection([
      [stateRow, { ...stateRow, endpoint_id: deliveryId, event_types: [] }],
    ]);
    await expect(listWebhookEventSubscriptions(listed.connection, workspaceId)).resolves.toEqual([
      {
        workspaceId,
        endpointId,
        eventTypes: [SCHEDULE_CHANGED_WEBHOOK_EVENT_TYPE],
      },
      { workspaceId, endpointId: deliveryId, eventTypes: [] },
    ]);
    expect(listed.captures[0]?.text).not.toMatch(/endpoint\.(url|name)/);
    expect(listed.captures[0]?.text).not.toContain("secret");
  });

  it("strictly validates and atomically replaces the complete opt-in set", async () => {
    const changed = createConnection([[{ id: endpointId }], [], [], [], []]);
    await expect(
      replaceWebhookEventSubscriptions(changed.connection, {
        workspaceId,
        endpointId,
        eventTypes: [SCHEDULE_CHANGED_WEBHOOK_EVENT_TYPE],
      }),
    ).resolves.toEqual({
      workspaceId,
      endpointId,
      previousEventTypes: [],
      eventTypes: [SCHEDULE_CHANGED_WEBHOOK_EVENT_TYPE],
      changed: true,
    });
    expect(changed.captures[0]?.text).toContain("status = 'active'");
    expect(changed.captures[0]?.text).toContain("for update");
    expect(changed.captures[1]?.text).toContain("for update");
    expect(changed.captures[2]?.text).toContain("delete from webhook_event_subscriptions");
    expect(changed.captures[3]?.text).toContain("insert into webhook_event_subscriptions");
    expect(changed.captures[4]?.text).toContain("webhook.subscriptions.replaced");
    expect(changed.captures[4]?.text).not.toContain("url");
    expect(changed.captures[4]?.text).not.toContain("secret");

    const unchanged = createConnection([
      [{ id: endpointId }],
      [{ event_type: SCHEDULE_CHANGED_WEBHOOK_EVENT_TYPE }],
    ]);
    await expect(
      replaceWebhookEventSubscriptions(unchanged.connection, {
        workspaceId,
        endpointId,
        eventTypes: [SCHEDULE_CHANGED_WEBHOOK_EVENT_TYPE],
      }),
    ).resolves.toMatchObject({ changed: false });
    expect(unchanged.captures).toHaveLength(2);

    const absent = createConnection([[]]);
    await expect(
      replaceWebhookEventSubscriptions(absent.connection, {
        workspaceId,
        endpointId,
        eventTypes: [],
      }),
    ).resolves.toBeNull();
    expect(absent.captures).toHaveLength(1);

    const invalid = createConnection([]);
    await expect(
      replaceWebhookEventSubscriptions(invalid.connection, {
        workspaceId,
        endpointId,
        eventTypes: ["schedule.changed.v2"],
      }),
    ).rejects.toThrow(/unsupported webhook event type/);
    await expect(
      replaceWebhookEventSubscriptions(invalid.connection, {
        workspaceId,
        endpointId,
        eventTypes: [SCHEDULE_CHANGED_WEBHOOK_EVENT_TYPE, SCHEDULE_CHANGED_WEBHOOK_EVENT_TYPE],
      }),
    ).rejects.toThrow(/duplicates/);
    expect(invalid.captures).toHaveLength(0);
  });

  it("enforces exact encrypted-envelope shape before preparing a serialized rotation", async () => {
    const { connection, captures } = createConnection([[secretRow]]);
    await expect(
      prepareWebhookSecretRotation(connection, {
        workspaceId,
        endpointId,
        secretId,
        secretEnvelope: envelope,
      }),
    ).resolves.toMatchObject({ id: secretId, version: 1, status: "pending" });
    await expect(
      prepareWebhookSecretRotation(connection, {
        workspaceId,
        endpointId,
        secretId,
        secretEnvelope: { ...envelope, plaintext: "never" } as typeof envelope,
      }),
    ).rejects.toThrow(/only version/);
    await expect(
      prepareWebhookSecretRotation(connection, {
        workspaceId,
        endpointId,
        secretId,
        secretEnvelope: { ...envelope, masterKeyId: "Uppercase" },
      }),
    ).rejects.toThrow(/canonical encoding/);
    await expect(
      prepareWebhookSecretRotation(connection, {
        workspaceId,
        endpointId,
        secretId,
        secretEnvelope: { ...envelope, nonce: "AbCdEfGhIjKlMnO=" },
      }),
    ).rejects.toThrow(/canonical encoding/);
    await expect(
      prepareWebhookSecretRotation(connection, {
        workspaceId,
        endpointId,
        secretId,
        secretEnvelope: { ...envelope, ciphertext: `${envelope.ciphertext}x` },
      }),
    ).rejects.toThrow(/canonical encoding/);
    await expect(
      prepareWebhookSecretRotation(connection, {
        workspaceId,
        endpointId,
        secretId,
        secretEnvelope: { ...envelope, tag: "AbCdEfGhIjKlMnOpQrStU=" },
      }),
    ).rejects.toThrow(/canonical encoding/);
    expect(captures[0]?.text).toContain("for update");
    expect(captures[0]?.text).toContain("coalesce(( select max(secret.version)");
    expect(captures[0]?.text).toContain("pending.status = 'pending'");
    expect(captures[0]?.text).toContain("webhook.secret.rotation_prepared");
  });

  it("activates a pending secret by retiring the prior active one under the endpoint lock", async () => {
    const activeRow = { ...secretRow, status: "active" as const, activated_at: now };
    const { connection, captures } = createConnection([[activeRow]]);
    await expect(
      activatePendingWebhookSecret(connection, { workspaceId, endpointId, secretId }),
    ).resolves.toMatchObject({ id: secretId, status: "active" });
    expect(captures[0]?.text).toContain("for update");
    expect(captures[0]?.text).toContain("set status = 'retired'");
    expect(captures[0]?.text).toContain("from endpoint, target");
    expect(captures[0]?.text).toContain("set status = 'active'");
    expect(captures[0]?.text).toContain("from target, retired");
    expect(captures[0]?.text).toContain("returning secret.id, secret.workspace_id");
    expect(captures[0]?.text).toContain("webhook.secret.rotation_activated");
  });

  it("revokes an endpoint and retires all usable secrets atomically", async () => {
    const { connection, captures } = createConnection([[{ id: endpointId }]]);
    await expect(revokeWebhookEndpoint(connection, { workspaceId, endpointId })).resolves.toBe(
      true,
    );
    expect(captures[0]?.text).toContain("status = 'revoked'");
    expect(captures[0]?.text).toContain("secret.status in ('pending', 'active')");
    expect(captures[0]?.text).toContain("webhook.endpoint.revoked");
  });

  it("enqueues exact JSON bytes with a matching SHA-256, thin outbox payload, and audit record", async () => {
    const rawBody = '{"type":"webhook.test","value":1}';
    const deliveryRow = {
      id: deliveryId,
      workspace_id: workspaceId,
      endpoint_id: endpointId,
      secret_id: secretId,
      event_id: "event-1",
      event_type: "webhook.test",
      event_occurred_at: now,
      raw_body: rawBody,
      body_sha256: createHash("sha256").update(rawBody).digest("hex"),
      created_at: now,
      outbox_event_id: outboxEventId,
    };
    const { connection, captures } = createConnection([
      [{ id: endpointId }],
      [{ endpoint_id: endpointId, secret_id: secretId }],
      [deliveryRow],
    ]);
    const result = await enqueueWebhookTestDelivery(connection, {
      workspaceId,
      endpointId,
      eventId: "event-1",
      eventType: "webhook.test",
      eventOccurredAt: now,
      rawBody,
    });

    expect(result).toMatchObject({ rawBody, bodySha256: deliveryRow.body_sha256, outboxEventId });
    expect(captures[0]?.text).toContain("from webhook_endpoints");
    expect(captures[0]?.text).toContain("for share");
    expect(captures[0]?.text).not.toContain("webhook_endpoint_secrets");
    expect(captures[1]?.text).toContain("from webhook_endpoint_secrets");
    expect(captures[1]?.text).toContain("for share");
    const query = captures[2]?.text;
    expect(query).toContain("insert into webhook_deliveries");
    expect(query).toContain("insert into outbox_events");
    expect(query).toContain("returning delivery.id, delivery.workspace_id");
    expect(query).toContain("returning outbox_event.id, outbox_event.webhook_delivery_id");
    expect(query).toContain("jsonb_build_object('deliveryId', delivery.id::text)");
    expect(captures[2]?.values).toContain(WEBHOOK_DELIVERY_TOPIC);
    expect(query).toContain("webhook.delivery.enqueued");
    expect(captures[2]?.values).toContain(deliveryRow.body_sha256);
    await expect(
      enqueueWebhookTestDelivery(connection, {
        workspaceId,
        endpointId,
        eventId: "event-2",
        eventType: "webhook.test",
        eventOccurredAt: now,
        rawBody: "not JSON",
      }),
    ).rejects.toThrow(/JSON object or array/);

    const missingEndpoint = createConnection([[]]);
    await expect(
      enqueueWebhookTestDelivery(missingEndpoint.connection, {
        workspaceId,
        endpointId,
        eventId: "missing-endpoint",
        eventType: "webhook.test",
        eventOccurredAt: now,
        rawBody,
      }),
    ).resolves.toBeNull();
    expect(missingEndpoint.captures).toHaveLength(1);

    const missingSecret = createConnection([[{ id: endpointId }], []]);
    await expect(
      enqueueWebhookTestDelivery(missingSecret.connection, {
        workspaceId,
        endpointId,
        eventId: "missing-secret",
        eventType: "webhook.test",
        eventOccurredAt: now,
        rawBody,
      }),
    ).resolves.toBeNull();
    expect(missingSecret.captures).toHaveLength(2);
  });

  it("loads dispatch state only through matching outbox, delivery, workspace, endpoint, and secret records", async () => {
    const dispatchRow = {
      id: deliveryId,
      workspace_id: workspaceId,
      endpoint_id: endpointId,
      secret_id: secretId,
      event_id: "event-1",
      event_type: "webhook.test",
      event_occurred_at: now,
      raw_body: "{}",
      body_sha256: createHash("sha256").update("{}").digest("hex"),
      created_at: now,
      outbox_event_id: outboxEventId,
      endpoint_url: endpointRow.url,
      secret_envelope: envelope,
    };
    const { connection, captures } = createConnection([[dispatchRow]]);
    await expect(
      loadWebhookDispatchRecord(connection, { workspaceId, outboxEventId, deliveryId }),
    ).resolves.toMatchObject({ endpointUrl: endpointRow.url, delivery: { id: deliveryId } });
    const query = captures[0]?.text;
    expect(query).toContain("delivery.workspace_id = outbox.workspace_id");
    expect(query).toContain("endpoint.status = 'active'");
    expect(query).toContain("secret.status in ('active', 'retired')");
    expect(query).toContain("outbox.topic = ?");
    expect(captures[0]?.values).toContain(WEBHOOK_DELIVERY_TOPIC);
  });

  it("returns dead-letter metadata only and redrives without copying a delivery", async () => {
    const deadLetter = {
      delivery_id: deliveryId,
      outbox_event_id: outboxEventId,
      endpoint_id: endpointId,
      event_id: "event-1",
      event_type: "webhook.test",
      event_occurred_at: now,
      created_at: now,
      attempts: 4,
      last_error: "connect timeout",
    };
    const listed = createConnection([[deadLetter]]);
    await expect(listWebhookDeadLetters(listed.connection, { workspaceId })).resolves.toEqual([
      {
        deliveryId,
        outboxEventId,
        endpointId,
        eventId: "event-1",
        eventType: "webhook.test",
        eventOccurredAt: now,
        createdAt: now,
        attempts: 4,
        lastError: "connect timeout",
      },
    ]);
    expect(listed.captures[0]?.text).not.toContain("raw_body");
    expect(listed.captures[0]?.text).not.toContain("secret_envelope");

    const redrive = createConnection([[{ id: outboxEventId }]]);
    await expect(
      redriveWebhookDelivery(redrive.connection, { workspaceId, deliveryId }),
    ).resolves.toBe(true);
    expect(redrive.captures[0]?.text).toContain("set status = 'pending', attempts = 0");
    expect(redrive.captures[0]?.text).toContain("webhook.delivery.redriven");
    expect(redrive.captures[0]?.text).not.toContain("insert into webhook_deliveries");
  });
});
