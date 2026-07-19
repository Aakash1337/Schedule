import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Validate the immutable runtime carried by an unpacked desktop bundle.
 *
 * This deliberately does not pretend to exercise a GUI.  A real launch smoke
 * requires the native adapter's explicit, bounded headless test hook; without
 * that hook a CI process cannot distinguish a running webview from a hung one.
 */
export async function smokeDesktopBundle(
  bundleDirectory: string,
  options: Readonly<{ requireLaunch?: boolean }> = {},
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
  const candidates = [
    path.join(root, "resources", "runtime", "runtime-manifest.json"),
    path.join(root, "usr", "lib", "Schedule", "resources", "runtime", "runtime-manifest.json"),
  ];
  const manifest = await Promise.any(
    candidates.map((candidate) => readFile(candidate, "utf8")),
  ).catch(() => undefined);
  if (manifest === undefined) {
    const entries = (await readdir(root)).join(", ");
    throw new Error(`Bundle does not contain an unpacked Schedule runtime (${entries}).`);
  }
  const parsed: unknown = JSON.parse(manifest);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray((parsed as { components?: unknown }).components) ||
    (parsed as { components: unknown[] }).components.length !== 4
  ) {
    throw new Error("Bundled runtime manifest is malformed.");
  }
}

function argumentsFor(
  argv: readonly string[],
): Readonly<{ bundle: string; requireLaunch: boolean }> {
  const requireLaunch = argv[0] === "--require-launch";
  const bundle = argv[requireLaunch ? 1 : 0];
  if (bundle === undefined || argv.length !== (requireLaunch ? 2 : 1))
    throw new Error(
      "Usage: smoke-desktop-installer [--require-launch] <unpacked-bundle-directory>",
    );
  return { bundle, requireLaunch };
}

if (process.argv[1]?.endsWith("smoke-desktop-installer.ts")) {
  const options = argumentsFor(process.argv.slice(2));
  void smokeDesktopBundle(options.bundle, { requireLaunch: options.requireLaunch }).catch(
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
