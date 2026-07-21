import { createHash } from "node:crypto";
import { isIP } from "node:net";

import { z } from "zod";

const baseSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DATABASE_URL: z.string().min(1).default("postgres://schedule:schedule@127.0.0.1:5432/schedule"),
});

const apiSchema = baseSchema.extend({
  API_HOST: z.string().min(1).default("127.0.0.1"),
  API_PORT: z.coerce.number().int().min(0).max(65_535).default(4_000),
  API_TRUSTED_PROXIES: z.string().max(16_384).default(""),
  PRODUCT_API_MODE: z
    .enum(["disabled", "local_unauthenticated", "desktop_authenticated"])
    .optional(),
  DESKTOP_API_TOKEN: z.string().max(128).optional(),
  HOSTED_API_MODE: z.enum(["disabled", "oidc"]).default("disabled"),
  HOSTED_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).default(120),
  HOSTED_AUTH_STARTS_PER_MINUTE: z.coerce.number().int().min(1).max(1_000).default(30),
  HOSTED_AUTH_MAX_CONCURRENT_CALLBACKS: z.coerce.number().int().min(1).max(32).default(4),
  HOSTED_PUBLIC_ORIGIN: z.string().optional(),
  HOSTED_OIDC_ISSUER: z.string().optional(),
  HOSTED_OIDC_CLIENT_ID: z.string().optional(),
  HOSTED_OIDC_PREFLIGHT_MODE: z.enum(["disabled", "enabled"]).default("disabled"),
  HOSTED_OIDC_TOKEN_AUTH_METHOD: z
    .enum(["none", "client_secret_basic", "client_secret_post"])
    .optional(),
  HOSTED_OIDC_CLIENT_SECRET: z.string().optional(),
  HOSTED_LOGIN_TRANSACTION_PEPPER: z.string().optional(),
  HOSTED_SESSION_PEPPER: z.string().optional(),
  HOSTED_LOGIN_PKCE_KEYS: z.string().optional(),
  HOSTED_LOGIN_PKCE_PRIMARY_KEY_ID: z.string().optional(),
  PRODUCT_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(10_000).default(240),
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
  PORT: z.coerce.number().int().min(1).max(65_535).optional(),
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(25),
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(8),
  WORKER_OBSERVABILITY_MODE: z.enum(["disabled", "loopback"]).default("disabled"),
  WORKER_OBSERVABILITY_PORT: z.coerce.number().int().min(1).max(65_535).default(9_464),
  WORKER_DEPLOYMENT_HEALTH_MODE: z.enum(["disabled", "railway"]).default("disabled"),
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
  HOSTED_WORK_ITEM_SYNC_CLEANUP_MODE: z.enum(["disabled", "enabled"]).default("disabled"),
  HOSTED_WORK_ITEM_SYNC_CLEANUP_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(3_600_000)
    .default(3_600_000),
  HOSTED_WORK_ITEM_SYNC_CLEANUP_RETENTION_DAYS: z.coerce
    .number()
    .int()
    .min(30)
    .max(3_650)
    .default(90),
  HOSTED_WORK_ITEM_SYNC_CLEANUP_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(250),
  HOSTED_WORK_ITEM_SYNC_CLEANUP_MAX_BATCHES: z.coerce.number().int().min(1).max(20).default(20),
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
  | "PRODUCT_API_MODE"
  | "DESKTOP_API_TOKEN"
  | "API_TRUSTED_PROXIES"
  | "HOSTED_PUBLIC_ORIGIN"
  | "HOSTED_OIDC_ISSUER"
  | "HOSTED_OIDC_CLIENT_ID"
  | "HOSTED_OIDC_TOKEN_AUTH_METHOD"
  | "HOSTED_OIDC_CLIENT_SECRET"
  | "HOSTED_LOGIN_TRANSACTION_PEPPER"
  | "HOSTED_SESSION_PEPPER"
  | "HOSTED_LOGIN_PKCE_KEYS"
  | "HOSTED_LOGIN_PKCE_PRIMARY_KEY_ID"
> & {
  readonly PRODUCT_API_MODE: "disabled" | "local_unauthenticated" | "desktop_authenticated";
  /** SHA-256 of the launch credential. The raw value is never retained in loaded configuration. */
  readonly DESKTOP_API_TOKEN_DIGEST: string | undefined;
  readonly API_TRUSTED_PROXIES: string[];
  readonly HOSTED_OIDC_REGISTRATION: HostedOidcRegistration | undefined;
  readonly HOSTED_OIDC_PREFLIGHT: HostedOidcPreflight | undefined;
};
export type HostedOidcRegistration = Readonly<{
  publicOrigin: string;
  issuer: string;
  clientId: string;
  redirectUri: string;
}>;
export type HostedOidcPreflight = Readonly<{
  registration: HostedOidcRegistration;
  loginTransactionPepper: string;
  browserSessionPepper: string;
  pkceKeyRing: Readonly<{
    primaryKeyId: string;
    keys: Readonly<Record<string, string>>;
  }>;
  tokenEndpointAuthentication:
    | Readonly<{ method: "none" }>
    | Readonly<{
        method: "client_secret_basic" | "client_secret_post";
        clientSecret: string;
      }>;
}>;
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

const invalidDesktopApiToken = (): never => {
  throw new Error("Desktop API launch credential configuration is invalid.");
};

function parseDesktopApiTokenDigest(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const decoded = Buffer.from(value, "base64url");
  if (value.length !== 43 || decoded.length !== 32 || decoded.toString("base64url") !== value) {
    invalidDesktopApiToken();
  }
  return createHash("sha256").update(value, "utf8").digest("base64url");
}

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

const MAXIMUM_HOSTED_URL_BYTES = 2_048;
const MAXIMUM_HOSTED_CLIENT_ID_BYTES = 512;
const MAXIMUM_HOSTED_SECRET_BYTES = 1_024;
const MAXIMUM_HOSTED_PKCE_KEYS_BYTES = 1_231;
const HOSTED_PKCE_KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/u;
const HOSTED_OIDC_PREFLIGHT_MODES = new Set(["disabled", "enabled"]);
const HOSTED_OIDC_TOKEN_AUTH_METHODS = new Set([
  "none",
  "client_secret_basic",
  "client_secret_post",
]);
const STAGED_HOSTED_VARIABLES = new Set([
  "HOSTED_PUBLIC_ORIGIN",
  "HOSTED_OIDC_ISSUER",
  "HOSTED_OIDC_CLIENT_ID",
  "HOSTED_RATE_LIMIT_PER_MINUTE",
  "HOSTED_AUTH_STARTS_PER_MINUTE",
  "HOSTED_AUTH_MAX_CONCURRENT_CALLBACKS",
  "HOSTED_OIDC_PREFLIGHT_MODE",
  "HOSTED_OIDC_TOKEN_AUTH_METHOD",
  "HOSTED_OIDC_CLIENT_SECRET",
  "HOSTED_LOGIN_TRANSACTION_PEPPER",
  "HOSTED_SESSION_PEPPER",
  "HOSTED_LOGIN_PKCE_KEYS",
  "HOSTED_LOGIN_PKCE_PRIMARY_KEY_ID",
]);

function containsControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return /[\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
}

function parseExactHostedHttpsUrl(value: string, originOnly: boolean): string | null {
  if (
    Buffer.byteLength(value, "utf8") > MAXIMUM_HOSTED_URL_BYTES ||
    containsControl(value) ||
    /[\s\\]/u.test(value)
  ) {
    return null;
  }
  try {
    const parsed = new URL(value);
    const hasBareQueryDelimiter = parsed.search === "" && value.includes("?");
    const hasBareFragmentDelimiter = parsed.hash === "" && value.includes("#");
    const canonical = originOnly
      ? parsed.origin === value
      : parsed.href === value || (parsed.pathname === "/" && parsed.href === `${value}/`);
    return parsed.protocol === "https:" &&
      canonical &&
      !hasBareQueryDelimiter &&
      !hasBareFragmentDelimiter &&
      (!originOnly || parsed.pathname === "/") &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.port === "" &&
      parsed.search === "" &&
      parsed.hash === ""
      ? value
      : null;
  } catch {
    return null;
  }
}

function parseHostedOidcRegistration(input: {
  readonly HOSTED_PUBLIC_ORIGIN: string | undefined;
  readonly HOSTED_OIDC_ISSUER: string | undefined;
  readonly HOSTED_OIDC_CLIENT_ID: string | undefined;
}): HostedOidcRegistration | undefined {
  const values = [
    input.HOSTED_PUBLIC_ORIGIN,
    input.HOSTED_OIDC_ISSUER,
    input.HOSTED_OIDC_CLIENT_ID,
  ];
  if (values.every((value) => value === undefined || value === "")) return undefined;
  if (values.some((value) => value === undefined || value === "")) {
    throw new Error("Hosted OIDC registration must be configured as one complete non-secret set.");
  }
  const publicOrigin = parseExactHostedHttpsUrl(input.HOSTED_PUBLIC_ORIGIN!, true);
  const issuer = parseExactHostedHttpsUrl(input.HOSTED_OIDC_ISSUER!, false);
  const clientId = input.HOSTED_OIDC_CLIENT_ID!;
  if (
    publicOrigin === null ||
    issuer === null ||
    clientId.trim() !== clientId ||
    Buffer.byteLength(clientId, "utf8") < 1 ||
    Buffer.byteLength(clientId, "utf8") > MAXIMUM_HOSTED_CLIENT_ID_BYTES ||
    containsControl(clientId)
  ) {
    throw new Error("Hosted OIDC registration is invalid.");
  }
  const redirectUri = `${publicOrigin}/v1/auth/callback`;
  if (Buffer.byteLength(redirectUri, "utf8") > MAXIMUM_HOSTED_URL_BYTES) {
    throw new Error("Hosted OIDC registration is invalid.");
  }
  return Object.freeze({ publicOrigin, issuer, clientId, redirectUri });
}

function invalidHostedOidcPreflight(): never {
  throw new Error("Hosted OIDC preflight configuration is invalid.");
}

function validHostedSecret(value: string | undefined, minimumBytes: number): value is string {
  if (value === undefined) return false;
  const bytes = Buffer.byteLength(value, "utf8");
  return bytes >= minimumBytes && bytes <= MAXIMUM_HOSTED_SECRET_BYTES && !containsControl(value);
}

function parseHostedPkceKeys(value: string | undefined): Readonly<Record<string, string>> {
  if (value === undefined || Buffer.byteLength(value, "utf8") > MAXIMUM_HOSTED_PKCE_KEYS_BYTES) {
    invalidHostedOidcPreflight();
  }
  const sourceEntries = value.split(",");
  if (sourceEntries.length < 1 || sourceEntries.length > 16) invalidHostedOidcPreflight();
  const entries: Array<readonly [string, string]> = [];
  const ids = new Set<string>();
  for (const entry of sourceEntries) {
    const separator = entry.indexOf(":");
    if (separator <= 0 || separator !== entry.lastIndexOf(":")) invalidHostedOidcPreflight();
    const id = entry.slice(0, separator);
    const material = entry.slice(separator + 1);
    if (
      !HOSTED_PKCE_KEY_ID_PATTERN.test(id) ||
      ids.has(id) ||
      !/^[A-Za-z0-9_-]{43}$/u.test(material)
    ) {
      invalidHostedOidcPreflight();
    }
    const decoded = Buffer.from(material, "base64url");
    if (decoded.length !== 32 || decoded.toString("base64url") !== material) {
      invalidHostedOidcPreflight();
    }
    ids.add(id);
    entries.push([id, material]);
  }
  return Object.freeze(Object.fromEntries(entries));
}

function parseHostedOidcPreflight(
  registration: HostedOidcRegistration | undefined,
  input: {
    readonly HOSTED_OIDC_PREFLIGHT_MODE: "disabled" | "enabled";
    readonly HOSTED_OIDC_TOKEN_AUTH_METHOD:
      "none" | "client_secret_basic" | "client_secret_post" | undefined;
    readonly HOSTED_OIDC_CLIENT_SECRET: string | undefined;
    readonly HOSTED_LOGIN_TRANSACTION_PEPPER: string | undefined;
    readonly HOSTED_SESSION_PEPPER: string | undefined;
    readonly HOSTED_LOGIN_PKCE_KEYS: string | undefined;
    readonly HOSTED_LOGIN_PKCE_PRIMARY_KEY_ID: string | undefined;
  },
): HostedOidcPreflight | undefined {
  const companionValues = [
    input.HOSTED_OIDC_TOKEN_AUTH_METHOD,
    input.HOSTED_OIDC_CLIENT_SECRET,
    input.HOSTED_LOGIN_TRANSACTION_PEPPER,
    input.HOSTED_SESSION_PEPPER,
    input.HOSTED_LOGIN_PKCE_KEYS,
    input.HOSTED_LOGIN_PKCE_PRIMARY_KEY_ID,
  ];
  if (input.HOSTED_OIDC_PREFLIGHT_MODE === "disabled") {
    if (companionValues.some((value) => value !== undefined && value !== "")) {
      invalidHostedOidcPreflight();
    }
    return undefined;
  }
  if (
    registration === undefined ||
    !validHostedSecret(input.HOSTED_LOGIN_TRANSACTION_PEPPER, 32) ||
    !validHostedSecret(input.HOSTED_SESSION_PEPPER, 32)
  ) {
    invalidHostedOidcPreflight();
  }
  if (input.HOSTED_LOGIN_TRANSACTION_PEPPER === input.HOSTED_SESSION_PEPPER) {
    invalidHostedOidcPreflight();
  }
  const keys = parseHostedPkceKeys(input.HOSTED_LOGIN_PKCE_KEYS);
  const primaryKeyId = input.HOSTED_LOGIN_PKCE_PRIMARY_KEY_ID;
  if (
    primaryKeyId === undefined ||
    !HOSTED_PKCE_KEY_ID_PATTERN.test(primaryKeyId) ||
    !Object.hasOwn(keys, primaryKeyId)
  ) {
    invalidHostedOidcPreflight();
  }
  const method = input.HOSTED_OIDC_TOKEN_AUTH_METHOD;
  const clientSecret = input.HOSTED_OIDC_CLIENT_SECRET;
  const tokenEndpointAuthentication =
    method === "none"
      ? clientSecret === undefined || clientSecret === ""
        ? Object.freeze({ method })
        : invalidHostedOidcPreflight()
      : method === "client_secret_basic" || method === "client_secret_post"
        ? validHostedSecret(clientSecret, 1)
          ? Object.freeze({ method, clientSecret })
          : invalidHostedOidcPreflight()
        : invalidHostedOidcPreflight();
  return Object.freeze({
    registration,
    loginTransactionPepper: input.HOSTED_LOGIN_TRANSACTION_PEPPER,
    browserSessionPepper: input.HOSTED_SESSION_PEPPER,
    pkceKeyRing: Object.freeze({ primaryKeyId, keys }),
    tokenEndpointAuthentication,
  });
}

export const loadApiConfig = (environment: NodeJS.ProcessEnv = process.env): ApiConfig => {
  const hasPrematureHostedConfiguration = Object.entries(environment).some(([name, value]) => {
    const normalizedName = name.toUpperCase();
    return (
      normalizedName.startsWith("HOSTED_") &&
      (normalizedName === "HOSTED_API_MODE"
        ? name !== "HOSTED_API_MODE"
        : !STAGED_HOSTED_VARIABLES.has(name)) &&
      value !== undefined &&
      value.length > 0
    );
  });
  if (hasPrematureHostedConfiguration) {
    // Do not echo names or values: future companion variables may contain credentials.
    throw new Error("Hosted companion configuration is not accepted.");
  }
  if (
    (environment.HOSTED_OIDC_PREFLIGHT_MODE !== undefined &&
      !HOSTED_OIDC_PREFLIGHT_MODES.has(environment.HOSTED_OIDC_PREFLIGHT_MODE)) ||
    (environment.HOSTED_OIDC_TOKEN_AUTH_METHOD !== undefined &&
      environment.HOSTED_OIDC_TOKEN_AUTH_METHOD !== "" &&
      !HOSTED_OIDC_TOKEN_AUTH_METHODS.has(environment.HOSTED_OIDC_TOKEN_AUTH_METHOD))
  ) {
    invalidHostedOidcPreflight();
  }
  const parsed = apiSchema.parse({
    ...environment,
    API_PORT: environment.API_PORT ?? environment.PORT,
    HOSTED_OIDC_TOKEN_AUTH_METHOD:
      environment.HOSTED_OIDC_TOKEN_AUTH_METHOD === ""
        ? undefined
        : environment.HOSTED_OIDC_TOKEN_AUTH_METHOD,
  });
  const {
    HOSTED_PUBLIC_ORIGIN,
    HOSTED_OIDC_ISSUER,
    HOSTED_OIDC_CLIENT_ID,
    HOSTED_OIDC_TOKEN_AUTH_METHOD,
    HOSTED_OIDC_CLIENT_SECRET,
    HOSTED_LOGIN_TRANSACTION_PEPPER,
    HOSTED_SESSION_PEPPER,
    HOSTED_LOGIN_PKCE_KEYS,
    HOSTED_LOGIN_PKCE_PRIMARY_KEY_ID,
    DESKTOP_API_TOKEN,
    ...publicConfig
  } = parsed;
  const hostedOidcRegistration = parseHostedOidcRegistration({
    HOSTED_PUBLIC_ORIGIN,
    HOSTED_OIDC_ISSUER,
    HOSTED_OIDC_CLIENT_ID,
  });
  const hostedOidcPreflight = parseHostedOidcPreflight(hostedOidcRegistration, {
    HOSTED_OIDC_PREFLIGHT_MODE: parsed.HOSTED_OIDC_PREFLIGHT_MODE,
    HOSTED_OIDC_TOKEN_AUTH_METHOD,
    HOSTED_OIDC_CLIENT_SECRET,
    HOSTED_LOGIN_TRANSACTION_PEPPER,
    HOSTED_SESSION_PEPPER,
    HOSTED_LOGIN_PKCE_KEYS,
    HOSTED_LOGIN_PKCE_PRIMARY_KEY_ID,
  });
  const config: ApiConfig = {
    ...publicConfig,
    API_TRUSTED_PROXIES: parseTrustedProxies(parsed.API_TRUSTED_PROXIES),
    HOSTED_OIDC_REGISTRATION: hostedOidcRegistration,
    HOSTED_OIDC_PREFLIGHT: hostedOidcPreflight,
    DESKTOP_API_TOKEN_DIGEST: parseDesktopApiTokenDigest(DESKTOP_API_TOKEN),
    LOCAL_MODEL_ADVISOR_URL: parseLocalModelAdvisorUrl(parsed.LOCAL_MODEL_ADVISOR_URL),
    PRODUCT_API_MODE:
      parsed.PRODUCT_API_MODE ??
      (parsed.NODE_ENV === "production" || parsed.HOSTED_API_MODE === "oidc"
        ? "disabled"
        : "local_unauthenticated"),
  };
  if (config.HOSTED_API_MODE === "oidc" && hostedOidcPreflight === undefined) {
    throw new Error("HOSTED_API_MODE=oidc requires complete enabled OIDC configuration.");
  }
  if (config.HOSTED_API_MODE === "oidc" && config.PRODUCT_API_MODE !== "disabled") {
    throw new Error("Hosted OIDC mode cannot expose the local product API.");
  }
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
    config.PRODUCT_API_MODE === "desktop_authenticated" &&
    (config.NODE_ENV !== "production" ||
      config.API_HOST !== "127.0.0.1" ||
      config.API_TRUSTED_PROXIES.length !== 0 ||
      config.HOSTED_API_MODE !== "disabled" ||
      config.DESKTOP_API_TOKEN_DIGEST === undefined)
  ) {
    throw new Error(
      "desktop_authenticated product API mode requires production, direct 127.0.0.1 binding, and a valid launch credential.",
    );
  }
  if (
    config.PRODUCT_API_MODE !== "desktop_authenticated" &&
    config.DESKTOP_API_TOKEN_DIGEST !== undefined
  ) {
    throw new Error(
      "The desktop API launch credential is accepted only in desktop_authenticated mode.",
    );
  }
  if (config.API_PORT === 0 && config.PRODUCT_API_MODE !== "desktop_authenticated") {
    throw new Error("Dynamic API port allocation is accepted only in desktop_authenticated mode.");
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
  if (
    parsed.WORKER_DEPLOYMENT_HEALTH_MODE === "railway" &&
    (parsed.NODE_ENV !== "production" || parsed.PORT === undefined)
  ) {
    throw new Error(
      "Railway worker deployment health requires production mode and the platform PORT.",
    );
  }
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
