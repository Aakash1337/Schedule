import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateDesktopRuntime } from "./build-desktop-runtime.js";

const targetTriples = {
  "linux-aarch64": "aarch64-unknown-linux-gnu",
  "linux-x86_64": "x86_64-unknown-linux-gnu",
  "windows-aarch64": "aarch64-pc-windows-msvc",
  "windows-x86_64": "x86_64-pc-windows-msvc",
} as const;
const BOOTSTRAP_FILE = ".gitkeep";
const BOOTSTRAP_CONTENT = "staged at build\n";
const STAGING_LOCK = ".schedule-runtime-stage.lock";

type Target = keyof typeof targetTriples;
type Runner = (
  command: string,
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
) => Promise<void>;
type Copier = (source: string, destination: string) => Promise<void>;

export type Platform = "win32" | "linux";

export interface DesktopReleaseOptions {
  readonly runtimeDirectory: string;
  readonly repositoryDirectory?: string;
  readonly target?: Target;
  readonly runTauri?: Runner;
  readonly platform?: Platform;
  readonly npmExecPath?: string;
  readonly copyEntry?: Copier;
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function targetFromManifest(manifest: { target: { os: string; arch: string } }): Target {
  const key = `${manifest.target.os}-${manifest.target.arch}`;
  if (!(key in targetTriples)) throw new Error("Runtime manifest target is unsupported.");
  return key as Target;
}

async function npmEntryPoint(value: string | undefined): Promise<string> {
  if (value === undefined || !path.isAbsolute(value) || path.basename(value) !== "pnpm.cjs") {
    throw new Error("npm_execpath must be an absolute pnpm.cjs entry point.");
  }
  const metadata = await lstat(value).catch(() => null);
  if (metadata === null || !metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("npm_execpath must identify a regular pnpm.cjs file.");
  }
  return value;
}

async function defaultRunner(
  command: string,
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
  cwd: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd,
      env: environment,
      shell: false,
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`Tauri exited with ${code}.`)),
    );
  });
}

function assertUnder(parent: string, candidate: string): void {
  const relative = path.relative(parent, candidate);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Desktop resource staging path escapes the application directory.");
  }
}

async function reserveRuntime(stagedRuntime: string): Promise<void> {
  try {
    await mkdir(stagedRuntime);
    return;
  } catch (error: unknown) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
  }
  const entries = await readdir(stagedRuntime);
  if (
    entries.length !== 1 ||
    entries[0] !== BOOTSTRAP_FILE ||
    (await readFile(path.join(stagedRuntime, BOOTSTRAP_FILE), "utf8")) !== BOOTSTRAP_CONTENT
  ) {
    throw new Error("Desktop runtime staging already exists; refusing to overwrite it.");
  }
  await rm(stagedRuntime, { recursive: true, force: false });
  await mkdir(stagedRuntime);
}

async function restoreBootstrap(stagedRuntime: string): Promise<void> {
  await mkdir(stagedRuntime, { recursive: true });
  await writeFile(path.join(stagedRuntime, BOOTSTRAP_FILE), BOOTSTRAP_CONTENT, {
    encoding: "utf8",
    flag: "w",
  });
}

async function acquireStageLock(resourceParent: string, token: string): Promise<string> {
  const lock = path.join(resourceParent, STAGING_LOCK);
  try {
    await writeFile(lock, `${token}\n`, { encoding: "utf8", flag: "wx" });
    return lock;
  } catch (error: unknown) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new Error("Desktop runtime packaging is already in progress.");
    }
    throw error;
  }
}

/** Stage an already assembled runtime, bind its manifest hash at build time, then remove staging. */
export async function packageDesktopRelease(options: DesktopReleaseOptions): Promise<void> {
  const repositoryDirectory = path.resolve(
    options.repositoryDirectory ?? path.resolve(import.meta.dirname, ".."),
  );
  const runtimeDirectory = path.resolve(options.runtimeDirectory);
  const manifest = await validateDesktopRuntime(runtimeDirectory);
  const target = targetFromManifest(manifest);
  const manifestHash = sha256(await readFile(path.join(runtimeDirectory, "runtime-manifest.json")));
  if (options.target !== undefined && options.target !== target) {
    throw new Error("Requested target does not match the assembled runtime manifest.");
  }
  const resourceParent = path.join(
    repositoryDirectory,
    "apps",
    "desktop",
    "src-tauri",
    "resources",
  );
  const stagedRuntime = path.join(resourceParent, "runtime");
  assertUnder(resourceParent, stagedRuntime);
  await mkdir(resourceParent, { recursive: true });
  const id = randomUUID();
  let lock: string | undefined;
  try {
    lock = await acquireStageLock(resourceParent, id);
    await reserveRuntime(stagedRuntime);
    const copyEntry =
      options.copyEntry ??
      ((source, destination) =>
        cp(source, destination, {
          recursive: true,
          dereference: false,
          errorOnExist: true,
          force: false,
        }));
    await Promise.all(
      (await readdir(runtimeDirectory)).map((entry) =>
        copyEntry(path.join(runtimeDirectory, entry), path.join(stagedRuntime, entry)),
      ),
    );
    if (
      sha256(await readFile(path.join(stagedRuntime, "runtime-manifest.json"))) !== manifestHash ||
      (await validateDesktopRuntime(stagedRuntime)).artifacts.licensesSha256 !==
        manifest.artifacts.licensesSha256
    ) {
      throw new Error("Staged runtime manifest does not match the assembled runtime.");
    }
    const runner =
      options.runTauri ??
      ((command, arguments_, environment) =>
        defaultRunner(command, arguments_, environment, repositoryDirectory));
    const platform = options.platform ?? process.platform;
    const command = platform === "win32" ? process.execPath : "pnpm";
    const pnpmEntry =
      platform === "win32"
        ? await npmEntryPoint(options.npmExecPath ?? process.env.npm_execpath)
        : undefined;
    await runner(
      command,
      [
        ...(pnpmEntry === undefined ? [] : [pnpmEntry]),
        "--filter",
        "@schedule/desktop",
        "exec",
        "tauri",
        "build",
        "--target",
        targetTriples[target],
      ],
      {
        ...process.env,
        SCHEDULE_DESKTOP_RUNTIME_MANIFEST_SHA256: manifestHash,
      },
    );
  } finally {
    if (lock !== undefined && (await readFile(lock, "utf8").catch(() => "")) === `${id}\n`) {
      await rm(stagedRuntime, { recursive: true, force: true });
      await restoreBootstrap(stagedRuntime);
      await rm(lock, { force: true });
    }
  }
}

export function parseDesktopReleaseArguments(arguments_: readonly string[]): DesktopReleaseOptions {
  if (arguments_.length !== 2 || arguments_[0] !== "--runtime" || !arguments_[1]) {
    throw new Error("Usage: desktop:package --runtime <assembled-runtime-root>");
  }
  return { runtimeDirectory: arguments_[1] };
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void packageDesktopRelease(parseDesktopReleaseArguments(process.argv.slice(2))).catch(
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
