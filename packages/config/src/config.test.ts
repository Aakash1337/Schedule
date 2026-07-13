import { describe, expect, it } from "vitest";

import { loadApiConfig, loadWorkerConfig } from "./index.js";

describe("runtime configuration", () => {
  it("provides safe local defaults", () => {
    const config = loadApiConfig({});
    expect(config.API_HOST).toBe("127.0.0.1");
    expect(config.API_PORT).toBe(4_000);
    expect(config.API_TRUSTED_PROXIES).toEqual([]);
    expect(config.PRODUCT_API_MODE).toBe("local_unauthenticated");
    expect(config.INTEGRATION_API_MODE).toBe("disabled");
    expect(config.INTEGRATION_API_PEPPER).toBeUndefined();
    expect(config.INTEGRATION_CONFIRMATION_TTL_SECONDS).toBe(600);
    expect(config.INTEGRATION_RATE_LIMIT_PER_MINUTE).toBe(120);
  });

  it("keeps the unauthenticated product API disabled by default in production", () => {
    const config = loadApiConfig({ NODE_ENV: "production" });
    expect(config.PRODUCT_API_MODE).toBe("disabled");
    expect(config.INTEGRATION_API_MODE).toBe("disabled");
  });

  it("rejects attempts to expose the unauthenticated product API", () => {
    expect(() =>
      loadApiConfig({
        NODE_ENV: "production",
        PRODUCT_API_MODE: "local_unauthenticated",
      }),
    ).toThrow(/non-production loopback/);
    expect(() =>
      loadApiConfig({
        API_HOST: "0.0.0.0",
        PRODUCT_API_MODE: "local_unauthenticated",
      }),
    ).toThrow(/non-production loopback/);
  });

  it("coerces worker numbers from environment strings", () => {
    const config = loadWorkerConfig({ OUTBOX_BATCH_SIZE: "40" });
    expect(config.OUTBOX_BATCH_SIZE).toBe(40);
  });

  it("rejects invalid ports", () => {
    expect(() => loadApiConfig({ API_PORT: "70000" })).toThrow();
  });

  it("parses an explicit trusted-proxy IP and CIDR allowlist", () => {
    expect(
      loadApiConfig({
        API_TRUSTED_PROXIES:
          " 127.0.0.1,10.0.0.0/8,104.16.0.0/13,2001:DB8::1,2400:cb00::/32,2001:db8:abcd::/48 ",
      }).API_TRUSTED_PROXIES,
    ).toEqual([
      "127.0.0.1",
      "10.0.0.0/8",
      "104.16.0.0/13",
      "2001:db8::1",
      "2400:cb00::/32",
      "2001:db8:abcd::/48",
    ]);
  });

  it.each([
    "true",
    "*",
    "all",
    "proxy.internal",
    "10.0.0.0/",
    "10.0.0.0/1",
    "10.0.0.0/33",
    "0.0.0.0/0",
    "::/0",
    "2001:db8::/16",
    "127.0.0.1,",
    "127.0.0.1,127.0.0.1",
  ])("rejects unsafe trusted-proxy value %s", (value) => {
    expect(() => loadApiConfig({ API_TRUSTED_PROXIES: value })).toThrow(/API_TRUSTED_PROXIES/);
  });

  it("requires a strong pepper before enabling the integration API", () => {
    expect(
      loadApiConfig({ INTEGRATION_API_MODE: "disabled", INTEGRATION_API_PEPPER: "staged" })
        .INTEGRATION_API_PEPPER,
    ).toBe("staged");
    expect(() => loadApiConfig({ INTEGRATION_API_MODE: "enabled" })).toThrow(
      /INTEGRATION_API_PEPPER/,
    );
    expect(() =>
      loadApiConfig({
        INTEGRATION_API_MODE: "enabled",
        INTEGRATION_API_PEPPER: "too-short",
      }),
    ).toThrow();

    expect(
      loadApiConfig({
        INTEGRATION_API_MODE: "enabled",
        INTEGRATION_API_PEPPER: "a".repeat(32),
      }).INTEGRATION_API_MODE,
    ).toBe("enabled");
  });

  it("coerces bounded integration controls from environment strings", () => {
    const config = loadApiConfig({
      INTEGRATION_CONFIRMATION_TTL_SECONDS: "300",
      INTEGRATION_RATE_LIMIT_PER_MINUTE: "60",
    });
    expect(config.INTEGRATION_CONFIRMATION_TTL_SECONDS).toBe(300);
    expect(config.INTEGRATION_RATE_LIMIT_PER_MINUTE).toBe(60);

    expect(() => loadApiConfig({ INTEGRATION_CONFIRMATION_TTL_SECONDS: "59" })).toThrow();
    expect(() => loadApiConfig({ INTEGRATION_CONFIRMATION_TTL_SECONDS: "3601" })).toThrow();
    expect(() => loadApiConfig({ INTEGRATION_RATE_LIMIT_PER_MINUTE: "0" })).toThrow();
    expect(() => loadApiConfig({ INTEGRATION_RATE_LIMIT_PER_MINUTE: "1001" })).toThrow();
  });
});
