import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const composeFile = path.join(repositoryRoot, "compose.e2e.yaml");
const playwrightCli = path.join(repositoryRoot, "node_modules", "@playwright", "test", "cli.js");
const tsxCli = path.join(repositoryRoot, "node_modules", "tsx", "dist", "cli.mjs");
const migrationEntryPoint = path.join(repositoryRoot, "packages", "database", "src", "migrate.ts");

let activeChild: ChildProcess | null = null;
let interruptedBy: NodeJS.Signals | null = null;
let interruptionTermination: Promise<void> = Promise.resolve();

function commandDescription(executable: string, arguments_: readonly string[]): string {
  return `${path.basename(executable)} ${arguments_.join(" ")}`;
}

function commandFailure(
  executable: string,
  arguments_: readonly string[],
  code: number | null,
  signal: NodeJS.Signals | null,
  stderr = "",
): Error {
  const result =
    signal === null ? `exited with code ${code ?? "unknown"}` : `was stopped by ${signal}`;
  const detail = stderr.trim().length === 0 ? "" : `: ${stderr.trim()}`;
  return new Error(`${commandDescription(executable, arguments_)} ${result}${detail}.`);
}

function childOptions(environment: NodeJS.ProcessEnv) {
  return {
    cwd: repositoryRoot,
    env: environment,
    windowsHide: true,
    detached: process.platform !== "win32",
  } as const;
}

async function terminateProcessTree(child: ChildProcess, signal: NodeJS.Signals): Promise<void> {
  const processId = child.pid;
  if (processId === undefined || child.exitCode !== null || child.signalCode !== null) return;

  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill.exe", ["/PID", String(processId), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("error", () => resolve());
      killer.once("exit", () => resolve());
    });
    return;
  }

  try {
    process.kill(-processId, signal);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") {
      return;
    }
    throw error;
  }
}

function onSignal(signal: NodeJS.Signals): void {
  if (interruptedBy !== null) return;
  interruptedBy = signal;
  const child = activeChild;
  if (child !== null) interruptionTermination = terminateProcessTree(child, signal);
}

const onSigint = () => onSignal("SIGINT");
const onSigterm = () => onSignal("SIGTERM");

function throwIfInterrupted(): void {
  if (interruptedBy !== null) {
    throw new Error(`Browser E2E verification interrupted by ${interruptedBy}.`);
  }
}

export async function runCommand(
  executable: string,
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, arguments_, {
      ...childOptions(environment),
      stdio: "inherit",
    });
    activeChild = child;
    child.once("error", (error) => {
      if (activeChild === child) activeChild = null;
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (activeChild === child) activeChild = null;
      if (code === 0) resolve();
      else reject(commandFailure(executable, arguments_, code, signal));
    });
  });
}

export async function runCommandCapture(
  executable: string,
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  return await new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(executable, arguments_, {
      ...childOptions(environment),
      stdio: ["ignore", "pipe", "pipe"],
    });
    activeChild = child;
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.once("error", (error) => {
      if (activeChild === child) activeChild = null;
      reject(error);
    });
    child.once("exit", (code, signal) => {
      if (activeChild === child) activeChild = null;
      if (code === 0) resolve(stdout.trim());
      else reject(commandFailure(executable, arguments_, code, signal, stderr));
    });
  });
}

async function runMainCommand(
  executable: string,
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  throwIfInterrupted();
  await runCommand(executable, arguments_, environment);
  throwIfInterrupted();
}

async function runMainCommandCapture(
  executable: string,
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  throwIfInterrupted();
  const output = await runCommandCapture(executable, arguments_, environment);
  throwIfInterrupted();
  return output;
}

async function listenOnRandomPort(): Promise<{ readonly port: number; readonly server: Server }> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve a loopback port."));
        return;
      }
      resolve({ port: address.port, server });
    });
  });
}

export async function reservePorts(count: number): Promise<readonly number[]> {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error("The number of ports to reserve must be a positive integer.");
  }
  const reservations: { readonly port: number; readonly server: Server }[] = [];
  try {
    for (let index = 0; index < count; index += 1) {
      reservations.push(await listenOnRandomPort());
    }
    return reservations.map(({ port }) => port);
  } finally {
    await Promise.all(
      reservations.map(
        ({ server }) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error === undefined ? resolve() : reject(error))),
          ),
      ),
    );
  }
}

async function portIsAvailable(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

export async function requireReleasedPorts(
  ports: readonly number[],
  timeoutMs = 5_000,
  pollIntervalMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let occupied: readonly number[] = ports;
  while (Date.now() < deadline) {
    const availability = await Promise.all(ports.map((port) => portIsAvailable(port)));
    occupied = ports.filter((_port, index) => !availability[index]);
    if (occupied.length === 0) return;
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error(`Browser verification left loopback ports occupied: ${occupied.join(", ")}.`);
}

export function composeProjectName(
  environment: NodeJS.ProcessEnv = process.env,
  processId = process.pid,
  timestamp = Date.now(),
): string {
  const name =
    environment.E2E_COMPOSE_PROJECT ?? `schedule-web-e2e-${processId}-${timestamp.toString(36)}`;
  if (!/^schedule-web-e2e-[a-z0-9][a-z0-9_-]{0,45}$/.test(name)) {
    throw new Error(
      "E2E_COMPOSE_PROJECT must start with schedule-web-e2e- and contain at most 63 lowercase letters, digits, underscores, or hyphens.",
    );
  }
  return name;
}

export function parsePublishedPostgresPort(output: string): number {
  const match = /^127\.0\.0\.1:(\d{1,5})$/u.exec(output.trim());
  const port = Number(match?.[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(
      `Docker returned an invalid PostgreSQL port mapping: ${output.trim() || "empty"}.`,
    );
  }
  return port;
}

export function buildTestEnvironment(
  ports: { readonly postgres: number; readonly api: number; readonly web: number },
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...environment,
    NODE_ENV: "test",
    LOG_LEVEL: "warn",
    PRODUCT_API_MODE: "local_unauthenticated",
    API_HOST: "127.0.0.1",
    API_PORT: String(ports.api),
    DATABASE_URL: `postgres://schedule:schedule@127.0.0.1:${ports.postgres}/schedule`,
    SCHEDULE_API_URL: `http://127.0.0.1:${ports.api}`,
    E2E_API_PORT: String(ports.api),
    E2E_WEB_PORT: String(ports.web),
  };
}

function splitIdentifiers(output: string): readonly string[] {
  return output.split(/\s+/u).filter((value) => value.length > 0);
}

async function assertComposeProjectUnused(
  projectName: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const filter = `label=com.docker.compose.project=${projectName}`;
  for (const resource of ["container", "network", "volume"] as const) {
    const listArguments =
      resource === "container"
        ? [resource, "ls", "--all", "--quiet", "--filter", filter]
        : [resource, "ls", "--quiet", "--filter", filter];
    const identifiers = await runMainCommandCapture("docker", listArguments, environment);
    if (identifiers.length > 0) {
      throw new Error(
        `Refusing to reuse the existing Compose project ${projectName}; remove its resources explicitly first.`,
      );
    }
  }
}

async function composeProjectIsOwned(
  projectName: string,
  ownerToken: string,
  environment: NodeJS.ProcessEnv,
): Promise<boolean> {
  const identifiers = splitIdentifiers(
    await runCommandCapture(
      "docker",
      [
        "container",
        "ls",
        "--all",
        "--quiet",
        "--filter",
        `label=com.docker.compose.project=${projectName}`,
      ],
      environment,
    ),
  );
  if (identifiers.length === 0) return true;
  for (const identifier of identifiers) {
    const owner = await runCommandCapture(
      "docker",
      ["inspect", "--format", '{{ index .Config.Labels "io.schedule.e2e.owner" }}', identifier],
      environment,
    );
    if (owner !== ownerToken) return false;
  }
  return true;
}

export async function runWebE2e(): Promise<void> {
  const [apiPort, webPort] = await reservePorts(2);
  if (apiPort === undefined || webPort === undefined) {
    throw new Error("Could not allocate the browser verification ports.");
  }

  const projectName = composeProjectName();
  const ownerToken = randomUUID();
  const composeEnvironment: NodeJS.ProcessEnv = {
    ...process.env,
    E2E_COMPOSE_PROJECT: projectName,
    E2E_OWNER_TOKEN: ownerToken,
  };
  const composeArguments = ["compose", "--project-name", projectName, "--file", composeFile];
  let composeAttempted = false;
  let ownershipVerified = false;
  let postgresPort: number | null = null;
  let primaryError: unknown = null;
  let cleanupError: unknown = null;

  activeChild = null;
  interruptedBy = null;
  interruptionTermination = Promise.resolve();
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  try {
    await runMainCommand("docker", ["compose", "version"], composeEnvironment);
    await assertComposeProjectUnused(projectName, composeEnvironment);
    composeAttempted = true;
    await runMainCommand(
      "docker",
      [...composeArguments, "up", "--detach", "--wait", "postgres"],
      composeEnvironment,
    );
    ownershipVerified = await composeProjectIsOwned(projectName, ownerToken, composeEnvironment);
    if (!ownershipVerified) {
      throw new Error(`Compose project ${projectName} is not owned by this browser verification.`);
    }
    postgresPort = parsePublishedPostgresPort(
      await runMainCommandCapture(
        "docker",
        [...composeArguments, "port", "postgres", "5432"],
        composeEnvironment,
      ),
    );
    const testEnvironment = buildTestEnvironment(
      { postgres: postgresPort, api: apiPort, web: webPort },
      composeEnvironment,
    );
    await runMainCommand(process.execPath, [tsxCli, migrationEntryPoint], testEnvironment);
    await runMainCommand(
      process.execPath,
      [playwrightCli, "test", "--config", path.join(repositoryRoot, "playwright.config.ts")],
      testEnvironment,
    );
    process.stdout.write(
      "Browser E2E verification passed live planning and persisted completion\n",
    );
  } catch (error) {
    primaryError =
      interruptedBy === null
        ? error
        : new Error(`Browser E2E verification interrupted by ${interruptedBy}.`, { cause: error });
    if (composeAttempted && ownershipVerified) {
      await runCommand(
        "docker",
        [...composeArguments, "logs", "--no-color", "postgres"],
        composeEnvironment,
      ).catch(() => undefined);
    }
  } finally {
    await interruptionTermination.catch((error) => {
      cleanupError = error;
    });
    if (composeAttempted) {
      let owned = ownershipVerified;
      try {
        if (!owned) {
          owned = await composeProjectIsOwned(projectName, ownerToken, composeEnvironment);
        }
      } catch (error) {
        cleanupError = cleanupError === null ? error : new AggregateError([cleanupError, error]);
      }
      if (!owned && cleanupError === null) {
        cleanupError = new Error(
          `Refusing to remove Compose project ${projectName} because its ownership token does not match.`,
        );
      }
      if (owned) {
        try {
          await runCommand(
            "docker",
            [...composeArguments, "down", "--volumes", "--remove-orphans"],
            composeEnvironment,
          );
        } catch (error) {
          cleanupError = cleanupError === null ? error : new AggregateError([cleanupError, error]);
        }
      }
    }
    try {
      await requireReleasedPorts([
        apiPort,
        webPort,
        ...(postgresPort === null ? [] : [postgresPort]),
      ]);
    } catch (error) {
      cleanupError = cleanupError === null ? error : new AggregateError([cleanupError, error]);
    }
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
  }

  if (primaryError !== null && cleanupError !== null) {
    throw new AggregateError(
      [primaryError, cleanupError],
      "Browser verification and cleanup failed.",
    );
  }
  if (primaryError !== null) throw primaryError;
  if (cleanupError !== null) throw cleanupError;
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && path.resolve(invokedPath) === fileURLToPath(import.meta.url)) {
  await runWebE2e();
}
