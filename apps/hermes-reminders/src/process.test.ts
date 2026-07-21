import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

import type { Sql } from "postgres";

import {
  HermesReminderProcessError,
  loadHermesDeliveryClient,
  loadHermesReminderProcessConfig,
  runHermesReminderProcess,
  type ManagedHermesDeliveryClient,
  type HermesReminderProcessDependencies,
} from "./process.js";

const modulePath = path.resolve("operator/schedule-hermes-client.mjs");
const privateToken = "t".repeat(40);
const enabledEnvironment = {
  HERMES_REMINDER_PROCESS_MODE: "enabled",
  HERMES_REMINDER_HEALTH_HOST: "127.0.0.1",
  HERMES_REMINDER_HEALTH_PORT: "9465",
  HERMES_REMINDER_SCHEDULE_URL: "https://schedule.example.com",
  HERMES_REMINDER_SCHEDULE_TOKEN: privateToken,
  HERMES_REMINDER_DEDUPE_DATABASE_URL:
    "postgres://hermes_runtime:private-password@database.example.com/schedule",
  HERMES_REMINDER_CLIENT_MODULE: modulePath,
} satisfies NodeJS.ProcessEnv;

const client: ManagedHermesDeliveryClient = {
  reconcile: async () => ({ outcome: "not_found" }),
  send: async () => ({ outcome: "accepted" }),
  close: async () => undefined,
};

async function unusedLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing test address.");
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
  return address.port;
}

describe("Hermes reminder process configuration", () => {
  it("stays disabled without loading enabled-only secrets", () => {
    expect(
      loadHermesReminderProcessConfig({
        HERMES_REMINDER_SCHEDULE_TOKEN: "malformed private value",
        HERMES_REMINDER_CLIENT_INITIALIZATION_TIMEOUT_MS: "not-a-number",
      }),
    ).toEqual({
      HERMES_REMINDER_PROCESS_MODE: "disabled",
      HERMES_REMINDER_HEALTH_HOST: "127.0.0.1",
      HERMES_REMINDER_HEALTH_PORT: 9_465,
    });
  });

  it("accepts one explicit enabled composition with an absolute local ESM factory", () => {
    expect(loadHermesReminderProcessConfig(enabledEnvironment)).toEqual({
      HERMES_REMINDER_PROCESS_MODE: "enabled",
      HERMES_REMINDER_HEALTH_HOST: "127.0.0.1",
      HERMES_REMINDER_HEALTH_PORT: 9_465,
      HERMES_REMINDER_SCHEDULE_URL: "https://schedule.example.com",
      HERMES_REMINDER_SCHEDULE_TOKEN: privateToken,
      HERMES_REMINDER_DEDUPE_DATABASE_URL:
        "postgres://hermes_runtime:private-password@database.example.com/schedule",
      HERMES_REMINDER_CLIENT_MODULE: modulePath,
      HERMES_REMINDER_CLIENT_INITIALIZATION_TIMEOUT_MS: 30_000,
    });
  });

  it.each([
    { HERMES_REMINDER_SCHEDULE_TOKEN: undefined },
    { HERMES_REMINDER_SCHEDULE_URL: "http://schedule.example.com" },
    { HERMES_REMINDER_DEDUPE_DATABASE_URL: "https://database.example.com/schedule" },
    { HERMES_REMINDER_CLIENT_MODULE: ".\\relative-client.mjs" },
    {
      HERMES_REMINDER_CLIENT_MODULE:
        process.platform === "win32"
          ? "\\\\server\\share\\schedule-hermes-client.mjs"
          : "//server/share/schedule-hermes-client.mjs",
    },
    { HERMES_REMINDER_CLIENT_MODULE: path.join(path.dirname(modulePath), "client.ts") },
    { HERMES_REMINDER_CLIENT_INITIALIZATION_TIMEOUT_MS: "0" },
    { HERMES_REMINDER_HEALTH_HOST: "0.0.0.0" },
  ])("rejects unsafe enabled composition without retaining values", (override) => {
    let failure: unknown;
    try {
      loadHermesReminderProcessConfig({ ...enabledEnvironment, ...override });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(HermesReminderProcessError);
    expect((failure as HermesReminderProcessError).code).toBe("configuration_invalid");
    expect(JSON.stringify(failure)).not.toContain(privateToken);
    expect(String(failure)).not.toContain("database.example.com");
  });
});

describe("Hermes delivery client module", () => {
  it("loads only the named factory from an absolute file URL", async () => {
    const factory = vi.fn(async (_signal: AbortSignal) => client);
    const importModule = vi.fn(async () => ({ createHermesDeliveryClient: factory }));

    await expect(
      loadHermesDeliveryClient(modulePath, {
        signal: new AbortController().signal,
        timeoutMs: 1_000,
        importModule,
      }),
    ).resolves.toBe(client);
    expect(importModule).toHaveBeenCalledWith(pathToFileURL(modulePath).href);
    expect(factory).toHaveBeenCalledOnce();
  });

  it.each([
    {
      code: "client_module_unavailable",
      importer: async () => Promise.reject(new Error("private provider import error")),
    },
    { code: "client_factory_invalid", importer: async () => ({}) },
    {
      code: "client_factory_invalid",
      importer: async () => ({ createHermesDeliveryClient: () => client }),
    },
    {
      code: "client_initialization_failed",
      importer: async () => ({
        createHermesDeliveryClient: (_signal: AbortSignal) => {
          throw new Error("private provider factory error");
        },
      }),
    },
    {
      code: "client_factory_invalid",
      importer: async () => ({
        createHermesDeliveryClient: (_signal: AbortSignal) => ({ send: async () => ({}) }),
      }),
    },
  ] as const)("redacts $code module failures", async ({ code, importer }) => {
    const failure = await loadHermesDeliveryClient(modulePath, {
      signal: new AbortController().signal,
      timeoutMs: 1_000,
      importModule: importer,
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(HermesReminderProcessError);
    expect((failure as HermesReminderProcessError).code).toBe(code);
    expect(String(failure)).not.toContain("private provider");
  });

  it("bounds a pending client-module import", async () => {
    const failure = await loadHermesDeliveryClient(modulePath, {
      signal: new AbortController().signal,
      timeoutMs: 5,
      importModule: async () => await new Promise<unknown>(() => undefined),
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(HermesReminderProcessError);
    expect((failure as HermesReminderProcessError).code).toBe("client_initialization_timed_out");
  });

  it("keeps the standalone process alive through a sanitized initialization timeout", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "schedule-hermes-process-"));
    const clientModule = path.join(directory, "pending-client.mjs");
    writeFileSync(
      clientModule,
      'export async function createHermesDeliveryClient(signal) { return await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("private factory abort")), { once: true })); }',
    );

    try {
      const result = spawnSync(
        process.execPath,
        ["--import", "tsx", fileURLToPath(new URL("./process-main.ts", import.meta.url))],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          timeout: 20_000,
          env: {
            ...process.env,
            NODE_OPTIONS: "",
            NODE_V8_COVERAGE: "",
            HERMES_REMINDER_PROCESS_MODE: "enabled",
            HERMES_REMINDER_CLIENT_INITIALIZATION_TIMEOUT_MS: "100",
            HERMES_REMINDER_SCHEDULE_URL: "https://schedule.example.com",
            HERMES_REMINDER_SCHEDULE_TOKEN: privateToken,
            HERMES_REMINDER_DEDUPE_DATABASE_URL:
              "postgres://hermes_runtime:private-password@database.example.com/schedule",
            HERMES_REMINDER_CLIENT_MODULE: clientModule,
          },
        },
      );

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain('"event":"hermes_reminder_process_failed"');
      expect(result.stderr).not.toContain(privateToken);
      expect(result.stderr).not.toContain(directory);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 25_000);
});

describe("Hermes reminder process composition", () => {
  it("does not initialize enabled dependencies when startup is already aborted", async () => {
    const controller = new AbortController();
    const importModule = vi.fn();
    const openDedupeConnection = vi.fn();
    const runRuntime = vi.fn();
    controller.abort("shutdown requested");

    await runHermesReminderProcess(enabledEnvironment, controller.signal, {
      importModule,
      openDedupeConnection,
      runRuntime,
    });

    expect(importModule).not.toHaveBeenCalled();
    expect(openDedupeConnection).not.toHaveBeenCalled();
    expect(runRuntime).not.toHaveBeenCalled();
  });

  it("stops startup while client factory initialization is pending", async () => {
    const controller = new AbortController();
    const cleanup = vi.fn();
    const openDedupeConnection = vi.fn();
    let markFactoryStarted = (): void => undefined;
    const factoryStarted = new Promise<void>((resolve) => {
      markFactoryStarted = resolve;
    });
    const running = runHermesReminderProcess(enabledEnvironment, controller.signal, {
      importModule: async () => ({
        createHermesDeliveryClient: async (signal: AbortSignal) => {
          markFactoryStarted();
          return await new Promise<ManagedHermesDeliveryClient>((_resolve, reject) => {
            const handle = setInterval(() => undefined, 1_000);
            signal.addEventListener(
              "abort",
              () => {
                clearInterval(handle);
                cleanup();
                reject(new Error("private factory abort"));
              },
              { once: true },
            );
          });
        },
      }),
      openDedupeConnection,
    });

    await factoryStarted;
    controller.abort("shutdown requested");

    await expect(running).resolves.toBeUndefined();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(openDedupeConnection).not.toHaveBeenCalled();
  });

  it("serves real disabled liveness without becoming ready", async () => {
    const port = await unusedLoopbackPort();
    const controller = new AbortController();
    const running = runHermesReminderProcess(
      { HERMES_REMINDER_HEALTH_PORT: String(port) },
      controller.signal,
    );

    try {
      let live: Response | undefined;
      for (let attempt = 0; attempt < 100 && live === undefined; attempt += 1) {
        try {
          live = await fetch(`http://127.0.0.1:${String(port)}/health/live`);
        } catch {
          await delay(10);
        }
      }
      expect(live?.status).toBe(200);
      expect(await live?.json()).toEqual({ status: "alive" });
      const ready = await fetch(`http://127.0.0.1:${String(port)}/health/ready`);
      expect(ready.status).toBe(503);
      expect(await ready.json()).toEqual({ status: "not_ready" });
    } finally {
      controller.abort("test complete");
      await running;
    }
  });

  it("runs disabled loopback health without opening provider or database dependencies", async () => {
    const importModule = vi.fn();
    const openDedupeConnection = vi.fn();
    const runRuntime: NonNullable<HermesReminderProcessDependencies["runRuntime"]> = vi.fn(
      async (options) => {
        expect(options.healthPort).toBe(9_465);
        expect(options.healthHost).toBe("127.0.0.1");
      },
    );

    await runHermesReminderProcess({}, new AbortController().signal, {
      importModule,
      openDedupeConnection,
      runRuntime,
    });
    expect(importModule).not.toHaveBeenCalled();
    expect(openDedupeConnection).not.toHaveBeenCalled();
    expect(runRuntime).toHaveBeenCalledOnce();
  });

  it("wires explicit enabled dependencies and always closes the client and database", async () => {
    const closeClient = vi.fn(async () => undefined);
    const closeDatabase = vi.fn(async () => undefined);
    const importModule = vi.fn(async () => ({
      createHermesDeliveryClient: (_signal: AbortSignal) => ({ ...client, close: closeClient }),
    }));
    const openDedupeConnection = vi.fn(() => ({ sql: {} as Sql, close: closeDatabase }));
    const runRuntime: NonNullable<HermesReminderProcessDependencies["runRuntime"]> = vi.fn(
      async (options) => {
        expect(options.healthPort).toBe(9_465);
        expect(options.healthHost).toBe("127.0.0.1");
      },
    );

    await runHermesReminderProcess(enabledEnvironment, new AbortController().signal, {
      importModule,
      openDedupeConnection,
      runRuntime,
    });

    expect(importModule).toHaveBeenCalledOnce();
    expect(openDedupeConnection).toHaveBeenCalledWith(
      enabledEnvironment.HERMES_REMINDER_DEDUPE_DATABASE_URL,
    );
    expect(runRuntime).toHaveBeenCalledOnce();
    expect(closeClient).toHaveBeenCalledOnce();
    expect(closeDatabase).toHaveBeenCalledOnce();
  });

  it("closes the client when database initialization fails", async () => {
    const closeClient = vi.fn(async () => undefined);
    const failure = await runHermesReminderProcess(
      enabledEnvironment,
      new AbortController().signal,
      {
        importModule: async () => ({
          createHermesDeliveryClient: (_signal: AbortSignal) => ({ ...client, close: closeClient }),
        }),
        openDedupeConnection: () => {
          throw new Error("private database initialization failure");
        },
      },
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(HermesReminderProcessError);
    expect((failure as HermesReminderProcessError).code).toBe(
      "dedupe_database_initialization_failed",
    );
    expect(String(failure)).not.toContain("private database");
    expect(closeClient).toHaveBeenCalledOnce();
  });

  it("preserves a runtime failure while closing its database", async () => {
    const failure = new Error("private runtime failure");
    const close = vi.fn(async () => undefined);

    await expect(
      runHermesReminderProcess(enabledEnvironment, new AbortController().signal, {
        importModule: async () => ({
          createHermesDeliveryClient: (_signal: AbortSignal) => client,
        }),
        openDedupeConnection: () => ({ sql: {} as Sql, close }),
        runRuntime: async () => Promise.reject(failure),
      }),
    ).rejects.toBe(failure);
    expect(close).toHaveBeenCalledOnce();
  });
});
