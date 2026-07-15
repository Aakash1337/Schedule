import { z } from "zod";

import {
  type ClaimedReminder,
  type ReminderTransportResult,
  type ScheduleDeliveryGateway,
  type ScheduleDeliveryReceipt,
} from "./contracts.js";

const VERSION = "schedule.integration/v1";
const MAX_RESPONSE_BYTES = 64 * 1024;

const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const command = z
  .strictObject({
    deliveryId: uuid,
    intentId: uuid,
    dedupeKey: uuid,
    kind: z.enum([
      "daily_digest",
      "daily_follow_up",
      "plan_window_open",
      "schedule_block_lead",
      "work_item_due",
      "one_off",
    ]),
    targetType: z.enum(["workspace", "daily_plan", "schedule_block", "work_item", "one_off"]),
    title: z.string().max(240).nullable(),
    scheduledFor: z.string().datetime({ offset: true }),
    localDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    priority: z.number().int().min(0).max(100),
    attempt: z.number().int().positive(),
    claimToken: uuid,
    leaseExpiresAt: z.string().datetime({ offset: true }),
  })
  .refine(
    (value) => value.deliveryId === value.intentId && value.deliveryId === value.dedupeKey,
    "Delivery, intent, and dedupe identities must match.",
  )
  .refine(
    (value) =>
      ({
        daily_digest: "workspace",
        daily_follow_up: "daily_plan",
        plan_window_open: "daily_plan",
        schedule_block_lead: "schedule_block",
        work_item_due: "work_item",
        one_off: "one_off",
      })[value.kind] === value.targetType,
    "Reminder kind and target type do not match.",
  );
const claimEnvelope = z.strictObject({
  version: z.literal(VERSION),
  requestId: z.string(),
  data: z.strictObject({ command: command.nullable() }),
});
const receiptEnvelope = z.strictObject({
  version: z.literal(VERSION),
  requestId: z.string(),
  data: z.strictObject({
    deliveryId: uuid,
    status: z.enum(["delivered", "retry_scheduled", "dead_lettered", "invalidated"]),
  }),
});
const receiptRequest = z.discriminatedUnion("outcome", [
  z.strictObject({ deliveryId: uuid, claimToken: uuid, outcome: z.literal("delivered") }),
  z.strictObject({
    deliveryId: uuid,
    claimToken: uuid,
    outcome: z.literal("retryable_failure"),
    failureCode: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/u),
    retryAfterSeconds: z.number().int().min(0).max(60),
  }),
  z.strictObject({
    deliveryId: uuid,
    claimToken: uuid,
    outcome: z.literal("permanent_failure"),
    failureCode: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/u),
  }),
]);

export class ScheduleDeliveryGatewayError extends Error {
  constructor(
    readonly reason:
      | "authentication_failed"
      | "request_conflict"
      | "rate_limited"
      | "server_unavailable"
      | "network_unavailable"
      | "invalid_response",
    readonly retryable: boolean,
  ) {
    super(`Schedule delivery gateway failed: ${reason}.`);
    this.name = "ScheduleDeliveryGatewayError";
  }
}

export interface HttpScheduleDeliveryGatewayOptions {
  readonly timeoutMilliseconds?: number;
  readonly fetch?: typeof fetch;
}

function normalizedBaseUrl(value: string): string {
  const url = new URL(value);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new TypeError(
      "Schedule gateway URL must use HTTPS, except for an explicit loopback host.",
    );
  }
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new TypeError("Schedule gateway URL cannot contain credentials, a query, or a fragment.");
  }
  return url.toString().replace(/\/$/u, "");
}

function validIdempotencyKey(value: string): void {
  if (value.trim() !== value || value.length < 1 || value.length > 160) {
    throw new TypeError("Idempotency keys must contain 1 to 160 unpadded characters.");
  }
}

export class HttpScheduleDeliveryGateway implements ScheduleDeliveryGateway {
  private readonly baseUrl: string;
  private readonly timeoutMilliseconds: number;
  private readonly fetchImplementation: typeof fetch;
  readonly maximumRequestDurationMilliseconds: number;

  constructor(
    baseUrl: string,
    private readonly credential: string,
    options: HttpScheduleDeliveryGatewayOptions = {},
  ) {
    this.baseUrl = normalizedBaseUrl(baseUrl);
    this.timeoutMilliseconds = options.timeoutMilliseconds ?? 10_000;
    this.maximumRequestDurationMilliseconds = this.timeoutMilliseconds;
    this.fetchImplementation = options.fetch ?? fetch;
    if (credential.length < 40 || credential.length > 512 || /\s/u.test(credential)) {
      throw new TypeError("A bounded Schedule delivery bearer credential is required.");
    }
    if (
      !Number.isSafeInteger(this.timeoutMilliseconds) ||
      this.timeoutMilliseconds < 1_000 ||
      this.timeoutMilliseconds > 60_000
    ) {
      throw new TypeError("timeoutMilliseconds must be an integer from 1000 to 60000.");
    }
  }

  private async post(path: string, idempotencyKey: string, body: unknown): Promise<unknown> {
    validIdempotencyKey(idempotencyKey);
    const serialized = JSON.stringify(body);
    const controller = new AbortController();
    const timedOut = Symbol("Schedule request timed out");
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutResult = new Promise<typeof timedOut>((resolve) => {
      timeout = setTimeout(() => {
        controller.abort();
        resolve(timedOut);
      }, this.timeoutMilliseconds);
    });
    let text: string;
    try {
      const operation = (async () => {
        const response = await this.fetchImplementation(`${this.baseUrl}${path}`, {
          method: "POST",
          redirect: "error",
          signal: controller.signal,
          headers: {
            authorization: `Bearer ${this.credential}`,
            "content-type": "application/json",
            "idempotency-key": idempotencyKey,
          },
          body: serialized,
        });
        if (response.status === 401 || response.status === 403) {
          throw new ScheduleDeliveryGatewayError("authentication_failed", false);
        }
        if (response.status === 409) {
          throw new ScheduleDeliveryGatewayError("request_conflict", false);
        }
        if (response.status === 429) throw new ScheduleDeliveryGatewayError("rate_limited", true);
        if (response.status >= 500) {
          throw new ScheduleDeliveryGatewayError("server_unavailable", true);
        }
        if (!response.ok) throw new ScheduleDeliveryGatewayError("invalid_response", false);
        return readBoundedResponse(response);
      })();
      const result = await Promise.race([operation, timeoutResult]);
      if (result === timedOut) {
        throw new ScheduleDeliveryGatewayError("network_unavailable", true);
      }
      text = result;
    } catch (error) {
      if (error instanceof ScheduleDeliveryGatewayError) throw error;
      throw new ScheduleDeliveryGatewayError("network_unavailable", true);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new ScheduleDeliveryGatewayError("invalid_response", false);
    }
  }

  async claim(idempotencyKey: string): Promise<ClaimedReminder | null> {
    const raw = await this.post("/v1/integrations/reminder-deliveries/claim", idempotencyKey, {
      version: VERSION,
    });
    const parsed = claimEnvelope.safeParse(raw);
    if (!parsed.success) throw new ScheduleDeliveryGatewayError("invalid_response", false);
    return parsed.data.data.command;
  }

  async recordReceipt(idempotencyKey: string, receipt: ScheduleDeliveryReceipt) {
    const parsedReceipt = receiptRequest.safeParse(receipt);
    if (!parsedReceipt.success) {
      throw new TypeError("Schedule delivery receipt does not match the bounded contract.");
    }
    receipt = parsedReceipt.data;
    const body = {
      version: VERSION,
      deliveryId: receipt.deliveryId,
      claimToken: receipt.claimToken,
      outcome: receipt.outcome,
      ...(receipt.outcome === "delivered"
        ? {}
        : {
            failureCode: receipt.failureCode,
            ...(receipt.outcome === "retryable_failure"
              ? { retryAfterSeconds: receipt.retryAfterSeconds }
              : {}),
          }),
    };
    const raw = await this.post(
      "/v1/integrations/reminder-deliveries/receipt",
      idempotencyKey,
      body,
    );
    const parsed = receiptEnvelope.safeParse(raw);
    if (!parsed.success || parsed.data.data.deliveryId !== receipt.deliveryId.toLowerCase()) {
      throw new ScheduleDeliveryGatewayError("invalid_response", false);
    }
    return parsed.data.data;
  }
}

async function readBoundedResponse(response: Response): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (
    contentLength !== null &&
    (!/^(?:0|[1-9]\d*)$/u.test(contentLength) || Number(contentLength) > MAX_RESPONSE_BYTES)
  ) {
    throw new ScheduleDeliveryGatewayError("invalid_response", false);
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new ScheduleDeliveryGatewayError("invalid_response", false);
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ScheduleDeliveryGatewayError("invalid_response", false);
  }
}

export type { ReminderTransportResult };
