import type {
  BrowserSessionPrincipal,
  ConsumeHostedLoginTransaction,
  FindOrProvisionHostedUser,
  IssueBrowserSession,
  RevokeBrowserSession,
  StartHostedLoginTransaction,
} from "@schedule/application";
import { MAX_EXTERNAL_IDENTITY_KEY_BYTES } from "@schedule/domain";
import type { FastifyInstance, FastifyReply, FastifyRequest, onSendHookHandler } from "fastify";

import type { HostedRequestAuthenticator, HostedRequestCsrfGuard } from "./hosted-auth-boundary.js";
import type { HostedAuthTrafficGuard } from "./hosted-auth-ingress.js";
import {
  clearHostedCsrfCookie,
  clearHostedLoginBindingCookie,
  clearHostedSessionCookie,
  hostedLoginBindingFromRequest,
  hostedSessionTokenFromRequest,
  issueHostedCsrfProtection,
  serializeHostedLoginBindingCookie,
  serializeHostedSessionCookie,
} from "./hosted-browser-session.js";
import type { OidcAuthorizationRequestBuilder } from "./oidc-authorization-request.js";
import type { OidcAuthorizationCodeTokenExchanger } from "./oidc-authorization-code-token-exchange.js";
import type { OidcIdTokenVerificationInput } from "./oidc-id-token-verifier.js";

export const HOSTED_LOGIN_ROUTE = "/v1/auth/login";
export const HOSTED_CALLBACK_ROUTE = "/v1/auth/callback";
export const HOSTED_SESSION_ROUTE = "/v1/auth/session";
export const HOSTED_LOGOUT_ROUTE = "/v1/auth/logout";

const MAX_CALLBACK_URL_BYTES = 4 * 1_024;
const OPAQUE_VALUE_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const AUTHORIZATION_CODE_PATTERN = /^[\x21-\x7e]{1,2048}$/u;
const LOCAL_RETURN_PATH_PATTERN = /^\/(?!\/)[^\\#]{0,2047}$/u;
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

export interface HostedOidcIdentityVerifier {
  verify(input: OidcIdTokenVerificationInput): Promise<VerifiedHostedIdentity | null>;
}

interface HostedLoginTransactionStarter {
  execute(
    input: Parameters<StartHostedLoginTransaction["execute"]>[0],
  ): ReturnType<StartHostedLoginTransaction["execute"]>;
}

interface HostedLoginTransactionConsumer {
  execute(
    input: Parameters<ConsumeHostedLoginTransaction["execute"]>[0],
  ): ReturnType<ConsumeHostedLoginTransaction["execute"]>;
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
  readonly loginTransactionStarter: HostedLoginTransactionStarter;
  readonly loginTransactionConsumer: HostedLoginTransactionConsumer;
  readonly authorizationRequestBuilder: OidcAuthorizationRequestBuilder;
  readonly tokenExchanger: OidcAuthorizationCodeTokenExchanger;
  readonly identityVerifier: HostedOidcIdentityVerifier;
  readonly identityProvisioner: HostedIdentityProvisioner;
  readonly sessionIssuer: HostedBrowserSessionIssuer;
  readonly sessionRevoker: HostedBrowserSessionRevoker;
  readonly sessionPolicy: {
    readonly idleTimeoutSeconds: number;
    readonly absoluteTtlSeconds: number;
  };
  readonly loginPolicy: {
    readonly hostedOrigin: string;
    readonly issuer: string;
    readonly clientId: string;
    readonly redirectUri: string;
    readonly returnToPath: string;
    readonly ttlSeconds: number;
  };
}

function publicFailure(
  request: FastifyRequest,
  status: 401 | 403 | 429 | 503,
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
  if (status === 429) {
    return {
      error: { code: "hosted.rate_limit_exceeded", message: "Too many requests." },
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

function containsAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function validLocalReturnPath(value: string): boolean {
  return LOCAL_RETURN_PATH_PATTERN.test(value) && !containsAsciiControl(value);
}

function snapshotLoginPolicy(value: HostedAuthLifecycleDependencies["loginPolicy"]) {
  const policy = Object.freeze({ ...value });
  let origin: URL;
  try {
    origin = new URL(policy.hostedOrigin);
  } catch {
    throw new TypeError("The hosted OIDC login policy is invalid.");
  }
  if (
    origin.protocol !== "https:" ||
    origin.origin !== policy.hostedOrigin ||
    policy.redirectUri !== `${policy.hostedOrigin}${HOSTED_CALLBACK_ROUTE}` ||
    typeof policy.returnToPath !== "string" ||
    !validLocalReturnPath(policy.returnToPath) ||
    !Number.isSafeInteger(policy.ttlSeconds) ||
    policy.ttlSeconds < 60 ||
    policy.ttlSeconds > 900
  ) {
    throw new TypeError("The hosted OIDC login policy is invalid.");
  }
  return policy;
}

function authorizationRedirect(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  return parsed.protocol === "https:" &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.hash === ""
    ? value
    : null;
}

function callbackCredentials(request: FastifyRequest): {
  readonly code: string;
  readonly state: string;
  readonly issuer?: string;
} | null {
  const rawUrl = request.raw.url;
  if (typeof rawUrl !== "string" || Buffer.byteLength(rawUrl, "utf8") > MAX_CALLBACK_URL_BYTES) {
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl, "https://callback.invalid");
  } catch {
    return null;
  }
  if (
    parsed.pathname !== HOSTED_CALLBACK_ROUTE ||
    parsed.searchParams.getAll("code").length !== 1 ||
    parsed.searchParams.getAll("state").length !== 1 ||
    parsed.searchParams.getAll("iss").length > 1 ||
    parsed.searchParams.has("error")
  ) {
    return null;
  }
  const code = parsed.searchParams.get("code") ?? "";
  const state = parsed.searchParams.get("state") ?? "";
  const issuer = parsed.searchParams.get("iss") ?? undefined;
  if (
    !AUTHORIZATION_CODE_PATTERN.test(code) ||
    !OPAQUE_VALUE_PATTERN.test(state) ||
    (issuer !== undefined && (issuer.length === 0 || issuer.length > 2_048))
  ) {
    return null;
  }
  return Object.freeze(issuer === undefined ? { code, state } : { code, state, issuer });
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
  reply.removeHeader("set-cookie");
  reply.header("set-cookie", [sessionCookie, csrf.setCookie, clearHostedLoginBindingCookie()]);
}

/**
 * Defines the provider-neutral browser lifecycle installed only by the explicit hosted OIDC gate.
 */
export async function registerHostedAuthLifecycle(
  app: FastifyInstance,
  dependencies: HostedAuthLifecycleDependencies,
  trafficGuard: HostedAuthTrafficGuard,
): Promise<void> {
  const sessionPolicy = Object.freeze({ ...dependencies.sessionPolicy });
  const loginPolicy = snapshotLoginPolicy(dependencies.loginPolicy);

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

    hostedAuth.post(HOSTED_LOGIN_ROUTE, { onRequest: verifyCsrf }, async (request, reply) => {
      reply.header("referrer-policy", "no-referrer");
      if (request.raw.url !== HOSTED_LOGIN_ROUTE) {
        return reply.code(401).send(publicFailure(request, 401));
      }
      const admission = trafficGuard.admitLoginStart();
      if (!admission.allowed) {
        reply.header("retry-after", String(admission.retryAfterSeconds));
        return reply.code(429).send(publicFailure(request, 429));
      }
      try {
        const transaction = await dependencies.loginTransactionStarter.execute({
          issuer: loginPolicy.issuer,
          clientId: loginPolicy.clientId,
          redirectUri: loginPolicy.redirectUri,
          returnToPath: loginPolicy.returnToPath,
          ttlSeconds: loginPolicy.ttlSeconds,
        });
        const authorization = dependencies.authorizationRequestBuilder.build(transaction);
        const redirect = authorizationRedirect(authorization.url);
        if (redirect === null) {
          throw new TypeError("The hosted authorization redirect is invalid.");
        }
        reply.header(
          "set-cookie",
          serializeHostedLoginBindingCookie(transaction.browserBinding, loginPolicy.ttlSeconds),
        );
        return { authorizationUrl: redirect };
      } catch {
        request.log.error("hosted OIDC authorization start failed internally");
        return reply.code(503).send(publicFailure(request, 503));
      }
    });

    hostedAuth.get(HOSTED_CALLBACK_ROUTE, async (request, reply) => {
      reply.header("referrer-policy", "no-referrer");
      const credentials = callbackCredentials(request);
      const browserBinding = hostedLoginBindingFromRequest(request);
      if (credentials === null || browserBinding === null) {
        reply.header("set-cookie", clearHostedLoginBindingCookie());
        return reply.code(401).send(publicFailure(request, 401));
      }
      const releaseCallback = trafficGuard.enterCallback();
      if (releaseCallback === null) {
        reply.header("retry-after", "1");
        return reply.code(429).send(publicFailure(request, 429));
      }
      reply.header("set-cookie", clearHostedLoginBindingCookie());

      try {
        const transaction = await dependencies.loginTransactionConsumer.execute({
          state: credentials.state,
          browserBinding,
        });
        if (transaction === null) return reply.code(401).send(publicFailure(request, 401));
        if (
          transaction.issuer !== loginPolicy.issuer ||
          transaction.clientId !== loginPolicy.clientId ||
          transaction.redirectUri !== loginPolicy.redirectUri
        ) {
          request.log.error("hosted login transaction returned inconsistent provider binding");
          return reply.code(503).send(publicFailure(request, 503));
        }
        if (credentials.issuer !== undefined && credentials.issuer !== transaction.issuer) {
          return reply.code(401).send(publicFailure(request, 401));
        }
        const returnUrl = new URL(transaction.returnToPath, loginPolicy.hostedOrigin);
        if (
          returnUrl.origin !== loginPolicy.hostedOrigin ||
          !validLocalReturnPath(transaction.returnToPath)
        ) {
          request.log.error("hosted login transaction returned an invalid local continuation");
          return reply.code(503).send(publicFailure(request, 503));
        }

        const exchanged = await dependencies.tokenExchanger.exchange({
          code: credentials.code,
          transaction,
        });
        if (exchanged === null) return reply.code(401).send(publicFailure(request, 401));
        const identity = await dependencies.identityVerifier.verify({
          idToken: exchanged.idToken,
          issuer: transaction.issuer,
          clientId: transaction.clientId,
          expectedNonce: transaction.expectedNonce,
        });
        if (identity === null) return reply.code(401).send(publicFailure(request, 401));
        if (!verifiedIdentityIsWellFormed(identity) || identity.issuer !== transaction.issuer) {
          request.log.error("hosted identity verifier returned an invalid identity");
          return reply.code(503).send(publicFailure(request, 503));
        }

        const provisioned = await dependencies.identityProvisioner.execute(identity);
        const userState = activeProvisionedUser(provisioned, identity);
        if (userState === "disabled") return reply.code(401).send(publicFailure(request, 401));
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
        return reply.code(303).redirect(returnUrl.toString());
      } catch {
        request.log.error("hosted OIDC callback failed internally");
        return reply.code(503).send(publicFailure(request, 503));
      } finally {
        releaseCallback();
      }
    });

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
