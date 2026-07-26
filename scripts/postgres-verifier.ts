import { spawn } from "node:child_process";
import path from "node:path";

import {
  assertComposeDatabaseReady,
  composeDatabaseName,
  composeDatabaseService,
  composeDatabaseUser,
  runComposeCommand,
} from "./backup-database.js";

const nativeBinVariable = "SCHEDULE_VERIFIER_POSTGRES_BIN";
const nativeUrlVariable = "SCHEDULE_VERIFIER_DATABASE_URL";
const commandTimeoutMs = 30_000;
const commandTerminationGraceMs = 2_000;
const outputLimit = 64 * 1024;
const safeSslModes = new Set(["disable", "allow", "prefer", "require", "verify-ca", "verify-full"]);
const loopbackHosts = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export interface NativePostgresVerifier {
  readonly binDirectory: string;
  readonly databasePassword: string;
  readonly databaseUrl: string;
  readonly databaseUser: string;
  readonly psql: string;
  readonly pgIsReady: string;
}

export interface PsqlOptions {
  readonly quiet?: boolean;
}

function databaseNameIsSafe(databaseName: string): boolean {
  return /^[a-z_][a-z0-9_]{0,62}$/.test(databaseName);
}

function assertSafeConnectionOptions(url: URL): void {
  const options = [...url.searchParams.keys()];
  const sslModes = url.searchParams.getAll("sslmode");
  if (
    url.hash !== "" ||
    options.some((option) => option !== "sslmode") ||
    sslModes.length > 1 ||
    (sslModes[0] !== undefined && !safeSslModes.has(sslModes[0]))
  ) {
    throw new Error(
      `${nativeUrlVariable} may contain only one recognized sslmode option and no fragment.`,
    );
  }
}

function redact(value: string, native: NativePostgresVerifier): string {
  const url = new URL(native.databaseUrl);
  let redacted = value.replaceAll(url.toString(), "[SCHEDULE_VERIFIER_DATABASE_URL]");
  for (const password of new Set([url.password, native.databasePassword])) {
    if (password !== "") redacted = redacted.replaceAll(password, "[REDACTED]");
  }
  return redacted;
}

export function redactVerifierCredentials(value: string): string {
  const native = parseNativePostgresVerifier();
  return native === null ? value : redact(value, native);
}

export function parseNativePostgresVerifier(
  environment: NodeJS.ProcessEnv = process.env,
  hostPlatform = process.platform,
): NativePostgresVerifier | null {
  const binDirectory = environment[nativeBinVariable]?.trim();
  const rawDatabaseUrl = environment[nativeUrlVariable]?.trim();
  if (binDirectory === undefined && rawDatabaseUrl === undefined) return null;
  if (binDirectory === undefined || rawDatabaseUrl === undefined) {
    throw new Error(
      `${nativeBinVariable} and ${nativeUrlVariable} must be set together to use native PostgreSQL verification.`,
    );
  }
  const platformPath = hostPlatform === "win32" ? path.win32 : path.posix;
  if (!platformPath.isAbsolute(binDirectory)) {
    throw new Error(`${nativeBinVariable} must be an absolute directory path.`);
  }

  let url: URL;
  try {
    url = new URL(rawDatabaseUrl);
  } catch {
    throw new Error(`${nativeUrlVariable} must be a valid PostgreSQL connection URL.`);
  }
  if (
    (url.protocol !== "postgres:" && url.protocol !== "postgresql:") ||
    !loopbackHosts.has(url.hostname)
  ) {
    throw new Error(`${nativeUrlVariable} must use a loopback PostgreSQL URL.`);
  }
  assertSafeConnectionOptions(url);
  let databaseName: string;
  let databasePassword: string;
  let databaseUser: string;
  try {
    databaseName = decodeURIComponent(url.pathname.slice(1));
    databasePassword = decodeURIComponent(url.password);
    databaseUser = decodeURIComponent(url.username);
  } catch {
    throw new Error(`${nativeUrlVariable} contains invalid percent-encoded credentials.`);
  }
  if (!databaseNameIsSafe(databaseName) || !databaseNameIsSafe(databaseUser)) {
    throw new Error(
      `${nativeUrlVariable} must contain simple PostgreSQL database and user identifiers for verifier safety.`,
    );
  }
  const suffix = hostPlatform === "win32" ? ".exe" : "";
  return {
    binDirectory,
    databasePassword,
    databaseUrl: url.toString(),
    databaseUser,
    psql: platformPath.join(binDirectory, `psql${suffix}`),
    pgIsReady: platformPath.join(binDirectory, `pg_isready${suffix}`),
  };
}

export function verifierDatabaseUrl(databaseName: string): string {
  if (!databaseNameIsSafe(databaseName)) {
    throw new Error(`Unsafe PostgreSQL verifier database identifier: ${databaseName}`);
  }
  const native = parseNativePostgresVerifier();
  if (native === null) {
    return `postgres://${composeDatabaseUser}:${composeDatabaseUser}@127.0.0.1:5432/${databaseName}`;
  }
  const url = new URL(native.databaseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

export function verifierCommandDatabaseUrl(databaseName: string): string {
  const url = new URL(verifierDatabaseUrl(databaseName));
  url.password = "";
  return url.toString();
}

export function verifierDatabaseUser(): string {
  return parseNativePostgresVerifier()?.databaseUser ?? composeDatabaseUser;
}

function nativeChildEnvironment(native: NativePostgresVerifier): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const key of Object.keys(environment)) {
    const normalized = key.toUpperCase();
    if (
      normalized.startsWith("PG") ||
      normalized === nativeBinVariable ||
      normalized.endsWith("DATABASE_URL")
    ) {
      delete environment[key];
    }
  }
  environment.PGCONNECT_TIMEOUT = "10";
  environment.PGPASSWORD = native.databasePassword;
  return environment;
}

export async function runNativeVerifierCommand(
  executable: string,
  args: readonly string[],
  native: NativePostgresVerifier,
  timing: {
    readonly timeoutMs?: number;
    readonly terminationGraceMs?: number;
  } = {},
): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputSize = 0;
    let settled = false;
    let timedOut = false;
    const timers: {
      command?: ReturnType<typeof setTimeout>;
      termination?: ReturnType<typeof setTimeout>;
    } = {};
    const add = (chunks: Buffer[], chunk: Buffer) => {
      if (outputSize >= outputLimit) return;
      const available = outputLimit - outputSize;
      chunks.push(chunk.subarray(0, available));
      outputSize += Math.min(chunk.length, available);
    };
    const diagnostic = () =>
      redact(
        Buffer.concat([...stdout, ...stderr])
          .toString("utf8")
          .trim(),
        native,
      );
    const finish = (error: Error | undefined, output = "") => {
      if (settled) return;
      settled = true;
      if (timers.command !== undefined) clearTimeout(timers.command);
      if (timers.termination !== undefined) clearTimeout(timers.termination);
      if (error === undefined) resolve(output);
      else reject(error);
    };
    const child = spawn(executable, args, {
      env: nativeChildEnvironment(native),
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    timers.command = setTimeout(() => {
      timedOut = true;
      child.kill();
      timers.termination = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
        try {
          child.kill("SIGKILL");
        } catch {
          // The bounded timeout result remains authoritative.
        }
        child.unref();
        const output = diagnostic();
        finish(
          new Error(
            `Native PostgreSQL verifier command timed out${output === "" ? "." : `: ${output}`}`,
          ),
        );
      }, timing.terminationGraceMs ?? commandTerminationGraceMs);
      timers.termination.unref?.();
    }, timing.timeoutMs ?? commandTimeoutMs);
    timers.command.unref?.();
    child.stdout?.on("data", (chunk: Buffer) => add(stdout, chunk));
    child.stderr?.on("data", (chunk: Buffer) => add(stderr, chunk));
    child.once("error", (error) => {
      finish(
        new Error(
          `Native PostgreSQL verifier command could not start: ${redact(error.message, native)}`,
        ),
      );
    });
    child.once("close", (code) => {
      const output = diagnostic();
      if (!timedOut && code === 0) {
        finish(undefined, Buffer.concat(stdout).toString("utf8"));
        return;
      }
      finish(
        new Error(
          `Native PostgreSQL verifier command ${timedOut ? "timed out" : `failed with exit code ${String(code)}`}${output === "" ? "" : `: ${output}`}`,
        ),
      );
    });
  });
}

export async function runVerifierPsql(
  databaseName: string,
  statement: string,
  options: PsqlOptions = {},
): Promise<string> {
  if (!databaseNameIsSafe(databaseName)) {
    throw new Error(`Unsafe PostgreSQL verifier database identifier: ${databaseName}`);
  }
  const native = parseNativePostgresVerifier();
  if (native === null) {
    return runComposeCommand([
      "exec",
      "-T",
      composeDatabaseService,
      "psql",
      "--username",
      composeDatabaseUser,
      "--dbname",
      databaseName,
      "--no-psqlrc",
      "--set=ON_ERROR_STOP=1",
      "--tuples-only",
      "--no-align",
      ...(options.quiet ? ["--quiet"] : []),
      "--command",
      statement,
    ]);
  }
  return runNativeVerifierCommand(
    native.psql,
    [
      "--dbname",
      verifierCommandDatabaseUrl(databaseName),
      "--no-psqlrc",
      "--set=ON_ERROR_STOP=1",
      "--tuples-only",
      "--no-align",
      ...(options.quiet ? ["--quiet"] : []),
      "--command",
      statement,
    ],
    native,
  );
}

export async function assertPostgresVerifierReady(
  databaseName = composeDatabaseName,
): Promise<void> {
  if (!databaseNameIsSafe(databaseName)) {
    throw new Error(`Unsafe PostgreSQL verifier database identifier: ${databaseName}`);
  }
  const native = parseNativePostgresVerifier();
  if (native === null) return assertComposeDatabaseReady(databaseName);
  await runNativeVerifierCommand(
    native.pgIsReady,
    ["--dbname", verifierCommandDatabaseUrl(databaseName), "--timeout=10"],
    native,
  );
}
