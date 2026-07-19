import { execFile as execFileCallback } from "node:child_process";
import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { validateDesktopRuntime } from "./build-desktop-runtime.js";

const execFile = promisify(execFileCallback);

/**
 * Validate the immutable runtime carried by an unpacked desktop bundle.
 *
 * This deliberately does not pretend to exercise a GUI.  A real launch smoke
 * requires the native adapter's explicit, bounded headless test hook; without
 * that hook a CI process cannot distinguish a running webview from a hung one.
 */
export async function smokeDesktopBundle(
  bundleDirectory: string,
  options: Readonly<{ requireLaunch?: boolean; probeExecutables?: boolean }> = {},
): Promise<void> {
  if (options.requireLaunch) {
    throw new Error(
      "Installed GUI smoke is unavailable: the native adapter has no bounded headless smoke hook.",
    );
  }
  const root = path.resolve(bundleDirectory);
  const stat = await lstat(root).catch(() => null);
  if (stat?.isDirectory() !== true || stat.isSymbolicLink())
    throw new Error("Desktop bundle root must be a regular directory.");
  const directRuntime = path.join(root, "runtime");
  let runtime = directRuntime;
  let manifest: Awaited<ReturnType<typeof validateDesktopRuntime>>;
  if ((await lstat(directRuntime).catch(() => null))?.isDirectory()) {
    manifest = await validateDesktopRuntime(directRuntime);
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
