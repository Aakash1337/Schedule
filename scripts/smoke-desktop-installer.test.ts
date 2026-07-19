import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { smokeDesktopBundle } from "./smoke-desktop-installer.js";

const roots: string[] = [];

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "schedule-desktop-bundle-"));
  roots.push(root);
  await mkdir(path.join(root, "resources", "runtime"), { recursive: true });
  await writeFile(
    path.join(root, "resources", "runtime", "runtime-manifest.json"),
    JSON.stringify({ components: [{}, {}, {}, {}] }),
  );
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("accepts a bundle that carries the exact runtime component count", async () => {
  await expect(smokeDesktopBundle(await fixture())).resolves.toBeUndefined();
});

test("refuses to fake a GUI smoke before the native hook exists", async () => {
  await expect(smokeDesktopBundle(await fixture(), { requireLaunch: true })).rejects.toThrow(
    "headless smoke hook",
  );
});
