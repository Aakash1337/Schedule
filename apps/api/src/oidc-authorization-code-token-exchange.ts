import type { ConsumedHostedLoginTransaction } from "@schedule/application";

import {
  readBoundedOidcJsonResponse,
  runOidcOperationWithDeadline,
} from "./oidc-bounded-json-fetch.js";
import type {
  OidcProviderMetadata,
  OidcTokenEndpointAuthMethod,
} from "./oidc-provider-metadata.js";
import { parseExactOidcProviderUrl } from "./oidc-provider-url.js";

const TOKEN_REQUEST_TIMEOUT_MILLISECONDS = 3_000;
const MAXIMUM_TOKEN_RESPONSE_BODY_BYTES = 64 * 1_024;
const MAXIMUM_AUTHORIZATION_CODE_BYTES = 2_048;
const MAXIMUM_CLIENT_ID_BYTES = 512;
const MAXIMUM_CLIENT_SECRET_BYTES = 1_024;
const MAXIMUM_REQUEST_BODY_BYTES = 16 * 1_024;
const MAXIMUM_TOKEN_BYTES = 16 * 1_024;
const MAXIMUM_SCOPE_BYTES = 1_024;
const MAXIMUM_ENDPOINT_QUERY_PARAMETERS = 16;
const PKCE_VERIFIER_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const AUTHORIZATION_CODE_PATTERN = /^[\x21-\x7e]+$/u;
const COMPACT_ID_TOKEN_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
const OAUTH_ERROR_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;
const SCOPE_PATTERN = /^[\x21\x23-\x5b\x5d-\x7e]+(?: [\x21\x23-\x5b\x5d-\x7e]+)*$/u;
const TOKEN_REQUEST_PARAMETER_NAMES = new Set([
  "grant_type",
  "code",
  "redirect_uri",
  "code_verifier",
  "client_id",
  "client_secret",
]);

export type OidcTokenEndpointAuthentication =
  | Readonly<{ method: "client_secret_basic"; clientSecret: string }>
  | Readonly<{ method: "client_secret_post"; clientSecret: string }>
  | Readonly<{ method: "none" }>;

export type OidcTokenEndpointTransport = (
  resource: string,
  options: RequestInit & Readonly<{ method: "POST" }>,
) => Promise<Response>;

export interface OidcAuthorizationCodeTokenExchangeConfiguration {
  /** One validated provider snapshot; its issuer, endpoint, and advertised auth methods are pinned. */
  readonly metadata: Pick<
    OidcProviderMetadata,
    "issuer" | "tokenEndpoint" | "tokenEndpointAuthMethods"
  >;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly authentication: OidcTokenEndpointAuthentication;
  /** Trusted transport responsible for DNS, resolved-IP, proxy, and TLS policy. */
  readonly transport: OidcTokenEndpointTransport;
}

export interface OidcAuthorizationCodeTokenExchangeInput {
  readonly code: string;
  readonly transaction: ConsumedHostedLoginTransaction;
}

export interface OidcAuthorizationCodeTokenExchange {
  /** Still-untrusted compact token; only the existing verifier may turn it into an identity. */
  readonly idToken: string;
}

export interface OidcAuthorizationCodeTokenExchanger {
  exchange(
    input: OidcAuthorizationCodeTokenExchangeInput,
  ): Promise<OidcAuthorizationCodeTokenExchange | null>;
}

/** Stable, redacted trusted-composition or consumed-transaction binding failure. */
export class OidcAuthorizationCodeTokenExchangeConfigurationError extends Error {
  readonly code = "hosted_oidc.authorization_code_exchange_configuration_invalid";

  constructor() {
    super("The hosted OIDC authorization-code exchange configuration is invalid.");
    this.name = "OidcAuthorizationCodeTokenExchangeConfigurationError";
  }
}

/** Stable, redacted provider or transport availability failure. */
export class OidcAuthorizationCodeTokenExchangeUnavailableError extends Error {
  readonly code = "hosted_oidc.authorization_code_exchange_unavailable";

  constructor() {
    super("The hosted OIDC authorization-code exchange is unavailable.");
    this.name = "OidcAuthorizationCodeTokenExchangeUnavailableError";
  }
}

function invalidConfiguration(): OidcAuthorizationCodeTokenExchangeConfigurationError {
  return new OidcAuthorizationCodeTokenExchangeConfigurationError();
}

function unavailable(): OidcAuthorizationCodeTokenExchangeUnavailableError {
  return new OidcAuthorizationCodeTokenExchangeUnavailableError();
}

function containsAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function validClientId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAXIMUM_CLIENT_ID_BYTES &&
    value === value.trim() &&
    !containsAsciiControl(value)
  );
}

function validClientSecret(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAXIMUM_CLIENT_SECRET_BYTES &&
    !containsAsciiControl(value)
  );
}

function validRedirectUri(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > 2_048 ||
    value !== value.trim() ||
    /[\s\\]/u.test(value) ||
    containsAsciiControl(value)
  ) {
    return false;
  }
  try {
    const parsed = new URL(value);
    const bareQuery = parsed.search.length === 0 && value.includes("?");
    const bareFragment = parsed.hash.length === 0 && value.includes("#");
    return (
      parsed.protocol === "https:" &&
      parsed.hostname.length > 0 &&
      parsed.username.length === 0 &&
      parsed.password.length === 0 &&
      parsed.hash.length === 0 &&
      !bareQuery &&
      !bareFragment &&
      (parsed.href === value || (parsed.pathname === "/" && parsed.href === `${value}/`))
    );
  } catch {
    return false;
  }
}

function validTokenEndpointQuery(endpoint: URL): boolean {
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
        !TOKEN_REQUEST_PARAMETER_NAMES.has(name),
    )
  );
}

function advertisedAuthMethods(value: unknown): readonly OidcTokenEndpointAuthMethod[] | null {
  if (!Array.isArray(value)) return null;
  const snapshot = Array.from(value as unknown[]);
  if (
    snapshot.length === 0 ||
    snapshot.length > 3 ||
    snapshot.some(
      (method) =>
        method !== "client_secret_basic" && method !== "client_secret_post" && method !== "none",
    ) ||
    new Set(snapshot).size !== snapshot.length
  ) {
    return null;
  }
  return Object.freeze(snapshot as OidcTokenEndpointAuthMethod[]);
}

function formEncode(value: string): string {
  return new URLSearchParams({ value }).toString().slice("value=".length);
}

function basicAuthorization(clientId: string, clientSecret: string): string {
  return `Basic ${Buffer.from(`${formEncode(clientId)}:${formEncode(clientSecret)}`, "utf8").toString("base64")}`;
}

interface ConsumedTransactionSnapshot {
  readonly issuer: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly expectedNonce: string;
  readonly pkceVerifier: string;
  readonly consumedAtMilliseconds: number;
}

function consumedTransactionSnapshot(value: unknown): ConsumedTransactionSnapshot | null {
  try {
    if (typeof value !== "object" || value === null) return null;
    const transaction = value as Partial<ConsumedHostedLoginTransaction>;
    const issuer = transaction.issuer;
    const clientId = transaction.clientId;
    const redirectUri = transaction.redirectUri;
    const expectedNonce = transaction.expectedNonce;
    const pkceVerifier = transaction.pkceVerifier;
    const consumedAt = transaction.consumedAt;
    const consumedAtMilliseconds = consumedAt instanceof Date ? consumedAt.getTime() : Number.NaN;
    if (
      parseExactOidcProviderUrl(issuer, false) === null ||
      !validClientId(clientId) ||
      !validRedirectUri(redirectUri) ||
      typeof expectedNonce !== "string" ||
      !PKCE_VERIFIER_PATTERN.test(expectedNonce) ||
      typeof pkceVerifier !== "string" ||
      !PKCE_VERIFIER_PATTERN.test(pkceVerifier) ||
      !Number.isFinite(consumedAtMilliseconds)
    ) {
      return null;
    }
    return Object.freeze({
      issuer: issuer as string,
      clientId,
      redirectUri,
      expectedNonce,
      pkceVerifier,
      consumedAtMilliseconds,
    });
  } catch {
    return null;
  }
}

function boundedOpaqueToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAXIMUM_TOKEN_BYTES &&
    AUTHORIZATION_CODE_PATTERN.test(value)
  );
}

function validSuccessfulTokenResponse(value: unknown): OidcAuthorizationCodeTokenExchange | null {
  if (!isPlainObject(value)) return null;
  const accessToken = value.access_token;
  const tokenType = value.token_type;
  const idToken = value.id_token;
  const refreshToken = value.refresh_token;
  const expiresIn = value.expires_in;
  const scope = value.scope;
  if (
    !boundedOpaqueToken(accessToken) ||
    typeof tokenType !== "string" ||
    tokenType.toLowerCase() !== "bearer" ||
    typeof idToken !== "string" ||
    Buffer.byteLength(idToken, "utf8") > MAXIMUM_TOKEN_BYTES ||
    !COMPACT_ID_TOKEN_PATTERN.test(idToken) ||
    (refreshToken !== undefined && !boundedOpaqueToken(refreshToken)) ||
    (expiresIn !== undefined &&
      (!Number.isSafeInteger(expiresIn) ||
        (expiresIn as number) < 0 ||
        (expiresIn as number) > 315_360_000)) ||
    (scope !== undefined &&
      (typeof scope !== "string" ||
        Buffer.byteLength(scope, "ascii") > MAXIMUM_SCOPE_BYTES ||
        !SCOPE_PATTERN.test(scope)))
  ) {
    return null;
  }
  return Object.freeze({ idToken });
}

function validOAuthError(value: unknown): boolean {
  return (
    isPlainObject(value) && typeof value.error === "string" && OAUTH_ERROR_PATTERN.test(value.error)
  );
}

/**
 * Redeems one already-consumed login transaction exactly once per invocation. It never retries and
 * intentionally performs no ID-token parsing, identity acceptance, persistence, or route work.
 */
export class StrictOidcAuthorizationCodeTokenExchanger implements OidcAuthorizationCodeTokenExchanger {
  readonly #issuer: string;
  readonly #tokenEndpoint: string;
  readonly #clientId: string;
  readonly #redirectUri: string;
  readonly #authMethod: OidcTokenEndpointAuthMethod;
  readonly #authorizationHeader: string | undefined;
  readonly #clientSecret: string | undefined;
  readonly #transport: OidcTokenEndpointTransport;

  constructor(configuration: OidcAuthorizationCodeTokenExchangeConfiguration) {
    try {
      if (typeof configuration !== "object" || configuration === null) throw invalidConfiguration();
      const metadata = configuration.metadata;
      const clientIdValue: unknown = configuration.clientId;
      const redirectUriValue: unknown = configuration.redirectUri;
      const authentication = configuration.authentication;
      const transportValue: unknown = configuration.transport;
      if (
        typeof metadata !== "object" ||
        metadata === null ||
        typeof authentication !== "object" ||
        authentication === null
      ) {
        throw invalidConfiguration();
      }
      const issuerValue: unknown = metadata.issuer;
      const tokenEndpointValue: unknown = metadata.tokenEndpoint;
      const tokenEndpoint = parseExactOidcProviderUrl(tokenEndpointValue, true);
      const authMethods = advertisedAuthMethods(metadata.tokenEndpointAuthMethods);
      const methodValue: unknown = authentication.method;
      const clientSecretValue: unknown = (authentication as { clientSecret?: unknown })
        .clientSecret;
      if (
        parseExactOidcProviderUrl(issuerValue, false) === null ||
        tokenEndpoint === null ||
        !validTokenEndpointQuery(tokenEndpoint) ||
        !validClientId(clientIdValue) ||
        !validRedirectUri(redirectUriValue) ||
        authMethods === null ||
        (methodValue !== "client_secret_basic" &&
          methodValue !== "client_secret_post" &&
          methodValue !== "none") ||
        !authMethods.includes(methodValue) ||
        typeof transportValue !== "function" ||
        (methodValue === "none"
          ? clientSecretValue !== undefined
          : !validClientSecret(clientSecretValue))
      ) {
        throw invalidConfiguration();
      }

      this.#issuer = issuerValue as string;
      this.#tokenEndpoint = tokenEndpoint.href;
      this.#clientId = clientIdValue;
      this.#redirectUri = redirectUriValue;
      this.#authMethod = methodValue;
      this.#authorizationHeader =
        methodValue === "client_secret_basic"
          ? basicAuthorization(clientIdValue, clientSecretValue as string)
          : undefined;
      this.#clientSecret =
        methodValue === "client_secret_post" ? (clientSecretValue as string) : undefined;
      this.#transport = transportValue as OidcTokenEndpointTransport;
    } catch (error) {
      if (error instanceof OidcAuthorizationCodeTokenExchangeConfigurationError) throw error;
      throw invalidConfiguration();
    }
  }

  async exchange(
    input: OidcAuthorizationCodeTokenExchangeInput,
  ): Promise<OidcAuthorizationCodeTokenExchange | null> {
    let code: string;
    let transaction: ConsumedTransactionSnapshot;
    try {
      if (typeof input !== "object" || input === null) throw invalidConfiguration();
      const codeValue: unknown = input.code;
      const snapshot = consumedTransactionSnapshot(input.transaction);
      if (
        snapshot === null ||
        snapshot.issuer !== this.#issuer ||
        snapshot.clientId !== this.#clientId ||
        snapshot.redirectUri !== this.#redirectUri
      ) {
        throw invalidConfiguration();
      }
      if (
        typeof codeValue !== "string" ||
        codeValue.length === 0 ||
        Buffer.byteLength(codeValue, "utf8") > MAXIMUM_AUTHORIZATION_CODE_BYTES ||
        !AUTHORIZATION_CODE_PATTERN.test(codeValue)
      ) {
        return null;
      }
      code = codeValue;
      transaction = snapshot;
    } catch (error) {
      if (error instanceof OidcAuthorizationCodeTokenExchangeConfigurationError) throw error;
      throw invalidConfiguration();
    }

    const form = new URLSearchParams();
    form.append("grant_type", "authorization_code");
    form.append("code", code);
    form.append("redirect_uri", this.#redirectUri);
    form.append("code_verifier", transaction.pkceVerifier);
    if (this.#authMethod === "none" || this.#authMethod === "client_secret_post") {
      form.append("client_id", this.#clientId);
    }
    if (this.#authMethod === "client_secret_post") {
      form.append("client_secret", this.#clientSecret as string);
    }
    const body = form.toString();
    if (Buffer.byteLength(body, "utf8") > MAXIMUM_REQUEST_BODY_BYTES) throw invalidConfiguration();

    const headers = new Headers({
      accept: "application/json",
      "accept-encoding": "identity",
      "cache-control": "no-store",
      "content-type": "application/x-www-form-urlencoded",
      pragma: "no-cache",
    });
    if (this.#authorizationHeader !== undefined) {
      headers.set("authorization", this.#authorizationHeader);
    }

    try {
      const result = await runOidcOperationWithDeadline(
        new AbortController().signal,
        TOKEN_REQUEST_TIMEOUT_MILLISECONDS,
        async (signal) => {
          const response = await this.#transport(this.#tokenEndpoint, {
            method: "POST",
            redirect: "manual",
            credentials: "omit",
            referrerPolicy: "no-referrer",
            signal,
            headers,
            body,
          });
          if (!(response instanceof Response) || response.url !== this.#tokenEndpoint) {
            throw unavailable();
          }
          return readBoundedOidcJsonResponse({
            response,
            expectedUrl: this.#tokenEndpoint,
            acceptedStatusCodes: [200, 400, 401],
            maximumBodyBytes: MAXIMUM_TOKEN_RESPONSE_BODY_BYTES,
            acceptedContentTypes: ["application/json"],
            requireNoStore: true,
          });
        },
      );
      if (result.status === 400) {
        if (!validOAuthError(result.json)) throw unavailable();
        return null;
      }
      if (result.status === 401) throw unavailable();
      return validSuccessfulTokenResponse(result.json);
    } catch {
      throw unavailable();
    }
  }
}
