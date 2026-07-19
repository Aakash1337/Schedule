import { execFile as execFileCallback } from "node:child_process";
import { lstat, mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { validateDesktopRuntime } from "./build-desktop-runtime.js";

const execFile = promisify(execFileCallback);
const NATIVE_SMOKE_TIMEOUT_MS = 450_000;

type Launch = (
  executable: string,
  arguments_: readonly string[],
  options: Readonly<{ timeout: number; windowsHide: boolean }>,
) => Promise<number>;

export interface DesktopSmokeOptions {
  readonly requireLaunch?: boolean;
  readonly probeExecutables?: boolean;
  /** Test seam for asserting the installed native lifecycle contract. */
  readonly launch?: Launch;
  /** Test seam for asserting cleanup failures remain redacted. */
  readonly removeDataRoot?: (root: string) => Promise<void>;
}

async function regularFile(file: string): Promise<boolean> {
  const entry = await lstat(file).catch(() => null);
  return entry?.isFile() === true && !entry.isSymbolicLink();
}

async function installedExecutable(
  root: string,
  runtime: string,
  target: "windows" | "linux",
): Promise<string> {
  if (target === "windows") {
    const executable = path.join(root, "Schedule.exe");
    if (!(await regularFile(executable)))
      throw new Error("Installed Schedule executable is missing.");
    return executable;
  }
  const bin = path.join(root, "usr", "bin");
  const candidates = await Promise.all(
    (await readdir(bin, { withFileTypes: true }).catch(() => []))
      .filter((entry) => entry.isFile() && !entry.isSymbolicLink())
      .map(async (entry) => ({
        name: entry.name,
        executable:
          process.platform === "win32" ||
          ((await lstat(path.join(bin, entry.name))).mode & 0o111) !== 0,
      })),
  );
  const executableCandidates = candidates.filter((candidate) => candidate.executable);
  if (executableCandidates.length !== 1)
    throw new Error("Installed Schedule executable is missing.");
  const executable = path.join(bin, executableCandidates[0]!.name);
  if (!(await regularFile(executable)))
    throw new Error("Installed Schedule executable is missing.");
  // The runtime was discovered from this package's usr/lib tree before its binary is admitted.
  if (!runtime.startsWith(`${path.join(root, "usr", "lib")}${path.sep}`))
    throw new Error("Installed Schedule executable is not paired with its runtime.");
  return executable;
}

async function defaultLaunch(
  executable: string,
  arguments_: readonly string[],
  options: Readonly<{ timeout: number; windowsHide: boolean }>,
): Promise<number> {
  try {
    await execFile(executable, arguments_, {
      shell: false,
      timeout: options.timeout,
      windowsHide: options.windowsHide,
      maxBuffer: 1_024,
    });
    return 0;
  } catch (error) {
    const code =
      typeof (error as { code?: unknown }).code === "number"
        ? (error as { code: number }).code
        : 124;
    return Number.isSafeInteger(code) && code >= 0 ? code : 124;
  }
}

async function launchNativeLifecycle(
  executable: string,
  runtime: string,
  launch: Launch,
  removeDataRoot: (root: string) => Promise<void>,
): Promise<void> {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "schedule-installed-smoke-"));
  let childFailed = false;
  try {
    const arguments_ = [
      "--schedule-runtime-smoke",
      "--runtime-root",
      runtime,
      "--data-root",
      dataRoot,
    ];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const code = await launch(executable, arguments_, {
        timeout: NATIVE_SMOKE_TIMEOUT_MS,
        windowsHide: true,
      });
      if (code !== 0) {
        childFailed = true;
        throw new Error(`Installed Schedule lifecycle smoke failed (exit code ${code}).`);
      }
    }
  } finally {
    try {
      await removeDataRoot(dataRoot);
    } catch {
      if (!childFailed)
        throw new Error("Installed Schedule lifecycle smoke failed (exit code 125).");
    }
  }
}

/**
 * Validate the immutable runtime carried by an unpacked desktop bundle.
 *
 * This deliberately does not pretend to exercise a GUI.  A real launch smoke
 * requires the native adapter's explicit, bounded headless test hook; without
 * that hook a CI process cannot distinguish a running webview from a hung one.
 */
export async function smokeDesktopBundle(
  bundleDirectory: string,
  options: DesktopSmokeOptions = {},
): Promise<void> {
  const root = path.resolve(bundleDirectory);
  const stat = await lstat(root).catch(() => null);
  if (stat?.isDirectory() !== true || stat.isSymbolicLink())
    throw new Error("Desktop bundle root must be a regular directory.");
  const directRuntime = path.join(root, "runtime");
  let runtime = directRuntime;
  let target: "windows" | "linux";
  let manifest: Awaited<ReturnType<typeof validateDesktopRuntime>>;
  if ((await lstat(directRuntime).catch(() => null))?.isDirectory()) {
    manifest = await validateDesktopRuntime(directRuntime);
    target = "windows";
  } else {
    const libRoot = path.join(root, "usr", "lib");
    const candidates: string[] = [];
    for (const entry of await readdir(libRoot, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const candidate = path.join(libRoot, entry.name, "runtime");
      if ((await lstat(candidate).catch(() => null))?.isDirectory() !== true) continue;
      try {
        await validateDesktopRuntime(candidate);
        candidates.push(candidate);
      } catch {
        // Only a complete, authenticated runtime may identify the package directory.
      }
    }
    if (candidates.length !== 1) {
      const entries = (await readdir(root)).join(", ");
      throw new Error(
        candidates.length === 0
          ? `Bundle does not contain one validated Schedule runtime (${entries}).`
          : "Bundle contains multiple validated Schedule runtimes.",
      );
    }
    runtime = candidates[0]!;
    manifest = await validateDesktopRuntime(runtime);
    target = "linux";
  }
  if (options.probeExecutables) {
    const components = new Map(manifest.components.map((component) => [component.name, component]));
    for (const name of ["node", "postgresql"] as const) {
      const component = components.get(name);
      if (component === undefined || component.launch.kind !== "executable")
        throw new Error(`Bundled ${name} executable is missing.`);
      await execFile(path.join(runtime, ...component.launch.path.split("/")), ["--version"], {
        shell: false,
        timeout: 5_000,
        windowsHide: true,
        maxBuffer: 16 * 1024,
      });
    }
  }
  if (options.requireLaunch) {
    const executable = await installedExecutable(root, runtime, target);
    await launchNativeLifecycle(
      executable,
      runtime,
      options.launch ?? defaultLaunch,
      options.removeDataRoot ?? ((root) => rm(root, { recursive: true, force: true })),
    );
  }
}

function argumentsFor(
  argv: readonly string[],
): Readonly<{ bundle: string; requireLaunch: boolean; probeExecutables: boolean }> {
  const flags = new Set(argv.filter((value) => value.startsWith("--")));
  const requireLaunch = flags.has("--require-launch");
  const probeExecutables = flags.has("--probe-executables");
  const bundle = argv.find((value) => !value.startsWith("--"));
  if (
    bundle === undefined ||
    argv.length !== flags.size + 1 ||
    [...flags].some((flag) => flag !== "--require-launch" && flag !== "--probe-executables")
  )
    throw new Error(
      "Usage: smoke-desktop-installer [--require-launch] [--probe-executables] <unpacked-bundle-directory>",
    );
  return { bundle, requireLaunch, probeExecutables };
}

if (process.argv[1]?.endsWith("smoke-desktop-installer.ts")) {
  const options = argumentsFor(process.argv.slice(2));
  void smokeDesktopBundle(options.bundle, options).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
