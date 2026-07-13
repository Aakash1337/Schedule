import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  lookup: vi.fn(),
  request: vi.fn(),
}));

vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
vi.mock("node:https", () => ({ request: mocks.request }));

import {
  MAX_WEBHOOK_RESPONSE_HEADER_BYTES,
  requestWebhook,
  resolvePublicDns,
  type WebhookRequestInput,
} from "./webhook-delivery.js";

class FakeRequest extends EventEmitter {
  destroyedWith: Error | undefined;
  ended: Buffer | undefined;
  destroy(error: Error): this {
    this.destroyedWith = error;
    this.emit("error", error);
    return this;
  }
  end(body: Buffer): this {
    this.ended = body;
    return this;
  }
}

class FakeResponse extends EventEmitter {
  readonly headers: Record<string, string>;
  resumed = false;
  constructor(
    readonly statusCode: number | undefined,
    headers: Record<string, string> = {},
  ) {
    super();
    this.headers = headers;
  }
  resume(): this {
    this.resumed = true;
    return this;
  }
}

const input = (overrides: Partial<WebhookRequestInput> = {}): WebhookRequestInput => ({
  hostname: "receiver.example.com",
  path: "/hook",
  address: { address: "8.8.8.8", family: 4 },
  headers: { "content-type": "application/json" },
  body: Buffer.from("{}"),
  connectTimeoutMs: 100,
  requestTimeoutMs: 200,
  maxResponseBytes: 10,
  signal: new AbortController().signal,
  ...overrides,
});

describe("webhook transport adapters", () => {
  it("resolves DNS in verbatim all-address mode", async () => {
    mocks.lookup.mockResolvedValueOnce([
      { address: "8.8.8.8", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ]);
    await expect(resolvePublicDns("receiver.example.com")).resolves.toEqual([
      { address: "8.8.8.8", family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ]);
    expect(mocks.lookup).toHaveBeenCalledWith("receiver.example.com", {
      all: true,
      verbatim: true,
    });
  });

  it("pins the lookup address while preserving hostname/TLS request settings", async () => {
    const request = new FakeRequest();
    mocks.request.mockReturnValueOnce(request);
    const pending = requestWebhook(input());
    const options = mocks.request.mock.calls[0]![0];
    expect(options).toMatchObject({
      protocol: "https:",
      hostname: "receiver.example.com",
      port: 443,
      method: "POST",
      agent: false,
      maxHeaderSize: MAX_WEBHOOK_RESPONSE_HEADER_BYTES,
    });
    expect(options.lookup("receiver.example.com", {}, vi.fn())).toBeUndefined();
    const lookupCallback = vi.fn();
    options.lookup("receiver.example.com", {}, lookupCallback);
    expect(lookupCallback).toHaveBeenCalledWith(null, "8.8.8.8", 4);
    const socket = new EventEmitter();
    request.emit("socket", socket);
    socket.emit("secureConnect");
    const response = new FakeResponse(204, { "x-test": "ok" });
    request.emit("response", response);
    response.emit("end");
    await expect(pending).resolves.toEqual({ statusCode: 204, headers: { "x-test": "ok" } });
    expect(request.ended).toEqual(Buffer.from("{}"));
    expect(response.resumed).toBe(true);
  });

  it("rejects transport, response, and response-size failures", async () => {
    const requestError = new FakeRequest();
    mocks.request.mockReturnValueOnce(requestError);
    const first = requestWebhook(input());
    requestError.emit("error", new Error("network"));
    await expect(first).rejects.toThrow("network");

    const responseError = new FakeRequest();
    mocks.request.mockReturnValueOnce(responseError);
    const second = requestWebhook(input());
    const failedResponse = new FakeResponse(200);
    responseError.emit("response", failedResponse);
    failedResponse.emit("error", new Error("read"));
    await expect(second).rejects.toThrow("read");

    const tooLarge = new FakeRequest();
    mocks.request.mockReturnValueOnce(tooLarge);
    const third = requestWebhook(input({ maxResponseBytes: 1 }));
    const largeResponse = new FakeResponse(200);
    tooLarge.emit("response", largeResponse);
    largeResponse.emit("data", Buffer.from("12"));
    await expect(third).rejects.toThrow("response too large");
  });
});
