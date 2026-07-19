import { isIP } from "node:net";

import cors from "@fastify/cors";
import Fastify, { type FastifyInstance, type FastifyServerOptions } from "fastify";

import { installErrorHandler } from "./http-errors.js";
import {
  registerProductRoutes,
  NATURAL_LANGUAGE_PROPOSAL_CANCELLATION_ROUTE,
  NATURAL_LANGUAGE_PROPOSAL_CONFIRMATION_ROUTE,
  NATURAL_LANGUAGE_PROPOSAL_ITEM_ROUTE,
  NATURAL_LANGUAGE_PROPOSAL_ROUTE,
  SCHEDULING_ADVICE_ROUTE,
  installIpRateLimit,
  type ProductApiLimits,
  type ProductServices,
} from "./product-routes.js";
import {
  registerIntegrationRoutes,
  type IntegrationApiLimits,
  type IntegrationServices,
} from "./integration-routes.js";
import {
  registerHostedAuthLifecycle,
  type HostedAuthLifecycleDependencies,
} from "./hosted-auth-lifecycle.js";
import {
  registerHostedWorkItemBoundary,
  type HostedWorkItemServices,
} from "./hosted-work-item-routes.js";
import { registerHostedTodayBoundary, type HostedTodayServices } from "./hosted-today-routes.js";
import type { HostedWorkspaceBoundaryDependencies } from "./hosted-auth-boundary.js";
import {
  registerHostedWorkspaceRoutes,
  type HostedWorkspaceServices,
} from "./hosted-workspace-routes.js";
import { registerHostedWebShell, type HostedWebShell } from "./hosted-web-shell.js";
import type { DesktopProductAuthenticator } from "./desktop-product-auth.js";

export interface HostedApiOptions {
  readonly auth: HostedAuthLifecycleDependencies;
  readonly boundary: HostedWorkspaceBoundaryDependencies;
  readonly workspaces: HostedWorkspaceServices;
  readonly workItems: HostedWorkItemServices;
  readonly today: HostedTodayServices;
  readonly webShell?: HostedWebShell;
  readonly requestsPerMinute: number;
}

export interface BuildAppOptions {
  readonly logger?: FastifyServerOptions["logger"];
  /** Exact proxy addresses/CIDRs that may supply forwarded client addresses. */
  readonly trustProxy?: FastifyServerOptions["trustProxy"];
  readonly readinessCheck?: () => Promise<void>;
  readonly productServices?: ProductServices;
  readonly productApiAccess?:
    | Readonly<{ mode: "local_unauthenticated" }>
    | Readonly<{
        mode: "desktop_authenticated";
        authenticator: DesktopProductAuthenticator;
      }>;
  readonly productApiLimits?: ProductApiLimits;
  readonly integrationServices?: IntegrationServices;
  readonly integrationApiLimits?: IntegrationApiLimits;
  readonly hostedApi?: HostedApiOptions;
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
  const productServices = options.productServices;
  const productApiAccess = options.productApiAccess;
  if ((productServices === undefined) !== (productApiAccess === undefined)) {
    throw new TypeError("Product services and their access policy must be configured together.");
  }
  const app = Fastify({
    logger: options.logger ?? false,
    trustProxy: options.trustProxy ?? false,
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
    productEndpointsEnabled: productServices !== undefined,
    integrationEndpointsEnabled: options.integrationServices !== undefined,
    hostedEndpointsEnabled: options.hostedApi !== undefined,
  }));

  const integrationServices = options.integrationServices;
  if (integrationServices !== undefined) {
    await app.register(async (integrationApp) => {
      await registerIntegrationRoutes(
        integrationApp,
        integrationServices,
        options.integrationApiLimits,
      );
    });
  }

  if (productServices !== undefined && productApiAccess !== undefined) {
    await app.register(async (productApp) => {
      productApp.addHook("onRequest", async (request, reply) => {
        if (
          request.routeOptions.url === SCHEDULING_ADVICE_ROUTE ||
          request.routeOptions.url === NATURAL_LANGUAGE_PROPOSAL_ROUTE ||
          request.routeOptions.url === NATURAL_LANGUAGE_PROPOSAL_ITEM_ROUTE ||
          request.routeOptions.url === NATURAL_LANGUAGE_PROPOSAL_CANCELLATION_ROUTE ||
          request.routeOptions.url === NATURAL_LANGUAGE_PROPOSAL_CONFIRMATION_ROUTE
        ) {
          reply.header("cache-control", "no-store");
        }
        if (!isAllowedLocalProductHost(request.headers.host)) {
          return reply.code(403).send({
            error: {
              code: "request.host_not_allowed",
              message: "The request host is not allowed for the local product API.",
            },
            requestId: request.id,
          });
        }
        if (productApiAccess.mode === "local_unauthenticated") return;

        reply.header("cache-control", "no-store");
        if (request.headers.origin !== undefined) {
          return reply.code(403).send({
            error: {
              code: "request.origin_not_allowed",
              message: "Browser-origin requests are not allowed for the desktop product API.",
            },
            requestId: request.id,
          });
        }
        if (productApiAccess.authenticator.verify(request.headers.authorization)) return;
        return reply.code(401).send({
          error: {
            code: "request.authentication_required",
            message: "Desktop product authentication is required.",
          },
          requestId: request.id,
        });
      });
      await registerProductRoutes(productApp, productServices, options.productApiLimits);
    });
  }

  if (options.hostedApi !== undefined) {
    if (options.hostedApi.webShell !== undefined) {
      await registerHostedWebShell(app, options.hostedApi.webShell);
    }
    await app.register(async (hostedApp) => {
      installIpRateLimit(hostedApp, options.hostedApi!.requestsPerMinute);
      await registerHostedAuthLifecycle(hostedApp, options.hostedApi!.auth);
      await registerHostedWorkspaceRoutes(
        hostedApp,
        options.hostedApi!.boundary,
        options.hostedApi!.workspaces,
      );
      await registerHostedWorkItemBoundary(
        hostedApp,
        options.hostedApi!.boundary,
        options.hostedApi!.workItems,
      );
      await registerHostedTodayBoundary(
        hostedApp,
        options.hostedApi!.boundary,
        options.hostedApi!.today,
      );
    });
  }

  return app;
}
