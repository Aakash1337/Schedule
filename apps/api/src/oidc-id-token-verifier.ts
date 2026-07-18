import { createHash, timingSafeEqual } from "node:crypto";

import {
  MAXIMUM_HOSTED_LOGIN_TTL_SECONDS,
  MAX_EXTERNAL_IDENTITY_KEY_BYTES,
} from "@schedule/domain";
import {
  decodeProtectedHeader,
  errors,
  jwtVerify,
  type JWTVerifyGetKey,
  type JWTPayload,
} from "jose";

import type { VerifiedHostedIdentity } from "./hosted-auth-lifecycle.js";

const MAXIMUM_ID_TOKEN_BYTES = 16 * 1_024;
const MAXIMUM_ISSUER_LENGTH = 2_048;
const MAXIMUM_CLIENT_ID_LENGTH = 512;
const MAXIMUM_KEY_ID_BYTES = 256;
const MAXIMUM_CLOCK_TOLERANCE_SECONDS = 120;
const MINIMUM_KEY_RESOLUTION_TIMEOUT_MILLISECONDS = 100;
const MAXIMUM_KEY_RESOLUTION_TIMEOUT_MILLISECONDS = 10_000;
const OPAQUE_NONCE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const COMPACT_JWS_PATTERN = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u;
const PRINTABLE_ASCII_SUBJECT_PATTERN = /^[\x20-\x7e]{1,255}$/u;

export const OIDC_ID_TOKEN_ALGORITHMS = Object.freeze([
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
  "EdDSA",
] as const);

export type OidcIdTokenAlgorithm = (typeof OIDC_ID_TOKEN_ALGORITHMS)[number];

const SUPPORTED_ALGORITHMS = new Set<string>(OIDC_ID_TOKEN_ALGORITHMS);

export interface OidcIdTokenVerificationInput {
  /** Compact, signed ID token returned by the configured provider. */
  readonly idToken: string;
  /** Exact issuer stored in the consumed hosted login transaction. */
  readonly issuer: string;
  /** Exact client identifier stored in the consumed hosted login transaction. */
  readonly clientId: string;
  /** Exact nonce stored in the consumed hosted login transaction. */
  readonly expectedNonce: string;
}

export interface JoseOidcIdTokenVerifierOptions {
  /** Provider-scoped signing-key resolver, such as a pinned local or remote JWKS resolver. */
  readonly keyResolver: JWTVerifyGetKey;
  /** Explicit asymmetric provider allowlist. Symmetric and unsecured JWT algorithms are forbidden. */
  readonly algorithms: readonly OidcIdTokenAlgorithm[];
  readonly clock?: () => Date;
  readonly clockToleranceSeconds?: number;
  readonly maxTokenAgeSeconds?: number;
  /** Hard response bound around even a misconfigured or stalled signing-key resolver. */
  readonly keyResolutionTimeoutMilliseconds?: number;
}

/**
 * Stable operational failure. The error intentionally contains no token, claims, key material, or
 * provider exception text so callers can safely map it to a generic 503 response.
 */
export class OidcIdTokenVerificationUnavailableError extends Error {
  readonly code = "hosted_oidc.verification_unavailable";

  constructor() {
    super("Hosted OIDC identity verification is temporarily unavailable.");
    this.name = "OidcIdTokenVerificationUnavailableError";
  }
}

function unavailable(): OidcIdTokenVerificationUnavailableError {
  return new OidcIdTokenVerificationUnavailableError();
}

function containsAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function validIssuer(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAXIMUM_ISSUER_LENGTH ||
    value !== value.trim()
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
      parsed.search.length === 0 &&
      parsed.hash.length === 0
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

function validPolicyInteger(value: number, minimum: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function validCompactIdToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAXIMUM_ID_TOKEN_BYTES &&
    COMPACT_JWS_PATTERN.test(value)
  );
}

function validKeyId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value === value.trim() &&
    Buffer.byteLength(value, "utf8") <= MAXIMUM_KEY_ID_BYTES &&
    !containsAsciiControl(value)
  );
}

function trustedProtectedHeader(
  header: ReturnType<typeof decodeProtectedHeader>,
  algorithms: ReadonlySet<string>,
): boolean {
  const typ = header.typ;
  return (
    typeof header.alg === "string" &&
    algorithms.has(header.alg) &&
    validKeyId(header.kid) &&
    header.jku === undefined &&
    header.x5u === undefined &&
    header.jwk === undefined &&
    header.x5c === undefined &&
    header.crit === undefined &&
    header.b64 === undefined &&
    (typ === undefined ||
      (typeof typ === "string" &&
        (typ.toLowerCase() === "jwt" || typ.toLowerCase() === "application/jwt")))
  );
}

function fixedLengthDigest(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function exactNonceMatches(actual: unknown, expected: string): boolean {
  return (
    typeof actual === "string" &&
    actual.length === expected.length &&
    timingSafeEqual(fixedLengthDigest(actual), fixedLengthDigest(expected))
  );
}

function validNumericDate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function validAudienceAndAuthorizedParty(payload: JWTPayload, clientId: string): boolean {
  const audience = payload.aud;
  const audiences = typeof audience === "string" ? [audience] : audience;
  if (
    !Array.isArray(audiences) ||
    audiences.length === 0 ||
    audiences.some(
      (value) =>
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > MAXIMUM_CLIENT_ID_LENGTH ||
        containsAsciiControl(value),
    ) ||
    new Set(audiences).size !== audiences.length
  ) {
    return false;
  }

  const authorizedParty = payload.azp;
  if (authorizedParty !== undefined && authorizedParty !== clientId) return false;
  return audiences.length === 1 || authorizedParty === clientId;
}

function validClaims(
  payload: JWTPayload,
  input: OidcIdTokenVerificationInput,
  currentDate: Date,
  maxTokenAgeSeconds: number,
): boolean {
  const subject = payload.sub;
  const currentSeconds = Math.floor(currentDate.getTime() / 1_000);
  if (
    payload.iss !== input.issuer ||
    typeof subject !== "string" ||
    !PRINTABLE_ASCII_SUBJECT_PATTERN.test(subject) ||
    !validAudienceAndAuthorizedParty(payload, input.clientId) ||
    !exactNonceMatches(payload.nonce, input.expectedNonce) ||
    !validNumericDate(payload.exp) ||
    !validNumericDate(payload.iat) ||
    currentSeconds - payload.iat > maxTokenAgeSeconds ||
    payload.exp <= payload.iat ||
    (payload.nbf !== undefined && (!validNumericDate(payload.nbf) || payload.nbf > payload.exp))
  ) {
    return false;
  }

  return (
    Buffer.byteLength(input.issuer, "utf8") + Buffer.byteLength(subject, "utf8") <=
    MAX_EXTERNAL_IDENTITY_KEY_BYTES
  );
}

function credentialJoseFailure(error: unknown): boolean {
  return (
    error instanceof errors.JWTClaimValidationFailed ||
    error instanceof errors.JWTExpired ||
    error instanceof errors.JOSEAlgNotAllowed ||
    error instanceof errors.JWSInvalid ||
    error instanceof errors.JWTInvalid ||
    error instanceof errors.JWSSignatureVerificationFailed ||
    error instanceof errors.JWKSNoMatchingKey ||
    error instanceof errors.JWKSMultipleMatchingKeys
  );
}

function trustedCurrentDate(clock: () => Date): Date {
  let value: Date;
  try {
    value = clock();
  } catch {
    throw unavailable();
  }
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw unavailable();
  return new Date(value.getTime());
}

/**
 * Verifies an OIDC ID token against exact transaction metadata. The dormant callback accepts this
 * adapter's contract, but buildApp and the production server intentionally do not construct or
 * register it with a provider-scoped key resolver.
 */
export class JoseOidcIdTokenVerifier {
  readonly #keyResolver: JWTVerifyGetKey;
  readonly #algorithms: readonly OidcIdTokenAlgorithm[];
  readonly #algorithmSet: ReadonlySet<string>;
  readonly #clock: () => Date;
  readonly #clockToleranceSeconds: number;
  readonly #maxTokenAgeSeconds: number;
  readonly #keyResolutionTimeoutMilliseconds: number;

  constructor(options: JoseOidcIdTokenVerifierOptions) {
    if (typeof options !== "object" || options === null || !Array.isArray(options.algorithms)) {
      throw unavailable();
    }
    const algorithms = [...options.algorithms];
    const clockToleranceSeconds = options.clockToleranceSeconds ?? 60;
    const maxTokenAgeSeconds = options.maxTokenAgeSeconds ?? MAXIMUM_HOSTED_LOGIN_TTL_SECONDS;
    const keyResolutionTimeoutMilliseconds = options.keyResolutionTimeoutMilliseconds ?? 5_000;
    if (
      typeof options.keyResolver !== "function" ||
      algorithms.length === 0 ||
      algorithms.length > OIDC_ID_TOKEN_ALGORITHMS.length ||
      algorithms.some((algorithm) => !SUPPORTED_ALGORITHMS.has(algorithm)) ||
      new Set(algorithms).size !== algorithms.length ||
      !validPolicyInteger(clockToleranceSeconds, 0, MAXIMUM_CLOCK_TOLERANCE_SECONDS) ||
      !validPolicyInteger(maxTokenAgeSeconds, 1, MAXIMUM_HOSTED_LOGIN_TTL_SECONDS) ||
      !validPolicyInteger(
        keyResolutionTimeoutMilliseconds,
        MINIMUM_KEY_RESOLUTION_TIMEOUT_MILLISECONDS,
        MAXIMUM_KEY_RESOLUTION_TIMEOUT_MILLISECONDS,
      ) ||
      (options.clock !== undefined && typeof options.clock !== "function")
    ) {
      throw unavailable();
    }

    this.#keyResolver = options.keyResolver;
    this.#algorithms = Object.freeze(algorithms);
    this.#algorithmSet = new Set(algorithms);
    this.#clock = options.clock ?? (() => new Date());
    this.#clockToleranceSeconds = clockToleranceSeconds;
    this.#maxTokenAgeSeconds = maxTokenAgeSeconds;
    this.#keyResolutionTimeoutMilliseconds = keyResolutionTimeoutMilliseconds;
  }

  async verify(input: OidcIdTokenVerificationInput): Promise<VerifiedHostedIdentity | null> {
    if (
      typeof input !== "object" ||
      input === null ||
      !validIssuer(input.issuer) ||
      !validClientId(input.clientId) ||
      typeof input.expectedNonce !== "string" ||
      !OPAQUE_NONCE_PATTERN.test(input.expectedNonce)
    ) {
      throw unavailable();
    }
    if (!validCompactIdToken(input.idToken)) return null;

    let decodedHeader: ReturnType<typeof decodeProtectedHeader>;
    try {
      decodedHeader = decodeProtectedHeader(input.idToken);
    } catch {
      return null;
    }
    if (!trustedProtectedHeader(decodedHeader, this.#algorithmSet)) return null;

    const currentDate = trustedCurrentDate(this.#clock);

    const guardedKeyResolver: JWTVerifyGetKey = async (protectedHeader, token) => {
      let timeout: NodeJS.Timeout | undefined;
      try {
        const resolution = Promise.resolve().then(() => this.#keyResolver(protectedHeader, token));
        const deadline = new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(unavailable()), this.#keyResolutionTimeoutMilliseconds);
          timeout.unref();
        });
        const key = await Promise.race([resolution, deadline]);
        const refreshed = trustedCurrentDate(this.#clock);
        currentDate.setTime(Math.max(currentDate.getTime(), refreshed.getTime()));
        return key;
      } catch (error) {
        if (
          error instanceof errors.JWKSNoMatchingKey ||
          error instanceof errors.JWKSMultipleMatchingKeys
        ) {
          throw error;
        }
        throw unavailable();
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
    };

    try {
      const { payload, protectedHeader } = await jwtVerify(input.idToken, guardedKeyResolver, {
        algorithms: [...this.#algorithms],
        audience: input.clientId,
        issuer: input.issuer,
        requiredClaims: ["iss", "sub", "aud", "exp", "iat", "nonce"],
        currentDate,
        clockTolerance: this.#clockToleranceSeconds,
        maxTokenAge: this.#maxTokenAgeSeconds,
      });
      if (
        !trustedProtectedHeader(protectedHeader, this.#algorithmSet) ||
        !validClaims(payload, input, currentDate, this.#maxTokenAgeSeconds)
      ) {
        return null;
      }
      return Object.freeze({ issuer: input.issuer, subject: payload.sub! });
    } catch (error) {
      if (error instanceof OidcIdTokenVerificationUnavailableError) throw error;
      if (credentialJoseFailure(error)) return null;
      throw unavailable();
    }
  }
}
