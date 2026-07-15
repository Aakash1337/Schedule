import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const composeFile = path.join(repositoryRoot, "compose.runtime-smoke.yaml");
const migrationJournal = path.join(
  repositoryRoot,
  "packages",
  "database",
  "drizzle",
  "meta",
  "_journal.json",
);
const COMMAND_TIMEOUT_MS = 12 * 60 * 1_000;
const CAPTURE_LIMIT_BYTES = 64 * 1_024;
const TERMINATION_GRACE_MS = 5_000;
const RUNTIME_UID = 10_001;
const RUNTIME_GID = 10_001;
const EMPTY_CAPABILITY_MASK = "0000000000000000";
const CAPABILITY_MASK_NAMES = [
  "ambient",
  "bounding",
  "effective",
  "inheritable",
  "permitted",
] as const;
const RUNTIME_SECURITY_PROBE = [
  "const fs=require('node:fs');",
  "const status=fs.readFileSync('/proc/self/status','utf8');",
  "const mountInfo=fs.readFileSync('/proc/self/mountinfo','utf8');",
  "const rootMount=mountInfo.split('\\n').find(line=>line.split(' ')[4]==='/');",
  "const rootFilesystemReadOnly=rootMount?.split(' ')[5]?.split(',').includes('ro')??false;",
  "const readMask=label=>new RegExp('^'+label+':\\\\s*([0-9a-f]+)$','imu').exec(status)?.[1]??null;",
  "const capabilityMasks={ambient:readMask('CapAmb'),bounding:readMask('CapBnd'),effective:readMask('CapEff'),inheritable:readMask('CapInh'),permitted:readMask('CapPrm')};",
  "const noNewPrivileges=/^NoNewPrivs:\\s*1$/mu.test(status);",
  "process.stdout.write(JSON.stringify({uid:process.getuid?.()??-1,gid:process.getgid?.()??-1,rootFilesystemReadOnly,noNewPrivileges,capabilityMasks}));",
].join("");

type RuntimeService = "api" | "migrate" | "worker";

interface RuntimeSecurityProbe {
  readonly uid: number;
  readonly gid: number;
  readonly rootFilesystemReadOnly: boolean;
  readonly noNewPrivileges: boolean;
  readonly capabilityMasks: Readonly<Record<(typeof CAPABILITY_MASK_NAMES)[number], string>>;
}

let activeChild: ChildProcess | null = null;
let interruptedBy: NodeJS.Signals | null = null;

function boundedAppend(current: string, chunk: Buffer): string {
  const combined = current + chunk.toString("utf8");
  return Buffer.byteLength(combined, "utf8") <= CAPTURE_LIMIT_BYTES
    ? combined
    : combined.slice(-CAPTURE_LIMIT_BYTES);
}

async function terminateChild(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("error", () => resolve());
      killer.once("exit", () => resolve());
    });
    return;
  }
  child.kill("SIGTERM");
}

function forceKillChild(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  child.kill(process.platform === "win32" ? undefined : "SIGKILL");
}

function onSignal(signal: NodeJS.Signals): void {
  interruptedBy ??= signal;
  if (activeChild !== null) void terminateChild(activeChild);
}

async function runCommand(
  executable: string,
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
  capture = false,
  allowAfterInterruption = false,
): Promise<string> {
  if (interruptedBy !== null && !allowAfterInterruption) {
    throw new Error(`OCI runtime verification interrupted by ${interruptedBy}.`);
  }
  return await new Promise<string>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let spawnError: Error | null = null;
    let timedOut = false;
    let settled = false;
    const child = spawn(executable, arguments_, {
      cwd: repositoryRoot,
      env: environment,
      windowsHide: true,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    activeChild = child;
    child.stdout?.on("data", (chunk: Buffer) => (stdout = boundedAppend(stdout, chunk)));
    child.stderr?.on("data", (chunk: Buffer) => (stderr = boundedAppend(stderr, chunk)));
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let rejectTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceTimer !== undefined) clearTimeout(forceTimer);
      if (rejectTimer !== undefined) clearTimeout(rejectTimer);
      if (activeChild === child) activeChild = null;
      if (error === undefined) resolve(stdout.trim());
      else reject(error);
    };
    const timeoutError = () =>
      new Error(`${path.basename(executable)} ${arguments_[0] ?? ""} exceeded its time limit.`);
    const timer = setTimeout(() => {
      timedOut = true;
      void terminateChild(child);
      forceTimer = setTimeout(() => forceKillChild(child), TERMINATION_GRACE_MS);
      rejectTimer = setTimeout(() => finish(timeoutError()), TERMINATION_GRACE_MS * 2);
    }, COMMAND_TIMEOUT_MS);
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (code, signal) => {
      if (spawnError !== null) finish(spawnError);
      else if (timedOut) finish(timeoutError());
      else if (code === 0) finish();
      else {
        const reason = signal === null ? `exit code ${String(code)}` : `signal ${signal}`;
        const detail = stderr.trim() === "" ? "" : `: ${stderr.trim()}`;
        finish(
          new Error(
            `${path.basename(executable)} ${arguments_[0] ?? ""} failed with ${reason}${detail}.`,
          ),
        );
      }
    });
  });
}

export function runtimeSmokeProjectName(
  environment: NodeJS.ProcessEnv = process.env,
  processId = process.pid,
  timestamp = Date.now(),
): string {
  const value =
    environment.OCI_RUNTIME_SMOKE_PROJECT ??
    `schedule-runtime-smoke-${processId}-${timestamp.toString(36)}`;
  if (!/^schedule-runtime-smoke-[a-z0-9][a-z0-9_-]{0,38}$/u.test(value)) {
    throw new Error(
      "OCI_RUNTIME_SMOKE_PROJECT must start with schedule-runtime-smoke- and contain at most 63 lowercase letters, digits, underscores, or hyphens.",
    );
  }
  return value;
}

export function parsePublishedApiPort(output: string): number {
  const match = /^127\.0\.0\.1:(\d{1,5})$/u.exec(output.trim());
  const port = Number(match?.[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Docker returned an invalid API loopback port mapping.");
  }
  return port;
}

export function parseContainerExitCode(output: string): number {
  if (!/^(?:0|[1-9]\d{0,2})$/u.test(output.trim())) {
    throw new Error("Docker returned an invalid container exit code.");
  }
  const code = Number(output.trim());
  if (code > 255) throw new Error("Docker returned an invalid container exit code.");
  return code;
}

export function parseMigrationCount(output: string): number {
  if (!/^(?:0|[1-9]\d{0,3})$/u.test(output.trim())) {
    throw new Error("PostgreSQL returned an invalid migration count.");
  }
  return Number(output.trim());
}

export function runtimeSecurityProbeArguments(
  compose: readonly string[],
  service: RuntimeService,
): readonly string[] {
  return service === "migrate"
    ? [...compose, "run", "--rm", "--no-deps", service, "node", "-e", RUNTIME_SECURITY_PROBE]
    : [...compose, "exec", "--no-TTY", service, "node", "-e", RUNTIME_SECURITY_PROBE];
}

export function parseRuntimeSecurityProbe(output: string): RuntimeSecurityProbe {
  let value: unknown;
  try {
    value = JSON.parse(output) as unknown;
  } catch {
    throw new Error("Container returned an invalid runtime security probe.");
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !==
      "capabilityMasks,gid,noNewPrivileges,rootFilesystemReadOnly,uid"
  ) {
    throw new Error("Container returned an invalid runtime security probe.");
  }
  const candidate = value as Record<string, unknown>;
  const capabilityMasks = candidate.capabilityMasks;
  if (
    typeof capabilityMasks !== "object" ||
    capabilityMasks === null ||
    Array.isArray(capabilityMasks) ||
    Object.keys(capabilityMasks).sort().join(",") !== CAPABILITY_MASK_NAMES.join(",") ||
    !CAPABILITY_MASK_NAMES.every(
      (name) =>
        typeof (capabilityMasks as Record<string, unknown>)[name] === "string" &&
        /^[0-9a-f]{16}$/u.test((capabilityMasks as Record<string, string>)[name] ?? ""),
    ) ||
    typeof candidate.uid !== "number" ||
    typeof candidate.gid !== "number" ||
    !Number.isSafeInteger(candidate.uid) ||
    !Number.isSafeInteger(candidate.gid) ||
    typeof candidate.rootFilesystemReadOnly !== "boolean" ||
    typeof candidate.noNewPrivileges !== "boolean"
  ) {
    throw new Error("Container returned an invalid runtime security probe.");
  }
  return candidate as unknown as RuntimeSecurityProbe;
}

function assertRuntimeSecurity(service: RuntimeService, output: string): void {
  const probe = parseRuntimeSecurityProbe(output);
  if (probe.uid !== RUNTIME_UID || probe.gid !== RUNTIME_GID) {
    throw new Error(`${service} did not run with the fixed non-root identity.`);
  }
  if (!probe.rootFilesystemReadOnly) {
    throw new Error(`${service} did not run with a read-only root filesystem.`);
  }
  if (!probe.noNewPrivileges) {
    throw new Error(`${service} did not run with no-new-privileges.`);
  }
  if (Object.values(probe.capabilityMasks).some((mask) => mask !== EMPTY_CAPABILITY_MASK)) {
    throw new Error(`${service} retained Linux capabilities.`);
  }
}

function expectedMigrationCount(): number {
  const value = JSON.parse(readFileSync(migrationJournal, "utf8")) as unknown;
  if (
    typeof value !== "object" ||
    value === null ||
    !("entries" in value) ||
    !Array.isArray(value.entries) ||
    value.entries.length < 1
  ) {
    throw new Error("Migration journal is invalid.");
  }
  return value.entries.length;
}

async function requireJson(
  url: string,
  expectedStatus: number,
  expectedBody: Readonly<Record<string, unknown>>,
): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(url, { redirect: "error", signal: controller.signal });
    const body = (await response.json()) as unknown;
    if (response.status !== expectedStatus || !isDeepStrictEqual(body, expectedBody)) {
      throw new Error(`Unexpected bounded response from ${new URL(url).pathname}.`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function assertProjectUnused(
  projectName: string,
  environment: NodeJS.ProcessEnv,
): Promise<void> {
  const output = await runCommand(
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
    true,
  );
  if (output !== "") throw new Error(`Refusing to reuse existing Compose project ${projectName}.`);
}

async function projectOwnership(
  projectName: string,
  owner: string,
  environment: NodeJS.ProcessEnv,
): Promise<"absent" | "owned" | "foreign"> {
  const output = await runCommand(
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
    true,
    true,
  );
  const identifiers = output.split(/\s+/u).filter((value) => value !== "");
  if (identifiers.length === 0) return "absent";
  for (const identifier of identifiers) {
    if (!/^[a-f0-9]{12,64}$/u.test(identifier)) return "foreign";
    const observedOwner = await runCommand(
      "docker",
      [
        "inspect",
        "--format",
        '{{ index .Config.Labels "io.schedule.runtime-smoke.owner" }}',
        identifier,
      ],
      environment,
      true,
      true,
    );
    if (observedOwner !== owner) return "foreign";
  }
  return "owned";
}

export async function verifyOciRuntime(): Promise<void> {
  const projectName = runtimeSmokeProjectName();
  const owner = randomUUID();
  const imageTag = `${process.pid}-${Date.now().toString(36)}`;
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    RUNTIME_SMOKE_OWNER: owner,
    RUNTIME_SMOKE_IMAGE_TAG: imageTag,
  };
  const compose = ["compose", "--project-name", projectName, "--file", composeFile];
  const apiImage = `schedule-api-runtime-smoke:${imageTag}`;
  const workerImage = `schedule-worker-runtime-smoke:${imageTag}`;
  let composeAttempted = false;
  let primaryError: unknown = null;
  let cleanupError: unknown = null;

  const sigint = () => onSignal("SIGINT");
  const sigterm = () => onSignal("SIGTERM");
  process.once("SIGINT", sigint);
  process.once("SIGTERM", sigterm);

  try {
    await runCommand("docker", ["compose", "version"], environment);
    await assertProjectUnused(projectName, environment);
    composeAttempted = true;
    await runCommand("docker", [...compose, "build", "api", "worker"], environment);
    await runCommand("docker", [...compose, "up", "--detach", "--wait", "postgres"], environment);
    if ((await projectOwnership(projectName, owner, environment)) !== "owned") {
      throw new Error(`Compose project ${projectName} is not owned by this verification.`);
    }
    assertRuntimeSecurity(
      "migrate",
      await runCommand(
        "docker",
        runtimeSecurityProbeArguments(compose, "migrate"),
        environment,
        true,
      ),
    );
    await runCommand("docker", [...compose, "run", "--rm", "migrate"], environment);
    const appliedMigrations = parseMigrationCount(
      await runCommand(
        "docker",
        [
          ...compose,
          "exec",
          "--no-TTY",
          "postgres",
          "psql",
          "--no-psqlrc",
          "--tuples-only",
          "--no-align",
          "--username",
          "schedule",
          "--dbname",
          "schedule",
          "--command",
          "select count(*) from drizzle.__drizzle_migrations",
        ],
        environment,
        true,
      ),
    );
    if (appliedMigrations !== expectedMigrationCount()) {
      throw new Error("Built image did not apply the complete migration journal.");
    }
    const schemaReady = await runCommand(
      "docker",
      [
        ...compose,
        "exec",
        "--no-TTY",
        "postgres",
        "psql",
        "--no-psqlrc",
        "--tuples-only",
        "--no-align",
        "--username",
        "schedule",
        "--dbname",
        "schedule",
        "--command",
        "select concat((to_regclass('public.workspaces') is not null)::int,(to_regclass('public.routines') is not null)::int,(to_regclass('public.work_items') is not null)::int,(to_regclass('public.notification_delivery_commands') is not null)::int,(to_regclass('public.external_identities') is not null)::int)",
      ],
      environment,
      true,
    );
    if (schemaReady !== "11111") throw new Error("Built image produced an incomplete schema.");
    await runCommand(
      "docker",
      [...compose, "up", "--detach", "--wait", "api", "worker"],
      environment,
    );
    for (const service of ["api", "worker"] as const) {
      assertRuntimeSecurity(
        service,
        await runCommand(
          "docker",
          runtimeSecurityProbeArguments(compose, service),
          environment,
          true,
        ),
      );
    }

    const apiPort = parsePublishedApiPort(
      await runCommand("docker", [...compose, "port", "api", "4000"], environment, true),
    );
    const apiBaseUrl = `http://127.0.0.1:${apiPort}`;
    await requireJson(`${apiBaseUrl}/health/live`, 200, { status: "alive" });
    await requireJson(`${apiBaseUrl}/health/ready`, 200, { status: "ready" });
    await requireJson(`${apiBaseUrl}/v1/workspaces`, 404, {
      message: "Route GET:/v1/workspaces not found",
      error: "Not Found",
      statusCode: 404,
    });
    await requireJson(`${apiBaseUrl}/v1/routines`, 404, {
      message: "Route GET:/v1/routines not found",
      error: "Not Found",
      statusCode: 404,
    });
    await requireJson(`${apiBaseUrl}/v1/integrations/today`, 404, {
      message: "Route GET:/v1/integrations/today not found",
      error: "Not Found",
      statusCode: 404,
    });
    await requireJson(`${apiBaseUrl}/v1/system/info`, 200, {
      service: "schedule-api",
      version: "0.1.0",
      architecture: "modular-monolith",
      productEndpointsEnabled: false,
      integrationEndpointsEnabled: false,
      hostedEndpointsEnabled: false,
    });

    await runCommand(
      "docker",
      [
        ...compose,
        "exec",
        "--no-TTY",
        "worker",
        "node",
        "-e",
        "Promise.all(['/health/live','/health/ready'].map(async p=>{const r=await fetch('http://127.0.0.1:9464'+p);if(!r.ok)throw new Error('unhealthy')})).catch(()=>process.exit(1))",
      ],
      environment,
    );
    const workerId = await runCommand(
      "docker",
      [...compose, "ps", "--all", "--quiet", "worker"],
      environment,
      true,
    );
    if (!/^[a-f0-9]{12,64}$/u.test(workerId)) {
      throw new Error("Docker did not return the worker container identifier.");
    }
    const runningWorkerId = await runCommand(
      "docker",
      [...compose, "ps", "--status", "running", "--quiet", "worker"],
      environment,
      true,
    );
    if (runningWorkerId !== workerId) {
      throw new Error("Worker was not running immediately before the shutdown check.");
    }
    await runCommand("docker", [...compose, "stop", "--timeout", "20", "worker"], environment);
    const runningAfterStop = await runCommand(
      "docker",
      [...compose, "ps", "--status", "running", "--quiet", "worker"],
      environment,
      true,
    );
    if (runningAfterStop !== "") throw new Error("Worker remained running after SIGTERM.");
    const exitCode = parseContainerExitCode(
      await runCommand(
        "docker",
        ["inspect", "--format", "{{.State.ExitCode}}", workerId],
        environment,
        true,
      ),
    );
    if (exitCode !== 0) throw new Error("Worker image did not exit cleanly after SIGTERM.");
    if (interruptedBy !== null) {
      throw new Error(`OCI runtime verification interrupted by ${interruptedBy}.`);
    }
    process.stdout.write(
      "OCI runtime verification passed hardened non-root containers, image builds, migrations, fail-closed API health, loopback worker health, and graceful shutdown.\n",
    );
  } catch (error) {
    primaryError = error;
    const mayInspect =
      composeAttempted &&
      (await projectOwnership(projectName, owner, environment).catch(() => "foreign")) === "owned";
    if (mayInspect) {
      await runCommand("docker", [...compose, "ps", "--all"], environment).catch(() => undefined);
      await runCommand(
        "docker",
        [...compose, "logs", "--no-color", "--tail", "200"],
        environment,
      ).catch(() => undefined);
    }
  } finally {
    if (composeAttempted) {
      try {
        const ownership = await projectOwnership(projectName, owner, environment);
        if (ownership === "foreign") {
          cleanupError = new Error(`Refusing to remove unowned Compose project ${projectName}.`);
        } else if (ownership === "owned") {
          await runCommand(
            "docker",
            [...compose, "down", "--volumes", "--remove-orphans", "--timeout", "20"],
            environment,
            false,
            true,
          );
        }
      } catch (error) {
        cleanupError ??= error;
      }
    }
    for (const image of [apiImage, workerImage]) {
      await runCommand("docker", ["image", "rm", "--force", image], environment, false, true).catch(
        () => undefined,
      );
      try {
        const remaining = await runCommand(
          "docker",
          ["image", "ls", "--quiet", "--filter", `reference=${image}`],
          environment,
          true,
          true,
        );
        if (remaining !== "") cleanupError ??= new Error("Runtime smoke image cleanup failed.");
      } catch {
        cleanupError ??= new Error("Runtime smoke image cleanup could not be verified.");
      }
    }
    process.removeListener("SIGINT", sigint);
    process.removeListener("SIGTERM", sigterm);
  }

  if (primaryError !== null && cleanupError !== null) {
    throw new AggregateError(
      [primaryError, cleanupError],
      "OCI runtime verification and cleanup failed.",
    );
  }
  if (primaryError !== null) throw primaryError;
  if (cleanupError !== null) throw cleanupError;
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  await verifyOciRuntime();
}
