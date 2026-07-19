import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

type Result = Readonly<{ stdout: string; stderr: string }>;

async function terminateProcessTree(child: ChildProcess): Promise<void> {
  const processId = child.pid;
  if (processId === undefined) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve, reject) => {
      const killer = spawn("taskkill.exe", ["/PID", String(processId), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      const timer = setTimeout(() => {
        killer.kill();
        reject(new Error("Windows process-tree termination exceeded 5000 ms."));
      }, 5000);
      killer.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      killer.once("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`Windows process-tree termination failed (${code ?? "unknown"}).`));
      });
    });
    return;
  }
  try {
    process.kill(-processId, "SIGKILL");
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") {
      return;
    }
    throw error;
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      process.kill(-processId, 0);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ESRCH"
      ) {
        return;
      }
      throw error;
    }
    await delay(25);
  }
  throw new Error("Unix process-tree termination exceeded 5000 ms.");
}

function executable(root: string, name: string): string {
  return path.join(root, "bin", `${name}${process.platform === "win32" ? ".exe" : ""}`);
}

export function runPostgresCommand(
  command: string,
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
  timeoutMs = 120_000,
  captureOutput = true,
): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      env: environment,
      shell: false,
      stdio: captureOutput ? ["ignore", "pipe", "pipe"] : "ignore",
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let directExited = false;
    const finish = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      action();
    };
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (directExited || child.exitCode !== null || child.signalCode !== null) {
        child.stdout?.destroy();
        child.stderr?.destroy();
        reject(new Error(`${path.basename(command)} exceeded its ${timeoutMs} ms limit.`));
        return;
      }
      void terminateProcessTree(child).then(
        () => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          reject(new Error(`${path.basename(command)} exceeded its ${timeoutMs} ms limit.`));
        },
        () => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          reject(new Error(`${path.basename(command)} timed out and tree termination failed.`));
        },
      );
    }, timeoutMs);
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (error) => finish(() => reject(error)));
    child.on("exit", () => (directExited = true));
    child.on("close", (code) => {
      finish(() => {
        if (code === 0) resolve({ stdout, stderr });
        else {
          const detail = (stderr || stdout)
            .trim()
            .slice(-4096)
            .replaceAll(os.tmpdir(), "<temporary>");
          reject(new Error(`${path.basename(command)} failed (${code}): ${detail}`));
        }
      });
    });
  });
}

async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (typeof address === "string" || address === null) {
        server.close();
        reject(new Error("Could not allocate a loopback smoke-test port."));
        return;
      }
      server.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

export async function smokePostgreSqlRuntime(runtimeDirectory: string): Promise<void> {
  const runtime = path.resolve(runtimeDirectory);
  const temporary = await mkdtemp(path.join(os.tmpdir(), "Schedule PostgreSQL smoke "));
  const relocated = path.join(temporary, "relocated runtime with spaces");
  const data = path.join(temporary, "cluster with spaces");
  const dump = path.join(temporary, "smoke.dump");
  const serverLog = path.join(temporary, "postgres.log");
  const environment = {
    ...process.env,
    PATH: `${path.join(relocated, "bin")}${path.delimiter}${process.env.PATH ?? ""}`,
  };
  let startAttempted = false;
  let primaryFailure: unknown;
  try {
    const { cp } = await import("node:fs/promises");
    await cp(runtime, relocated, { recursive: true, dereference: false, errorOnExist: true });
    await runPostgresCommand(
      executable(relocated, "initdb"),
      ["-D", data, "--auth=trust", "--no-locale", "--username=postgres"],
      environment,
    );
    const port = await availablePort();
    await writeFile(
      path.join(data, "postgresql.auto.conf"),
      `listen_addresses = '127.0.0.1'\nport = ${port}\nssl = off\n`,
    );
    await writeFile(serverLog, "", { mode: 0o600 });
    startAttempted = true;
    await runPostgresCommand(
      executable(relocated, "pg_ctl"),
      ["-D", data, "-l", serverLog, "-w", "start"],
      environment,
      120_000,
      false,
    );
    const connection = ["-h", "127.0.0.1", "-p", String(port), "-U", "postgres", "-d", "postgres"];
    await runPostgresCommand(
      executable(relocated, "psql"),
      [...connection, "-v", "ON_ERROR_STOP=1", "-c", "CREATE EXTENSION pgcrypto"],
      environment,
    );
    const crypto = await runPostgresCommand(
      executable(relocated, "psql"),
      [
        ...connection,
        "-At",
        "-v",
        "ON_ERROR_STOP=1",
        "-c",
        "SELECT encode(digest('schedule','sha256'),'hex'), convert_from(decrypt(encrypt('schedule'::bytea, digest('key','sha256'), 'aes'), digest('key','sha256'), 'aes'),'UTF8')",
      ],
      environment,
    );
    if (!/^[a-f0-9]{64}\|schedule\s*$/u.test(crypto.stdout.trim())) {
      throw new Error("pgcrypto smoke result was invalid.");
    }
    await runPostgresCommand(
      executable(relocated, "pg_dump"),
      [...connection, "-Fc", "-f", dump],
      environment,
    );
    const listing = await runPostgresCommand(
      executable(relocated, "pg_restore"),
      ["--list", dump],
      environment,
    );
    if (!listing.stdout.includes("EXTENSION - pgcrypto")) {
      throw new Error("pg_dump/pg_restore smoke did not retain pgcrypto.");
    }
  } catch (error) {
    primaryFailure = error;
  }
  let cleanupFailure: unknown;
  const postmasterPid = await lstat(path.join(data, "postmaster.pid")).catch(() => null);
  if (startAttempted && postmasterPid?.isFile()) {
    try {
      await runPostgresCommand(
        executable(relocated, "pg_ctl"),
        ["-D", data, "-w", "-m", "fast", "stop"],
        environment,
        120_000,
        false,
      );
    } catch {
      try {
        await runPostgresCommand(
          executable(relocated, "pg_ctl"),
          ["-D", data, "-w", "-m", "immediate", "stop"],
          environment,
          120_000,
          false,
        );
      } catch (error) {
        cleanupFailure = error;
      }
    }
  }
  if (cleanupFailure === undefined) {
    await rm(temporary, { recursive: true, force: true });
  }
  if (primaryFailure !== undefined && cleanupFailure !== undefined) {
    throw new AggregateError(
      [primaryFailure, cleanupFailure],
      `PostgreSQL smoke failed and retained its live-cluster directory at ${temporary}.`,
    );
  }
  if (cleanupFailure !== undefined) {
    throw new Error(`PostgreSQL smoke retained its live-cluster directory at ${temporary}.`, {
      cause: cleanupFailure,
    });
  }
  if (primaryFailure !== undefined) throw primaryFailure;
}

if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  if (process.argv.length !== 3) throw new Error("Usage: smoke-postgresql-runtime ROOT");
  await smokePostgreSqlRuntime(process.argv[2]!);
  process.stdout.write("Relocated PostgreSQL runtime smoke passed.\n");
}
