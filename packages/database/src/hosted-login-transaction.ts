import { and, eq, lte, sql } from "drizzle-orm";

import type {
  HostedLoginTransactionContext,
  HostedLoginTransactionRepository,
  HostedLoginTransactionTimeRepository,
  HostedLoginTransactionUnitOfWork,
  UnitOfWorkOptions,
} from "@schedule/application";
import {
  DomainError,
  hostedLoginTransactionId,
  type HostedLoginTransaction,
} from "@schedule/domain";

import type { DatabaseConnection } from "./database.js";
import { databaseErrorCode } from "./database-errors.js";
import { hostedLoginTransactions } from "./schema.js";

type TransactionCallback = Parameters<DatabaseConnection["db"]["transaction"]>[0];
type DatabaseTransaction = Parameters<TransactionCallback>[0];
type DatabaseExecutor = DatabaseConnection["db"] | DatabaseTransaction;
type HostedLoginTransactionRow = typeof hostedLoginTransactions.$inferSelect;

function mapHostedLoginTransaction(row: HostedLoginTransactionRow): HostedLoginTransaction {
  if (row.pkceMethod !== "S256") {
    throw new DomainError(
      "hosted_login_transaction.persistence_invalid",
      "The hosted login transaction is unavailable.",
    );
  }
  return {
    id: hostedLoginTransactionId(row.id),
    stateDigest: row.stateDigest,
    browserBindingDigest: row.browserBindingDigest,
    issuer: row.issuer,
    clientId: row.clientId,
    redirectUri: row.redirectUri,
    returnToPath: row.returnToPath,
    nonce: row.nonce,
    pkceChallenge: row.pkceChallenge,
    pkceMethod: row.pkceMethod,
    protectedPkceVerifier: row.protectedPkceVerifier,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt,
    version: row.version,
  };
}

class PostgresHostedLoginTransactionRepository implements HostedLoginTransactionRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async findByStateDigestForUpdate(stateDigest: string): Promise<HostedLoginTransaction | null> {
    const [row] = await this.database
      .select()
      .from(hostedLoginTransactions)
      .where(eq(hostedLoginTransactions.stateDigest, stateDigest))
      .limit(1)
      .for("update");
    return row === undefined ? null : mapHostedLoginTransaction(row);
  }

  async insert(transaction: HostedLoginTransaction): Promise<void> {
    await this.database.insert(hostedLoginTransactions).values(transaction);
  }

  async save(transaction: HostedLoginTransaction, expectedVersion: number): Promise<void> {
    const updated = await this.database
      .update(hostedLoginTransactions)
      .set({ consumedAt: transaction.consumedAt, version: transaction.version })
      .where(
        and(
          eq(hostedLoginTransactions.id, transaction.id),
          eq(hostedLoginTransactions.version, expectedVersion),
        ),
      )
      .returning({ id: hostedLoginTransactions.id });
    if (updated.length === 0) {
      throw new DomainError(
        "hosted_login_transaction.version_conflict",
        "The hosted login transaction changed before it could be consumed.",
      );
    }
  }

  async deleteExpiredBefore(cutoff: Date, limit: number): Promise<number> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
      throw new RangeError(
        "The hosted login transaction cleanup limit must be between 1 and 1000.",
      );
    }
    const deleted = await this.database.execute(
      sql<{ id: string }>`
        with candidates as (
          select ${hostedLoginTransactions.id}
          from ${hostedLoginTransactions}
          where ${lte(hostedLoginTransactions.expiresAt, cutoff)}
          order by ${hostedLoginTransactions.expiresAt}, ${hostedLoginTransactions.id}
          for update skip locked
          limit ${limit}
        )
        delete from ${hostedLoginTransactions}
        using candidates
        where ${hostedLoginTransactions.id} = candidates.id
        returning ${hostedLoginTransactions.id}
      `,
    );
    return deleted.length;
  }
}

class PostgresHostedLoginTransactionTimeRepository implements HostedLoginTransactionTimeRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async current(): Promise<Date> {
    const rows = await this.database.execute(
      sql<{ value: unknown }>`select clock_timestamp() as value`,
    );
    const value = rows[0]?.value;
    const parsed = value instanceof Date || typeof value === "string" ? new Date(value) : null;
    if (parsed === null || !Number.isFinite(parsed.getTime())) {
      throw new DomainError(
        "hosted_login_transaction.clock_invalid",
        "The database did not return a valid login coordination timestamp.",
      );
    }
    return parsed;
  }
}

function createHostedLoginTransactionContext(
  database: DatabaseExecutor,
): HostedLoginTransactionContext {
  return {
    transactions: new PostgresHostedLoginTransactionRepository(database),
    time: new PostgresHostedLoginTransactionTimeRepository(database),
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

/** Separate pre-authentication transaction boundary; it does not widen product or identity UoWs. */
export class PostgresHostedLoginTransactionUnitOfWork implements HostedLoginTransactionUnitOfWork {
  constructor(private readonly connection: DatabaseConnection) {}

  async run<Result>(
    operation: (context: HostedLoginTransactionContext) => Promise<Result>,
    options?: UnitOfWorkOptions,
  ): Promise<Result> {
    let retry = 0;
    while (true) {
      try {
        return await this.connection.db.transaction(
          async (transaction) => operation(createHostedLoginTransactionContext(transaction)),
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
