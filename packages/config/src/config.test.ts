import { describe, expect, it } from "vitest";

import { loadApiConfig, loadWorkerConfig } from "./index.js";

const webhookKeyMaterial = (byte: number) => Buffer.alloc(32, byte).toString("base64url");

describe("runtime configuration", () => {
  it("provides safe local defaults", () => {
    const config = loadApiConfig({});
    expect(config.API_HOST).toBe("127.0.0.1");
    expect(config.API_PORT).toBe(4_000);
    expect(config.API_TRUSTED_PROXIES).toEqual([]);
    expect(config.PRODUCT_API_MODE).toBe("local_unauthenticated");
    expect(config.LOCAL_MODEL_ADVISOR_MODE).toBe("disabled");
    expect(config.LOCAL_MODEL_ADVISOR_URL).toBe("http://127.0.0.1:11434");
    expect(config.LOCAL_MODEL_ADVISOR_MODEL).toBe("gemma4:e4b");
    expect(config.LOCAL_MODEL_ADVISOR_CONNECT_TIMEOUT_MS).toBe(2_000);
    expect(config.LOCAL_MODEL_ADVISOR_REQUEST_TIMEOUT_MS).toBe(60_000);
    expect(config.LOCAL_MODEL_ADVISOR_MAX_RESPONSE_BYTES).toBe(32_768);
    expect(config.LOCAL_MODEL_ADVISOR_MAX_CONCURRENT).toBe(1);
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

  it("loads an explicitly enabled local Ollama advisor with bounded controls", () => {
    const config = loadApiConfig({
      LOCAL_MODEL_ADVISOR_MODE: "ollama",
      LOCAL_MODEL_ADVISOR_URL: "http://127.0.0.1:12345",
      LOCAL_MODEL_ADVISOR_MODEL: "gemma4:31b",
      LOCAL_MODEL_ADVISOR_CONNECT_TIMEOUT_MS: "100",
      LOCAL_MODEL_ADVISOR_REQUEST_TIMEOUT_MS: "120000",
      LOCAL_MODEL_ADVISOR_MAX_RESPONSE_BYTES: "65536",
      LOCAL_MODEL_ADVISOR_MAX_CONCURRENT: "4",
    });

    expect(config.LOCAL_MODEL_ADVISOR_MODE).toBe("ollama");
    expect(config.LOCAL_MODEL_ADVISOR_URL).toBe("http://127.0.0.1:12345");
    expect(config.LOCAL_MODEL_ADVISOR_MODEL).toBe("gemma4:31b");
    expect(config.LOCAL_MODEL_ADVISOR_CONNECT_TIMEOUT_MS).toBe(100);
    expect(config.LOCAL_MODEL_ADVISOR_REQUEST_TIMEOUT_MS).toBe(120_000);
    expect(config.LOCAL_MODEL_ADVISOR_MAX_RESPONSE_BYTES).toBe(65_536);
    expect(config.LOCAL_MODEL_ADVISOR_MAX_CONCURRENT).toBe(4);
  });

  it.each(["gemma4:e2b", "gemma4:e4b", "gemma4:26b", "gemma4:31b"] as const)(
    "accepts the local-only advisor model %s",
    (model) => {
      expect(loadApiConfig({ LOCAL_MODEL_ADVISOR_MODEL: model }).LOCAL_MODEL_ADVISOR_MODEL).toBe(
        model,
      );
    },
  );

  it("rejects unsupported local-model advisor modes", () => {
    expect(() => loadApiConfig({ LOCAL_MODEL_ADVISOR_MODE: "enabled" })).toThrow();
  });

  it.each([
    "http://localhost:11434",
    "http://127.0.0.2:11434",
    "http://127.1:11434",
    "http://2130706433:11434",
    "http://0177.0.0.1:11434",
    "http://[::1]:11434",
    "https://127.0.0.1:11434",
    "http://user:pass@127.0.0.1:11434",
    "http://127.0.0.1:11434/",
    "http://127.0.0.1:11434/api",
    "http://127.0.0.1:11434?next=http://example.com",
    "http://127.0.0.1:11434#fragment",
    "http://127.0.0.1:0",
    "http://127.0.0.1:65536",
    "http://127.0.0.1:011434",
    " http://127.0.0.1:11434",
  ])("rejects non-canonical local-model advisor URL %s", (value) => {
    expect(() => loadApiConfig({ LOCAL_MODEL_ADVISOR_URL: value })).toThrow(
      /LOCAL_MODEL_ADVISOR_URL/,
    );
  });

  it.each([
    "gemma4",
    "gemma4:latest",
    "gemma4:e4b-cloud",
    "gemma4:E4B",
    " gemma4:e4b",
    "gemma4:e4b ",
  ])("rejects non-allowlisted local-model advisor model %s", (value) => {
    expect(() => loadApiConfig({ LOCAL_MODEL_ADVISOR_MODEL: value })).toThrow();
  });

  it("coerces and bounds every local-model advisor resource control", () => {
    expect(() => loadApiConfig({ LOCAL_MODEL_ADVISOR_CONNECT_TIMEOUT_MS: "99" })).toThrow();
    expect(() => loadApiConfig({ LOCAL_MODEL_ADVISOR_CONNECT_TIMEOUT_MS: "10001" })).toThrow();
    expect(() => loadApiConfig({ LOCAL_MODEL_ADVISOR_CONNECT_TIMEOUT_MS: "100.5" })).toThrow();
    expect(() => loadApiConfig({ LOCAL_MODEL_ADVISOR_REQUEST_TIMEOUT_MS: "999" })).toThrow();
    expect(() => loadApiConfig({ LOCAL_MODEL_ADVISOR_REQUEST_TIMEOUT_MS: "120001" })).toThrow();
    expect(() => loadApiConfig({ LOCAL_MODEL_ADVISOR_REQUEST_TIMEOUT_MS: "1000.5" })).toThrow();
    expect(() => loadApiConfig({ LOCAL_MODEL_ADVISOR_MAX_RESPONSE_BYTES: "1023" })).toThrow();
    expect(() => loadApiConfig({ LOCAL_MODEL_ADVISOR_MAX_RESPONSE_BYTES: "65537" })).toThrow();
    expect(() => loadApiConfig({ LOCAL_MODEL_ADVISOR_MAX_RESPONSE_BYTES: "2048.5" })).toThrow();
    expect(() => loadApiConfig({ LOCAL_MODEL_ADVISOR_MAX_CONCURRENT: "0" })).toThrow();
    expect(() => loadApiConfig({ LOCAL_MODEL_ADVISOR_MAX_CONCURRENT: "5" })).toThrow();
    expect(() => loadApiConfig({ LOCAL_MODEL_ADVISOR_MAX_CONCURRENT: "1.5" })).toThrow();
  });

  it("requires the local-model request timeout to cover the connect timeout", () => {
    expect(
      loadApiConfig({
        LOCAL_MODEL_ADVISOR_CONNECT_TIMEOUT_MS: "10000",
        LOCAL_MODEL_ADVISOR_REQUEST_TIMEOUT_MS: "10000",
      }).LOCAL_MODEL_ADVISOR_REQUEST_TIMEOUT_MS,
    ).toBe(10_000);
    expect(() =>
      loadApiConfig({
        LOCAL_MODEL_ADVISOR_CONNECT_TIMEOUT_MS: "10000",
        LOCAL_MODEL_ADVISOR_REQUEST_TIMEOUT_MS: "9999",
      }),
    ).toThrow(/LOCAL_MODEL_ADVISOR_REQUEST_TIMEOUT_MS/);
  });

  it("coerces worker numbers from environment strings", () => {
    const config = loadWorkerConfig({ OUTBOX_BATCH_SIZE: "40" });
    expect(config.OUTBOX_BATCH_SIZE).toBe(40);
  });

  it("keeps outbound webhook delivery disabled with an immutable empty keyring by default", () => {
    const config = loadWorkerConfig({});
    expect(config.WEBHOOK_DELIVERY_MODE).toBe("disabled");
    expect(config.WEBHOOK_MASTER_KEYS).toEqual([]);
    expect(config.WEBHOOK_MASTER_KEYS_BY_ID.size).toBe(0);
    expect(config.WEBHOOK_ACTIVE_MASTER_KEY_ID).toBe("");
    expect(config.WEBHOOK_CONNECT_TIMEOUT_MS).toBe(5_000);
    expect(config.WEBHOOK_REQUEST_TIMEOUT_MS).toBe(15_000);
    expect(config.WEBHOOK_MAX_RESPONSE_BYTES).toBe(65_536);
    expect(config.WEBHOOK_MAX_RETRY_AFTER_MS).toBe(300_000);
    expect(config.WEBHOOK_MAX_DELIVERY_AGE_MS).toBe(604_800_000);
    expect(Object.isFrozen(config.WEBHOOK_MASTER_KEYS)).toBe(true);
    expect(Object.isFrozen(config.WEBHOOK_MASTER_KEYS_BY_ID)).toBe(true);
  });

  it("parses a canonical keyring and requires an active configured key before enabling delivery", () => {
    const primaryMaterial = webhookKeyMaterial(0);
    const secondaryMaterial = webhookKeyMaterial(1);
    const disabledConfig = loadWorkerConfig({
      WEBHOOK_MASTER_KEYS: `primary:${primaryMaterial},secondary:${secondaryMaterial}`,
      WEBHOOK_ACTIVE_MASTER_KEY_ID: "primary",
    });
    expect(disabledConfig.WEBHOOK_MASTER_KEYS).toEqual([
      { id: "primary", material: primaryMaterial },
      { id: "secondary", material: secondaryMaterial },
    ]);
    expect(disabledConfig.WEBHOOK_MASTER_KEYS_BY_ID.get("secondary")).toEqual({
      id: "secondary",
      material: secondaryMaterial,
    });

    expect(() => loadWorkerConfig({ WEBHOOK_DELIVERY_MODE: "enabled" })).toThrow(
      /WEBHOOK_MASTER_KEYS/,
    );
    expect(() =>
      loadWorkerConfig({
        WEBHOOK_DELIVERY_MODE: "enabled",
        WEBHOOK_MASTER_KEYS: `primary:${primaryMaterial}`,
      }),
    ).toThrow(/WEBHOOK_ACTIVE_MASTER_KEY_ID/);
    expect(
      loadWorkerConfig({
        WEBHOOK_DELIVERY_MODE: "enabled",
        WEBHOOK_MASTER_KEYS: `primary:${primaryMaterial}`,
        WEBHOOK_ACTIVE_MASTER_KEY_ID: "primary",
      }).WEBHOOK_DELIVERY_MODE,
    ).toBe("enabled");
  });

  it.each([
    "primary:short",
    `primary:${"A".repeat(42)}`,
    `primary:${"A".repeat(43)}=`,
    `primary:${"A".repeat(42)}+`,
    `Primary:${"A".repeat(43)}`,
    `primary-:${"A".repeat(43)}`,
    `primary:${webhookKeyMaterial(0)},primary:${webhookKeyMaterial(1)}`,
    `primary:${"A".repeat(43)},`,
  ])("rejects malformed webhook keyring material without echoing it", (keyring) => {
    const secretFragment = keyring.split(":")[1] ?? "";
    try {
      loadWorkerConfig({ WEBHOOK_MASTER_KEYS: keyring });
      expect.unreachable("expected invalid webhook keyring");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/WEBHOOK_MASTER_KEYS/);
      expect((error as Error).message).not.toContain(secretFragment);
    }
  });

  it("rejects invalid active key IDs and keyring references even before delivery is enabled", () => {
    const material = webhookKeyMaterial(0);
    expect(() => loadWorkerConfig({ WEBHOOK_ACTIVE_MASTER_KEY_ID: "Primary" })).toThrow(
      /WEBHOOK_ACTIVE_MASTER_KEY_ID/,
    );
    expect(() =>
      loadWorkerConfig({
        WEBHOOK_MASTER_KEYS: `primary:${material}`,
        WEBHOOK_ACTIVE_MASTER_KEY_ID: "secondary",
      }),
    ).toThrow(/WEBHOOK_ACTIVE_MASTER_KEY_ID/);
  });

  it("coerces and bounds webhook delivery timing and response controls", () => {
    const config = loadWorkerConfig({
      WEBHOOK_CONNECT_TIMEOUT_MS: "1000",
      WEBHOOK_REQUEST_TIMEOUT_MS: "2000",
      WEBHOOK_MAX_RESPONSE_BYTES: "2048",
      WEBHOOK_MAX_RETRY_AFTER_MS: "0",
      WEBHOOK_MAX_DELIVERY_AGE_MS: "60000",
    });
    expect(config.WEBHOOK_CONNECT_TIMEOUT_MS).toBe(1_000);
    expect(config.WEBHOOK_REQUEST_TIMEOUT_MS).toBe(2_000);
    expect(config.WEBHOOK_MAX_RESPONSE_BYTES).toBe(2_048);
    expect(config.WEBHOOK_MAX_RETRY_AFTER_MS).toBe(0);
    expect(config.WEBHOOK_MAX_DELIVERY_AGE_MS).toBe(60_000);

    expect(() => loadWorkerConfig({ WEBHOOK_CONNECT_TIMEOUT_MS: "99" })).toThrow();
    expect(() => loadWorkerConfig({ WEBHOOK_REQUEST_TIMEOUT_MS: "120001" })).toThrow();
    expect(() => loadWorkerConfig({ WEBHOOK_MAX_RESPONSE_BYTES: "1023" })).toThrow();
    expect(() => loadWorkerConfig({ WEBHOOK_MAX_RETRY_AFTER_MS: "3600001" })).toThrow();
    expect(() => loadWorkerConfig({ WEBHOOK_MAX_DELIVERY_AGE_MS: "59999" })).toThrow();
    expect(() => loadWorkerConfig({ WEBHOOK_MAX_DELIVERY_AGE_MS: "2592000001" })).toThrow();
    expect(() =>
      loadWorkerConfig({ WEBHOOK_CONNECT_TIMEOUT_MS: "5000", WEBHOOK_REQUEST_TIMEOUT_MS: "4999" }),
    ).toThrow(/WEBHOOK_REQUEST_TIMEOUT_MS/);
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
