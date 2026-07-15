import { invariant } from "./errors.js";
import {
  browserSessionId,
  externalIdentityId,
  userId,
  type BrowserSessionId,
  type ExternalIdentityId,
  type UserId,
  type WorkspaceId,
} from "./ids.js";

export const hostedUserStatuses = ["active", "disabled"] as const;
export type HostedUserStatus = (typeof hostedUserStatuses)[number];

export const browserSessionRevocationReasons = [
  "signed_out",
  "rotated",
  "user_disabled",
  "administrative",
] as const;
export type BrowserSessionRevocationReason = (typeof browserSessionRevocationReasons)[number];

export const workspaceMembershipStatuses = ["active", "revoked"] as const;
export type WorkspaceMembershipStatus = (typeof workspaceMembershipStatuses)[number];

export interface HostedUser {
  readonly id: UserId;
  readonly status: HostedUserStatus;
  readonly disabledAt: Date | null;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ExternalIdentity {
  readonly id: ExternalIdentityId;
  readonly userId: UserId;
  /** Exact provider issuer bytes. Never trim, case-fold, or Unicode-normalize this value. */
  readonly issuer: string;
  /** Exact provider subject bytes. Never merge identities through email or display claims. */
  readonly subject: string;
  readonly createdAt: Date;
}

export interface BrowserSession {
  /** Public selector only. This value is not sufficient to authenticate. */
  readonly id: BrowserSessionId;
  readonly userId: UserId;
  /** HMAC-SHA-256 digest. The bearer secret must never be persisted. */
  readonly secretDigest: string;
  readonly idleTimeoutSeconds: number;
  readonly issuedAt: Date;
  readonly lastSeenAt: Date;
  readonly idleExpiresAt: Date;
  readonly absoluteExpiresAt: Date;
  readonly revokedAt: Date | null;
  readonly revocationReason: BrowserSessionRevocationReason | null;
  readonly version: number;
}

export interface WorkspaceMembership {
  readonly userId: UserId;
  readonly workspaceId: WorkspaceId;
  readonly status: WorkspaceMembershipStatus;
  readonly revokedAt: Date | null;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

const SESSION_DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const MINIMUM_IDLE_TIMEOUT_SECONDS = 60;
const MAXIMUM_IDLE_TIMEOUT_SECONDS = 30 * 24 * 60 * 60;
export const MAX_EXTERNAL_IDENTITY_KEY_BYTES = 2_000;
const utf8Encoder = new TextEncoder();

function validInstant(value: Date, code: string, message: string): Date {
  invariant(Number.isFinite(value.getTime()), code, message);
  return new Date(value);
}

function requireTransitionInstant(value: Date, earliest: Date, entity: string): Date {
  const instant = validInstant(
    value,
    `${entity}.timestamp_invalid`,
    `A valid ${entity.replaceAll("_", " ")} timestamp is required.`,
  );
  invariant(
    instant.getTime() >= earliest.getTime(),
    `${entity}.timestamp_before_creation`,
    `The ${entity.replaceAll("_", " ")} timestamp cannot precede creation.`,
  );
  return instant;
}

export function createHostedUser(
  input: { readonly id?: UserId; readonly now?: Date } = {},
): HostedUser {
  const now = validInstant(
    input.now ?? new Date(),
    "hosted_user.timestamp_invalid",
    "A valid hosted user timestamp is required.",
  );
  return {
    id: input.id ?? userId(),
    status: "active",
    disabledAt: null,
    version: 1,
    createdAt: new Date(now),
    updatedAt: new Date(now),
  };
}

export function disableHostedUser(user: HostedUser, now: Date): HostedUser {
  if (user.status === "disabled") return user;
  const disabledAt = requireTransitionInstant(now, user.createdAt, "hosted_user");
  return {
    ...user,
    status: "disabled",
    disabledAt,
    version: user.version + 1,
    updatedAt: new Date(disabledAt),
  };
}

export function createExternalIdentity(input: {
  readonly id?: ExternalIdentityId;
  readonly userId: UserId;
  readonly issuer: string;
  readonly subject: string;
  readonly now?: Date;
}): ExternalIdentity {
  invariant(
    input.issuer.length > 0,
    "external_identity.issuer_required",
    "An external identity issuer is required.",
  );
  invariant(
    input.issuer.length <= 2_048,
    "external_identity.issuer_too_long",
    "An external identity issuer cannot exceed 2048 characters.",
  );
  invariant(
    input.subject.length > 0,
    "external_identity.subject_required",
    "An external identity subject is required.",
  );
  invariant(
    input.subject.length <= 512,
    "external_identity.subject_too_long",
    "An external identity subject cannot exceed 512 characters.",
  );
  invariant(
    utf8Encoder.encode(input.issuer).byteLength + utf8Encoder.encode(input.subject).byteLength <=
      MAX_EXTERNAL_IDENTITY_KEY_BYTES,
    "external_identity.key_too_large",
    `An external identity issuer and subject cannot exceed ${MAX_EXTERNAL_IDENTITY_KEY_BYTES} UTF-8 bytes combined.`,
  );
  return {
    id: input.id ?? externalIdentityId(),
    userId: input.userId,
    issuer: input.issuer,
    subject: input.subject,
    createdAt: validInstant(
      input.now ?? new Date(),
      "external_identity.timestamp_invalid",
      "A valid external identity timestamp is required.",
    ),
  };
}

export function createBrowserSession(input: {
  readonly id?: BrowserSessionId;
  readonly userId: UserId;
  readonly secretDigest: string;
  readonly idleTimeoutSeconds: number;
  readonly absoluteExpiresAt: Date;
  readonly now?: Date;
}): BrowserSession {
  const issuedAt = validInstant(
    input.now ?? new Date(),
    "browser_session.timestamp_invalid",
    "A valid browser session timestamp is required.",
  );
  const absoluteExpiresAt = validInstant(
    input.absoluteExpiresAt,
    "browser_session.absolute_expiry_invalid",
    "A valid browser session absolute expiry is required.",
  );
  invariant(
    SESSION_DIGEST_PATTERN.test(input.secretDigest),
    "browser_session.digest_invalid",
    "A browser session requires a lowercase HMAC-SHA-256 digest.",
  );
  invariant(
    Number.isSafeInteger(input.idleTimeoutSeconds) &&
      input.idleTimeoutSeconds >= MINIMUM_IDLE_TIMEOUT_SECONDS &&
      input.idleTimeoutSeconds <= MAXIMUM_IDLE_TIMEOUT_SECONDS,
    "browser_session.idle_timeout_invalid",
    "A browser session idle timeout must be between 60 seconds and 30 days.",
  );
  invariant(
    absoluteExpiresAt.getTime() > issuedAt.getTime(),
    "browser_session.absolute_expiry_invalid",
    "A browser session absolute expiry must follow issuance.",
  );
  const idleExpiresAt = new Date(
    Math.min(issuedAt.getTime() + input.idleTimeoutSeconds * 1_000, absoluteExpiresAt.getTime()),
  );
  return {
    id: input.id ?? browserSessionId(),
    userId: input.userId,
    secretDigest: input.secretDigest,
    idleTimeoutSeconds: input.idleTimeoutSeconds,
    issuedAt,
    lastSeenAt: new Date(issuedAt),
    idleExpiresAt,
    absoluteExpiresAt,
    revokedAt: null,
    revocationReason: null,
    version: 1,
  };
}

export function browserSessionIsUsable(session: BrowserSession, now: Date): boolean {
  const instant = validInstant(
    now,
    "browser_session.timestamp_invalid",
    "A valid browser session timestamp is required.",
  );
  return (
    session.revokedAt === null &&
    instant.getTime() < session.idleExpiresAt.getTime() &&
    instant.getTime() < session.absoluteExpiresAt.getTime()
  );
}

export function touchBrowserSession(session: BrowserSession, now: Date): BrowserSession {
  const lastSeenAt = requireTransitionInstant(now, session.issuedAt, "browser_session");
  invariant(
    browserSessionIsUsable(session, lastSeenAt),
    "browser_session.unavailable",
    "The browser session is unavailable.",
  );
  const idleExpiresAt = new Date(
    Math.min(
      lastSeenAt.getTime() + session.idleTimeoutSeconds * 1_000,
      session.absoluteExpiresAt.getTime(),
    ),
  );
  return {
    ...session,
    lastSeenAt,
    idleExpiresAt,
    version: session.version + 1,
  };
}

export function revokeBrowserSession(
  session: BrowserSession,
  reason: BrowserSessionRevocationReason,
  now: Date,
): BrowserSession {
  if (session.revokedAt !== null) return session;
  const revokedAt = requireTransitionInstant(now, session.issuedAt, "browser_session");
  return {
    ...session,
    revokedAt,
    revocationReason: reason,
    version: session.version + 1,
  };
}

export function createWorkspaceMembership(input: {
  readonly userId: UserId;
  readonly workspaceId: WorkspaceId;
  readonly now?: Date;
}): WorkspaceMembership {
  const now = validInstant(
    input.now ?? new Date(),
    "workspace_membership.timestamp_invalid",
    "A valid workspace membership timestamp is required.",
  );
  return {
    userId: input.userId,
    workspaceId: input.workspaceId,
    status: "active",
    revokedAt: null,
    version: 1,
    createdAt: new Date(now),
    updatedAt: new Date(now),
  };
}

export function revokeWorkspaceMembership(
  membership: WorkspaceMembership,
  now: Date,
): WorkspaceMembership {
  if (membership.status === "revoked") return membership;
  const revokedAt = requireTransitionInstant(now, membership.createdAt, "workspace_membership");
  return {
    ...membership,
    status: "revoked",
    revokedAt,
    version: membership.version + 1,
    updatedAt: new Date(revokedAt),
  };
}

export function reactivateWorkspaceMembership(
  membership: WorkspaceMembership,
  now: Date,
): WorkspaceMembership {
  if (membership.status === "active") return membership;
  const updatedAt = requireTransitionInstant(now, membership.createdAt, "workspace_membership");
  return {
    ...membership,
    status: "active",
    revokedAt: null,
    version: membership.version + 1,
    updatedAt,
  };
}
