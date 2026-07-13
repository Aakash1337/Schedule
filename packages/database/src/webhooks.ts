import { createHash, randomUUID } from "node:crypto";
import { isIP } from "node:net";

import type { DatabaseConnection } from "./database.js";

export const WEBHOOK_DELIVERY_TOPIC = "webhook.delivery.v1";
export const MAX_WEBHOOK_RAW_BODY_BYTES = 1_048_576;

export interface WebhookSecretEnvelope {
  readonly version: "v1";
  readonly masterKeyId: string;
  readonly nonce: string;
  readonly ciphertext: string;
  readonly tag: string;
}

export interface WebhookEndpoint {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly url: string;
  readonly status: "active" | "revoked";
  readonly revokedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface WebhookEndpointSecret {
  readonly id: string;
  readonly workspaceId: string;
  readonly endpointId: string;
  readonly version: number;
  readonly status: "pending" | "active" | "retired";
  readonly secretEnvelope: WebhookSecretEnvelope;
  readonly activatedAt: Date | null;
  readonly retiredAt: Date | null;
  readonly createdAt: Date;
}

export interface WebhookDelivery {
  readonly id: string;
  readonly workspaceId: string;
  readonly endpointId: string;
  readonly secretId: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly eventOccurredAt: Date;
  readonly rawBody: string;
  readonly bodySha256: string;
  readonly createdAt: Date;
  readonly outboxEventId: string;
}

export interface WebhookDispatchRecord {
  readonly delivery: WebhookDelivery;
  readonly endpointUrl: string;
  /** Encrypted material only; callers must decrypt it just in time for signing. */
  readonly secretEnvelope: WebhookSecretEnvelope;
}

export interface WebhookDeadLetter {
  readonly deliveryId: string;
  readonly outboxEventId: string;
  readonly endpointId: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly eventOccurredAt: Date;
  readonly createdAt: Date;
  readonly attempts: number;
  readonly lastError: string;
}

interface EndpointRow {
  id: string;
  workspace_id: string;
  name: string;
  url: string;
  status: "active" | "revoked";
  revoked_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface SecretRow {
  id: string;
  workspace_id: string;
  endpoint_id: string;
  version: number;
  status: "pending" | "active" | "retired";
  secret_envelope: WebhookSecretEnvelope;
  activated_at: Date | null;
  retired_at: Date | null;
  created_at: Date;
}

interface DeliveryRow {
  id: string;
  workspace_id: string;
  endpoint_id: string;
  secret_id: string;
  event_id: string;
  event_type: string;
  event_occurred_at: Date;
  raw_body: string;
  body_sha256: string;
  created_at: Date;
  outbox_event_id: string;
}

interface DispatchRow extends DeliveryRow {
  endpoint_url: string;
  secret_envelope: WebhookSecretEnvelope;
}

interface DeadLetterRow {
  delivery_id: string;
  outbox_event_id: string;
  endpoint_id: string;
  event_id: string;
  event_type: string;
  event_occurred_at: Date;
  created_at: Date;
  attempts: number;
  last_error: string;
}

interface IdRow {
  id: string;
}

function assertNonEmptyBounded(name: string, value: string, maximum: number): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > maximum) {
    throw new RangeError(`${name} must contain between 1 and ${maximum} characters`);
  }
  return normalized;
}

function assertWebhookUrl(url: string): string {
  const normalized = assertNonEmptyBounded("url", url, 2_048);
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new RangeError("url must be an absolute HTTPS URL");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    parsed.hostname.length === 0 ||
    parsed.hash.length > 0 ||
    (parsed.port.length > 0 && parsed.port !== "443") ||
    /\s/.test(normalized)
  ) {
    throw new RangeError("url must be an absolute HTTPS URL without user credentials");
  }
  const hostname = parsed.hostname.toLowerCase();
  if (
    isIP(hostname) !== 0 ||
    hostname === "localhost" ||
    hostname === "home.arpa" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".home.arpa") ||
    hostname.endsWith(".test") ||
    hostname.endsWith(".example") ||
    hostname.endsWith(".invalid")
  ) {
    throw new RangeError("url must not use an IP literal or local/reserved hostname");
  }
  return normalized;
}

function assertEnvelope(envelope: WebhookSecretEnvelope): WebhookSecretEnvelope {
  if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new RangeError("secretEnvelope must be an encrypted envelope object");
  }
  const keys = Object.keys(envelope).sort();
  if (keys.join(",") !== "ciphertext,masterKeyId,nonce,tag,version") {
    throw new RangeError(
      "secretEnvelope must contain only version, masterKeyId, nonce, ciphertext, and tag",
    );
  }
  if (envelope.version !== "v1") {
    throw new RangeError("secretEnvelope.version must be v1");
  }
  return {
    version: "v1",
    masterKeyId: assertCanonicalPart(
      "secretEnvelope.masterKeyId",
      envelope.masterKeyId,
      /^[a-z][a-z0-9_-]{0,31}$/,
    ),
    nonce: assertCanonicalPart("secretEnvelope.nonce", envelope.nonce, /^[A-Za-z0-9_-]{16}$/),
    ciphertext: assertCanonicalPart(
      "secretEnvelope.ciphertext",
      envelope.ciphertext,
      /^[A-Za-z0-9_-]{43}$/,
    ),
    tag: assertCanonicalPart("secretEnvelope.tag", envelope.tag, /^[A-Za-z0-9_-]{22}$/),
  };
}

function assertCanonicalPart(name: string, value: string, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new RangeError(`${name} is not in the required canonical encoding`);
  }
  return value;
}

function assertValidDate(name: string, value: Date): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new RangeError(`${name} must be a valid Date`);
  }
  return value;
}

function assertRawJsonBody(rawBody: string): string {
  if (typeof rawBody !== "string") {
    throw new TypeError("rawBody must be a string");
  }
  const byteLength = Buffer.byteLength(rawBody, "utf8");
  if (byteLength < 2 || byteLength > MAX_WEBHOOK_RAW_BODY_BYTES) {
    throw new RangeError(
      `rawBody must contain between 2 and ${MAX_WEBHOOK_RAW_BODY_BYTES} UTF-8 bytes`,
    );
  }
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (parsed === null || typeof parsed !== "object") {
      throw new RangeError("rawBody must encode a JSON object or array");
    }
  } catch (error) {
    if (error instanceof RangeError) throw error;
    throw new RangeError("rawBody must encode a JSON object or array", { cause: error });
  }
  return rawBody;
}

function mapEndpoint(row: EndpointRow): WebhookEndpoint {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    name: row.name,
    url: row.url,
    status: row.status,
    revokedAt: row.revoked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSecret(row: SecretRow): WebhookEndpointSecret {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    endpointId: row.endpoint_id,
    version: row.version,
    status: row.status,
    secretEnvelope: assertEnvelope(row.secret_envelope),
    activatedAt: row.activated_at,
    retiredAt: row.retired_at,
    createdAt: row.created_at,
  };
}

function mapDelivery(row: DeliveryRow): WebhookDelivery {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    endpointId: row.endpoint_id,
    secretId: row.secret_id,
    eventId: row.event_id,
    eventType: row.event_type,
    eventOccurredAt: row.event_occurred_at,
    rawBody: row.raw_body,
    bodySha256: row.body_sha256,
    createdAt: row.created_at,
    outboxEventId: row.outbox_event_id,
  };
}

export async function createWebhookEndpoint(
  connection: DatabaseConnection,
  input: {
    readonly workspaceId: string;
    /** Caller-generated IDs are part of the encryption AAD contract. */
    readonly endpointId: string;
    readonly secretId: string;
    readonly name: string;
    readonly url: string;
    readonly secretEnvelope: WebhookSecretEnvelope;
    readonly actorId?: string | null;
  },
): Promise<WebhookEndpoint> {
  const url = assertWebhookUrl(input.url);
  const name = assertNonEmptyBounded("name", input.name, 160);
  if (/\p{Cc}/u.test(name)) {
    throw new RangeError("name must not contain control characters");
  }
  const secretEnvelope = assertEnvelope(input.secretEnvelope);
  const auditEventId = randomUUID();
  const rows = await connection.sql.begin(async (transaction) => {
    return transaction<EndpointRow[]>`
      with endpoint as (
        insert into webhook_endpoints (id, workspace_id, name, url)
        values (${input.endpointId}::uuid, ${input.workspaceId}::uuid, ${name}, ${url})
        returning id, workspace_id, name, url, status, revoked_at, created_at, updated_at
      ), secret as (
        insert into webhook_endpoint_secrets (
          id, workspace_id, endpoint_id, version, status, secret_envelope, activated_at
        )
        select
          ${input.secretId}::uuid,
          endpoint.workspace_id,
          endpoint.id,
          1,
          'active'::webhook_secret_status,
          ${JSON.stringify(secretEnvelope)}::jsonb,
          clock_timestamp()
        from endpoint
      ), audit as (
        insert into audit_events (id, workspace_id, actor_id, action, entity_type, entity_id, data)
        select
          ${auditEventId}::uuid,
          endpoint.workspace_id,
          ${input.actorId ?? null}::uuid,
          'webhook.endpoint.created',
          'webhook_endpoint',
          endpoint.id,
          jsonb_build_object(
            'secretId', ${input.secretId}::text,
            'secretVersion', 1,
            'masterKeyId', ${secretEnvelope.masterKeyId}::text
          )
        from endpoint
      )
      select * from endpoint
    `;
  });
  const row = rows[0];
  if (!row) throw new Error("Webhook endpoint creation did not return a row");
  return mapEndpoint(row);
}

export async function listWebhookEndpoints(
  connection: DatabaseConnection,
  workspaceId: string,
): Promise<readonly WebhookEndpoint[]> {
  const rows = await connection.sql<EndpointRow[]>`
    select id, workspace_id, name, url, status, revoked_at, created_at, updated_at
    from webhook_endpoints
    where workspace_id = ${workspaceId}::uuid
    order by created_at, id
  `;
  return rows.map(mapEndpoint);
}

/** Creates the next strictly increasing pending secret version, if the endpoint has no pending rotation. */
export async function prepareWebhookSecretRotation(
  connection: DatabaseConnection,
  input: {
    readonly workspaceId: string;
    readonly endpointId: string;
    /** Caller-generated because the endpoint and secret IDs are AAD-bound. */
    readonly secretId: string;
    readonly secretEnvelope: WebhookSecretEnvelope;
    readonly actorId?: string | null;
  },
): Promise<WebhookEndpointSecret | null> {
  const envelope = assertEnvelope(input.secretEnvelope);
  const auditEventId = randomUUID();
  const rows = await connection.sql.begin(async (transaction) => {
    return transaction<SecretRow[]>`
      with endpoint as (
        select id
        from webhook_endpoints
        where id = ${input.endpointId}::uuid and workspace_id = ${input.workspaceId}::uuid and status = 'active'
        for update
      ), inserted as (
        insert into webhook_endpoint_secrets as secret (id, workspace_id, endpoint_id, version, status, secret_envelope)
        select
          ${input.secretId}::uuid,
          ${input.workspaceId}::uuid,
          endpoint.id,
          coalesce((
            select max(secret.version)
            from webhook_endpoint_secrets as secret
            where secret.workspace_id = ${input.workspaceId}::uuid and secret.endpoint_id = endpoint.id
          ), 0) + 1,
          'pending'::webhook_secret_status,
          ${JSON.stringify(envelope)}::jsonb
        from endpoint
        where not exists (
          select 1
          from webhook_endpoint_secrets as pending
          where pending.workspace_id = ${input.workspaceId}::uuid
            and pending.endpoint_id = endpoint.id
            and pending.status = 'pending'
        )
        returning
          secret.id,
          secret.workspace_id,
          secret.endpoint_id,
          secret.version,
          secret.status,
          secret.secret_envelope,
          secret.activated_at,
          secret.retired_at,
          secret.created_at
      ), audit as (
        insert into audit_events (id, workspace_id, actor_id, action, entity_type, entity_id, data)
        select
          ${auditEventId}::uuid,
          inserted.workspace_id,
          ${input.actorId ?? null}::uuid,
          'webhook.secret.rotation_prepared',
          'webhook_endpoint_secret',
          inserted.id,
          jsonb_build_object(
            'endpointId', inserted.endpoint_id::text,
            'version', inserted.version,
            'masterKeyId', inserted.secret_envelope->>'masterKeyId'
          )
        from inserted
      )
      select * from inserted
    `;
  });
  const row = rows[0];
  return row ? mapSecret(row) : null;
}

/** Atomically retires the previous active secret and activates one pending secret. */
export async function activatePendingWebhookSecret(
  connection: DatabaseConnection,
  input: {
    readonly workspaceId: string;
    readonly endpointId: string;
    readonly secretId: string;
    readonly actorId?: string | null;
  },
): Promise<WebhookEndpointSecret | null> {
  const auditEventId = randomUUID();
  const rows = await connection.sql.begin(async (transaction) => {
    return transaction<SecretRow[]>`
      with endpoint as (
        select id
        from webhook_endpoints
        where id = ${input.endpointId}::uuid and workspace_id = ${input.workspaceId}::uuid and status = 'active'
        for update
      ), target as (
        select secret.id
        from webhook_endpoint_secrets as secret
        join endpoint on endpoint.id = secret.endpoint_id
        where secret.workspace_id = ${input.workspaceId}::uuid
          and secret.id = ${input.secretId}::uuid
          and secret.status = 'pending'
        for update
      ), retired as (
        update webhook_endpoint_secrets as secret
        set status = 'retired', retired_at = clock_timestamp()
        from endpoint, target
        where secret.workspace_id = ${input.workspaceId}::uuid
          and secret.endpoint_id = endpoint.id
          and secret.status = 'active'
        returning secret.id
      ), activated as (
        update webhook_endpoint_secrets as secret
        set status = 'active', activated_at = clock_timestamp()
        from target, retired
        where secret.id = target.id
        returning
          secret.id,
          secret.workspace_id,
          secret.endpoint_id,
          secret.version,
          secret.status,
          secret.secret_envelope,
          secret.activated_at,
          secret.retired_at,
          secret.created_at
      ), audit as (
        insert into audit_events (id, workspace_id, actor_id, action, entity_type, entity_id, data)
        select
          ${auditEventId}::uuid,
          activated.workspace_id,
          ${input.actorId ?? null}::uuid,
          'webhook.secret.rotation_activated',
          'webhook_endpoint_secret',
          activated.id,
          jsonb_build_object('endpointId', activated.endpoint_id::text, 'version', activated.version)
        from activated
      )
      select * from activated
    `;
  });
  const row = rows[0];
  return row ? mapSecret(row) : null;
}

/** Revocation is terminal and retires all signing material without exposing it. */
export async function revokeWebhookEndpoint(
  connection: DatabaseConnection,
  input: {
    readonly workspaceId: string;
    readonly endpointId: string;
    readonly actorId?: string | null;
  },
): Promise<boolean> {
  const auditEventId = randomUUID();
  const rows = await connection.sql.begin(async (transaction) => {
    return transaction<IdRow[]>`
      with revoked as (
        update webhook_endpoints
        set status = 'revoked', revoked_at = clock_timestamp(), updated_at = clock_timestamp()
        where id = ${input.endpointId}::uuid
          and workspace_id = ${input.workspaceId}::uuid
          and status = 'active'
        returning id
      ), retired as (
        update webhook_endpoint_secrets as secret
        set status = 'retired', retired_at = clock_timestamp()
        from revoked
        where secret.workspace_id = ${input.workspaceId}::uuid
          and secret.endpoint_id = revoked.id
          and secret.status in ('pending', 'active')
      ), audit as (
        insert into audit_events (id, workspace_id, actor_id, action, entity_type, entity_id, data)
        select
          ${auditEventId}::uuid,
          ${input.workspaceId}::uuid,
          ${input.actorId ?? null}::uuid,
          'webhook.endpoint.revoked',
          'webhook_endpoint',
          revoked.id,
          '{}'::jsonb
        from revoked
      )
      select id from revoked
    `;
  });
  return rows.length === 1;
}

/**
 * Stores the exact JSON bytes once, binds them to the active endpoint and
 * secret, and queues a deliberately thin outbox message in the same
 * transaction. A duplicate event ID for the same endpoint returns null.
 */
export async function enqueueWebhookTestDelivery(
  connection: DatabaseConnection,
  input: {
    readonly workspaceId: string;
    readonly endpointId: string;
    readonly eventId: string;
    readonly eventType: string;
    readonly eventOccurredAt: Date;
    readonly rawBody: string;
    readonly actorId?: string | null;
  },
): Promise<WebhookDelivery | null> {
  const eventId = assertNonEmptyBounded("eventId", input.eventId, 160);
  const eventType = assertNonEmptyBounded("eventType", input.eventType, 160);
  const eventOccurredAt = assertValidDate("eventOccurredAt", input.eventOccurredAt).toISOString();
  const rawBody = assertRawJsonBody(input.rawBody);
  const deliveryId = randomUUID();
  const outboxEventId = randomUUID();
  const auditEventId = randomUUID();
  const bodySha256 = createHash("sha256").update(rawBody, "utf8").digest("hex");

  const rows = await connection.sql.begin(async (transaction) => {
    return transaction<DeliveryRow[]>`
      with active_target as (
        select endpoint.id as endpoint_id, secret.id as secret_id
        from webhook_endpoints as endpoint
        join webhook_endpoint_secrets as secret
          on secret.workspace_id = endpoint.workspace_id
          and secret.endpoint_id = endpoint.id
          and secret.status = 'active'
        where endpoint.workspace_id = ${input.workspaceId}::uuid
          and endpoint.id = ${input.endpointId}::uuid
          and endpoint.status = 'active'
        for update of endpoint, secret
      ), delivery as (
        insert into webhook_deliveries as delivery (
          id, workspace_id, endpoint_id, secret_id, event_id, event_type, event_occurred_at, raw_body, body_sha256
        )
        select
          ${deliveryId}::uuid,
          ${input.workspaceId}::uuid,
          target.endpoint_id,
          target.secret_id,
          ${eventId},
          ${eventType},
          ${eventOccurredAt}::timestamptz,
          ${rawBody},
          ${bodySha256}
        from active_target as target
        on conflict (workspace_id, endpoint_id, event_id) do nothing
        returning
          delivery.id,
          delivery.workspace_id,
          delivery.endpoint_id,
          delivery.secret_id,
          delivery.event_id,
          delivery.event_type,
          delivery.event_occurred_at,
          delivery.raw_body,
          delivery.body_sha256,
          delivery.created_at
      ), outbox as (
        insert into outbox_events as outbox_event (id, workspace_id, topic, payload, webhook_delivery_id)
        select
          ${outboxEventId}::uuid,
          delivery.workspace_id,
          ${WEBHOOK_DELIVERY_TOPIC},
          jsonb_build_object('deliveryId', delivery.id::text),
          delivery.id
        from delivery
        returning outbox_event.id, outbox_event.webhook_delivery_id
      ), audit as (
        insert into audit_events (id, workspace_id, actor_id, action, entity_type, entity_id, data)
        select
          ${auditEventId}::uuid,
          delivery.workspace_id,
          ${input.actorId ?? null}::uuid,
          'webhook.delivery.enqueued',
          'webhook_delivery',
          delivery.id,
          jsonb_build_object(
            'endpointId', delivery.endpoint_id::text,
            'eventId', delivery.event_id,
            'eventType', delivery.event_type,
            'outboxEventId', outbox.id::text
          )
        from delivery
        join outbox on outbox.webhook_delivery_id = delivery.id
      )
      select delivery.*, outbox.id as outbox_event_id
      from delivery
      join outbox on outbox.webhook_delivery_id = delivery.id
    `;
  });
  const row = rows[0];
  return row ? mapDelivery(row) : null;
}

/**
 * Strictly loads a queued event through all tenant-bound relationships. It
 * intentionally refuses revoked endpoints but permits a retired delivery
 * secret so an already-created delivery remains cryptographically stable.
 */
export async function loadWebhookDispatchRecord(
  connection: DatabaseConnection,
  input: {
    readonly workspaceId: string;
    readonly outboxEventId: string;
    readonly deliveryId: string;
  },
): Promise<WebhookDispatchRecord | null> {
  const rows = await connection.sql<DispatchRow[]>`
    select
      delivery.id,
      delivery.workspace_id,
      delivery.endpoint_id,
      delivery.secret_id,
      delivery.event_id,
      delivery.event_type,
      delivery.event_occurred_at,
      delivery.raw_body,
      delivery.body_sha256,
      delivery.created_at,
      outbox.id as outbox_event_id,
      endpoint.url as endpoint_url,
      secret.secret_envelope
    from outbox_events as outbox
    join webhook_deliveries as delivery
      on delivery.workspace_id = outbox.workspace_id
      and delivery.id = outbox.webhook_delivery_id
    join webhook_endpoints as endpoint
      on endpoint.workspace_id = delivery.workspace_id
      and endpoint.id = delivery.endpoint_id
      and endpoint.status = 'active'
    join webhook_endpoint_secrets as secret
      on secret.workspace_id = delivery.workspace_id
      and secret.endpoint_id = delivery.endpoint_id
      and secret.id = delivery.secret_id
      and secret.status in ('active', 'retired')
    where outbox.id = ${input.outboxEventId}::uuid
      and outbox.workspace_id = ${input.workspaceId}::uuid
      and delivery.id = ${input.deliveryId}::uuid
      and outbox.topic = ${WEBHOOK_DELIVERY_TOPIC}
  `;
  const row = rows[0];
  return row
    ? {
        delivery: mapDelivery(row),
        endpointUrl: row.endpoint_url,
        secretEnvelope: assertEnvelope(row.secret_envelope),
      }
    : null;
}

/** Metadata only: this deliberately never reads a body or encrypted envelope. */
export async function listWebhookDeadLetters(
  connection: DatabaseConnection,
  input: { readonly workspaceId: string; readonly limit?: number },
): Promise<readonly WebhookDeadLetter[]> {
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new RangeError("limit must be an integer between 1 and 100");
  }
  const rows = await connection.sql<DeadLetterRow[]>`
    select
      delivery.id as delivery_id,
      outbox.id as outbox_event_id,
      delivery.endpoint_id,
      delivery.event_id,
      delivery.event_type,
      delivery.event_occurred_at,
      delivery.created_at,
      outbox.attempts,
      outbox.last_error
    from outbox_events as outbox
    join webhook_deliveries as delivery
      on delivery.workspace_id = outbox.workspace_id
      and delivery.id = outbox.webhook_delivery_id
    where outbox.workspace_id = ${input.workspaceId}::uuid
      and outbox.topic = ${WEBHOOK_DELIVERY_TOPIC}
      and outbox.status = 'dead_letter'
    order by delivery.created_at desc, delivery.id desc
    limit ${limit}
  `;
  return rows.map((row) => ({
    deliveryId: row.delivery_id,
    outboxEventId: row.outbox_event_id,
    endpointId: row.endpoint_id,
    eventId: row.event_id,
    eventType: row.event_type,
    eventOccurredAt: row.event_occurred_at,
    createdAt: row.created_at,
    attempts: row.attempts,
    lastError: row.last_error,
  }));
}

/** Requeues the same delivery and raw body, recording an audit event in the transaction. */
export async function redriveWebhookDelivery(
  connection: DatabaseConnection,
  input: {
    readonly workspaceId: string;
    readonly deliveryId: string;
    readonly actorId?: string | null;
  },
): Promise<boolean> {
  const auditEventId = randomUUID();
  const rows = await connection.sql.begin(async (transaction) => {
    return transaction<IdRow[]>`
      with candidate as (
        select outbox.id, delivery.id as delivery_id, delivery.workspace_id
        from outbox_events as outbox
        join webhook_deliveries as delivery
          on delivery.workspace_id = outbox.workspace_id
          and delivery.id = outbox.webhook_delivery_id
        join webhook_endpoints as endpoint
          on endpoint.workspace_id = delivery.workspace_id
          and endpoint.id = delivery.endpoint_id
          and endpoint.status = 'active'
        where delivery.workspace_id = ${input.workspaceId}::uuid
          and delivery.id = ${input.deliveryId}::uuid
          and outbox.topic = ${WEBHOOK_DELIVERY_TOPIC}
          and outbox.status = 'dead_letter'
        for update of outbox
      ), redriven as (
        update outbox_events as outbox
        set status = 'pending', attempts = 0, available_at = clock_timestamp(), locked_at = null,
            completed_at = null, last_error = null
        from candidate
        where outbox.id = candidate.id
        returning outbox.id, candidate.delivery_id, candidate.workspace_id
      ), audit as (
        insert into audit_events (id, workspace_id, actor_id, action, entity_type, entity_id, data)
        select
          ${auditEventId}::uuid,
          redriven.workspace_id,
          ${input.actorId ?? null}::uuid,
          'webhook.delivery.redriven',
          'webhook_delivery',
          redriven.delivery_id,
          jsonb_build_object('outboxEventId', redriven.id::text)
        from redriven
      )
      select id from redriven
    `;
  });
  return rows.length === 1;
}
