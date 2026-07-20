import { execFile as execFileCallback } from "node:child_process";
import { lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { validateDesktopRuntime } from "./build-desktop-runtime.js";

const execFile = promisify(execFileCallback);
const NATIVE_SMOKE_TIMEOUT_MS = 450_000;
const MAX_DIAGNOSTIC_FILE_BYTES = 64 * 1024;
const JOURNAL_PHASES = new Set([
  "initializing",
  "starting_database",
  "verifying_database",
  "backing_up_database",
  "migrating_database",
  "starting_api",
  "starting_worker",
  "ready",
  "stopping",
]);

type Launch = (
  executable: string,
  arguments_: readonly string[],
  options: Readonly<{ timeout: number; windowsHide: boolean }>,
) => Promise<number | NativeLaunchResult>;

interface NativeLaunchResult {
  readonly exitCode: number;
  readonly databaseStart?: string;
}

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

async function regularDirectory(directory: string): Promise<boolean> {
  const entry = await lstat(directory).catch(() => null);
  return entry?.isDirectory() === true && !entry.isSymbolicLink();
}

async function exactMarker(file: string, expected: string): Promise<boolean> {
  const entry = await lstat(file).catch(() => null);
  if (
    entry?.isFile() !== true ||
    entry.isSymbolicLink() ||
    entry.size !== Buffer.byteLength(expected)
  )
    return false;
  return (await readFile(file, "utf8").catch(() => "")) === expected;
}

async function postgresLogState(log: string): Promise<string> {
  const entry = await lstat(log).catch(() => null);
  if (entry?.isFile() !== true || entry.isSymbolicLink() || entry.size > MAX_DIAGNOSTIC_FILE_BYTES)
    return "missing";
  const contents = await readFile(log, "utf8").catch(() => "");
  const markers: ReadonlyArray<readonly [string, readonly string[]]> = [
    ["ready", ["database system is ready to accept connections"]],
    ["bind", ["could not bind IPv4 address", "could not create any TCP/IP sockets"]],
    [
      "access",
      [
        "Permission denied",
        "Access is denied",
        "could not open file",
        "could not create lock file",
        "could not open configuration file",
      ],
    ],
    ["fatal", ["FATAL:", "PANIC:"]],
  ];
  let latest = { index: -1, state: contents.trim() === "" ? "missing" : "other" };
  for (const [state, phrases] of markers) {
    const index = Math.max(...phrases.map((phrase) => contents.lastIndexOf(phrase)));
    if (index > latest.index) latest = { index, state };
  }
  return latest.state;
}

async function installedExecutable(
  root: string,
  runtime: string,
  target: "windows" | "linux",
): Promise<string> {
  if (target === "windows") {
    const executable = path.join(root, "schedule-desktop.exe");
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
): Promise<NativeLaunchResult> {
  try {
    await execFile(executable, arguments_, {
      shell: false,
      timeout: options.timeout,
      windowsHide: options.windowsHide,
      maxBuffer: 1_024 * 1_024,
    });
    return { exitCode: 0 };
  } catch (error) {
    const code =
      typeof (error as { code?: unknown }).code === "number"
        ? (error as { code: number }).code
        : 124;
    const databaseStart = databaseStartupDiagnostic((error as { stderr?: unknown }).stderr);
    return {
      exitCode: Number.isSafeInteger(code) && code >= 0 ? code : 124,
      ...(databaseStart ? { databaseStart } : {}),
    };
  }
}

export function databaseStartupDiagnostic(stderr: unknown): string | undefined {
  const contents =
    typeof stderr === "string" ? stderr : Buffer.isBuffer(stderr) ? stderr.toString("utf8") : "";
  if (Buffer.byteLength(contents) > MAX_DIAGNOSTIC_FILE_BYTES) return undefined;
  const prefix = "SCHEDULE_DESKTOP_DATABASE_STARTUP=";
  for (const line of contents.split(/\r?\n/u).reverse()) {
    if (!line.startsWith(prefix)) continue;
    const state = validatedDatabaseStartupState(line.slice(prefix.length));
    if (state) return state;
  }
  return undefined;
}

function validatedDatabaseStartupState(value: unknown): string | undefined {
  if (value === "guardian_admission_failed") return value;
  if (typeof value !== "string") return undefined;
  const match = /^post_admission_exit:(unknown|\d{1,10})$/u.exec(value);
  if (!match) return undefined;
  if (match[1] === "unknown") return value;
  const code = Number(match[1]);
  return Number.isSafeInteger(code) && code <= 0xffff_ffff ? value : undefined;
}

async function lifecycleDiagnostic(dataRoot: string): Promise<string> {
  const journal = path.join(dataRoot, "runtime", "journal.json");
  const stat = await lstat(journal).catch(() => null);
  if (stat?.isFile() !== true || stat.isSymbolicLink() || stat.size > MAX_DIAGNOSTIC_FILE_BYTES)
    return "journal unavailable";
  try {
    const value = JSON.parse(await readFile(journal, "utf8")) as {
      schema_version?: unknown;
      attempt?: { id?: unknown; phase?: unknown };
      prior_success?: unknown;
    };
    const attempt = value.attempt?.id;
    const phase = value.attempt?.phase;
    if (
      value.schema_version !== 1 ||
      typeof attempt !== "number" ||
      !Number.isSafeInteger(attempt) ||
      attempt < 1 ||
      typeof phase !== "string" ||
      !JOURNAL_PHASES.has(phase)
    )
      return "journal invalid";
    const staging = path.join(dataRoot, "postgresql", ".schedule-initializing-v1");
    const finalData = path.join(dataRoot, "postgresql", "data");
    const [
      stagingPresent,
      finalPresent,
      initdbMarker,
      bootstrapMarker,
      postmasterOpts,
      collectorLog,
    ] = await Promise.all([
      regularDirectory(staging),
      regularDirectory(finalData),
      exactMarker(path.join(staging, "SCHEDULE_INITDB_COMPLETE_V1"), "schedule-initdb-v1\n"),
      exactMarker(path.join(staging, "SCHEDULE_BOOTSTRAPPED_V1"), "schedule-bootstrap-v1\n"),
      regularFile(path.join(staging, "postmaster.opts")),
      postgresLogState(path.join(dataRoot, "logs", "postgresql.log")),
    ]);
    return [
      `attempt ${attempt}`,
      `phase ${phase}`,
      `prior-success ${value.prior_success != null}`,
      `staging ${stagingPresent}`,
      `final ${finalPresent}`,
      `initdb-marker ${initdbMarker}`,
      `bootstrap-marker ${bootstrapMarker}`,
      `postmaster-opts ${postmasterOpts}`,
      `postgres-log ${collectorLog}`,
    ].join(", ");
  } catch {
    return "journal invalid";
  }
}

async function launchNativeLifecycle(
  executable: string,
  runtime: string,
  launch: Launch,
  removeTemporaryRoot: (root: string) => Promise<void>,
): Promise<void> {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "schedule-installed-smoke-"));
  // The native runtime must create this child itself so Windows can apply its
  // protected, user-only ACL exactly as it does on a real first launch.
  const dataRoot = path.join(temporaryRoot, "data");
  let failed = false;
  let failure: unknown;
  try {
    const arguments_ = [
      "--schedule-runtime-smoke",
      "--runtime-root",
      runtime,
      "--data-root",
      dataRoot,
    ];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await launch(executable, arguments_, {
        timeout: NATIVE_SMOKE_TIMEOUT_MS,
        windowsHide: true,
      });
      const code = typeof result === "number" ? result : result.exitCode;
      if (code !== 0) {
        const databaseStart =
          typeof result === "number"
            ? undefined
            : validatedDatabaseStartupState(result.databaseStart);
        const diagnostic =
          code === 11
            ? `, ${await lifecycleDiagnostic(dataRoot)}${databaseStart ? `, database-start ${databaseStart}` : ""}`
            : "";
        throw new Error(
          `Installed Schedule lifecycle smoke failed (exit code ${code}${diagnostic}).`,
        );
      }
    }
  } catch (error: unknown) {
    failed = true;
    failure = error;
  }
  try {
    await removeTemporaryRoot(temporaryRoot);
  } catch {
    if (!failed) {
      failed = true;
      failure = new Error("Installed Schedule lifecycle smoke failed (exit code 125).");
    }
  }
  if (failed) throw failure;
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
