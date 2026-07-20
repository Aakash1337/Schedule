import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { createDesktopReleaseProvenance } from "./create-desktop-release-provenance.js";

const roots: string[] = [];
const environment = {
  GITHUB_SHA: "a".repeat(40),
  GITHUB_REF: "refs/pull/1/merge",
  GITHUB_EVENT_NAME: "pull_request",
  GITHUB_RUN_ID: "123",
  GITHUB_RUN_ATTEMPT: "1",
};

async function fixture(): Promise<{ installers: string; metadata: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "schedule-release-provenance-"));
  roots.push(root);
  const installers = path.join(root, "installers");
  const metadata = path.join(root, "metadata");
  await mkdir(path.join(installers, "nested"), { recursive: true });
  await mkdir(metadata, { recursive: true });
  await writeFile(path.join(installers, "z-setup.exe"), "windows");
  await writeFile(path.join(installers, "nested", "a.deb"), "linux");
  await writeFile(path.join(metadata, "runtime-manifest.json"), "manifest");
  return { installers, metadata };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("writes sorted installer hashes and authenticated build identity", async () => {
  const { installers, metadata } = await fixture();
  await createDesktopReleaseProvenance({
    installerDirectory: installers,
    metadataDirectory: metadata,
    target: "windows",
    version: "0.1.0",
    nodeVersion: "24.18.0",
    rustVersion: "1.97.1",
    environment,
  });
  const receipt = JSON.parse(
    await readFile(path.join(metadata, "release-provenance.json"), "utf8"),
  ) as {
    installers: Array<{ path: string }>;
    toolchains: { node: string; rust: string };
    source: { commit: string };
  };
  expect(receipt.installers.map(({ path: file }) => file)).toEqual(["nested/a.deb", "z-setup.exe"]);
  expect(receipt.toolchains).toEqual({ node: "24.18.0", rust: "1.97.1" });
  expect(receipt.source.commit).toBe(environment.GITHUB_SHA);
});

test("refuses installer links", async () => {
  const { installers, metadata } = await fixture();
  await symlink(path.join(installers, "z-setup.exe"), path.join(installers, "linked.deb"));
  await expect(
    createDesktopReleaseProvenance({
      installerDirectory: installers,
      metadataDirectory: metadata,
      target: "linux",
      version: "0.1.0",
      nodeVersion: "24.18.0",
      rustVersion: "1.97.1",
      environment,
    }),
  ).rejects.toThrow("cannot contain links");
});
