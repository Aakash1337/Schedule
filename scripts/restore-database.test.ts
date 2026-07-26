import { describe, expect, it } from "vitest";

import {
  assertDisposableRecoveryPlan,
  assertDisposableRecoveryPreflight,
  cleanupOwnedRestoreStagingAfterFailure,
  createDisposableRecoveryPlan,
  promoteDisposableRecoveryStaging,
  restoreDisposableScheduleDatabase,
  rollbackDisposableRecoveryNames,
  type RecoveryDatabaseOperations,
} from "./restore-database.js";

interface FakeDatabase {
  allowsConnections: boolean;
  readonly marker: string;
}

interface FakeFailureHooks {
  readonly rename?: (source: string, target: string) => Error | undefined;
  readonly setConnections?: (databaseName: string, allowsConnections: boolean) => Error | undefined;
}

function fakeOperations(
  databases: Map<string, FakeDatabase>,
  hooks: FakeFailureHooks = {},
): RecoveryDatabaseOperations {
  const identities = new WeakMap<FakeDatabase, number>();
  let nextIdentity = 1;
  return {
    databaseExists: async (databaseName) => databases.has(databaseName),
    databaseIdentity: async (databaseName) => {
      const database = databases.get(databaseName);
      if (database === undefined) return null;
      let identity = identities.get(database);
      if (identity === undefined) {
        identity = nextIdentity;
        nextIdentity += 1;
        identities.set(database, identity);
      }
      return identity;
    },
    databaseAllowsConnections: async (databaseName) => {
      const database = databases.get(databaseName);
      if (database === undefined) throw new Error(`missing database ${databaseName}`);
      return database.allowsConnections;
    },
    setDatabaseAllowsConnections: async (databaseName, allowsConnections) => {
      const failure = hooks.setConnections?.(databaseName, allowsConnections);
      if (failure !== undefined) throw failure;
      const database = databases.get(databaseName);
      if (database === undefined) throw new Error(`missing database ${databaseName}`);
      database.allowsConnections = allowsConnections;
    },
    terminateDatabaseConnections: async (databaseName) => {
      if (!databases.has(databaseName)) throw new Error(`missing database ${databaseName}`);
    },
    renameDatabase: async (source, target) => {
      const failure = hooks.rename?.(source, target);
      if (failure !== undefined) throw failure;
      const database = databases.get(source);
      if (database === undefined) throw new Error(`missing database ${source}`);
      if (databases.has(target)) throw new Error(`target exists ${target}`);
      databases.delete(source);
      databases.set(target, database);
    },
    dropDatabase: async (databaseName) => {
      databases.delete(databaseName);
    },
  };
}

describe("disposable recovery plan", () => {
  it("creates five distinct exact role names bound to one cryptographic nonce", () => {
    const plan = createDisposableRecoveryPlan();

    expect(() => assertDisposableRecoveryPlan(plan)).not.toThrow();
    expect(plan.nonce).toMatch(/^[a-f0-9]{32}$/);
    const names = [
      plan.activeDatabase,
      plan.stagingDatabase,
      plan.previousDatabase,
      plan.rejectedDatabase,
      plan.referenceDatabase,
    ];
    expect(new Set(names).size).toBe(5);
    expect(names).not.toContain("schedule");
    expect(plan.activeDatabase).toBe(`schedule_recovery_active_${plan.nonce}`);
    expect(plan.stagingDatabase).toBe(`schedule_recovery_staging_${plan.nonce}`);
    expect(plan.previousDatabase).toBe(`schedule_recovery_previous_${plan.nonce}`);
    expect(plan.rejectedDatabase).toBe(`schedule_recovery_rejected_${plan.nonce}`);
    expect(plan.referenceDatabase).toBe(`schedule_recovery_reference_${plan.nonce}`);
  });

  it("rejects mixed nonces, duplicate roles, malformed nonces, and the bare schedule name", () => {
    const plan = createDisposableRecoveryPlan();
    const other = createDisposableRecoveryPlan();

    expect(() =>
      assertDisposableRecoveryPlan({ ...plan, stagingDatabase: other.stagingDatabase }),
    ).toThrow(/bound to the plan nonce/);
    expect(() =>
      assertDisposableRecoveryPlan({ ...plan, rejectedDatabase: plan.previousDatabase }),
    ).toThrow(/distinct/);
    expect(() => assertDisposableRecoveryPlan({ ...plan, nonce: "not-a-nonce" })).toThrow(
      /128 bits/,
    );
    expect(() => assertDisposableRecoveryPlan({ ...plan, activeDatabase: "schedule" })).toThrow(
      /bare schedule/,
    );
  });

  it("refuses any role collision before exposing a mutation operation", async () => {
    const plan = createDisposableRecoveryPlan();
    const checked: string[] = [];
    const existenceOnly = {
      databaseExists: async (databaseName: string) => {
        checked.push(databaseName);
        return databaseName === plan.activeDatabase || databaseName === plan.rejectedDatabase;
      },
    };

    await expect(assertDisposableRecoveryPreflight(plan, "restore", existenceOnly)).rejects.toThrow(
      new RegExp(`rejected=${plan.rejectedDatabase} expected absent`),
    );
    expect(checked).toHaveLength(5);
  });

  it("fails closed before mixing native SQL with Compose archive restore", async () => {
    const previousBin = process.env.SCHEDULE_VERIFIER_POSTGRES_BIN;
    const previousUrl = process.env.SCHEDULE_VERIFIER_DATABASE_URL;
    process.env.SCHEDULE_VERIFIER_POSTGRES_BIN = process.cwd();
    process.env.SCHEDULE_VERIFIER_DATABASE_URL =
      "postgres://verifier:secret@localhost:5432/postgres";
    try {
      await expect(
        restoreDisposableScheduleDatabase("unused.dump", createDisposableRecoveryPlan()),
      ).rejects.toThrow(/Compose-only/);
    } finally {
      if (previousBin === undefined) delete process.env.SCHEDULE_VERIFIER_POSTGRES_BIN;
      else process.env.SCHEDULE_VERIFIER_POSTGRES_BIN = previousBin;
      if (previousUrl === undefined) delete process.env.SCHEDULE_VERIFIER_DATABASE_URL;
      else process.env.SCHEDULE_VERIFIER_DATABASE_URL = previousUrl;
    }
  });
});

describe("disposable recovery compensation", () => {
  it("cleans only a staging database whose creation was positively acknowledged", async () => {
    const plan = createDisposableRecoveryPlan();
    const originalFailure = new Error("restore failed");
    const unownedDatabases = new Map<string, FakeDatabase>([
      [plan.stagingDatabase, { allowsConnections: true, marker: "collision" }],
    ]);

    await expect(
      cleanupOwnedRestoreStagingAfterFailure(
        originalFailure,
        plan.stagingDatabase,
        null,
        fakeOperations(unownedDatabases),
      ),
    ).rejects.toBe(originalFailure);
    expect(unownedDatabases.get(plan.stagingDatabase)?.marker).toBe("collision");

    const ownedDatabases = new Map<string, FakeDatabase>([
      [plan.stagingDatabase, { allowsConnections: true, marker: "owned" }],
    ]);
    const ownedOperations = fakeOperations(ownedDatabases);
    const ownedIdentity = await ownedOperations.databaseIdentity(plan.stagingDatabase);
    await expect(
      cleanupOwnedRestoreStagingAfterFailure(
        originalFailure,
        plan.stagingDatabase,
        ownedIdentity,
        ownedOperations,
      ),
    ).rejects.toBe(originalFailure);
    expect(ownedDatabases.has(plan.stagingDatabase)).toBe(false);

    const replacedDatabases = new Map<string, FakeDatabase>([
      [plan.stagingDatabase, { allowsConnections: true, marker: "original-owned" }],
    ]);
    const replacedOperations = fakeOperations(replacedDatabases);
    const replacedIdentity = await replacedOperations.databaseIdentity(plan.stagingDatabase);
    replacedDatabases.set(plan.stagingDatabase, {
      allowsConnections: true,
      marker: "same-name-replacement",
    });
    await expect(
      cleanupOwnedRestoreStagingAfterFailure(
        originalFailure,
        plan.stagingDatabase,
        replacedIdentity,
        replacedOperations,
      ),
    ).rejects.toBeInstanceOf(AggregateError);
    expect(replacedDatabases.get(plan.stagingDatabase)?.marker).toBe("same-name-replacement");
  });

  it("restores the original active name when staging promotion fails mid-swap", async () => {
    const plan = createDisposableRecoveryPlan();
    const databases = new Map<string, FakeDatabase>([
      [plan.activeDatabase, { allowsConnections: true, marker: "original" }],
      [plan.stagingDatabase, { allowsConnections: true, marker: "restored" }],
    ]);
    let promotionFailureInjected = false;
    const operations = fakeOperations(databases, {
      rename: (source, target) => {
        if (
          !promotionFailureInjected &&
          source === plan.stagingDatabase &&
          target === plan.activeDatabase
        ) {
          promotionFailureInjected = true;
          return new Error("injected staging promotion failure");
        }
        return undefined;
      },
    });

    await expect(promoteDisposableRecoveryStaging(plan, operations)).rejects.toThrow(
      /Database promotion failed/,
    );
    expect(databases.get(plan.activeDatabase)).toEqual({
      allowsConnections: true,
      marker: "original",
    });
    expect(databases.get(plan.stagingDatabase)?.marker).toBe("restored");
    expect(databases.has(plan.previousDatabase)).toBe(false);
  });

  it("aggregates an unsafe compensation failure without overwriting an occupied name", async () => {
    const plan = createDisposableRecoveryPlan();
    const databases = new Map<string, FakeDatabase>([
      [plan.activeDatabase, { allowsConnections: true, marker: "original" }],
      [plan.stagingDatabase, { allowsConnections: true, marker: "restored" }],
    ]);
    const operations = fakeOperations(databases, {
      rename: (source, target) => {
        if (source === plan.stagingDatabase && target === plan.activeDatabase) {
          return new Error("injected promotion failure");
        }
        if (source === plan.previousDatabase && target === plan.activeDatabase) {
          return new Error("injected compensation failure");
        }
        return undefined;
      },
    });

    let caught: unknown;
    try {
      await promoteDisposableRecoveryStaging(plan, operations);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors.length).toBeGreaterThanOrEqual(3);
    expect(databases.has(plan.activeDatabase)).toBe(false);
    expect(databases.get(plan.previousDatabase)?.marker).toBe("original");
    expect(databases.get(plan.stagingDatabase)?.marker).toBe("restored");
  });

  it("undoes a rollback if enabling the promoted previous database fails", async () => {
    const plan = createDisposableRecoveryPlan();
    const databases = new Map<string, FakeDatabase>([
      [plan.activeDatabase, { allowsConnections: true, marker: "restored" }],
      [plan.previousDatabase, { allowsConnections: false, marker: "original" }],
    ]);
    let enableFailureInjected = false;
    const operations = fakeOperations(databases, {
      setConnections: (databaseName, allowsConnections) => {
        if (!enableFailureInjected && databaseName === plan.activeDatabase && allowsConnections) {
          enableFailureInjected = true;
          return new Error("injected enable failure");
        }
        return undefined;
      },
    });

    await expect(rollbackDisposableRecoveryNames(plan, operations)).rejects.toThrow(
      /Rollback failed/,
    );
    expect(databases.get(plan.activeDatabase)).toEqual({
      allowsConnections: true,
      marker: "restored",
    });
    expect(databases.get(plan.previousDatabase)).toEqual({
      allowsConnections: false,
      marker: "original",
    });
    expect(databases.has(plan.rejectedDatabase)).toBe(false);
  });
});
