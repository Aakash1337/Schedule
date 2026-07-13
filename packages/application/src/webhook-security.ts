import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MASTER_KEY_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const SECRET_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const MAX_BODY_BYTES = 1_048_576;
const MAX_ENVELOPE_BYTES = MAX_BODY_BYTES + 128;
const MAX_UNIX_SECONDS = 253_402_300_799;
const ENVELOPE_VERSION = "v1";
const SECRET_AAD_LABEL = "schedule.webhook-secret/v1";

export type RandomBytes = (size: number) => Buffer;

export interface WebhookSecretEnvelope {
  readonly version: "v1";
  readonly masterKeyId: string;
  readonly nonce: string;
  readonly ciphertext: string;
  readonly tag: string;
}

export interface WebhookSecretContext {
  readonly workspaceId: string;
  readonly endpointId: string;
  readonly secretId: string;
  readonly masterKeyId: string;
}

export interface EncryptWebhookSigningSecretInput extends WebhookSecretContext {
  readonly signingSecret: string;
  readonly masterKey: string;
  /** Test-only injection. Production callers should omit this value. */
  readonly nonce?: string;
  readonly randomBytes?: RandomBytes;
}

export interface DecryptWebhookSigningSecretInput extends WebhookSecretContext {
  readonly envelope: WebhookSecretEnvelope;
  readonly masterKey: string;
}

export interface WebhookSignatureInput {
  readonly signingSecret: string;
  readonly deliveryId: string;
  readonly unixSeconds: number;
  readonly rawBody: string;
}

/** A deliberately non-diagnostic error: never includes sensitive input. */
export class WebhookSecurityError extends Error {
  constructor() {
    super("Invalid webhook security input.");
    this.name = "WebhookSecurityError";
  }
}

export function generateWebhookSigningSecret(random: RandomBytes = randomBytes): string {
  const bytes = random(SECRET_BYTES);
  if (!Buffer.isBuffer(bytes) || bytes.byteLength !== SECRET_BYTES) throw invalid();
  return bytes.toString("base64url");
}

export function encryptWebhookSigningSecret(
  input: EncryptWebhookSigningSecretInput,
): WebhookSecretEnvelope {
  const context = validateContext(input);
  const signingSecret = decode32(input.signingSecret);
  const masterKey = decode32(input.masterKey);
  const nonce =
    input.nonce === undefined
      ? randomNonce(input.randomBytes)
      : decodeExact(input.nonce, NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", masterKey, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(createAad(context));
  const ciphertext = Buffer.concat([cipher.update(signingSecret), cipher.final()]);
  const tag = cipher.getAuthTag();
  if (ciphertext.byteLength !== SECRET_BYTES || tag.byteLength !== TAG_BYTES) throw invalid();

  return {
    version: ENVELOPE_VERSION,
    masterKeyId: context.masterKeyId,
    nonce: nonce.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: tag.toString("base64url"),
  };
}

export function decryptWebhookSigningSecret(input: DecryptWebhookSigningSecretInput): string {
  const context = validateContext(input);
  const { envelope } = input;
  if (
    envelope.version !== ENVELOPE_VERSION ||
    envelope.masterKeyId !== context.masterKeyId ||
    Object.keys(envelope).length !== 5
  ) {
    throw invalid();
  }

  const masterKey = decode32(input.masterKey);
  const nonce = decodeExact(envelope.nonce, NONCE_BYTES);
  const ciphertext = decodeExact(envelope.ciphertext, SECRET_BYTES);
  const tag = decodeExact(envelope.tag, TAG_BYTES);
  try {
    const decipher = createDecipheriv("aes-256-gcm", masterKey, nonce, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(createAad(context));
    decipher.setAuthTag(tag);
    const secret = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    if (secret.byteLength !== SECRET_BYTES) throw invalid();
    return secret.toString("base64url");
  } catch {
    throw invalid();
  }
}

export function sha256WebhookBody(rawBody: string): string {
  return createHash("sha256").update(validateBody(rawBody)).digest("hex");
}

/** Signs the exact UTF-8 bytes of `v1.<deliveryId>.<unixSeconds>.<rawBody>`. */
export function signWebhookDelivery(input: WebhookSignatureInput): string {
  const secret = decode32(input.signingSecret);
  const envelope = createSignatureEnvelope(input.deliveryId, input.unixSeconds, input.rawBody);
  return createHmac("sha256", secret).update(envelope).digest("base64url");
}

/**
 * Constant-time signature comparison. Invalid public inputs simply do not
 * verify, which avoids turning a receiver into a parsing oracle.
 */
export function verifyWebhookSignature(
  input: WebhookSignatureInput & { readonly signature: string },
): boolean {
  try {
    const expected = Buffer.from(signWebhookDelivery(input), "base64url");
    const actual = decodeExact(input.signature, SECRET_BYTES);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function randomNonce(random: RandomBytes | undefined): Buffer {
  const bytes = (random ?? randomBytes)(NONCE_BYTES);
  if (!Buffer.isBuffer(bytes) || bytes.byteLength !== NONCE_BYTES) throw invalid();
  return bytes;
}

function validateContext(context: WebhookSecretContext): WebhookSecretContext {
  return {
    workspaceId: validateUuid(context.workspaceId),
    endpointId: validateUuid(context.endpointId),
    secretId: validateUuid(context.secretId),
    masterKeyId: validateMasterKeyId(context.masterKeyId),
  };
}

function validateUuid(value: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw invalid();
  return value;
}

function validateMasterKeyId(value: string): string {
  if (typeof value !== "string" || !MASTER_KEY_ID.test(value)) throw invalid();
  return value;
}

function decode32(value: string): Buffer {
  return decodeExact(value, SECRET_BYTES);
}

function decodeExact(value: string, byteLength: number): Buffer {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !BASE64URL.test(value) ||
    value.length > 256
  ) {
    throw invalid();
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength !== byteLength || decoded.toString("base64url") !== value) throw invalid();
  return decoded;
}

function createAad(context: WebhookSecretContext): Buffer {
  return Buffer.from(
    `${SECRET_AAD_LABEL}|${context.workspaceId}|${context.endpointId}|${context.secretId}|${context.masterKeyId}`,
    "utf8",
  );
}

function createSignatureEnvelope(deliveryId: string, unixSeconds: number, rawBody: string): Buffer {
  const id = validateUuid(deliveryId);
  if (!Number.isSafeInteger(unixSeconds) || unixSeconds < 0 || unixSeconds > MAX_UNIX_SECONDS)
    throw invalid();
  const body = validateBody(rawBody);
  const prefix = Buffer.from(`${ENVELOPE_VERSION}.${id}.${unixSeconds}.`, "utf8");
  if (prefix.byteLength + body.byteLength > MAX_ENVELOPE_BYTES) throw invalid();
  return Buffer.concat([prefix, body]);
}

function validateBody(rawBody: string): Buffer {
  if (typeof rawBody !== "string") throw invalid();
  const body = Buffer.from(rawBody, "utf8");
  if (body.byteLength > MAX_BODY_BYTES) throw invalid();
  return body;
}

function invalid(): WebhookSecurityError {
  return new WebhookSecurityError();
}
