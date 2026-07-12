import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  assertComposeDatabaseReady,
  composeDatabaseName,
  createBackup,
} from "./backup-database.js";
import {
  assertScheduleDatabase,
  createEmptyDatabase,
  databaseContentSignal,
  databaseSchemaSignal,
  dropDatabase,
  errorMessage,
  restoreArchiveIntoDatabase,
  runPsql,
} from "./restore-database.js";

const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "schedule-backup-verify-"));
const backupPath = path.join(temporaryDirectory, "verification.dump");
const verificationDatabase = `schedule_verify_${randomUUID().replaceAll("-", "")}`;
const sourceDatabase = process.env.SCHEDULE_VERIFY_SOURCE_DATABASE ?? composeDatabaseName;
let verificationDatabaseCreated = false;
let verificationFailure: unknown;

try {
  await assertComposeDatabaseReady(sourceDatabase);
  await assertScheduleDatabase(sourceDatabase, { requireCurrentMigrations: true });
  const sourceSchemaSignal = await databaseSchemaSignal(sourceDatabase);
  const sourceContentSignal = await databaseContentSignal(sourceDatabase);

  await createBackup(backupPath, sourceDatabase);
  await createEmptyDatabase(verificationDatabase);
  verificationDatabaseCreated = true;
  await restoreArchiveIntoDatabase(backupPath, verificationDatabase);
  await assertScheduleDatabase(verificationDatabase, { requireCurrentMigrations: true });

  assert.equal(
    await databaseSchemaSignal(verificationDatabase),
    sourceSchemaSignal,
    "restored database must contain the same deterministic schema signal as the source",
  );
  assert.equal(
    await databaseContentSignal(verificationDatabase),
    sourceContentSignal,
    "restored database must contain the same deterministic all-table content signal as the source",
  );
  console.log(
    "Backup/restore verification passed for every application table, sequence, and the migration ledger.",
  );
} catch (error) {
  verificationFailure = error;
}

const cleanupFailures: Error[] = [];
if (verificationDatabaseCreated) {
  try {
    await runPsql(
      "postgres",
      `ALTER DATABASE "${verificationDatabase}" WITH ALLOW_CONNECTIONS false;`,
    );
  } catch (error) {
    cleanupFailures.push(
      new Error(`disable disposable database connections: ${errorMessage(error)}`, {
        cause: error,
      }),
    );
  }
  try {
    await runPsql(
      "postgres",
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${verificationDatabase}' AND pid <> pg_backend_pid();`,
    );
  } catch (error) {
    cleanupFailures.push(
      new Error(`terminate disposable database sessions: ${errorMessage(error)}`, { cause: error }),
    );
  }
  try {
    await dropDatabase(verificationDatabase);
  } catch (error) {
    cleanupFailures.push(
      new Error(`drop disposable database: ${errorMessage(error)}`, { cause: error }),
    );
  }
}
try {
  await rm(temporaryDirectory, { recursive: true, force: true });
} catch (error) {
  cleanupFailures.push(
    new Error(`remove temporary archive: ${errorMessage(error)}`, { cause: error }),
  );
}

if (verificationFailure !== undefined || cleanupFailures.length > 0) {
  const failures = [verificationFailure, ...cleanupFailures].filter(
    (failure): failure is NonNullable<typeof failure> => failure !== undefined,
  );
  throw new AggregateError(
    failures,
    [
      "Backup/restore verification or cleanup failed.",
      `Disposable database identifier: ${verificationDatabase}.`,
      `Temporary archive path: ${backupPath}.`,
      "Do not ignore this failure; inspect pg_database and remove any retained clone only after confirming connections are disabled.",
    ].join("\n"),
    verificationFailure === undefined ? undefined : { cause: verificationFailure },
  );
}
