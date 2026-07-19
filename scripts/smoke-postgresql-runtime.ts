import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

type Result = Readonly<{ stdout: string; stderr: string }>;

function executable(root: string, name: string): string {
  return path.join(root, "bin", `${name}${process.platform === "win32" ? ".exe" : ""}`);
}

function run(
  command: string,
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<Result> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      env: environment,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 120_000);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (timedOut) reject(new Error(`${path.basename(command)} exceeded its 120 second limit.`));
      else if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${path.basename(command)} failed (${code}): ${stderr || stdout}`));
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
  const environment = {
    ...process.env,
    PATH: `${path.join(relocated, "bin")}${path.delimiter}${process.env.PATH ?? ""}`,
  };
  let startAttempted = false;
  let primaryFailure: unknown;
  try {
    const { cp } = await import("node:fs/promises");
    await cp(runtime, relocated, { recursive: true, dereference: false, errorOnExist: true });
    await run(
      executable(relocated, "initdb"),
      ["-D", data, "--auth=trust", "--no-locale"],
      environment,
    );
    const port = await availablePort();
    await writeFile(
      path.join(data, "postgresql.auto.conf"),
      `listen_addresses = '127.0.0.1'\nport = ${port}\nssl = off\n`,
    );
    startAttempted = true;
    await run(executable(relocated, "pg_ctl"), ["-D", data, "-w", "start"], environment);
    const connection = ["-h", "127.0.0.1", "-p", String(port), "-d", "postgres"];
    await run(
      executable(relocated, "psql"),
      [...connection, "-v", "ON_ERROR_STOP=1", "-c", "CREATE EXTENSION pgcrypto"],
      environment,
    );
    const crypto = await run(
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
    await run(executable(relocated, "pg_dump"), [...connection, "-Fc", "-f", dump], environment);
    const listing = await run(executable(relocated, "pg_restore"), ["--list", dump], environment);
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
      await run(
        executable(relocated, "pg_ctl"),
        ["-D", data, "-w", "-m", "fast", "stop"],
        environment,
      );
    } catch {
      try {
        await run(
          executable(relocated, "pg_ctl"),
          ["-D", data, "-w", "-m", "immediate", "stop"],
          environment,
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
