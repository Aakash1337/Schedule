import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  stageDesktopServiceDeployments,
  type DeployCommand,
} from "./stage-desktop-service-deployments.js";

const roots: string[] = [];
const databaseRelative = path.join("node_modules", "@schedule", "database");

afterEach(
  async () =>
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))),
);

type RawMutation = (destination: string, api: boolean, root: string) => Promise<void>;

async function fixture(mutate?: RawMutation): Promise<{
  root: string;
  deploy: DeployCommand;
  output: string;
}> {
  const root = await mkdtemp(path.join(os.tmpdir(), "schedule-deploy-"));
  roots.push(root);
  await Promise.all([
    mkdir(path.join(root, "apps", "api"), { recursive: true }),
    mkdir(path.join(root, "apps", "worker"), { recursive: true }),
  ]);
  const deploy: DeployCommand = async (_command, arguments_) => {
    const destination = arguments_[arguments_.length - 1] as string;
    const api = arguments_.includes("@schedule/api");
    await mkdir(path.join(destination, "dist"), { recursive: true });
    await writeFile(
      path.join(destination, "dist", api ? "server.js" : "index.js"),
      api ? "api" : "worker",
    );
    await writeFile(
      path.join(destination, "package.json"),
      JSON.stringify({
        name: api ? "@schedule/api" : "@schedule/worker",
        version: "1.0.0",
        license: "MIT",
        dependencies: api
          ? { "@schedule/database": "workspace:*" }
          : { "@schedule/config": "workspace:*" },
      }),
    );
    if (api) {
      const database = path.join(destination, databaseRelative);
      await mkdir(path.join(database, "dist"), { recursive: true });
      await mkdir(path.join(database, "drizzle", "meta"), { recursive: true });
      await mkdir(path.join(destination, "node_modules", "dotenv"), { recursive: true });
      await writeFile(
        path.join(database, "dist", "migrate.js"),
        'import "dotenv/config"; export const stagedMigrationFixture = true;',
      );
      await writeFile(
        path.join(database, "dist", "migration-ledger.js"),
        "export const stagedMigrationLedgerFixture = true;",
      );
      await writeFile(
        path.join(database, "dist", "migration-sql.js"),
        "export const stagedMigrationSqlFixture = true;",
      );
      await writeFile(
        path.join(database, "dist", "desktop-portable.js"),
        "export const stagedDesktopPortableFixture = true;",
      );
      await Promise.all(
        [
          "portable-export.js",
          "portable-archive.js",
          "portable-payload.js",
          "portable-file.js",
          "backup-database.js",
          "portable-data.js",
          "database.js",
        ].map((file) =>
          writeFile(path.join(database, "dist", file), `export const ${file} = true;`),
        ),
      );
      await writeFile(
        path.join(database, "package.json"),
        JSON.stringify({ name: "@schedule/database", dependencies: { dotenv: "1.0.0" } }),
      );
      await writeFile(
        path.join(destination, "node_modules", "dotenv", "package.json"),
        JSON.stringify({
          name: "dotenv",
          version: "1.0.0",
          type: "module",
          exports: { "./config": "./config.js" },
        }),
      );
      await writeFile(path.join(destination, "node_modules", "dotenv", "config.js"), "");
      await writeFile(
        path.join(database, "drizzle", "meta", "_journal.json"),
        JSON.stringify({
          version: "7",
          dialect: "postgresql",
          entries: [{ idx: 0, version: "7", when: 1, tag: "0000_initial", breakpoints: true }],
        }),
      );
      const migration = "select 1;";
      await writeFile(path.join(database, "drizzle", "0000_initial.sql"), migration);
      await writeFile(
        path.join(database, "drizzle", "meta", "_migration_manifest.json"),
        JSON.stringify({
          schemaVersion: 1,
          entries: [
            {
              tag: "0000_initial",
              createdAt: 1,
              sha256: createHash("sha256").update(migration).digest("hex"),
              compatibleSha256: [],
            },
          ],
        }),
      );
    } else {
      const config = path.join(destination, "node_modules", "@schedule", "config");
      await mkdir(config, { recursive: true });
      await mkdir(path.join(destination, "node_modules", "zod"), { recursive: true });
      await writeFile(
        path.join(config, "package.json"),
        JSON.stringify({ name: "@schedule/config", dependencies: { zod: "1.0.0" } }),
      );
      await writeFile(
        path.join(destination, "node_modules", "zod", "package.json"),
        JSON.stringify({ name: "zod", version: "1.0.0" }),
      );
    }
    await mutate?.(destination, api, root);
  };
  return { root, deploy, output: path.join(root, "portable-output") };
}

async function expectFailure(mutate: RawMutation, message: string): Promise<void> {
  const setup = await fixture(mutate);
  await expect(
    stageDesktopServiceDeployments({
      sourceDirectory: setup.root,
      outputDirectory: setup.output,
      deploy: setup.deploy,
    }),
  ).rejects.toThrow(message);
  await expect(lstat(setup.output)).rejects.toThrow();
  expect(
    (await readdir(setup.root)).some(
      (name) =>
        name.startsWith("portable-output.raw-") || name.startsWith("portable-output.staging-"),
    ),
  ).toBe(false);
}

describe("stageDesktopServiceDeployments", () => {
  it("materializes internal workspace links and preserves package metadata", async () => {
    const setup = await fixture(async (destination, api, root) => {
      if (!api) return;
      const workspacePackage = path.join(destination, "workspace-package");
      await mkdir(workspacePackage);
      await writeFile(path.join(workspacePackage, "package.json"), "{}");
      await symlink(
        workspacePackage,
        path.join(destination, "node_modules", "workspace-package"),
        "junction",
      );
      const selfLink = path.join(
        destination,
        "node_modules",
        ".pnpm",
        "node_modules",
        "@schedule",
        "api",
      );
      await mkdir(path.dirname(selfLink), { recursive: true });
      await symlink(path.join(root, "apps", "api"), selfLink, "junction");
    });
    const result = await stageDesktopServiceDeployments({
      sourceDirectory: setup.root,
      outputDirectory: setup.output,
      deploy: setup.deploy,
    });
    expect(result.apiSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.workerSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(
      (
        await lstat(path.join(result.apiDeploymentDirectory, "node_modules", "workspace-package"))
      ).isSymbolicLink(),
    ).toBe(false);
    expect(
      JSON.parse(await readFile(path.join(result.apiDeploymentDirectory, "package.json"), "utf8")),
    ).toMatchObject({ name: "@schedule/api", license: "MIT" });
    await expect(
      import(
        pathToFileURL(
          path.join(result.apiDeploymentDirectory, databaseRelative, "dist", "migrate.js"),
        ).href
      ),
    ).resolves.toMatchObject({ stagedMigrationFixture: true });
    expect(
      await readFile(
        path.join(result.apiDeploymentDirectory, databaseRelative, "dist", "desktop-portable.js"),
        "utf8",
      ),
    ).toContain("stagedDesktopPortableFixture");
    const stagedHelper = await lstat(
      path.join(result.apiDeploymentDirectory, databaseRelative, "dist", "desktop-portable.js"),
    );
    expect(stagedHelper.isFile()).toBe(true);
    expect(stagedHelper.isSymbolicLink()).toBe(false);
  });

  it("requests a hoisted deploy so materialized workspace dependencies stay resolvable", async () => {
    const setup = await fixture();
    const calls: string[][] = [];
    await stageDesktopServiceDeployments({
      sourceDirectory: setup.root,
      outputDirectory: setup.output,
      deploy: async (command, arguments_, options) => {
        calls.push([...arguments_]);
        await setup.deploy(command, arguments_, options);
      },
    });
    expect(calls).toHaveLength(2);
    expect(calls.every((arguments_) => arguments_[0] === "--config.node-linker=hoisted")).toBe(
      true,
    );
  });

  it("rejects invalid raw trees and cleans failed staging", async () => {
    const cases: readonly [string, RawMutation, string][] = [
      [
        "external links",
        async (destination, api) => {
          if (!api) await symlink(process.execPath, path.join(destination, "external.js"));
        },
        "escapes",
      ],
      [
        "link cycles",
        async (destination, api) => {
          if (!api) await symlink(destination, path.join(destination, "cycle"), "junction");
        },
        "cycle",
      ],
      [
        "missing API entrypoint",
        async (destination, api) => {
          if (api) await unlink(path.join(destination, "dist", "server.js"));
        },
        "API server entrypoint",
      ],
      [
        "missing worker entrypoint",
        async (destination, api) => {
          if (!api) await unlink(path.join(destination, "dist", "index.js"));
        },
        "Worker entrypoint",
      ],
      [
        "missing migration entrypoint",
        async (destination, api) => {
          if (api) await unlink(path.join(destination, databaseRelative, "dist", "migrate.js"));
        },
        "Database migration entrypoint",
      ],
      [
        "missing migration ledger helper",
        async (destination, api) => {
          if (api)
            await unlink(path.join(destination, databaseRelative, "dist", "migration-ledger.js"));
        },
        "Database migration ledger helper",
      ],
      [
        "missing migration SQL safety helper",
        async (destination, api) => {
          if (api)
            await unlink(path.join(destination, databaseRelative, "dist", "migration-sql.js"));
        },
        "Database migration SQL safety helper",
      ],
      [
        "missing desktop portable export helper",
        async (destination, api) => {
          if (api)
            await unlink(path.join(destination, databaseRelative, "dist", "desktop-portable.js"));
        },
        "Database desktop portable export module desktop-portable.js",
      ],
      [
        "missing portable export module closure file",
        async (destination, api) => {
          if (api)
            await unlink(path.join(destination, databaseRelative, "dist", "portable-export.js"));
        },
        "Database desktop portable export module portable-export.js",
      ],
      [
        "missing materialized workspace dependency",
        async (destination, api) => {
          if (api) await unlink(path.join(destination, "node_modules", "dotenv", "package.json"));
        },
        "Runtime dependency dotenv",
      ],
      [
        "missing workspace package scope",
        async (destination, api) => {
          if (!api)
            await rm(path.join(destination, "node_modules", "@schedule"), {
              recursive: true,
              force: true,
            });
        },
        "Runtime dependency @schedule/config",
      ],
      [
        "missing migration journal",
        async (destination, api) => {
          if (api)
            await unlink(
              path.join(destination, databaseRelative, "drizzle", "meta", "_journal.json"),
            );
        },
        "Migration journal",
      ],
      [
        "missing immutable migration manifest",
        async (destination, api) => {
          if (api)
            await unlink(
              path.join(
                destination,
                databaseRelative,
                "drizzle",
                "meta",
                "_migration_manifest.json",
              ),
            );
        },
        "Immutable migration manifest",
      ],
      [
        "missing journaled SQL",
        async (destination, api) => {
          if (api)
            await unlink(path.join(destination, databaseRelative, "drizzle", "0000_initial.sql"));
        },
        "Journaled SQL migration",
      ],
      [
        "stale immutable migration manifest",
        async (destination, api) => {
          if (api)
            await writeFile(
              path.join(destination, databaseRelative, "drizzle", "0000_initial.sql"),
              "select 2;",
            );
        },
        "immutable manifest",
      ],
      [
        "malformed journal",
        async (destination, api) => {
          if (api)
            await writeFile(
              path.join(destination, databaseRelative, "drizzle", "meta", "_journal.json"),
              "{",
            );
        },
        "valid JSON",
      ],
      [
        "escaping journal tag",
        async (destination, api, root) => {
          if (!api) return;
          await writeFile(path.join(root, "outside.sql"), "outside");
          await writeFile(
            path.join(destination, databaseRelative, "drizzle", "meta", "_journal.json"),
            JSON.stringify({
              version: "7",
              dialect: "postgresql",
              entries: [
                {
                  idx: 0,
                  version: "7",
                  when: 1,
                  tag: "../../../../../../outside",
                  breakpoints: true,
                },
              ],
            }),
          );
        },
        "invalid migration tag",
      ],
    ];
    for (const [, mutate, message] of cases) await expectFailure(mutate, message);
  }, 20_000);

  it("rejects nonportable and case-colliding paths where the host can create them", async () => {
    if (process.platform === "win32") return;
    await expectFailure(async (destination, api) => {
      if (!api) await writeFile(path.join(destination, "bad:name"), "bad");
    }, "nonportable");
    await expectFailure(async (destination, api) => {
      if (!api) {
        await writeFile(path.join(destination, "Case"), "one");
        await writeFile(path.join(destination, "case"), "two");
      }
    }, "case-colliding");
  });

  it("does not replace an existing output", async () => {
    const setup = await fixture();
    await stageDesktopServiceDeployments({
      sourceDirectory: setup.root,
      outputDirectory: setup.output,
      deploy: setup.deploy,
    });
    await expect(
      stageDesktopServiceDeployments({
        sourceDirectory: setup.root,
        outputDirectory: setup.output,
        deploy: setup.deploy,
      }),
    ).rejects.toThrow("already exists");
  });

  it("reserves the output before deployment so concurrent callers cannot replace it", async () => {
    const setup = await fixture();
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => (enter = resolve));
    const released = new Promise<void>((resolve) => (release = resolve));
    let held = false;
    const deploy: DeployCommand = async (...arguments_) => {
      if (!held) {
        held = true;
        enter();
        await released;
      }
      await setup.deploy(...arguments_);
    };
    const first = stageDesktopServiceDeployments({
      sourceDirectory: setup.root,
      outputDirectory: setup.output,
      deploy,
    });
    await entered;
    try {
      expect((await lstat(setup.output)).isDirectory()).toBe(true);
      await expect(
        stageDesktopServiceDeployments({
          sourceDirectory: setup.root,
          outputDirectory: setup.output,
          deploy: setup.deploy,
        }),
      ).rejects.toThrow("already exists");
    } finally {
      release();
    }
    await expect(first).resolves.toMatchObject({ apiDeploymentDirectory: expect.any(String) });
  });
});
