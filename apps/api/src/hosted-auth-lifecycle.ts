import type {
  BrowserSessionPrincipal,
  FindOrProvisionHostedUser,
  IssueBrowserSession,
  RevokeBrowserSession,
} from "@schedule/application";
import { MAX_EXTERNAL_IDENTITY_KEY_BYTES } from "@schedule/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest, onSendHookHandler } from "fastify";

import type { HostedRequestAuthenticator, HostedRequestCsrfGuard } from "./hosted-auth-boundary.js";
import {
  clearHostedCsrfCookie,
  clearHostedSessionCookie,
  hostedSessionTokenFromRequest,
  issueHostedCsrfProtection,
  serializeHostedSessionCookie,
} from "./hosted-browser-session.js";

export const HOSTED_LOGIN_ROUTE = "/v1/auth/login";
export const HOSTED_SESSION_ROUTE = "/v1/auth/session";
export const HOSTED_LOGOUT_ROUTE = "/v1/auth/logout";

const MAX_LOGIN_BODY_BYTES = 16 * 1_024;
const MAX_IDENTITY_PROOF_BYTES = 12 * 1_024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

const enforcePrivateCaching: onSendHookHandler = (_request, reply, payload, done) => {
  reply.header("cache-control", "no-store");
  done(null, payload);
};

export interface VerifiedHostedIdentity {
  /** Exact verified provider bytes. The lifecycle never normalizes or derives this value. */
  readonly issuer: string;
  /** Exact verified provider subject. Email, display name, and other claims are not identity keys. */
  readonly subject: string;
}

export interface HostedIdentityProofVerifier {
  /** A provider adapter must validate the proof completely before returning an identity. */
  verify(proof: string): Promise<VerifiedHostedIdentity | null>;
}

interface HostedIdentityProvisioner {
  execute(input: VerifiedHostedIdentity): ReturnType<FindOrProvisionHostedUser["execute"]>;
}

interface HostedBrowserSessionIssuer {
  execute(input: {
    readonly userId: Parameters<IssueBrowserSession["execute"]>[0]["userId"];
    readonly idleTimeoutSeconds: number;
    readonly absoluteTtlSeconds: number;
  }): ReturnType<IssueBrowserSession["execute"]>;
}

interface HostedBrowserSessionRevoker {
  execute(
    token: Parameters<RevokeBrowserSession["execute"]>[0],
    reason?: Parameters<RevokeBrowserSession["execute"]>[1],
  ): ReturnType<RevokeBrowserSession["execute"]>;
}

export interface HostedAuthLifecycleDependencies {
  readonly authenticator: HostedRequestAuthenticator;
  readonly csrfGuard: HostedRequestCsrfGuard;
  readonly identityVerifier: HostedIdentityProofVerifier;
  readonly identityProvisioner: HostedIdentityProvisioner;
  readonly sessionIssuer: HostedBrowserSessionIssuer;
  readonly sessionRevoker: HostedBrowserSessionRevoker;
  readonly sessionPolicy: {
    readonly idleTimeoutSeconds: number;
    readonly absoluteTtlSeconds: number;
  };
}

function publicFailure(
  request: FastifyRequest,
  status: 401 | 403 | 503,
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
  return {
    error: {
      code: "hosted.authentication_unavailable",
      message: "Hosted authentication is temporarily unavailable.",
    },
    requestId: request.id,
  };
}

function loginProof(body: unknown): string | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== "proof") return null;
  const proof = (body as { readonly proof?: unknown }).proof;
  return typeof proof === "string" &&
    proof.length > 0 &&
    Buffer.byteLength(proof, "utf8") <= MAX_IDENTITY_PROOF_BYTES
    ? proof
    : null;
}

function verifiedIdentityIsWellFormed(value: unknown): value is VerifiedHostedIdentity {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<VerifiedHostedIdentity>;
  if (
    typeof candidate.issuer !== "string" ||
    candidate.issuer.length === 0 ||
    candidate.issuer.length > 2_048 ||
    typeof candidate.subject !== "string" ||
    candidate.subject.length === 0 ||
    candidate.subject.length > 512
  ) {
    return false;
  }
  return (
    Buffer.byteLength(candidate.issuer, "utf8") + Buffer.byteLength(candidate.subject, "utf8") <=
    MAX_EXTERNAL_IDENTITY_KEY_BYTES
  );
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

function activeProvisionedUser(
  value: Awaited<ReturnType<FindOrProvisionHostedUser["execute"]>>,
  verifiedIdentity: VerifiedHostedIdentity,
): "active" | "disabled" | "invalid" {
  const user = value?.user;
  const boundIdentity = value?.identity;
  if (
    user === undefined ||
    !UUID_PATTERN.test(user.id) ||
    boundIdentity === undefined ||
    boundIdentity.userId !== user.id ||
    boundIdentity.issuer !== verifiedIdentity.issuer ||
    boundIdentity.subject !== verifiedIdentity.subject
  ) {
    return "invalid";
  }
  return user.status === "active" ? "active" : user.status === "disabled" ? "disabled" : "invalid";
}

function setAuthenticationCookies(reply: FastifyReply, sessionCookie: string): void {
  const csrf = issueHostedCsrfProtection();
  reply.header("set-cookie", [sessionCookie, csrf.setCookie]);
}

/**
 * Defines a complete provider-neutral browser lifecycle without making it reachable. Callers must
 * explicitly register this function; buildApp and the production server intentionally do not.
 */
export async function registerHostedAuthLifecycle(
  app: FastifyInstance,
  dependencies: HostedAuthLifecycleDependencies,
): Promise<void> {
  const sessionPolicy = Object.freeze({ ...dependencies.sessionPolicy });

  await app.register(async (hostedAuth) => {
    hostedAuth.addHook("onSend", enforcePrivateCaching);

    const verifyCsrf = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      try {
        if ((await dependencies.csrfGuard.verify(request)) === true) return;
      } catch {
        request.log.error("hosted authentication request verification failed internally");
        await reply.code(503).send(publicFailure(request, 503));
        return;
      }
      await reply.code(403).send(publicFailure(request, 403));
    };

    hostedAuth.get(HOSTED_SESSION_ROUTE, async (request, reply) => {
      const csrf = issueHostedCsrfProtection();
      reply.header("set-cookie", csrf.setCookie);
      try {
        const principal = await dependencies.authenticator.authenticate(request);
        if (principal === null) return { authenticated: false };
        if (!principalIsWellFormed(principal)) {
          request.log.error("hosted session authenticator returned an inconsistent principal");
          return reply.code(503).send(publicFailure(request, 503));
        }
        return { authenticated: true };
      } catch {
        request.log.error("hosted session authentication failed internally");
        return reply.code(503).send(publicFailure(request, 503));
      }
    });

    hostedAuth.post(
      HOSTED_LOGIN_ROUTE,
      { bodyLimit: MAX_LOGIN_BODY_BYTES, onRequest: verifyCsrf },
      async (request, reply) => {
        const proof = loginProof(request.body);
        if (proof === null) return reply.code(401).send(publicFailure(request, 401));

        let identity: VerifiedHostedIdentity | null;
        try {
          identity = await dependencies.identityVerifier.verify(proof);
        } catch {
          request.log.error("hosted identity proof verification failed internally");
          return reply.code(503).send(publicFailure(request, 503));
        }
        if (identity === null) return reply.code(401).send(publicFailure(request, 401));
        if (!verifiedIdentityIsWellFormed(identity)) {
          request.log.error("hosted identity verifier returned an invalid identity");
          return reply.code(503).send(publicFailure(request, 503));
        }

        try {
          const provisioned = await dependencies.identityProvisioner.execute(identity);
          const userState = activeProvisionedUser(provisioned, identity);
          if (userState === "disabled") {
            return reply.code(401).send(publicFailure(request, 401));
          }
          if (userState === "invalid") {
            request.log.error("hosted identity provisioner returned an invalid user");
            return reply.code(503).send(publicFailure(request, 503));
          }

          const issued = await dependencies.sessionIssuer.execute({
            userId: provisioned.user.id,
            idleTimeoutSeconds: sessionPolicy.idleTimeoutSeconds,
            absoluteTtlSeconds: sessionPolicy.absoluteTtlSeconds,
          });
          setAuthenticationCookies(reply, serializeHostedSessionCookie(issued.token));
          return reply.code(204).send();
        } catch {
          request.log.error("hosted identity provisioning or session issuance failed internally");
          return reply.code(503).send(publicFailure(request, 503));
        }
      },
    );

    hostedAuth.post(HOSTED_LOGOUT_ROUTE, { onRequest: verifyCsrf }, async (request, reply) => {
      reply.header("set-cookie", [clearHostedSessionCookie(), clearHostedCsrfCookie()]);
      const token = hostedSessionTokenFromRequest(request);
      if (token === null) return reply.code(204).send();
      try {
        await dependencies.sessionRevoker.execute(token, "signed_out");
        return reply.code(204).send();
      } catch {
        request.log.error("hosted browser session revocation failed internally");
        return reply.code(503).send(publicFailure(request, 503));
      }
    });
  });
}
