import path from "node:path";
import { pathToFileURL } from "node:url";

import { assertComposeDatabaseReady } from "./backup-database.js";
import {
  assertCleanupDatabaseIdentifier,
  databaseAllowsConnections,
  databaseExists,
  dropDatabase,
  errorMessage,
  runPsql,
} from "./restore-database.js";

const cleanupConfirmation = "drop-retained-database";

function parseArguments(args: readonly string[]): { databaseName: string; confirmed: boolean } {
  const normalizedArgs = args.filter((arg) => arg !== "--");
  const confirmation = normalizedArgs.find((arg) => arg.startsWith("--confirm="));
  const positional = normalizedArgs.filter((arg) => !arg.startsWith("--confirm="));
  if (positional.length !== 1 || positional[0] === undefined) {
    throw new Error(
      `Usage: pnpm db:restore:cleanup -- <retained-database> --confirm=${cleanupConfirmation}`,
    );
  }
  return {
    databaseName: positional[0],
    confirmed: confirmation === `--confirm=${cleanupConfirmation}`,
  };
}

async function main(): Promise<void> {
  try {
    const args = parseArguments(process.argv.slice(2));
    assertCleanupDatabaseIdentifier(args.databaseName);
    if (!args.confirmed) {
      throw new Error(
        `Cleanup refused. Verify the retained identifier, then pass --confirm=${cleanupConfirmation}.`,
      );
    }

    await assertComposeDatabaseReady("postgres");
    if (!(await databaseExists(args.databaseName))) {
      throw new Error(`Retained database does not exist: ${args.databaseName}`);
    }
    if (await databaseAllowsConnections(args.databaseName)) {
      await runPsql(
        "postgres",
        `ALTER DATABASE "${args.databaseName}" WITH ALLOW_CONNECTIONS false;`,
      );
      await runPsql(
        "postgres",
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${args.databaseName}' AND pid <> pg_backend_pid();`,
      );
    }

    await dropDatabase(args.databaseName);
    console.log(`Retained database removed: ${args.databaseName}`);
  } catch (error) {
    console.error(`Retained database cleanup failed: ${errorMessage(error)}`);
    process.exitCode = 1;
  }
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(path.resolve(entryPoint)).href) {
  await main();
}
