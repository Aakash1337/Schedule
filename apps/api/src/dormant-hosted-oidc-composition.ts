import {
  AesGcmHostedLoginPkceProtector,
  ConsumeHostedLoginTransaction,
  FindOrProvisionHostedUser,
  HmacBrowserSessionTokenCodec,
  HmacHostedLoginTransactionCodec,
  IssueBrowserSession,
  ResolveBrowserSession,
  RevokeBrowserSession,
  StartHostedLoginTransaction,
  type HostedLoginPkceKeyRing,
} from "@schedule/application";
import type { HostedOidcRegistration } from "@schedule/config";
import {
  PostgresHostedLoginTransactionUnitOfWork,
  PostgresIdentityUnitOfWork,
  type DatabaseConnection,
} from "@schedule/database";
import type { FetchImplementation } from "jose";

import {
  HostedBrowserCsrfGuard,
  HostedBrowserSessionAuthenticator,
} from "./hosted-browser-session.js";
import {
  HOSTED_CALLBACK_ROUTE,
  type HostedAuthLifecycleDependencies,
} from "./hosted-auth-lifecycle.js";
import {
  StrictOidcAuthorizationCodeTokenExchanger,
  type OidcTokenEndpointAuthentication,
  type OidcTokenEndpointTransport,
} from "./oidc-authorization-code-token-exchange.js";
import { StrictOidcAuthorizationRequestBuilder } from "./oidc-authorization-request.js";
import { directOidcHttpsFetch } from "./oidc-direct-https-transport.js";
import { JoseOidcIdTokenVerifier } from "./oidc-id-token-verifier.js";
import { OidcProviderMetadataDiscovery } from "./oidc-provider-metadata.js";
import { createOidcRemoteJwksResolver } from "./oidc-remote-jwks-resolver.js";

const LOGIN_TTL_SECONDS = 5 * 60;
const SESSION_IDLE_TIMEOUT_SECONDS = 60 * 60;
const SESSION_ABSOLUTE_TTL_SECONDS = 24 * 60 * 60;
const DEFAULT_RETURN_PATH = "/";
const DEFAULT_SCOPES = Object.freeze(["openid"] as const);
const MAXIMUM_CLIENT_ID_BYTES = 512;
const MAXIMUM_CLIENT_SECRET_BYTES = 1_024;

export type HostedOidcCompositionTransport = FetchImplementation & OidcTokenEndpointTransport;

export interface DormantHostedOidcCompositionOptions {
  readonly database: DatabaseConnection;
  readonly registration: HostedOidcRegistration;
  readonly loginTransactionPepper: string;
  readonly browserSessionPepper: string;
  readonly pkceKeyRing: HostedLoginPkceKeyRing;
  readonly tokenEndpointAuthentication: OidcTokenEndpointAuthentication;
  /** Tests may inject a strict in-process provider; production should omit this safe default. */
  readonly transport?: HostedOidcCompositionTransport;
}

function invalid(): TypeError {
  return new TypeError("Dormant hosted OIDC composition is invalid.");
}

function containsAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function snapshotRegistration(value: HostedOidcRegistration): HostedOidcRegistration {
  if (typeof value !== "object" || value === null) throw invalid();
  const registration = Object.freeze({
    publicOrigin: value.publicOrigin,
    issuer: value.issuer,
    clientId: value.clientId,
    redirectUri: value.redirectUri,
  });
  if (
    registration.redirectUri !== `${registration.publicOrigin}${HOSTED_CALLBACK_ROUTE}` ||
    typeof registration.clientId !== "string" ||
    registration.clientId.length === 0 ||
    registration.clientId !== registration.clientId.trim() ||
    Buffer.byteLength(registration.clientId, "utf8") > MAXIMUM_CLIENT_ID_BYTES ||
    containsAsciiControl(registration.clientId)
  ) {
    throw invalid();
  }
  return registration;
}

function snapshotAuthentication(
  value: OidcTokenEndpointAuthentication,
): OidcTokenEndpointAuthentication {
  if (typeof value !== "object" || value === null) throw invalid();
  const method = value.method;
  if (method === "none") {
    if ("clientSecret" in value) throw invalid();
    return Object.freeze({ method });
  }
  const clientSecret = value.clientSecret;
  if (
    (method !== "client_secret_basic" && method !== "client_secret_post") ||
    typeof clientSecret !== "string" ||
    clientSecret.length === 0 ||
    Buffer.byteLength(clientSecret, "utf8") > MAXIMUM_CLIENT_SECRET_BYTES ||
    containsAsciiControl(clientSecret)
  ) {
    throw invalid();
  }
  return Object.freeze({ method, clientSecret });
}

/**
 * Builds the complete hosted OIDC dependency graph without creating an app or registering a route.
 * Provider discovery is the only I/O performed during construction.
 */
export async function createDormantHostedOidcComposition(
  options: DormantHostedOidcCompositionOptions,
): Promise<HostedAuthLifecycleDependencies> {
  if (typeof options !== "object" || options === null) throw invalid();
  const registration = snapshotRegistration(options.registration);
  const authentication = snapshotAuthentication(options.tokenEndpointAuthentication);
  const transport = options.transport ?? directOidcHttpsFetch;
  if (typeof transport !== "function") throw invalid();

  const csrfGuard = new HostedBrowserCsrfGuard(registration.publicOrigin);
  const loginCodec = new HmacHostedLoginTransactionCodec(options.loginTransactionPepper);
  const pkceProtector = new AesGcmHostedLoginPkceProtector(options.pkceKeyRing);
  const sessionCodec = new HmacBrowserSessionTokenCodec(options.browserSessionPepper);
  const loginUnitOfWork = new PostgresHostedLoginTransactionUnitOfWork(options.database);
  const identityUnitOfWork = new PostgresIdentityUnitOfWork(options.database);

  const metadata = await new OidcProviderMetadataDiscovery({
    issuer: registration.issuer,
    transport,
  }).discover();
  const remoteKeys = createOidcRemoteJwksResolver({
    issuer: metadata.issuer,
    jwksUri: metadata.jwksUri,
    transport,
  });

  return Object.freeze({
    authenticator: new HostedBrowserSessionAuthenticator(
      new ResolveBrowserSession(identityUnitOfWork, sessionCodec),
    ),
    csrfGuard,
    loginTransactionStarter: new StartHostedLoginTransaction(
      loginUnitOfWork,
      loginCodec,
      pkceProtector,
    ),
    loginTransactionConsumer: new ConsumeHostedLoginTransaction(
      loginUnitOfWork,
      loginCodec,
      pkceProtector,
    ),
    authorizationRequestBuilder: new StrictOidcAuthorizationRequestBuilder({
      issuer: metadata.issuer,
      authorizationEndpoint: metadata.authorizationEndpoint,
      clientId: registration.clientId,
      redirectUri: registration.redirectUri,
      scopes: DEFAULT_SCOPES,
    }),
    tokenExchanger: new StrictOidcAuthorizationCodeTokenExchanger({
      metadata,
      clientId: registration.clientId,
      redirectUri: registration.redirectUri,
      authentication,
      transport,
    }),
    identityVerifier: new JoseOidcIdTokenVerifier({
      keyResolver: remoteKeys.keyResolver,
      algorithms: metadata.idTokenSigningAlgorithms,
      maxTokenAgeSeconds: LOGIN_TTL_SECONDS,
    }),
    identityProvisioner: new FindOrProvisionHostedUser(identityUnitOfWork),
    sessionIssuer: new IssueBrowserSession(identityUnitOfWork, sessionCodec),
    sessionRevoker: new RevokeBrowserSession(identityUnitOfWork, sessionCodec),
    sessionPolicy: Object.freeze({
      idleTimeoutSeconds: SESSION_IDLE_TIMEOUT_SECONDS,
      absoluteTtlSeconds: SESSION_ABSOLUTE_TTL_SECONDS,
    }),
    loginPolicy: Object.freeze({
      hostedOrigin: registration.publicOrigin,
      issuer: registration.issuer,
      clientId: registration.clientId,
      redirectUri: registration.redirectUri,
      returnToPath: DEFAULT_RETURN_PATH,
      ttlSeconds: LOGIN_TTL_SECONDS,
    }),
  });
}
