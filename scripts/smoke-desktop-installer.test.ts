import { chmod, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { createDesktopRuntimeFixture } from "./create-desktop-runtime-fixture.js";
import { databaseStartupDiagnostic, smokeDesktopBundle } from "./smoke-desktop-installer.js";

const roots: string[] = [];

async function fixture(relative = "runtime"): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "schedule-desktop-bundle-"));
  roots.push(root);
  const runtime = path.join(root, ...relative.split("/"));
  await mkdir(path.dirname(runtime), { recursive: true });
  await createDesktopRuntimeFixture(runtime);
  return root;
}

async function installedLinuxFixture(): Promise<string> {
  const root = await fixture("usr/lib/schedule-desktop/runtime");
  const executable = path.join(root, "usr", "bin", "Schedule");
  await mkdir(path.dirname(executable), { recursive: true });
  await writeFile(executable, "fixture executable");
  await chmod(executable, 0o755);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("validates the complete bundled runtime contract", async () => {
  await expect(smokeDesktopBundle(await fixture())).resolves.toBeUndefined();
});

test("discovers the deb runtime below the package executable directory", async () => {
  await expect(
    smokeDesktopBundle(await fixture("usr/lib/schedule-desktop/runtime")),
  ).resolves.toBeUndefined();
});

test("rejects a deb extraction without one validated runtime", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "schedule-desktop-bundle-"));
  roots.push(root);
  await expect(smokeDesktopBundle(root)).rejects.toThrow("does not contain one validated");
});

test("rejects ambiguous deb package runtime directories", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "schedule-desktop-bundle-"));
  roots.push(root);
  for (const name of ["schedule-desktop", "schedule-other"]) {
    const runtime = path.join(root, "usr", "lib", name, "runtime");
    await mkdir(path.dirname(runtime), { recursive: true });
    await createDesktopRuntimeFixture(runtime);
  }
  await expect(smokeDesktopBundle(root)).rejects.toThrow("multiple validated");
});

test("rejects a bundled runtime whose manifest component hash was rewritten", async () => {
  const root = await fixture();
  const manifestPath = path.join(root, "runtime", "runtime-manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    components: Array<{ sha256: string }>;
  };
  manifest.components[0]!.sha256 = "0".repeat(64);
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
  await expect(smokeDesktopBundle(root)).rejects.toThrow("component integrity");
});

test("rejects a bundled runtime missing an authenticated inventory", async () => {
  const root = await fixture();
  await unlink(path.join(root, "runtime", "runtime-sbom.json"));
  await expect(smokeDesktopBundle(root)).rejects.toThrow();
});

test("runs the installed native lifecycle twice against one isolated data root", async () => {
  const root = await fixture("usr/lib/schedule-desktop/runtime");
  const executable = path.join(root, "usr", "bin", "Schedule");
  await mkdir(path.dirname(executable), { recursive: true });
  await writeFile(executable, "fixture executable");
  await chmod(executable, 0o755);
  const launches: Array<{ executable: string; arguments_: readonly string[]; timeout: number }> =
    [];
  await smokeDesktopBundle(root, {
    requireLaunch: true,
    launch: async (command, arguments_, options) => {
      launches.push({ executable: command, arguments_, timeout: options.timeout });
      return 0;
    },
  });
  expect(launches).toHaveLength(2);
  expect(launches.map((launch) => launch.executable)).toEqual([executable, executable]);
  expect(launches.map((launch) => launch.timeout)).toEqual([450_000, 450_000]);
  expect(launches[0]!.arguments_.slice(0, 3)).toEqual([
    "--schedule-runtime-smoke",
    "--runtime-root",
    path.join(root, "usr", "lib", "schedule-desktop", "runtime"),
  ]);
  expect(launches[0]!.arguments_[4]).toBe(launches[1]!.arguments_[4]);
  expect(path.basename(launches[0]!.arguments_[4]!)).toBe("data");
});

test("uses the Cargo binary name for an installed Windows executable", async () => {
  if (process.platform !== "win32") return;
  const root = await fixture();
  const executable = path.join(root, "schedule-desktop.exe");
  await writeFile(executable, "fixture executable");
  const launches: string[] = [];
  await smokeDesktopBundle(root, {
    requireLaunch: true,
    launch: async (command) => {
      launches.push(command);
      return 0;
    },
  });
  expect(launches).toEqual([executable, executable]);
});

test("redacts native launch failures to an exit code", async () => {
  const root = await installedLinuxFixture();
  await expect(
    smokeDesktopBundle(root, {
      requireLaunch: true,
      launch: async () => 37,
      removeDataRoot: async () => {
        throw new Error("private cleanup path");
      },
    }),
  ).rejects.toThrow("Installed Schedule lifecycle smoke failed (exit code 37).");
});

test("reports only validated lifecycle state for a native startup failure", async () => {
  const root = await installedLinuxFixture();
  const result = smokeDesktopBundle(root, {
    requireLaunch: true,
    launch: async (_command, arguments_) => {
      const dataRoot = arguments_[4]!;
      const staging = path.join(dataRoot, "postgresql", ".schedule-initializing-v1");
      await mkdir(path.join(dataRoot, "runtime"), { recursive: true });
      await mkdir(path.join(dataRoot, "logs"), { recursive: true });
      await mkdir(staging, { recursive: true });
      await writeFile(path.join(staging, "SCHEDULE_INITDB_COMPLETE_V1"), "schedule-initdb-v1\n");
      await writeFile(path.join(staging, "SCHEDULE_BOOTSTRAPPED_V1"), "schedule-bootstrap-v1\n");
      await writeFile(path.join(staging, "postmaster.opts"), "redacted fixture");
      await writeFile(
        path.join(dataRoot, "logs", "postgresql.log"),
        "database system is ready to accept connections\nFATAL: private diagnostic must not escape\n",
      );
      await writeFile(
        path.join(dataRoot, "runtime", "journal.json"),
        JSON.stringify({
          schema_version: 1,
          attempt: { id: 2, phase: "starting_database" },
        }),
      );
      return { exitCode: 11, databaseStart: "post_admission_exit:3221225781" };
    },
  });
  await expect(result).rejects.toThrow(
    "Installed Schedule lifecycle smoke failed (exit code 11, attempt 2, phase starting_database, prior-success false, staging true, final false, initdb-marker true, bootstrap-marker true, postmaster-opts true, postgres-log fatal, database-start post_admission_exit:3221225781).",
  );
  await expect(result).rejects.not.toThrow("private diagnostic must not escape");
});

test("classifies only bounded database startup sentinels", () => {
  expect(
    databaseStartupDiagnostic(
      "private output\nSCHEDULE_DESKTOP_DATABASE_STARTUP=post_admission_exit:3221225781\n",
    ),
  ).toBe("post_admission_exit:3221225781");
  expect(
    databaseStartupDiagnostic("SCHEDULE_DESKTOP_DATABASE_STARTUP=guardian_admission_failed\r\n"),
  ).toBe("guardian_admission_failed");
  expect(
    databaseStartupDiagnostic("SCHEDULE_DESKTOP_DATABASE_STARTUP=post_admission_exit:4294967296\n"),
  ).toBeUndefined();
  expect(databaseStartupDiagnostic("private output only")).toBeUndefined();
});

test("redacts a cleanup failure without exposing its temporary root", async () => {
  const root = await installedLinuxFixture();
  let removedRoot = "";
  const result = smokeDesktopBundle(root, {
    requireLaunch: true,
    launch: async () => 0,
    removeDataRoot: async (dataRoot) => {
      removedRoot = dataRoot;
      throw new Error(dataRoot);
    },
  });
  await expect(result).rejects.toThrow(
    "Installed Schedule lifecycle smoke failed (exit code 125).",
  );
  await expect(result).rejects.not.toThrow(removedRoot);
});

test("redacts a timed-out native launch to the synthetic timeout exit code", async () => {
  const root = await fixture("usr/lib/schedule-desktop/runtime");
  const executable = path.join(root, "usr", "bin", "Schedule");
  await mkdir(path.dirname(executable), { recursive: true });
  await writeFile(executable, "fixture executable");
  await chmod(executable, 0o755);
  await expect(
    smokeDesktopBundle(root, { requireLaunch: true, launch: async () => 124 }),
  ).rejects.toThrow("Installed Schedule lifecycle smoke failed (exit code 124).");
});

test("requires exactly one Debian Schedule executable", async () => {
  const root = await fixture("usr/lib/schedule-desktop/runtime");
  await expect(
    smokeDesktopBundle(root, { requireLaunch: true, launch: async () => 0 }),
  ).rejects.toThrow("Installed Schedule executable is missing.");
});
