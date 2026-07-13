import { lookup as nodeLookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

import {
  decryptWebhookSigningSecret,
  sha256WebhookBody,
  signWebhookDelivery,
  type WebhookSecretEnvelope,
} from "@schedule/application";
import {
  loadWebhookDispatchRecord,
  type ClaimedOutboxEvent,
  type DatabaseConnection,
} from "@schedule/database";

import { OutboxHandlerFailure, type OutboxHandler } from "./dispatcher.js";

export const WEBHOOK_DELIVERY_TOPIC = "webhook.delivery.v1";
export const MAX_WEBHOOK_BODY_BYTES = 1_048_576;
export const MAX_WEBHOOK_RESPONSE_BYTES = 65_536;
export const DEFAULT_WEBHOOK_RESPONSE_BYTES = MAX_WEBHOOK_RESPONSE_BYTES;
export const MAX_WEBHOOK_RESPONSE_HEADER_BYTES = 16_384;
export const DEFAULT_WEBHOOK_CONNECT_TIMEOUT_MS = 10_000;
export const DEFAULT_WEBHOOK_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_WEBHOOK_MAX_RETRY_AFTER_MS = 60_000;
export const DEFAULT_WEBHOOK_MAX_DELIVERY_AGE_MS = 7 * 24 * 60 * 60_000;
export const MIN_WEBHOOK_MAX_DELIVERY_AGE_MS = 60_000;
export const MAX_WEBHOOK_MAX_DELIVERY_AGE_MS = 30 * 24 * 60 * 60_000;

export interface WebhookDeliveryRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly outboxEventId: string;
  readonly endpointId: string;
  readonly secretId: string;
  readonly rawBody: string;
  readonly bodySha256: string;
  readonly createdAt: Date;
}

export interface WebhookEndpointRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly active: boolean;
  readonly url: string;
  readonly activeSecretId: string;
}

export interface WebhookSecretRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly endpointId: string;
  readonly masterKeyId: string;
  readonly envelope: WebhookSecretEnvelope;
  readonly active: boolean;
}

export interface WebhookDeliveryLoader {
  load(
    deliveryId: string,
    event: ClaimedOutboxEvent,
  ): Promise<{
    readonly delivery: WebhookDeliveryRecord | null;
    readonly endpoint: WebhookEndpointRecord | null;
    readonly secret: WebhookSecretRecord | null;
  }>;
}

export interface WebhookMasterKeyring {
  get(masterKeyId: string): string | undefined;
}

export interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export type WebhookResolver = (hostname: string) => Promise<readonly ResolvedAddress[]>;

export interface WebhookRequestInput {
  readonly hostname: string;
  readonly path: string;
  readonly address: ResolvedAddress;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Buffer;
  readonly connectTimeoutMs: number;
  readonly requestTimeoutMs: number;
  readonly maxResponseBytes: number;
  readonly signal: AbortSignal;
}

export interface WebhookResponse {
  readonly statusCode: number;
  readonly headers?: Readonly<Record<string, string | readonly string[] | undefined>>;
}

export type WebhookRequester = (input: WebhookRequestInput) => Promise<WebhookResponse>;

export interface WebhookDeliveryHandlerOptions {
  readonly loader: WebhookDeliveryLoader;
  readonly keyring: WebhookMasterKeyring;
  readonly resolve?: WebhookResolver;
  readonly request?: WebhookRequester;
  readonly now?: () => Date;
  readonly connectTimeoutMs?: number;
  readonly requestTimeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly maxRetryAfterMs?: number;
  readonly maxDeliveryAgeMs?: number;
  readonly random?: () => number;
}

/** Strictly parse an operator supplied webhook target before any network I/O. */
export function validateWebhookUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw permanent("webhook_url_invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    isIP(url.hostname) !== 0 ||
    !isOrdinaryDnsName(url.hostname)
  ) {
    throw permanent("webhook_url_rejected");
  }
  return url;
}

/** Reject any DNS set containing a non-global address to prevent rebinding. */
export function assertPublicDnsAnswers(
  answers: readonly ResolvedAddress[],
): readonly ResolvedAddress[] {
  if (answers.length === 0 || answers.length > 32) throw retryable("webhook_dns_unavailable");
  for (const answer of answers) {
    if (
      (answer.family !== 4 && answer.family !== 6) ||
      isIP(answer.address) !== answer.family ||
      !isPublicAddress(answer.address)
    ) {
      throw permanent("webhook_dns_rejected");
    }
  }
  return answers;
}

/** Build the handler without ambient DNS, HTTP, clock, or database dependencies. */
export function createWebhookDeliveryHandler(
  options: WebhookDeliveryHandlerOptions,
): OutboxHandler {
  const resolve = options.resolve ?? resolvePublicDns;
  const request = options.request ?? requestWebhook;
  const now = options.now ?? (() => new Date());
  const connectTimeoutMs = boundedTimeout(
    options.connectTimeoutMs,
    DEFAULT_WEBHOOK_CONNECT_TIMEOUT_MS,
  );
  const requestTimeoutMs = boundedTimeout(
    options.requestTimeoutMs,
    DEFAULT_WEBHOOK_REQUEST_TIMEOUT_MS,
  );
  const maxResponseBytes = boundedLimit(options.maxResponseBytes, DEFAULT_WEBHOOK_RESPONSE_BYTES);
  const maxRetryAfterMs = boundedNonNegativeLimit(
    options.maxRetryAfterMs,
    DEFAULT_WEBHOOK_MAX_RETRY_AFTER_MS,
  );
  const maxDeliveryAgeMs = boundedDeliveryAge(options.maxDeliveryAgeMs);
  const random = options.random ?? Math.random;

  return async (event, signal) => {
    const deliveryId = parsePayload(event);
    if (event.workspaceId === null) throw permanent("webhook_workspace_missing");
    const loaded = await safelyLoad(options.loader, deliveryId, event);
    const { delivery, endpoint, secret } = loaded;
    if (!delivery || !endpoint || !secret || !isBound(event, delivery, endpoint, secret)) {
      throw permanent("webhook_binding_invalid");
    }
    const body = Buffer.from(delivery.rawBody, "utf8");
    if (
      body.byteLength > MAX_WEBHOOK_BODY_BYTES ||
      sha256WebhookBody(delivery.rawBody) !== delivery.bodySha256
    ) {
      throw permanent("webhook_body_tampered");
    }
    const deliveryNow = now();
    const createdAtMs = delivery.createdAt.getTime();
    const nowMs = deliveryNow.getTime();
    if (!Number.isFinite(createdAtMs) || !Number.isFinite(nowMs)) {
      throw permanent("webhook_delivery_time_invalid");
    }
    if (createdAtMs > nowMs || nowMs - createdAtMs > maxDeliveryAgeMs) {
      throw permanent("webhook_delivery_expired");
    }
    let signingSecret: string;
    try {
      const masterKey = options.keyring.get(secret.masterKeyId);
      if (masterKey === undefined) throw new Error("missing");
      signingSecret = decryptWebhookSigningSecret({
        workspaceId: delivery.workspaceId,
        endpointId: endpoint.id,
        secretId: secret.id,
        masterKeyId: secret.masterKeyId,
        envelope: secret.envelope,
        masterKey,
      });
    } catch {
      throw permanent("webhook_secret_unavailable");
    }

    const url = validateWebhookUrl(endpoint.url);
    let answers: readonly ResolvedAddress[];
    try {
      answers = assertPublicDnsAnswers(
        await resolveWithDeadline(resolve, url.hostname, signal, connectTimeoutMs),
      );
    } catch (error) {
      if (error instanceof OutboxHandlerFailure) throw error;
      throw retryable("webhook_dns_failed", jitterDelayMs(event.attempts, maxRetryAfterMs, random));
    }
    const unixSeconds = Math.floor(deliveryNow.getTime() / 1_000);
    if (!Number.isSafeInteger(unixSeconds) || unixSeconds < 0)
      throw permanent("webhook_clock_invalid");
    const headers = {
      "content-type": "application/json",
      "content-length": String(body.byteLength),
      "schedule-webhook-id": delivery.id,
      "schedule-webhook-timestamp": String(unixSeconds),
      "schedule-webhook-key-id": secret.id,
      "schedule-webhook-signature": signWebhookDelivery({
        signingSecret,
        deliveryId: delivery.id,
        unixSeconds,
        rawBody: delivery.rawBody,
      }),
    };
    let response: WebhookResponse;
    try {
      response = await request({
        hostname: url.hostname,
        path: `${url.pathname}${url.search}`,
        address: answers[0]!,
        headers,
        body,
        connectTimeoutMs,
        requestTimeoutMs,
        maxResponseBytes,
        signal,
      });
    } catch (error) {
      if (error instanceof OutboxHandlerFailure) throw error;
      throw retryable(
        signal.aborted ? "webhook_request_aborted" : "webhook_request_failed",
        jitterDelayMs(event.attempts, maxRetryAfterMs, random),
      );
    }
    if (response.statusCode >= 200 && response.statusCode <= 299) return;
    if ([408, 425, 429].includes(response.statusCode) || response.statusCode >= 500) {
      throw retryable(
        "webhook_response_retryable",
        retryAfterMs(response.headers, now, maxRetryAfterMs) ??
          jitterDelayMs(event.attempts, maxRetryAfterMs, random),
      );
    }
    throw permanent("webhook_response_permanent");
  };
}

/** Mutates only a caller-owned handler map, making registration explicit. */
export function registerWebhookDeliveryHandler(
  handlers: Map<string, OutboxHandler>,
  options: WebhookDeliveryHandlerOptions,
): void {
  handlers.set(WEBHOOK_DELIVERY_TOPIC, createWebhookDeliveryHandler(options));
}

/** Production adapter: persistence performs the tenant-bound join before the handler signs. */
export function createDatabaseWebhookDeliveryHandler(
  database: DatabaseConnection,
  options: Omit<WebhookDeliveryHandlerOptions, "loader">,
): OutboxHandler {
  return createWebhookDeliveryHandler({
    ...options,
    loader: {
      async load(deliveryId, event) {
        // The outbox ID and workspace are additionally checked by the generic
        // handler.  This lookup has no ambient tenant default.
        if (!event?.workspaceId) return { delivery: null, endpoint: null, secret: null };
        const record = await loadWebhookDispatchRecord(database, {
          workspaceId: event.workspaceId,
          outboxEventId: event.id,
          deliveryId,
        });
        if (!record) return { delivery: null, endpoint: null, secret: null };
        return {
          delivery: record.delivery,
          endpoint: {
            id: record.delivery.endpointId,
            workspaceId: record.delivery.workspaceId,
            active: true,
            url: record.endpointUrl,
            activeSecretId: record.delivery.secretId,
          },
          secret: {
            id: record.delivery.secretId,
            workspaceId: record.delivery.workspaceId,
            endpointId: record.delivery.endpointId,
            masterKeyId: record.secretEnvelope.masterKeyId,
            envelope: record.secretEnvelope,
            // Retired delivery keys remain deliberately eligible for retries.
            active: true,
          },
        };
      },
    },
  });
}

export async function resolvePublicDns(hostname: string): Promise<readonly ResolvedAddress[]> {
  const results = await nodeLookup(hostname, { all: true, verbatim: true });
  return results.map((result) => ({ address: result.address, family: result.family as 4 | 6 }));
}

/** DNS libraries cannot always cancel an OS resolver call, so detach it after a bounded race. */
export function resolveWithDeadline(
  resolve: WebhookResolver,
  hostname: string,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<readonly ResolvedAddress[]> {
  return new Promise((resolveResult, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = (): void => finish(() => reject(new Error("dns aborted")));
    const timer = setTimeout(() => finish(() => reject(new Error("dns timeout"))), timeoutMs);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    void resolve(hostname).then(
      (answers) => finish(() => resolveResult(answers)),
      () => finish(() => reject(new Error("dns failed"))),
    );
  });
}

/** A direct HTTPS request: no proxy agent, no redirect following, pinned lookup. */
export function requestWebhook(input: WebhookRequestInput): Promise<WebhookResponse> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest({
      protocol: "https:",
      hostname: input.hostname,
      port: 443,
      path: input.path,
      method: "POST",
      headers: input.headers,
      agent: false,
      maxHeaderSize: MAX_WEBHOOK_RESPONSE_HEADER_BYTES,
      lookup: (_hostname, _options, callback) =>
        callback(null, input.address.address, input.address.family),
      signal: input.signal,
    });
    let connectTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(
      () => request.destroy(new Error("connect timeout")),
      input.connectTimeoutMs,
    );
    const totalTimer = setTimeout(
      () => request.destroy(new Error("request timeout")),
      input.requestTimeoutMs,
    );
    const clearTimers = (): void => {
      if (connectTimer !== undefined) clearTimeout(connectTimer);
      clearTimeout(totalTimer);
    };
    request.once("socket", (socket) =>
      socket.once("secureConnect", () => {
        if (connectTimer !== undefined) clearTimeout(connectTimer);
        connectTimer = undefined;
      }),
    );
    request.once("error", (error) => {
      clearTimers();
      reject(error);
    });
    request.once("response", (response) => {
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.byteLength;
        if (bytes > input.maxResponseBytes) request.destroy(new Error("response too large"));
      });
      response.once("error", (error) => {
        clearTimers();
        reject(error);
      });
      response.once("end", () => {
        clearTimers();
        resolve({ statusCode: response.statusCode ?? 0, headers: response.headers });
      });
      response.resume();
    });
    request.end(input.body);
  });
}

function parsePayload(event: ClaimedOutboxEvent): string {
  const keys = Object.keys(event.payload);
  const value = event.payload.deliveryId;
  if (keys.length !== 1 || typeof value !== "string" || !isUuid(value))
    throw permanent("webhook_payload_invalid");
  return value;
}

function isBound(
  event: ClaimedOutboxEvent,
  delivery: WebhookDeliveryRecord,
  endpoint: WebhookEndpointRecord,
  secret: WebhookSecretRecord,
): boolean {
  return (
    event.workspaceId === delivery.workspaceId &&
    event.id === delivery.outboxEventId &&
    delivery.endpointId === endpoint.id &&
    delivery.secretId === secret.id &&
    endpoint.workspaceId === delivery.workspaceId &&
    secret.workspaceId === delivery.workspaceId &&
    secret.endpointId === endpoint.id &&
    endpoint.active &&
    secret.active &&
    endpoint.activeSecretId === secret.id &&
    isUuid(delivery.id) &&
    isUuid(delivery.workspaceId) &&
    isUuid(endpoint.id) &&
    isUuid(secret.id)
  );
}

async function safelyLoad(
  loader: WebhookDeliveryLoader,
  deliveryId: string,
  event: ClaimedOutboxEvent,
) {
  try {
    return await loader.load(deliveryId, event);
  } catch {
    throw retryable("webhook_load_failed");
  }
}

function retryAfterMs(
  headers: WebhookResponse["headers"],
  now: () => Date,
  maximum: number,
): number | undefined {
  const raw = headers?.["retry-after"] ?? headers?.["Retry-After"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string" || value.length > 128) return undefined;
  const seconds = /^\d+$/.test(value) ? Number(value) * 1_000 : Date.parse(value) - now().getTime();
  return Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= maximum ? seconds : undefined;
}

function permanent(code: string): OutboxHandlerFailure {
  return new OutboxHandlerFailure({ code, retryable: false });
}

function retryable(code: string, retryDelayMs?: number): OutboxHandlerFailure {
  return new OutboxHandlerFailure({
    code,
    retryable: true,
    ...(retryDelayMs === undefined ? {} : { retryDelayMs }),
  });
}

function boundedTimeout(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 100 || value > 120_000)
    throw new RangeError("webhook timeout out of range");
  return value;
}

function boundedLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_WEBHOOK_BODY_BYTES)
    throw new RangeError("webhook limit out of range");
  return value;
}

function boundedNonNegativeLimit(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_WEBHOOK_BODY_BYTES)
    throw new RangeError("webhook limit out of range");
  return value;
}

function boundedDeliveryAge(value: number | undefined): number {
  const result = value ?? DEFAULT_WEBHOOK_MAX_DELIVERY_AGE_MS;
  if (
    !Number.isSafeInteger(result) ||
    result < MIN_WEBHOOK_MAX_DELIVERY_AGE_MS ||
    result > MAX_WEBHOOK_MAX_DELIVERY_AGE_MS
  ) {
    throw new RangeError("webhook delivery age out of range");
  }
  return result;
}

/** Full jitter prevents a fleet of failed endpoints from retrying in lockstep. */
export function jitterDelayMs(attempts: number, maximum: number, random: () => number): number {
  if (
    !Number.isSafeInteger(attempts) ||
    attempts < 1 ||
    !Number.isSafeInteger(maximum) ||
    maximum < 0
  ) {
    throw new RangeError("invalid webhook retry delay input");
  }
  const sample = random();
  const unit = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 0;
  const ceiling = Math.min(maximum, 1_000 * 2 ** Math.min(attempts, 6));
  return Math.floor(unit * ceiling);
}

function isOrdinaryDnsName(value: string): boolean {
  const host = value.toLowerCase();
  if (
    host.length > 253 ||
    !host.includes(".") ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    [".local", ".internal", ".home.arpa", ".test", ".example", ".invalid"].some((suffix) =>
      host.endsWith(suffix),
    )
  )
    return false;
  return host.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family !== 6) return false;
  const mapped = ipv4Mapped(address);
  if (mapped !== null) return isPublicIpv4(mapped);
  const value = ipv6ToBigInt(address);
  if (value === null) return false;
  // Only global unicast (2000::/3) is eligible. This deny-by-default rule
  // excludes loopback, link-local, unique-local, multicast, site-local,
  // mapped IPv4, and unallocated ranges such as 4000::/3.
  if (!inCidr(value, 0x2000n << 112n, 3n)) return false;
  return ![
    [0x2001n << 112n, 23n], // IETF Protocol Assignments (deny conservatively)
    [0x20010000n << 96n, 32n], // Teredo
    [0x20010001n << 96n, 64n], // IETF protocol assignment anycast/reserved block
    [0x20010002n << 96n, 48n], // benchmarking
    [0x20010003n << 96n, 32n], // AMT
    [0x200100040112n << 80n, 48n], // AS112-v6
    [0x20010010n << 96n, 28n], // ORCHID
    [0x20010020n << 96n, 28n], // ORCHIDv2
    [0x20010030n << 96n, 28n], // Drone remote identification protocol entity tags
    [0x20010db8n << 96n, 32n], // documentation
    [0x2002n << 112n, 16n], // 6to4
    [0x262004f8000n << 80n, 48n], // AS112-v6
    [0x3fffn << 112n, 20n], // documentation
  ].some(([network, prefix]) => inCidr(value, network as bigint, prefix as bigint));
}

function isPublicIpv4(value: string): boolean {
  const octets = value.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
  )
    return false;
  const numeric = octets.reduce((total, part) => total * 256 + part, 0);
  return ![
    [0x00000000, 8],
    [0x0a000000, 8],
    [0x64400000, 10],
    [0x7f000000, 8],
    [0xa9fe0000, 16],
    [0xac100000, 12],
    [0xc0000000, 24],
    [0xc0000200, 24],
    [0xc01fc400, 24],
    [0xc034c100, 24],
    [0xc0586300, 24],
    [0xc0a80000, 16],
    [0xc0af3000, 24],
    [0xc6120000, 15],
    [0xc6336400, 24],
    [0xcb007100, 24],
    [0xe0000000, 4],
    [0xf0000000, 4],
  ].some(([network, prefix]) => inCidr(BigInt(numeric), BigInt(network!), BigInt(prefix!), 32n));
}

function ipv4Mapped(value: string): string | null {
  const normalized = value.toLowerCase();
  const match = normalized.match(/^(?:::(?:ffff:)?)(\d+\.\d+\.\d+\.\d+)$/);
  return match?.[1] ?? null;
}

function ipv6ToBigInt(value: string): bigint | null {
  const [left = "", right = ""] = value.toLowerCase().split("::");
  if (value.split("::").length > 2) return null;
  const leftParts = left === "" ? [] : left.split(":");
  const rightParts = right === "" ? [] : right.split(":");
  if (
    leftParts.some((part) => !/^[0-9a-f]{1,4}$/.test(part)) ||
    rightParts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))
  )
    return null;
  const count = leftParts.length + rightParts.length;
  if ((value.includes("::") && count >= 8) || (!value.includes("::") && count !== 8)) return null;
  const parts = [...leftParts, ...Array(Math.max(0, 8 - count)).fill("0"), ...rightParts];
  return parts.reduce((result, part) => (result << 16n) + BigInt(`0x${part}`), 0n);
}

function inCidr(value: bigint, network: bigint, prefix: bigint, bits = 128n): boolean {
  const shift = bits - prefix;
  return value >> shift === network >> shift;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}
