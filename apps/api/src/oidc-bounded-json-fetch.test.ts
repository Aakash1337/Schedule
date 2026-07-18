import type { FetchImplementation } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchBoundedOidcJson, OidcBoundedJsonFetchError } from "./oidc-bounded-json-fetch.js";

const URL = "https://issuer.schedule.test/.well-known/openid-configuration";

afterEach(() => {
  vi.useRealTimers();
});

function fetchDocument(transport: FetchImplementation, signal: AbortSignal) {
  return fetchBoundedOidcJson({
    url: URL,
    transport,
    signal,
    timeoutMilliseconds: 3_000,
    requestHeaders: new Headers({ accept: "application/json" }),
    maximumBodyBytes: 64 * 1_024,
    acceptedContentTypes: ["application/json"],
  });
}

describe("fetchBoundedOidcJson cancellation", () => {
  it("rejects an already-aborted upstream signal without invoking transport", async () => {
    const controller = new AbortController();
    controller.abort();
    const transport = vi.fn(
      async () => new Response("{}", { headers: { "content-type": "application/json" } }),
    ) as FetchImplementation & ReturnType<typeof vi.fn>;

    await expect(fetchDocument(transport, controller.signal)).rejects.toEqual(
      new OidcBoundedJsonFetchError(),
    );
    expect(transport).not.toHaveBeenCalled();
  });

  it("handles an upstream abort triggered synchronously during transport invocation", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let transportSignal: AbortSignal | undefined;
    const transport = vi.fn(async (_resource, options) => {
      transportSignal = options.signal;
      controller.abort();
      return new Promise<Response>(() => undefined);
    }) as FetchImplementation & ReturnType<typeof vi.fn>;

    await expect(fetchDocument(transport, controller.signal)).rejects.toEqual(
      new OidcBoundedJsonFetchError(),
    );
    expect(transportSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a later upstream abort even when transport ignores it and clears the deadline", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let transportSignal: AbortSignal | undefined;
    const transport = vi.fn(async (_resource, options) => {
      transportSignal = options.signal;
      return new Promise<Response>(() => undefined);
    }) as FetchImplementation & ReturnType<typeof vi.fn>;
    const pending = fetchDocument(transport, controller.signal);
    const rejection = expect(pending).rejects.toEqual(new OidcBoundedJsonFetchError());

    expect(transport).toHaveBeenCalledTimes(1);
    expect(transportSignal?.aborted).toBe(false);
    controller.abort();

    await rejection;
    expect(transportSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
