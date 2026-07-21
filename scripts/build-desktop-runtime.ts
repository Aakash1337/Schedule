import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { loadMigrationManifest } from "../packages/database/src/migration-ledger.js";

const MANIFEST_NAME = "runtime-manifest.json";
const SBOM_NAME = "runtime-sbom.json";
const LICENSES_NAME = "runtime-licenses.json";
const POSTGRESQL_TOOLS = [
  "initdb",
  "pg_ctl",
  "pg_dump",
  "pg_isready",
  "pg_restore",
  "postgres",
  "psql",
] as const;
function executableSuffix(target: DesktopRuntimeBuildOptions["target"]): string {
  return target.os === "windows" ? ".exe" : "";
}

export interface PinnedSource {
  readonly version: string;
  /** SHA-256 of the complete, sorted source tree. */
  readonly sha256: string;
}

export interface DesktopRuntimeBuildOptions {
  readonly outputDirectory: string;
  readonly target: Readonly<{ os: "windows" | "linux"; arch: "x86_64" | "aarch64" }>;
  readonly postgresqlMajor: number;
  /** A production deployment tree, such as the result of `pnpm deploy --prod`. */
  readonly apiDeploymentDirectory: string;
  /** A production deployment tree, such as the result of `pnpm deploy --prod`. */
  readonly workerDeploymentDirectory: string;
  readonly nodeRuntimeDirectory: string;
  readonly postgresqlRuntimeDirectory: string;
  readonly sources: Readonly<{
    api: PinnedSource;
    worker: PinnedSource;
    node: PinnedSource;
    postgresql: PinnedSource;
  }>;
}

export interface RuntimeFile {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

export interface DesktopRuntimeManifest {
  readonly schemaVersion: 1;
  readonly target: DesktopRuntimeBuildOptions["target"];
  readonly postgresqlMajor: number;
  readonly components: readonly RuntimeComponent[];
  readonly artifacts: Readonly<{ licensesSha256: string; sbomSha256: string }>;
}

const RUNTIME_ROOT_ENTRIES = new Set([
  "api",
  "node",
  "postgresql",
  LICENSES_NAME,
  MANIFEST_NAME,
  SBOM_NAME,
  "worker",
]);

export interface RuntimeComponent {
  readonly name: "node" | "api" | "worker" | "postgresql";
  readonly version: string;
  readonly sha256: string;
  readonly launch: Readonly<{ kind: "executable" | "entrypoint"; path: string }>;
  readonly licensePath: string;
  readonly sbomPath: string;
}

interface LicenseRecord {
  readonly path: string;
  readonly name: string;
  readonly version: string;
  readonly license: string;
}

interface NoticeRecord {
  readonly path: string;
  readonly sha256: string;
}

/** Stable binary/code-unit ordering: never depend on the builder host's locale. */
export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function strictRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !(key in value))
  )
    throw new Error(`${label} is invalid.`);
  return value as Record<string, unknown>;
}

function exactVersion(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^\d[A-Za-z0-9.+_-]*$/u.test(value))
    throw new Error(`${label} is not an exact release identifier.`);
  return value;
}

function strictDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value))
    throw new Error(`${label} has a malformed SHA-256.`);
  return value;
}

function strictRuntimeManifest(value: unknown): DesktopRuntimeManifest {
  const manifest = strictRecord(
    value,
    ["schemaVersion", "target", "postgresqlMajor", "components", "artifacts"],
    "Runtime manifest",
  );
  const target = strictRecord(manifest.target, ["os", "arch"], "Runtime manifest target");
  const artifacts = strictRecord(
    manifest.artifacts,
    ["licensesSha256", "sbomSha256"],
    "Runtime manifest artifacts",
  );
  if (
    manifest.schemaVersion !== 1 ||
    manifest.postgresqlMajor !== 17 ||
    (target.os !== "linux" && target.os !== "windows") ||
    (target.arch !== "x86_64" && target.arch !== "aarch64") ||
    !Array.isArray(manifest.components)
  )
    throw new Error("Runtime manifest does not meet the assembled runtime contract.");
  strictDigest(artifacts.licensesSha256, "Runtime license inventory");
  strictDigest(artifacts.sbomSha256, "Runtime SBOM");
  const expected = new Map<RuntimeComponent["name"], Readonly<{ kind: string; path: string }>>([
    ["node", { kind: "executable", path: `node/node${target.os === "windows" ? ".exe" : ""}` }],
    ["api", { kind: "entrypoint", path: "api/dist/server.js" }],
    ["worker", { kind: "entrypoint", path: "worker/dist/index.js" }],
    [
      "postgresql",
      {
        kind: "executable",
        path: `postgresql/bin/postgres${target.os === "windows" ? ".exe" : ""}`,
      },
    ],
  ]);
  for (const raw of manifest.components) {
    const component = strictRecord(
      raw,
      ["name", "version", "sha256", "launch", "licensePath", "sbomPath"],
      "Runtime component",
    );
    const launch = strictRecord(component.launch, ["kind", "path"], "Runtime component launch");
    const name = component.name as RuntimeComponent["name"];
    const required = expected.get(name);
    const version = exactVersion(component.version, "Runtime component version");
    const postgresqlMajor = version.split(".", 1)[0] ?? "";
    if (
      required === undefined ||
      launch.kind !== required.kind ||
      launch.path !== required.path ||
      component.licensePath !== LICENSES_NAME ||
      component.sbomPath !== SBOM_NAME ||
      (name === "postgresql" &&
        (!/^[1-9][0-9]*$/u.test(postgresqlMajor) || postgresqlMajor !== "17"))
    )
      throw new Error("Runtime manifest component contract is invalid.");
    strictDigest(component.sha256, "Runtime component");
    expected.delete(name);
  }
  if (expected.size !== 0)
    throw new Error("Runtime manifest has duplicate, unknown, or missing components.");
  return value as DesktopRuntimeManifest;
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertPin(name: string, pin: PinnedSource): void {
  if (!/^\d[A-Za-z0-9.+_-]*$/u.test(pin.version) || !/^[a-f0-9]{64}$/u.test(pin.sha256)) {
    throw new Error(`${name} must have a non-empty version and a lowercase SHA-256 pin.`);
  }
}

function isPortablePathComponent(component: string): boolean {
  const base = component.split(".", 1)[0]?.toUpperCase() ?? "";
  const reserved = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/u.test(base);
  return (
    component !== "" &&
    component !== "." &&
    component !== ".." &&
    !component.endsWith(".") &&
    !component.endsWith(" ") &&
    !reserved &&
    [...component].every((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code >= 0x20 && code <= 0x7e && !'<>:"\\|?*'.includes(character);
    })
  );
}

function assertPortableRelative(relative: string): void {
  if (!relative.split("/").every(isPortablePathComponent)) {
    throw new Error(`Runtime paths must use portable ASCII components: ${relative}`);
  }
}

function safeRelative(root: string, candidate: string): string {
  const relative = path.relative(root, candidate);
  if (relative === "" || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Path escapes its declared source root: ${candidate}`);
  }
  const portable = relative.split(path.sep).join("/");
  assertPortableRelative(portable);
  return portable;
}

function containsPath(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function assertOutputIsDisjoint(output: string, sources: readonly string[]): void {
  for (const source of sources) {
    if (containsPath(source, output) || containsPath(output, source)) {
      throw new Error("The runtime output and each source tree must be disjoint.");
    }
  }
}

async function assertRegularDirectory(directory: string, label: string): Promise<void> {
  const entry = await lstat(directory).catch(() => null);
  if (entry === null || !entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error(`${label} must be an existing non-symlink directory.`);
  }
}

/** Reject symlinks before copying so the bundle cannot acquire files outside its inputs. */
export async function assertTreeIsSafe(root: string): Promise<void> {
  await assertRegularDirectory(root, "Source");
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new Error(`Symlinks are not allowed in runtime inputs: ${fullPath}`);
      if (entry.isDirectory()) await visit(fullPath);
      else if (!entry.isFile())
        throw new Error(`Only regular files are allowed in runtime inputs: ${fullPath}`);
    }
  };
  await visit(root);
}

export async function hashTree(root: string): Promise<string> {
  await assertTreeIsSafe(root);
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(fullPath);
      else files.push(safeRelative(root, fullPath));
    }
  };
  await visit(root);
  files.sort();
  const digest = createHash("sha256");
  for (const relative of files) {
    const bytes = await readFile(path.join(root, ...relative.split("/")));
    digest.update(relative).update("\0").update(bytes).update("\0");
  }
  return digest.digest("hex");
}

async function assertPinnedTree(name: string, directory: string, pin: PinnedSource): Promise<void> {
  assertPin(name, pin);
  await assertTreeIsSafe(directory);
  if ((await hashTree(directory)) !== pin.sha256) {
    throw new Error(`${name} source tree does not match its supplied SHA-256 pin.`);
  }
}

async function requireFile(root: string, relative: string, label: string): Promise<void> {
  const fullPath = path.join(root, ...relative.split("/"));
  safeRelative(root, fullPath);
  const entry = await lstat(fullPath).catch(() => null);
  if (entry === null || !entry.isFile() || entry.isSymbolicLink()) {
    throw new Error(`${label} is required at ${relative}.`);
  }
  await access(fullPath, constants.R_OK);
}

async function requireDirectory(root: string, relative: string, label: string): Promise<void> {
  const fullPath = path.join(root, ...relative.split("/"));
  safeRelative(root, fullPath);
  const entry = await lstat(fullPath).catch(() => null);
  if (entry === null || !entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error(`${label} is required at ${relative}.`);
  }
}

async function requirePgcrypto(
  root: string,
  target: DesktopRuntimeBuildOptions["target"],
): Promise<void> {
  const control = await readFile(path.join(root, "share", "extension", "pgcrypto.control"), "utf8");
  const version = /^\s*default_version\s*=\s*'([A-Za-z0-9._+-]+)'\s*$/mu.exec(control)?.[1];
  if (version === undefined) {
    throw new Error("PostgreSQL pgcrypto control metadata has no safe default version.");
  }
  await requireFile(
    root,
    `share/extension/pgcrypto--${version}.sql`,
    "PostgreSQL pgcrypto extension SQL",
  );
  const libraries =
    target.os === "windows"
      ? ["lib/pgcrypto.dll"]
      : ["lib/postgresql/pgcrypto.so", "lib/pgcrypto.so"];
  for (const relative of libraries) {
    const entry = await lstat(path.join(root, ...relative.split("/"))).catch(() => null);
    if (entry?.isFile() === true && !entry.isSymbolicLink()) return;
  }
  throw new Error("The PostgreSQL pgcrypto shared library is required.");
}

/** Revalidate the assembled runtime contract before copying it into an installer. */
export async function validateDesktopRuntime(root: string): Promise<DesktopRuntimeManifest> {
  const runtimeRoot = path.resolve(root);
  await assertTreeIsSafe(runtimeRoot);
  const entries = await readdir(runtimeRoot);
  if (
    entries.length !== RUNTIME_ROOT_ENTRIES.size ||
    entries.some((entry) => !RUNTIME_ROOT_ENTRIES.has(entry))
  ) {
    throw new Error("Runtime root must contain the exact assembled, non-nested runtime layout.");
  }
  const manifestBytes = await readFile(path.join(runtimeRoot, MANIFEST_NAME));
  if (manifestBytes.byteLength > 256 * 1024) throw new Error("Runtime manifest is too large.");
  let manifest: DesktopRuntimeManifest;
  try {
    manifest = strictRuntimeManifest(JSON.parse(manifestBytes.toString("utf8")));
  } catch {
    throw new Error("Runtime manifest is invalid JSON.");
  }
  const target = manifest.target as DesktopRuntimeBuildOptions["target"];
  const executable = executableSuffix(target);
  const expected = new Map<RuntimeComponent["name"], Readonly<{ kind: string; path: string }>>([
    ["node", { kind: "executable", path: `node/node${executable}` }],
    ["api", { kind: "entrypoint", path: "api/dist/server.js" }],
    ["worker", { kind: "entrypoint", path: "worker/dist/index.js" }],
    ["postgresql", { kind: "executable", path: `postgresql/bin/postgres${executable}` }],
  ]);
  for (const component of manifest.components) {
    const launch = expected.get(component.name);
    if (
      launch === undefined ||
      !/^[a-f0-9]{64}$/u.test(component.sha256) ||
      component.launch?.kind !== launch.kind ||
      component.launch.path !== launch.path ||
      component.licensePath !== LICENSES_NAME ||
      component.sbomPath !== SBOM_NAME ||
      (await hashTree(path.join(runtimeRoot, component.name))) !== component.sha256
    ) {
      throw new Error("Runtime manifest component integrity does not match its assembled tree.");
    }
    expected.delete(component.name);
  }
  if (
    expected.size !== 0 ||
    !/^[a-f0-9]{64}$/u.test(manifest.artifacts.licensesSha256) ||
    !/^[a-f0-9]{64}$/u.test(manifest.artifacts.sbomSha256)
  ) {
    throw new Error("Runtime manifest has incomplete or malformed integrity metadata.");
  }
  if (
    sha256(await readFile(path.join(runtimeRoot, LICENSES_NAME))) !==
      manifest.artifacts.licensesSha256 ||
    sha256(await readFile(path.join(runtimeRoot, SBOM_NAME))) !== manifest.artifacts.sbomSha256
  ) {
    throw new Error("Runtime inventory integrity does not match its manifest.");
  }
  await requireFile(runtimeRoot, "api/dist/server.js", "API server entrypoint");
  await requireFile(runtimeRoot, "worker/dist/index.js", "Worker entrypoint");
  await requireFile(
    runtimeRoot,
    "api/node_modules/@schedule/database/dist/migrate.js",
    "Database migration entrypoint",
  );
  await requireFile(
    runtimeRoot,
    "api/node_modules/@schedule/database/dist/migration-ledger.js",
    "Database migration ledger helper",
  );
  await requireFile(
    runtimeRoot,
    "api/node_modules/@schedule/database/dist/migration-sql.js",
    "Database migration SQL safety helper",
  );
  await requireFile(
    runtimeRoot,
    "api/node_modules/@schedule/database/drizzle/meta/_journal.json",
    "Migration journal",
  );
  await requireFile(
    runtimeRoot,
    "api/node_modules/@schedule/database/drizzle/meta/_migration_manifest.json",
    "Immutable migration manifest",
  );
  await loadMigrationManifest(
    path.join(runtimeRoot, "api", "node_modules", "@schedule", "database", "drizzle"),
  );
  await requireFile(runtimeRoot, `node/node${executable}`, "Node executable");
  await Promise.all(
    POSTGRESQL_TOOLS.map((tool) =>
      requireFile(
        runtimeRoot,
        `postgresql/bin/${tool}${executable}`,
        `PostgreSQL ${tool} executable`,
      ),
    ),
  );
  await requireFile(
    runtimeRoot,
    "postgresql/share/postgresql.conf.sample",
    "PostgreSQL shared configuration",
  );
  await requireFile(
    runtimeRoot,
    "postgresql/share/extension/pgcrypto.control",
    "PostgreSQL pgcrypto extension metadata",
  );
  await requireDirectory(runtimeRoot, "postgresql/lib", "PostgreSQL runtime libraries");
  await requirePgcrypto(path.join(runtimeRoot, "postgresql"), target);
  return manifest;
}

async function copyTree(source: string, destination: string): Promise<void> {
  await assertTreeIsSafe(source);
  await cp(source, destination, {
    recursive: true,
    dereference: false,
    errorOnExist: true,
    force: false,
  });
}

async function inventoryFiles(root: string): Promise<RuntimeFile[]> {
  const files: RuntimeFile[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(fullPath);
      else if (entry.isFile()) {
        const bytes = await readFile(fullPath);
        files.push({
          path: safeRelative(root, fullPath),
          sha256: sha256(bytes),
          size: bytes.byteLength,
        });
      }
    }
  };
  await visit(root);
  return files.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
}

async function inventoryLicenses(root: string): Promise<LicenseRecord[]> {
  const records: LicenseRecord[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(fullPath);
      else if (entry.isFile() && entry.name === "package.json") {
        const parsed: unknown = JSON.parse(await readFile(fullPath, "utf8"));
        if (typeof parsed !== "object" || parsed === null) continue;
        const packageJson = parsed as Record<string, unknown>;
        if (typeof packageJson.name === "string" && typeof packageJson.version === "string") {
          records.push({
            path: safeRelative(root, fullPath),
            name: packageJson.name,
            version: packageJson.version,
            license: typeof packageJson.license === "string" ? packageJson.license : "UNKNOWN",
          });
        }
      }
    }
  };
  await visit(root);
  return records.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
}

/** Preserve native distribution notices (Node/PostgreSQL included) when their trees provide them. */
async function inventoryNotices(root: string): Promise<NoticeRecord[]> {
  const records: NoticeRecord[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(fullPath);
      else if (
        entry.isFile() &&
        /^(?:license|copying|copyright|notice)(?:\..*)?$/iu.test(entry.name)
      ) {
        records.push({
          path: safeRelative(root, fullPath),
          sha256: sha256(await readFile(fullPath)),
        });
      }
    }
  };
  await visit(root);
  return records.sort((left, right) => compareCodeUnits(left.path, right.path));
}

async function promote(stagingDirectory: string, outputDirectory: string): Promise<void> {
  const backup = `${outputDirectory}.previous-${process.pid}`;
  const outputExists = await lstat(outputDirectory)
    .then(() => true)
    .catch(() => false);
  try {
    if (outputExists) await rename(outputDirectory, backup);
    await rename(stagingDirectory, outputDirectory);
    if (outputExists) await rm(backup, { recursive: true, force: true });
  } catch (error) {
    if (
      outputExists &&
      !(await lstat(outputDirectory)
        .then(() => true)
        .catch(() => false))
    ) {
      await rename(backup, outputDirectory).catch(() => undefined);
    }
    throw error;
  }
}

/** Assemble fully supplied, pinned runtime inputs without downloading or resolving dependencies. */
export async function buildDesktopRuntime(
  options: DesktopRuntimeBuildOptions,
): Promise<DesktopRuntimeManifest> {
  const outputDirectory = path.resolve(options.outputDirectory);
  const apiDeploymentDirectory = path.resolve(options.apiDeploymentDirectory);
  const workerDeploymentDirectory = path.resolve(options.workerDeploymentDirectory);
  const nodeRuntimeDirectory = path.resolve(options.nodeRuntimeDirectory);
  const postgresqlRuntimeDirectory = path.resolve(options.postgresqlRuntimeDirectory);
  assertOutputIsDisjoint(outputDirectory, [
    apiDeploymentDirectory,
    workerDeploymentDirectory,
    nodeRuntimeDirectory,
    postgresqlRuntimeDirectory,
  ]);
  if (
    !["windows", "linux"].includes(options.target.os) ||
    !["x86_64", "aarch64"].includes(options.target.arch)
  ) {
    throw new Error("target must be a supported Windows/Linux and x86_64/aarch64 pair.");
  }
  if (options.postgresqlMajor !== 17) {
    throw new Error("The desktop runtime currently requires PostgreSQL major 17.");
  }
  const postgresqlVersionMajor = options.sources.postgresql.version.split(".", 1)[0] ?? "";
  if (
    !/^[0-9]+$/u.test(postgresqlVersionMajor) ||
    Number(postgresqlVersionMajor) !== options.postgresqlMajor
  ) {
    throw new Error("The PostgreSQL source version must match PostgreSQL major 17.");
  }
  const executable = executableSuffix(options.target);
  const sources = [
    ["API", apiDeploymentDirectory, options.sources.api],
    ["Worker", workerDeploymentDirectory, options.sources.worker],
    ["Node", nodeRuntimeDirectory, options.sources.node],
    ["PostgreSQL", postgresqlRuntimeDirectory, options.sources.postgresql],
  ] as const;
  for (const [name, directory, pin] of sources) await assertPinnedTree(name, directory, pin);

  await requireFile(apiDeploymentDirectory, "dist/server.js", "API server entrypoint");
  await requireFile(workerDeploymentDirectory, "dist/index.js", "Worker entrypoint");
  await requireFile(
    apiDeploymentDirectory,
    "node_modules/@schedule/database/dist/migrate.js",
    "Database migration entrypoint",
  );
  await requireFile(
    apiDeploymentDirectory,
    "node_modules/@schedule/database/dist/migration-ledger.js",
    "Database migration ledger helper",
  );
  await requireFile(
    apiDeploymentDirectory,
    "node_modules/@schedule/database/dist/migration-sql.js",
    "Database migration SQL safety helper",
  );
  await requireFile(
    apiDeploymentDirectory,
    "node_modules/@schedule/database/drizzle/meta/_journal.json",
    "Migration journal",
  );
  await requireFile(
    apiDeploymentDirectory,
    "node_modules/@schedule/database/drizzle/meta/_migration_manifest.json",
    "Immutable migration manifest",
  );
  await loadMigrationManifest(
    path.join(apiDeploymentDirectory, "node_modules", "@schedule", "database", "drizzle"),
  );
  await requireFile(nodeRuntimeDirectory, `node${executable}`, "Node executable");
  await Promise.all(
    POSTGRESQL_TOOLS.map((tool) =>
      requireFile(
        postgresqlRuntimeDirectory,
        `bin/${tool}${executable}`,
        `PostgreSQL ${tool} executable`,
      ),
    ),
  );
  await requireFile(
    postgresqlRuntimeDirectory,
    "share/postgresql.conf.sample",
    "PostgreSQL shared configuration",
  );
  await requireFile(
    postgresqlRuntimeDirectory,
    "share/extension/pgcrypto.control",
    "PostgreSQL pgcrypto extension metadata",
  );
  await requireDirectory(postgresqlRuntimeDirectory, "lib", "PostgreSQL runtime libraries");
  await requirePgcrypto(postgresqlRuntimeDirectory, options.target);

  await mkdir(path.dirname(outputDirectory), { recursive: true });
  const stagingDirectory = `${outputDirectory}.staging-${process.pid}-${Date.now().toString(36)}`;
  await rm(stagingDirectory, { recursive: true, force: true });
  try {
    await mkdir(stagingDirectory);
    await Promise.all([
      copyTree(apiDeploymentDirectory, path.join(stagingDirectory, "api")),
      copyTree(workerDeploymentDirectory, path.join(stagingDirectory, "worker")),
      copyTree(nodeRuntimeDirectory, path.join(stagingDirectory, "node")),
      copyTree(postgresqlRuntimeDirectory, path.join(stagingDirectory, "postgresql")),
    ]);
    const files = await inventoryFiles(stagingDirectory);
    const licensePath = LICENSES_NAME;
    const sbomPath = SBOM_NAME;
    const sbom = { schemaVersion: 1, format: "schedule-runtime", sources: options.sources, files };
    const licenses = {
      schemaVersion: 1,
      packages: await inventoryLicenses(stagingDirectory),
      notices: await inventoryNotices(stagingDirectory),
    };
    const sbomBytes = Buffer.from(`${JSON.stringify(sbom, null, 2)}\n`);
    const licenseBytes = Buffer.from(`${JSON.stringify(licenses, null, 2)}\n`);
    await writeFile(path.join(stagingDirectory, SBOM_NAME), sbomBytes);
    await writeFile(path.join(stagingDirectory, LICENSES_NAME), licenseBytes);
    const manifest: DesktopRuntimeManifest = {
      schemaVersion: 1,
      target: options.target,
      postgresqlMajor: options.postgresqlMajor,
      components: [
        {
          name: "node",
          ...options.sources.node,
          launch: { kind: "executable", path: `node/node${executable}` },
          licensePath,
          sbomPath,
        },
        {
          name: "api",
          ...options.sources.api,
          launch: { kind: "entrypoint", path: "api/dist/server.js" },
          licensePath,
          sbomPath,
        },
        {
          name: "worker",
          ...options.sources.worker,
          launch: { kind: "entrypoint", path: "worker/dist/index.js" },
          licensePath,
          sbomPath,
        },
        {
          name: "postgresql",
          ...options.sources.postgresql,
          launch: { kind: "executable", path: `postgresql/bin/postgres${executable}` },
          licensePath,
          sbomPath,
        },
      ],
      artifacts: { licensesSha256: sha256(licenseBytes), sbomSha256: sha256(sbomBytes) },
    };
    await writeFile(
      path.join(stagingDirectory, MANIFEST_NAME),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    await chmod(path.join(stagingDirectory, "node", `node${executable}`), 0o755);
    await Promise.all(
      POSTGRESQL_TOOLS.map((tool) =>
        chmod(path.join(stagingDirectory, "postgresql", "bin", `${tool}${executable}`), 0o755),
      ),
    );
    await promote(stagingDirectory, outputDirectory);
    return manifest;
  } catch (error) {
    await rm(stagingDirectory, { recursive: true, force: true });
    throw error;
  }
}

function parseArguments(arguments_: readonly string[]): DesktopRuntimeBuildOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    if (key === undefined || value === undefined || !key.startsWith("--"))
      throw new Error("Arguments must be --name value pairs.");
    values.set(key.slice(2), value);
  }
  const required = (name: string): string => {
    const value = values.get(name);
    if (value === undefined || value.length === 0) throw new Error(`--${name} is required.`);
    return value;
  };
  const source = (name: string): PinnedSource => ({
    version: required(`${name}-version`),
    sha256: required(`${name}-sha256`),
  });
  return {
    outputDirectory: required("output"),
    target: {
      os: required("target-os") as "windows" | "linux",
      arch: required("target-arch") as "x86_64" | "aarch64",
    },
    postgresqlMajor: Number(required("postgres-major")),
    apiDeploymentDirectory: required("api-deploy"),
    workerDeploymentDirectory: required("worker-deploy"),
    nodeRuntimeDirectory: required("node-runtime"),
    postgresqlRuntimeDirectory: required("postgres-runtime"),
    sources: {
      api: source("api"),
      worker: source("worker"),
      node: source("node"),
      postgresql: source("postgres"),
    },
  };
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  const options = parseArguments(process.argv.slice(2));
  void buildDesktopRuntime(options).then(
    async () => {
      const manifest = await readFile(
        path.join(path.resolve(options.outputDirectory), MANIFEST_NAME),
      );
      process.stdout.write(
        `Desktop runtime assembled.\nSCHEDULE_DESKTOP_RUNTIME_MANIFEST_SHA256=${sha256(manifest)}\n`,
      );
    },
    (error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
