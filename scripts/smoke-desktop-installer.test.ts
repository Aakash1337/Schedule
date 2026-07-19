import { chmod, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { createDesktopRuntimeFixture } from "./create-desktop-runtime-fixture.js";
import { smokeDesktopBundle } from "./smoke-desktop-installer.js";

const roots: string[] = [];

async function fixture(relative = "runtime"): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "schedule-desktop-bundle-"));
  roots.push(root);
  const runtime = path.join(root, ...relative.split("/"));
  await mkdir(path.dirname(runtime), { recursive: true });
  await createDesktopRuntimeFixture(runtime);
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
});

test("redacts native launch failures to an exit code", async () => {
  const root = await fixture("usr/lib/schedule-desktop/runtime");
  const executable = path.join(root, "usr", "bin", "Schedule");
  await mkdir(path.dirname(executable), { recursive: true });
  await writeFile(executable, "fixture executable");
  await chmod(executable, 0o755);
  await expect(
    smokeDesktopBundle(root, { requireLaunch: true, launch: async () => 37 }),
  ).rejects.toThrow("Installed Schedule lifecycle smoke failed (exit code 37).");
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
