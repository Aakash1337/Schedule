import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { DatabaseConnection } from "./database.js";
import {
  WEBHOOK_DELIVERY_TOPIC,
  activatePendingWebhookSecret,
  createWebhookEndpoint,
  enqueueWebhookTestDelivery,
  listWebhookDeadLetters,
  loadWebhookDispatchRecord,
  prepareWebhookSecretRotation,
  redriveWebhookDelivery,
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
    const { connection, captures } = createConnection([[deliveryRow]]);
    const result = await enqueueWebhookTestDelivery(connection, {
      workspaceId,
      endpointId,
      eventId: "event-1",
      eventType: "webhook.test",
      eventOccurredAt: now,
      rawBody,
    });

    expect(result).toMatchObject({ rawBody, bodySha256: deliveryRow.body_sha256, outboxEventId });
    const query = captures[0]?.text;
    expect(query).toContain("insert into webhook_deliveries");
    expect(query).toContain("insert into outbox_events");
    expect(query).toContain("returning delivery.id, delivery.workspace_id");
    expect(query).toContain("returning outbox_event.id, outbox_event.webhook_delivery_id");
    expect(query).toContain("jsonb_build_object('deliveryId', delivery.id::text)");
    expect(captures[0]?.values).toContain(WEBHOOK_DELIVERY_TOPIC);
    expect(query).toContain("webhook.delivery.enqueued");
    expect(captures[0]?.values).toContain(deliveryRow.body_sha256);
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
