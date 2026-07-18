import path from "node:path";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

import type { Sql } from "postgres";

import type { HermesDeliveryClient } from "./hermes-whatsapp-transport.js";
import {
  HermesReminderProcessError,
  loadHermesDeliveryClient,
  loadHermesReminderProcessConfig,
  runHermesReminderProcess,
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

const client: HermesDeliveryClient = {
  reconcile: async () => ({ outcome: "not_found" }),
  send: async () => ({ outcome: "accepted" }),
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
    const factory = vi.fn(async () => client);
    const importModule = vi.fn(async () => ({ createHermesDeliveryClient: factory }));

    await expect(loadHermesDeliveryClient(modulePath, importModule)).resolves.toBe(client);
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
      importer: async () => ({ createHermesDeliveryClient: (_required: unknown) => client }),
    },
    {
      code: "client_initialization_failed",
      importer: async () => ({
        createHermesDeliveryClient: () => {
          throw new Error("private provider factory error");
        },
      }),
    },
    {
      code: "client_factory_invalid",
      importer: async () => ({ createHermesDeliveryClient: () => ({ send: async () => ({}) }) }),
    },
  ] as const)("redacts $code module failures", async ({ code, importer }) => {
    const failure = await loadHermesDeliveryClient(modulePath, importer).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(HermesReminderProcessError);
    expect((failure as HermesReminderProcessError).code).toBe(code);
    expect(String(failure)).not.toContain("private provider");
  });
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

  it("wires explicit enabled dependencies and always closes the dedupe connection", async () => {
    const close = vi.fn(async () => undefined);
    const importModule = vi.fn(async () => ({ createHermesDeliveryClient: () => client }));
    const openDedupeConnection = vi.fn(() => ({ sql: {} as Sql, close }));
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
    expect(close).toHaveBeenCalledOnce();
  });

  it("preserves a runtime failure while closing its database", async () => {
    const failure = new Error("private runtime failure");
    const close = vi.fn(async () => undefined);

    await expect(
      runHermesReminderProcess(enabledEnvironment, new AbortController().signal, {
        importModule: async () => ({ createHermesDeliveryClient: () => client }),
        openDedupeConnection: () => ({ sql: {} as Sql, close }),
        runRuntime: async () => Promise.reject(failure),
      }),
    ).rejects.toBe(failure);
    expect(close).toHaveBeenCalledOnce();
  });
});
