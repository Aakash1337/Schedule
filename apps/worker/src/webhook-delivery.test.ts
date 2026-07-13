import { createHash } from "node:crypto";

import { encryptWebhookSigningSecret } from "@schedule/application";
import type { ClaimedOutboxEvent } from "@schedule/database";
import { describe, expect, it, vi } from "vitest";

import {
  WEBHOOK_DELIVERY_TOPIC,
  assertPublicDnsAnswers,
  createWebhookDeliveryHandler,
  isPublicAddress,
  jitterDelayMs,
  resolveWithDeadline,
  validateWebhookUrl,
  type WebhookDeliveryHandlerOptions,
} from "./webhook-delivery.js";

const workspaceId = "00000000-0000-4000-8000-000000000001";
const endpointId = "00000000-0000-4000-8000-000000000002";
const secretId = "00000000-0000-4000-8000-000000000003";
const deliveryId = "00000000-0000-4000-8000-000000000004";
const outboxId = "00000000-0000-4000-8000-000000000005";
const masterKey = Buffer.alloc(32, 7).toString("base64url");
const signingSecret = Buffer.alloc(32, 8).toString("base64url");
const body = '{"type":"webhook.test.v1","marker":"schedule"}';

const event = (): ClaimedOutboxEvent => ({
  id: outboxId,
  workspaceId,
  topic: WEBHOOK_DELIVERY_TOPIC,
  payload: { deliveryId },
  attempts: 1,
  lockedAt: "2026-07-13 00:00:00+00",
});

const options = (
  overrides: Partial<WebhookDeliveryHandlerOptions> = {},
): WebhookDeliveryHandlerOptions => ({
  loader: {
    load: vi.fn(async () => ({
      delivery: {
        id: deliveryId,
        workspaceId,
        outboxEventId: outboxId,
        endpointId,
        secretId,
        rawBody: body,
        bodySha256: createHash("sha256").update(body).digest("hex"),
        createdAt: new Date("2026-07-13T00:00:00Z"),
      },
      endpoint: {
        id: endpointId,
        workspaceId,
        active: true,
        url: "https://receiver.example.com/hook?a=1",
        activeSecretId: secretId,
      },
      secret: {
        id: secretId,
        workspaceId,
        endpointId,
        masterKeyId: "primary",
        active: true,
        envelope: encryptWebhookSigningSecret({
          workspaceId,
          endpointId,
          secretId,
          masterKeyId: "primary",
          signingSecret,
          masterKey,
          nonce: Buffer.alloc(12, 9).toString("base64url"),
        }),
      },
    })),
  },
  keyring: { get: () => masterKey },
  resolve: vi.fn(async () => [{ address: "8.8.8.8", family: 4 }]),
  request: vi.fn(async () => ({ statusCode: 204 })),
  now: () => new Date("2026-07-13T00:00:00Z"),
  ...overrides,
});

describe("webhook delivery network policy", () => {
  it.each([
    "127.0.0.1",
    "10.0.0.1",
    "100.64.0.1",
    "169.254.1.1",
    "172.16.0.1",
    "192.168.1.1",
    "198.18.0.1",
    "198.19.255.254",
    "203.0.113.1",
    "224.0.0.1",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:c0a8:101",
    "fc00::1",
    "fe80::1",
    "fec0::1",
    "4000::1",
    "2001:db8::1",
    "2001:0::1",
    "2001:1:1::1",
    "2001:4::1",
    "2001:2::1",
    "2001:3::1",
    "2001:20::1",
    "2002::1",
    "3fff::1",
    "3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff",
    "ff02::1",
  ])("rejects non-public address %s", (address) => expect(isPublicAddress(address)).toBe(false));

  it.each(["8.8.8.8", "1.1.1.1", "2001:200::1", "3fff:1000::1", "2606:4700:4700::1111"])(
    "accepts public address %s",
    (address) => expect(isPublicAddress(address)).toBe(true),
  );

  it("keeps only the exact RFC 2544 benchmarking range non-public", () => {
    expect(isPublicAddress("198.17.255.255")).toBe(true);
    expect(isPublicAddress("198.18.0.0")).toBe(false);
    expect(isPublicAddress("198.19.255.255")).toBe(false);
    expect(isPublicAddress("198.20.0.0")).toBe(true);
  });

  it("rejects a DNS response set if any answer is private", () => {
    expect(() =>
      assertPublicDnsAnswers([
        { address: "8.8.8.8", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ]),
    ).toThrow("outbox handler failed");
  });

  it("bounds a hung DNS resolver and obeys cancellation", async () => {
    vi.useFakeTimers();
    const never = async (): Promise<readonly { readonly address: string; readonly family: 4 }[]> =>
      new Promise(() => undefined);
    const timeout = expect(
      resolveWithDeadline(never, "receiver.example.test", new AbortController().signal, 50),
    ).rejects.toThrow("dns timeout");
    await vi.advanceTimersByTimeAsync(50);
    await timeout;
    const controller = new AbortController();
    const aborted = expect(
      resolveWithDeadline(never, "receiver.example.test", controller.signal, 50),
    ).rejects.toThrow("dns aborted");
    controller.abort();
    await aborted;
    vi.useRealTimers();
  });

  it.each([
    "http://receiver.example.test",
    "https://127.0.0.1/",
    "https://user@receiver.example.test/",
    "https://receiver.example.test:444/",
    "https://receiver.example.test/#fragment",
    "https://localhost/",
    "https://api.localhost/",
    "https://receiver.local/",
    "https://receiver.internal/",
    "https://receiver.home.arpa/",
    "https://receiver.test/",
    "https://receiver.example/",
    "https://receiver.invalid/",
  ])("rejects unsafe URL %s", (url) =>
    expect(() => validateWebhookUrl(url)).toThrow("outbox handler failed"),
  );

  it("rejects malformed, empty, oversized, and family-mismatched DNS sets", () => {
    expect(() => assertPublicDnsAnswers([])).toThrow();
    expect(() =>
      assertPublicDnsAnswers(Array.from({ length: 33 }, () => ({ address: "8.8.8.8", family: 4 }))),
    ).toThrow();
    expect(() => assertPublicDnsAnswers([{ address: "8.8.8.8", family: 6 }])).toThrow();
    expect(() => assertPublicDnsAnswers([{ address: "not-an-ip", family: 4 }])).toThrow();
    expect(() => assertPublicDnsAnswers([{ address: "8.8.8.8", family: 5 as 4 }])).toThrow();
  });
});

describe("webhook delivery handler", () => {
  it("pins a validated address, signs exact bytes, and keeps the stable delivery ID", async () => {
    const input = options();
    const handler = createWebhookDeliveryHandler(input);
    await handler(event(), new AbortController().signal);
    const request = vi.mocked(input.request!);
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        hostname: "receiver.example.com",
        path: "/hook?a=1",
        address: { address: "8.8.8.8", family: 4 },
        body: Buffer.from(body),
        headers: expect.objectContaining({
          "schedule-webhook-id": deliveryId,
          "schedule-webhook-key-id": secretId,
          "schedule-webhook-timestamp": "1783900800",
        }),
      }),
    );
    const sent = request.mock.calls[0]![0];
    expect(sent.headers["schedule-webhook-signature"]).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("uses permanent failures for binding and body tampering without exposing sensitive values", async () => {
    const input = options({
      loader: { load: async () => ({ delivery: null, endpoint: null, secret: null }) },
    });
    await expect(
      createWebhookDeliveryHandler(input)(event(), new AbortController().signal),
    ).rejects.toMatchObject({ code: "webhook_binding_invalid", retryable: false });
    const tampered = options({
      loader: {
        load: async () => ({
          ...(await options().loader.load(deliveryId)),
          delivery: {
            ...(await options().loader.load(deliveryId)).delivery!,
            bodySha256: "0".repeat(64),
          },
        }),
      },
    });
    await expect(
      createWebhookDeliveryHandler(tampered)(event(), new AbortController().signal),
    ).rejects.toMatchObject({ code: "webhook_body_tampered", retryable: false });
  });

  it("fails closed for malformed event, unavailable load, decrypt, and clock state", async () => {
    await expect(
      createWebhookDeliveryHandler(options())(
        { ...event(), payload: { deliveryId, extra: true } },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "webhook_payload_invalid" });
    await expect(
      createWebhookDeliveryHandler(options())(
        { ...event(), workspaceId: null },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "webhook_workspace_missing" });
    await expect(
      createWebhookDeliveryHandler(
        options({
          loader: {
            load: async () => {
              throw new Error("db");
            },
          },
        }),
      )(event(), new AbortController().signal),
    ).rejects.toMatchObject({ code: "webhook_load_failed", retryable: true });
    await expect(
      createWebhookDeliveryHandler(options({ keyring: { get: () => undefined } }))(
        event(),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "webhook_secret_unavailable" });
    const base = await options().loader.load(deliveryId, event());
    await expect(
      createWebhookDeliveryHandler(
        options({
          loader: {
            load: async () => ({
              ...base,
              delivery: { ...base.delivery!, createdAt: new Date("invalid") },
            }),
          },
        }),
      )(event(), new AbortController().signal),
    ).rejects.toMatchObject({ code: "webhook_delivery_time_invalid" });
  });

  it("converts resolver failure to jittered retry but preserves policy rejections", async () => {
    const failing = options({
      resolve: async () => {
        throw new Error("dns");
      },
      random: () => 1,
    });
    await expect(
      createWebhookDeliveryHandler(failing)(event(), new AbortController().signal),
    ).rejects.toMatchObject({ code: "webhook_dns_failed", retryDelayMs: 2_000 });
    const privateAnswer = options({ resolve: async () => [{ address: "127.0.0.1", family: 4 }] });
    await expect(
      createWebhookDeliveryHandler(privateAnswer)(event(), new AbortController().signal),
    ).rejects.toMatchObject({ code: "webhook_dns_rejected", retryable: false });
  });

  it("rejects expired and future-corrupt deliveries while accepting the exact age boundary", async () => {
    const now = new Date("2026-07-13T00:00:00Z");
    const base = await options().loader.load(deliveryId, event());
    const at = (createdAt: Date) =>
      options({
        loader: { load: async () => ({ ...base, delivery: { ...base.delivery!, createdAt } }) },
        now: () => now,
        maxDeliveryAgeMs: 60_000,
      });
    await expect(
      createWebhookDeliveryHandler(at(new Date(now.getTime() - 60_000)))(
        event(),
        new AbortController().signal,
      ),
    ).resolves.toBeUndefined();
    await expect(
      createWebhookDeliveryHandler(at(new Date(now.getTime() - 60_001)))(
        event(),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "webhook_delivery_expired", retryable: false });
    await expect(
      createWebhookDeliveryHandler(at(new Date(now.getTime() + 1)))(
        event(),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "webhook_delivery_expired", retryable: false });
  });

  it.each([
    [408, true],
    [425, true],
    [429, true],
    [500, true],
    [302, false],
    [400, false],
  ])("classifies HTTP %i deterministically", async (statusCode, retryable) => {
    const input = options({ request: async () => ({ statusCode }) });
    await expect(
      createWebhookDeliveryHandler(input)(event(), new AbortController().signal),
    ).rejects.toMatchObject({ retryable });
  });

  it("honors a bounded Retry-After and never leaks raw request errors", async () => {
    const input = options({
      request: async () => ({ statusCode: 429, headers: { "retry-after": "12" } }),
    });
    await expect(
      createWebhookDeliveryHandler(input)(event(), new AbortController().signal),
    ).rejects.toMatchObject({ retryDelayMs: 12_000 });
    const secretError = options({
      request: async () => {
        throw new Error("https://user:secret@private.example/body");
      },
    });
    await expect(
      createWebhookDeliveryHandler(secretError)(event(), new AbortController().signal),
    ).rejects.toMatchObject({ code: "webhook_request_failed" });
  });

  it("uses deterministic full jitter when a retryable response has no Retry-After", async () => {
    const input = options({
      request: async () => ({ statusCode: 503 }),
      random: () => 0.75,
      maxRetryAfterMs: 10_000,
    });
    await expect(
      createWebhookDeliveryHandler(input)(event(), new AbortController().signal),
    ).rejects.toMatchObject({ retryable: true, retryDelayMs: 1_500 });
    expect(jitterDelayMs(2, 10_000, () => 0)).toBe(0);
    expect(jitterDelayMs(2, 10_000, () => 1)).toBe(4_000);
    expect(jitterDelayMs(99, 1_000_000, () => 1)).toBe(64_000);
  });

  it("allows a zero retry-delay cap while retaining retry classification", async () => {
    const input = options({ request: async () => ({ statusCode: 503 }), maxRetryAfterMs: 0 });
    await expect(
      createWebhookDeliveryHandler(input)(event(), new AbortController().signal),
    ).rejects.toMatchObject({ retryable: true, retryDelayMs: 0 });
  });

  it("validates handler bounds and jitter inputs eagerly", () => {
    expect(() => createWebhookDeliveryHandler(options({ connectTimeoutMs: 99 }))).toThrow(
      "timeout",
    );
    expect(() => createWebhookDeliveryHandler(options({ requestTimeoutMs: 120_001 }))).toThrow(
      "timeout",
    );
    expect(() => createWebhookDeliveryHandler(options({ maxResponseBytes: 0 }))).toThrow("limit");
    expect(() => createWebhookDeliveryHandler(options({ maxRetryAfterMs: -1 }))).toThrow("limit");
    expect(() => createWebhookDeliveryHandler(options({ maxDeliveryAgeMs: 59_999 }))).toThrow(
      "age",
    );
    expect(() => jitterDelayMs(0, 1, () => 0)).toThrow("invalid");
    expect(() => jitterDelayMs(1, -1, () => 0)).toThrow("invalid");
    expect(jitterDelayMs(1, 100, () => Number.NaN)).toBe(0);
  });
});
