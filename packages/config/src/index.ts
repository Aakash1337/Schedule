import { isIP } from "node:net";

import { z } from "zod";

const baseSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DATABASE_URL: z.string().min(1).default("postgres://schedule:schedule@127.0.0.1:5432/schedule"),
});

const apiSchema = baseSchema.extend({
  API_HOST: z.string().min(1).default("127.0.0.1"),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(4_000),
  API_TRUSTED_PROXIES: z.string().max(16_384).default(""),
  PRODUCT_API_MODE: z.enum(["disabled", "local_unauthenticated"]).optional(),
  LOCAL_MODEL_ADVISOR_MODE: z.enum(["disabled", "ollama"]).default("disabled"),
  LOCAL_MODEL_PROPOSAL_MODE: z.enum(["disabled", "ollama"]).default("disabled"),
  LOCAL_MODEL_PROPOSAL_HMAC_KEY: z.string().optional(),
  LOCAL_MODEL_PROPOSAL_TTL_SECONDS: z.coerce.number().int().min(60).max(3_600).default(600),
  LOCAL_MODEL_ADVISOR_URL: z.string().default("http://127.0.0.1:11434"),
  LOCAL_MODEL_ADVISOR_MODEL: z
    .enum(["gemma4:e2b", "gemma4:e4b", "gemma4:26b", "gemma4:31b"])
    .default("gemma4:e4b"),
  LOCAL_MODEL_ADVISOR_CONNECT_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(10_000)
    .default(2_000),
  LOCAL_MODEL_ADVISOR_REQUEST_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(120_000)
    .default(60_000),
  LOCAL_MODEL_ADVISOR_MAX_RESPONSE_BYTES: z.coerce
    .number()
    .int()
    .min(1_024)
    .max(65_536)
    .default(32_768),
  LOCAL_MODEL_ADVISOR_MAX_CONCURRENT: z.coerce.number().int().min(1).max(4).default(1),
  INTEGRATION_API_MODE: z.enum(["disabled", "enabled"]).default("disabled"),
  INTEGRATION_API_PEPPER: z.string().optional(),
  INTEGRATION_CONFIRMATION_TTL_SECONDS: z.coerce.number().int().min(60).max(3_600).default(600),
  INTEGRATION_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(1_000).default(120),
});

const workerSchema = baseSchema.extend({
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(25),
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(8),
  WORKER_OBSERVABILITY_MODE: z.enum(["disabled", "loopback"]).default("disabled"),
  WORKER_OBSERVABILITY_PORT: z.coerce.number().int().min(1).max(65_535).default(9_464),
  NOTIFICATION_MATERIALIZATION_MODE: z.enum(["disabled", "enabled"]).default("disabled"),
  NOTIFICATION_MATERIALIZATION_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(10_000)
    .max(3_600_000)
    .default(60_000),
  NOTIFICATION_MATERIALIZATION_LOOKAHEAD_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(3_600_000)
    .default(300_000),
  WEBHOOK_DELIVERY_MODE: z.enum(["disabled", "enabled"]).default("disabled"),
  WEBHOOK_MASTER_KEYS: z.string().max(4_096).default(""),
  WEBHOOK_ACTIVE_MASTER_KEY_ID: z.string().max(32).default(""),
  WEBHOOK_CONNECT_TIMEOUT_MS: z.coerce.number().int().min(100).max(30_000).default(5_000),
  WEBHOOK_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(120_000).default(15_000),
  WEBHOOK_MAX_RESPONSE_BYTES: z.coerce.number().int().min(1_024).max(1_048_576).default(65_536),
  WEBHOOK_MAX_RETRY_AFTER_MS: z.coerce.number().int().min(0).max(3_600_000).default(300_000),
  WEBHOOK_MAX_DELIVERY_AGE_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(2_592_000_000)
    .default(604_800_000),
});

export type ApiConfig = Omit<
  z.infer<typeof apiSchema>,
  "PRODUCT_API_MODE" | "API_TRUSTED_PROXIES"
> & {
  readonly PRODUCT_API_MODE: "disabled" | "local_unauthenticated";
  readonly API_TRUSTED_PROXIES: string[];
};
export type WebhookMasterKey = Readonly<{
  /** Conservative, canonical key identifier; never derived from a secret. */
  id: string;
  /** Canonical unpadded base64url material for exactly 32 bytes. */
  material: string;
}>;

type ParsedWorkerConfig = Omit<
  z.infer<typeof workerSchema>,
  "WEBHOOK_MASTER_KEYS" | "WEBHOOK_ACTIVE_MASTER_KEY_ID"
>;

export type WorkerConfig = ParsedWorkerConfig & {
  /** Immutable key list in configured order. */
  readonly WEBHOOK_MASTER_KEYS: readonly WebhookMasterKey[];
  /** Immutable lookup by canonical key ID. */
  readonly WEBHOOK_MASTER_KEYS_BY_ID: ReadonlyMap<string, WebhookMasterKey>;
  /** Empty only while delivery is disabled and no active key has been configured. */
  readonly WEBHOOK_ACTIVE_MASTER_KEY_ID: string;
};

const webhookKeyIdPattern = /^[a-z](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

const invalidWebhookKeyring = (): never => {
  // Never include the source value: it contains master-key material.
  throw new Error(
    "WEBHOOK_MASTER_KEYS must be a comma-delimited set of at most eight lowercase key-id:base64url-32-byte-key entries.",
  );
};

function parseWebhookMasterKeys(value: string): readonly WebhookMasterKey[] {
  if (value === "") return Object.freeze([]) as readonly WebhookMasterKey[];

  const entries = value.split(",");
  if (entries.length > 8) invalidWebhookKeyring();

  const parsed: WebhookMasterKey[] = [];
  const ids = new Set<string>();
  for (const entry of entries) {
    // A strict representation avoids accepting invisible whitespace or ambiguous separators.
    const separator = entry.indexOf(":");
    if (separator <= 0 || separator !== entry.lastIndexOf(":")) invalidWebhookKeyring();

    const id = entry.slice(0, separator);
    const material = entry.slice(separator + 1);
    if (
      !webhookKeyIdPattern.test(id) ||
      material.length !== 43 ||
      !/^[A-Za-z0-9_-]+$/.test(material)
    ) {
      invalidWebhookKeyring();
    }

    let decoded: Buffer | undefined;
    try {
      decoded = Buffer.from(material, "base64url");
    } catch {
      invalidWebhookKeyring();
    }
    if (
      decoded === undefined ||
      decoded.length !== 32 ||
      decoded.toString("base64url") !== material ||
      ids.has(id)
    ) {
      invalidWebhookKeyring();
    }

    ids.add(id);
    parsed.push(Object.freeze({ id, material }));
  }
  return Object.freeze(parsed) as readonly WebhookMasterKey[];
}

function parseWebhookActiveKeyId(value: string): string {
  if (value === "") return "";
  if (!webhookKeyIdPattern.test(value)) {
    throw new Error("WEBHOOK_ACTIVE_MASTER_KEY_ID must be a lowercase key identifier.");
  }
  return value;
}

function createReadonlyWebhookKeyMap(
  keys: readonly WebhookMasterKey[],
): ReadonlyMap<string, WebhookMasterKey> {
  const values = new Map(keys.map((key) => [key.id, key] as const));
  const readonlyMap: ReadonlyMap<string, WebhookMasterKey> = Object.freeze({
    get size() {
      return values.size;
    },
    has: (id: string) => values.has(id),
    get: (id: string) => values.get(id),
    entries: () => values.entries(),
    keys: () => values.keys(),
    values: () => values.values(),
    forEach: (
      callbackfn: (
        value: WebhookMasterKey,
        key: string,
        map: ReadonlyMap<string, WebhookMasterKey>,
      ) => void,
      thisArg?: unknown,
    ) => values.forEach((value, key) => callbackfn.call(thisArg, value, key, readonlyMap)),
    [Symbol.iterator]: () => values[Symbol.iterator](),
  } satisfies ReadonlyMap<string, WebhookMasterKey>);
  return readonlyMap;
}

function parseTrustedProxies(value: string): string[] {
  if (value.trim() === "") return [];
  const entries = value.split(",").map((entry) => entry.trim());
  if (entries.length > 256) {
    throw new Error("API_TRUSTED_PROXIES cannot contain more than 256 entries.");
  }

  const normalized = entries.map((entry) => {
    if (entry === "") {
      throw new Error("API_TRUSTED_PROXIES cannot contain empty entries.");
    }
    const parts = entry.split("/");
    const address = parts[0]?.toLowerCase();
    if (address === undefined || parts.length > 2 || isIP(address) === 0) {
      throw new Error(
        "API_TRUSTED_PROXIES entries must be explicit IPv4/IPv6 addresses or CIDR ranges.",
      );
    }
    const prefixText = parts[1];
    if (prefixText === undefined) return address;
    if (!/^(0|[1-9][0-9]*)$/.test(prefixText)) {
      throw new Error("API_TRUSTED_PROXIES contains an invalid CIDR prefix.");
    }
    const prefix = Number(prefixText);
    const addressVersion = isIP(address);
    const minimum = addressVersion === 4 ? 8 : 32;
    const maximum = addressVersion === 4 ? 32 : 128;
    if (prefix < minimum || prefix > maximum) {
      throw new Error(
        `API_TRUSTED_PROXIES CIDR prefixes must be /${String(minimum)} through /${String(maximum)} for this address family.`,
      );
    }
    return `${address}/${String(prefix)}`;
  });

  if (new Set(normalized).size !== normalized.length) {
    throw new Error("API_TRUSTED_PROXIES cannot contain duplicate entries.");
  }
  return normalized;
}

function parseLocalModelAdvisorUrl(value: string): string {
  // Require one unambiguous, direct IPv4 loopback origin. In particular, do not
  // allow DNS, URL credentials, redirects encoded as paths, or alternate IP forms.
  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(value);
  const port = match?.[1] === undefined ? Number.NaN : Number(match[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("LOCAL_MODEL_ADVISOR_URL must be a canonical http://127.0.0.1:<port> origin.");
  }
  return value;
}

export const loadApiConfig = (environment: NodeJS.ProcessEnv = process.env): ApiConfig => {
  const parsed = apiSchema.parse(environment);
  const config: ApiConfig = {
    ...parsed,
    API_TRUSTED_PROXIES: parseTrustedProxies(parsed.API_TRUSTED_PROXIES),
    LOCAL_MODEL_ADVISOR_URL: parseLocalModelAdvisorUrl(parsed.LOCAL_MODEL_ADVISOR_URL),
    PRODUCT_API_MODE:
      parsed.PRODUCT_API_MODE ??
      (parsed.NODE_ENV === "production" ? "disabled" : "local_unauthenticated"),
  };
  if (
    config.PRODUCT_API_MODE === "local_unauthenticated" &&
    (config.NODE_ENV === "production" ||
      !["127.0.0.1", "::1", "localhost"].includes(config.API_HOST))
  ) {
    throw new Error(
      "local_unauthenticated product API mode requires a non-production loopback binding.",
    );
  }
  if (
    config.INTEGRATION_API_MODE === "enabled" &&
    (config.INTEGRATION_API_PEPPER === undefined || config.INTEGRATION_API_PEPPER.length < 32)
  ) {
    throw new Error(
      "INTEGRATION_API_PEPPER must contain at least 32 characters when the integration API is enabled.",
    );
  }
  if (
    config.LOCAL_MODEL_PROPOSAL_MODE === "ollama" &&
    (config.LOCAL_MODEL_PROPOSAL_HMAC_KEY === undefined ||
      Buffer.byteLength(config.LOCAL_MODEL_PROPOSAL_HMAC_KEY, "utf8") < 32)
  ) {
    throw new Error(
      "LOCAL_MODEL_PROPOSAL_HMAC_KEY must contain at least 32 bytes when natural-language proposals are enabled.",
    );
  }
  if (
    config.LOCAL_MODEL_ADVISOR_REQUEST_TIMEOUT_MS < config.LOCAL_MODEL_ADVISOR_CONNECT_TIMEOUT_MS
  ) {
    throw new Error(
      "LOCAL_MODEL_ADVISOR_REQUEST_TIMEOUT_MS must be at least LOCAL_MODEL_ADVISOR_CONNECT_TIMEOUT_MS.",
    );
  }
  return config;
};

export const loadWorkerConfig = (environment: NodeJS.ProcessEnv = process.env): WorkerConfig => {
  const parsed = workerSchema.parse(environment);
  if (parsed.WEBHOOK_REQUEST_TIMEOUT_MS < parsed.WEBHOOK_CONNECT_TIMEOUT_MS) {
    throw new Error("WEBHOOK_REQUEST_TIMEOUT_MS must be at least WEBHOOK_CONNECT_TIMEOUT_MS.");
  }

  const masterKeys = parseWebhookMasterKeys(parsed.WEBHOOK_MASTER_KEYS);
  const masterKeysById = createReadonlyWebhookKeyMap(masterKeys);
  const activeMasterKeyId = parseWebhookActiveKeyId(parsed.WEBHOOK_ACTIVE_MASTER_KEY_ID);
  if (activeMasterKeyId !== "" && !masterKeysById.has(activeMasterKeyId)) {
    throw new Error("WEBHOOK_ACTIVE_MASTER_KEY_ID must identify a configured webhook master key.");
  }
  if (parsed.WEBHOOK_DELIVERY_MODE === "enabled") {
    if (masterKeys.length === 0) {
      throw new Error("WEBHOOK_MASTER_KEYS must be configured when webhook delivery is enabled.");
    }
    if (activeMasterKeyId === "") {
      throw new Error(
        "WEBHOOK_ACTIVE_MASTER_KEY_ID must identify a configured webhook master key when webhook delivery is enabled.",
      );
    }
  }

  return Object.freeze({
    ...parsed,
    WEBHOOK_MASTER_KEYS: masterKeys,
    WEBHOOK_MASTER_KEYS_BY_ID: masterKeysById,
    WEBHOOK_ACTIVE_MASTER_KEY_ID: activeMasterKeyId,
  });
};
