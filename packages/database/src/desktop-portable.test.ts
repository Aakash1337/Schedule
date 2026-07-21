import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";
import {
  createGuardedDesktopVerificationDatabase,
  desktopMigrationInvocation,
  desktopPortableSuccessPrefix,
  desktopVerificationClusterToken,
  desktopVerificationDatabaseName,
  desktopVerificationDatabaseOwnershipMarker,
  dropGuardedDesktopVerificationDatabase,
  exportDesktopPortableScheduleData,
  parseDesktopPortableExport,
  readDesktopPortableEnvironment,
  reclaimStaleDesktopVerificationDatabases,
  runDesktopPortableCli,
  selectStaleDesktopVerificationDatabases,
  type DesktopPortableEnvironment,
  type DesktopVerificationDatabaseIdentity,
} from "./desktop-portable.js";

describe("desktop portable helper boundary", () => {
  it("accepts only an absolute new schedule destination", () => {
    const destination = path.join(path.parse(process.cwd()).root, "exports", "data.schedule");
    expect(parseDesktopPortableExport(["export", destination])).toBe(destination);
    expect(() => parseDesktopPortableExport(["export", "data.schedule"])).toThrow(/invalid/);
  });
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
});
