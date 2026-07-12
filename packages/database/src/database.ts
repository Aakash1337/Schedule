import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";

import * as schema from "./schema.js";

export interface DatabaseConnection {
  readonly db: PostgresJsDatabase<typeof schema>;
  readonly sql: Sql;
  close(): Promise<void>;
}

export function createDatabase(databaseUrl: string, maxConnections = 10): DatabaseConnection {
  const client = postgres(databaseUrl, {
    max: maxConnections,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false,
  });

  return {
    db: drizzle(client, { schema }),
    sql: client,
    close: async () => client.end({ timeout: 5 }),
  };
}

export async function healthCheckDatabase(connection: DatabaseConnection): Promise<void> {
  await connection.sql`select 1 as healthy`;
}
