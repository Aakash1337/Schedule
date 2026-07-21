import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildDesktopRuntime, hashTree } from "./build-desktop-runtime.js";
import { DESKTOP_PORTABLE_MODULES } from "./desktop-portable-modules.js";
import { packageDesktopRelease, parseDesktopReleaseArguments } from "./package-desktop-release.js";

const temporaryDirectories: string[] = [];

async function fixture(): Promise<{ repository: string; runtime: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "schedule-desktop-package-"));
  temporaryDirectories.push(root);
  const api = path.join(root, "api");
  const worker = path.join(root, "worker");
  const node = path.join(root, "node");
  const postgresql = path.join(root, "postgresql");
  const runtime = path.join(root, "assembled-runtime");
  await Promise.all(
    [
      "api/dist",
      "api/node_modules/@schedule/database/dist",
      "api/node_modules/@schedule/database/drizzle/meta",
      "worker/dist",
      "node",
      "postgresql/bin",
      "postgresql/lib/postgresql",
      "postgresql/share/extension",
    ].map((directory) => mkdir(path.join(root, directory), { recursive: true })),
  );
  await Promise.all([
    writeFile(path.join(api, "dist/server.js"), "api"),
    writeFile(path.join(worker, "dist/index.js"), "worker"),
    writeFile(path.join(api, "node_modules/@schedule/database/dist/migrate.js"), "migrate"),
    writeFile(
      path.join(api, "node_modules/@schedule/database/dist/migration-ledger.js"),
      "migration ledger",
    ),
    writeFile(
      path.join(api, "node_modules/@schedule/database/dist/migration-sql.js"),
      "migration SQL safety",
    ),
    ...DESKTOP_PORTABLE_MODULES.map((file) =>
      writeFile(
        path.join(api, "node_modules/@schedule/database/dist", file),
        `desktop portable export module ${file}`,
      ),
    ),
    writeFile(
      path.join(api, "node_modules/@schedule/database/drizzle/meta/_journal.json"),
      JSON.stringify({
        version: "7",
        dialect: "postgresql",
        entries: [{ idx: 0, version: "7", when: 1, tag: "0000_initial", breakpoints: true }],
      }),
    ),
    writeFile(
      path.join(api, "node_modules/@schedule/database/drizzle/meta/_migration_manifest.json"),
      JSON.stringify({
        schemaVersion: 1,
        entries: [
          {
            tag: "0000_initial",
            createdAt: 1,
            sha256: createHash("sha256").update("select 1;").digest("hex"),
            compatibleSha256: [],
          },
        ],
      }),
    ),
    writeFile(
      path.join(api, "node_modules/@schedule/database/drizzle/0000_initial.sql"),
      "select 1;",
    ),
    writeFile(path.join(node, "node"), "node"),
    writeFile(path.join(postgresql, "share/postgresql.conf.sample"), "config"),
    writeFile(
      path.join(postgresql, "share/extension/pgcrypto.control"),
      "default_version = '1.3'\n",
    ),
    writeFile(path.join(postgresql, "share/extension/pgcrypto--1.3.sql"), "sql"),
    writeFile(path.join(postgresql, "lib/postgresql/pgcrypto.so"), "library"),
    ...["initdb", "pg_ctl", "pg_dump", "pg_isready", "pg_restore", "postgres", "psql"].map((tool) =>
      writeFile(path.join(postgresql, `bin/${tool}`), tool),
    ),
  ]);
  await buildDesktopRuntime({
    outputDirectory: runtime,
    target: { os: "linux", arch: "x86_64" },
    postgresqlMajor: 17,
    apiDeploymentDirectory: api,
    workerDeploymentDirectory: worker,
    nodeRuntimeDirectory: node,
    postgresqlRuntimeDirectory: postgresql,
    sources: {
      api: { version: "1.0.0", sha256: await hashTree(api) },
      worker: { version: "1.0.0", sha256: await hashTree(worker) },
      node: { version: "24.0.0", sha256: await hashTree(node) },
      postgresql: { version: "17.0", sha256: await hashTree(postgresql) },
    },
  });
  const repository = path.join(root, "repository");
  const tauriEntry = path.join(repository, "apps/desktop/node_modules/@tauri-apps/cli/tauri.js");
  await mkdir(path.dirname(tauriEntry), { recursive: true });
  await writeFile(tauriEntry, "fixture Tauri CLI");
  return { repository, runtime };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("packageDesktopRelease", () => {
  it("requires an explicit assembled runtime argument", () => {
    expect(parseDesktopReleaseArguments(["--runtime", "E:/runtime"])).toEqual({
      runtimeDirectory: "E:/runtime",
    });
    expect(parseDesktopReleaseArguments(["--", "--runtime", "E:/runtime"])).toEqual({
      runtimeDirectory: "E:/runtime",
    });
    expect(() => parseDesktopReleaseArguments([])).toThrow("Usage");
    expect(() => parseDesktopReleaseArguments(["--", "--", "--runtime", "E:/runtime"])).toThrow(
      "Usage",
    );
  });

  it("stages a verified runtime, binds its manifest hash, and cleans owned staging", async () => {
    const { repository, runtime } = await fixture();
    let command = "";
    let arguments_: readonly string[] = [];
    let hash = "";
    let cwd = "";
    await packageDesktopRelease({
      repositoryDirectory: repository,
      runtimeDirectory: runtime,
      runTauri: async (receivedCommand, receivedArguments, environment, receivedCwd) => {
        command = receivedCommand;
        arguments_ = receivedArguments;
        hash = environment.SCHEDULE_DESKTOP_RUNTIME_MANIFEST_SHA256 ?? "";
        cwd = receivedCwd;
        expect(
          await readFile(
            path.join(repository, "apps/desktop/src-tauri/resources/runtime/runtime-manifest.json"),
            "utf8",
          ),
        ).toContain('"linux"');
      },
    });
    expect(command).toBe(process.execPath);
    expect(arguments_).toEqual([
      path.join(repository, "apps/desktop/node_modules/@tauri-apps/cli/tauri.js"),
      "build",
      "--target",
      "x86_64-unknown-linux-gnu",
    ]);
    expect(cwd).toBe(path.join(repository, "apps", "desktop"));
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(
      await readFile(
        path.join(repository, "apps/desktop/src-tauri/resources/runtime/.gitkeep"),
        "utf8",
      ),
    ).toBe("staged at build\n");
  });

  it("rejects a nested or skeletal runtime before invoking Tauri", async () => {
    const { repository, runtime } = await fixture();
    await expect(
      packageDesktopRelease({
        repositoryDirectory: repository,
        runtimeDirectory: path.dirname(runtime),
        runTauri: async () => {
          throw new Error("must not run");
        },
      }),
    ).rejects.toThrow("exact assembled, non-nested runtime layout");
    await writeFile(path.join(runtime, "runtime-licenses.json"), "tampered");
    await expect(
      packageDesktopRelease({ repositoryDirectory: repository, runtimeDirectory: runtime }),
    ).rejects.toThrow("inventory integrity");
  });

  it("rejects a Rust-invalid manifest mutation before invoking Tauri", async () => {
    const { repository, runtime } = await fixture();
    const manifestPath = path.join(runtime, "runtime-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      components: Array<Record<string, unknown>>;
    };
    delete manifest.components[0]?.version;
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    let invoked = false;
    await expect(
      packageDesktopRelease({
        repositoryDirectory: repository,
        runtimeDirectory: runtime,
        runTauri: async () => {
          invoked = true;
        },
      }),
    ).rejects.toThrow("invalid");
    expect(invoked).toBe(false);
  });

  it("rejects a non-canonical PostgreSQL major before invoking Tauri", async () => {
    const { repository, runtime } = await fixture();
    const manifestPath = path.join(runtime, "runtime-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      components: Array<{ name: string; version: string }>;
    };
    manifest.components.find((component) => component.name === "postgresql")!.version = "17e0";
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    let invoked = false;
    await expect(
      packageDesktopRelease({
        repositoryDirectory: repository,
        runtimeDirectory: runtime,
        runTauri: async () => {
          invoked = true;
        },
      }),
    ).rejects.toThrow("invalid");
    expect(invoked).toBe(false);
  });

  it("rejects manifest fields Rust would deny before invoking Tauri", async () => {
    const { repository, runtime } = await fixture();
    const manifestPath = path.join(runtime, "runtime-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    manifest.unexpected = true;
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    await expect(
      packageDesktopRelease({
        repositoryDirectory: repository,
        runtimeDirectory: runtime,
        runTauri: async () => {
          throw new Error("must not run");
        },
      }),
    ).rejects.toThrow("invalid");
  });

  it("rejects an unavailable Tauri CLI before invoking the runner", async () => {
    const { repository, runtime } = await fixture();
    await rm(path.join(repository, "apps/desktop/node_modules/@tauri-apps/cli/tauri.js"));
    let invoked = false;
    await expect(
      packageDesktopRelease({
        repositoryDirectory: repository,
        runtimeDirectory: runtime,
        runTauri: async () => {
          invoked = true;
        },
      }),
    ).rejects.toThrow("Tauri CLI entry point is unavailable");
    expect(invoked).toBe(false);
  });

  it("accepts the bootstrap marker after a Windows checkout", async () => {
    const { repository, runtime } = await fixture();
    const reserved = path.join(repository, "apps/desktop/src-tauri/resources/runtime");
    await mkdir(reserved, { recursive: true });
    await writeFile(path.join(reserved, ".gitkeep"), "staged at build\r\n");
    await packageDesktopRelease({
      repositoryDirectory: repository,
      runtimeDirectory: runtime,
      runTauri: async () => undefined,
    });
    expect(await readFile(path.join(reserved, ".gitkeep"), "utf8")).toBe("staged at build\n");
  });

  it("keeps an existing concurrent reservation and restores bootstrap staging after failures", async () => {
    const { repository, runtime } = await fixture();
    const reserved = path.join(repository, "apps/desktop/src-tauri/resources/runtime");
    await mkdir(reserved, { recursive: true });
    await writeFile(path.join(reserved, "keep"), "keep");
    await expect(
      packageDesktopRelease({
        repositoryDirectory: repository,
        runtimeDirectory: runtime,
        runTauri: async () => undefined,
      }),
    ).rejects.toThrow();
    expect(await readFile(path.join(reserved, "keep"), "utf8")).toBe("keep");
    await rm(reserved, { recursive: true, force: true });
    let releaseCopies: () => void = () => undefined;
    let signalSlowCopy: () => void = () => undefined;
    const copyGate = new Promise<void>((resolve) => {
      releaseCopies = resolve;
    });
    const slowCopyStarted = new Promise<void>((resolve) => {
      signalSlowCopy = resolve;
    });
    const packaging = packageDesktopRelease({
      repositoryDirectory: repository,
      runtimeDirectory: runtime,
      copyEntry: async (source, destination) => {
        if (path.basename(source) === "runtime-manifest.json") throw new Error("copy failed");
        signalSlowCopy();
        await copyGate;
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, "late copy");
      },
    });
    await slowCopyStarted;
    expect(
      await Promise.race([
        packaging.then(
          () => "settled",
          () => "settled",
        ),
        new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 100)),
      ]),
    ).toBe("pending");
    releaseCopies();
    await expect(packaging).rejects.toThrow("copy failed");
    expect(await readFile(path.join(reserved, ".gitkeep"), "utf8")).toBe("staged at build\n");
  });

  it("atomically excludes a simultaneous packaging contender", async () => {
    const { repository, runtime } = await fixture();
    let release: () => void = () => undefined;
    let signalEntered: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = packageDesktopRelease({
      repositoryDirectory: repository,
      runtimeDirectory: runtime,
      runTauri: async () => {
        signalEntered();
        await gate;
      },
    });
    await entered;
    await expect(
      packageDesktopRelease({
        repositoryDirectory: repository,
        runtimeDirectory: runtime,
        runTauri: async () => undefined,
      }),
    ).rejects.toThrow("already in progress");
    release();
    await first;
  });
});
