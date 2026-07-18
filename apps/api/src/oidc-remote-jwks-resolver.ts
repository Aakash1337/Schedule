import {
  createRemoteJWKSet,
  customFetch,
  type FetchImplementation,
  type JWTVerifyGetKey,
} from "jose";

import { fetchBoundedOidcJson } from "./oidc-bounded-json-fetch.js";
import { parseExactOidcProviderUrl } from "./oidc-provider-url.js";

const MAXIMUM_JWKS_BODY_BYTES = 64 * 1_024;
const MAXIMUM_JWKS_KEYS = 32;
const REQUEST_TIMEOUT_MILLISECONDS = 3_000;
const UNKNOWN_KEY_COOLDOWN_MILLISECONDS = 30_000;
const CACHE_MAX_AGE_MILLISECONDS = 300_000;

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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function parseBoundedJwks(parsed: unknown): Readonly<{ keys: readonly Record<string, unknown>[] }> {
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

function boundedFetch(pinnedJwksUri: string, transport: FetchImplementation): FetchImplementation {
  return async (resource, options) => {
    try {
      if (resource !== pinnedJwksUri || options.method !== "GET" || options.redirect !== "manual") {
        throw unavailable();
      }

      const jwks = parseBoundedJwks(
        await fetchBoundedOidcJson({
          url: pinnedJwksUri,
          transport,
          signal: options.signal,
          timeoutMilliseconds: REQUEST_TIMEOUT_MILLISECONDS,
          requestHeaders: options.headers,
          maximumBodyBytes: MAXIMUM_JWKS_BODY_BYTES,
          acceptedContentTypes: ["application/json", "application/jwk-set+json"],
        }),
      );
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
    const issuer = parseExactOidcProviderUrl(issuerValue, false);
    const jwksUri = parseExactOidcProviderUrl(jwksUriValue, true);
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
