import Fastify, { type FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { HostedAuthIngressGuard, hostedRequestLogProtection } from "./hosted-auth-ingress.js";

const ORIGIN = "https://hosted.schedule.test";
const LIMITS = { loginStartsPerMinute: 2, maxConcurrentCallbacks: 1 };

function request(
  rawHeaders: readonly string[] = ["host", "hosted.schedule.test"],
  protocol = "https",
): FastifyRequest {
  const headers: Record<string, string> = {};
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    headers[rawHeaders[index]!.toLowerCase()] = rawHeaders[index + 1]!;
  }
  return { protocol, headers, raw: { rawHeaders: [...rawHeaders] } } as never;
}

describe("hosted auth ingress", () => {
  it.each([
    ["missing host", []],
    ["alternate host", ["host", "other.schedule.test"]],
    ["duplicate host", ["host", "hosted.schedule.test", "host", "hosted.schedule.test"]],
    [
      "alternate forwarded host",
      ["host", "hosted.schedule.test", "x-forwarded-host", "other.schedule.test"],
    ],
    ["plaintext forwarding", ["host", "hosted.schedule.test", "x-forwarded-proto", "http"]],
  ] as const)("rejects %s", (_label, headers) => {
    expect(new HostedAuthIngressGuard(ORIGIN, LIMITS).accepts(request(headers))).toBe(false);
  });

  it("accepts only the exact HTTPS public boundary", () => {
    const guard = new HostedAuthIngressGuard(ORIGIN, LIMITS);
    expect(guard.accepts(request())).toBe(true);
    expect(guard.accepts(request(undefined, "http"))).toBe(false);
    expect(
      guard.accepts(
        request([
          "host",
          "hosted.schedule.test",
          "x-forwarded-host",
          "hosted.schedule.test",
          "x-forwarded-proto",
          "https",
        ]),
      ),
    ).toBe(true);
  });

  it("accepts forwarded HTTPS only through a trusted proxy", async () => {
    const guard = new HostedAuthIngressGuard(ORIGIN, LIMITS);
    const trusted = Fastify({ trustProxy: "127.0.0.1" });
    const untrusted = Fastify({ trustProxy: false });
    for (const app of [trusted, untrusted]) {
      app.get("/", async (incoming) => ({ accepted: guard.accepts(incoming) }));
    }
    const options = {
      method: "GET" as const,
      url: "/",
      headers: {
        host: "hosted.schedule.test",
        "x-forwarded-host": "hosted.schedule.test",
        "x-forwarded-proto": "https",
      },
    };
    try {
      expect((await trusted.inject(options)).json()).toEqual({ accepted: true });
      expect((await untrusted.inject(options)).json()).toEqual({ accepted: false });
    } finally {
      await Promise.all([trusted.close(), untrusted.close()]);
    }
  });

  it("bounds aggregate login starts in constant space and resets the window", () => {
    let now = 10_000;
    const guard = new HostedAuthIngressGuard(ORIGIN, LIMITS, () => now);

    expect(guard.admitLoginStart()).toEqual({ allowed: true });
    expect(guard.admitLoginStart()).toEqual({ allowed: true });
    expect(guard.admitLoginStart()).toEqual({ allowed: false, retryAfterSeconds: 60 });
    now += 60_000;
    expect(guard.admitLoginStart()).toEqual({ allowed: true });
  });

  it("bounds concurrent callbacks and makes release idempotent", () => {
    const guard = new HostedAuthIngressGuard(ORIGIN, LIMITS);
    const release = guard.enterCallback();
    expect(release).toBeTypeOf("function");
    expect(guard.enterCallback()).toBeNull();
    release!();
    release!();
    expect(guard.enterCallback()).toBeTypeOf("function");
  });

  it("keeps request paths but excludes OIDC query credentials from logs", async () => {
    const logs: string[] = [];
    const app = await buildApp({
      logger: {
        level: "info",
        ...hostedRequestLogProtection(),
        stream: { write: (message: string) => logs.push(message) },
      },
    });
    try {
      await app.inject({
        method: "GET",
        url: "/v1/auth/callback?code=private-code&state=private-state",
        headers: {
          cookie: "session=private-cookie",
          authorization: "Bearer private-bearer",
        },
      });
    } finally {
      await app.close();
    }
    const rendered = logs.join("");
    expect(rendered).toContain("/v1/auth/callback");
    for (const sentinel of ["private-code", "private-state", "private-cookie", "private-bearer"]) {
      expect(rendered).not.toContain(sentinel);
    }
    expect(hostedRequestLogProtection().redact.paths).toContain('res.headers["set-cookie"]');
  });
});
