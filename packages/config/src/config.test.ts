import { describe, expect, it } from "vitest";

import { loadApiConfig, loadWorkerConfig } from "./index.js";

const webhookKeyMaterial = (byte: number) => Buffer.alloc(32, byte).toString("base64url");
const hostedPreflightEnvironment = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  HOSTED_PUBLIC_ORIGIN: "https://schedule.example.com",
  HOSTED_OIDC_ISSUER: "https://login.example.com/tenant",
  HOSTED_OIDC_CLIENT_ID: "schedule-browser",
  HOSTED_OIDC_PREFLIGHT_MODE: "enabled",
  HOSTED_OIDC_TOKEN_AUTH_METHOD: "client_secret_basic",
  HOSTED_OIDC_CLIENT_SECRET: "provider-secret",
  HOSTED_LOGIN_TRANSACTION_PEPPER: "login-transaction-pepper-with-32-bytes",
  HOSTED_SESSION_PEPPER: "browser-session-pepper-with-32-bytes",
  HOSTED_LOGIN_PKCE_KEYS: `primary:${webhookKeyMaterial(31)}`,
  HOSTED_LOGIN_PKCE_PRIMARY_KEY_ID: "primary",
  ...overrides,
});

describe("runtime configuration", () => {
  it("provides safe local defaults", () => {
    const config = loadApiConfig({});
    expect(config.API_HOST).toBe("127.0.0.1");
    expect(config.API_PORT).toBe(4_000);
    expect(config.API_TRUSTED_PROXIES).toEqual([]);
    expect(config.PRODUCT_API_MODE).toBe("local_unauthenticated");
    expect(config.HOSTED_API_MODE).toBe("disabled");
    expect(config.HOSTED_RATE_LIMIT_PER_MINUTE).toBe(120);
    expect(config.HOSTED_OIDC_REGISTRATION).toBeUndefined();
    expect(config.HOSTED_OIDC_PREFLIGHT_MODE).toBe("disabled");
    expect(config.HOSTED_OIDC_PREFLIGHT).toBeUndefined();
    expect(config.PRODUCT_RATE_LIMIT_PER_MINUTE).toBe(240);
    expect(config.LOCAL_MODEL_ADVISOR_MODE).toBe("disabled");
    expect(config.LOCAL_MODEL_PROPOSAL_MODE).toBe("disabled");
    expect(config.LOCAL_MODEL_PROPOSAL_HMAC_KEY).toBeUndefined();
    expect(config.LOCAL_MODEL_PROPOSAL_TTL_SECONDS).toBe(600);
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

  it("uses a platform port only when API_PORT is absent", () => {
    expect(loadApiConfig({ PORT: "4312" }).API_PORT).toBe(4_312);
    expect(loadApiConfig({ API_PORT: "4001", PORT: "4312" }).API_PORT).toBe(4_001);
    expect(() => loadApiConfig({ PORT: "70000" })).toThrow();
  });

  it("keeps the unauthenticated product API disabled by default in production", () => {
    const config = loadApiConfig({ NODE_ENV: "production" });
    expect(config.PRODUCT_API_MODE).toBe("disabled");
    expect(config.INTEGRATION_API_MODE).toBe("disabled");
    expect(config.HOSTED_API_MODE).toBe("disabled");
  });

  it("requires complete preflight configuration before enabling hosted OIDC", () => {
    expect(loadApiConfig({ HOSTED_API_MODE: "disabled" }).HOSTED_API_MODE).toBe("disabled");
    expect(() => loadApiConfig({ HOSTED_API_MODE: "enabled" })).toThrow(/HOSTED_API_MODE/);
    expect(() => loadApiConfig({ HOSTED_API_MODE: "oidc" })).toThrow(/complete enabled OIDC/);

    const config = loadApiConfig(hostedPreflightEnvironment({ HOSTED_API_MODE: "oidc" }));
    expect(config.HOSTED_API_MODE).toBe("oidc");
    expect(config.PRODUCT_API_MODE).toBe("disabled");
    expect(config.HOSTED_OIDC_PREFLIGHT).toBeDefined();
    expect(() =>
      loadApiConfig(
        hostedPreflightEnvironment({
          HOSTED_API_MODE: "oidc",
          PRODUCT_API_MODE: "local_unauthenticated",
        }),
      ),
    ).toThrow(/local unauthenticated product API/);
  });

  it("stages one immutable complete non-secret hosted OIDC registration", () => {
    const config = loadApiConfig({
      HOSTED_PUBLIC_ORIGIN: "https://schedule.example.com",
      HOSTED_OIDC_ISSUER: "https://login.example.com/tenant",
      HOSTED_OIDC_CLIENT_ID: "schedule-browser",
    });

    expect(config.HOSTED_API_MODE).toBe("disabled");
    expect(config.HOSTED_OIDC_REGISTRATION).toEqual({
      publicOrigin: "https://schedule.example.com",
      issuer: "https://login.example.com/tenant",
      clientId: "schedule-browser",
      redirectUri: "https://schedule.example.com/v1/auth/callback",
    });
    expect(Object.isFrozen(config.HOSTED_OIDC_REGISTRATION)).toBe(true);
  });

  it("loads one immutable hosted OIDC preflight with rotating PKCE keys", () => {
    const primary = webhookKeyMaterial(31);
    const previous = webhookKeyMaterial(30);
    const config = loadApiConfig(
      hostedPreflightEnvironment({
        HOSTED_LOGIN_PKCE_KEYS: `previous:${previous},primary:${primary}`,
      }),
    );

    expect(config.HOSTED_API_MODE).toBe("disabled");
    expect(config.HOSTED_OIDC_PREFLIGHT).toEqual({
      registration: config.HOSTED_OIDC_REGISTRATION,
      loginTransactionPepper: "login-transaction-pepper-with-32-bytes",
      browserSessionPepper: "browser-session-pepper-with-32-bytes",
      pkceKeyRing: { primaryKeyId: "primary", keys: { previous, primary } },
      tokenEndpointAuthentication: {
        method: "client_secret_basic",
        clientSecret: "provider-secret",
      },
    });
    expect(Object.isFrozen(config.HOSTED_OIDC_PREFLIGHT)).toBe(true);
    expect(Object.isFrozen(config.HOSTED_OIDC_PREFLIGHT?.pkceKeyRing)).toBe(true);
    expect(Object.isFrozen(config.HOSTED_OIDC_PREFLIGHT?.pkceKeyRing.keys)).toBe(true);
    expect(Object.isFrozen(config.HOSTED_OIDC_PREFLIGHT?.tokenEndpointAuthentication)).toBe(true);
  });

  it("accepts explicit public-client preflight without a client secret", () => {
    const config = loadApiConfig(
      hostedPreflightEnvironment({
        HOSTED_OIDC_TOKEN_AUTH_METHOD: "none",
        HOSTED_OIDC_CLIENT_SECRET: undefined,
      }),
    );

    expect(config.HOSTED_OIDC_PREFLIGHT?.tokenEndpointAuthentication).toEqual({ method: "none" });
  });

  it.each([
    { HOSTED_PUBLIC_ORIGIN: "https://schedule.example.com" },
    { HOSTED_OIDC_ISSUER: "https://login.example.com" },
    { HOSTED_OIDC_CLIENT_ID: "schedule-browser" },
    {
      HOSTED_PUBLIC_ORIGIN: "https://schedule.example.com",
      HOSTED_OIDC_ISSUER: "https://login.example.com",
    },
  ])("rejects a partial hosted OIDC registration", (environment) => {
    expect(() => loadApiConfig(environment)).toThrow(/complete non-secret set/);
  });

  it.each([
    "http://schedule.example.com",
    "https://schedule.example.com/",
    "https://schedule.example.com/path",
    "https://schedule.example.com?query=1",
    "https://schedule.example.com#fragment",
    "https://user:pass@schedule.example.com",
    "https://schedule.example.com:443",
    "https://SCHEDULE.example.com",
    " https://schedule.example.com",
  ])("rejects non-canonical hosted public origin %s", (value) => {
    expect(() =>
      loadApiConfig({
        HOSTED_PUBLIC_ORIGIN: value,
        HOSTED_OIDC_ISSUER: "https://login.example.com",
        HOSTED_OIDC_CLIENT_ID: "schedule-browser",
      }),
    ).toThrow(/Hosted OIDC registration is invalid/);
  });

  it.each([
    "http://login.example.com",
    "https://login.example.com?query=1",
    "https://login.example.com/tenant?",
    "https://login.example.com#fragment",
    "https://login.example.com/tenant#",
    "https://user:pass@login.example.com",
    "https://login.example.com:443",
    "https://LOGIN.example.com",
    " https://login.example.com",
  ])("rejects non-canonical hosted issuer %s", (value) => {
    expect(() =>
      loadApiConfig({
        HOSTED_PUBLIC_ORIGIN: "https://schedule.example.com",
        HOSTED_OIDC_ISSUER: value,
        HOSTED_OIDC_CLIENT_ID: "schedule-browser",
      }),
    ).toThrow(/Hosted OIDC registration is invalid/);
  });

  it.each([" client", "client ", "client\ncontrol", "client\u0085control", "", "x".repeat(513)])(
    "rejects invalid hosted client identifier %s",
    (value) => {
      expect(() =>
        loadApiConfig({
          HOSTED_PUBLIC_ORIGIN: "https://schedule.example.com",
          HOSTED_OIDC_ISSUER: "https://login.example.com",
          HOSTED_OIDC_CLIENT_ID: value,
        }),
      ).toThrow();
    },
  );

  it("rejects unknown hosted companions without disclosing them", () => {
    const secret = "https://issuer.example/tenant?credential=private-value";
    for (const environment of [
      { Hosted_Oidc_Client_Secret: secret },
      { Hosted_Public_Origin: secret },
      { Hosted_Api_Mode: "enabled" },
    ]) {
      let error: unknown;
      try {
        loadApiConfig(environment);
      } catch (reason) {
        error = reason;
      }
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/Hosted companion configuration/);
      expect((error as Error).message).not.toContain(secret);
      expect((error as Error).message).not.toContain("private-value");
    }

    expect(
      loadApiConfig({
        HOSTED_API_MODE: "disabled",
        HOSTED_PUBLIC_ORIGIN: "",
        HOSTED_OIDC_ISSUER: "",
        HOSTED_OIDC_CLIENT_ID: "",
        HOSTED_OIDC_TOKEN_AUTH_METHOD: "",
        HOSTED_SESSION_PEPPER: "",
      }).HOSTED_OIDC_REGISTRATION,
    ).toBeUndefined();
  });

  it.each([
    { HOSTED_SESSION_PEPPER: "session-secret-with-more-than-32-bytes" },
    { HOSTED_OIDC_PREFLIGHT_MODE: "enabled" },
    hostedPreflightEnvironment({
      HOSTED_OIDC_CLIENT_SECRET: "bad\nsecret",
    }),
    hostedPreflightEnvironment({ HOSTED_OIDC_CLIENT_SECRET: "bad\u202esecret" }),
    { HOSTED_OIDC_PREFLIGHT_MODE: "private-mode-sentinel" },
    hostedPreflightEnvironment({
      HOSTED_OIDC_TOKEN_AUTH_METHOD: "private-method-sentinel",
    }),
    hostedPreflightEnvironment({
      HOSTED_OIDC_TOKEN_AUTH_METHOD: "none",
      HOSTED_OIDC_CLIENT_SECRET: "must-not-be-present",
    }),
    hostedPreflightEnvironment({
      HOSTED_LOGIN_TRANSACTION_PEPPER: "short",
    }),
    hostedPreflightEnvironment({
      HOSTED_SESSION_PEPPER: `${"x".repeat(32)}\u2028`,
    }),
    hostedPreflightEnvironment({
      HOSTED_SESSION_PEPPER: "login-transaction-pepper-with-32-bytes",
    }),
    hostedPreflightEnvironment({
      HOSTED_LOGIN_PKCE_KEYS: `duplicate:${webhookKeyMaterial(30)},duplicate:${webhookKeyMaterial(31)}`,
      HOSTED_LOGIN_PKCE_PRIMARY_KEY_ID: "duplicate",
    }),
    hostedPreflightEnvironment({ HOSTED_LOGIN_PKCE_KEYS: "x,".repeat(616) }),
  ])(
    "rejects an invalid or premature hosted preflight without disclosing values",
    (environment) => {
      const serialized = JSON.stringify(environment);
      let error: unknown;
      try {
        loadApiConfig(environment);
      } catch (reason) {
        error = reason;
      }
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("Hosted OIDC preflight configuration is invalid.");
      for (const value of Object.values(environment)) {
        if (typeof value === "string" && value.length > 8) {
          expect((error as Error).message).not.toContain(value);
        }
      }
      expect((error as Error).message).not.toContain(serialized);
    },
  );

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

  it("enables proposal-only Ollama access only with a durable prompt-fingerprint key", () => {
    const config = loadApiConfig({
      LOCAL_MODEL_PROPOSAL_MODE: "ollama",
      LOCAL_MODEL_PROPOSAL_HMAC_KEY: "a-secure-test-key-with-more-than-32-bytes",
      LOCAL_MODEL_PROPOSAL_TTL_SECONDS: "3600",
    });

    expect(config.LOCAL_MODEL_PROPOSAL_MODE).toBe("ollama");
    expect(config.LOCAL_MODEL_PROPOSAL_TTL_SECONDS).toBe(3_600);
    expect(() => loadApiConfig({ LOCAL_MODEL_PROPOSAL_MODE: "ollama" })).toThrow(
      /LOCAL_MODEL_PROPOSAL_HMAC_KEY/,
    );
    expect(() =>
      loadApiConfig({
        LOCAL_MODEL_PROPOSAL_MODE: "ollama",
        LOCAL_MODEL_PROPOSAL_HMAC_KEY: "too-short",
      }),
    ).toThrow(/LOCAL_MODEL_PROPOSAL_HMAC_KEY/);
    expect(() => loadApiConfig({ LOCAL_MODEL_PROPOSAL_TTL_SECONDS: "59" })).toThrow();
    expect(() => loadApiConfig({ LOCAL_MODEL_PROPOSAL_TTL_SECONDS: "3601" })).toThrow();
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
    expect(config.WORKER_OBSERVABILITY_MODE).toBe("disabled");
    expect(config.WORKER_OBSERVABILITY_PORT).toBe(9_464);
    expect(config.WORKER_DEPLOYMENT_HEALTH_MODE).toBe("disabled");
    expect(config.PORT).toBeUndefined();
    expect(config.NOTIFICATION_MATERIALIZATION_MODE).toBe("disabled");
    expect(config.NOTIFICATION_MATERIALIZATION_INTERVAL_MS).toBe(60_000);
    expect(config.NOTIFICATION_MATERIALIZATION_LOOKAHEAD_MS).toBe(300_000);
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

  it("enables only a bounded loopback worker observability port", () => {
    const config = loadWorkerConfig({
      WORKER_OBSERVABILITY_MODE: "loopback",
      WORKER_OBSERVABILITY_PORT: "10001",
    });
    expect(config.WORKER_OBSERVABILITY_MODE).toBe("loopback");
    expect(config.WORKER_OBSERVABILITY_PORT).toBe(10_001);
    expect(() => loadWorkerConfig({ WORKER_OBSERVABILITY_PORT: "0" })).toThrow();
    expect(() => loadWorkerConfig({ WORKER_OBSERVABILITY_PORT: "65536" })).toThrow();
    expect(() => loadWorkerConfig({ WORKER_OBSERVABILITY_MODE: "public" })).toThrow();
  });

  it("requires Railway worker health to use its production platform port", () => {
    const config = loadWorkerConfig({
      NODE_ENV: "production",
      WORKER_DEPLOYMENT_HEALTH_MODE: "railway",
      PORT: "10002",
    });
    expect(config.WORKER_DEPLOYMENT_HEALTH_MODE).toBe("railway");
    expect(config.PORT).toBe(10_002);
    expect(() =>
      loadWorkerConfig({ WORKER_DEPLOYMENT_HEALTH_MODE: "railway", PORT: "10002" }),
    ).toThrow(/production mode/i);
    expect(() =>
      loadWorkerConfig({
        NODE_ENV: "production",
        WORKER_DEPLOYMENT_HEALTH_MODE: "railway",
      }),
    ).toThrow(/PORT/);
    expect(() => loadWorkerConfig({ PORT: "0" })).toThrow();
    expect(() => loadWorkerConfig({ PORT: "65536" })).toThrow();
    expect(() => loadWorkerConfig({ WORKER_DEPLOYMENT_HEALTH_MODE: "public" })).toThrow();
  });

  it("coerces bounded automatic notification materialization controls", () => {
    const config = loadWorkerConfig({
      NOTIFICATION_MATERIALIZATION_MODE: "enabled",
      NOTIFICATION_MATERIALIZATION_INTERVAL_MS: "10000",
      NOTIFICATION_MATERIALIZATION_LOOKAHEAD_MS: "1000",
    });

    expect(config.NOTIFICATION_MATERIALIZATION_MODE).toBe("enabled");
    expect(config.NOTIFICATION_MATERIALIZATION_INTERVAL_MS).toBe(10_000);
    expect(config.NOTIFICATION_MATERIALIZATION_LOOKAHEAD_MS).toBe(1_000);
    expect(() => loadWorkerConfig({ NOTIFICATION_MATERIALIZATION_INTERVAL_MS: "9999" })).toThrow();
    expect(() =>
      loadWorkerConfig({ NOTIFICATION_MATERIALIZATION_INTERVAL_MS: "3600001" }),
    ).toThrow();
    expect(() => loadWorkerConfig({ NOTIFICATION_MATERIALIZATION_LOOKAHEAD_MS: "999" })).toThrow();
    expect(() =>
      loadWorkerConfig({ NOTIFICATION_MATERIALIZATION_LOOKAHEAD_MS: "3600001" }),
    ).toThrow();
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

  it("coerces the bounded local product rate limit from an environment string", () => {
    expect(
      loadApiConfig({ PRODUCT_RATE_LIMIT_PER_MINUTE: "1000" }).PRODUCT_RATE_LIMIT_PER_MINUTE,
    ).toBe(1_000);
    expect(() => loadApiConfig({ PRODUCT_RATE_LIMIT_PER_MINUTE: "0" })).toThrow();
    expect(() => loadApiConfig({ PRODUCT_RATE_LIMIT_PER_MINUTE: "10001" })).toThrow();
  });
});
