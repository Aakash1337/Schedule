import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export type PostgreSqlRuntimeTarget = "linux-x64" | "windows-x64";

export interface PostgreSqlRuntimeLock {
  readonly schemaVersion: 1;
  readonly postgresql: Readonly<{ version: string; url: string; sha256: string }>;
  readonly linuxDependencies: Readonly<{
    openssl: Readonly<{ version: string; url: string; sha256: string }>;
    zlib: Readonly<{ version: string; url: string; sha256: string }>;
  }>;
  readonly windowsDependencies: Readonly<{
    vcpkgBaseline: string;
    triplet: "x64-windows-static-md";
    mesonVersion: string;
    ninjaVersion: string;
    winFlexBison: Readonly<{ version: string; url: string; sha256: string }>;
  }>;
}

type RuntimeFile = Readonly<{ path: string; sha256: string; size: number }>;

const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_COMMIT = /^[a-f0-9]{40}$/u;
const VERSION = /^\d+\.\d+(?:\.\d+)?$/u;
const REQUIRED_TOOLS = [
  "initdb",
  "pg_ctl",
  "pg_dump",
  "pg_isready",
  "pg_restore",
  "postgres",
  "psql",
] as const;
const INVENTORY = "RUNTIME-FILES.json";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function source(value: unknown, label: string): { version: string; url: string; sha256: string } {
  if (
    !record(value) ||
    !exactKeys(value, ["version", "url", "sha256"]) ||
    typeof value.version !== "string" ||
    !VERSION.test(value.version) ||
    typeof value.url !== "string" ||
    !value.url.startsWith("https://") ||
    typeof value.sha256 !== "string" ||
    !SHA256.test(value.sha256)
  ) {
    throw new Error(`${label} lock entry is invalid.`);
  }
  return { version: value.version, url: value.url, sha256: value.sha256 };
}

export function parsePostgreSqlRuntimeLock(value: unknown): PostgreSqlRuntimeLock {
  if (
    !record(value) ||
    !exactKeys(value, [
      "schemaVersion",
      "postgresql",
      "linuxDependencies",
      "windowsDependencies",
    ]) ||
    value.schemaVersion !== 1 ||
    !record(value.linuxDependencies) ||
    !exactKeys(value.linuxDependencies, ["openssl", "zlib"]) ||
    !record(value.windowsDependencies) ||
    !exactKeys(value.windowsDependencies, [
      "vcpkgBaseline",
      "triplet",
      "mesonVersion",
      "ninjaVersion",
      "winFlexBison",
    ])
  ) {
    throw new Error("PostgreSQL runtime lock has an invalid schema.");
  }
  const postgresql = source(value.postgresql, "PostgreSQL");
  const openssl = source(value.linuxDependencies.openssl, "OpenSSL");
  const zlib = source(value.linuxDependencies.zlib, "zlib");
  const winFlexBison = source(value.windowsDependencies.winFlexBison, "WinFlexBison");
  const windows = value.windowsDependencies;
  if (
    typeof windows.vcpkgBaseline !== "string" ||
    !GIT_COMMIT.test(windows.vcpkgBaseline) ||
    windows.triplet !== "x64-windows-static-md" ||
    typeof windows.mesonVersion !== "string" ||
    !VERSION.test(windows.mesonVersion) ||
    typeof windows.ninjaVersion !== "string" ||
    !VERSION.test(windows.ninjaVersion) ||
    winFlexBison.url !==
      `https://github.com/lexxmark/winflexbison/releases/download/v${winFlexBison.version}/win_flex_bison-${winFlexBison.version}.zip`
  ) {
    throw new Error("Windows dependency lock is invalid.");
  }
  if (
    postgresql.version !== "17.10" ||
    postgresql.url !==
      `https://ftp.postgresql.org/pub/source/v${postgresql.version}/postgresql-${postgresql.version}.tar.gz` ||
    openssl.url !==
      `https://github.com/openssl/openssl/releases/download/openssl-${openssl.version}/openssl-${openssl.version}.tar.gz` ||
    zlib.url !== `https://zlib.net/fossils/zlib-${zlib.version}.tar.gz`
  ) {
    throw new Error("PostgreSQL runtime sources are not the supported canonical releases.");
  }
  return Object.freeze({
    schemaVersion: 1,
    postgresql: Object.freeze(postgresql),
    linuxDependencies: Object.freeze({
      openssl: Object.freeze(openssl),
      zlib: Object.freeze(zlib),
    }),
    windowsDependencies: Object.freeze({
      vcpkgBaseline: windows.vcpkgBaseline,
      triplet: windows.triplet,
      mesonVersion: windows.mesonVersion,
      ninjaVersion: windows.ninjaVersion,
      winFlexBison: Object.freeze(winFlexBison),
    }),
  });
}

function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

async function visit(root: string, onFile: (fullPath: string) => Promise<void>): Promise<void> {
  const walk = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const fullPath = path.join(directory, entry.name);
      const stat = await lstat(fullPath);
      if (stat.isSymbolicLink()) await onFile(fullPath);
      else if (stat.isDirectory()) await walk(fullPath);
      else if (stat.isFile()) await onFile(fullPath);
      else
        throw new Error(`Runtime contains an unsupported entry: ${path.relative(root, fullPath)}`);
    }
  };
  await walk(root);
}

/** Replace contained file symlinks with private copies; directory links and escapes fail closed. */
export async function materializeRuntimeSymlinks(rootDirectory: string): Promise<void> {
  const root = await realpath(path.resolve(rootDirectory));
  await visit(root, async (fullPath) => {
    const stat = await lstat(fullPath);
    if (!stat.isSymbolicLink()) return;
    const target = await realpath(fullPath);
    if (!contains(root, target) || !(await lstat(target)).isFile()) {
      throw new Error(
        `Runtime link is not a contained regular file: ${path.relative(root, fullPath)}`,
      );
    }
    const temporary = `${fullPath}.materialize-${randomUUID()}`;
    try {
      await copyFile(target, temporary);
      await chmod(temporary, (await lstat(target)).mode);
      await rm(fullPath);
      await rename(temporary, fullPath);
    } finally {
      await rm(temporary, { force: true });
    }
  });
}

async function requireRegular(root: string, relative: string): Promise<void> {
  const fullPath = path.join(root, ...relative.split("/"));
  if (!contains(root, path.resolve(fullPath))) throw new Error("Runtime path escaped its root.");
  const stat = await lstat(fullPath).catch(() => null);
  if (stat === null || !stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`PostgreSQL runtime requires ${relative}.`);
  }
}

async function inventory(root: string): Promise<readonly RuntimeFile[]> {
  const files: RuntimeFile[] = [];
  await visit(root, async (fullPath) => {
    const stat = await lstat(fullPath);
    if (stat.isSymbolicLink()) {
      throw new Error(`PostgreSQL runtime must be symlink-free: ${path.relative(root, fullPath)}`);
    }
    const relative = path.relative(root, fullPath).split(path.sep).join("/");
    if (relative === INVENTORY) return;
    const bytes = await readFile(fullPath);
    files.push({
      path: relative,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
    });
  });
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

export async function assertPostgreSqlRuntime(
  rootDirectory: string,
  target: PostgreSqlRuntimeTarget,
): Promise<readonly RuntimeFile[]> {
  const root = await realpath(path.resolve(rootDirectory));
  const suffix = target === "windows-x64" ? ".exe" : "";
  await Promise.all([
    ...REQUIRED_TOOLS.map((tool) => requireRegular(root, `bin/${tool}${suffix}`)),
    requireRegular(root, "share/postgresql.conf.sample"),
    requireRegular(root, "share/extension/pgcrypto.control"),
    requireRegular(root, "share/extension/pgcrypto--1.3.sql"),
    requireRegular(root, target === "windows-x64" ? "lib/pgcrypto.dll" : "lib/pgcrypto.so"),
    requireRegular(root, "LICENSES/PostgreSQL.txt"),
    requireRegular(root, "LICENSES/OpenSSL.txt"),
    requireRegular(root, "LICENSES/zlib.txt"),
    requireRegular(root, "BUILD-PROVENANCE.json"),
  ]);
  return inventory(root);
}

export async function sealPostgreSqlRuntime(
  rootDirectory: string,
  target: PostgreSqlRuntimeTarget,
  lock: PostgreSqlRuntimeLock,
): Promise<readonly RuntimeFile[]> {
  const root = path.resolve(rootDirectory);
  const provenance = {
    schemaVersion: 1,
    target,
    postgresql: lock.postgresql,
    dependencies: target === "linux-x64" ? lock.linuxDependencies : lock.windowsDependencies,
  };
  await writeFile(
    path.join(root, "BUILD-PROVENANCE.json"),
    `${JSON.stringify(provenance, null, 2)}\n`,
    { flag: "wx" },
  );
  const files = await assertPostgreSqlRuntime(root, target);
  await writeFile(
    path.join(root, INVENTORY),
    `${JSON.stringify({ schemaVersion: 1, target, files }, null, 2)}\n`,
    { flag: "wx" },
  );
  return files;
}

async function cli(arguments_: readonly string[]): Promise<void> {
  const [command, root, targetValue, lockPath] = arguments_;
  if (
    !["materialize", "seal", "verify"].includes(command ?? "") ||
    root === undefined ||
    (targetValue !== "linux-x64" && targetValue !== "windows-x64")
  ) {
    throw new Error("Usage: postgresql-runtime <materialize|seal|verify> ROOT TARGET [LOCK]");
  }
  if (command === "materialize") {
    await materializeRuntimeSymlinks(root);
    return;
  }
  if (command === "seal") {
    if (lockPath === undefined) throw new Error("seal requires the runtime lock path.");
    const lock = parsePostgreSqlRuntimeLock(
      JSON.parse(await readFile(lockPath, "utf8")) as unknown,
    );
    const files = await sealPostgreSqlRuntime(root, targetValue, lock);
    process.stdout.write(`Sealed PostgreSQL runtime with ${files.length} files.\n`);
    return;
  }
  const actual = await assertPostgreSqlRuntime(root, targetValue);
  const manifest = JSON.parse(await readFile(path.join(root, INVENTORY), "utf8")) as {
    schemaVersion?: unknown;
    target?: unknown;
    files?: unknown;
  };
  if (
    manifest.schemaVersion !== 1 ||
    manifest.target !== targetValue ||
    JSON.stringify(manifest.files) !== JSON.stringify(actual)
  ) {
    throw new Error("PostgreSQL runtime inventory does not match the runtime tree.");
  }
  process.stdout.write(`Verified PostgreSQL runtime with ${actual.length} files.\n`);
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  await cli(process.argv.slice(2));
}
