import { createHash } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { buildDesktopRuntime, hashTree } from "./build-desktop-runtime.js";

async function write(root: string, relative: string, value: string): Promise<void> {
  const file = path.join(root, ...relative.split("/"));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, value);
}

export async function createDesktopRuntimeFixture(outputDirectory: string): Promise<void> {
  const root = path.resolve(`${outputDirectory}.inputs`);
  const output = path.resolve(outputDirectory);
  const windows = process.platform === "win32";
  const suffix = windows ? ".exe" : "";
  const api = path.join(root, "api");
  const worker = path.join(root, "worker");
  const node = path.join(root, "node");
  const postgresql = path.join(root, "postgresql");
  await rm(root, { recursive: true, force: true });
  await rm(output, { recursive: true, force: true });
  await Promise.all([
    write(api, "dist/server.js", "fixture api"),
    write(worker, "dist/index.js", "fixture worker"),
    write(api, "node_modules/@schedule/database/dist/migrate.js", "fixture migration"),
    write(
      api,
      "node_modules/@schedule/database/dist/migration-ledger.js",
      "fixture migration ledger",
    ),
    write(
      api,
      "node_modules/@schedule/database/drizzle/meta/_journal.json",
      JSON.stringify({
        version: "7",
        dialect: "postgresql",
        entries: [{ idx: 0, version: "7", when: 1, tag: "0000_initial", breakpoints: true }],
      }),
    ),
    write(
      api,
      "node_modules/@schedule/database/drizzle/meta/_migration_manifest.json",
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
    write(api, "node_modules/@schedule/database/drizzle/0000_initial.sql", "select 1;"),
    write(node, `node${suffix}`, "fixture node"),
    write(postgresql, "share/postgresql.conf.sample", "fixture config"),
    write(postgresql, "share/extension/pgcrypto.control", "default_version = '1.3'\n"),
    write(postgresql, "share/extension/pgcrypto--1.3.sql", "fixture extension"),
    write(
      postgresql,
      windows ? "lib/pgcrypto.dll" : "lib/postgresql/pgcrypto.so",
      "fixture library",
    ),
    ...["initdb", "pg_ctl", "pg_dump", "pg_isready", "pg_restore", "postgres", "psql"].map((tool) =>
      write(postgresql, `bin/${tool}${suffix}`, `fixture ${tool}`),
    ),
  ]);
  const target = {
    os: windows ? "windows" : "linux",
    arch: process.arch === "arm64" ? "aarch64" : "x86_64",
  } as const;
  await buildDesktopRuntime({
    outputDirectory: output,
    target,
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
}

if (process.argv[1]?.endsWith("create-desktop-runtime-fixture.ts")) {
  const output = process.argv[3];
  if (process.argv[2] !== "--output" || output === undefined)
    throw new Error("Usage: --output <directory>");
  void createDesktopRuntimeFixture(output);
}
