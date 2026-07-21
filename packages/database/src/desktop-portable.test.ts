import { access, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import {
  classifyDesktopImportRecoveryTopology,
  createGuardedDesktopVerificationDatabase,
  desktopMigrationInvocation,
  desktopPortableInspectSuccessPrefix,
  desktopPortableImportSuccessPrefix,
  desktopPortableRecoverySuccessPrefix,
  desktopPortableSuccessPrefix,
  desktopVerificationClusterToken,
  desktopVerificationDatabaseName,
  desktopVerificationDatabaseOwnershipMarker,
  dropGuardedDesktopVerificationDatabase,
  exportDesktopPortableScheduleData,
  parseDesktopPortableExport,
  parseDesktopPortableCommand,
  readDesktopImportJournal,
  readDesktopPortableEnvironment,
  reclaimStaleDesktopVerificationDatabases,
  recoverDesktopPortableImport,
  runDesktopPortableCli,
  scavengeDesktopImportJournalTemporaries,
  selectStaleDesktopVerificationDatabases,
  writeDesktopImportJournal,
  type DesktopImportJournalV1,
  type DesktopPortableEnvironment,
  type DesktopPortableRecoveryEnvironment,
  type DesktopVerificationDatabaseIdentity,
} from "./desktop-portable.js";
import { portablePromotionOperations } from "./portable-import.js";

describe("desktop portable helper boundary", () => {
  it("accepts only an absolute new schedule destination", () => {
    const destination = path.join(path.parse(process.cwd()).root, "exports", "data.schedule");
    expect(parseDesktopPortableExport(["export", destination])).toBe(destination);
    expect(() => parseDesktopPortableExport(["export", "data.schedule"])).toThrow(/invalid/);
  });
  it("admits only absolute schedule sources for inspection and import", () => {
    const source = path.join(path.parse(process.cwd()).root, "exports", "data.schedule");
    expect(parseDesktopPortableCommand(["inspect", source])).toEqual({ kind: "inspect", source });
    expect(parseDesktopPortableCommand(["import", source])).toEqual({ kind: "import", source });
    expect(parseDesktopPortableCommand(["recover"])).toEqual({ kind: "recover" });
    expect(() => parseDesktopPortableCommand(["import", "data.schedule"])).toThrow(/invalid/);
  });
  it("treats a missing import journal as a database-free recovery no-op", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "schedule-import-no-journal-test-"));
    const environment: DesktopPortableRecoveryEnvironment = {
      databaseUrl: "postgres://owner:secret@127.0.0.1:1/schedule",
      adminDatabaseUrl: "postgres://admin:secret@127.0.0.1:1/postgres",
      nodeExecutable: path.join(directory, "node"),
      migrationEntrypoint: path.join(directory, "migrate.js"),
      applicationVersion: "1.2.3",
      databaseName: "schedule",
      clusterAdminRole: "schedule_admin",
      ownerRole: "schedule_owner",
      runtimeRole: "schedule_runtime",
      importJournalPath: path.join(directory, "portable-import-journal.v1.json"),
    };
    try {
      await expect(recoverDesktopPortableImport(environment)).resolves.toEqual({
        recovered: false,
        state: "no-journal",
        previousRetained: false,
        committed: false,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it.runIf(process.platform === "win32")(
    "accepts the same Windows journal directory through alternate path casing",
    async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "Schedule-Import-Case-Test-"));
      const alternateCaseDirectory = directory.toUpperCase();
      try {
        await expect(
          recoverDesktopPortableImport({
            databaseUrl: "postgres://owner:secret@127.0.0.1:1/schedule",
            adminDatabaseUrl: "postgres://admin:secret@127.0.0.1:1/postgres",
            nodeExecutable: path.join(alternateCaseDirectory, "node"),
            migrationEntrypoint: path.join(alternateCaseDirectory, "migrate.js"),
            applicationVersion: "1.2.3",
            databaseName: "schedule",
            clusterAdminRole: "schedule_admin",
            ownerRole: "schedule_owner",
            runtimeRole: "schedule_runtime",
            importJournalPath: path.join(alternateCaseDirectory, "portable-import-journal.v1.json"),
          }),
        ).resolves.toMatchObject({ state: "no-journal" });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
  it("requires every packaged runtime input", () => {
    expect(() => readDesktopPortableEnvironment({ DATABASE_URL: "postgres://x/y" })).toThrow(
      /invalid/,
    );
  });
  it("runs packaged migrate.js with no mode argument and a minimal child environment", () => {
    const environment: DesktopPortableEnvironment = {
      databaseUrl: "postgres://source-secret@localhost/schedule",
      adminDatabaseUrl: "postgres://admin-secret@localhost/postgres",
      nodeExecutable: "C:\\runtime\\node.exe",
      migrationEntrypoint: "C:\\runtime\\database\\dist\\migrate.js",
      applicationVersion: "1.2.3",
      databaseName: "schedule",
      clusterAdminRole: "schedule_admin",
      ownerRole: "schedule_owner",
      runtimeRole: "schedule_runtime",
    };
    const invocation = desktopMigrationInvocation(
      environment,
      "postgres://verification-secret@localhost/schedule_verify_x",
    );
    expect(invocation.args).toEqual([environment.migrationEntrypoint]);
    expect(invocation.args).not.toContain("export");
    expect(Object.keys(invocation.env).sort()).toEqual([
      "DATABASE_URL",
      "DOTENV_CONFIG_DEBUG",
      "DOTENV_CONFIG_QUIET",
    ]);
    expect(JSON.stringify(invocation)).not.toContain("source-secret");
    expect(JSON.stringify(invocation)).not.toContain("admin-secret");
  });
  it("wires the production entrypoint to lifecycle, migration, and export dependencies", async () => {
    const temporaryDirectory = await mkdtemp(path.join(tmpdir(), "schedule-desktop-export-test-"));
    const destination = path.join(temporaryDirectory, "portable.schedule");
    const calls: string[] = [];
    const environment: DesktopPortableEnvironment = {
      databaseUrl: "postgres://source@127.0.0.1:5432/schedule",
      adminDatabaseUrl: "postgres://admin@127.0.0.1:5432/postgres",
      nodeExecutable: "C:\\runtime\\node.exe",
      migrationEntrypoint: "C:\\runtime\\database\\dist\\migrate.js",
      applicationVersion: "1.2.3",
      databaseName: "schedule",
      clusterAdminRole: "schedule_admin",
      ownerRole: "schedule_owner",
      runtimeRole: "schedule_runtime",
    };
    try {
      const result = await exportDesktopPortableScheduleData(destination, environment, {
        prepareLifecycle: async (source, admin) => {
          calls.push(`prepare:${source}:${admin}`);
          return {
            verificationDatabaseName: () => "schedule_verify_01234567_00000001_0123456789abcdef",
            verificationDatabaseUrl: (name) => `postgres://verify@127.0.0.1/${name}`,
            createVerificationDatabase: async (_name, _url, onCreated) => {
              calls.push("create");
              onCreated();
            },
            dropVerificationDatabase: async () => {
              calls.push("drop");
            },
          };
        },
        runChild: async (executable, args, env) => {
          calls.push(`child:${executable}:${args.join(",")}:${Object.keys(env).sort().join(",")}`);
        },
        exportDatabase: async (options) => {
          calls.push(`export:${options.outputPath}`);
          const name = options.verificationDatabaseName!();
          const url = options.verificationDatabaseUrl!(name);
          await options.createVerificationDatabase(name, url, () => undefined);
          await options.migrateVerificationDatabase(name, url);
          await options.dropVerificationDatabase(name);
          return { path: destination, sizeBytes: 7, manifest: {} as never };
        },
      });
      expect(result).toEqual({ sizeBytes: 7 });
      expect(calls).toEqual([
        `prepare:${environment.databaseUrl}:${environment.adminDatabaseUrl}`,
        `export:${destination}`,
        "create",
        `child:${environment.nodeExecutable}:${environment.migrationEntrypoint}:DATABASE_URL,DOTENV_CONFIG_DEBUG,DOTENV_CONFIG_QUIET`,
        "drop",
      ]);
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it("selects only exact marked stale database identities", () => {
    const systemIdentifier = "1234567890123456789";
    const otherSystemIdentifier = "9876543210987654321";
    const token = desktopVerificationClusterToken(systemIdentifier);
    const otherToken = desktopVerificationClusterToken(otherSystemIdentifier);
    const admin = "schedule_admin";
    const now = 2_000_000_000;
    const oldest = desktopVerificationDatabaseName(token, now - 30_000);
    const stale = desktopVerificationDatabaseName(token, now - 25_000);
    const fresh = desktopVerificationDatabaseName(token, now - 60);
    const foreign = desktopVerificationDatabaseName(otherToken, now - 30_000);
    const unmarked = desktopVerificationDatabaseName(token, now - 29_000);
    const forged = desktopVerificationDatabaseName(token, now - 28_000);
    const forgedSystemIdentifier = desktopVerificationDatabaseName(token, now - 27_500);
    const wrongOwner = desktopVerificationDatabaseName(token, now - 27_000);
    const wrongCurrentAdmin = desktopVerificationDatabaseName(token, now - 26_500);
    const template = desktopVerificationDatabaseName(token, now - 26_000);
    const identity = (
      databaseName: string,
      overrides: Partial<DesktopVerificationDatabaseIdentity> = {},
    ): DesktopVerificationDatabaseIdentity => ({
      databaseOid: "10001",
      databaseName,
      ownershipMarker: desktopVerificationDatabaseOwnershipMarker(
        databaseName === foreign ? otherSystemIdentifier : systemIdentifier,
        databaseName,
      ),
      databaseOwner: admin,
      currentAdmin: admin,
      systemIdentifier: databaseName === foreign ? otherSystemIdentifier : systemIdentifier,
      isTemplate: false,
      ...overrides,
    });

    expect(desktopVerificationDatabaseOwnershipMarker(systemIdentifier, stale)).toBe(
      `schedule:desktop-portable-verification-database:v1:${systemIdentifier}:${stale}`,
    );
    expect(
      selectStaleDesktopVerificationDatabases(
        [
          identity(fresh),
          identity(foreign),
          identity(unmarked, { ownershipMarker: null }),
          identity(forged, {
            ownershipMarker: desktopVerificationDatabaseOwnershipMarker(systemIdentifier, stale),
          }),
          identity(forgedSystemIdentifier, {
            ownershipMarker: `schedule:desktop-portable-verification-database:v1:${otherSystemIdentifier}:${forgedSystemIdentifier}`,
          }),
          identity(wrongOwner, { databaseOwner: "somebody_else" }),
          identity(wrongCurrentAdmin, { currentAdmin: "somebody_else" }),
          identity(template, { isTemplate: true }),
          identity(stale),
          identity(oldest),
          {
            databaseOid: "10002",
            databaseName: "schedule_verify_0123456789abcdef0123456789abcdef",
            ownershipMarker: "unreadable-or-malformed",
            databaseOwner: admin,
            currentAdmin: admin,
            systemIdentifier,
            isTemplate: false,
          },
        ],
        systemIdentifier,
        admin,
        now,
      ),
    ).toEqual([oldest, stale]);
  });

  it("preserves stale identity mismatches before termination and the name-only drop", async () => {
    const systemIdentifier = "1234567890123456789";
    const token = desktopVerificationClusterToken(systemIdentifier);
    const admin = "schedule_admin";
    const now = 2_000_000_000;
    const oldest = desktopVerificationDatabaseName(token, now - 30_000);
    const changedBeforeTermination = desktopVerificationDatabaseName(token, now - 28_000);
    const unmarkedBeforeTermination = desktopVerificationDatabaseName(token, now - 27_000);
    const changedBeforeDrop = desktopVerificationDatabaseName(token, now - 25_000);
    const identity = (
      databaseName: string,
      databaseOid: string,
    ): DesktopVerificationDatabaseIdentity => ({
      databaseOid,
      databaseName,
      ownershipMarker: desktopVerificationDatabaseOwnershipMarker(systemIdentifier, databaseName),
      databaseOwner: admin,
      currentAdmin: admin,
      systemIdentifier,
      isTemplate: false,
    });
    const dropped: string[] = [];
    const terminated: string[] = [];
    let changedBeforeDropReads = 0;
    await expect(
      reclaimStaleDesktopVerificationDatabases(systemIdentifier, admin, now, {
        listCandidates: async () => [
          identity(changedBeforeDrop, "10003"),
          identity(unmarkedBeforeTermination, "10004"),
          identity(changedBeforeTermination, "10002"),
          identity(oldest, "10001"),
        ],
        revalidateCandidate: async (name) => {
          if (name === changedBeforeTermination) {
            return identity(name, "90002");
          }
          if (name === unmarkedBeforeTermination) {
            return { ...identity(name, "10004"), ownershipMarker: null };
          }
          if (name !== changedBeforeDrop) return identity(name, "10001");
          changedBeforeDropReads += 1;
          return identity(name, changedBeforeDropReads === 1 ? "10003" : "90003");
        },
        terminateCandidateConnections: async ({ databaseName, databaseOid }) => {
          terminated.push(`${databaseName}:${databaseOid}`);
        },
        dropCandidate: async (name) => {
          dropped.push(name);
        },
      }),
    ).resolves.toEqual([oldest]);
    expect(terminated).toEqual([`${oldest}:10001`, `${changedBeforeDrop}:10003`]);
    expect(dropped).toEqual([oldest]);
  });

  it("uses the same OID guard for a remembered same-run database", async () => {
    const systemIdentifier = "1234567890123456789";
    const admin = "schedule_admin";
    const databaseName = desktopVerificationDatabaseName(
      desktopVerificationClusterToken(systemIdentifier),
      2_000_000_000,
    );
    const identity = (databaseOid: string): DesktopVerificationDatabaseIdentity => ({
      databaseOid,
      databaseName,
      ownershipMarker: desktopVerificationDatabaseOwnershipMarker(systemIdentifier, databaseName),
      databaseOwner: admin,
      currentAdmin: admin,
      systemIdentifier,
      isTemplate: false,
    });
    const events: string[] = [];
    let reads = 0;
    await expect(
      dropGuardedDesktopVerificationDatabase(
        { databaseName, databaseOid: "10001" },
        systemIdentifier,
        admin,
        "exact-or-null-for-same-run",
        {
          revalidateCandidate: async () => {
            events.push("read");
            reads += 1;
            return identity(reads === 1 ? "10001" : "90001");
          },
          terminateCandidateConnections: async ({ databaseOid }) => {
            events.push(`terminate:${databaseOid}`);
          },
          dropCandidate: async () => {
            events.push("drop");
          },
        },
      ),
    ).resolves.toBe(false);
    expect(events).toEqual(["read", "terminate:10001", "read"]);
  });

  it.each(["comment", "post-comment identity read"] as const)(
    "cleans the captured OID after an injected %s failure",
    async (fault) => {
      const systemIdentifier = "1234567890123456789";
      const admin = "schedule_admin";
      const databaseName = desktopVerificationDatabaseName(
        desktopVerificationClusterToken(systemIdentifier),
        2_000_000_000,
      );
      const exactMarker = desktopVerificationDatabaseOwnershipMarker(
        systemIdentifier,
        databaseName,
      );
      let marker: string | null = null;
      let reads = 0;
      let captured:
        Pick<DesktopVerificationDatabaseIdentity, "databaseOid" | "databaseName"> | undefined;
      const events: string[] = [];
      const identity = (): DesktopVerificationDatabaseIdentity => ({
        databaseOid: "10001",
        databaseName,
        ownershipMarker: marker,
        databaseOwner: admin,
        currentAdmin: admin,
        systemIdentifier,
        isTemplate: false,
      });

      await expect(
        createGuardedDesktopVerificationDatabase(
          databaseName,
          systemIdentifier,
          admin,
          (value) => {
            events.push("captured");
            captured = value;
          },
          {
            createCandidate: async () => {
              events.push("create");
            },
            readCandidate: async () => {
              reads += 1;
              events.push(reads === 1 ? "read-base" : "read-marked");
              if (fault === "post-comment identity read" && reads === 2) {
                throw new Error("injected post-comment read failure");
              }
              return identity();
            },
            markCandidate: async (_name, value) => {
              events.push("comment");
              if (fault === "comment") throw new Error("injected comment failure");
              marker = value;
            },
          },
        ),
      ).rejects.toThrow("injected");
      expect(captured).toEqual({ databaseOid: "10001", databaseName });
      if (captured === undefined) throw new Error("test failed to capture database identity");

      await expect(
        dropGuardedDesktopVerificationDatabase(
          captured,
          systemIdentifier,
          admin,
          "exact-or-null-for-same-run",
          {
            revalidateCandidate: async () => {
              events.push("cleanup-read");
              return identity();
            },
            terminateCandidateConnections: async ({ databaseOid }) => {
              events.push(`terminate:${databaseOid}`);
            },
            dropCandidate: async () => {
              events.push("drop");
            },
          },
        ),
      ).resolves.toBe(true);
      expect(events).toEqual([
        "create",
        "read-base",
        "captured",
        "comment",
        ...(fault === "post-comment identity read" ? ["read-marked"] : []),
        "cleanup-read",
        "terminate:10001",
        "cleanup-read",
        "drop",
      ]);
      expect(marker).toBe(fault === "comment" ? null : exactMarker);
    },
  );

  it("does not register name-only ownership when the immediate OID read fails", async () => {
    const systemIdentifier = "1234567890123456789";
    const databaseName = desktopVerificationDatabaseName(
      desktopVerificationClusterToken(systemIdentifier),
      2_000_000_000,
    );
    let captured = false;
    await expect(
      createGuardedDesktopVerificationDatabase(
        databaseName,
        systemIdentifier,
        "schedule_admin",
        () => {
          captured = true;
        },
        {
          createCandidate: async () => undefined,
          readCandidate: async () => {
            throw new Error("injected base identity read failure");
          },
          markCandidate: async () => {
            throw new Error("marker must not run");
          },
        },
      ),
    ).rejects.toThrow("injected base identity read failure");
    expect(captured).toBe(false);
  });

  it("reclaims at most the oldest eight exact marked databases per invocation", async () => {
    const systemIdentifier = "1234567890123456789";
    const token = desktopVerificationClusterToken(systemIdentifier);
    const admin = "schedule_admin";
    const now = 2_000_000_000;
    const identities = Array.from({ length: 9 }, (_, index) =>
      desktopVerificationDatabaseName(token, now - 30_000 - index),
    ).map((databaseName, index): DesktopVerificationDatabaseIdentity => ({
      databaseOid: String(10_000 + index),
      databaseName,
      ownershipMarker: desktopVerificationDatabaseOwnershipMarker(systemIdentifier, databaseName),
      databaseOwner: admin,
      currentAdmin: admin,
      systemIdentifier,
      isTemplate: false,
    }));
    const expected = selectStaleDesktopVerificationDatabases(
      identities,
      systemIdentifier,
      admin,
      now,
    );
    const dropped: string[] = [];
    await expect(
      reclaimStaleDesktopVerificationDatabases(systemIdentifier, admin, now, {
        listCandidates: async () => identities,
        revalidateCandidate: async (name) => identities.find((row) => row.databaseName === name),
        terminateCandidateConnections: async () => undefined,
        dropCandidate: async (name) => {
          dropped.push(name);
        },
      }),
    ).resolves.toEqual(expected);
    expect(dropped).toEqual(expected);
    expect(dropped).toHaveLength(8);
    expect(dropped).not.toContain(identities[0]!.databaseName);
  });

  it("emits an exact success record and redacts all failure details", async () => {
    const root = path.parse(process.cwd()).root;
    const destination = path.join(root, "exports", "data.schedule");
    const environment = {
      DATABASE_URL: "postgres://source@localhost/schedule",
      SCHEDULE_ADMIN_DATABASE_URL: "postgres://admin@localhost/postgres",
      SCHEDULE_NODE_EXECUTABLE: path.join(root, "runtime", "node"),
      SCHEDULE_MIGRATION_ENTRYPOINT: path.join(root, "runtime", "database", "dist", "migrate.js"),
      SCHEDULE_APPLICATION_VERSION: "1.2.3",
      SCHEDULE_DATABASE_NAME: "schedule",
      SCHEDULE_CLUSTER_ADMIN_ROLE: "schedule_admin",
      SCHEDULE_OWNER_ROLE: "schedule_owner",
      SCHEDULE_RUNTIME_ROLE: "schedule_runtime",
    };
    const stdout: string[] = [];
    const stderr: string[] = [];
    await expect(
      runDesktopPortableCli(["export", destination], environment, {
        stdout: (value) => stdout.push(value),
        stderr: (value) => stderr.push(value),
        exportSchedule: async () => ({ sizeBytes: 42 }),
      }),
    ).resolves.toBe(true);
    expect(stdout).toEqual([`${desktopPortableSuccessPrefix}{"sizeBytes":42}\n`]);
    expect(stderr).toEqual([]);

    stdout.length = 0;
    await expect(
      runDesktopPortableCli(["export", destination], environment, {
        stdout: (value) => stdout.push(value),
        stderr: (value) => stderr.push(value),
        exportSchedule: async () => {
          throw new Error("postgres://admin:secret@localhost/postgres");
        },
      }),
    ).resolves.toBe(false);
    expect(stdout).toEqual([]);
    expect(stderr).toEqual(["Schedule portable export failed.\n"]);
  });

  it("emits an import completion record only after its runtime adapter succeeds", async () => {
    const root = path.parse(process.cwd()).root;
    const source = path.join(root, "exports", "data.schedule");
    const environment = {
      DATABASE_URL: "postgres://source@localhost/schedule",
      SCHEDULE_ADMIN_DATABASE_URL: "postgres://admin@localhost/postgres",
      SCHEDULE_NODE_EXECUTABLE: path.join(root, "runtime", "node"),
      SCHEDULE_MIGRATION_ENTRYPOINT: path.join(root, "runtime", "database", "dist", "migrate.js"),
      SCHEDULE_APPLICATION_VERSION: "1.2.3",
      SCHEDULE_DATABASE_NAME: "schedule",
      SCHEDULE_CLUSTER_ADMIN_ROLE: "schedule_admin",
      SCHEDULE_OWNER_ROLE: "schedule_owner",
      SCHEDULE_RUNTIME_ROLE: "schedule_runtime",
      SCHEDULE_EXPECTED_ARCHIVE_ID: "01234567-89ab-4cde-8fab-0123456789ab",
      SCHEDULE_EXPECTED_ARCHIVE_SHA256: "a".repeat(64),
      SCHEDULE_PORTABLE_IMPORT_JOURNAL: path.join(root, "runtime", "import-journal.json"),
    };
    const stdout: string[] = [];
    await expect(
      runDesktopPortableCli(["import", source], environment, {
        stdout: (value) => stdout.push(value),
        stderr: () => undefined,
        importSchedule: async (actualSource) => {
          expect(actualSource).toBe(source);
          return {
            archiveId: "01234567-89ab-4cde-8fab-0123456789ab",
            committed: true,
          };
        },
      }),
    ).resolves.toBe(true);
    expect(stdout).toEqual([`${desktopPortableImportSuccessPrefix}{"previousRetained":true}\n`]);
  });

  it("emits a bounded inspection record without exposing the selected path", async () => {
    const root = path.parse(process.cwd()).root;
    const source = path.join(root, "private", "selected.schedule");
    const stdout: string[] = [];
    await expect(
      runDesktopPortableCli(
        ["inspect", source],
        {},
        {
          stdout: (value) => stdout.push(value),
          stderr: () => undefined,
          inspectSchedule: async () => ({
            archiveId: "01234567-89ab-4cde-8fab-0123456789ab",
            archiveSha256: "a".repeat(64),
            exportedAt: "2026-07-21T00:00:00.000Z",
            applicationVersion: "1.2.3",
            schemaVersion: 42,
            sizeBytes: 123,
          }),
        },
      ),
    ).resolves.toBe(true);
    expect(stdout).toEqual([
      `${desktopPortableInspectSuccessPrefix}{"archiveId":"01234567-89ab-4cde-8fab-0123456789ab","archiveSha256":"${"a".repeat(64)}","exportedAt":"2026-07-21T00:00:00.000Z","applicationVersion":"1.2.3","schemaVersion":42,"sizeBytes":123}\n`,
    ]);
    expect(stdout.join("")).not.toContain(source);
  });

  it("writes and replaces a bounded secret-free versioned journal", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "schedule-import-journal-test-"));
    const journalPath = path.join(directory, "import-journal.json");
    const journal: DesktopImportJournalV1 = {
      format: "schedule.desktop-portable-import-journal",
      version: 1,
      archiveId: "01234567-89ab-4cde-8fab-0123456789ab",
      clusterSystemIdentifier: "1234567890123456789",
      phase: "prepared",
      active: { name: "schedule", oid: 100, owner: "schedule_owner" },
      staging: {
        name: `schedule_restore_${"a".repeat(32)}`,
        oid: 101,
        owner: "schedule_owner",
      },
      previous: {
        name: `schedule_previous_${"b".repeat(32)}`,
        oid: 100,
        owner: "schedule_owner",
      },
    };
    try {
      const allocation: DesktopImportJournalV1 = {
        ...journal,
        phase: "allocating-staging",
        staging: { ...journal.staging, oid: 0 },
      };
      await writeDesktopImportJournal(journalPath, allocation, true);
      expect(await readDesktopImportJournal(journalPath)).toEqual(allocation);
      await writeDesktopImportJournal(journalPath, journal);
      expect(await readDesktopImportJournal(journalPath)).toEqual(journal);
      await writeDesktopImportJournal(journalPath, { ...journal, phase: "committed" });
      expect((await readDesktopImportJournal(journalPath))?.phase).toBe("committed");
      expect(await readFile(journalPath, "utf8")).not.toMatch(/postgres|password|secret/i);

      const staleTemporary = path.join(directory, `.import-journal.json.${"a".repeat(24)}.tmp`);
      const malformedTemporary = path.join(directory, `.import-journal.json.${"b".repeat(24)}.tmp`);
      await writeFile(staleTemporary, `${JSON.stringify(allocation)}\n`);
      await writeFile(malformedTemporary, "not a journal\n");
      const now = Date.now();
      const stale = new Date(now - 25 * 60 * 60 * 1_000);
      await utimes(staleTemporary, stale, stale);
      await utimes(malformedTemporary, stale, stale);
      await expect(scavengeDesktopImportJournalTemporaries(journalPath, now)).resolves.toBe(1);
      await expect(access(staleTemporary)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(malformedTemporary)).resolves.toBeUndefined();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(
    portablePromotionOperations.flatMap((operation) => [
      `before-${operation}`,
      `after-operation:${operation}`,
      `after-${operation}`,
    ]),
  )("reconciles the exact catalog topology at the %s crash boundary", (faultPoint) => {
    const operationName = faultPoint.replace(/^before-|^after-operation:|^after-/, "");
    const operationIndex = portablePromotionOperations.indexOf(
      operationName as (typeof portablePromotionOperations)[number],
    );
    const completed = operationIndex + (faultPoint.startsWith("before-") ? 0 : 1);
    const topology =
      completed > portablePromotionOperations.indexOf("promote-staging")
        ? ({ active: "new", staging: "missing", previous: "old" } as const)
        : completed > portablePromotionOperations.indexOf("rename-active")
          ? ({ active: "missing", staging: "new", previous: "old" } as const)
          : ({ active: "old", staging: "new", previous: "missing" } as const);
    expect(classifyDesktopImportRecoveryTopology(topology)).toBe(
      topology.active === "new" ? "finish-new" : "restore-old",
    );
  });

  it.each([
    ["prepared", { active: "old", staging: "new", previous: "missing" }, "restore-old"],
    ["committed", { active: "new", staging: "missing", previous: "old" }, "finish-new"],
  ] as const)("reconciles the %s journal boundary", (_phase, topology, expected) => {
    expect(classifyDesktopImportRecoveryTopology(topology)).toBe(expected);
  });

  it("rejects a recovery topology containing any unbound database identity", () => {
    expect(() =>
      classifyDesktopImportRecoveryTopology({
        active: "other",
        staging: "new",
        previous: "missing",
      }),
    ).toThrow(/recovery failed/);
  });

  it("emits the exact bounded recovery protocol without requiring an archive identity", async () => {
    const root = path.parse(process.cwd()).root;
    const environment = {
      DATABASE_URL: "postgres://source@localhost/schedule",
      SCHEDULE_ADMIN_DATABASE_URL: "postgres://admin@localhost/postgres",
      SCHEDULE_NODE_EXECUTABLE: path.join(root, "runtime", "node"),
      SCHEDULE_MIGRATION_ENTRYPOINT: path.join(root, "runtime", "database", "dist", "migrate.js"),
      SCHEDULE_APPLICATION_VERSION: "1.2.3",
      SCHEDULE_DATABASE_NAME: "schedule",
      SCHEDULE_CLUSTER_ADMIN_ROLE: "schedule_admin",
      SCHEDULE_OWNER_ROLE: "schedule_owner",
      SCHEDULE_RUNTIME_ROLE: "schedule_runtime",
      SCHEDULE_PORTABLE_IMPORT_JOURNAL: path.join(root, "runtime", "import-journal.json"),
    };
    const stdout: string[] = [];
    await expect(
      runDesktopPortableCli(["recover"], environment, {
        stdout: (value) => stdout.push(value),
        stderr: () => undefined,
        recoverImport: async () => ({
          recovered: true,
          state: "committed-new-active",
          archiveId: "01234567-89ab-4cde-8fab-0123456789ab",
          previousRetained: true,
          committed: true,
        }),
      }),
    ).resolves.toBe(true);
    expect(stdout).toEqual([
      `${desktopPortableRecoverySuccessPrefix}{"recovered":true,"committed":true}\n`,
    ]);
  });
});
