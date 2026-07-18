import { describe, expect, it, vi } from "vitest";

import {
  parseHostedHealthOrigin,
  verifyHostedHealth,
  type HostedHealthProbeDependencies,
} from "./verify-hosted-health.js";

const origin = "https://schedule.example.com";

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fixture(fetch: typeof globalThis.fetch) {
  const timeoutSignal = vi.fn(() => new AbortController().signal);
  const log = vi.fn();
  const dependencies: HostedHealthProbeDependencies = { fetch, timeoutSignal, log };
  return { dependencies, timeoutSignal, log };
}

describe("hosted public health probe", () => {
  it("checks liveness then readiness with fixed private request options", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response(200, { status: "alive" }))
      .mockResolvedValueOnce(response(200, { status: "ready" }));
    const { dependencies, timeoutSignal, log } = fixture(fetch);

    await verifyHostedHealth({ SCHEDULE_HOSTED_HEALTH_ORIGIN: origin }, dependencies);

    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      `${origin}/health/live`,
      `${origin}/health/ready`,
    ]);
    for (const [, options] of fetch.mock.calls) {
      expect(options).toMatchObject({
        method: "GET",
        headers: { accept: "application/json" },
        credentials: "omit",
        redirect: "error",
      });
      expect(options?.signal).toBeInstanceOf(AbortSignal);
    }
    expect(timeoutSignal.mock.calls).toEqual([[10_000], [10_000]]);
    expect(log.mock.calls).toEqual([
      ["[hosted-health schedule.example.com] /health/live ok"],
      ["[hosted-health schedule.example.com] /health/ready ok"],
    ]);
  });

  it.each([
    ["missing", undefined],
    ["blank", ""],
    ["HTTP", "http://schedule.example.com"],
    ["credentials", "https://user:super-secret@schedule.example.com"],
    ["path", `${origin}/api`],
    ["query", `${origin}?debug=1`],
    ["fragment", `${origin}#debug`],
    ["trailing slash", `${origin}/`],
    ["localhost", "https://localhost"],
    ["localhost subdomain", "https://api.localhost"],
    ["IPv4", "https://192.0.2.1"],
    ["IPv6", "https://[2001:db8::1]"],
    ["noncanonical default port", "https://schedule.example.com:443"],
  ])("rejects a %s target before network I/O", async (_caseName, target) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    const { dependencies } = fixture(fetch);

    await expect(
      verifyHostedHealth({ SCHEDULE_HOSTED_HEALTH_ORIGIN: target }, dependencies),
    ).rejects.toThrow("canonical HTTPS origin with a DNS hostname");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("accepts one canonical HTTPS origin with an explicit non-default port", () => {
    expect(
      parseHostedHealthOrigin({
        SCHEDULE_HOSTED_HEALTH_ORIGIN: "https://schedule.example.com:8443",
      }).origin,
    ).toBe("https://schedule.example.com:8443");
  });

  it.each([
    ["readiness failure", 503, { status: "not_ready" }],
    ["extra response fields", 200, { status: "ready", detail: "secret" }],
    ["wrong response state", 200, { status: "alive" }],
  ])("fails closed for %s", async (_caseName, status, body) => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(response(200, { status: "alive" }))
      .mockResolvedValueOnce(response(status, body));
    const { dependencies, log } = fixture(fetch);

    await expect(
      verifyHostedHealth({ SCHEDULE_HOSTED_HEALTH_ORIGIN: origin }, dependencies),
    ).rejects.toThrow("/health/ready returned an unhealthy response");
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid JSON without echoing the response", async () => {
    const secret = "private-upstream-body";
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(secret, {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const { dependencies } = fixture(fetch);

    await expect(
      verifyHostedHealth({ SCHEDULE_HOSTED_HEALTH_ORIGIN: origin }, dependencies),
    ).rejects.not.toThrow(secret);
  });

  it("redacts network and timeout errors", async () => {
    const secret = "private-network-detail";
    for (const failure of [new Error(secret), new DOMException(secret, "TimeoutError")]) {
      const fetch = vi.fn<typeof globalThis.fetch>().mockRejectedValue(failure);
      const { dependencies } = fixture(fetch);

      let thrown: unknown;
      try {
        await verifyHostedHealth({ SCHEDULE_HOSTED_HEALTH_ORIGIN: origin }, dependencies);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(Error);
      expect((thrown as Error).message).toBe("Hosted health probe /health/live request failed.");
      expect((thrown as Error).message).not.toContain(secret);
    }
  });

  it("does not reflect credential-like target input", () => {
    const secret = "super-secret";
    expect(() =>
      parseHostedHealthOrigin({
        SCHEDULE_HOSTED_HEALTH_ORIGIN: `https://user:${secret}@schedule.example.com`,
      }),
    ).toThrowError(
      new Error(
        "SCHEDULE_HOSTED_HEALTH_ORIGIN must be a canonical HTTPS origin with a DNS hostname.",
      ),
    );
  });
});
