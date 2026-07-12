import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { copyFile, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  assertComposeDatabaseReady,
  composeDatabaseName,
  composeDatabaseService,
  composeDatabaseUser,
  createBackup,
  runComposeCommand,
  verifyBackup,
  withPreparedRestoreArchive,
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
const mutableInputPath = path.join(temporaryDirectory, "mutable-input.dump");
const emptyArchivePath = path.join(temporaryDirectory, "empty.dump");
const plainArchivePath = path.join(temporaryDirectory, "plain.sql");
const truncatedArchivePath = path.join(temporaryDirectory, "truncated.dump");
const schemaOnlyArchivePath = path.join(temporaryDirectory, "schema-only.dump");
const ledgerlessArchivePath = path.join(temporaryDirectory, "ledgerless.dump");
const verificationDatabase = `schedule_verify_${randomUUID().replaceAll("-", "")}`;
const sourceDatabase = process.env.SCHEDULE_VERIFY_SOURCE_DATABASE ?? composeDatabaseName;
let verificationDatabaseCreated = false;
let verificationFailure: unknown;

async function assertArchiveRejected(
  archivePath: string,
  expectedMessage: RegExp,
  forbiddenDetail?: string,
): Promise<void> {
  let rejection: unknown;
  try {
    await verifyBackup(archivePath);
  } catch (error) {
    rejection = error;
  }
  assert.notEqual(rejection, undefined, `expected archive rejection for ${archivePath}`);
  const message = errorMessage(rejection);
  assert.match(message, expectedMessage);
  if (forbiddenDetail !== undefined) assert.doesNotMatch(message, new RegExp(forbiddenDetail));
}

async function createCustomArchive(
  outputPath: string,
  extraArguments: readonly string[],
): Promise<void> {
  await runComposeCommand(
    [
      "exec",
      "-T",
      composeDatabaseService,
      "pg_dump",
      "--username",
      composeDatabaseUser,
      "--dbname",
      sourceDatabase,
      "--format=custom",
      "--compress=6",
      "--no-owner",
      "--no-privileges",
      ...extraArguments,
    ],
    { outputPath },
  );
}

async function recoveryArtifactInventory(): Promise<string> {
  return (
    await runPsql(
      "postgres",
      "SELECT COALESCE(string_agg(datname, ',' ORDER BY datname), '') FROM pg_database WHERE datname ~ '^schedule_(restore|schema|previous|rejected)_[a-f0-9]{32}$';",
    )
  ).trim();
}

try {
  await assertComposeDatabaseReady(sourceDatabase);
  await assertScheduleDatabase(sourceDatabase, { requireCurrentMigrations: true });
  const sourceSchemaSignal = await databaseSchemaSignal(sourceDatabase);
  const sourceContentSignal = await databaseContentSignal(sourceDatabase);

  await createBackup(backupPath, sourceDatabase);
  const recoveryArtifactsBeforeRejections = await recoveryArtifactInventory();
  await writeFile(emptyArchivePath, "", { mode: 0o600 });
  await assertArchiveRejected(emptyArchivePath, /missing or empty/);

  const privateArchiveMarker = `private-archive-${randomUUID()}`;
  await writeFile(plainArchivePath, `-- ${privateArchiveMarker}\nselect 1;\n`, { mode: 0o600 });
  await assertArchiveRejected(
    plainArchivePath,
    /Docker Compose command failed/,
    privateArchiveMarker,
  );

  await copyFile(backupPath, truncatedArchivePath);
  await truncate(truncatedArchivePath, 64);
  await assertArchiveRejected(truncatedArchivePath, /Docker Compose command failed/);

  await createCustomArchive(schemaOnlyArchivePath, ["--schema-only"]);
  await assertArchiveRejected(schemaOnlyArchivePath, /definitions and data sections/);

  await createCustomArchive(ledgerlessArchivePath, [
    "--exclude-table=drizzle.__drizzle_migrations",
  ]);
  await assertArchiveRejected(ledgerlessArchivePath, /missing the Drizzle migration ledger/);

  assert.equal(
    await databaseSchemaSignal(sourceDatabase),
    sourceSchemaSignal,
    "archive rejection checks must not mutate the active source schema",
  );
  assert.equal(
    await databaseContentSignal(sourceDatabase),
    sourceContentSignal,
    "archive rejection checks must not mutate active source content",
  );
  assert.equal(
    await recoveryArtifactInventory(),
    recoveryArtifactsBeforeRejections,
    "archive rejection checks must not create staging or retained recovery databases",
  );

  await copyFile(backupPath, mutableInputPath);
  await withPreparedRestoreArchive(mutableInputPath, async ({ snapshotPath }) => {
    await writeFile(mutableInputPath, "replaced after private snapshot creation", { mode: 0o600 });
    await verifyBackup(snapshotPath);
    await createEmptyDatabase(verificationDatabase);
    verificationDatabaseCreated = true;
    await restoreArchiveIntoDatabase(snapshotPath, verificationDatabase);
  });
  await assertArchiveRejected(mutableInputPath, /Docker Compose command failed/);
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
    "Backup/restore verification passed valid round-trip, immutable snapshot, adversarial rejection, every application table, sequence, and the migration ledger.",
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
