import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import {
  DomainError,
  browserSessionId,
  browserSessionIsUsable,
  createBrowserSession,
  createExternalIdentity,
  createHostedUser,
  createWorkspace,
  createWorkspaceMembership,
  disableHostedUser,
  reactivateWorkspaceMembership,
  revokeBrowserSession,
  revokeWorkspaceMembership,
  touchBrowserSession,
  type BrowserSession,
  type BrowserSessionId,
  type BrowserSessionRevocationReason,
  type ExternalIdentity,
  type HostedUser,
  type UserId,
  type Workspace,
  type WorkspaceId,
  type WorkspaceMembership,
} from "@schedule/domain";

import type { UnitOfWorkOptions } from "./ports.js";

const BROWSER_SESSION_TOKEN_VERSION = "schedule.browser-session/v1";
const BROWSER_SESSION_SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DUMMY_SELECTOR = "00000000-0000-4000-8000-000000000000";
const DUMMY_DIGEST = "0".repeat(64);
const MINIMUM_ABSOLUTE_TTL_SECONDS = 5 * 60;
const MAXIMUM_ABSOLUTE_TTL_SECONDS = 90 * 24 * 60 * 60;

export interface HostedUserRepository {
  findByIdForUpdate(id: UserId): Promise<HostedUser | null>;
  insert(user: HostedUser): Promise<void>;
  save(user: HostedUser, expectedVersion: number): Promise<void>;
}

export interface ExternalIdentityRepository {
  /** Serializes exact issuer/subject provisioning before the subsequent read. */
  lockExact(issuer: string, subject: string): Promise<void>;
  findExact(issuer: string, subject: string): Promise<ExternalIdentity | null>;
  insert(identity: ExternalIdentity): Promise<void>;
}

export interface BrowserSessionRepository {
  /** Non-locking ownership probe used to establish the global user-before-session lock order. */
  findById(id: BrowserSessionId): Promise<BrowserSession | null>;
  findByIdForUpdate(id: BrowserSessionId): Promise<BrowserSession | null>;
  insert(session: BrowserSession): Promise<void>;
  save(session: BrowserSession, expectedVersion: number): Promise<void>;
  revokeAllForUser(
    userId: UserId,
    revokedAt: Date,
    reason: "user_disabled" | "administrative",
  ): Promise<number>;
}

export interface WorkspaceMembershipRepository {
  findByUserAndWorkspace(
    userId: UserId,
    workspaceId: WorkspaceId,
  ): Promise<WorkspaceMembership | null>;
  findByUserAndWorkspaceForUpdate(
    userId: UserId,
    workspaceId: WorkspaceId,
  ): Promise<WorkspaceMembership | null>;
  insert(membership: WorkspaceMembership): Promise<void>;
  save(membership: WorkspaceMembership, expectedVersion: number): Promise<void>;
}

/** Hosted provisioning deliberately bypasses the local installation's 20-workspace cap. */
export interface HostedWorkspaceRepository {
  insert(workspace: Workspace): Promise<void>;
}

export interface IdentityTimeRepository {
  /** PostgreSQL time is authoritative for cross-process expiry and revocation decisions. */
  current(): Promise<Date>;
}

export interface IdentityTransactionContext {
  readonly users: HostedUserRepository;
  readonly externalIdentities: ExternalIdentityRepository;
  readonly browserSessions: BrowserSessionRepository;
  readonly memberships: WorkspaceMembershipRepository;
  readonly workspaces: HostedWorkspaceRepository;
  readonly time: IdentityTimeRepository;
}

export interface IdentityUnitOfWork {
  run<Result>(
    operation: (context: IdentityTransactionContext) => Promise<Result>,
    options?: UnitOfWorkOptions,
  ): Promise<Result>;
}

export interface BrowserSessionToken {
  readonly selector: string;
  readonly secret: string;
}

interface BrowserSessionSecretMaterial {
  readonly selector: BrowserSessionId;
  readonly secret: string;
  readonly secretDigest: string;
}

export interface BrowserSessionTokenCodec {
  issue(): BrowserSessionSecretMaterial;
  isWellFormed(token: BrowserSessionToken): boolean;
  verify(token: BrowserSessionToken, expectedDigest: string): boolean;
}

/** Creates 256-bit bearer secrets and persists only peppered HMAC-SHA-256 digests. */
export class HmacBrowserSessionTokenCodec implements BrowserSessionTokenCodec {
  private readonly pepper: Buffer;

  constructor(pepper: string) {
    if (typeof pepper !== "string" || Buffer.byteLength(pepper, "utf8") < 32) {
      throw new TypeError("The browser session pepper must be at least 32 bytes.");
    }
    this.pepper = Buffer.from(pepper, "utf8");
  }

  private digest(selector: string, secret: string): string {
    return createHmac("sha256", this.pepper)
      .update(BROWSER_SESSION_TOKEN_VERSION, "utf8")
      .update("\0", "utf8")
      .update(selector, "utf8")
      .update("\0", "utf8")
      .update(secret, "utf8")
      .digest("hex");
  }

  issue(): BrowserSessionSecretMaterial {
    const selector = browserSessionId();
    const secret = randomBytes(32).toString("base64url");
    return { selector, secret, secretDigest: this.digest(selector, secret) };
  }

  isWellFormed(token: BrowserSessionToken): boolean {
    return UUID_PATTERN.test(token.selector) && BROWSER_SESSION_SECRET_PATTERN.test(token.secret);
  }

  verify(token: BrowserSessionToken, expectedDigest: string): boolean {
    const wellFormed = this.isWellFormed(token) && /^[0-9a-f]{64}$/u.test(expectedDigest);
    const selector = UUID_PATTERN.test(token.selector) ? token.selector : DUMMY_SELECTOR;
    const secret = BROWSER_SESSION_SECRET_PATTERN.test(token.secret)
      ? token.secret
      : "A".repeat(43);
    const actual = Buffer.from(this.digest(selector, secret), "hex");
    const expected = Buffer.from(
      /^[0-9a-f]{64}$/u.test(expectedDigest) ? expectedDigest : DUMMY_DIGEST,
      "hex",
    );
    return timingSafeEqual(actual, expected) && wellFormed;
  }
}

function selectorForLookup(token: BrowserSessionToken): BrowserSessionId {
  return browserSessionId(UUID_PATTERN.test(token.selector) ? token.selector : DUMMY_SELECTOR);
}

function requireActiveUser(user: HostedUser | null): HostedUser {
  if (user === null) {
    throw new DomainError("hosted_identity.user_not_found", "The hosted user does not exist.");
  }
  if (user.status !== "active") {
    throw new DomainError("hosted_identity.user_disabled", "The hosted user is disabled.");
  }
  return user;
}

export interface FindOrProvisionHostedUserResult {
  readonly user: HostedUser;
  readonly identity: ExternalIdentity;
  readonly created: boolean;
}

export class FindOrProvisionHostedUser {
  constructor(private readonly unitOfWork: IdentityUnitOfWork) {}

  execute(input: {
    readonly issuer: string;
    readonly subject: string;
  }): Promise<FindOrProvisionHostedUserResult> {
    return this.unitOfWork.run(
      async ({ users, externalIdentities, time }) => {
        await externalIdentities.lockExact(input.issuer, input.subject);
        const existing = await externalIdentities.findExact(input.issuer, input.subject);
        if (existing !== null) {
          const user = await users.findByIdForUpdate(existing.userId);
          if (user === null) {
            throw new DomainError(
              "hosted_identity.binding_corrupt",
              "The external identity binding is inconsistent.",
            );
          }
          return { user, identity: existing, created: false };
        }

        const now = await time.current();
        const user = createHostedUser({ now });
        const identity = createExternalIdentity({ ...input, userId: user.id, now });
        await users.insert(user);
        await externalIdentities.insert(identity);
        return { user, identity, created: true };
      },
      { isolationLevel: "read_committed" },
    );
  }
}

export class ProvisionHostedWorkspace {
  constructor(private readonly unitOfWork: IdentityUnitOfWork) {}

  execute(input: { readonly userId: UserId; readonly name: string }): Promise<{
    readonly workspace: Workspace;
    readonly membership: WorkspaceMembership;
  }> {
    return this.unitOfWork.run(async ({ users, workspaces, memberships, time }) => {
      requireActiveUser(await users.findByIdForUpdate(input.userId));
      const now = await time.current();
      const workspace = createWorkspace({ name: input.name, now });
      const membership = createWorkspaceMembership({
        userId: input.userId,
        workspaceId: workspace.id,
        now,
      });
      await workspaces.insert(workspace);
      await memberships.insert(membership);
      return { workspace, membership };
    });
  }
}

export interface IssuedBrowserSession {
  readonly token: BrowserSessionToken;
  readonly idleExpiresAt: Date;
  readonly absoluteExpiresAt: Date;
}

function requireAbsoluteTtl(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < MINIMUM_ABSOLUTE_TTL_SECONDS ||
    value > MAXIMUM_ABSOLUTE_TTL_SECONDS
  ) {
    throw new DomainError(
      "browser_session.absolute_ttl_invalid",
      "A browser session absolute lifetime must be between five minutes and 90 days.",
    );
  }
  return value;
}

function issuedSessionResult(
  material: BrowserSessionSecretMaterial,
  session: BrowserSession,
): IssuedBrowserSession {
  return {
    token: { selector: material.selector, secret: material.secret },
    idleExpiresAt: new Date(session.idleExpiresAt),
    absoluteExpiresAt: new Date(session.absoluteExpiresAt),
  };
}

export class IssueBrowserSession {
  constructor(
    private readonly unitOfWork: IdentityUnitOfWork,
    private readonly tokenCodec: BrowserSessionTokenCodec,
  ) {}

  execute(input: {
    readonly userId: UserId;
    readonly idleTimeoutSeconds: number;
    readonly absoluteTtlSeconds: number;
  }): Promise<IssuedBrowserSession> {
    const absoluteTtlSeconds = requireAbsoluteTtl(input.absoluteTtlSeconds);
    const material = this.tokenCodec.issue();
    return this.unitOfWork.run(async ({ users, browserSessions, time }) => {
      requireActiveUser(await users.findByIdForUpdate(input.userId));
      const now = await time.current();
      const session = createBrowserSession({
        id: material.selector,
        userId: input.userId,
        secretDigest: material.secretDigest,
        idleTimeoutSeconds: input.idleTimeoutSeconds,
        absoluteExpiresAt: new Date(now.getTime() + absoluteTtlSeconds * 1_000),
        now,
      });
      await browserSessions.insert(session);
      return issuedSessionResult(material, session);
    });
  }
}

export interface BrowserSessionPrincipal {
  readonly userId: UserId;
  readonly sessionId: BrowserSessionId;
  readonly idleExpiresAt: Date;
  readonly absoluteExpiresAt: Date;
}

export interface HostedWorkspaceAuthorization {
  readonly userId: UserId;
  readonly sessionId: BrowserSessionId;
  readonly workspaceId: WorkspaceId;
}

/**
 * Performs the read-side workspace membership check for an already authenticated request.
 * Revocation fences subsequent requests; it cannot retract a request that has already crossed
 * this boundary. Hosted mutations that require a stronger fence must reauthorize in their own
 * product transaction instead of treating this preflight decision as transaction authority.
 */
export class AuthorizeHostedWorkspace {
  constructor(private readonly unitOfWork: IdentityUnitOfWork) {}

  execute(
    principal: Pick<BrowserSessionPrincipal, "userId" | "sessionId">,
    workspaceId: WorkspaceId,
  ): Promise<HostedWorkspaceAuthorization | null> {
    return this.unitOfWork.run(
      async ({ memberships }) => {
        const membership = await memberships.findByUserAndWorkspace(principal.userId, workspaceId);
        if (membership?.status !== "active") return null;
        return Object.freeze({
          userId: principal.userId,
          sessionId: principal.sessionId,
          workspaceId: membership.workspaceId,
        });
      },
      { isolationLevel: "read_committed" },
    );
  }
}

async function lockPresentedSession(
  users: HostedUserRepository,
  browserSessions: BrowserSessionRepository,
  tokenCodec: BrowserSessionTokenCodec,
  token: BrowserSessionToken,
): Promise<{ readonly user: HostedUser; readonly session: BrowserSession } | null> {
  const selector = selectorForLookup(token);
  const observed = await browserSessions.findById(selector);
  const observedSecretMatches = tokenCodec.verify(token, observed?.secretDigest ?? DUMMY_DIGEST);
  if (!tokenCodec.isWellFormed(token) || !observedSecretMatches || observed === null) return null;

  // Every path that needs both rows locks user before session. The preliminary read supplies the
  // immutable owner without taking the inverse session-before-user lock used by the old protocol.
  const user = await users.findByIdForUpdate(observed.userId);
  const session = await browserSessions.findByIdForUpdate(selector);
  const currentSecretMatches = tokenCodec.verify(token, session?.secretDigest ?? DUMMY_DIGEST);
  if (
    user === null ||
    session === null ||
    session.userId !== observed.userId ||
    !currentSecretMatches
  ) {
    return null;
  }
  return { user, session };
}

export class ResolveBrowserSession {
  constructor(
    private readonly unitOfWork: IdentityUnitOfWork,
    private readonly tokenCodec: BrowserSessionTokenCodec,
  ) {}

  execute(token: BrowserSessionToken): Promise<BrowserSessionPrincipal | null> {
    return this.unitOfWork.run(async ({ users, browserSessions, time }) => {
      const locked = await lockPresentedSession(users, browserSessions, this.tokenCodec, token);
      if (locked === null) return null;
      const { session, user } = locked;
      const now = await time.current();
      if (user.status !== "active" || !browserSessionIsUsable(session, now)) return null;
      const touched = touchBrowserSession(session, now);
      await browserSessions.save(touched, session.version);
      return {
        userId: user.id,
        sessionId: touched.id,
        idleExpiresAt: new Date(touched.idleExpiresAt),
        absoluteExpiresAt: new Date(touched.absoluteExpiresAt),
      };
    });
  }
}

export class RotateBrowserSession {
  constructor(
    private readonly unitOfWork: IdentityUnitOfWork,
    private readonly tokenCodec: BrowserSessionTokenCodec,
  ) {}

  execute(token: BrowserSessionToken): Promise<IssuedBrowserSession | null> {
    const material = this.tokenCodec.issue();
    return this.unitOfWork.run(async ({ users, browserSessions, time }) => {
      const locked = await lockPresentedSession(users, browserSessions, this.tokenCodec, token);
      if (locked === null) return null;
      const { session: current, user } = locked;
      const now = await time.current();
      if (user.status !== "active" || !browserSessionIsUsable(current, now)) return null;

      const rotated = revokeBrowserSession(current, "rotated", now);
      const replacement = createBrowserSession({
        id: material.selector,
        userId: current.userId,
        secretDigest: material.secretDigest,
        idleTimeoutSeconds: current.idleTimeoutSeconds,
        absoluteExpiresAt: current.absoluteExpiresAt,
        now,
      });
      await browserSessions.save(rotated, current.version);
      await browserSessions.insert(replacement);
      return issuedSessionResult(material, replacement);
    });
  }
}

export class RevokeBrowserSession {
  constructor(
    private readonly unitOfWork: IdentityUnitOfWork,
    private readonly tokenCodec: BrowserSessionTokenCodec,
  ) {}

  execute(
    token: BrowserSessionToken,
    reason: BrowserSessionRevocationReason = "signed_out",
  ): Promise<boolean> {
    const presentedWellFormed = this.tokenCodec.isWellFormed(token);
    return this.unitOfWork.run(async ({ browserSessions, time }) => {
      const session = await browserSessions.findByIdForUpdate(selectorForLookup(token));
      const secretMatches = this.tokenCodec.verify(token, session?.secretDigest ?? DUMMY_DIGEST);
      if (!presentedWellFormed || !secretMatches || session === null) return false;
      const now = await time.current();
      const revoked = revokeBrowserSession(session, reason, now);
      if (revoked !== session) await browserSessions.save(revoked, session.version);
      return true;
    });
  }
}

export class DisableHostedUser {
  constructor(private readonly unitOfWork: IdentityUnitOfWork) {}

  execute(userId: UserId): Promise<HostedUser> {
    return this.unitOfWork.run(async ({ users, browserSessions, time }) => {
      const user = await users.findByIdForUpdate(userId);
      if (user === null) {
        throw new DomainError("hosted_identity.user_not_found", "The hosted user does not exist.");
      }
      const now = await time.current();
      const disabled = disableHostedUser(user, now);
      if (disabled !== user) await users.save(disabled, user.version);
      await browserSessions.revokeAllForUser(user.id, now, "user_disabled");
      return disabled;
    });
  }
}

async function mutateMembership(
  unitOfWork: IdentityUnitOfWork,
  userId: UserId,
  workspaceId: WorkspaceId,
  transition: (membership: WorkspaceMembership, now: Date) => WorkspaceMembership,
): Promise<WorkspaceMembership> {
  return unitOfWork.run(async ({ memberships, time }) => {
    const membership = await memberships.findByUserAndWorkspaceForUpdate(userId, workspaceId);
    if (membership === null) {
      throw new DomainError(
        "workspace_membership.not_found",
        "The workspace membership does not exist.",
      );
    }
    const updated = transition(membership, await time.current());
    if (updated !== membership) await memberships.save(updated, membership.version);
    return updated;
  });
}

export class RevokeWorkspaceMembership {
  constructor(private readonly unitOfWork: IdentityUnitOfWork) {}

  execute(userId: UserId, workspaceId: WorkspaceId): Promise<WorkspaceMembership> {
    return mutateMembership(this.unitOfWork, userId, workspaceId, revokeWorkspaceMembership);
  }
}

export class ReactivateWorkspaceMembership {
  constructor(private readonly unitOfWork: IdentityUnitOfWork) {}

  execute(userId: UserId, workspaceId: WorkspaceId): Promise<WorkspaceMembership> {
    return mutateMembership(this.unitOfWork, userId, workspaceId, reactivateWorkspaceMembership);
  }
}
