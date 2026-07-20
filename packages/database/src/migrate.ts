import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { migrate } from "drizzle-orm/postgres-js/migrator";

import { createDatabase } from "./database.js";
import { inspectMigrationLedger, loadMigrationManifest } from "./migration-ledger.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://schedule:schedule@127.0.0.1:5432/schedule";
const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../drizzle");
const statusMode = process.argv.slice(2).length === 1 && process.argv[2] === "--status";

function requireReleasedMigrationLock(value: boolean | undefined): void {
  if (value !== true) throw new Error("Migration lock ownership was lost.");
}

try {
  const manifest = await loadMigrationManifest(migrationsFolder);
  const connection = createDatabase(databaseUrl, 1, {
    ...(statusMode ? { readOnly: true, statementTimeoutMs: 30_000 } : {}),
    ...(!statusMode ? { idleTimeoutSeconds: 0 } : {}),
    suppressNotices: true,
    applicationName: "schedule-migration-ledger",
  });
  try {
    if (statusMode) {
      const before = await inspectMigrationLedger(connection.sql, manifest);
      process.stdout.write(`SCHEDULE_MIGRATION_STATUS_V1 ${before}\n`);
    } else {
      if (process.argv.length > 2) throw new Error("Migration arguments are invalid.");

      // A one-connection pool with idle eviction disabled owns one PostgreSQL backend until close,
      // so its session lock spans preflight, Drizzle's transaction, and postflight.
      const migrationSql = connection.sql;
      await migrationSql`
        select pg_advisory_lock(hashtextextended('schedule:database-migrations', 0))
      `;
      try {
        const before = await inspectMigrationLedger(migrationSql, manifest);
        if (before === "ahead" || before === "divergent") {
          throw new Error("Migration history is incompatible.");
        }
        if (before === "prefix") {
          await migrate(connection.db, { migrationsFolder });
        }
        if ((await inspectMigrationLedger(migrationSql, manifest)) !== "exact") {
          throw new Error("Migration did not reach the expected ledger.");
        }
      } finally {
        const [unlock] = await migrationSql<{ unlocked: boolean }[]>`
          select pg_advisory_unlock(
            hashtextextended('schedule:database-migrations', 0)
          ) as unlocked
        `;
        requireReleasedMigrationLock(unlock?.unlocked);
      }
    }
  } finally {
    await connection.close();
  }
} catch {
  process.stderr.write("Database migration compatibility check failed.\n");
  process.exitCode = 1;
}
