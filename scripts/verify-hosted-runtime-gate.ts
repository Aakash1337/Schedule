import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverEntryPoint = path.join(repositoryRoot, "apps", "api", "src", "server.ts");
const MAX_CAPTURED_OUTPUT_BYTES = 64 * 1_024;

interface SpawnedServer {
  readonly child: ChildProcess;
  readonly exited: Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>;
  readonly output: () => string;
}

function cleanEnvironment(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("HOSTED_")),
  );
  return {
    ...environment,
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    API_HOST: "127.0.0.1",
    PRODUCT_API_MODE: "disabled",
    INTEGRATION_API_MODE: "disabled",
    HOSTED_API_MODE: "disabled",
    ...overrides,
  };
}

function spawnApi(environment: NodeJS.ProcessEnv): SpawnedServer {
  let output = "";
  // Run the entry point in the child itself so signals reach its shutdown handler instead of a
  // platform-specific CLI wrapper process.
  const child = spawn(process.execPath, ["--import", "tsx", serverEntryPoint], {
    cwd: repositoryRoot,
    env: environment,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const capture = (chunk: Buffer): void => {
    const remainingBytes = MAX_CAPTURED_OUTPUT_BYTES - Buffer.byteLength(output, "utf8");
    if (remainingBytes <= 0) return;
    output += chunk.subarray(0, remainingBytes).toString("utf8");
  };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    },
  );
  return { child, exited, output: () => output };
}

async function within<Value>(promise: Promise<Value>, milliseconds: number, message: string) {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function unusedLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("No loopback port assigned.");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function waitForLiveServer(origin: string, spawned: SpawnedServer): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (spawned.child.exitCode !== null || spawned.child.signalCode !== null) {
      throw new Error(`Disabled hosted API exited before listening: ${spawned.output()}`);
    }
    try {
      const response = await fetch(`${origin}/health/live`, { signal: AbortSignal.timeout(500) });
      if (response.status === 200) return;
    } catch {
      // Startup is asynchronous; retry within the fixed outer bound.
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Disabled hosted API did not become live: ${spawned.output()}`);
}

async function stopServer(spawned: SpawnedServer): Promise<void> {
  if (spawned.child.exitCode === null && spawned.child.signalCode === null) {
    spawned.child.kill("SIGTERM");
  }
  const result = await within(spawned.exited, 5_000, "API did not stop after SIGTERM.");
  assert.equal(
    result.code === 0 || result.signal === "SIGTERM",
    true,
    `API shutdown failed: ${spawned.output()}`,
  );
}

async function startDisabledServer(): Promise<{
  readonly origin: string;
  readonly spawned: SpawnedServer;
}> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const port = await unusedLoopbackPort();
    const origin = `http://127.0.0.1:${String(port)}`;
    const spawned = spawnApi(cleanEnvironment({ API_PORT: String(port), LOG_LEVEL: "error" }));
    try {
      await waitForLiveServer(origin, spawned);
      return { origin, spawned };
    } catch (error) {
      if (spawned.child.exitCode === null && spawned.child.signalCode === null) {
        spawned.child.kill("SIGKILL");
      }
      await within(spawned.exited, 5_000, "Failed API child did not exit.").catch(() => undefined);
      if (!/EADDRINUSE|address already in use/iu.test(spawned.output()) || attempt === 2) {
        throw error;
      }
    }
  }
  throw new Error("Disabled hosted API startup attempts were exhausted.");
}

const secret = "hosted-secret-must-never-appear";
const rejected = spawnApi(
  cleanEnvironment({
    API_PORT: String(await unusedLoopbackPort()),
    Hosted_Session_Pepper: secret,
  }),
);
try {
  const rejectedExit = await within(
    rejected.exited,
    10_000,
    "API accepted premature hosted companion configuration.",
  );
  assert.notEqual(rejectedExit.code, 0);
  const rejectedOutput = rejected.output();
  assert.equal(rejectedOutput.includes(secret), false);
  assert.equal(rejectedOutput.toUpperCase().includes("HOSTED_SESSION_PEPPER"), false);
  assert.match(rejectedOutput, /Hosted companion configuration is not accepted/u);
} finally {
  if (rejected.child.exitCode === null && rejected.child.signalCode === null) {
    rejected.child.kill("SIGKILL");
  }
}

const { origin, spawned: disabled } = await startDisabledServer();
try {
  const systemInfo = await fetch(`${origin}/v1/system/info`);
  assert.equal(systemInfo.status, 200);
  assert.deepEqual(await systemInfo.json(), {
    service: "schedule-api",
    version: "0.1.0",
    architecture: "modular-monolith",
    productEndpointsEnabled: false,
    integrationEndpointsEnabled: false,
    hostedEndpointsEnabled: false,
  });

  const browserHeaders = {
    "content-type": "application/json",
    origin: "https://hosted.schedule.test",
    cookie:
      "__Host-schedule_session=00000000-0000-4000-8000-000000000201.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA; __Host-schedule_csrf=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
    "x-schedule-csrf": "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
  };
  for (const request of [
    { method: "GET", route: "/v1/auth/session" },
    { method: "GET", route: "/v1/auth/login" },
    {
      method: "GET",
      route: `/v1/auth/callback?code=unreachable-code&state=${"S".repeat(43)}`,
    },
    { method: "POST", route: "/v1/auth/logout", body: {} },
    {
      method: "POST",
      route: "/v1/hosted/workspaces/00000000-0000-4000-8000-000000000001/work-items",
      body: { title: "Unreachable hosted work item" },
    },
  ] as const) {
    const response = await fetch(`${origin}${request.route}`, {
      method: request.method,
      headers: browserHeaders,
      ...("body" in request ? { body: JSON.stringify(request.body) } : {}),
    });
    assert.equal(response.status, 404, `${request.method} ${request.route}`);
  }

  assert.equal(disabled.child.exitCode, null, "API exited during dormant-route verification.");
  assert.equal(
    disabled.child.signalCode,
    null,
    "API was signaled during dormant-route verification.",
  );

  await stopServer(disabled);
} finally {
  if (disabled.child.exitCode === null && disabled.child.signalCode === null) {
    disabled.child.kill("SIGKILL");
  }
}

console.log(
  "Hosted runtime gate verification passed startup rejection without secret disclosure, disabled capability reporting, and dormant route closure.",
);
