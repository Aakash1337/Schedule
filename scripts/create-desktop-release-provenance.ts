import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

const INSTALLER = /(?:\.msi|\.deb|\.AppImage|-setup\.exe)$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

export interface ReleaseProvenanceOptions {
  readonly installerDirectory: string;
  readonly metadataDirectory: string;
  readonly target: "linux" | "windows";
  readonly version: string;
  readonly nodeVersion: string;
  readonly rustVersion: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function safeRelative(root: string, candidate: string): string {
  const relative = path.relative(root, candidate).split(path.sep).join("/");
  if (
    relative === "" ||
    relative.startsWith("../") ||
    path.isAbsolute(relative) ||
    !relative.split("/").every((part) => /^[A-Za-z0-9._-]+$/u.test(part))
  ) {
    throw new Error("Installer inventory has an unsafe relative filename.");
  }
  return relative;
}

async function installers(root: string): Promise<readonly { path: string; sha256: string }[]> {
  const files: { path: string; sha256: string }[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error("Installer inventory cannot contain links.");
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && INSTALLER.test(entry.name)) {
        files.push({ path: safeRelative(root, file), sha256: sha256(await readFile(file)) });
      }
    }
  };
  const stat = await lstat(root).catch(() => null);
  if (stat?.isDirectory() !== true || stat.isSymbolicLink())
    throw new Error("Installer directory must be a regular directory.");
  await visit(root);
  if (files.length === 0) throw new Error("No installer files were produced.");
  return files.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
}

function required(environment: ReleaseProvenanceOptions["environment"], name: string): string {
  const value = environment[name];
  if (value === undefined || value.length === 0 || /[\r\n]/u.test(value))
    throw new Error(`Release provenance requires ${name}.`);
  return value;
}

/** Write an immutable, deterministic release receipt after native installers have been produced. */
export async function createDesktopReleaseProvenance(
  options: ReleaseProvenanceOptions,
): Promise<void> {
  if (!VERSION.test(options.version)) throw new Error("Desktop release version is not semver.");
  if (!VERSION.test(options.nodeVersion) || !VERSION.test(options.rustVersion))
    throw new Error("Release toolchain version is not semver.");
  const metadata = path.resolve(options.metadataDirectory);
  const manifest = await readFile(path.join(metadata, "runtime-manifest.json"));
  const receipt = {
    schemaVersion: 1,
    version: options.version,
    target: options.target,
    toolchains: { node: options.nodeVersion, rust: options.rustVersion },
    source: {
      commit: required(options.environment, "GITHUB_SHA"),
      ref: required(options.environment, "GITHUB_REF"),
      event: required(options.environment, "GITHUB_EVENT_NAME"),
      runId: required(options.environment, "GITHUB_RUN_ID"),
      runAttempt: required(options.environment, "GITHUB_RUN_ATTEMPT"),
    },
    runtimeManifestSha256: sha256(manifest),
    installers: await installers(path.resolve(options.installerDirectory)),
  };
  if (!SHA256.test(receipt.runtimeManifestSha256))
    throw new Error("Runtime manifest hash is invalid.");
  await mkdir(metadata, { recursive: true });
  await writeFile(
    path.join(metadata, "release-provenance.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" },
  );
}

function parseArguments(argv: readonly string[]): Omit<ReleaseProvenanceOptions, "environment"> {
  const expected = new Set(["installers", "metadata", "target", "version", "node", "rust"]);
  if (
    argv.length !== 12 ||
    argv.some(
      (value, index) =>
        index % 2 === 0 && (!value.startsWith("--") || !expected.has(value.slice(2))),
    )
  ) {
    throw new Error("Arguments must be exactly six known --name value pairs.");
  }
  const get = (name: string) => {
    const value = argv[argv.indexOf(`--${name}`) + 1];
    if (value === undefined || value.startsWith("--")) throw new Error(`--${name} is required.`);
    return value;
  };
  const target = get("target");
  if (target !== "linux" && target !== "windows")
    throw new Error("--target must be linux or windows.");
  return {
    installerDirectory: get("installers"),
    metadataDirectory: get("metadata"),
    target,
    version: get("version"),
    nodeVersion: get("node"),
    rustVersion: get("rust"),
  };
}

if (process.argv[1]?.endsWith("create-desktop-release-provenance.ts")) {
  void createDesktopReleaseProvenance({
    ...parseArguments(process.argv.slice(2)),
    environment: process.env,
  }).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
