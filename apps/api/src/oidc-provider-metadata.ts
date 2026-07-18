import type { FetchImplementation } from "jose";

import { fetchBoundedOidcJson } from "./oidc-bounded-json-fetch.js";
import { OIDC_ID_TOKEN_ALGORITHMS, type OidcIdTokenAlgorithm } from "./oidc-id-token-verifier.js";
import { parseExactOidcProviderUrl } from "./oidc-provider-url.js";

const DISCOVERY_SUFFIX = "/.well-known/openid-configuration";
const DISCOVERY_TIMEOUT_MILLISECONDS = 3_000;
const MAXIMUM_DISCOVERY_BODY_BYTES = 64 * 1_024;
const MAXIMUM_METADATA_LIST_VALUES = 32;
const MAXIMUM_METADATA_VALUE_BYTES = 128;
const MAXIMUM_ENDPOINT_QUERY_PARAMETERS = 16;
const RESERVED_AUTHORIZATION_PARAMETERS = new Set([
  "response_type",
  "client_id",
  "redirect_uri",
  "scope",
  "state",
  "nonce",
  "code_challenge",
  "code_challenge_method",
]);
const SUPPORTED_TOKEN_ENDPOINT_AUTH_METHODS = Object.freeze([
  "client_secret_basic",
  "client_secret_post",
  "none",
] as const);

export type OidcTokenEndpointAuthMethod = (typeof SUPPORTED_TOKEN_ENDPOINT_AUTH_METHODS)[number];

export interface OidcProviderMetadataDiscoveryOptions {
  /** Exact deployment-controlled issuer. Metadata must return this value byte for byte. */
  readonly issuer: string;
  /** Trusted transport responsible for DNS, resolved-IP, proxy, and TLS policy. */
  readonly transport: FetchImplementation;
}

export interface OidcProviderMetadata {
  readonly issuer: string;
  readonly discoveryUrl: string;
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly jwksUri: string;
  readonly idTokenSigningAlgorithms: readonly OidcIdTokenAlgorithm[];
  readonly tokenEndpointAuthMethods: readonly OidcTokenEndpointAuthMethod[];
}

export class OidcProviderMetadataConfigurationError extends Error {
  readonly code = "hosted_oidc.provider_metadata_configuration_invalid";

  constructor() {
    super("Hosted OIDC provider metadata configuration is invalid.");
    this.name = "OidcProviderMetadataConfigurationError";
  }
}

export class OidcProviderMetadataUnavailableError extends Error {
  readonly code = "hosted_oidc.provider_metadata_unavailable";

  constructor() {
    super("Hosted OIDC provider metadata is unavailable.");
    this.name = "OidcProviderMetadataUnavailableError";
  }
}

function invalidConfiguration(): OidcProviderMetadataConfigurationError {
  return new OidcProviderMetadataConfigurationError();
}

function unavailable(): OidcProviderMetadataUnavailableError {
  return new OidcProviderMetadataUnavailableError();
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function isBoundedVisibleAscii(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAXIMUM_METADATA_VALUE_BYTES ||
    value !== value.trim()
  ) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

function boundedProtocolValues(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const snapshot = Array.from(value as unknown[]);
  if (
    snapshot.length === 0 ||
    snapshot.length > MAXIMUM_METADATA_LIST_VALUES ||
    snapshot.some((entry) => !isBoundedVisibleAscii(entry))
  ) {
    return null;
  }
  const values = snapshot as string[];
  return new Set(values).size === values.length ? Object.freeze(values) : null;
}

function optionalProtocolValues(
  value: unknown,
  fallback: readonly string[],
): readonly string[] | null {
  return value === undefined ? fallback : boundedProtocolValues(value);
}

function containsAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function validAuthorizationEndpointQuery(endpoint: URL): boolean {
  const entries = [...endpoint.searchParams];
  return (
    entries.length <= MAXIMUM_ENDPOINT_QUERY_PARAMETERS &&
    entries.every(
      ([name, value]) =>
        name.length > 0 &&
        name.length <= 128 &&
        value.length <= 512 &&
        !/\s/u.test(name) &&
        !containsAsciiControl(name) &&
        !containsAsciiControl(value) &&
        !RESERVED_AUTHORIZATION_PARAMETERS.has(name),
    )
  );
}

function trustedEndpoint(value: unknown, authorizationEndpoint = false): string | null {
  const parsed = parseExactOidcProviderUrl(value, true);
  if (parsed === null || (authorizationEndpoint && !validAuthorizationEndpointQuery(parsed))) {
    return null;
  }
  return parsed.href;
}

function trustedAlgorithms(values: readonly string[]): readonly OidcIdTokenAlgorithm[] | null {
  if (!values.includes("RS256")) return null;
  const supported = OIDC_ID_TOKEN_ALGORITHMS.filter((algorithm) => values.includes(algorithm));
  return supported.length > 0 ? Object.freeze(supported) : null;
}

function trustedAuthMethods(
  values: readonly string[],
): readonly OidcTokenEndpointAuthMethod[] | null {
  const supported = SUPPORTED_TOKEN_ENDPOINT_AUTH_METHODS.filter((method) =>
    values.includes(method),
  );
  return supported.length > 0 ? Object.freeze(supported) : null;
}

function providerSnapshot(
  value: unknown,
  configuredIssuer: string,
  discoveryUrl: string,
): OidcProviderMetadata {
  if (!isPlainObject(value)) throw unavailable();

  const metadataIssuer: unknown = value.issuer;
  const authorizationEndpointValue: unknown = value.authorization_endpoint;
  const tokenEndpointValue: unknown = value.token_endpoint;
  const jwksUriValue: unknown = value.jwks_uri;
  const responseTypesValue: unknown = value.response_types_supported;
  const subjectTypesValue: unknown = value.subject_types_supported;
  const signingAlgorithmsValue: unknown = value.id_token_signing_alg_values_supported;
  const grantTypesValue: unknown = value.grant_types_supported;
  const responseModesValue: unknown = value.response_modes_supported;
  const scopesValue: unknown = value.scopes_supported;
  const codeChallengeMethodsValue: unknown = value.code_challenge_methods_supported;
  const tokenAuthMethodsValue: unknown = value.token_endpoint_auth_methods_supported;

  const authorizationEndpoint = trustedEndpoint(authorizationEndpointValue, true);
  const tokenEndpoint = trustedEndpoint(tokenEndpointValue);
  const jwksUri = trustedEndpoint(jwksUriValue);
  const responseTypes = boundedProtocolValues(responseTypesValue);
  const subjectTypes = boundedProtocolValues(subjectTypesValue);
  const signingAlgorithmValues = boundedProtocolValues(signingAlgorithmsValue);
  const grantTypes = optionalProtocolValues(grantTypesValue, Object.freeze(["authorization_code"]));
  const responseModes = optionalProtocolValues(responseModesValue, Object.freeze(["query"]));
  const scopes =
    scopesValue === undefined ? Object.freeze(["openid"]) : boundedProtocolValues(scopesValue);
  const codeChallengeMethods = boundedProtocolValues(codeChallengeMethodsValue);
  const tokenAuthMethods = optionalProtocolValues(
    tokenAuthMethodsValue,
    Object.freeze(["client_secret_basic"]),
  );
  const idTokenSigningAlgorithms =
    signingAlgorithmValues === null ? null : trustedAlgorithms(signingAlgorithmValues);
  const tokenEndpointAuthMethods =
    tokenAuthMethods === null ? null : trustedAuthMethods(tokenAuthMethods);

  if (
    metadataIssuer !== configuredIssuer ||
    authorizationEndpoint === null ||
    tokenEndpoint === null ||
    jwksUri === null ||
    responseTypes === null ||
    !responseTypes.includes("code") ||
    subjectTypes === null ||
    subjectTypes.some((type) => type !== "public" && type !== "pairwise") ||
    idTokenSigningAlgorithms === null ||
    grantTypes === null ||
    !grantTypes.includes("authorization_code") ||
    responseModes === null ||
    !responseModes.includes("query") ||
    scopes === null ||
    !scopes.includes("openid") ||
    codeChallengeMethods === null ||
    !codeChallengeMethods.includes("S256") ||
    tokenEndpointAuthMethods === null
  ) {
    throw unavailable();
  }

  return Object.freeze({
    issuer: configuredIssuer,
    discoveryUrl,
    authorizationEndpoint,
    tokenEndpoint,
    jwksUri,
    idTokenSigningAlgorithms,
    tokenEndpointAuthMethods,
  });
}

/**
 * Retrieves and freezes one exact provider metadata snapshot. Successful metadata is intentionally
 * stable for this object's lifetime; a configuration reload must build a new discovery instance.
 */
export class OidcProviderMetadataDiscovery {
  readonly #issuer: string;
  readonly #discoveryUrl: string;
  readonly #transport: FetchImplementation;
  #metadata: OidcProviderMetadata | undefined;
  #pending: Promise<OidcProviderMetadata> | undefined;

  constructor(options: OidcProviderMetadataDiscoveryOptions) {
    try {
      if (typeof options !== "object" || options === null) throw invalidConfiguration();
      const issuerValue: unknown = options.issuer;
      const transportValue: unknown = options.transport;
      if (
        parseExactOidcProviderUrl(issuerValue, false) === null ||
        typeof transportValue !== "function"
      ) {
        throw invalidConfiguration();
      }
      const issuer = issuerValue as string;
      const discoveryUrl = `${issuer.endsWith("/") ? issuer.slice(0, -1) : issuer}${DISCOVERY_SUFFIX}`;
      if (parseExactOidcProviderUrl(discoveryUrl, false) === null) throw invalidConfiguration();
      this.#issuer = issuer;
      this.#discoveryUrl = discoveryUrl;
      this.#transport = transportValue as FetchImplementation;
    } catch (error) {
      if (error instanceof OidcProviderMetadataConfigurationError) throw error;
      throw invalidConfiguration();
    }
  }

  discover(): Promise<OidcProviderMetadata> {
    if (this.#metadata !== undefined) return Promise.resolve(this.#metadata);
    if (this.#pending !== undefined) return this.#pending;

    const pending = fetchBoundedOidcJson({
      url: this.#discoveryUrl,
      transport: this.#transport,
      signal: new AbortController().signal,
      timeoutMilliseconds: DISCOVERY_TIMEOUT_MILLISECONDS,
      requestHeaders: new Headers({ accept: "application/json" }),
      maximumBodyBytes: MAXIMUM_DISCOVERY_BODY_BYTES,
      acceptedContentTypes: ["application/json"],
    })
      .then((value) => providerSnapshot(value, this.#issuer, this.#discoveryUrl))
      .then(
        (value) => {
          this.#metadata = value;
          this.#pending = undefined;
          return value;
        },
        () => {
          this.#pending = undefined;
          throw unavailable();
        },
      );
    this.#pending = pending;
    return pending;
  }
}
