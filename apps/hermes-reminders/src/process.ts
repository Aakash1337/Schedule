import path from "node:path";
import { pathToFileURL } from "node:url";

import postgres, { type Sql } from "postgres";
import { z } from "zod";

import { HermesReminderRunner } from "./delivery-runner.js";
import { HermesWhatsAppTransport, type HermesDeliveryClient } from "./hermes-whatsapp-transport.js";
import { PostgresDeliveryDedupeStore } from "./postgres-dedupe-store.js";
import { runHermesReminderRuntime } from "./runtime.js";
import { HttpScheduleDeliveryGateway } from "./schedule-client.js";
import { HermesReminderSupervisor } from "./supervisor.js";

const DEFAULT_CLIENT_INITIALIZATION_TIMEOUT_MS = 30_000;

const commonConfigSchema = z.object({
  HERMES_REMINDER_PROCESS_MODE: z.enum(["disabled", "enabled"]).default("disabled"),
  HERMES_REMINDER_HEALTH_HOST: z.enum(["127.0.0.1", "::1"]).default("127.0.0.1"),
  HERMES_REMINDER_HEALTH_PORT: z.coerce.number().int().min(1).max(65_535).default(9_465),
});

function validClientModulePath(value: string): boolean {
  if (!path.isAbsolute(value) || /^[\\/]{2}/u.test(value)) return false;
  if (process.platform === "win32" && !/^[a-z]:[\\/]/iu.test(value)) return false;
  return [".js", ".mjs"].includes(path.extname(value));
}

const enabledConfigSchema = commonConfigSchema.extend({
  HERMES_REMINDER_SCHEDULE_URL: z.string().min(1).max(2_048),
  HERMES_REMINDER_SCHEDULE_TOKEN: z.string().min(40).max(512).regex(/^\S+$/u),
  HERMES_REMINDER_DEDUPE_DATABASE_URL: z.string().min(1).max(2_048),
  HERMES_REMINDER_CLIENT_MODULE: z.string().min(1).max(2_048).refine(validClientModulePath),
  HERMES_REMINDER_CLIENT_INITIALIZATION_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .min(100)
    .max(120_000)
    .default(DEFAULT_CLIENT_INITIALIZATION_TIMEOUT_MS),
});

type CommonConfig = z.infer<typeof commonConfigSchema>;

export type HermesReminderProcessConfig =
  | (CommonConfig & { readonly HERMES_REMINDER_PROCESS_MODE: "disabled" })
  | (z.infer<typeof enabledConfigSchema> & {
      readonly HERMES_REMINDER_PROCESS_MODE: "enabled";
    });

export type HermesReminderProcessErrorCode =
  | "configuration_invalid"
  | "client_module_unavailable"
  | "client_factory_invalid"
  | "client_initialization_failed"
  | "client_initialization_timed_out"
  | "startup_aborted"
  | "dedupe_database_initialization_failed";

/** Fixed bootstrap failure. Environment values and imported-module errors are never retained. */
export class HermesReminderProcessError extends Error {
  override readonly name = "HermesReminderProcessError";

  constructor(readonly code: HermesReminderProcessErrorCode) {
    super(`Hermes reminder process failed: ${code}.`);
  }
}

type ImportModule = (specifier: string) => Promise<unknown>;

export interface HermesDeliveryClientLoadOptions {
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
  readonly importModule?: ImportModule;
}

export interface ManagedHermesDeliveryClient extends HermesDeliveryClient {
  close(): Promise<void>;
}

export interface HermesReminderDedupeConnection {
  readonly sql: Sql;
  close(): Promise<void>;
}

export interface HermesReminderProcessDependencies {
  readonly importModule?: ImportModule;
  readonly openDedupeConnection?: (databaseUrl: string) => HermesReminderDedupeConnection;
  readonly runRuntime?: typeof runHermesReminderRuntime;
}

interface HermesReminderProcessRuntime {
  run(signal: AbortSignal): Promise<void>;
  close(): Promise<void>;
}

function invalidConfiguration(): never {
  throw new HermesReminderProcessError("configuration_invalid");
}

function validPostgresUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      (url.protocol === "postgres:" || url.protocol === "postgresql:") &&
      url.pathname.length > 1 &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

export function loadHermesReminderProcessConfig(
  environment: NodeJS.ProcessEnv = process.env,
): HermesReminderProcessConfig {
  const common = commonConfigSchema.safeParse(environment);
  if (!common.success) return invalidConfiguration();
  if (common.data.HERMES_REMINDER_PROCESS_MODE === "disabled") {
    return Object.freeze({
      ...common.data,
      HERMES_REMINDER_PROCESS_MODE: "disabled" as const,
    });
  }

  const enabled = enabledConfigSchema.safeParse(environment);
  if (!enabled.success || !validPostgresUrl(enabled.data.HERMES_REMINDER_DEDUPE_DATABASE_URL)) {
    return invalidConfiguration();
  }
  try {
    new HttpScheduleDeliveryGateway(
      enabled.data.HERMES_REMINDER_SCHEDULE_URL,
      enabled.data.HERMES_REMINDER_SCHEDULE_TOKEN,
    );
  } catch {
    return invalidConfiguration();
  }
  return Object.freeze({ ...enabled.data, HERMES_REMINDER_PROCESS_MODE: "enabled" as const });
}

function isDeliveryClient(value: unknown): value is ManagedHermesDeliveryClient {
  try {
    return (
      typeof value === "object" &&
      value !== null &&
      typeof (value as Partial<HermesDeliveryClient>).reconcile === "function" &&
      typeof (value as Partial<HermesDeliveryClient>).send === "function" &&
      typeof (value as Partial<ManagedHermesDeliveryClient>).close === "function"
    );
  } catch {
    return false;
  }
}

function startupAborted(): HermesReminderProcessError {
  return new HermesReminderProcessError("startup_aborted");
}

async function withClientInitializationBoundary<T>(
  signal: AbortSignal,
  timeoutMs: number,
  initialize: (initializationSignal: AbortSignal) => Promise<T>,
  closeLateValue: (value: T) => Promise<void>,
): Promise<T> {
  if (signal.aborted) throw startupAborted();

  const initializationController = new AbortController();
  let boundarySettled = false;
  let abort = (): void => undefined;
  let timeout: NodeJS.Timeout | undefined;
  const boundary = new Promise<never>((_, reject) => {
    abort = () => {
      if (boundarySettled) return;
      boundarySettled = true;
      reject(startupAborted());
      initializationController.abort();
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      abort();
      return;
    }
    timeout = setTimeout(() => {
      if (boundarySettled) return;
      boundarySettled = true;
      reject(new HermesReminderProcessError("client_initialization_timed_out"));
      initializationController.abort();
    }, timeoutMs);
  });
  const initialization = Promise.resolve().then(async () => {
    if (initializationController.signal.aborted) throw startupAborted();
    return await initialize(initializationController.signal);
  });
  void initialization.then(
    async (value) => {
      if (!boundarySettled) return;
      try {
        await closeLateValue(value);
      } catch {
        // A late trusted client cannot replace the fixed startup failure.
      }
    },
    () => undefined,
  );

  try {
    return await Promise.race([initialization, boundary]);
  } finally {
    signal.removeEventListener("abort", abort);
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export async function loadHermesDeliveryClient(
  modulePath: string,
  options: HermesDeliveryClientLoadOptions,
): Promise<ManagedHermesDeliveryClient> {
  if (!validClientModulePath(modulePath)) {
    throw new HermesReminderProcessError("client_factory_invalid");
  }
  const importModule = options.importModule ?? (async (specifier) => await import(specifier));
  return await withClientInitializationBoundary(
    options.signal,
    options.timeoutMs,
    async (initializationSignal) => {
      let imported: unknown;
      try {
        imported = await importModule(pathToFileURL(modulePath).href);
      } catch {
        throw new HermesReminderProcessError("client_module_unavailable");
      }
      let factory: unknown;
      try {
        factory = (imported as { readonly createHermesDeliveryClient?: unknown })
          ?.createHermesDeliveryClient;
      } catch {
        throw new HermesReminderProcessError("client_factory_invalid");
      }
      if (typeof factory !== "function" || factory.length !== 1) {
        throw new HermesReminderProcessError("client_factory_invalid");
      }
      if (initializationSignal.aborted) throw startupAborted();

      let client: unknown;
      try {
        client = await Reflect.apply(factory, undefined, [initializationSignal]);
      } catch {
        throw new HermesReminderProcessError("client_initialization_failed");
      }
      if (!isDeliveryClient(client)) {
        throw new HermesReminderProcessError("client_factory_invalid");
      }
      return client;
    },
    async (client) => await client.close(),
  );
}

function openDedupeConnection(databaseUrl: string): HermesReminderDedupeConnection {
  const sql = postgres(databaseUrl, {
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false,
    connection: { application_name: "schedule-hermes-reminders" },
  });
  return { sql, close: async () => await sql.end({ timeout: 5 }) };
}

async function closeHermesProcessResources(
  client: ManagedHermesDeliveryClient,
  connection?: HermesReminderDedupeConnection,
): Promise<void> {
  const results = await Promise.allSettled([
    Promise.resolve().then(async () => await client.close()),
    ...(connection === undefined
      ? []
      : [Promise.resolve().then(async () => await connection.close())]),
  ]);
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "Hermes client and database shutdown both failed.");
  }
}

async function createHermesReminderProcessRuntime(
  config: HermesReminderProcessConfig,
  signal: AbortSignal,
  dependencies: HermesReminderProcessDependencies,
): Promise<HermesReminderProcessRuntime> {
  const runRuntime = dependencies.runRuntime ?? runHermesReminderRuntime;
  if (config.HERMES_REMINDER_PROCESS_MODE === "disabled") {
    const supervisor = new HermesReminderSupervisor(
      { runOnce: async () => ({ status: "idle" }) },
      { enabled: () => false },
    );
    return {
      run: async (signal) =>
        await runRuntime(
          {
            supervisor,
            healthPort: config.HERMES_REMINDER_HEALTH_PORT,
            healthHost: config.HERMES_REMINDER_HEALTH_HOST,
          },
          signal,
        ),
      close: async () => undefined,
    };
  }

  const client = await loadHermesDeliveryClient(config.HERMES_REMINDER_CLIENT_MODULE, {
    signal,
    timeoutMs: config.HERMES_REMINDER_CLIENT_INITIALIZATION_TIMEOUT_MS,
    ...(dependencies.importModule === undefined ? {} : { importModule: dependencies.importModule }),
  });
  let connection: HermesReminderDedupeConnection | undefined;
  try {
    if (signal.aborted) throw startupAborted();
    const gateway = new HttpScheduleDeliveryGateway(
      config.HERMES_REMINDER_SCHEDULE_URL,
      config.HERMES_REMINDER_SCHEDULE_TOKEN,
    );
    if (signal.aborted) throw startupAborted();
    try {
      connection = (dependencies.openDedupeConnection ?? openDedupeConnection)(
        config.HERMES_REMINDER_DEDUPE_DATABASE_URL,
      );
    } catch {
      throw new HermesReminderProcessError("dedupe_database_initialization_failed");
    }
    const supervisor = new HermesReminderSupervisor(
      new HermesReminderRunner(
        gateway,
        new PostgresDeliveryDedupeStore(connection.sql),
        new HermesWhatsAppTransport(client),
      ),
      { enabled: () => true },
    );
    return {
      run: async (signal) =>
        await runRuntime(
          {
            supervisor,
            healthPort: config.HERMES_REMINDER_HEALTH_PORT,
            healthHost: config.HERMES_REMINDER_HEALTH_HOST,
          },
          signal,
        ),
      close: async () => await closeHermesProcessResources(client, connection),
    };
  } catch (error) {
    try {
      await closeHermesProcessResources(client, connection);
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Hermes process composition and cleanup both failed.",
        { cause: cleanupError },
      );
    }
    throw error;
  }
}

export async function runHermesReminderProcess(
  environment: NodeJS.ProcessEnv,
  signal: AbortSignal,
  dependencies: HermesReminderProcessDependencies = {},
): Promise<void> {
  if (signal.aborted) return;

  let runtime: HermesReminderProcessRuntime;
  try {
    runtime = await createHermesReminderProcessRuntime(
      loadHermesReminderProcessConfig(environment),
      signal,
      dependencies,
    );
  } catch (error) {
    if (
      signal.aborted &&
      error instanceof HermesReminderProcessError &&
      error.code === "startup_aborted"
    ) {
      return;
    }
    throw error;
  }
  let failure: unknown;
  try {
    await runtime.run(signal);
  } catch (error) {
    failure = error;
  }
  try {
    await runtime.close();
  } catch (error) {
    failure =
      failure === undefined
        ? error
        : new AggregateError([failure, error], "Hermes runtime and shutdown both failed.");
  }
  if (failure !== undefined) throw failure;
}
