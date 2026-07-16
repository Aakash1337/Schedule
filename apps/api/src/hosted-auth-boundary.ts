import {
  type BrowserSessionPrincipal,
  type HostedWorkspaceAuthorization,
} from "@schedule/application";
import { DomainError, workspaceId, type WorkspaceId } from "@schedule/domain";
import type { FastifyInstance, FastifyRequest, onSendHookHandler } from "fastify";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const WORKSPACE_PARAMETER_SEGMENT = /(?:^|\/):workspaceId(?:\/|$)/u;
const enforcePrivateCaching: onSendHookHandler = (_request, reply, payload, done) => {
  reply.header("cache-control", "no-store");
  done(null, payload);
};

export interface HostedRequestAuthenticator {
  /** Transport parsing and session resolution stay behind this port. */
  authenticate(request: FastifyRequest): Promise<BrowserSessionPrincipal | null>;
}

export interface HostedRequestCsrfGuard {
  /** Safe methods pass; unsafe browser requests require the configured Origin and CSRF proof. */
  verify(request: FastifyRequest): Promise<boolean> | boolean;
}

export interface HostedPrincipalBoundaryDependencies {
  readonly authenticator: HostedRequestAuthenticator;
  readonly csrfGuard: HostedRequestCsrfGuard;
}

export interface HostedPrincipalRequestAccess {
  /** Available only after this boundary has authenticated the request. */
  principal(
    request: FastifyRequest,
  ): Readonly<Pick<BrowserSessionPrincipal, "userId" | "sessionId">>;
}

export type HostedPrincipalRouteRegistrar = (
  app: FastifyInstance,
  access: HostedPrincipalRequestAccess,
) => Promise<void> | void;

export interface HostedWorkspaceAuthorizer {
  execute(
    principal: Pick<BrowserSessionPrincipal, "userId" | "sessionId">,
    workspaceId: WorkspaceId,
  ): Promise<HostedWorkspaceAuthorization | null>;
}

export interface HostedWorkspaceRequestAccess {
  /** Available only after this boundary has authenticated and authorized the request. */
  authorization(request: FastifyRequest): HostedWorkspaceAuthorization;
}

export interface HostedWorkspaceBoundaryDependencies extends HostedPrincipalBoundaryDependencies {
  readonly authorizer: HostedWorkspaceAuthorizer;
}

export type HostedWorkspaceRouteRegistrar = (
  app: FastifyInstance,
  access: HostedWorkspaceRequestAccess,
) => Promise<void> | void;

export async function withHostedWorkspaceNotFoundRedacted<Result>(
  operation: () => Promise<Result>,
): Promise<Result> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof DomainError && error.code === "workspace.not_found") {
      throw new DomainError("workspace.not_found", "The requested workspace does not exist.");
    }
    throw error;
  }
}

function workspaceFromRequest(request: FastifyRequest): WorkspaceId | null {
  if (typeof request.params !== "object" || request.params === null) return null;
  const value = (request.params as Record<string, unknown>).workspaceId;
  return typeof value === "string" && UUID_PATTERN.test(value)
    ? workspaceId(value.toLowerCase())
    : null;
}

function principalIsWellFormed(
  principal: BrowserSessionPrincipal | null,
): principal is BrowserSessionPrincipal {
  return (
    principal !== null &&
    UUID_PATTERN.test(principal.userId) &&
    UUID_PATTERN.test(principal.sessionId)
  );
}

function publicFailure(
  request: FastifyRequest,
  status: 401 | 403 | 404 | 503,
): {
  readonly error: { readonly code: string; readonly message: string };
  readonly requestId: string;
} {
  if (status === 401) {
    return {
      error: { code: "hosted.authentication_failed", message: "Authentication failed." },
      requestId: request.id,
    };
  }
  if (status === 403) {
    return {
      error: { code: "hosted.csrf_failed", message: "Request verification failed." },
      requestId: request.id,
    };
  }
  if (status === 404) {
    return {
      error: { code: "workspace.not_found", message: "The requested workspace does not exist." },
      requestId: request.id,
    };
  }
  return {
    error: {
      code: "hosted.authorization_unavailable",
      message: "Hosted authorization is temporarily unavailable.",
    },
    requestId: request.id,
  };
}

/** Authenticates hosted routes without exposing transport or session details to handlers. */
export async function registerHostedPrincipalBoundary(
  app: FastifyInstance,
  dependencies: HostedPrincipalBoundaryDependencies,
  registerRoutes: HostedPrincipalRouteRegistrar,
): Promise<void> {
  await app.register(async (hostedApp) => {
    const principalByRequest = new WeakMap<
      FastifyRequest,
      Readonly<Pick<BrowserSessionPrincipal, "userId" | "sessionId">>
    >();
    const access: HostedPrincipalRequestAccess = Object.freeze({
      principal(request: FastifyRequest) {
        const principal = principalByRequest.get(request);
        if (principal === undefined) {
          throw new Error("Hosted principal is unavailable for this request.");
        }
        return principal;
      },
    });

    hostedApp.addHook("onRoute", (route) => {
      const existing = route.onSend;
      route.onSend =
        existing === undefined
          ? enforcePrivateCaching
          : Array.isArray(existing)
            ? [...existing, enforcePrivateCaching]
            : [existing, enforcePrivateCaching];
    });

    hostedApp.addHook("onRequest", async (request, reply) => {
      reply.header("cache-control", "no-store");
      try {
        if ((await dependencies.csrfGuard.verify(request)) !== true) {
          return reply.code(403).send(publicFailure(request, 403));
        }
      } catch {
        request.log.error("hosted request verification failed internally");
        return reply.code(503).send(publicFailure(request, 503));
      }

      let principal: BrowserSessionPrincipal | null;
      try {
        principal = await dependencies.authenticator.authenticate(request);
      } catch {
        request.log.error("hosted request authentication failed internally");
        return reply.code(503).send(publicFailure(request, 503));
      }
      if (!principalIsWellFormed(principal)) {
        return reply.code(401).send(publicFailure(request, 401));
      }
      principalByRequest.set(
        request,
        Object.freeze({ userId: principal.userId, sessionId: principal.sessionId }),
      );
    });

    await registerRoutes(hostedApp, access);
  });
}

/**
 * Adds exact workspace membership authorization to the hosted principal boundary. The production
 * app installs it only when the explicit hosted OIDC runtime gate succeeds.
 */
export async function registerHostedWorkspaceBoundary(
  app: FastifyInstance,
  dependencies: HostedWorkspaceBoundaryDependencies,
  registerRoutes: HostedWorkspaceRouteRegistrar,
): Promise<void> {
  await registerHostedPrincipalBoundary(app, dependencies, async (hostedApp, principalAccess) => {
    const authorizationByRequest = new WeakMap<FastifyRequest, HostedWorkspaceAuthorization>();
    const access: HostedWorkspaceRequestAccess = Object.freeze({
      authorization(request: FastifyRequest): HostedWorkspaceAuthorization {
        const authorization = authorizationByRequest.get(request);
        if (authorization === undefined) {
          throw new Error("Hosted workspace authorization is unavailable for this request.");
        }
        return authorization;
      },
    });

    hostedApp.addHook("onRoute", (route) => {
      if (!WORKSPACE_PARAMETER_SEGMENT.test(route.url)) {
        throw new Error("Every hosted workspace route must include a :workspaceId parameter.");
      }
    });

    hostedApp.addHook("onRequest", async (request, reply) => {
      const principal = principalAccess.principal(request);

      const requestedWorkspace = workspaceFromRequest(request);
      if (requestedWorkspace === null) {
        return reply.code(404).send(publicFailure(request, 404));
      }

      try {
        const authorization = await dependencies.authorizer.execute(
          Object.freeze({ userId: principal.userId, sessionId: principal.sessionId }),
          requestedWorkspace,
        );
        if (authorization === null) {
          return reply.code(404).send(publicFailure(request, 404));
        }
        if (
          authorization.userId !== principal.userId ||
          authorization.sessionId !== principal.sessionId ||
          authorization.workspaceId !== requestedWorkspace
        ) {
          request.log.error("hosted workspace authorizer returned an inconsistent context");
          return reply.code(503).send(publicFailure(request, 503));
        }
        authorizationByRequest.set(request, Object.freeze({ ...authorization }));
      } catch {
        request.log.error("hosted workspace authorization failed internally");
        return reply.code(503).send(publicFailure(request, 503));
      }
    });

    await registerRoutes(hostedApp, access);
  });
}
