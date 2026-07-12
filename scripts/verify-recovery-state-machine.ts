import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { assertComposeDatabaseReady, createBackup } from "./backup-database.js";
import {
  assertDisposableRecoveryPlan,
  cleanupDisposableRecoveryDatabase,
  createDisposableRecoveryPlan,
  databaseAllowsConnections,
  databaseContentSignal,
  databaseExists,
  disposableRecoveryVerificationSentinel,
  dropDatabase,
  errorMessage,
  initializeDisposableRecoveryActiveDatabase,
  rollbackDisposableScheduleDatabase,
  restoreDisposableScheduleDatabase,
  runPsql,
  type DisposableRecoveryPlan,
} from "./restore-database.js";

const sentinelVariable = "SCHEDULE_RECOVERY_STATE_MACHINE_SENTINEL";

if (process.env.NODE_ENV !== "test") {
  throw new Error("Recovery state-machine verification requires NODE_ENV=test.");
}
if (process.env[sentinelVariable] !== disposableRecoveryVerificationSentinel) {
  throw new Error(
    `Recovery state-machine verification requires ${sentinelVariable}=${disposableRecoveryVerificationSentinel}.`,
  );
}

async function databaseOid(databaseName: string): Promise<number> {
  const value = (
    await runPsql(
      "postgres",
      `SELECT oid::text FROM pg_database WHERE datname = '${databaseName}';`,
    )
  ).trim();
  if (!/^\d+$/.test(value)) throw new Error(`Could not read database OID for ${databaseName}.`);
  return Number(value);
}

async function markerName(databaseName: string, markerId: string): Promise<string> {
  return (
    await runPsql(databaseName, `SELECT name FROM workspaces WHERE id = '${markerId}'::uuid;`)
  ).trim();
}

async function inspectLockedDatabase<T>(
  databaseName: string,
  inspect: () => Promise<T>,
): Promise<T> {
  assert.equal(
    await databaseAllowsConnections(databaseName),
    false,
    `${databaseName} must be locked before inspection`,
  );
  await runPsql("postgres", `ALTER DATABASE "${databaseName}" WITH ALLOW_CONNECTIONS true;`);
  let result: T | undefined;
  let inspectionFailure: unknown;
  try {
    result = await inspect();
  } catch (error) {
    inspectionFailure = error;
  }

  const lockdownFailures: Error[] = [];
  try {
    await runPsql("postgres", `ALTER DATABASE "${databaseName}" WITH ALLOW_CONNECTIONS false;`);
  } catch (error) {
    lockdownFailures.push(
      new Error(`disable ${databaseName} after inspection: ${errorMessage(error)}`, {
        cause: error,
      }),
    );
  }
  try {
    await runPsql(
      "postgres",
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${databaseName}' AND pid <> pg_backend_pid();`,
    );
  } catch (error) {
    lockdownFailures.push(
      new Error(`terminate ${databaseName} sessions after inspection: ${errorMessage(error)}`, {
        cause: error,
      }),
    );
  }

  if (inspectionFailure !== undefined || lockdownFailures.length > 0) {
    throw new AggregateError(
      [inspectionFailure, ...lockdownFailures].filter(
        (failure): failure is NonNullable<typeof failure> => failure !== undefined,
      ),
      `Locked database inspection failed for ${databaseName}.`,
      inspectionFailure === undefined ? undefined : { cause: inspectionFailure },
    );
  }
  return result as T;
}

async function assertRoleExistence(
  plan: DisposableRecoveryPlan,
  expected: Readonly<Record<keyof Omit<DisposableRecoveryPlan, "nonce">, boolean>>,
): Promise<void> {
  for (const role of [
    "activeDatabase",
    "stagingDatabase",
    "previousDatabase",
    "rejectedDatabase",
    "referenceDatabase",
  ] as const) {
    assert.equal(
      await databaseExists(plan[role]),
      expected[role],
      `${role} existence must match the recovery phase`,
    );
  }
}

async function forceCleanupOwnedDatabases(databaseNames: readonly string[]): Promise<Error[]> {
  const failures: Error[] = [];
  for (const databaseName of databaseNames) {
    let exists = true;
    try {
      exists = await databaseExists(databaseName);
    } catch (error) {
      failures.push(
        new Error(`inspect ${databaseName} before force-cleanup: ${errorMessage(error)}`, {
          cause: error,
        }),
      );
    }
    if (!exists) continue;

    for (const [label, action] of [
      [
        "disable connections",
        () => runPsql("postgres", `ALTER DATABASE "${databaseName}" WITH ALLOW_CONNECTIONS false;`),
      ],
      [
        "terminate sessions",
        () =>
          runPsql(
            "postgres",
            `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${databaseName}' AND pid <> pg_backend_pid();`,
          ),
      ],
      ["drop database", () => dropDatabase(databaseName)],
    ] as const) {
      try {
        await action();
      } catch (error) {
        failures.push(
          new Error(`${label} for ${databaseName}: ${errorMessage(error)}`, { cause: error }),
        );
      }
    }
  }
  return failures;
}

const plan = createDisposableRecoveryPlan();
assertDisposableRecoveryPlan(plan);
const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "schedule-recovery-state-"));
const archivePath = path.join(temporaryDirectory, "private-recovery.dump");
const markerId = randomUUID();
const archivedMarker = `archived-${plan.nonce}`;
const currentMarker = `current-${plan.nonce}`;
let verificationFailure: unknown;
const cleanupFailures: Error[] = [];
const cleanupEligibleDatabases = new Set<string>();

try {
  await chmod(temporaryDirectory, 0o700);
  await assertComposeDatabaseReady("postgres");
  for (const databaseName of [
    plan.activeDatabase,
    plan.stagingDatabase,
    plan.previousDatabase,
    plan.rejectedDatabase,
    plan.referenceDatabase,
  ]) {
    const exists = await databaseExists(databaseName);
    if (!exists) cleanupEligibleDatabases.add(databaseName);
    assert.equal(exists, false, `generated recovery name must be unoccupied: ${databaseName}`);
  }

  await initializeDisposableRecoveryActiveDatabase(plan);
  const originalActiveOid = await databaseOid(plan.activeDatabase);
  await runPsql(
    plan.activeDatabase,
    `INSERT INTO workspaces (id, name) VALUES ('${markerId}'::uuid, '${archivedMarker}');`,
  );
  const archivedContent = await databaseContentSignal(plan.activeDatabase);
  await createBackup(archivePath, plan.activeDatabase);
  await chmod(archivePath, 0o600);
  if (process.platform !== "win32") {
    assert.equal((await stat(temporaryDirectory)).mode & 0o077, 0, "archive directory is private");
    assert.equal((await stat(archivePath)).mode & 0o077, 0, "archive file is private");
  }

  await runPsql(
    plan.activeDatabase,
    `UPDATE workspaces SET name = '${currentMarker}', updated_at = now() WHERE id = '${markerId}'::uuid;`,
  );
  const currentContent = await databaseContentSignal(plan.activeDatabase);
  assert.notEqual(currentContent, archivedContent, "current state must differ from archived state");

  const restoreResult = await restoreDisposableScheduleDatabase(archivePath, plan);
  assert.deepEqual(restoreResult, {
    activeDatabase: plan.activeDatabase,
    previousDatabase: plan.previousDatabase,
  });
  await assertRoleExistence(plan, {
    activeDatabase: true,
    stagingDatabase: false,
    previousDatabase: true,
    rejectedDatabase: false,
    referenceDatabase: false,
  });

  const restoredActiveOid = await databaseOid(plan.activeDatabase);
  assert.notEqual(restoredActiveOid, originalActiveOid, "restored database must have a new OID");
  assert.equal(
    await databaseOid(plan.previousDatabase),
    originalActiveOid,
    "the original active OID must be retained under the previous role",
  );
  assert.equal(await databaseAllowsConnections(plan.activeDatabase), true);
  assert.equal(await databaseAllowsConnections(plan.previousDatabase), false);
  assert.equal(await markerName(plan.activeDatabase, markerId), archivedMarker);
  assert.equal(await databaseContentSignal(plan.activeDatabase), archivedContent);
  await inspectLockedDatabase(plan.previousDatabase, async () => {
    assert.equal(await markerName(plan.previousDatabase, markerId), currentMarker);
    assert.equal(await databaseContentSignal(plan.previousDatabase), currentContent);
  });
  assert.equal(await databaseAllowsConnections(plan.previousDatabase), false);

  const rollbackResult = await rollbackDisposableScheduleDatabase(plan);
  assert.deepEqual(rollbackResult, {
    activeDatabase: plan.activeDatabase,
    rejectedDatabase: plan.rejectedDatabase,
  });
  await assertRoleExistence(plan, {
    activeDatabase: true,
    stagingDatabase: false,
    previousDatabase: false,
    rejectedDatabase: true,
    referenceDatabase: false,
  });

  assert.equal(
    await databaseOid(plan.activeDatabase),
    originalActiveOid,
    "rollback must restore the original active OID",
  );
  assert.equal(
    await databaseOid(plan.rejectedDatabase),
    restoredActiveOid,
    "rollback must retain the restored OID under the rejected role",
  );
  assert.equal(await databaseAllowsConnections(plan.activeDatabase), true);
  assert.equal(await databaseAllowsConnections(plan.rejectedDatabase), false);
  assert.equal(await markerName(plan.activeDatabase, markerId), currentMarker);
  assert.equal(await databaseContentSignal(plan.activeDatabase), currentContent);
  await inspectLockedDatabase(plan.rejectedDatabase, async () => {
    assert.equal(await markerName(plan.rejectedDatabase, markerId), archivedMarker);
    assert.equal(await databaseContentSignal(plan.rejectedDatabase), archivedContent);
  });
  assert.equal(await databaseAllowsConnections(plan.rejectedDatabase), false);

  await cleanupDisposableRecoveryDatabase(plan, "rejected");
  assert.equal(await databaseExists(plan.rejectedDatabase), false);
  console.log(
    "Disposable recovery state-machine verification passed restore, promotion, rollback, and cleanup.",
  );
} catch (error) {
  verificationFailure = error;
} finally {
  cleanupFailures.push(...(await forceCleanupOwnedDatabases([...cleanupEligibleDatabases])));
  try {
    await rm(temporaryDirectory, { recursive: true, force: true });
  } catch (error) {
    cleanupFailures.push(
      new Error(`remove disposable archive directory: ${errorMessage(error)}`, { cause: error }),
    );
  }
  try {
    await stat(temporaryDirectory);
    cleanupFailures.push(
      new Error(`disposable archive directory still exists: ${temporaryDirectory}`),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      cleanupFailures.push(
        new Error(`confirm disposable archive removal: ${errorMessage(error)}`, { cause: error }),
      );
    }
  }
  for (const databaseName of cleanupEligibleDatabases) {
    try {
      assert.equal(
        await databaseExists(databaseName),
        false,
        `generated database must not remain: ${databaseName}`,
      );
    } catch (error) {
      cleanupFailures.push(
        new Error(`confirm removal of ${databaseName}: ${errorMessage(error)}`, { cause: error }),
      );
    }
  }
}

if (verificationFailure !== undefined || cleanupFailures.length > 0) {
  throw new AggregateError(
    [verificationFailure, ...cleanupFailures].filter(
      (failure): failure is NonNullable<typeof failure> => failure !== undefined,
    ),
    [
      "Disposable recovery state-machine verification or cleanup failed.",
      `Recovery nonce: ${plan.nonce}.`,
      "Every recovery database name owned by this run was independently inspected for force-cleanup; pre-existing collisions were never removed.",
    ].join("\n"),
    verificationFailure === undefined ? undefined : { cause: verificationFailure },
  );
}
