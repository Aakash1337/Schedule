import { readFile } from "node:fs/promises";
import path from "node:path";
import { buildDesktopRuntime, hashTree } from "./build-desktop-runtime.js";

type Target = "windows" | "linux";

function value(arguments_: readonly string[], name: string): string {
  const index = arguments_.indexOf(`--${name}`);
  const result = index < 0 ? undefined : arguments_[index + 1];
  if (result === undefined || result.startsWith("--")) throw new Error(`--${name} is required.`);
  return result;
}

function packageVersion(raw: string, label: string): string {
  const parsed: unknown = JSON.parse(raw);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as { version?: unknown }).version !== "string"
  ) {
    throw new Error(`${label} deployment package.json has no version.`);
  }
  return (parsed as { version: string }).version;
}

/** Assemble real release inputs after every producer has independently verified its own output. */
export async function assembleDesktopReleaseRuntime(arguments_: readonly string[]): Promise<void> {
  const expected = new Set([
    "output",
    "target",
    "api",
    "worker",
    "node",
    "node-version",
    "postgres",
    "postgres-version",
  ]);
  if (
    arguments_.length !== 16 ||
    arguments_.some(
      (argument, index) =>
        index % 2 === 0 && (!argument.startsWith("--") || !expected.has(argument.slice(2))),
    )
  ) {
    throw new Error("Arguments must be exactly eight known --name value pairs.");
  }
  const target = value(arguments_, "target") as Target;
  if (target !== "windows" && target !== "linux")
    throw new Error("--target must be windows or linux.");
  const api = path.resolve(value(arguments_, "api"));
  const worker = path.resolve(value(arguments_, "worker"));
  const node = path.resolve(value(arguments_, "node"));
  const postgresql = path.resolve(value(arguments_, "postgres"));
  await buildDesktopRuntime({
    outputDirectory: value(arguments_, "output"),
    target: { os: target, arch: "x86_64" },
    postgresqlMajor: 17,
    apiDeploymentDirectory: api,
    workerDeploymentDirectory: worker,
    nodeRuntimeDirectory: node,
    postgresqlRuntimeDirectory: postgresql,
    sources: {
      api: {
        version: packageVersion(await readFile(path.join(api, "package.json"), "utf8"), "API"),
        sha256: await hashTree(api),
      },
      worker: {
        version: packageVersion(
          await readFile(path.join(worker, "package.json"), "utf8"),
          "Worker",
        ),
        sha256: await hashTree(worker),
      },
      node: { version: value(arguments_, "node-version"), sha256: await hashTree(node) },
      postgresql: {
        version: value(arguments_, "postgres-version"),
        sha256: await hashTree(postgresql),
      },
    },
  });
}

if (process.argv[1]?.endsWith("assemble-desktop-release-runtime.ts")) {
  void assembleDesktopReleaseRuntime(process.argv.slice(2)).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
