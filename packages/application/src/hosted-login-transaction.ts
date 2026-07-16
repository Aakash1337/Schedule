import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import {
  DomainError,
  consumeHostedLoginTransaction,
  createHostedLoginTransaction,
  hostedLoginTransactionId,
  hostedLoginTransactionIsUsable,
  type HostedLoginTransaction,
  type HostedLoginTransactionId,
} from "@schedule/domain";

import type { UnitOfWorkOptions } from "./ports.js";

const LOGIN_SECRET_VERSION = "schedule.hosted-login-secret/v1";
const PKCE_PROTECTION_VERSION = "v1";
const PKCE_AAD_VERSION = "schedule.hosted-login-pkce/v1";
const OPAQUE_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/u;
const DUMMY_SECRET = "A".repeat(43);
const DUMMY_DIGEST = "0".repeat(64);
const MAXIMUM_CLEANUP_BATCH = 1_000;
const MAXIMUM_PKCE_KEYS = 16;

function fixedOpaqueEqual(left: string, right: string): boolean {
  const leftValid = OPAQUE_SECRET_PATTERN.test(left);
  const rightValid = OPAQUE_SECRET_PATTERN.test(right);
  const leftBytes = Buffer.from(leftValid ? left : DUMMY_SECRET, "ascii");
  const rightBytes = Buffer.from(rightValid ? right : DUMMY_SECRET, "ascii");
  return timingSafeEqual(leftBytes, rightBytes) && leftValid && rightValid;
}

function fixedDigestEqual(left: string, right: string): boolean {
  const leftValid = DIGEST_PATTERN.test(left);
  const rightValid = DIGEST_PATTERN.test(right);
  const leftBytes = Buffer.from(leftValid ? left : DUMMY_DIGEST, "hex");
  const rightBytes = Buffer.from(rightValid ? right : DUMMY_DIGEST, "hex");
  return timingSafeEqual(leftBytes, rightBytes) && leftValid && rightValid;
}

export interface HostedLoginTransactionRepository {
  findByStateDigestForUpdate(stateDigest: string): Promise<HostedLoginTransaction | null>;
  insert(transaction: HostedLoginTransaction): Promise<void>;
  save(transaction: HostedLoginTransaction, expectedVersion: number): Promise<void>;
  deleteExpiredBefore(cutoff: Date, limit: number): Promise<number>;
}

export interface HostedLoginTransactionTimeRepository {
  /** PostgreSQL time is authoritative for cross-process expiry and consumption decisions. */
  current(): Promise<Date>;
}

export interface HostedLoginTransactionContext {
  readonly transactions: HostedLoginTransactionRepository;
  readonly time: HostedLoginTransactionTimeRepository;
}

export interface HostedLoginTransactionUnitOfWork {
  run<Result>(
    operation: (context: HostedLoginTransactionContext) => Promise<Result>,
    options?: UnitOfWorkOptions,
  ): Promise<Result>;
}

export interface HostedLoginSecretMaterial {
  readonly state: string;
  readonly stateDigest: string;
  readonly browserBinding: string;
  readonly browserBindingDigest: string;
  readonly nonce: string;
  readonly pkceVerifier: string;
  readonly pkceChallenge: string;
}

export interface HostedLoginStateLookup {
  readonly digest: string;
  readonly wellFormed: boolean;
}

export interface HostedLoginTransactionCodec {
  issue(): HostedLoginSecretMaterial;
  stateDigestForLookup(state: string): HostedLoginStateLookup;
  verifyBrowserBinding(browserBinding: string, expectedDigest: string): boolean;
  pkceChallenge(pkceVerifier: string): string;
}

/** Issues independent 256-bit values and persists only purpose-separated peppered HMAC digests. */
export class HmacHostedLoginTransactionCodec implements HostedLoginTransactionCodec {
  private readonly pepper: Buffer;

  constructor(pepper: string) {
    if (typeof pepper !== "string" || Buffer.byteLength(pepper, "utf8") < 32) {
      throw new TypeError("The hosted login transaction pepper must be at least 32 bytes.");
    }
    this.pepper = Buffer.from(pepper, "utf8");
  }

  private digest(purpose: "state" | "browser-binding", secret: string): string {
    return createHmac("sha256", this.pepper)
      .update(LOGIN_SECRET_VERSION, "utf8")
      .update("\0", "utf8")
      .update(purpose, "utf8")
      .update("\0", "utf8")
      .update(secret, "utf8")
      .digest("hex");
  }

  issue(): HostedLoginSecretMaterial {
    const state = randomBytes(32).toString("base64url");
    const browserBinding = randomBytes(32).toString("base64url");
    const nonce = randomBytes(32).toString("base64url");
    const pkceVerifier = randomBytes(32).toString("base64url");
    return Object.freeze({
      state,
      stateDigest: this.digest("state", state),
      browserBinding,
      browserBindingDigest: this.digest("browser-binding", browserBinding),
      nonce,
      pkceVerifier,
      pkceChallenge: this.pkceChallenge(pkceVerifier),
    });
  }

  stateDigestForLookup(state: string): HostedLoginStateLookup {
    const wellFormed = OPAQUE_SECRET_PATTERN.test(state);
    return {
      digest: this.digest("state", wellFormed ? state : DUMMY_SECRET),
      wellFormed,
    };
  }

  verifyBrowserBinding(browserBinding: string, expectedDigest: string): boolean {
    const wellFormed =
      OPAQUE_SECRET_PATTERN.test(browserBinding) && DIGEST_PATTERN.test(expectedDigest);
    const actual = Buffer.from(
      this.digest(
        "browser-binding",
        OPAQUE_SECRET_PATTERN.test(browserBinding) ? browserBinding : DUMMY_SECRET,
      ),
      "hex",
    );
    const expected = Buffer.from(
      DIGEST_PATTERN.test(expectedDigest) ? expectedDigest : DUMMY_DIGEST,
      "hex",
    );
    return timingSafeEqual(actual, expected) && wellFormed;
  }

  pkceChallenge(pkceVerifier: string): string {
    const verifier = OPAQUE_SECRET_PATTERN.test(pkceVerifier) ? pkceVerifier : DUMMY_SECRET;
    return createHash("sha256").update(verifier, "ascii").digest("base64url");
  }
}

export interface HostedLoginPkceProtector {
  protect(transactionId: HostedLoginTransactionId, pkceVerifier: string): string;
  unprotect(transactionId: HostedLoginTransactionId, protectedPkceVerifier: string): string;
}

export interface HostedLoginPkceKeyRing {
  readonly primaryKeyId: string;
  /** Canonical base64url-encoded 256-bit AES keys, keyed by a non-secret rotation identifier. */
  readonly keys: Readonly<Record<string, string>>;
}

function pkceProtectionFailure(): DomainError {
  return new DomainError(
    "hosted_login_transaction.pkce_protection_failed",
    "The hosted login transaction could not be resumed.",
  );
}

function decodeCanonicalBase64Url(value: string, expectedBytes?: number): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) return null;
  return expectedBytes === undefined || decoded.length === expectedBytes ? decoded : null;
}

function pkceAdditionalData(transactionId: HostedLoginTransactionId, keyId: string): Buffer {
  return Buffer.from(`${PKCE_AAD_VERSION}\0${keyId}\0${transactionId}`, "utf8");
}

/** Protects recoverable PKCE verifiers with transaction-bound AES-256-GCM and key rotation IDs. */
export class AesGcmHostedLoginPkceProtector implements HostedLoginPkceProtector {
  private readonly primaryKeyId: string;
  private readonly keys: ReadonlyMap<string, Buffer>;

  constructor(keyRing: HostedLoginPkceKeyRing) {
    if (!KEY_ID_PATTERN.test(keyRing.primaryKeyId)) {
      throw new TypeError("The primary hosted login PKCE key identifier is invalid.");
    }
    if (
      Object.keys(keyRing.keys).length < 1 ||
      Object.keys(keyRing.keys).length > MAXIMUM_PKCE_KEYS
    ) {
      throw new TypeError("The hosted login PKCE key ring must contain between 1 and 16 keys.");
    }
    const keys = new Map<string, Buffer>();
    for (const [keyId, encoded] of Object.entries(keyRing.keys)) {
      const key = KEY_ID_PATTERN.test(keyId) ? decodeCanonicalBase64Url(encoded, 32) : null;
      if (key === null) throw new TypeError("A hosted login PKCE key is invalid.");
      keys.set(keyId, Buffer.from(key));
    }
    if (!keys.has(keyRing.primaryKeyId)) {
      throw new TypeError("The primary hosted login PKCE key is unavailable.");
    }
    this.primaryKeyId = keyRing.primaryKeyId;
    this.keys = keys;
  }

  protect(transactionId: HostedLoginTransactionId, pkceVerifier: string): string {
    if (!OPAQUE_SECRET_PATTERN.test(pkceVerifier)) throw pkceProtectionFailure();
    const key = this.keys.get(this.primaryKeyId);
    if (key === undefined) throw pkceProtectionFailure();
    try {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(pkceAdditionalData(transactionId, this.primaryKeyId));
      const ciphertext = Buffer.concat([cipher.update(pkceVerifier, "ascii"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [
        PKCE_PROTECTION_VERSION,
        this.primaryKeyId,
        iv.toString("base64url"),
        ciphertext.toString("base64url"),
        tag.toString("base64url"),
      ].join(".");
    } catch {
      throw pkceProtectionFailure();
    }
  }

  unprotect(transactionId: HostedLoginTransactionId, protectedPkceVerifier: string): string {
    try {
      const parts = protectedPkceVerifier.split(".");
      if (parts.length !== 5 || parts[0] !== PKCE_PROTECTION_VERSION) {
        throw pkceProtectionFailure();
      }
      const [, keyId, encodedIv, encodedCiphertext, encodedTag] = parts;
      const resolvedKeyId = keyId ?? "";
      const key = KEY_ID_PATTERN.test(resolvedKeyId) ? this.keys.get(resolvedKeyId) : undefined;
      const iv = decodeCanonicalBase64Url(encodedIv ?? "", 12);
      const ciphertext = decodeCanonicalBase64Url(encodedCiphertext ?? "", 43);
      const tag = decodeCanonicalBase64Url(encodedTag ?? "", 16);
      if (key === undefined || iv === null || ciphertext === null || tag === null) {
        throw pkceProtectionFailure();
      }
      const decipher = createDecipheriv("aes-256-gcm", key, iv);
      decipher.setAAD(pkceAdditionalData(transactionId, resolvedKeyId));
      decipher.setAuthTag(tag);
      const verifier = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
        "ascii",
      );
      if (!OPAQUE_SECRET_PATTERN.test(verifier)) throw pkceProtectionFailure();
      return verifier;
    } catch {
      throw pkceProtectionFailure();
    }
  }
}

function assertIssuedMaterial(
  material: HostedLoginSecretMaterial,
  codec: HostedLoginTransactionCodec,
): void {
  const stateLookup = codec.stateDigestForLookup(material.state);
  if (
    !OPAQUE_SECRET_PATTERN.test(material.state) ||
    !DIGEST_PATTERN.test(material.stateDigest) ||
    !OPAQUE_SECRET_PATTERN.test(material.browserBinding) ||
    !DIGEST_PATTERN.test(material.browserBindingDigest) ||
    !OPAQUE_SECRET_PATTERN.test(material.nonce) ||
    !OPAQUE_SECRET_PATTERN.test(material.pkceVerifier) ||
    !OPAQUE_SECRET_PATTERN.test(material.pkceChallenge) ||
    !stateLookup.wellFormed ||
    !fixedDigestEqual(stateLookup.digest, material.stateDigest) ||
    !codec.verifyBrowserBinding(material.browserBinding, material.browserBindingDigest) ||
    !fixedOpaqueEqual(codec.pkceChallenge(material.pkceVerifier), material.pkceChallenge)
  ) {
    throw new DomainError(
      "hosted_login_transaction.secret_material_invalid",
      "The hosted login transaction could not be created.",
    );
  }
}

export interface IssuedHostedLoginTransaction {
  /** Exact provider binding copied from the validated persisted transaction. */
  readonly issuer: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly browserBinding: string;
  readonly nonce: string;
  readonly pkceChallenge: string;
  readonly pkceMethod: "S256";
  readonly expiresAt: Date;
}

export class StartHostedLoginTransaction {
  constructor(
    private readonly unitOfWork: HostedLoginTransactionUnitOfWork,
    private readonly codec: HostedLoginTransactionCodec,
    private readonly pkceProtector: HostedLoginPkceProtector,
  ) {}

  execute(input: {
    readonly issuer: string;
    readonly clientId: string;
    readonly redirectUri: string;
    readonly returnToPath: string;
    readonly ttlSeconds: number;
  }): Promise<IssuedHostedLoginTransaction> {
    return this.unitOfWork.run(async ({ transactions, time }) => {
      const createdAt = await time.current();
      const id = hostedLoginTransactionId();
      const material = this.codec.issue();
      assertIssuedMaterial(material, this.codec);
      const transaction = createHostedLoginTransaction({
        id,
        stateDigest: material.stateDigest,
        browserBindingDigest: material.browserBindingDigest,
        issuer: input.issuer,
        clientId: input.clientId,
        redirectUri: input.redirectUri,
        returnToPath: input.returnToPath,
        nonce: material.nonce,
        pkceChallenge: material.pkceChallenge,
        protectedPkceVerifier: this.pkceProtector.protect(id, material.pkceVerifier),
        ttlSeconds: input.ttlSeconds,
        now: createdAt,
      });
      await transactions.insert(transaction);
      return Object.freeze({
        issuer: transaction.issuer,
        clientId: transaction.clientId,
        redirectUri: transaction.redirectUri,
        state: material.state,
        browserBinding: material.browserBinding,
        nonce: material.nonce,
        pkceChallenge: material.pkceChallenge,
        pkceMethod: transaction.pkceMethod,
        expiresAt: new Date(transaction.expiresAt),
      });
    });
  }
}

export interface ConsumedHostedLoginTransaction {
  readonly id: HostedLoginTransactionId;
  readonly issuer: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly returnToPath: string;
  readonly expectedNonce: string;
  readonly pkceVerifier: string;
  readonly consumedAt: Date;
}

export class ConsumeHostedLoginTransaction {
  constructor(
    private readonly unitOfWork: HostedLoginTransactionUnitOfWork,
    private readonly codec: HostedLoginTransactionCodec,
    private readonly pkceProtector: HostedLoginPkceProtector,
  ) {}

  execute(input: {
    readonly state: string;
    readonly browserBinding: string;
  }): Promise<ConsumedHostedLoginTransaction | null> {
    const stateLookup = this.codec.stateDigestForLookup(input.state);
    return this.unitOfWork.run(async ({ transactions, time }) => {
      const transaction = await transactions.findByStateDigestForUpdate(stateLookup.digest);
      const browserBindingValid = this.codec.verifyBrowserBinding(
        input.browserBinding,
        transaction?.browserBindingDigest ?? DUMMY_DIGEST,
      );
      const consumedAt = await time.current();
      if (
        !stateLookup.wellFormed ||
        transaction === null ||
        !browserBindingValid ||
        !hostedLoginTransactionIsUsable(transaction, consumedAt)
      ) {
        return null;
      }

      const pkceVerifier = this.pkceProtector.unprotect(
        transaction.id,
        transaction.protectedPkceVerifier,
      );
      if (!fixedOpaqueEqual(this.codec.pkceChallenge(pkceVerifier), transaction.pkceChallenge)) {
        throw pkceProtectionFailure();
      }
      const consumed = consumeHostedLoginTransaction(transaction, consumedAt);
      await transactions.save(consumed, transaction.version);
      return Object.freeze({
        id: transaction.id,
        issuer: transaction.issuer,
        clientId: transaction.clientId,
        redirectUri: transaction.redirectUri,
        returnToPath: transaction.returnToPath,
        expectedNonce: transaction.nonce,
        pkceVerifier,
        consumedAt: new Date(consumedAt),
      });
    });
  }
}

export class PruneHostedLoginTransactions {
  constructor(private readonly unitOfWork: HostedLoginTransactionUnitOfWork) {}

  execute(limit: number): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAXIMUM_CLEANUP_BATCH) {
      throw new RangeError(
        "The hosted login transaction cleanup limit must be between 1 and 1000.",
      );
    }
    return this.unitOfWork.run(
      async ({ transactions, time }) =>
        transactions.deleteExpiredBefore(await time.current(), limit),
      { isolationLevel: "read_committed" },
    );
  }
}
