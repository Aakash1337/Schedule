import { readFile, readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import type { FastifyInstance, FastifyReply } from "fastify";

const defaultRoot = fileURLToPath(new URL("../hosted-web/", import.meta.url));
const assetNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\.(?:css|js)$/u;
const maximumAssetCount = 32;
const maximumAssetBytes = 1024 * 1024;
const maximumBundleBytes = 2 * 1024 * 1024;
const shellSecurityPolicy = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
].join("; ");

export interface HostedWebAsset {
  readonly body: Buffer;
  readonly contentType: string;
}

export interface HostedWebShell {
  readonly html: string;
  readonly icon: Buffer;
  readonly assets: ReadonlyMap<string, HostedWebAsset>;
}

export type HostedWebShellLoader = () => Promise<HostedWebShell>;

function assetContentType(name: string): string {
  return name.endsWith(".css") ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8";
}

async function boundedFile(path: string, maximumBytes: number): Promise<Buffer> {
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size < 1 || metadata.size > maximumBytes) {
    throw new Error("invalid file");
  }
  const value = await readFile(path);
  if (value.byteLength === 0 || value.byteLength > maximumBytes) throw new Error("invalid file");
  return value;
}

/** Loads one immutable, build-produced shell before the API starts listening. */
export async function loadHostedWebShell(root = defaultRoot): Promise<HostedWebShell> {
  try {
    const htmlBytes = await boundedFile(`${root}/hosted.html`, 64 * 1024);
    const icon = await boundedFile(`${root}/favicon.svg`, 32 * 1024);
    const entries = await readdir(`${root}/assets`, { withFileTypes: true });
    if (entries.length === 0 || entries.length > maximumAssetCount)
      throw new Error("invalid assets");

    const assets = new Map<string, HostedWebAsset>();
    let bundleBytes = htmlBytes.byteLength + icon.byteLength;
    for (const entry of entries) {
      if (!entry.isFile() || !assetNamePattern.test(entry.name)) throw new Error("invalid asset");
      const body = await boundedFile(`${root}/assets/${entry.name}`, maximumAssetBytes);
      bundleBytes += body.byteLength;
      if (bundleBytes > maximumBundleBytes) throw new Error("oversized bundle");
      assets.set(entry.name, Object.freeze({ body, contentType: assetContentType(entry.name) }));
    }

    const html = htmlBytes.toString("utf8");
    const references = [...html.matchAll(/(?:src|href)="\/assets\/([^"]+)"/gu)].map(
      (match) => match[1],
    );
    const referencedAssets = new Set(references);
    if (
      !html.includes('id="root"') ||
      references.length === 0 ||
      references.some((name) => name === undefined || !assets.has(name)) ||
      referencedAssets.size !== assets.size
    ) {
      throw new Error("invalid shell");
    }
    return Object.freeze({ html, icon, assets });
  } catch {
    throw new Error("Hosted web shell could not be loaded.");
  }
}

function applyDocumentHeaders(reply: FastifyReply): void {
  reply.header("cache-control", "no-store");
  reply.header("content-security-policy", shellSecurityPolicy);
  reply.header("referrer-policy", "no-referrer");
  reply.header("x-content-type-options", "nosniff");
}

export async function registerHostedWebShell(
  app: FastifyInstance,
  shell: HostedWebShell,
): Promise<void> {
  app.get("/", async (_request, reply) => {
    applyDocumentHeaders(reply);
    return reply.type("text/html; charset=utf-8").send(shell.html);
  });

  app.get("/favicon.svg", async (_request, reply) => {
    reply.header("cache-control", "public, max-age=3600");
    reply.header("x-content-type-options", "nosniff");
    return reply.type("image/svg+xml").send(shell.icon);
  });

  app.get<{ Params: { asset: string } }>("/assets/:asset", async (request, reply) => {
    const asset = shell.assets.get(request.params.asset);
    if (asset === undefined) return reply.code(404).send();
    reply.header("cache-control", "public, max-age=31536000, immutable");
    reply.header("x-content-type-options", "nosniff");
    return reply.type(asset.contentType).send(asset.body);
  });
}
