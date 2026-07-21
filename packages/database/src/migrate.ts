import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadEnvironment, type DotenvConfigOptions } from "dotenv";
import { readMigrationFiles } from "drizzle-orm/migrator";

import { createDatabase } from "./database.js";
import { inspectMigrationLedger, loadMigrationManifest } from "./migration-ledger.js";
import { controlsMigrationTransaction, migrationSqlStatements } from "./migration-sql.js";

const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../drizzle");
const statusMode = process.argv.slice(2).length === 1 && process.argv[2] === "--status";

function loadMigrationEnvironment(): void {
  // Status mode owns stdout as a one-line wire protocol, even with dotenv override mode enabled.
  const quietKey = "DOTENV_CONFIG_QUIET";
  const debugKey = "DOTENV_CONFIG_DEBUG";
  process.env[quietKey] = "true";
  process.env[debugKey] = "false";
  const protectedEnvironment = new Proxy(process.env, {
    set(target, property, value) {
      const normalized = typeof property === "string" ? property.toUpperCase() : property;
      if (normalized === quietKey || normalized === debugKey) return true;
      return Reflect.set(target, property, value);
    },
  });
  const configuredPath = process.env.DOTENV_CONFIG_PATH;
  const environmentPath =
    configuredPath === undefined || configuredPath === "" ? undefined : configuredPath;
  const configuredKey = process.env.DOTENV_CONFIG_DOTENV_KEY;
  const dotenvKey =
    configuredKey === undefined || configuredKey === "" ? process.env.DOTENV_KEY : configuredKey;
  if (dotenvKey !== undefined && dotenvKey !== "") {
    const vault =
      environmentPath === undefined
        ? path.resolve(process.cwd(), ".env.vault")
        : environmentPath.endsWith(".vault")
          ? environmentPath
          : `${environmentPath}.vault`;
    if (!existsSync(vault)) throw new Error("Encrypted migration environment is unavailable.");
  }
  const override = process.env.DOTENV_CONFIG_OVERRIDE;
  const environmentOptions: DotenvConfigOptions = {
    quiet: true,
    debug: false,
    processEnv: protectedEnvironment,
    ...(environmentPath === undefined ? {} : { path: environmentPath }),
    ...(process.env.DOTENV_CONFIG_ENCODING === undefined
      ? {}
      : { encoding: process.env.DOTENV_CONFIG_ENCODING }),
    ...(override === undefined
      ? {}
      : { override: !["false", "0", "no", "off", ""].includes(override.toLowerCase()) }),
    ...(configuredKey === undefined ? {} : { DOTENV_KEY: configuredKey }),
  };
  loadEnvironment(environmentOptions);
}

function requireReleasedMigrationLock(value: boolean | undefined): void {
  if (value !== true) throw new Error("Migration lock ownership was lost.");
}

try {
  loadMigrationEnvironment();
  const databaseUrl =
    process.env.DATABASE_URL ?? "postgres://schedule:schedule@127.0.0.1:5432/schedule";
  const manifest = await loadMigrationManifest(migrationsFolder);
  const migrations = readMigrationFiles({ migrationsFolder });
  if (
    migrations.length !== manifest.entries.length ||
    migrations.some((migration, index) => {
      const expected = manifest.entries[index];
      return (
        expected === undefined ||
        migration.folderMillis !== expected.createdAt ||
        (migration.hash !== expected.sha256 && migration.hash !== expected.crlfSha256)
      );
    })
  ) {
    throw new Error("Migration runtime metadata is inconsistent.");
  }
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
      // so its session lock spans preflight, the migration transaction, and postflight.
      const migrationSql = connection.sql;
      await migrationSql`
        select pg_advisory_lock(hashtextextended('schedule:database-migrations', 0))
      `;
      try {
        await migrationSql`set standard_conforming_strings = on`;
        const [stringSyntax] = await migrationSql<{ value: string }[]>`
          select current_setting('standard_conforming_strings') as value
        `;
        if (stringSyntax?.value !== "on") {
          throw new Error("Migration string syntax could not be pinned.");
        }
        const before = await inspectMigrationLedger(migrationSql, manifest);
        if (before === "ahead" || before === "divergent") {
          throw new Error("Migration history is incompatible.");
        }
        if (before === "prefix") {
          await migrationSql.begin(async (transaction) => {
            const persistentSettings = async (): Promise<string> => {
              const [settings] = await transaction<{ value: string }[]>`
                select coalesce(
                  jsonb_agg(
                    jsonb_build_array(setdatabase, setrole, setconfig)
                    order by setdatabase, setrole
                  ),
                  '[]'::jsonb
                )::text as value
                from pg_catalog.pg_db_role_setting
              `;
              if (settings === undefined) throw new Error("Migration settings could not be read.");
              return settings.value;
            };
            const originalSettings = await persistentSettings();
            const executeSource = async (source: string): Promise<void> => {
              for (const statement of migrationSqlStatements(source)) {
                if (controlsMigrationTransaction(statement)) {
                  throw new Error("Migration attempted to control its transaction.");
                }
                await transaction`set standard_conforming_strings = on`;
                await transaction.unsafe(statement.source);
                const [after] = await transaction<{ value: string }[]>`
                  select current_setting('standard_conforming_strings') as value
                `;
                if (after?.value !== "on") {
                  throw new Error("Migration changed its required string syntax.");
                }
              }
            };

            await executeSource("create schema if not exists drizzle");
            await executeSource(`
              create table if not exists drizzle.__drizzle_migrations (
                id serial primary key,
                hash text not null,
                created_at bigint
              )
            `);
            const [ledger] = await transaction<{ count: number }[]>`
              select count(*)::integer as count from drizzle.__drizzle_migrations
            `;
            if (
              ledger === undefined ||
              !Number.isSafeInteger(ledger.count) ||
              ledger.count < 0 ||
              ledger.count > migrations.length
            ) {
              throw new Error("Migration ledger length is invalid.");
            }
            for (const migration of migrations.slice(ledger.count)) {
              for (const source of migration.sql) await executeSource(source);
              await transaction`
                insert into drizzle.__drizzle_migrations (hash, created_at)
                values (${migration.hash}, ${migration.folderMillis})
              `;
            }
            if ((await persistentSettings()) !== originalSettings) {
              throw new Error("Migration changed persistent database settings.");
            }
          });
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
