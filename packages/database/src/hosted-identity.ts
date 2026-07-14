import { and, eq, isNull, sql } from "drizzle-orm";

import type {
  BrowserSessionRepository,
  ExternalIdentityRepository,
  HostedUserRepository,
  HostedWorkspaceRepository,
  IdentityTimeRepository,
  IdentityTransactionContext,
  IdentityUnitOfWork,
  UnitOfWorkOptions,
  WorkspaceMembershipRepository,
} from "@schedule/application";
import {
  DomainError,
  browserSessionId,
  externalIdentityId,
  userId,
  workspaceId,
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

import type { DatabaseConnection } from "./database.js";
import { databaseErrorCode } from "./database-errors.js";
import {
  browserSessions,
  externalIdentities,
  hostedUsers,
  workspaces,
  workspaceMemberships,
} from "./schema.js";

type TransactionCallback = Parameters<DatabaseConnection["db"]["transaction"]>[0];
type DatabaseTransaction = Parameters<TransactionCallback>[0];
type DatabaseExecutor = DatabaseConnection["db"] | DatabaseTransaction;

type HostedUserRow = typeof hostedUsers.$inferSelect;
type ExternalIdentityRow = typeof externalIdentities.$inferSelect;
type BrowserSessionRow = typeof browserSessions.$inferSelect;
type WorkspaceMembershipRow = typeof workspaceMemberships.$inferSelect;

function mapHostedUser(row: HostedUserRow): HostedUser {
  return {
    id: userId(row.id),
    status: row.status,
    disabledAt: row.disabledAt,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function mapExternalIdentity(row: ExternalIdentityRow): ExternalIdentity {
  return {
    id: externalIdentityId(row.id),
    userId: userId(row.userId),
    issuer: row.issuer,
    subject: row.subject,
    createdAt: row.createdAt,
  };
}

function mapBrowserSession(row: BrowserSessionRow): BrowserSession {
  return {
    id: browserSessionId(row.id),
    userId: userId(row.userId),
    secretDigest: row.secretDigest,
    idleTimeoutSeconds: row.idleTimeoutSeconds,
    issuedAt: row.issuedAt,
    lastSeenAt: row.lastSeenAt,
    idleExpiresAt: row.idleExpiresAt,
    absoluteExpiresAt: row.absoluteExpiresAt,
    revokedAt: row.revokedAt,
    revocationReason: row.revocationReason,
    version: row.version,
  };
}

function mapWorkspaceMembership(row: WorkspaceMembershipRow): WorkspaceMembership {
  return {
    userId: userId(row.userId),
    workspaceId: workspaceId(row.workspaceId),
    status: row.status,
    revokedAt: row.revokedAt,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function versionConflict(entity: string): DomainError {
  return new DomainError(
    `${entity}.version_conflict`,
    `The ${entity.replaceAll("_", " ")} changed before it could be saved.`,
  );
}

class PostgresHostedUserRepository implements HostedUserRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async findByIdForUpdate(id: UserId): Promise<HostedUser | null> {
    const [row] = await this.database
      .select()
      .from(hostedUsers)
      .where(eq(hostedUsers.id, id))
      .limit(1)
      .for("update");
    return row === undefined ? null : mapHostedUser(row);
  }

  async insert(user: HostedUser): Promise<void> {
    await this.database.insert(hostedUsers).values(user);
  }

  async save(user: HostedUser, expectedVersion: number): Promise<void> {
    const updated = await this.database
      .update(hostedUsers)
      .set({
        status: user.status,
        disabledAt: user.disabledAt,
        version: user.version,
        updatedAt: user.updatedAt,
      })
      .where(and(eq(hostedUsers.id, user.id), eq(hostedUsers.version, expectedVersion)))
      .returning({ id: hostedUsers.id });
    if (updated.length === 0) throw versionConflict("hosted_user");
  }
}

class PostgresExternalIdentityRepository implements ExternalIdentityRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async lockExact(issuer: string, subject: string): Promise<void> {
    const exactBinding = JSON.stringify([issuer, subject]);
    await this.database.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${exactBinding}::text, 0))`,
    );
  }

  async findExact(issuer: string, subject: string): Promise<ExternalIdentity | null> {
    const [row] = await this.database
      .select()
      .from(externalIdentities)
      .where(
        and(
          sql`${externalIdentities.issuer} collate "C" = ${issuer}::text collate "C"`,
          sql`${externalIdentities.subject} collate "C" = ${subject}::text collate "C"`,
        ),
      )
      .limit(1);
    return row === undefined ? null : mapExternalIdentity(row);
  }

  async insert(identity: ExternalIdentity): Promise<void> {
    await this.database.insert(externalIdentities).values(identity);
  }
}

class PostgresBrowserSessionRepository implements BrowserSessionRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async findById(id: BrowserSessionId): Promise<BrowserSession | null> {
    const [row] = await this.database
      .select()
      .from(browserSessions)
      .where(eq(browserSessions.id, id))
      .limit(1);
    return row === undefined ? null : mapBrowserSession(row);
  }

  async findByIdForUpdate(id: BrowserSessionId): Promise<BrowserSession | null> {
    const [row] = await this.database
      .select()
      .from(browserSessions)
      .where(eq(browserSessions.id, id))
      .limit(1)
      .for("update");
    return row === undefined ? null : mapBrowserSession(row);
  }

  async insert(session: BrowserSession): Promise<void> {
    await this.database.insert(browserSessions).values(session);
  }

  async save(session: BrowserSession, expectedVersion: number): Promise<void> {
    const updated = await this.database
      .update(browserSessions)
      .set({
        secretDigest: session.secretDigest,
        idleTimeoutSeconds: session.idleTimeoutSeconds,
        lastSeenAt: session.lastSeenAt,
        idleExpiresAt: session.idleExpiresAt,
        absoluteExpiresAt: session.absoluteExpiresAt,
        revokedAt: session.revokedAt,
        revocationReason: session.revocationReason,
        version: session.version,
      })
      .where(and(eq(browserSessions.id, session.id), eq(browserSessions.version, expectedVersion)))
      .returning({ id: browserSessions.id });
    if (updated.length === 0) throw versionConflict("browser_session");
  }

  async revokeAllForUser(
    id: UserId,
    revokedAt: Date,
    reason: Extract<BrowserSessionRevocationReason, "user_disabled" | "administrative">,
  ): Promise<number> {
    const updated = await this.database
      .update(browserSessions)
      .set({
        revokedAt,
        revocationReason: reason,
        version: sql`${browserSessions.version} + 1`,
      })
      .where(and(eq(browserSessions.userId, id), isNull(browserSessions.revokedAt)))
      .returning({ id: browserSessions.id });
    return updated.length;
  }
}

class PostgresWorkspaceMembershipRepository implements WorkspaceMembershipRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async findByUserAndWorkspace(
    id: UserId,
    workspace: WorkspaceId,
  ): Promise<WorkspaceMembership | null> {
    const [row] = await this.database
      .select()
      .from(workspaceMemberships)
      .where(
        and(eq(workspaceMemberships.userId, id), eq(workspaceMemberships.workspaceId, workspace)),
      )
      .limit(1);
    return row === undefined ? null : mapWorkspaceMembership(row);
  }

  async findByUserAndWorkspaceForUpdate(
    id: UserId,
    workspace: WorkspaceId,
  ): Promise<WorkspaceMembership | null> {
    const [row] = await this.database
      .select()
      .from(workspaceMemberships)
      .where(
        and(eq(workspaceMemberships.userId, id), eq(workspaceMemberships.workspaceId, workspace)),
      )
      .limit(1)
      .for("update");
    return row === undefined ? null : mapWorkspaceMembership(row);
  }

  async insert(membership: WorkspaceMembership): Promise<void> {
    await this.database.insert(workspaceMemberships).values(membership);
  }

  async save(membership: WorkspaceMembership, expectedVersion: number): Promise<void> {
    const updated = await this.database
      .update(workspaceMemberships)
      .set({
        status: membership.status,
        revokedAt: membership.revokedAt,
        version: membership.version,
        updatedAt: membership.updatedAt,
      })
      .where(
        and(
          eq(workspaceMemberships.userId, membership.userId),
          eq(workspaceMemberships.workspaceId, membership.workspaceId),
          eq(workspaceMemberships.version, expectedVersion),
        ),
      )
      .returning({ userId: workspaceMemberships.userId });
    if (updated.length === 0) throw versionConflict("workspace_membership");
  }
}

class PostgresHostedWorkspaceRepository implements HostedWorkspaceRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async insert(workspace: Workspace): Promise<void> {
    await this.database.insert(workspaces).values(workspace);
  }
}

class PostgresIdentityTimeRepository implements IdentityTimeRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async current(): Promise<Date> {
    const rows = await this.database.execute(
      sql<{ value: unknown }>`select clock_timestamp() as value`,
    );
    const value = rows[0]?.value;
    const parsed = value instanceof Date || typeof value === "string" ? new Date(value) : null;
    if (parsed === null || !Number.isFinite(parsed.getTime())) {
      throw new DomainError(
        "hosted_identity.clock_invalid",
        "The database did not return a valid identity coordination timestamp.",
      );
    }
    return parsed;
  }
}

function createIdentityTransactionContext(database: DatabaseExecutor): IdentityTransactionContext {
  return {
    users: new PostgresHostedUserRepository(database),
    externalIdentities: new PostgresExternalIdentityRepository(database),
    browserSessions: new PostgresBrowserSessionRepository(database),
    memberships: new PostgresWorkspaceMembershipRepository(database),
    workspaces: new PostgresHostedWorkspaceRepository(database),
    time: new PostgresIdentityTimeRepository(database),
  };
}

const SERIALIZATION_RETRY_LIMIT = 7;

async function waitForSerializationRetry(retry: number): Promise<void> {
  const backoffMilliseconds = Math.min(100, 5 * 2 ** retry);
  const jitterMilliseconds = Math.floor(Math.random() * backoffMilliseconds);
  await new Promise<void>((resolve) => {
    setTimeout(resolve, backoffMilliseconds + jitterMilliseconds);
  });
}

/** Separate hosted-identity transaction boundary; it does not widen the local product context. */
export class PostgresIdentityUnitOfWork implements IdentityUnitOfWork {
  constructor(private readonly connection: DatabaseConnection) {}

  async run<Result>(
    operation: (context: IdentityTransactionContext) => Promise<Result>,
    options?: UnitOfWorkOptions,
  ): Promise<Result> {
    let retry = 0;
    while (true) {
      try {
        return await this.connection.db.transaction(
          async (transaction) => operation(createIdentityTransactionContext(transaction)),
          {
            isolationLevel:
              options?.isolationLevel === "read_committed" ? "read committed" : "serializable",
          },
        );
      } catch (error) {
        if (databaseErrorCode(error) !== "40001" || retry >= SERIALIZATION_RETRY_LIMIT) throw error;
        await waitForSerializationRetry(retry);
        retry += 1;
      }
    }
  }
}
