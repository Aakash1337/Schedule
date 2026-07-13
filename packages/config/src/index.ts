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
  INTEGRATION_API_MODE: z.enum(["disabled", "enabled"]).default("disabled"),
  INTEGRATION_API_PEPPER: z.string().optional(),
  INTEGRATION_CONFIRMATION_TTL_SECONDS: z.coerce.number().int().min(60).max(3_600).default(600),
  INTEGRATION_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(1_000).default(120),
});

const workerSchema = baseSchema.extend({
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(25),
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(8),
});

export type ApiConfig = Omit<
  z.infer<typeof apiSchema>,
  "PRODUCT_API_MODE" | "API_TRUSTED_PROXIES"
> & {
  readonly PRODUCT_API_MODE: "disabled" | "local_unauthenticated";
  readonly API_TRUSTED_PROXIES: string[];
};
export type WorkerConfig = z.infer<typeof workerSchema>;

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

export const loadApiConfig = (environment: NodeJS.ProcessEnv = process.env): ApiConfig => {
  const parsed = apiSchema.parse(environment);
  const config: ApiConfig = {
    ...parsed,
    API_TRUSTED_PROXIES: parseTrustedProxies(parsed.API_TRUSTED_PROXIES),
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
  return config;
};

export const loadWorkerConfig = (environment: NodeJS.ProcessEnv = process.env): WorkerConfig =>
  workerSchema.parse(environment);
