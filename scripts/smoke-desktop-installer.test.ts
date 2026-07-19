import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { createDesktopRuntimeFixture } from "./create-desktop-runtime-fixture.js";
import { smokeDesktopBundle } from "./smoke-desktop-installer.js";

const roots: string[] = [];

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "schedule-desktop-bundle-"));
  roots.push(root);
  await createDesktopRuntimeFixture(path.join(root, "runtime"));
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("validates the complete bundled runtime contract", async () => {
  await expect(smokeDesktopBundle(await fixture())).resolves.toBeUndefined();
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
