import {
  type BrowserSessionPrincipal,
  type HostedWorkspaceAuthorization,
} from "@schedule/application";
import { workspaceId, type WorkspaceId } from "@schedule/domain";
import type { FastifyInstance, FastifyRequest } from "fastify";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const WORKSPACE_PARAMETER_SEGMENT = /(?:^|\/):workspaceId(?:\/|$)/u;

export interface HostedRequestAuthenticator {
  /** Transport parsing and session resolution stay behind this port. */
  authenticate(request: FastifyRequest): Promise<BrowserSessionPrincipal | null>;
}

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

export interface HostedWorkspaceBoundaryDependencies {
  readonly authenticator: HostedRequestAuthenticator;
  readonly authorizer: HostedWorkspaceAuthorizer;
}

export type HostedWorkspaceRouteRegistrar = (
  app: FastifyInstance,
  access: HostedWorkspaceRequestAccess,
) => Promise<void> | void;

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
  status: 401 | 404 | 503,
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

/**
 * Encapsulates future hosted workspace routes behind one deny-by-default boundary. This function
 * is intentionally not wired into buildApp: defining the seam must not expose a production route.
 */
export async function registerHostedWorkspaceBoundary(
  app: FastifyInstance,
  dependencies: HostedWorkspaceBoundaryDependencies,
  registerRoutes: HostedWorkspaceRouteRegistrar,
): Promise<void> {
  await app.register(async (hostedApp) => {
    const authenticationByRequest = new WeakMap<
      FastifyRequest,
      Promise<BrowserSessionPrincipal | null>
    >();
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
      reply.header("cache-control", "no-store");
      let authentication = authenticationByRequest.get(request);
      if (authentication === undefined) {
        authentication = Promise.resolve().then(() =>
          dependencies.authenticator.authenticate(request),
        );
        authenticationByRequest.set(request, authentication);
      }

      let principal: BrowserSessionPrincipal | null;
      try {
        principal = await authentication;
      } catch {
        request.log.error("hosted request authentication failed internally");
        return reply.code(503).send(publicFailure(request, 503));
      }
      if (!principalIsWellFormed(principal)) {
        return reply.code(401).send(publicFailure(request, 401));
      }

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

    hostedApp.addHook("onSend", async (_request, reply, payload) => {
      // A route or later hook must not weaken the private-response cache policy.
      reply.header("cache-control", "no-store");
      return payload;
    });

    await registerRoutes(hostedApp, access);
  });
}
