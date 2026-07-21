import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildDesktopRuntime,
  compareCodeUnits,
  hashTree,
  type DesktopRuntimeBuildOptions,
} from "./build-desktop-runtime.js";

const temporaryDirectories: string[] = [];
const executable = process.platform === "win32" ? ".exe" : "";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<{
  root: string;
  options: Omit<DesktopRuntimeBuildOptions, "sources">;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "schedule-runtime-"));
  temporaryDirectories.push(root);
  const api = path.join(root, "api");
  const worker = path.join(root, "worker");
  const node = path.join(root, "node");
  const postgres = path.join(root, "postgres");
  await Promise.all([
    mkdir(path.join(api, "dist"), { recursive: true }),
    mkdir(path.join(api, "node_modules", "@schedule", "database", "drizzle", "meta"), {
      recursive: true,
    }),
    mkdir(path.join(api, "node_modules", "@schedule", "database", "dist"), {
      recursive: true,
    }),
    mkdir(path.join(worker, "dist"), { recursive: true }),
    mkdir(node, { recursive: true }),
    mkdir(path.join(postgres, "bin"), { recursive: true }),
    mkdir(path.join(postgres, "lib"), { recursive: true }),
    mkdir(path.join(postgres, "share", "extension"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(api, "dist", "server.js"), "api"),
    writeFile(
      path.join(api, "node_modules", "@schedule", "database", "dist", "migrate.js"),
      "migration",
    ),
    writeFile(
      path.join(api, "node_modules", "@schedule", "database", "dist", "migration-ledger.js"),
      "migration ledger",
    ),
    writeFile(
      path.join(api, "node_modules", "@schedule", "database", "dist", "migration-sql.js"),
      "migration SQL safety",
    ),
    writeFile(
      path.join(api, "node_modules", "@schedule", "database", "dist", "desktop-portable.js"),
      "desktop portable export helper",
    ),
    ...[
      "portable-export.js",
      "portable-archive.js",
      "portable-payload.js",
      "portable-file.js",
      "backup-database.js",
      "portable-data.js",
      "database.js",
    ].map((file) =>
      writeFile(
        path.join(api, "node_modules", "@schedule", "database", "dist", file),
        `desktop portable export module ${file}`,
      ),
    ),
    writeFile(
      path.join(api, "node_modules", "@schedule", "database", "drizzle", "meta", "_journal.json"),
      JSON.stringify({
        version: "7",
        dialect: "postgresql",
        entries: [{ idx: 0, version: "7", when: 1, tag: "0000_initial", breakpoints: true }],
      }),
    ),
    writeFile(
      path.join(
        api,
        "node_modules",
        "@schedule",
        "database",
        "drizzle",
        "meta",
        "_migration_manifest.json",
      ),
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
      path.join(api, "node_modules", "@schedule", "database", "drizzle", "0000_initial.sql"),
      "select 1;",
    ),
    writeFile(path.join(worker, "dist", "index.js"), "worker"),
    writeFile(path.join(node, `node${executable}`), "node"),
    writeFile(path.join(node, "LICENSE"), "node notice"),
    ...["initdb", "pg_ctl", "pg_dump", "pg_isready", "pg_restore", "postgres", "psql"].map((tool) =>
      writeFile(path.join(postgres, "bin", `${tool}${executable}`), tool),
    ),
    writeFile(path.join(postgres, "share", "postgresql.conf.sample"), "config"),
    writeFile(path.join(postgres, "COPYING"), "postgres notice"),
    writeFile(path.join(postgres, "COPYRIGHT"), "postgres copyright notice"),
    writeFile(
      path.join(postgres, "share", "extension", "pgcrypto.control"),
      "default_version = '1.3'\n",
    ),
    writeFile(path.join(postgres, "share", "extension", "pgcrypto--1.3.sql"), "extension"),
    writeFile(
      path.join(postgres, "lib", process.platform === "win32" ? "pgcrypto.dll" : "pgcrypto.so"),
      "library",
    ),
  ]);
  return {
    root,
    options: {
      outputDirectory: path.join(root, "runtime"),
      target: { os: process.platform === "win32" ? "windows" : "linux", arch: "x86_64" },
      postgresqlMajor: 17,
      apiDeploymentDirectory: api,
      workerDeploymentDirectory: worker,
      nodeRuntimeDirectory: node,
      postgresqlRuntimeDirectory: postgres,
    },
  };
}

async function pins(
  options: Omit<DesktopRuntimeBuildOptions, "sources">,
): Promise<DesktopRuntimeBuildOptions["sources"]> {
  const pin = async (directory: string, version: string) => ({
    version,
    sha256: await hashTree(directory),
  });
  return {
    api: await pin(options.apiDeploymentDirectory, "1.0.0"),
    worker: await pin(options.workerDeploymentDirectory, "1.0.0"),
    node: await pin(options.nodeRuntimeDirectory, "24.0.0"),
    postgresql: await pin(options.postgresqlRuntimeDirectory, "17.0.0"),
  };
}

describe("buildDesktopRuntime", () => {
  it("keeps the component tree hash compatible with the Rust verifier", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "schedule-runtime-hash-"));
    temporaryDirectories.push(root);
    await mkdir(path.join(root, "nested"));
    await Promise.all([
      writeFile(path.join(root, "a.txt"), "alpha"),
      writeFile(path.join(root, "nested", "b.txt"), "beta"),
    ]);
    expect(await hashTree(root)).toBe(
      "bddbe9c2eadc41a9f84c19d9c16b98ee2ad029b1f807000abee5d1635251565f",
    );
  });

  it("assembles pinned deployment trees with deterministic inventories", async () => {
    const { options } = await fixture();
    const manifest = await buildDesktopRuntime({ ...options, sources: await pins(options) });
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.components.map((component) => component.launch.path)).toContain(
      "api/dist/server.js",
    );
    const output = JSON.parse(
      await readFile(path.join(options.outputDirectory, "runtime-manifest.json"), "utf8"),
    ) as typeof manifest;
    expect(output).toEqual(manifest);
    const licenses = JSON.parse(
      await readFile(path.join(options.outputDirectory, "runtime-licenses.json"), "utf8"),
    ) as { packages: unknown[]; notices: Array<{ path: string }> };
    expect(licenses.packages).toEqual([]);
    expect(licenses.notices.map((notice) => notice.path)).toEqual([
      "node/LICENSE",
      "postgresql/COPYING",
      "postgresql/COPYRIGHT",
    ]);
    expect(manifest.artifacts.licensesSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.artifacts.sbomSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(
      await readFile(
        path.join(
          options.outputDirectory,
          "api",
          "node_modules",
          "@schedule",
          "database",
          "dist",
          "desktop-portable.js",
        ),
        "utf8",
      ),
    ).toBe("desktop portable export helper");
    expect(manifest.components.find((component) => component.name === "api")?.sha256).toBe(
      await hashTree(path.join(options.outputDirectory, "api")),
    );
  });

  it("orders notice paths by code units rather than the builder locale", () => {
    expect(["i/NOTICE", "I/NOTICE", "z/NOTICE"].sort(compareCodeUnits)).toEqual([
      "I/NOTICE",
      "i/NOTICE",
      "z/NOTICE",
    ]);
  });

  it("rejects a pin mismatch without promoting an output", async () => {
    const { options } = await fixture();
    const sourcePins = await pins(options);
    await expect(
      buildDesktopRuntime({
        ...options,
        sources: { ...sourcePins, node: { version: "24.0.0", sha256: "0".repeat(64) } },
      }),
    ).rejects.toThrow("does not match");
    await expect(
      readFile(path.join(options.outputDirectory, "runtime-manifest.json")),
    ).rejects.toThrow();
  });

  it("rejects symlinked and incomplete inputs", async () => {
    const { root, options } = await fixture();
    const sourcePins = await pins(options);
    await symlink(
      path.join(options.apiDeploymentDirectory, "dist", "server.js"),
      path.join(options.apiDeploymentDirectory, "linked.js"),
    );
    await expect(buildDesktopRuntime({ ...options, sources: sourcePins })).rejects.toThrow(
      "Symlinks are not allowed",
    );
    await rm(path.join(root, "api", "linked.js"));
    await rm(path.join(options.workerDeploymentDirectory, "dist", "index.js"));
    await expect(buildDesktopRuntime({ ...options, sources: sourcePins })).rejects.toThrow(
      "does not match",
    );
  });

  it("requires runtime executables even when the supplied tree pin is valid", async () => {
    const { options } = await fixture();
    await rm(path.join(options.postgresqlRuntimeDirectory, "bin", `postgres${executable}`));
    await expect(buildDesktopRuntime({ ...options, sources: await pins(options) })).rejects.toThrow(
      "PostgreSQL postgres executable is required",
    );
  });

  it("requires the deployed database migration entrypoint", async () => {
    const { options } = await fixture();
    await rm(
      path.join(
        options.apiDeploymentDirectory,
        "node_modules",
        "@schedule",
        "database",
        "dist",
        "migrate.js",
      ),
    );
    await expect(buildDesktopRuntime({ ...options, sources: await pins(options) })).rejects.toThrow(
      "Database migration entrypoint is required",
    );
  });

  it("requires the deployed database migration ledger helper", async () => {
    const { options } = await fixture();
    await rm(
      path.join(
        options.apiDeploymentDirectory,
        "node_modules",
        "@schedule",
        "database",
        "dist",
        "migration-ledger.js",
      ),
    );
    await expect(buildDesktopRuntime({ ...options, sources: await pins(options) })).rejects.toThrow(
      "Database migration ledger helper is required",
    );
  });

  it("requires the deployed database migration SQL safety helper", async () => {
    const { options } = await fixture();
    await rm(
      path.join(
        options.apiDeploymentDirectory,
        "node_modules",
        "@schedule",
        "database",
        "dist",
        "migration-sql.js",
      ),
    );
    await expect(buildDesktopRuntime({ ...options, sources: await pins(options) })).rejects.toThrow(
      "Database migration SQL safety helper is required",
    );
  });

  it("requires a regular, non-symlink deployed desktop portable export helper", async () => {
    const { options } = await fixture();
    const helper = path.join(
      options.apiDeploymentDirectory,
      "node_modules",
      "@schedule",
      "database",
      "dist",
      "desktop-portable.js",
    );
    await rm(helper);
    await expect(buildDesktopRuntime({ ...options, sources: await pins(options) })).rejects.toThrow(
      "Database desktop portable export module desktop-portable.js is required",
    );
    await mkdir(helper);
    await expect(buildDesktopRuntime({ ...options, sources: await pins(options) })).rejects.toThrow(
      "Database desktop portable export module desktop-portable.js is required",
    );
    await rm(helper, { recursive: true });
    const sourcePins = await pins(options);
    await symlink(path.join(options.apiDeploymentDirectory, "dist", "server.js"), helper);
    await expect(buildDesktopRuntime({ ...options, sources: sourcePins })).rejects.toThrow(
      "Symlinks are not allowed",
    );
  });

  it("requires the compiled portable export module closure", async () => {
    const { options } = await fixture();
    await rm(
      path.join(
        options.apiDeploymentDirectory,
        "node_modules",
        "@schedule",
        "database",
        "dist",
        "portable-export.js",
      ),
    );
    await expect(buildDesktopRuntime({ ...options, sources: await pins(options) })).rejects.toThrow(
      "Database desktop portable export module portable-export.js is required",
    );
  });

  it("requires the immutable migration manifest", async () => {
    const { options } = await fixture();
    await rm(
      path.join(
        options.apiDeploymentDirectory,
        "node_modules",
        "@schedule",
        "database",
        "drizzle",
        "meta",
        "_migration_manifest.json",
      ),
    );
    await expect(buildDesktopRuntime({ ...options, sources: await pins(options) })).rejects.toThrow(
      "Immutable migration manifest is required",
    );
  });

  it("rejects output paths that overlap an immutable input tree", async () => {
    const { options } = await fixture();
    const sourcePins = await pins(options);
    await expect(
      buildDesktopRuntime({
        ...options,
        outputDirectory: path.join(options.apiDeploymentDirectory, "runtime"),
        sources: sourcePins,
      }),
    ).rejects.toThrow("must be disjoint");
  });

  it("rejects runtime manifests that the Rust supervisor cannot launch", async () => {
    const { options } = await fixture();
    const sourcePins = await pins(options);
    await expect(
      buildDesktopRuntime({ ...options, postgresqlMajor: 18, sources: sourcePins }),
    ).rejects.toThrow("requires PostgreSQL major 17");
    await expect(
      buildDesktopRuntime({
        ...options,
        sources: { ...sourcePins, postgresql: { ...sourcePins.postgresql, version: "18.1" } },
      }),
    ).rejects.toThrow("source version must match");
    for (const version of ["17e0", "0x11"]) {
      await expect(
        buildDesktopRuntime({
          ...options,
          sources: { ...sourcePins, postgresql: { ...sourcePins.postgresql, version } },
        }),
      ).rejects.toThrow("source version must match");
    }
  });
});
