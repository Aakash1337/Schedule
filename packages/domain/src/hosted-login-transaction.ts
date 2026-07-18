import { invariant } from "./errors.js";
import { hostedLoginTransactionId, type HostedLoginTransactionId } from "./ids.js";

export const HOSTED_LOGIN_PKCE_METHOD = "S256" as const;
export const MINIMUM_HOSTED_LOGIN_TTL_SECONDS = 60;
export const MAXIMUM_HOSTED_LOGIN_TTL_SECONDS = 15 * 60;

const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const OPAQUE_VALUE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const MAXIMUM_PROTECTED_PKCE_BYTES = 2_048;
const MAXIMUM_ISSUER_LENGTH = 2_048;
const MAXIMUM_CLIENT_ID_LENGTH = 512;
const MAXIMUM_REDIRECT_URI_LENGTH = 2_048;
const MAXIMUM_RETURN_TO_PATH_LENGTH = 2_048;

export interface HostedLoginTransaction {
  readonly id: HostedLoginTransactionId;
  /** HMAC-SHA-256 digest. The authorization state value must never be persisted. */
  readonly stateDigest: string;
  /** HMAC-SHA-256 digest. The browser-binding bearer value must never be persisted. */
  readonly browserBindingDigest: string;
  /** Exact configured provider issuer bytes. */
  readonly issuer: string;
  /** Exact configured OIDC client identifier bytes. */
  readonly clientId: string;
  /** Exact redirect URI used for the authorization request and code exchange. */
  readonly redirectUri: string;
  /** Local relative destination restored only after successful authentication. */
  readonly returnToPath: string;
  /** High-entropy OIDC nonce that a future verifier must match exactly. */
  readonly nonce: string;
  readonly pkceChallenge: string;
  readonly pkceMethod: typeof HOSTED_LOGIN_PKCE_METHOD;
  /** Authenticated ciphertext; the plaintext PKCE verifier must never be persisted. */
  readonly protectedPkceVerifier: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
  readonly version: number;
}

function validInstant(value: Date, code: string, message: string): Date {
  invariant(Number.isFinite(value.getTime()), code, message);
  return new Date(value);
}

function containsAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function requireExactHttpsUrl(
  value: string,
  kind: "issuer" | "redirect_uri",
  maximumLength: number,
): void {
  invariant(
    value.length > 0 && value.length <= maximumLength && value === value.trim(),
    `hosted_login_transaction.${kind}_invalid`,
    `A valid hosted login ${kind.replace("_", " ")} is required.`,
  );
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    invariant(
      false,
      `hosted_login_transaction.${kind}_invalid`,
      `A valid hosted login ${kind.replace("_", " ")} is required.`,
    );
    return;
  }
  invariant(
    parsed.protocol === "https:" &&
      parsed.hostname.length > 0 &&
      parsed.username.length === 0 &&
      parsed.password.length === 0 &&
      parsed.hash.length === 0 &&
      (kind !== "issuer" || parsed.search.length === 0),
    `hosted_login_transaction.${kind}_invalid`,
    `A valid hosted login ${kind.replace("_", " ")} is required.`,
  );
}

function requireReturnToPath(value: string): void {
  invariant(
    value.length > 0 &&
      value.length <= MAXIMUM_RETURN_TO_PATH_LENGTH &&
      value.startsWith("/") &&
      !value.startsWith("//") &&
      !value.includes("\\") &&
      !value.includes("#") &&
      !containsAsciiControl(value),
    "hosted_login_transaction.return_to_invalid",
    "A hosted login return path must be a bounded local path.",
  );
}

export function createHostedLoginTransaction(input: {
  readonly id?: HostedLoginTransactionId;
  readonly stateDigest: string;
  readonly browserBindingDigest: string;
  readonly issuer: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly returnToPath: string;
  readonly nonce: string;
  readonly pkceChallenge: string;
  readonly protectedPkceVerifier: string;
  readonly ttlSeconds: number;
  readonly now?: Date;
}): HostedLoginTransaction {
  const createdAt = validInstant(
    input.now ?? new Date(),
    "hosted_login_transaction.timestamp_invalid",
    "A valid hosted login transaction timestamp is required.",
  );
  invariant(
    DIGEST_PATTERN.test(input.stateDigest),
    "hosted_login_transaction.state_digest_invalid",
    "A hosted login transaction requires a lowercase state HMAC digest.",
  );
  invariant(
    DIGEST_PATTERN.test(input.browserBindingDigest),
    "hosted_login_transaction.browser_binding_digest_invalid",
    "A hosted login transaction requires a lowercase browser-binding HMAC digest.",
  );
  requireExactHttpsUrl(input.issuer, "issuer", MAXIMUM_ISSUER_LENGTH);
  invariant(
    input.clientId.length > 0 &&
      input.clientId.length <= MAXIMUM_CLIENT_ID_LENGTH &&
      input.clientId === input.clientId.trim(),
    "hosted_login_transaction.client_id_invalid",
    "A valid hosted login client identifier is required.",
  );
  requireExactHttpsUrl(input.redirectUri, "redirect_uri", MAXIMUM_REDIRECT_URI_LENGTH);
  requireReturnToPath(input.returnToPath);
  invariant(
    OPAQUE_VALUE_PATTERN.test(input.nonce),
    "hosted_login_transaction.nonce_invalid",
    "A hosted login transaction requires a 256-bit nonce.",
  );
  invariant(
    OPAQUE_VALUE_PATTERN.test(input.pkceChallenge),
    "hosted_login_transaction.pkce_challenge_invalid",
    "A hosted login transaction requires a SHA-256 PKCE challenge.",
  );
  invariant(
    input.protectedPkceVerifier.length > 0 &&
      Buffer.byteLength(input.protectedPkceVerifier, "utf8") <= MAXIMUM_PROTECTED_PKCE_BYTES &&
      !containsAsciiControl(input.protectedPkceVerifier),
    "hosted_login_transaction.protected_pkce_invalid",
    "A hosted login transaction requires a bounded protected PKCE verifier.",
  );
  invariant(
    Number.isSafeInteger(input.ttlSeconds) &&
      input.ttlSeconds >= MINIMUM_HOSTED_LOGIN_TTL_SECONDS &&
      input.ttlSeconds <= MAXIMUM_HOSTED_LOGIN_TTL_SECONDS,
    "hosted_login_transaction.ttl_invalid",
    "A hosted login transaction TTL must be between 60 and 900 seconds.",
  );
  return {
    id: input.id ?? hostedLoginTransactionId(),
    stateDigest: input.stateDigest,
    browserBindingDigest: input.browserBindingDigest,
    issuer: input.issuer,
    clientId: input.clientId,
    redirectUri: input.redirectUri,
    returnToPath: input.returnToPath,
    nonce: input.nonce,
    pkceChallenge: input.pkceChallenge,
    pkceMethod: HOSTED_LOGIN_PKCE_METHOD,
    protectedPkceVerifier: input.protectedPkceVerifier,
    createdAt,
    expiresAt: new Date(createdAt.getTime() + input.ttlSeconds * 1_000),
    consumedAt: null,
    version: 1,
  };
}

export function hostedLoginTransactionIsUsable(
  transaction: HostedLoginTransaction,
  now: Date,
): boolean {
  const instant = validInstant(
    now,
    "hosted_login_transaction.timestamp_invalid",
    "A valid hosted login transaction timestamp is required.",
  );
  return transaction.consumedAt === null && instant.getTime() < transaction.expiresAt.getTime();
}

export function consumeHostedLoginTransaction(
  transaction: HostedLoginTransaction,
  now: Date,
): HostedLoginTransaction {
  const consumedAt = validInstant(
    now,
    "hosted_login_transaction.timestamp_invalid",
    "A valid hosted login transaction timestamp is required.",
  );
  invariant(
    consumedAt.getTime() >= transaction.createdAt.getTime() &&
      hostedLoginTransactionIsUsable(transaction, consumedAt),
    "hosted_login_transaction.unavailable",
    "The hosted login transaction is unavailable.",
  );
  return {
    ...transaction,
    consumedAt,
    version: transaction.version + 1,
  };
}
