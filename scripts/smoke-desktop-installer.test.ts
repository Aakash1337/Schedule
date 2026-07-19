import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
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

test("refuses to fake a GUI smoke before the native hook exists", async () => {
  await expect(smokeDesktopBundle(await fixture(), { requireLaunch: true })).rejects.toThrow(
    "headless smoke hook",
  );
});
