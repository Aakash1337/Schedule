import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";

import * as schema from "./schema.js";

export interface DatabaseConnection {
  readonly db: PostgresJsDatabase<typeof schema>;
  readonly sql: Sql;
  close(): Promise<void>;
}

export interface DatabasePoolOptions {
  /** Makes every session in this pool read-only unless a transaction explicitly overrides it. */
  readonly readOnly?: boolean;
  /** PostgreSQL-enforced statement deadline for every session in this pool. */
  readonly statementTimeoutMs?: number;
  /** Pool idle lifetime in seconds; zero keeps a migration lock session alive until explicit close. */
  readonly idleTimeoutSeconds?: number;
  /** Keep fixed-protocol maintenance commands free of PostgreSQL NOTICE output. */
  readonly suppressNotices?: boolean;
  readonly applicationName?: string;
}

const DEFAULT_HEALTH_CHECK_TIMEOUT_MS = 5_000;

function requirePositiveTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) {
    throw new RangeError("Database statement timeout must be a positive 32-bit integer.");
  }
  return value;
}

function requireIdleTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647) {
    throw new RangeError("Database idle timeout must be a non-negative 32-bit integer.");
  }
  return value;
}

export function createDatabase(
  databaseUrl: string,
  maxConnections = 10,
  options: DatabasePoolOptions = {},
): DatabaseConnection {
  const statementTimeout =
    options.statementTimeoutMs === undefined
      ? undefined
      : requirePositiveTimeout(options.statementTimeoutMs);
  const idleTimeout =
    options.idleTimeoutSeconds === undefined ? 20 : requireIdleTimeout(options.idleTimeoutSeconds);
  const client = postgres(databaseUrl, {
    max: maxConnections,
    idle_timeout: idleTimeout,
    connect_timeout: 10,
    prepare: false,
    ...(options.suppressNotices === true ? { onnotice: () => undefined } : {}),
    connection: {
      ...(options.readOnly === undefined
        ? {}
        : { default_transaction_read_only: options.readOnly }),
      ...(statementTimeout === undefined ? {} : { statement_timeout: statementTimeout }),
      ...(options.applicationName === undefined
        ? {}
        : { application_name: options.applicationName }),
    },
  });

  return {
    db: drizzle(client, { schema }),
    sql: client,
    close: async () => client.end({ timeout: 5 }),
  };
}

export async function withDatabaseOperationDeadline<Result>(
  operation: PromiseLike<Result>,
  timeoutMs: number,
): Promise<Result> {
  const timeout = requirePositiveTimeout(timeoutMs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error("Database operation exceeded its deadline."));
    }, timeout);
    timer.unref?.();
  });

  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function healthCheckDatabase(
  connection: DatabaseConnection,
  timeoutMs = DEFAULT_HEALTH_CHECK_TIMEOUT_MS,
): Promise<void> {
  await withDatabaseOperationDeadline(connection.sql`select 1 as healthy`, timeoutMs);
}
