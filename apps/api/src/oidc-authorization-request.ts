import type { IssuedHostedLoginTransaction } from "@schedule/application";
import { HOSTED_LOGIN_PKCE_METHOD } from "@schedule/domain";

const MAXIMUM_URL_LENGTH = 2_048;
const MAXIMUM_AUTHORIZATION_REQUEST_URL_BYTES = 8 * 1_024;
const MAXIMUM_CLIENT_ID_LENGTH = 512;
const MAXIMUM_SCOPE_COUNT = 16;
const MAXIMUM_SCOPE_TOKEN_LENGTH = 128;
const MAXIMUM_SCOPE_VALUE_BYTES = 512;
const MAXIMUM_ENDPOINT_QUERY_PARAMETERS = 16;
const OPAQUE_VALUE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
// RFC 6749 scope-token: visible ASCII except double quote and backslash.
const SCOPE_TOKEN_PATTERN = /^[\x21\x23-\x5b\x5d-\x7e]+$/u;
const REQUEST_PARAMETER_NAMES = Object.freeze([
  "response_type",
  "client_id",
  "redirect_uri",
  "scope",
  "state",
  "nonce",
  "code_challenge",
  "code_challenge_method",
] as const);
const RESERVED_REQUEST_PARAMETERS = new Set<string>(REQUEST_PARAMETER_NAMES);

export interface OidcAuthorizationRequestConfiguration {
  /** Exact OIDC issuer used when the server-side login transaction is persisted. */
  readonly issuer: string;
  /** Trusted provider endpoint. Token input can never replace or extend this URL. */
  readonly authorizationEndpoint: string;
  /** Exact registered client identifier and redirect URI. */
  readonly clientId: string;
  readonly redirectUri: string;
  /** Required OIDC/OAuth scopes. `openid` must be present exactly once. */
  readonly scopes: readonly string[];
}

export interface OidcAuthorizationRequestBuilderOptions {
  readonly clock?: () => Date;
}

export interface OidcAuthorizationRequest {
  /** Canonical URL with trusted endpoint query plus the fixed authorization-code parameters. */
  readonly url: string;
}

export interface OidcAuthorizationRequestBuilder {
  build(transaction: IssuedHostedLoginTransaction): OidcAuthorizationRequest;
}

/** Stable, redacted trusted-composition failure. */
export class OidcAuthorizationRequestConfigurationError extends Error {
  readonly code = "hosted_oidc.authorization_request_invalid";

  constructor() {
    super("The hosted OIDC authorization request could not be created.");
    this.name = "OidcAuthorizationRequestConfigurationError";
  }
}

function invalid(): OidcAuthorizationRequestConfigurationError {
  return new OidcAuthorizationRequestConfigurationError();
}

function containsAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function validExactHttpsUrl(value: unknown, allowQuery: boolean): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAXIMUM_URL_LENGTH ||
    value !== value.trim() ||
    containsAsciiControl(value) ||
    /\s/u.test(value) ||
    value.includes("\\")
  ) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      parsed.hostname.length > 0 &&
      parsed.username.length === 0 &&
      parsed.password.length === 0 &&
      parsed.hash.length === 0 &&
      (allowQuery || parsed.search.length === 0)
    );
  } catch {
    return false;
  }
}

function validClientId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAXIMUM_CLIENT_ID_LENGTH &&
    value === value.trim() &&
    !containsAsciiControl(value)
  );
}

function canonicalScopes(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const snapshot = Array.from(value as unknown[]);
  if (snapshot.length === 0 || snapshot.length > MAXIMUM_SCOPE_COUNT) return null;
  if (
    snapshot.some(
      (scope) =>
        typeof scope !== "string" ||
        scope.length === 0 ||
        scope.length > MAXIMUM_SCOPE_TOKEN_LENGTH ||
        !SCOPE_TOKEN_PATTERN.test(scope),
    )
  ) {
    return null;
  }
  const scopes = snapshot as string[];
  if (new Set(scopes).size !== scopes.length || !scopes.includes("openid")) return null;
  const canonical = [
    "openid",
    ...scopes
      .filter((scope) => scope !== "openid")
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)),
  ];
  return Buffer.byteLength(canonical.join(" "), "ascii") <= MAXIMUM_SCOPE_VALUE_BYTES
    ? Object.freeze(canonical)
    : null;
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
        !RESERVED_REQUEST_PARAMETERS.has(name),
    )
  );
}

interface IssuedTransactionSnapshot {
  readonly issuer: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly nonce: string;
  readonly pkceChallenge: string;
  readonly expiresAtMilliseconds: number;
}

function issuedTransactionSnapshot(value: unknown): IssuedTransactionSnapshot | null {
  try {
    if (typeof value !== "object" || value === null) return null;
    const transaction = value as Partial<IssuedHostedLoginTransaction>;
    const issuer = transaction.issuer;
    const clientId = transaction.clientId;
    const redirectUri = transaction.redirectUri;
    const state = transaction.state;
    const browserBinding = transaction.browserBinding;
    const nonce = transaction.nonce;
    const pkceChallenge = transaction.pkceChallenge;
    const pkceMethod = transaction.pkceMethod;
    const expiresAt = transaction.expiresAt;
    const expiresAtMilliseconds = expiresAt instanceof Date ? expiresAt.getTime() : Number.NaN;
    if (
      !validExactHttpsUrl(issuer, false) ||
      !validClientId(clientId) ||
      !validExactHttpsUrl(redirectUri, true) ||
      typeof state !== "string" ||
      !OPAQUE_VALUE_PATTERN.test(state) ||
      typeof browserBinding !== "string" ||
      !OPAQUE_VALUE_PATTERN.test(browserBinding) ||
      typeof nonce !== "string" ||
      !OPAQUE_VALUE_PATTERN.test(nonce) ||
      typeof pkceChallenge !== "string" ||
      !OPAQUE_VALUE_PATTERN.test(pkceChallenge) ||
      pkceMethod !== HOSTED_LOGIN_PKCE_METHOD ||
      !Number.isFinite(expiresAtMilliseconds)
    ) {
      return null;
    }
    return Object.freeze({
      issuer,
      clientId,
      redirectUri,
      state,
      nonce,
      pkceChallenge,
      expiresAtMilliseconds,
    });
  } catch {
    return null;
  }
}

/**
 * Builds a deterministic OIDC authorization-code request from one exact issued login transaction.
 * It performs no I/O and is intentionally absent from buildApp, server configuration, and routes.
 */
export class StrictOidcAuthorizationRequestBuilder implements OidcAuthorizationRequestBuilder {
  readonly #issuer: string;
  readonly #authorizationEndpoint: string;
  readonly #clientId: string;
  readonly #redirectUri: string;
  readonly #scopes: readonly string[];
  readonly #clock: () => Date;

  constructor(
    configuration: OidcAuthorizationRequestConfiguration,
    options: OidcAuthorizationRequestBuilderOptions = {},
  ) {
    let issuer: string;
    let authorizationEndpoint: URL;
    let clientId: string;
    let redirectUri: string;
    let scopes: readonly string[];
    let clock: () => Date;
    try {
      if (
        typeof configuration !== "object" ||
        configuration === null ||
        typeof options !== "object" ||
        options === null
      ) {
        throw invalid();
      }
      issuer = configuration.issuer;
      const rawAuthorizationEndpoint = configuration.authorizationEndpoint;
      clientId = configuration.clientId;
      redirectUri = configuration.redirectUri;
      const canonical = canonicalScopes(configuration.scopes);
      clock = options.clock ?? (() => new Date());
      if (
        !validExactHttpsUrl(issuer, false) ||
        !validExactHttpsUrl(rawAuthorizationEndpoint, true) ||
        !validClientId(clientId) ||
        !validExactHttpsUrl(redirectUri, true) ||
        canonical === null ||
        typeof clock !== "function"
      ) {
        throw invalid();
      }
      authorizationEndpoint = new URL(rawAuthorizationEndpoint);
      if (!validAuthorizationEndpointQuery(authorizationEndpoint)) throw invalid();
      scopes = canonical;
    } catch {
      throw invalid();
    }
    this.#issuer = issuer;
    this.#authorizationEndpoint = authorizationEndpoint.href;
    this.#clientId = clientId;
    this.#redirectUri = redirectUri;
    this.#scopes = scopes;
    this.#clock = clock;
  }

  build(transaction: IssuedHostedLoginTransaction): OidcAuthorizationRequest {
    try {
      const snapshot = issuedTransactionSnapshot(transaction);
      const now = this.#clock();
      const nowMilliseconds = now instanceof Date ? now.getTime() : Number.NaN;
      if (
        snapshot === null ||
        !Number.isFinite(nowMilliseconds) ||
        nowMilliseconds >= snapshot.expiresAtMilliseconds ||
        snapshot.issuer !== this.#issuer ||
        snapshot.clientId !== this.#clientId ||
        snapshot.redirectUri !== this.#redirectUri
      ) {
        throw invalid();
      }

      const request = new URL(this.#authorizationEndpoint);
      request.searchParams.set("response_type", "code");
      request.searchParams.set("client_id", this.#clientId);
      request.searchParams.set("redirect_uri", this.#redirectUri);
      request.searchParams.set("scope", this.#scopes.join(" "));
      request.searchParams.set("state", snapshot.state);
      request.searchParams.set("nonce", snapshot.nonce);
      request.searchParams.set("code_challenge", snapshot.pkceChallenge);
      request.searchParams.set("code_challenge_method", HOSTED_LOGIN_PKCE_METHOD);
      const url = request.href;
      if (Buffer.byteLength(url, "utf8") > MAXIMUM_AUTHORIZATION_REQUEST_URL_BYTES) {
        throw invalid();
      }
      return Object.freeze({ url });
    } catch {
      throw invalid();
    }
  }
}
