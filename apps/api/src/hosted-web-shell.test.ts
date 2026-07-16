import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { loadHostedWebShell, registerHostedWebShell } from "./hosted-web-shell.js";

const apps: FastifyInstance[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixtureDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "schedule-hosted-web-"));
  temporaryDirectories.push(root);
  await mkdir(join(root, "assets"));
  await writeFile(
    join(root, "hosted.html"),
    '<!doctype html><link href="/assets/hosted-test.css" rel="stylesheet"><div id="root"></div><script src="/assets/hosted-test.js"></script>',
  );
  await writeFile(join(root, "favicon.svg"), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
  await writeFile(join(root, "assets", "hosted-test.js"), "globalThis.hosted = true;");
  await writeFile(join(root, "assets", "hosted-test.css"), ":root { color-scheme: light; }");
  return root;
}

describe("hosted web shell", () => {
  it("loads and serves only the bounded build output with hardened caching", async () => {
    const shell = await loadHostedWebShell(await fixtureDirectory());
    const app = Fastify({ logger: false });
    apps.push(app);
    await registerHostedWebShell(app, shell);

    const document = await app.inject({ method: "GET", url: "/" });
    expect(document.statusCode).toBe(200);
    expect(document.headers["content-type"]).toContain("text/html");
    expect(document.headers["cache-control"]).toBe("no-store");
    expect(document.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(document.headers["content-security-policy"]).toContain("connect-src 'self'");
    expect(document.headers["referrer-policy"]).toBe("no-referrer");

    const head = await app.inject({ method: "HEAD", url: "/" });
    expect(head.statusCode).toBe(200);
    expect(head.body).toBe("");

    const asset = await app.inject({ method: "GET", url: "/assets/hosted-test.js" });
    expect(asset.statusCode).toBe(200);
    expect(asset.headers["content-type"]).toContain("text/javascript");
    expect(asset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(asset.body).toContain("globalThis.hosted");

    expect((await app.inject({ method: "GET", url: "/assets/missing.js" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/v1/missing" })).statusCode).toBe(404);
  });

  it("redacts invalid or missing build output", async () => {
    const root = await fixtureDirectory();
    await writeFile(join(root, "assets", "unexpected.map"), "source map");

    await expect(loadHostedWebShell(root)).rejects.toThrow("Hosted web shell could not be loaded.");
    await expect(loadHostedWebShell(join(root, "missing"))).rejects.toThrow(
      "Hosted web shell could not be loaded.",
    );
  });

  it.each([
    [
      "an oversized asset",
      async (root: string) =>
        writeFile(join(root, "assets", "hosted-test.js"), Buffer.alloc(1024 * 1024 + 1)),
    ],
    [
      "an oversized aggregate bundle",
      async (root: string) => {
        await writeFile(join(root, "assets", "hosted-test.js"), Buffer.alloc(1024 * 1024));
        await writeFile(join(root, "assets", "hosted-test.css"), Buffer.alloc(1024 * 1024));
      },
    ],
    [
      "a missing document asset",
      async (root: string) =>
        writeFile(
          join(root, "hosted.html"),
          '<div id="root"></div><script src="/assets/missing.js"></script>',
        ),
    ],
    [
      "an unexpected asset directory",
      async (root: string) => mkdir(join(root, "assets", "nested")),
    ],
    [
      "an unreferenced asset",
      async (root: string) => writeFile(join(root, "assets", "unused.js"), "void 0;"),
    ],
  ])("rejects %s", async (_case, mutate) => {
    const root = await fixtureDirectory();
    await mutate(root);
    await expect(loadHostedWebShell(root)).rejects.toThrow("Hosted web shell could not be loaded.");
  });
});
