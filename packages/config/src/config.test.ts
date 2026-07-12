import { describe, expect, it } from "vitest";

import { loadApiConfig, loadWorkerConfig } from "./index.js";

describe("runtime configuration", () => {
  it("provides safe local defaults", () => {
    const config = loadApiConfig({});
    expect(config.API_HOST).toBe("127.0.0.1");
    expect(config.API_PORT).toBe(4_000);
    expect(config.PRODUCT_API_MODE).toBe("local_unauthenticated");
  });

  it("keeps the unauthenticated product API disabled by default in production", () => {
    const config = loadApiConfig({ NODE_ENV: "production" });
    expect(config.PRODUCT_API_MODE).toBe("disabled");
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
});
