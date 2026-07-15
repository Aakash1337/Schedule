import { createServer, type Server } from "node:http";
import { once } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import { HttpScheduleDeliveryGateway, ScheduleDeliveryGatewayError } from "./schedule-client.js";

const credential = `00000000-0000-4000-8000-000000000001.${"A".repeat(43)}`;
const deliveryId = "00000000-0000-4000-8000-000000000101";
const claimToken = "00000000-0000-4000-8000-000000000102";
const servers: Server[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});

async function startServer(
  handler: Parameters<typeof createServer>[0],
): Promise<{ readonly url: string }> {
  const server = createServer(handler);
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing server address.");
  return { url: `http://127.0.0.1:${address.port}` };
}

async function readBody(request: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString("utf8");
}

describe("Schedule delivery HTTP client", () => {
  it("sends exact claim authentication/version/idempotency and validates the bounded command", async () => {
    const observed: { path?: string; authorization?: string; key?: string; body?: string } = {};
    const server = await startServer(async (request, response) => {
      observed.path = request.url;
      observed.authorization = request.headers.authorization;
      observed.key = request.headers["idempotency-key"] as string;
      observed.body = await readBody(request);
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          version: "schedule.integration/v1",
          requestId: "request-1",
          data: {
            command: {
              deliveryId,
              intentId: deliveryId,
              dedupeKey: deliveryId,
              kind: "one_off",
              targetType: "one_off",
              title: "Take medication",
              scheduledFor: "2026-07-15T01:00:00.000Z",
              localDate: "2026-07-14",
              priority: 50,
              attempt: 1,
              claimToken,
              leaseExpiresAt: "2026-07-15T01:05:00.000Z",
            },
          },
        }),
      );
    });
    const client = new HttpScheduleDeliveryGateway(server.url, credential);

    await expect(client.claim("claim-key-1")).resolves.toMatchObject({ deliveryId, claimToken });
    expect(observed).toEqual({
      path: "/v1/integrations/reminder-deliveries/claim",
      authorization: `Bearer ${credential}`,
      key: "claim-key-1",
      body: JSON.stringify({ version: "schedule.integration/v1" }),
    });
  });

  it("sends only the discriminated bounded receipt contract", async () => {
    let observedBody = "";
    const server = await startServer(async (request, response) => {
      observedBody = await readBody(request);
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          version: "schedule.integration/v1",
          requestId: "request-2",
          data: { deliveryId, status: "retry_scheduled" },
        }),
      );
    });
    const client = new HttpScheduleDeliveryGateway(server.url, credential);
    await client.recordReceipt("receipt-key-1", {
      deliveryId,
      claimToken,
      outcome: "retryable_failure",
      failureCode: "provider_unavailable",
      retryAfterSeconds: 10,
    });
    expect(JSON.parse(observedBody)).toEqual({
      version: "schedule.integration/v1",
      deliveryId,
      claimToken,
      outcome: "retryable_failure",
      failureCode: "provider_unavailable",
      retryAfterSeconds: 10,
    });
  });

  it("rejects malformed responses without exposing the credential", async () => {
    const server = await startServer((_request, response) => response.end("not-json"));
    const client = new HttpScheduleDeliveryGateway(server.url, credential);
    const error = await client.claim("claim-key-2").catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ScheduleDeliveryGatewayError);
    expect(error).toMatchObject({ reason: "invalid_response", retryable: false });
    expect(String(error)).not.toContain(credential);
  });

  it("rejects oversized responses without exposing the credential", async () => {
    const server = await startServer((_request, response) =>
      response.end(JSON.stringify({ private: "x".repeat(65 * 1024) })),
    );
    const client = new HttpScheduleDeliveryGateway(server.url, credential);
    const error = await client.claim("claim-key-oversized").catch((reason: unknown) => reason);
    expect(error).toMatchObject({ reason: "invalid_response", retryable: false });
    expect(String(error)).not.toContain(credential);
  });

  it("stops reading a streamed response at the byte limit", async () => {
    const server = await startServer((_request, response) => {
      response.setHeader("transfer-encoding", "chunked");
      response.write("x".repeat(40 * 1024));
      response.end("x".repeat(40 * 1024));
    });
    const client = new HttpScheduleDeliveryGateway(server.url, credential);
    await expect(client.claim("claim-stream-limit")).rejects.toMatchObject({
      reason: "invalid_response",
      retryable: false,
    });
  });

  it("hard-times out a fetch implementation that ignores cancellation", async () => {
    vi.useFakeTimers();
    const ignoredFetch = vi.fn(async () => new Promise<Response>(() => undefined));
    const client = new HttpScheduleDeliveryGateway("http://127.0.0.1:1", credential, {
      timeoutMilliseconds: 1_000,
      fetch: ignoredFetch as typeof fetch,
    });
    const pending = client.claim("claim-hard-timeout");
    const assertion = expect(pending).rejects.toMatchObject({
      reason: "network_unavailable",
      retryable: true,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
  });

  it("rejects mismatched reminder kind and target semantics", async () => {
    const server = await startServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          version: "schedule.integration/v1",
          requestId: "request-invalid-target",
          data: {
            command: {
              deliveryId,
              intentId: deliveryId,
              dedupeKey: deliveryId,
              kind: "daily_digest",
              targetType: "one_off",
              title: null,
              scheduledFor: "2026-07-15T01:00:00.000Z",
              localDate: "2026-07-14",
              priority: 50,
              attempt: 1,
              claimToken,
              leaseExpiresAt: "2026-07-15T01:05:00.000Z",
            },
          },
        }),
      );
    });
    const client = new HttpScheduleDeliveryGateway(server.url, credential);
    await expect(client.claim("claim-invalid-target")).rejects.toMatchObject({
      reason: "invalid_response",
      retryable: false,
    });
  });

  it("rejects a receipt response for a different delivery", async () => {
    const server = await startServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          version: "schedule.integration/v1",
          requestId: "request-mismatched-receipt",
          data: {
            deliveryId: "00000000-0000-4000-8000-000000000999",
            status: "delivered",
          },
        }),
      );
    });
    const client = new HttpScheduleDeliveryGateway(server.url, credential);
    await expect(
      client.recordReceipt("receipt-mismatch", {
        deliveryId,
        claimToken,
        outcome: "delivered",
      }),
    ).rejects.toMatchObject({ reason: "invalid_response", retryable: false });
  });

  it("rejects invalid idempotency keys and bounded credentials before any request", () => {
    const client = new HttpScheduleDeliveryGateway("http://127.0.0.1:1", credential);
    expect(() => new HttpScheduleDeliveryGateway("http://127.0.0.1:1", "short")).toThrow(
      "bearer credential",
    );
    expect(client.claim(" padded ")).rejects.toThrow("Idempotency keys");
  });

  it("rejects malformed outbound receipts before any request", async () => {
    const fetchImplementation = vi.fn<typeof fetch>();
    const client = new HttpScheduleDeliveryGateway("http://127.0.0.1:1", credential, {
      fetch: fetchImplementation,
    });
    await expect(
      client.recordReceipt("invalid-receipt", {
        deliveryId,
        claimToken,
        outcome: "retryable_failure",
        failureCode: "Private failure!",
        retryAfterSeconds: 999,
      }),
    ).rejects.toThrow("bounded contract");
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it.each([
    "http://example.com",
    "ftp://127.0.0.1",
    "http://localhost",
    "https://user:password@example.com",
    "https://example.com?token=secret",
  ])("rejects unsafe gateway URL %s", (url) => {
    expect(() => new HttpScheduleDeliveryGateway(url, credential)).toThrow();
  });

  it.each([
    [401, "authentication_failed", false],
    [409, "request_conflict", false],
    [429, "rate_limited", true],
    [503, "server_unavailable", true],
  ] as const)("classifies gateway status %i", async (status, reason, retryable) => {
    const server = await startServer((_request, response) => {
      response.statusCode = status;
      response.end("private upstream details");
    });
    const client = new HttpScheduleDeliveryGateway(server.url, credential);
    await expect(client.claim(`claim-${status}`)).rejects.toMatchObject({ reason, retryable });
  });
});
