import cors from "@fastify/cors";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";

import { installErrorHandler } from "./http-errors.js";
import {
  registerProductRoutes,
  type ProductApiLimits,
  type ProductServices,
} from "./product-routes.js";

export interface BuildAppOptions {
  readonly logger?: FastifyServerOptions["logger"];
  readonly readinessCheck?: () => Promise<void>;
  readonly productServices?: ProductServices;
  readonly productApiLimits?: ProductApiLimits;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 256 * 1024,
    connectionTimeout: 10_000,
    requestTimeout: 15_000,
  });
  const readinessCheck = options.readinessCheck ?? (async () => undefined);

  await app.register(cors, {
    origin: false,
  });
  installErrorHandler(app);

  app.get("/health/live", async () => ({ status: "alive" }));

  app.get("/health/ready", async (_request, reply) => {
    try {
      await readinessCheck();
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "not_ready" });
    }
  });

  app.get("/v1/system/info", async () => ({
    service: "schedule-api",
    version: "0.1.0",
    architecture: "modular-monolith",
    productEndpointsEnabled: options.productServices !== undefined,
  }));

  if (options.productServices !== undefined) {
    await app.register(async (productApp) => {
      await registerProductRoutes(
        productApp,
        options.productServices as ProductServices,
        options.productApiLimits,
      );
    });
  }

  return app;
}
