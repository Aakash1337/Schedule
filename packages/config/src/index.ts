import { z } from "zod";

const baseSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DATABASE_URL: z.string().min(1).default("postgres://schedule:schedule@127.0.0.1:5432/schedule"),
});

const apiSchema = baseSchema.extend({
  API_HOST: z.string().min(1).default("127.0.0.1"),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(4_000),
  PRODUCT_API_MODE: z.enum(["disabled", "local_unauthenticated"]).optional(),
});

const workerSchema = baseSchema.extend({
  OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(100).max(60_000).default(1_000),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(500).default(25),
  OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(8),
});

export type ApiConfig = Omit<z.infer<typeof apiSchema>, "PRODUCT_API_MODE"> & {
  readonly PRODUCT_API_MODE: "disabled" | "local_unauthenticated";
};
export type WorkerConfig = z.infer<typeof workerSchema>;

export const loadApiConfig = (environment: NodeJS.ProcessEnv = process.env): ApiConfig => {
  const parsed = apiSchema.parse(environment);
  const config: ApiConfig = {
    ...parsed,
    PRODUCT_API_MODE:
      parsed.PRODUCT_API_MODE ??
      (parsed.NODE_ENV === "production" ? "disabled" : "local_unauthenticated"),
  };
  if (
    config.PRODUCT_API_MODE === "local_unauthenticated" &&
    (config.NODE_ENV === "production" ||
      !["127.0.0.1", "::1", "localhost"].includes(config.API_HOST))
  ) {
    throw new Error(
      "local_unauthenticated product API mode requires a non-production loopback binding.",
    );
  }
  return config;
};

export const loadWorkerConfig = (environment: NodeJS.ProcessEnv = process.env): WorkerConfig =>
  workerSchema.parse(environment);
