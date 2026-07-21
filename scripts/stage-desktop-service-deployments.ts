import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { copyFile, lstat, mkdir, readdir, readFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadMigrationManifest } from "../packages/database/src/migration-ledger.js";
import { hashTree } from "./build-desktop-runtime.js";
import { DESKTOP_PORTABLE_MODULES } from "./desktop-portable-modules.js";

export interface DeployCommand {
  (
    command: string,
    arguments_: readonly string[],
    options: Readonly<{ cwd: string }>,
  ): Promise<void>;
}

export interface DesktopServiceDeploymentOptions {
  readonly sourceDirectory: string;
  readonly outputDirectory: string;
  readonly deploy?: DeployCommand;
}

export interface DesktopServiceDeployments {
  readonly apiDeploymentDirectory: string;
  readonly workerDeploymentDirectory: string;
  readonly apiSha256: string;
  readonly workerSha256: string;
}

function isPortableComponent(component: string): boolean {
  const stem = component.split(".", 1)[0]?.toUpperCase() ?? "";
  return (
    component !== "" &&
    component !== "." &&
    component !== ".." &&
    !component.endsWith(".") &&
    !component.endsWith(" ") &&
    !/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(stem) &&
    [...component].every((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 0x20 && code <= 0x7e && !'<>:"\\|?*'.includes(character);
    })
  );
}

function assertPortableRelative(relative: string): void {
  if (!relative.split("/").every(isPortableComponent)) {
    throw new Error(`Deployment contains a nonportable path: ${relative}`);
  }
}

function relativeWithin(root: string, candidate: string): string {
  const relative = path.relative(root, candidate);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Deployment link escapes its raw deploy root: ${candidate}`);
  }
  const portable = relative.split(path.sep).join("/");
  assertPortableRelative(portable);
  return portable;
}

function pathIdentity(candidate: string): string {
  const normalized = path.normalize(candidate);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

async function reserveOutput(directory: string, label: string): Promise<void> {
  await mkdir(path.dirname(directory), { recursive: true });
  try {
    await mkdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`${label} already exists and will not be replaced: ${directory}`, {
        cause: error,
      });
    }
    throw error;
  }
}

async function copyMaterializedTree(
  rawRoot: string,
  destination: string,
  selfLink: Readonly<{ relative: string; target: string }>,
): Promise<void> {
  const canonicalRoot = await realpath(rawRoot);
  const canonicalRootIdentity = pathIdentity(canonicalRoot);
  const canonicalSelfLinkTarget = pathIdentity(await realpath(selfLink.target));
  const expectedSelfLink = pathIdentity(path.join(rawRoot, ...selfLink.relative.split("/")));
  const rootEntry = await lstat(rawRoot).catch(() => null);
  if (rootEntry === null || !rootEntry.isDirectory() || rootEntry.isSymbolicLink()) {
    throw new Error(`Raw deployment must be a non-symlink directory: ${rawRoot}`);
  }
  const copyDirectory = async (
    source: string,
    target: string,
    ancestors: ReadonlySet<string>,
  ): Promise<void> => {
    const canonical = await realpath(source);
    const canonicalIdentity = pathIdentity(canonical);
    if (canonicalIdentity !== canonicalRootIdentity) relativeWithin(canonicalRoot, canonical);
    if (ancestors.has(canonicalIdentity)) {
      throw new Error(`Deployment link cycle detected at ${source}`);
    }
    await mkdir(target, { recursive: false });
    const nextAncestors = new Set(ancestors).add(canonicalIdentity);
    const portableNames = new Set<string>();
    for (const entry of await readdir(source, { withFileTypes: true })) {
      assertPortableRelative(entry.name);
      const collisionKey = entry.name.toLowerCase();
      if (portableNames.has(collisionKey)) {
        throw new Error(
          `Deployment contains a case-colliding path: ${source}${path.sep}${entry.name}`,
        );
      }
      portableNames.add(collisionKey);
      const childSource = path.join(source, entry.name);
      const childTarget = path.join(target, entry.name);
      if (entry.isDirectory()) await copyDirectory(childSource, childTarget, nextAncestors);
      else if (entry.isFile()) await copyFile(childSource, childTarget, 0);
      else if (entry.isSymbolicLink()) {
        const canonicalTarget = await realpath(childSource);
        if (
          pathIdentity(childSource) === expectedSelfLink &&
          pathIdentity(canonicalTarget) === canonicalSelfLinkTarget
        ) {
          continue;
        }
        if (pathIdentity(canonicalTarget) !== canonicalRootIdentity) {
          relativeWithin(canonicalRoot, canonicalTarget);
        }
        const targetEntry = await lstat(canonicalTarget);
        if (targetEntry.isDirectory()) await copyDirectory(childSource, childTarget, nextAncestors);
        else if (targetEntry.isFile()) await copyFile(childSource, childTarget, 0);
        else
          throw new Error(
            `Deployment link must resolve to a regular file or directory: ${childSource}`,
          );
      } else throw new Error(`Deployment contains a non-regular filesystem entry: ${childSource}`);
    }
  };
  await copyDirectory(rawRoot, destination, new Set());
}

async function requireFile(root: string, relative: string, label: string): Promise<void> {
  assertPortableRelative(relative);
  const target = path.join(root, ...relative.split("/"));
  relativeWithin(root, target);
  const entry = await lstat(target).catch(() => null);
  if (entry === null || !entry.isFile() || entry.isSymbolicLink()) {
    throw new Error(`${label} is required at ${relative}.`);
  }
}

async function requireDesktopPortableModules(root: string): Promise<void> {
  for (const file of DESKTOP_PORTABLE_MODULES) {
    await requireFile(
      root,
      `node_modules/@schedule/database/dist/${file}`,
      `Database desktop portable export module ${file}`,
    );
  }
}

async function validateDeclaredDependencies(
  root: string,
  packageDirectory: string,
  label: string,
): Promise<void> {
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(path.join(packageDirectory, "package.json"), "utf8"));
  } catch {
    throw new Error(`${label} needs valid package metadata.`);
  }
  const dependencies = (manifest as { dependencies?: unknown }).dependencies;
  if (
    dependencies !== undefined &&
    (typeof dependencies !== "object" || dependencies === null || Array.isArray(dependencies))
  ) {
    throw new Error(`${label} has invalid dependencies.`);
  }
  for (const dependency of Object.keys(dependencies ?? {})) {
    await requireFile(
      root,
      `node_modules/${dependency}/package.json`,
      `Runtime dependency ${dependency} for ${label}`,
    );
  }
}

async function validateWorkspaceDependencyClosure(root: string): Promise<void> {
  await validateDeclaredDependencies(root, root, "Deployment root");
  const scope = path.join(root, "node_modules", "@schedule");
  const packages = await readdir(scope, { withFileTypes: true }).catch(() => null);
  if (packages === null || packages.length === 0) {
    throw new Error("Deployment needs materialized @schedule runtime packages.");
  }
  for (const entry of packages) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(`Workspace deployment package @schedule/${entry.name} must be a directory.`);
    }
    await validateDeclaredDependencies(
      root,
      path.join(scope, entry.name),
      `Workspace deployment package @schedule/${entry.name}`,
    );
  }
}

function assertMigrationTag(tag: string): void {
  if (tag.includes("/") || tag.includes("\\") || !isPortableComponent(tag)) {
    throw new Error("Migration journal contains an invalid migration tag.");
  }
}

async function validateApiDeployment(root: string): Promise<void> {
  await requireFile(root, "dist/server.js", "API server entrypoint");
  await requireFile(
    root,
    "node_modules/@schedule/database/dist/migrate.js",
    "Database migration entrypoint",
  );
  await requireFile(
    root,
    "node_modules/@schedule/database/dist/migration-ledger.js",
    "Database migration ledger helper",
  );
  await requireFile(
    root,
    "node_modules/@schedule/database/dist/migration-sql.js",
    "Database migration SQL safety helper",
  );
  await requireDesktopPortableModules(root);
  const journal = path.join(
    root,
    "node_modules",
    "@schedule",
    "database",
    "drizzle",
    "meta",
    "_journal.json",
  );
  await requireFile(
    root,
    "node_modules/@schedule/database/drizzle/meta/_journal.json",
    "Migration journal",
  );
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(journal, "utf8"));
  } catch {
    throw new Error("Migration journal must be valid JSON.");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as { entries?: unknown }).entries)
  ) {
    throw new Error("Migration journal must contain an entries array.");
  }
  for (const entry of (parsed as { entries: unknown[] }).entries) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof (entry as { tag?: unknown }).tag !== "string"
    ) {
      throw new Error("Migration journal contains an invalid migration tag.");
    }
    const tag = (entry as { tag: string }).tag;
    assertMigrationTag(tag);
    await requireFile(
      root,
      `node_modules/@schedule/database/drizzle/${tag}.sql`,
      "Journaled SQL migration",
    );
  }
  await requireFile(
    root,
    "node_modules/@schedule/database/drizzle/meta/_migration_manifest.json",
    "Immutable migration manifest",
  );
  await loadMigrationManifest(path.dirname(path.dirname(journal)));
  await validateWorkspaceDependencyClosure(root);
}

async function validateWorkerDeployment(root: string): Promise<void> {
  await requireFile(root, "dist/index.js", "Worker entrypoint");
  await validateWorkspaceDependencyClosure(root);
}

async function currentPnpmCli(): Promise<string> {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath === undefined || !path.isAbsolute(npmExecPath)) {
    throw new Error("pnpm must provide an absolute npm_execpath for desktop deployment staging.");
  }
  const cli = await realpath(npmExecPath);
  const entry = await lstat(cli).catch(() => null);
  if (entry === null || !entry.isFile() || !/^pnpm(?:\.[cm]?js)?$/iu.test(path.basename(cli))) {
    throw new Error("npm_execpath must resolve to the current pnpm CLI file.");
  }
  return cli;
}

const runPnpmDeploy: DeployCommand = async (_command, arguments_, options) => {
  const pnpmCli = await currentPnpmCli();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [pnpmCli, ...arguments_], {
      cwd: options.cwd,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`pnpm exited with ${code ?? "no"} status.`)),
    );
  });
};

/** Create portable, immutable service deployment trees and return assembler-compatible pins. */
export async function stageDesktopServiceDeployments(
  options: DesktopServiceDeploymentOptions,
): Promise<DesktopServiceDeployments> {
  const sourceDirectory = path.resolve(options.sourceDirectory);
  const outputDirectory = path.resolve(options.outputDirectory);
  await reserveOutput(outputDirectory, "Desktop service deployment output");
  const rawDirectory = `${outputDirectory}.raw-${randomUUID()}`;
  try {
    await mkdir(rawDirectory);
    const rawApi = path.join(rawDirectory, "api");
    const rawWorker = path.join(rawDirectory, "worker");
    const deploy = options.deploy ?? runPnpmDeploy;
    const deployPackage = async (name: string, destination: string) =>
      await deploy(
        "pnpm",
        [
          "--config.node-linker=hoisted",
          "--filter",
          name,
          "deploy",
          "--prod",
          "--legacy",
          destination,
        ],
        { cwd: sourceDirectory },
      );
    await deployPackage("@schedule/api", rawApi);
    await deployPackage("@schedule/worker", rawWorker);
    const api = path.join(outputDirectory, "api");
    const worker = path.join(outputDirectory, "worker");
    await copyMaterializedTree(rawApi, api, {
      relative: "node_modules/.pnpm/node_modules/@schedule/api",
      target: path.join(sourceDirectory, "apps", "api"),
    });
    await copyMaterializedTree(rawWorker, worker, {
      relative: "node_modules/.pnpm/node_modules/@schedule/worker",
      target: path.join(sourceDirectory, "apps", "worker"),
    });
    await Promise.all([validateApiDeployment(api), validateWorkerDeployment(worker)]);
    const apiSha256 = await hashTree(api);
    const workerSha256 = await hashTree(worker);
    return {
      apiDeploymentDirectory: api,
      workerDeploymentDirectory: worker,
      apiSha256,
      workerSha256,
    };
  } catch (error) {
    await rm(outputDirectory, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(rawDirectory, { recursive: true, force: true });
  }
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  const output = process.argv[2];
  if (output === undefined)
    throw new Error("Usage: stage-desktop-service-deployments.ts <output-directory>");
  void stageDesktopServiceDeployments({
    sourceDirectory: process.cwd(),
    outputDirectory: output,
  }).then(
    (deployments) => process.stdout.write(`${JSON.stringify(deployments)}\n`),
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
