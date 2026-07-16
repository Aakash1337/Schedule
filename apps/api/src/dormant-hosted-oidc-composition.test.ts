import {
  ConsumeHostedLoginTransaction,
  FindOrProvisionHostedUser,
  IssueBrowserSession,
  RevokeBrowserSession,
  StartHostedLoginTransaction,
  type IssuedHostedLoginTransaction,
} from "@schedule/application";
import type { HostedOidcRegistration } from "@schedule/config";
import type { DatabaseConnection } from "@schedule/database";
import { describe, expect, it, vi } from "vitest";

import {
  createDormantHostedOidcComposition,
  type DormantHostedOidcCompositionOptions,
  type HostedOidcCompositionTransport,
} from "./dormant-hosted-oidc-composition.js";
import {
  HostedBrowserCsrfGuard,
  HostedBrowserSessionAuthenticator,
} from "./hosted-browser-session.js";
import { StrictOidcAuthorizationCodeTokenExchanger } from "./oidc-authorization-code-token-exchange.js";
import { StrictOidcAuthorizationRequestBuilder } from "./oidc-authorization-request.js";
import { JoseOidcIdTokenVerifier } from "./oidc-id-token-verifier.js";

const ORIGIN = "https://schedule.example.com";
const ISSUER = "https://login.example.com/tenant";
const CLIENT_ID = "schedule-browser";
const REDIRECT_URI = `${ORIGIN}/v1/auth/callback`;
const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;
const AUTHORIZATION_ENDPOINT = "https://login.example.com/oauth/authorize";
const TOKEN_ENDPOINT = "https://login.example.com/oauth/token";
const JWKS_URI = "https://login.example.com/oauth/jwks";
const CLIENT_SECRET = "client-secret-with-at-least-32-safe-bytes";
const PKCE_KEY = Buffer.alloc(32, 7).toString("base64url");

class ExactUrlResponse extends Response {
  constructor(url: string, body: BodyInit, init: ResponseInit) {
    super(body, init);
    Object.defineProperty(this, "url", { value: url });
  }
}

function metadataDocument() {
  return {
    issuer: ISSUER,
    authorization_endpoint: AUTHORIZATION_ENDPOINT,
    token_endpoint: TOKEN_ENDPOINT,
    jwks_uri: JWKS_URI,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    scopes_supported: ["openid"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["client_secret_basic"],
  };
}

function jsonResponse(url: string, body: unknown, extraHeaders: HeadersInit = {}): Response {
  return new ExactUrlResponse(url, JSON.stringify(body), {
    status: 200,
    headers: {
      "content-type": "application/json",
      ...Object.fromEntries(new Headers(extraHeaders)),
    },
  });
}

function providerTransport(): HostedOidcCompositionTransport & ReturnType<typeof vi.fn> {
  return vi.fn(async (resource: string, options: RequestInit) => {
    if (resource === DISCOVERY_URL && options.method === "GET") {
      return jsonResponse(resource, metadataDocument());
    }
    if (resource === TOKEN_ENDPOINT && options.method === "POST") {
      return jsonResponse(
        resource,
        { access_token: "opaque-access", token_type: "Bearer", id_token: "a.b.c" },
        { "cache-control": "no-store", pragma: "no-cache" },
      );
    }
    throw new Error("unexpected provider request");
  }) as HostedOidcCompositionTransport & ReturnType<typeof vi.fn>;
}

function registration(overrides: Partial<HostedOidcRegistration> = {}): HostedOidcRegistration {
  return {
    publicOrigin: ORIGIN,
    issuer: ISSUER,
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    ...overrides,
  };
}

function options(
  transport: HostedOidcCompositionTransport = providerTransport(),
  overrides: Partial<DormantHostedOidcCompositionOptions> = {},
): DormantHostedOidcCompositionOptions {
  return {
    database: {} as DatabaseConnection,
    registration: registration(),
    loginTransactionPepper: "login-transaction-pepper-with-32-bytes",
    browserSessionPepper: "browser-session-pepper-with-32-bytes",
    pkceKeyRing: { primaryKeyId: "primary", keys: { primary: PKCE_KEY } },
    tokenEndpointAuthentication: {
      method: "client_secret_basic",
      clientSecret: CLIENT_SECRET,
    },
    transport,
    ...overrides,
  };
}

describe("dormant hosted OIDC composition", () => {
  it("constructs one frozen complete dependency graph from one provider snapshot", async () => {
    const transport = providerTransport();
    const composition = await createDormantHostedOidcComposition(options(transport));

    expect(Object.isFrozen(composition)).toBe(true);
    expect(composition.authenticator).toBeInstanceOf(HostedBrowserSessionAuthenticator);
    expect(composition.csrfGuard).toBeInstanceOf(HostedBrowserCsrfGuard);
    expect(composition.loginTransactionStarter).toBeInstanceOf(StartHostedLoginTransaction);
    expect(composition.loginTransactionConsumer).toBeInstanceOf(ConsumeHostedLoginTransaction);
    expect(composition.authorizationRequestBuilder).toBeInstanceOf(
      StrictOidcAuthorizationRequestBuilder,
    );
    expect(composition.tokenExchanger).toBeInstanceOf(StrictOidcAuthorizationCodeTokenExchanger);
    expect(composition.identityVerifier).toBeInstanceOf(JoseOidcIdTokenVerifier);
    expect(composition.identityProvisioner).toBeInstanceOf(FindOrProvisionHostedUser);
    expect(composition.sessionIssuer).toBeInstanceOf(IssueBrowserSession);
    expect(composition.sessionRevoker).toBeInstanceOf(RevokeBrowserSession);
    expect(composition.loginPolicy).toEqual({
      hostedOrigin: ORIGIN,
      issuer: ISSUER,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      returnToPath: "/",
      ttlSeconds: 300,
    });
    expect(composition.sessionPolicy).toEqual({
      idleTimeoutSeconds: 3_600,
      absoluteTtlSeconds: 86_400,
    });
    expect(transport).toHaveBeenCalledOnce();
    expect(transport).toHaveBeenCalledWith(
      DISCOVERY_URL,
      expect.objectContaining({ method: "GET", redirect: "manual" }),
    );
  });

  it("feeds the discovered authorization and token endpoints into their concrete adapters", async () => {
    const transport = providerTransport();
    const composition = await createDormantHostedOidcComposition(options(transport));
    const issued: IssuedHostedLoginTransaction = {
      issuer: ISSUER,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      state: "S".repeat(43),
      browserBinding: "B".repeat(43),
      nonce: "N".repeat(43),
      pkceChallenge: "C".repeat(43),
      pkceMethod: "S256",
      expiresAt: new Date("2100-01-01T00:00:00.000Z"),
    };

    const authorization = new URL(composition.authorizationRequestBuilder.build(issued).url);
    expect(`${authorization.origin}${authorization.pathname}`).toBe(AUTHORIZATION_ENDPOINT);
    expect(authorization.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(authorization.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(authorization.searchParams.get("scope")).toBe("openid");

    await expect(
      composition.tokenExchanger.exchange({
        code: "opaque-code",
        transaction: {
          issuer: ISSUER,
          clientId: CLIENT_ID,
          redirectUri: REDIRECT_URI,
          expectedNonce: "N".repeat(43),
          pkceVerifier: "P".repeat(43),
          consumedAt: new Date(),
        } as never,
      }),
    ).resolves.toEqual({ idToken: "a.b.c" });
    expect(transport).toHaveBeenLastCalledWith(
      TOKEN_ENDPOINT,
      expect.objectContaining({ method: "POST", redirect: "manual" }),
    );
    const tokenOptions = transport.mock.calls.at(-1)?.[1] as RequestInit;
    expect(new Headers(tokenOptions.headers).get("authorization")).toMatch(/^Basic /u);
    expect(String(tokenOptions.body)).not.toContain(CLIENT_SECRET);
  });

  it.each([
    ["redirect binding", { registration: registration({ redirectUri: `${ORIGIN}/wrong` }) }],
    ["client identifier", { registration: registration({ clientId: " client" }) }],
    ["login pepper", { loginTransactionPepper: "short" }],
    ["session pepper", { browserSessionPepper: "short" }],
    ["PKCE key ring", { pkceKeyRing: { primaryKeyId: "missing", keys: { primary: PKCE_KEY } } }],
    [
      "client secret",
      {
        tokenEndpointAuthentication: { method: "client_secret_basic", clientSecret: "bad\nsecret" },
      },
    ],
  ] satisfies ReadonlyArray<readonly [string, Partial<DormantHostedOidcCompositionOptions>]>)(
    "rejects invalid local %s before provider discovery",
    async (_label, override) => {
      const transport = providerTransport();
      await expect(
        createDormantHostedOidcComposition(options(transport, override)),
      ).rejects.toThrow();
      expect(transport).not.toHaveBeenCalled();
    },
  );

  it("snapshots registration and client authentication across asynchronous discovery", async () => {
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transport = vi.fn(async (resource: string, request: RequestInit) => {
      if (request.method === "GET") {
        await waiting;
        return jsonResponse(resource, metadataDocument());
      }
      return jsonResponse(
        resource,
        { access_token: "opaque-access", token_type: "Bearer", id_token: "a.b.c" },
        { "cache-control": "no-store", pragma: "no-cache" },
      );
    }) as HostedOidcCompositionTransport & ReturnType<typeof vi.fn>;
    const mutableRegistration = registration() as {
      -readonly [Key in keyof HostedOidcRegistration]: HostedOidcRegistration[Key];
    };
    const mutableAuthentication = {
      method: "client_secret_basic" as const,
      clientSecret: CLIENT_SECRET,
    };
    const pending = createDormantHostedOidcComposition(
      options(transport, {
        registration: mutableRegistration,
        tokenEndpointAuthentication: mutableAuthentication,
      }),
    );
    mutableRegistration.clientId = "attacker-client";
    mutableAuthentication.clientSecret = "attacker-secret-with-more-than-32-bytes";
    release();

    const composition = await pending;
    expect(composition.loginPolicy.clientId).toBe(CLIENT_ID);
    await composition.tokenExchanger.exchange({
      code: "opaque-code",
      transaction: {
        issuer: ISSUER,
        clientId: CLIENT_ID,
        redirectUri: REDIRECT_URI,
        expectedNonce: "N".repeat(43),
        pkceVerifier: "P".repeat(43),
        consumedAt: new Date(),
      } as never,
    });
    const tokenHeaders = new Headers((transport.mock.calls.at(-1)?.[1] as RequestInit).headers);
    expect(tokenHeaders.get("authorization")).toBe(
      `Basic ${Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`, "utf8").toString("base64")}`,
    );
  });

  it("redacts incompatible provider metadata without exposing configured secrets", async () => {
    const transport = vi.fn(async (resource: string) =>
      jsonResponse(resource, {
        ...metadataDocument(),
        token_endpoint_auth_methods_supported: ["none"],
      }),
    ) as HostedOidcCompositionTransport & ReturnType<typeof vi.fn>;

    const error = await createDormantHostedOidcComposition(options(transport)).catch(
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toContain(CLIENT_SECRET);
    expect((error as Error).message).not.toContain(TOKEN_ENDPOINT);
  });
});
