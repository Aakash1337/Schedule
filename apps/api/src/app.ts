import { isIP } from "node:net";

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

function validOptionalPort(value: string): boolean {
  if (value === "") return true;
  if (!/^:\d{1,5}$/.test(value)) return false;
  const port = Number(value.slice(1));
  return port >= 1 && port <= 65_535;
}

function isIpv6Loopback(value: string): boolean {
  if (isIP(value) !== 6) return false;
  try {
    return new URL(`http://[${value}]/`).hostname === "[::1]";
  } catch {
    return false;
  }
}

/**
 * Protect the unauthenticated loopback API from DNS rebinding. Host is an
 * HTTP authority, so IPv6 literals must be bracketed and any port must be a
 * valid TCP port.
 */
export function isAllowedLocalProductHost(host: string | undefined): boolean {
  if (host === undefined || host.length === 0 || host !== host.trim() || host.length > 255) {
    return false;
  }

  if (host.startsWith("[")) {
    const closingBracket = host.indexOf("]");
    if (closingBracket < 0) return false;
    const address = host.slice(1, closingBracket);
    const port = host.slice(closingBracket + 1);
    return isIpv6Loopback(address) && validOptionalPort(port);
  }

  if (host.includes("[") || host.includes("]")) return false;
  const firstColon = host.indexOf(":");
  const lastColon = host.lastIndexOf(":");
  if (firstColon !== lastColon) return false;

  const hostname = (firstColon < 0 ? host : host.slice(0, firstColon)).toLowerCase();
  const port = firstColon < 0 ? "" : host.slice(firstColon);
  if (!validOptionalPort(port)) return false;
  if (hostname === "localhost") return true;
  return isIP(hostname) === 4 && hostname.split(".")[0] === "127";
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
      productApp.addHook("onRequest", async (request, reply) => {
        if (isAllowedLocalProductHost(request.headers.host)) return;
        return reply.code(403).send({
          error: {
            code: "request.host_not_allowed",
            message: "The request host is not allowed for the local product API.",
          },
          requestId: request.id,
        });
      });
      await registerProductRoutes(
        productApp,
        options.productServices as ProductServices,
        options.productApiLimits,
      );
    });
  }

  return app;
}
