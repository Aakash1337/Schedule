import {
  createRemoteJWKSet,
  customFetch,
  type FetchImplementation,
  type JWTVerifyGetKey,
} from "jose";

const MAXIMUM_PROVIDER_URL_BYTES = 2_048;
const MAXIMUM_JWKS_BODY_BYTES = 64 * 1_024;
const MAXIMUM_JWKS_KEYS = 32;
const REQUEST_TIMEOUT_MILLISECONDS = 3_000;
const UNKNOWN_KEY_COOLDOWN_MILLISECONDS = 30_000;
const CACHE_MAX_AGE_MILLISECONDS = 300_000;
const FORBIDDEN_RAW_URL_CHARACTER = /[\s\\]/u;
const JSON_CONTENT_TYPE = /^(?:application\/json|application\/jwk-set\+json)(?:\s*;.*)?$/iu;
const FORBIDDEN_REQUEST_HEADERS = new Set([
  "authorization",
  "cookie",
  "forwarded",
  "proxy-authorization",
  "proxy-connection",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
]);

export interface OidcRemoteJwksResolverOptions {
  /** Exact provider issuer to bind to this resolver. */
  readonly issuer: string;
  /** Deployment-controlled, pinned JWKS endpoint for the provider. */
  readonly jwksUri: string;
  /**
   * Trusted transport that enforces deployment-specific DNS, IP, proxy, and TLS egress policy.
   * This module deliberately has no implicit global-fetch fallback.
   */
  readonly transport: FetchImplementation;
}

export interface OidcRemoteJwksResolver {
  readonly issuer: string;
  readonly jwksUri: string;
  readonly keyResolver: JWTVerifyGetKey;
}

/** Stable, redacted construction failure for invalid or hostile provider configuration. */
export class OidcRemoteJwksResolverConfigurationError extends Error {
  readonly code = "hosted_oidc.remote_jwks_configuration_invalid";

  constructor() {
    super("Hosted OIDC remote signing-key configuration is invalid.");
    this.name = "OidcRemoteJwksResolverConfigurationError";
  }
}

class OidcRemoteJwksUnavailableError extends Error {
  constructor() {
    super("Hosted OIDC remote signing keys are unavailable.");
    this.name = "OidcRemoteJwksUnavailableError";
  }
}

function invalidConfiguration(): OidcRemoteJwksResolverConfigurationError {
  return new OidcRemoteJwksResolverConfigurationError();
}

function unavailable(): OidcRemoteJwksUnavailableError {
  return new OidcRemoteJwksUnavailableError();
}

function validRawUrl(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAXIMUM_PROVIDER_URL_BYTES &&
    !FORBIDDEN_RAW_URL_CHARACTER.test(value) &&
    !containsAsciiControl(value)
  );
}

function containsAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function parseProviderUrl(value: unknown, allowQuery: boolean): URL | null {
  if (!validRawUrl(value)) return null;

  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname.length === 0 ||
      parsed.username.length > 0 ||
      parsed.password.length > 0 ||
      parsed.port.length > 0 ||
      parsed.hash.length > 0 ||
      (!allowQuery && parsed.search.length > 0)
    ) {
      return null;
    }

    // Preserve the interoperable root-issuer spelling without a trailing slash. Otherwise reject
    // spellings that URL would silently normalize (IDNs, redundant ports, or dot segments).
    if (parsed.href !== value && !(parsed.pathname === "/" && parsed.href === `${value}/`)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function safeContentLength(headers: Headers): number | null {
  const raw = headers.get("content-length");
  if (raw === null) return null;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(raw)) throw unavailable();
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > MAXIMUM_JWKS_BODY_BYTES) throw unavailable();
  return value;
}

async function readBoundedBody(response: Response): Promise<Uint8Array> {
  const declaredLength = safeContentLength(response.headers);
  if (response.body === null) throw unavailable();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = next.value;
      total += chunk.byteLength;
      if (total > MAXIMUM_JWKS_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw unavailable();
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }

  if (declaredLength !== null && declaredLength !== total) throw unavailable();
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function parseBoundedJwks(
  body: Uint8Array,
): Readonly<{ keys: readonly Record<string, unknown>[] }> {
  let parsed: unknown;
  try {
    const json = new TextDecoder("utf-8", { fatal: true }).decode(body);
    parsed = JSON.parse(json) as unknown;
  } catch {
    throw unavailable();
  }

  if (!isPlainObject(parsed) || !Object.hasOwn(parsed, "keys")) throw unavailable();
  const keys = parsed.keys;
  if (
    !Array.isArray(keys) ||
    keys.length === 0 ||
    keys.length > MAXIMUM_JWKS_KEYS ||
    keys.some((key) => !isPlainObject(key))
  ) {
    throw unavailable();
  }

  return { keys: keys.map((key) => ({ ...key })) };
}

function trustedRequestHeaders(headers: Headers): Headers {
  const snapshot = new Headers(headers);
  let headerCount = 0;
  for (const [name, value] of snapshot) {
    headerCount += 1;
    if (
      headerCount > 8 ||
      FORBIDDEN_REQUEST_HEADERS.has(name.toLowerCase()) ||
      name.toLowerCase().startsWith("x-forwarded-") ||
      Buffer.byteLength(name, "utf8") > 128 ||
      Buffer.byteLength(value, "utf8") > 1_024
    ) {
      throw unavailable();
    }
  }
  snapshot.set("accept-encoding", "identity");
  return snapshot;
}

function boundedFetch(pinnedJwksUri: string, transport: FetchImplementation): FetchImplementation {
  return async (resource, options) => {
    try {
      if (resource !== pinnedJwksUri || options.method !== "GET" || options.redirect !== "manual") {
        throw unavailable();
      }

      const response = await transport(resource, {
        method: "GET",
        redirect: "manual",
        signal: options.signal,
        headers: trustedRequestHeaders(options.headers),
      });
      if (
        !(response instanceof Response) ||
        response.status !== 200 ||
        response.redirected ||
        (response.url.length > 0 && response.url !== pinnedJwksUri)
      ) {
        throw unavailable();
      }
      const contentType = response.headers.get("content-type");
      if (contentType === null || !JSON_CONTENT_TYPE.test(contentType)) throw unavailable();

      const jwks = parseBoundedJwks(await readBoundedBody(response));
      const normalized = JSON.stringify(jwks);
      if (Buffer.byteLength(normalized, "utf8") > MAXIMUM_JWKS_BODY_BYTES) throw unavailable();
      return new Response(normalized, {
        status: 200,
        headers: { "content-type": "application/jwk-set+json" },
      });
    } catch {
      throw unavailable();
    }
  };
}

/**
 * Creates a dormant, provider-scoped signing-key resolver. The mandatory transport is the
 * connection-level trust boundary; this adapter adds exact endpoint binding, redirect denial,
 * bounded response parsing, and JOSE's in-memory single-flight rotation cache.
 */
export function createOidcRemoteJwksResolver(
  options: OidcRemoteJwksResolverOptions,
): OidcRemoteJwksResolver {
  try {
    if (typeof options !== "object" || options === null) throw invalidConfiguration();
    const issuerValue: unknown = options.issuer;
    const jwksUriValue: unknown = options.jwksUri;
    const transportValue: unknown = options.transport;
    const issuer = parseProviderUrl(issuerValue, false);
    const jwksUri = parseProviderUrl(jwksUriValue, true);
    if (issuer === null || jwksUri === null || typeof transportValue !== "function") {
      throw invalidConfiguration();
    }

    const canonicalJwksUri = jwksUri.href;
    const keyResolver: JWTVerifyGetKey = createRemoteJWKSet(jwksUri, {
      timeoutDuration: REQUEST_TIMEOUT_MILLISECONDS,
      cooldownDuration: UNKNOWN_KEY_COOLDOWN_MILLISECONDS,
      cacheMaxAge: CACHE_MAX_AGE_MILLISECONDS,
      [customFetch]: boundedFetch(canonicalJwksUri, transportValue as FetchImplementation),
    });

    return Object.freeze({
      issuer: issuerValue as string,
      jwksUri: canonicalJwksUri,
      keyResolver,
    });
  } catch (error) {
    if (error instanceof OidcRemoteJwksResolverConfigurationError) throw error;
    throw invalidConfiguration();
  }
}
