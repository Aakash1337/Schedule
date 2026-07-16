import type {
  ConsumedHostedLoginTransaction,
  IssuedHostedLoginTransaction,
} from "@schedule/application";
import {
  exportJWK,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type FetchImplementation,
  type JWK,
} from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { StrictOidcAuthorizationRequestBuilder } from "./oidc-authorization-request.js";
import {
  StrictOidcAuthorizationCodeTokenExchanger,
  type OidcTokenEndpointTransport,
} from "./oidc-authorization-code-token-exchange.js";
import { JoseOidcIdTokenVerifier } from "./oidc-id-token-verifier.js";
import {
  OidcProviderMetadataConfigurationError,
  OidcProviderMetadataDiscovery,
  OidcProviderMetadataUnavailableError,
  type OidcProviderMetadataDiscoveryOptions,
} from "./oidc-provider-metadata.js";
import { createOidcRemoteJwksResolver } from "./oidc-remote-jwks-resolver.js";

const ISSUER = "https://issuer.schedule.test/tenant";
const DISCOVERY_URL = `${ISSUER}/.well-known/openid-configuration`;
const AUTHORIZATION_ENDPOINT = "https://login.schedule.test/oauth/authorize?audience=schedule";
const TOKEN_ENDPOINT = "https://login.schedule.test/oauth/token?tenant=schedule";
const JWKS_URI = "https://keys.schedule.test/oidc/jwks.json?tenant=schedule";
const CLIENT_ID = "schedule-hosted-client";
const REDIRECT_URI = "https://schedule.test/v1/auth/callback";
const NOW = new Date("2026-07-16T12:00:00.000Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1_000);
const NONCE = "N".repeat(43);
const SUBJECT = "provider-subject-123";
const KEY_ID = "provider-key";

let signingKey: CryptoKey;
let publicJwk: JWK;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  signingKey = pair.privateKey;
  publicJwk = {
    ...(await exportJWK(pair.publicKey)),
    alg: "RS256",
    kid: KEY_ID,
    use: "sig",
  };
});

afterEach(() => {
  vi.useRealTimers();
});

function providerMetadata(overrides: Readonly<Record<string, unknown | undefined>> = {}) {
  const value: Record<string, unknown> = {
    issuer: ISSUER,
    authorization_endpoint: AUTHORIZATION_ENDPOINT,
    token_endpoint: TOKEN_ENDPOINT,
    jwks_uri: JWKS_URI,
    response_types_supported: ["code", "code id_token", "id_token"],
    response_modes_supported: ["query", "fragment"],
    grant_types_supported: ["authorization_code", "implicit"],
    subject_types_supported: ["public", "pairwise"],
    id_token_signing_alg_values_supported: ["ES256", "HS256", "RS256", "PS256"],
    scopes_supported: ["openid", "profile", "email"],
    code_challenge_methods_supported: ["plain", "S256"],
    token_endpoint_auth_methods_supported: ["none", "private_key_jwt", "client_secret_basic"],
    ignored_provider_extension: "ignored",
  };
  for (const [name, field] of Object.entries(overrides)) {
    if (field === undefined) delete value[name];
    else value[name] = field;
  }
  return value;
}

function metadataResponse(value: unknown = providerMetadata(), init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  return new Response(JSON.stringify(value), { ...init, headers });
}

function transportFrom(
  implementation: FetchImplementation = async () => metadataResponse(),
): FetchImplementation & ReturnType<typeof vi.fn> {
  return vi.fn(implementation) as FetchImplementation & ReturnType<typeof vi.fn>;
}

function createDiscovery(
  transport: FetchImplementation,
  overrides: Partial<OidcProviderMetadataDiscoveryOptions> = {},
): OidcProviderMetadataDiscovery {
  return new OidcProviderMetadataDiscovery({ issuer: ISSUER, transport, ...overrides });
}

describe("OidcProviderMetadataDiscovery", () => {
  it("retrieves one exact provider document and returns a frozen compatible snapshot", async () => {
    const transport = transportFrom();
    const discovery = createDiscovery(transport);

    const metadata = await discovery.discover();

    expect(metadata).toEqual({
      issuer: ISSUER,
      discoveryUrl: DISCOVERY_URL,
      authorizationEndpoint: AUTHORIZATION_ENDPOINT,
      tokenEndpoint: TOKEN_ENDPOINT,
      jwksUri: JWKS_URI,
      idTokenSigningAlgorithms: ["RS256", "PS256", "ES256"],
      tokenEndpointAuthMethods: ["client_secret_basic", "none"],
    });
    expect(Object.isFrozen(metadata)).toBe(true);
    expect(Object.isFrozen(metadata.idTokenSigningAlgorithms)).toBe(true);
    expect(Object.isFrozen(metadata.tokenEndpointAuthMethods)).toBe(true);

    expect(transport).toHaveBeenCalledTimes(1);
    const [resource, options] = transport.mock.calls[0] as Parameters<FetchImplementation>;
    expect(resource).toBe(DISCOVERY_URL);
    expect(options.method).toBe("GET");
    expect(options.redirect).toBe("manual");
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.headers.get("accept")).toBe("application/json");
    expect(options.headers.get("accept-encoding")).toBe("identity");
    expect(options.headers.has("authorization")).toBe(false);
    expect(options.headers.has("cookie")).toBe(false);
    expect(options.headers.has("forwarded")).toBe(false);
  });

  it.each([
    [
      "root issuer without slash",
      "https://issuer.schedule.test",
      "https://issuer.schedule.test/.well-known/openid-configuration",
    ],
    [
      "root issuer with slash",
      "https://issuer.schedule.test/",
      "https://issuer.schedule.test/.well-known/openid-configuration",
    ],
    [
      "path issuer with slash",
      "https://issuer.schedule.test/tenant/",
      "https://issuer.schedule.test/tenant/.well-known/openid-configuration",
    ],
  ])("derives the official discovery path for a %s", async (_name, issuer, expectedUrl) => {
    const transport = transportFrom(async () => metadataResponse(providerMetadata({ issuer })));
    const metadata = await createDiscovery(transport, { issuer }).discover();

    expect(metadata.issuer).toBe(issuer);
    expect(metadata.discoveryUrl).toBe(expectedUrl);
    expect(transport).toHaveBeenCalledWith(expectedUrl, expect.objectContaining({ method: "GET" }));
  });

  it("reads configuration once and isolates the provider snapshot from later mutation", async () => {
    let issuerReads = 0;
    let transportReads = 0;
    const transport = transportFrom();
    const options = Object.defineProperties(
      {},
      {
        issuer: { enumerable: true, get: () => ((issuerReads += 1), ISSUER) },
        transport: { enumerable: true, get: () => ((transportReads += 1), transport) },
      },
    ) as OidcProviderMetadataDiscoveryOptions;
    const discovery = new OidcProviderMetadataDiscovery(options);

    const first = await discovery.discover();
    const second = await discovery.discover();

    expect({ issuerReads, transportReads }).toEqual({ issuerReads: 1, transportReads: 1 });
    expect(second).toBe(first);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("redacts hostile configuration getters", () => {
    const options = Object.defineProperty({}, "issuer", {
      get: () => {
        throw new Error("secret-provider-configuration");
      },
    });

    expect(
      () => new OidcProviderMetadataDiscovery(options as OidcProviderMetadataDiscoveryOptions),
    ).toThrow(OidcProviderMetadataConfigurationError);
    try {
      new OidcProviderMetadataDiscovery(options as OidcProviderMetadataDiscoveryOptions);
    } catch (error) {
      expect(String(error)).not.toContain("secret-provider-configuration");
    }
  });

  it.each([
    ["non-object options", null],
    ["HTTP issuer", { issuer: "http://issuer.schedule.test" }],
    ["issuer query", { issuer: `${ISSUER}?tenant=other` }],
    ["bare issuer query delimiter", { issuer: `${ISSUER}?` }],
    ["issuer fragment", { issuer: `${ISSUER}#fragment` }],
    ["bare issuer fragment delimiter", { issuer: `${ISSUER}#` }],
    ["issuer credentials", { issuer: "https://user:pass@issuer.schedule.test" }],
    ["issuer port", { issuer: "https://issuer.schedule.test:8443/tenant" }],
    ["noncanonical issuer", { issuer: "https://ISSUER.schedule.test/tenant" }],
    ["raw whitespace", { issuer: "https://issuer.schedule.test/ten ant" }],
    ["raw backslash", { issuer: "https://issuer.schedule.test\\tenant" }],
    ["oversized derived URL", { issuer: `https://issuer.schedule.test/${"a".repeat(2_030)}` }],
    ["missing transport", { issuer: ISSUER, transport: undefined }],
  ])("rejects and redacts %s", (_name, partial) => {
    const value = partial === null ? null : { transport: transportFrom(), ...partial };
    expect(
      () => new OidcProviderMetadataDiscovery(value as OidcProviderMetadataDiscoveryOptions),
    ).toThrow(OidcProviderMetadataConfigurationError);
  });

  it("uses specification defaults for optional code-flow metadata", async () => {
    const transport = transportFrom(async () =>
      metadataResponse(
        providerMetadata({
          grant_types_supported: undefined,
          response_modes_supported: undefined,
          scopes_supported: undefined,
          token_endpoint_auth_methods_supported: undefined,
        }),
      ),
    );

    const metadata = await createDiscovery(transport).discover();

    expect(metadata.tokenEndpointAuthMethods).toEqual(["client_secret_basic"]);
  });

  it.each([
    ["non-Response value", async () => ({ status: 200 }) as unknown as Response],
    [
      "redirect",
      async () =>
        metadataResponse(undefined, { status: 302, headers: { location: "https://evil.test" } }),
    ],
    ["no content", async () => new Response(null, { status: 204 })],
    ["server error", async () => metadataResponse(undefined, { status: 503 })],
    ["missing media type", async () => new Response(JSON.stringify(providerMetadata()))],
    [
      "wrong media type",
      async () =>
        new Response(JSON.stringify(providerMetadata()), {
          headers: { "content-type": "application/jwk-set+json" },
        }),
    ],
    [
      "declared oversized body",
      async () =>
        metadataResponse(undefined, {
          headers: { "content-type": "application/json", "content-length": "65537" },
        }),
    ],
    [
      "mismatched declared body",
      async () =>
        metadataResponse(undefined, {
          headers: { "content-type": "application/json", "content-length": "1" },
        }),
    ],
    [
      "streamed oversized body",
      async () =>
        new Response(new Uint8Array(65_537), { headers: { "content-type": "application/json" } }),
    ],
    [
      "malformed UTF-8",
      async () =>
        new Response(new Uint8Array([0xc3, 0x28]), {
          headers: { "content-type": "application/json" },
        }),
    ],
    [
      "malformed JSON",
      async () => new Response("{", { headers: { "content-type": "application/json" } }),
    ],
    ["top-level array", async () => metadataResponse([])],
    ["top-level null", async () => metadataResponse(null)],
    [
      "transport rejection",
      async () => {
        throw new Error("secret-upstream-details");
      },
    ],
  ] satisfies ReadonlyArray<readonly [string, FetchImplementation]>)(
    "maps %s to one redacted unavailable error",
    async (_name, implementation) => {
      const transport = transportFrom(implementation);
      await expect(createDiscovery(transport).discover()).rejects.toEqual(
        new OidcProviderMetadataUnavailableError(),
      );
      try {
        await createDiscovery(transport).discover();
      } catch (error) {
        expect(String(error)).not.toContain("secret-upstream-details");
      }
    },
  );

  it("rejects redirect evidence and a mismatched final response URL", async () => {
    const redirected = metadataResponse();
    Object.defineProperty(redirected, "redirected", { value: true });
    const mismatched = metadataResponse();
    Object.defineProperty(mismatched, "url", { value: "https://evil.test/openid-configuration" });

    await expect(
      createDiscovery(transportFrom(async () => redirected)).discover(),
    ).rejects.toBeInstanceOf(OidcProviderMetadataUnavailableError);
    await expect(
      createDiscovery(transportFrom(async () => mismatched)).discover(),
    ).rejects.toBeInstanceOf(OidcProviderMetadataUnavailableError);
  });

  it.each([
    ["missing issuer", { issuer: undefined }],
    ["mismatched issuer", { issuer: `${ISSUER}/` }],
    ["missing authorization endpoint", { authorization_endpoint: undefined }],
    [
      "HTTP authorization endpoint",
      { authorization_endpoint: "http://login.schedule.test/oauth/authorize" },
    ],
    [
      "credential-bearing authorization endpoint",
      { authorization_endpoint: "https://user@login.schedule.test/oauth/authorize" },
    ],
    [
      "fragmented authorization endpoint",
      { authorization_endpoint: `${AUTHORIZATION_ENDPOINT}#fragment` },
    ],
    [
      "noncanonical authorization endpoint",
      { authorization_endpoint: "https://LOGIN.schedule.test/oauth/authorize" },
    ],
    ["missing token endpoint", { token_endpoint: undefined }],
    ["HTTP token endpoint", { token_endpoint: "http://login.schedule.test/oauth/token" }],
    ["missing JWKS URI", { jwks_uri: undefined }],
    ["HTTP JWKS URI", { jwks_uri: "http://keys.schedule.test/jwks.json" }],
    ["missing response types", { response_types_supported: undefined }],
    ["response types without code", { response_types_supported: ["id_token"] }],
    ["duplicate response types", { response_types_supported: ["code", "code"] }],
    ["missing subject types", { subject_types_supported: undefined }],
    ["unsupported subject type", { subject_types_supported: ["ephemeral"] }],
    ["duplicate subject type", { subject_types_supported: ["public", "public"] }],
    ["missing signing algorithms", { id_token_signing_alg_values_supported: undefined }],
    ["signing algorithms without RS256", { id_token_signing_alg_values_supported: ["ES256"] }],
    ["duplicate signing algorithm", { id_token_signing_alg_values_supported: ["RS256", "RS256"] }],
    ["grant types without authorization code", { grant_types_supported: ["implicit"] }],
    ["response modes without query", { response_modes_supported: ["fragment"] }],
    ["scopes without openid", { scopes_supported: ["profile"] }],
    ["missing PKCE methods", { code_challenge_methods_supported: undefined }],
    ["PKCE methods without S256", { code_challenge_methods_supported: ["plain"] }],
    [
      "unsupported token authentication",
      { token_endpoint_auth_methods_supported: ["private_key_jwt"] },
    ],
    ["empty token authentication", { token_endpoint_auth_methods_supported: [] }],
    [
      "too many response types",
      { response_types_supported: Array.from({ length: 33 }, (_, index) => `code-${index}`) },
    ],
    ["oversized protocol value", { response_types_supported: ["code", "x".repeat(129)] }],
    ["non-string protocol value", { response_types_supported: ["code", 1] }],
  ])("rejects incompatible provider metadata: %s", async (_name, overrides) => {
    const transport = transportFrom(async () => metadataResponse(providerMetadata(overrides)));
    await expect(createDiscovery(transport).discover()).rejects.toEqual(
      new OidcProviderMetadataUnavailableError(),
    );
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each([
    "response_type",
    "client_id",
    "redirect_uri",
    "scope",
    "state",
    "nonce",
    "code_challenge",
    "code_challenge_method",
  ])("rejects authorization endpoint collision with %s", async (parameter) => {
    const endpoint = `https://login.schedule.test/oauth/authorize?${parameter}=attacker`;
    const transport = transportFrom(async () =>
      metadataResponse(providerMetadata({ authorization_endpoint: endpoint })),
    );
    await expect(createDiscovery(transport).discover()).rejects.toBeInstanceOf(
      OidcProviderMetadataUnavailableError,
    );
  });

  it("rejects an oversized or malformed trusted authorization endpoint query", async () => {
    const tooMany = new URL("https://login.schedule.test/oauth/authorize");
    for (let index = 0; index < 17; index += 1) tooMany.searchParams.append(`p${index}`, "v");
    const whitespaceName = "https://login.schedule.test/oauth/authorize?bad+name=value";

    await expect(
      createDiscovery(
        transportFrom(async () =>
          metadataResponse(providerMetadata({ authorization_endpoint: tooMany.href })),
        ),
      ).discover(),
    ).rejects.toBeInstanceOf(OidcProviderMetadataUnavailableError);
    await expect(
      createDiscovery(
        transportFrom(async () =>
          metadataResponse(providerMetadata({ authorization_endpoint: whitespaceName })),
        ),
      ).discover(),
    ).rejects.toBeInstanceOf(OidcProviderMetadataUnavailableError);
  });

  it("shares a cold request, caches only success, and retries after failure", async () => {
    let release!: (value: Response) => void;
    const firstResponse = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const transport = transportFrom(async () => firstResponse);
    const discovery = createDiscovery(transport);

    const first = discovery.discover();
    const second = discovery.discover();
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    release(metadataResponse());
    const [firstMetadata, secondMetadata] = await Promise.all([first, second]);
    expect(secondMetadata).toBe(firstMetadata);

    let attempts = 0;
    const retryTransport = transportFrom(async () => {
      attempts += 1;
      return attempts === 1 ? metadataResponse(undefined, { status: 503 }) : metadataResponse();
    });
    const retryDiscovery = createDiscovery(retryTransport);
    await expect(retryDiscovery.discover()).rejects.toBeInstanceOf(
      OidcProviderMetadataUnavailableError,
    );
    await expect(retryDiscovery.discover()).resolves.toMatchObject({ issuer: ISSUER });
    expect(retryTransport).toHaveBeenCalledTimes(2);
  });

  it("hard-bounds a transport that ignores its abort signal", async () => {
    vi.useFakeTimers();
    let observedAbort = false;
    const transport = transportFrom(async (_resource, options) => {
      options.signal.addEventListener("abort", () => {
        observedAbort = true;
      });
      return new Promise<Response>(() => undefined);
    });
    const pending = createDiscovery(transport).discover();
    const rejection = expect(pending).rejects.toEqual(new OidcProviderMetadataUnavailableError());

    await vi.advanceTimersByTimeAsync(3_001);

    await rejection;
    expect(observedAbort).toBe(true);
  });

  it("clears its hard-deadline timer after a successful response", async () => {
    vi.useFakeTimers();
    let observedSignal: AbortSignal | undefined;
    const transport = transportFrom(async (_resource, options) => {
      observedSignal = options.signal;
      return metadataResponse();
    });

    await expect(createDiscovery(transport).discover()).resolves.toMatchObject({ issuer: ISSUER });
    expect(observedSignal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(3_001);

    expect(observedSignal?.aborted).toBe(false);
  });

  it("feeds only validated frozen values into authorization, token, and JWKS boundaries", async () => {
    const metadata = await createDiscovery(transportFrom()).discover();
    const builder = new StrictOidcAuthorizationRequestBuilder(
      {
        issuer: metadata.issuer,
        authorizationEndpoint: metadata.authorizationEndpoint,
        clientId: CLIENT_ID,
        redirectUri: REDIRECT_URI,
        scopes: ["profile", "openid"],
      },
      { clock: () => new Date(NOW) },
    );
    const transaction: IssuedHostedLoginTransaction = {
      issuer: metadata.issuer,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      state: "S".repeat(43),
      browserBinding: "B".repeat(43),
      nonce: "N".repeat(43),
      pkceChallenge: "C".repeat(43),
      pkceMethod: "S256",
      expiresAt: new Date(NOW.getTime() + 60_000),
    };
    const request = builder.build(transaction);
    const query = new URL(request.url).searchParams;
    expect(query.get("response_type")).toBe("code");
    expect(query.get("scope")).toBe("openid profile");

    const jwksTransport = transportFrom(
      async () =>
        new Response(JSON.stringify({ keys: [publicJwk] }), {
          headers: { "content-type": "application/jwk-set+json" },
        }),
    );
    const resolver = createOidcRemoteJwksResolver({
      issuer: metadata.issuer,
      jwksUri: metadata.jwksUri,
      transport: jwksTransport,
    });
    const verifier = new JoseOidcIdTokenVerifier({
      keyResolver: resolver.keyResolver,
      algorithms: metadata.idTokenSigningAlgorithms,
      clock: () => new Date(NOW),
      clockToleranceSeconds: 60,
      maxTokenAgeSeconds: 900,
      keyResolutionTimeoutMilliseconds: 1_000,
    });
    const idToken = await new SignJWT({
      iss: metadata.issuer,
      sub: SUBJECT,
      aud: CLIENT_ID,
      exp: NOW_SECONDS + 300,
      iat: NOW_SECONDS - 30,
      nonce: NONCE,
    })
      .setProtectedHeader({ alg: "RS256", kid: KEY_ID, typ: "JWT" })
      .sign(signingKey);
    const tokenTransport = vi.fn(async (resource, options) => {
      expect(resource).toBe(metadata.tokenEndpoint);
      const form = new URLSearchParams(String(options.body));
      expect(form.get("code")).toBe("provider-code");
      expect(form.get("code_verifier")).toBe("P".repeat(43));
      const response = new Response(
        JSON.stringify({
          access_token: "provider-access-token",
          token_type: "Bearer",
          id_token: idToken,
        }),
        {
          headers: {
            "content-type": "application/json",
            "cache-control": "no-store",
            pragma: "no-cache",
          },
        },
      );
      Object.defineProperty(response, "url", { value: metadata.tokenEndpoint });
      return response;
    }) as unknown as OidcTokenEndpointTransport & ReturnType<typeof vi.fn>;
    const exchanger = new StrictOidcAuthorizationCodeTokenExchanger({
      metadata,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      authentication: { method: "none" },
      transport: tokenTransport,
    });
    const consumed = {
      id: "00000000-0000-4000-8000-000000000001",
      issuer: metadata.issuer,
      clientId: CLIENT_ID,
      redirectUri: REDIRECT_URI,
      returnToPath: "/today",
      expectedNonce: NONCE,
      pkceVerifier: "P".repeat(43),
      consumedAt: new Date(NOW),
    } as ConsumedHostedLoginTransaction;
    const exchanged = await exchanger.exchange({ code: "provider-code", transaction: consumed });
    expect(exchanged).toEqual({ idToken });

    await expect(
      verifier.verify({
        idToken: exchanged?.idToken ?? "",
        issuer: metadata.issuer,
        clientId: CLIENT_ID,
        expectedNonce: NONCE,
      }),
    ).resolves.toEqual({ issuer: metadata.issuer, subject: SUBJECT });
    expect(tokenTransport).toHaveBeenCalledTimes(1);
    expect(jwksTransport).toHaveBeenCalledTimes(1);
  });
});
