import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { migrate } from "drizzle-orm/postgres-js/migrator";

import { createDatabase } from "./database.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://schedule:schedule@127.0.0.1:5432/schedule";
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../drizzle");
const connection = createDatabase(databaseUrl, 1);

try {
  await migrate(connection.db, { migrationsFolder });
} finally {
  await connection.close();
}
