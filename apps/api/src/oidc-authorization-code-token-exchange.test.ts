import type { ConsumedHostedLoginTransaction } from "@schedule/application";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  OidcAuthorizationCodeTokenExchangeConfigurationError,
  OidcAuthorizationCodeTokenExchangeUnavailableError,
  StrictOidcAuthorizationCodeTokenExchanger,
  type OidcAuthorizationCodeTokenExchangeConfiguration,
  type OidcTokenEndpointAuthentication,
  type OidcTokenEndpointTransport,
} from "./oidc-authorization-code-token-exchange.js";

const ISSUER = "https://issuer.schedule.test/tenant";
const TOKEN_ENDPOINT = "https://login.schedule.test/oauth/token?tenant=schedule";
const CLIENT_ID = "schedule client:+";
const CLIENT_SECRET = "s e:c+r/et?";
const REDIRECT_URI = "https://schedule.test/v1/auth/callback?tenant=primary";
const AUTHORIZATION_CODE = "provider-code_123-ABC";
const PKCE_VERIFIER = "P".repeat(43);
const NONCE = "N".repeat(43);
const ID_TOKEN = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.signature";
const ACCESS_TOKEN = "access-token-value";
const REFRESH_TOKEN = "refresh-token-value";
const intentionallyUrlLessResponses = new WeakSet<Response>();

afterEach(() => {
  vi.useRealTimers();
});

function providerMetadata(
  overrides: Partial<OidcAuthorizationCodeTokenExchangeConfiguration["metadata"]> = {},
): OidcAuthorizationCodeTokenExchangeConfiguration["metadata"] {
  return {
    issuer: ISSUER,
    tokenEndpoint: TOKEN_ENDPOINT,
    tokenEndpointAuthMethods: ["client_secret_basic", "client_secret_post", "none"],
    ...overrides,
  };
}

function consumedTransaction(
  overrides: Partial<ConsumedHostedLoginTransaction> = {},
): ConsumedHostedLoginTransaction {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    issuer: ISSUER,
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    returnToPath: "/today",
    expectedNonce: NONCE,
    pkceVerifier: PKCE_VERIFIER,
    consumedAt: new Date("2026-07-16T12:00:00.000Z"),
    ...overrides,
  } as ConsumedHostedLoginTransaction;
}

function successfulBody(overrides: Readonly<Record<string, unknown | undefined>> = {}) {
  const value: Record<string, unknown> = {
    access_token: ACCESS_TOKEN,
    token_type: "Bearer",
    expires_in: 3_600,
    refresh_token: REFRESH_TOKEN,
    scope: "openid profile",
    id_token: ID_TOKEN,
  };
  for (const [name, field] of Object.entries(overrides)) {
    if (field === undefined) delete value[name];
    else value[name] = field;
  }
  return value;
}

function tokenResponse(value: unknown = successfulBody(), init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  if (!headers.has("cache-control")) headers.set("cache-control", "private, no-store");
  if (!headers.has("pragma")) headers.set("pragma", "no-cache");
  const response = new Response(JSON.stringify(value), { ...init, headers });
  Object.defineProperty(response, "url", { value: TOKEN_ENDPOINT, configurable: true });
  return response;
}

type MockTransport = OidcTokenEndpointTransport & ReturnType<typeof vi.fn>;

function transportFrom(
  implementation: OidcTokenEndpointTransport = async () => tokenResponse(),
): MockTransport {
  return vi.fn(async (...arguments_: Parameters<OidcTokenEndpointTransport>) => {
    const response = await implementation(...arguments_);
    if (
      response instanceof Response &&
      response.url.length === 0 &&
      !intentionallyUrlLessResponses.has(response)
    ) {
      Object.defineProperty(response, "url", { value: TOKEN_ENDPOINT, configurable: true });
    }
    return response;
  }) as unknown as MockTransport;
}

function withoutFinalUrl(response: Response): Response {
  intentionallyUrlLessResponses.add(response);
  return response;
}

function baseConfiguration(
  transport: OidcTokenEndpointTransport,
  authentication: OidcTokenEndpointAuthentication = {
    method: "client_secret_basic",
    clientSecret: CLIENT_SECRET,
  },
): OidcAuthorizationCodeTokenExchangeConfiguration {
  return {
    metadata: providerMetadata(),
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    authentication,
    transport,
  };
}

function createExchanger(
  transport: OidcTokenEndpointTransport,
  overrides: Partial<OidcAuthorizationCodeTokenExchangeConfiguration> = {},
) {
  return new StrictOidcAuthorizationCodeTokenExchanger({
    ...baseConfiguration(transport),
    ...overrides,
  });
}

function exchange(
  exchanger: StrictOidcAuthorizationCodeTokenExchanger,
  overrides: Partial<{
    code: string;
    transaction: ConsumedHostedLoginTransaction;
  }> = {},
) {
  return exchanger.exchange({
    code: AUTHORIZATION_CODE,
    transaction: consumedTransaction(),
    ...overrides,
  });
}

function formEncode(value: string): string {
  return new URLSearchParams({ value }).toString().slice("value=".length);
}

describe("StrictOidcAuthorizationCodeTokenExchanger", () => {
  it("makes one exact Basic-authenticated POST and returns only a frozen ID token", async () => {
    const transport = transportFrom();
    const exchanger = createExchanger(transport);

    const result = await exchange(exchanger);

    expect(result).toEqual({ idToken: ID_TOKEN });
    expect(Object.isFrozen(result)).toBe(true);
    expect(result).not.toHaveProperty("accessToken");
    expect(result).not.toHaveProperty("refreshToken");
    expect(JSON.stringify(result)).not.toContain(ACCESS_TOKEN);
    expect(JSON.stringify(result)).not.toContain(REFRESH_TOKEN);
    expect(transport).toHaveBeenCalledTimes(1);
    const [resource, options] = transport.mock.calls[0] as Parameters<OidcTokenEndpointTransport>;
    expect(resource).toBe(TOKEN_ENDPOINT);
    expect(options).toMatchObject({
      method: "POST",
      redirect: "manual",
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    expect(options.signal).toBeInstanceOf(AbortSignal);
    const headers = new Headers(options.headers);
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("accept-encoding")).toBe("identity");
    expect(headers.get("cache-control")).toBe("no-store");
    expect(headers.get("pragma")).toBe("no-cache");
    expect(headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(headers.has("cookie")).toBe(false);
    expect(headers.has("forwarded")).toBe(false);
    expect(headers.has("proxy-authorization")).toBe(false);
    const expectedBasic = Buffer.from(
      `${formEncode(CLIENT_ID)}:${formEncode(CLIENT_SECRET)}`,
      "utf8",
    ).toString("base64");
    expect(headers.get("authorization")).toBe(`Basic ${expectedBasic}`);
    const form = new URLSearchParams(String(options.body));
    expect([...form]).toEqual([
      ["grant_type", "authorization_code"],
      ["code", AUTHORIZATION_CODE],
      ["redirect_uri", REDIRECT_URI],
      ["code_verifier", PKCE_VERIFIER],
    ]);
    expect(form.has("client_id")).toBe(false);
    expect(form.has("client_secret")).toBe(false);
  });

  it("uses client_secret_post without leaking an Authorization header", async () => {
    const transport = transportFrom();
    const exchanger = createExchanger(transport, {
      authentication: { method: "client_secret_post", clientSecret: CLIENT_SECRET },
    });

    await expect(exchange(exchanger)).resolves.toEqual({ idToken: ID_TOKEN });

    const options = transport.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(options.headers).has("authorization")).toBe(false);
    expect([...new URLSearchParams(String(options.body))]).toEqual([
      ["grant_type", "authorization_code"],
      ["code", AUTHORIZATION_CODE],
      ["redirect_uri", REDIRECT_URI],
      ["code_verifier", PKCE_VERIFIER],
      ["client_id", CLIENT_ID],
      ["client_secret", CLIENT_SECRET],
    ]);
  });

  it("uses the public-client method with client_id and no credential", async () => {
    const transport = transportFrom();
    const exchanger = createExchanger(transport, { authentication: { method: "none" } });

    await expect(exchange(exchanger)).resolves.toEqual({ idToken: ID_TOKEN });

    const options = transport.mock.calls[0]?.[1] as RequestInit;
    expect(new Headers(options.headers).has("authorization")).toBe(false);
    const form = new URLSearchParams(String(options.body));
    expect(form.get("client_id")).toBe(CLIENT_ID);
    expect(form.has("client_secret")).toBe(false);
  });

  it("form-encodes an opaque authorization code without parameter injection", async () => {
    const transport = transportFrom();
    const exchanger = createExchanger(transport);
    const code = "provider&client_secret=attacker%value";

    await expect(exchange(exchanger, { code })).resolves.toEqual({ idToken: ID_TOKEN });

    const form = new URLSearchParams(String(transport.mock.calls[0]?.[1].body));
    expect(form.get("code")).toBe(code);
    expect(form.getAll("code")).toHaveLength(1);
    expect(form.has("client_secret")).toBe(false);
    expect([...form.keys()]).toEqual(["grant_type", "code", "redirect_uri", "code_verifier"]);
  });

  it("snapshots accessor-backed configuration exactly once", async () => {
    const reads = {
      metadata: 0,
      issuer: 0,
      tokenEndpoint: 0,
      authMethods: 0,
      clientId: 0,
      redirectUri: 0,
      authentication: 0,
      method: 0,
      secret: 0,
      transport: 0,
    };
    const transport = transportFrom();
    const metadata = Object.defineProperties(
      {},
      {
        issuer: { enumerable: true, get: () => ((reads.issuer += 1), ISSUER) },
        tokenEndpoint: {
          enumerable: true,
          get: () => ((reads.tokenEndpoint += 1), TOKEN_ENDPOINT),
        },
        tokenEndpointAuthMethods: {
          enumerable: true,
          get: () => ((reads.authMethods += 1), ["client_secret_basic"]),
        },
      },
    );
    const authentication = Object.defineProperties(
      {},
      {
        method: {
          enumerable: true,
          get: () => ((reads.method += 1), "client_secret_basic"),
        },
        clientSecret: {
          enumerable: true,
          get: () => ((reads.secret += 1), CLIENT_SECRET),
        },
      },
    );
    const configuration = Object.defineProperties(
      {},
      {
        metadata: { enumerable: true, get: () => ((reads.metadata += 1), metadata) },
        clientId: { enumerable: true, get: () => ((reads.clientId += 1), CLIENT_ID) },
        redirectUri: {
          enumerable: true,
          get: () => ((reads.redirectUri += 1), REDIRECT_URI),
        },
        authentication: {
          enumerable: true,
          get: () => ((reads.authentication += 1), authentication),
        },
        transport: { enumerable: true, get: () => ((reads.transport += 1), transport) },
      },
    ) as OidcAuthorizationCodeTokenExchangeConfiguration;

    const exchanger = new StrictOidcAuthorizationCodeTokenExchanger(configuration);
    await exchange(exchanger);

    expect(reads).toEqual({
      metadata: 1,
      issuer: 1,
      tokenEndpoint: 1,
      authMethods: 1,
      clientId: 1,
      redirectUri: 1,
      authentication: 1,
      method: 1,
      secret: 1,
      transport: 1,
    });
  });

  it("redacts hostile configuration getters", () => {
    const configuration = Object.defineProperty({}, "metadata", {
      get: () => {
        throw new Error("secret-hostile-configuration");
      },
    });

    expect(
      () =>
        new StrictOidcAuthorizationCodeTokenExchanger(
          configuration as OidcAuthorizationCodeTokenExchangeConfiguration,
        ),
    ).toThrow(new OidcAuthorizationCodeTokenExchangeConfigurationError());
    try {
      new StrictOidcAuthorizationCodeTokenExchanger(
        configuration as OidcAuthorizationCodeTokenExchangeConfiguration,
      );
    } catch (error) {
      expect(String(error)).not.toContain("secret-hostile-configuration");
    }
  });

  it.each([
    ["non-object configuration", null],
    ["missing metadata", { metadata: null }],
    ["HTTP issuer", { metadata: providerMetadata({ issuer: "http://issuer.schedule.test" }) }],
    ["issuer query", { metadata: providerMetadata({ issuer: `${ISSUER}?other=true` }) }],
    [
      "HTTP token endpoint",
      { metadata: providerMetadata({ tokenEndpoint: "http://login.schedule.test/token" }) },
    ],
    [
      "token endpoint fragment",
      { metadata: providerMetadata({ tokenEndpoint: `${TOKEN_ENDPOINT}#fragment` }) },
    ],
    [
      "token endpoint credentials",
      { metadata: providerMetadata({ tokenEndpoint: "https://user@login.schedule.test/token" }) },
    ],
    [
      "noncanonical token endpoint",
      { metadata: providerMetadata({ tokenEndpoint: "https://LOGIN.schedule.test/token" }) },
    ],
    ["empty client ID", { clientId: "" }],
    ["client ID control", { clientId: "client\nsecret" }],
    ["HTTP redirect URI", { redirectUri: "http://schedule.test/callback" }],
    ["redirect fragment", { redirectUri: `${REDIRECT_URI}#fragment` }],
    ["missing transport", { transport: undefined }],
    [
      "duplicate advertised methods",
      { metadata: providerMetadata({ tokenEndpointAuthMethods: ["none", "none"] }) },
    ],
    [
      "unadvertised selected method",
      {
        metadata: providerMetadata({ tokenEndpointAuthMethods: ["none"] }),
        authentication: { method: "client_secret_basic", clientSecret: CLIENT_SECRET },
      },
    ],
    ["missing client secret", { authentication: { method: "client_secret_basic" } }],
    [
      "client secret control",
      { authentication: { method: "client_secret_post", clientSecret: "secret\nvalue" } },
    ],
    [
      "oversized client secret",
      { authentication: { method: "client_secret_post", clientSecret: "s".repeat(1_025) } },
    ],
    ["public method with secret", { authentication: { method: "none", clientSecret: "secret" } }],
    ["unsupported method", { authentication: { method: "private_key_jwt" } }],
  ])("rejects and redacts %s", (_name, overrides) => {
    const configuration =
      overrides === null ? null : { ...baseConfiguration(transportFrom()), ...overrides };
    expect(
      () =>
        new StrictOidcAuthorizationCodeTokenExchanger(
          configuration as OidcAuthorizationCodeTokenExchangeConfiguration,
        ),
    ).toThrow(OidcAuthorizationCodeTokenExchangeConfigurationError);
  });

  it.each(["grant_type", "code", "redirect_uri", "code_verifier", "client_id", "client_secret"])(
    "rejects token-endpoint query collision with %s",
    (name) => {
      const endpoint = new URL("https://login.schedule.test/oauth/token");
      endpoint.searchParams.set(name, "provider-value");
      expect(() =>
        createExchanger(transportFrom(), {
          metadata: providerMetadata({ tokenEndpoint: endpoint.href }),
        }),
      ).toThrow(OidcAuthorizationCodeTokenExchangeConfigurationError);
    },
  );

  it("rejects an oversized trusted token-endpoint query", () => {
    const endpoint = new URL("https://login.schedule.test/oauth/token");
    for (let index = 0; index < 17; index += 1) endpoint.searchParams.append(`p${index}`, "value");
    expect(() =>
      createExchanger(transportFrom(), {
        metadata: providerMetadata({ tokenEndpoint: endpoint.href }),
      }),
    ).toThrow(OidcAuthorizationCodeTokenExchangeConfigurationError);
  });

  it.each([
    ["malformed transaction", null],
    ["mismatched issuer", consumedTransaction({ issuer: `${ISSUER}/other` })],
    ["mismatched client", consumedTransaction({ clientId: "other-client" })],
    [
      "mismatched redirect",
      consumedTransaction({ redirectUri: "https://schedule.test/other/callback" }),
    ],
    ["malformed PKCE verifier", consumedTransaction({ pkceVerifier: "short" })],
    ["malformed nonce", consumedTransaction({ expectedNonce: "short" })],
    ["invalid consumed time", consumedTransaction({ consumedAt: new Date(Number.NaN) })],
  ])("rejects %s before transport", async (_name, transaction) => {
    const transport = transportFrom();
    const exchanger = createExchanger(transport);

    await expect(
      exchange(exchanger, { transaction: transaction as ConsumedHostedLoginTransaction }),
    ).rejects.toEqual(new OidcAuthorizationCodeTokenExchangeConfigurationError());
    expect(transport).not.toHaveBeenCalled();
  });

  it("redacts hostile consumed-transaction getters before transport", async () => {
    const transport = transportFrom();
    const exchanger = createExchanger(transport);
    const transaction = Object.defineProperty({}, "issuer", {
      get: () => {
        throw new Error("secret-hostile-transaction");
      },
    });

    await expect(
      exchange(exchanger, { transaction: transaction as ConsumedHostedLoginTransaction }),
    ).rejects.toEqual(new OidcAuthorizationCodeTokenExchangeConfigurationError());
    try {
      await exchange(exchanger, { transaction: transaction as ConsumedHostedLoginTransaction });
    } catch (error) {
      expect(String(error)).not.toContain("secret-hostile-transaction");
    }
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    ["empty", ""],
    ["space", "code with space"],
    ["control", "code\nvalue"],
    ["non-ASCII", "códé"],
    ["oversized", "c".repeat(2_049)],
  ])("treats a %s authorization code as rejected without transport", async (_name, code) => {
    const transport = transportFrom();
    const exchanger = createExchanger(transport);

    await expect(exchange(exchanger, { code })).resolves.toBeNull();
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    ["non-Response result", async () => ({ status: 200 }) as unknown as Response],
    [
      "missing final URL",
      async () =>
        withoutFinalUrl(
          new Response(JSON.stringify(successfulBody()), {
            headers: {
              "content-type": "application/json",
              "cache-control": "no-store",
              pragma: "no-cache",
            },
          }),
        ),
    ],
    [
      "redirect status",
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.test/token" },
        }),
    ],
    ["no content", async () => new Response(null, { status: 204 })],
    ["server error", async () => tokenResponse({ error: "server_error" }, { status: 503 })],
    [
      "redirect evidence",
      async () => {
        const response = tokenResponse();
        Object.defineProperty(response, "redirected", { value: true });
        return response;
      },
    ],
    [
      "mismatched final URL",
      async () => {
        const response = tokenResponse();
        Object.defineProperty(response, "url", { value: "https://evil.test/token" });
        return response;
      },
    ],
  ] satisfies ReadonlyArray<readonly [string, OidcTokenEndpointTransport]>)(
    "maps %s to one redacted availability error",
    async (_name, implementation) => {
      const transport = transportFrom(implementation);
      await expect(exchange(createExchanger(transport))).rejects.toEqual(
        new OidcAuthorizationCodeTokenExchangeUnavailableError(),
      );
      expect(transport).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ["missing content type", async () => new Response(JSON.stringify(successfulBody()))],
    [
      "wrong content type",
      async () =>
        new Response(JSON.stringify(successfulBody()), {
          headers: {
            "content-type": "text/html",
            "cache-control": "no-store",
            pragma: "no-cache",
          },
        }),
    ],
    [
      "missing no-store",
      async () =>
        new Response(JSON.stringify(successfulBody()), {
          headers: { "content-type": "application/json", pragma: "no-cache" },
        }),
    ],
    [
      "missing no-cache pragma",
      async () =>
        new Response(JSON.stringify(successfulBody()), {
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        }),
    ],
    [
      "parameterized no-store directive",
      async () =>
        new Response(JSON.stringify(successfulBody()), {
          headers: {
            "content-type": "application/json",
            "cache-control": "no-store=invalid",
            pragma: "no-cache",
          },
        }),
    ],
    [
      "parameterized no-cache pragma",
      async () =>
        new Response(JSON.stringify(successfulBody()), {
          headers: {
            "content-type": "application/json",
            "cache-control": "no-store",
            pragma: "no-cache=invalid",
          },
        }),
    ],
    [
      "quoted no-store extension",
      async () =>
        new Response(JSON.stringify(successfulBody()), {
          headers: {
            "content-type": "application/json",
            "cache-control": 'ext="a,no-store,b"',
            pragma: "no-cache",
          },
        }),
    ],
    [
      "quoted no-cache extension",
      async () =>
        new Response(JSON.stringify(successfulBody()), {
          headers: {
            "content-type": "application/json",
            "cache-control": "no-store",
            pragma: 'ext="a,no-cache,b"',
          },
        }),
    ],
    [
      "declared oversized body",
      async () => tokenResponse(undefined, { headers: { "content-length": "65537" } }),
    ],
    [
      "mismatched declared body",
      async () => tokenResponse(undefined, { headers: { "content-length": "1" } }),
    ],
    [
      "streamed oversized body",
      async () =>
        new Response(new Uint8Array(65_537), {
          headers: {
            "content-type": "application/json",
            "cache-control": "no-store",
            pragma: "no-cache",
          },
        }),
    ],
    [
      "malformed UTF-8",
      async () =>
        new Response(new Uint8Array([0xc3, 0x28]), {
          headers: {
            "content-type": "application/json",
            "cache-control": "no-store",
            pragma: "no-cache",
          },
        }),
    ],
    [
      "malformed JSON",
      async () =>
        new Response("{", {
          headers: {
            "content-type": "application/json",
            "cache-control": "no-store",
            pragma: "no-cache",
          },
        }),
    ],
    [
      "too many response headers",
      async () => {
        const headers = new Headers({
          "content-type": "application/json",
          "cache-control": "no-store",
          pragma: "no-cache",
        });
        for (let index = 0; index < 65; index += 1) headers.set(`x-provider-${index}`, "v");
        return new Response(JSON.stringify(successfulBody()), { headers });
      },
    ],
    [
      "oversized response header",
      async () => tokenResponse(undefined, { headers: { "x-provider": "v".repeat(8_193) } }),
    ],
    [
      "oversized response header name",
      async () => tokenResponse(undefined, { headers: { [`x-${"n".repeat(127)}`]: "value" } }),
    ],
    [
      "oversized aggregate response headers",
      async () =>
        tokenResponse(undefined, {
          headers: Object.fromEntries(
            Array.from({ length: 5 }, (_, index) => [`x-provider-${index}`, "v".repeat(7_000)]),
          ),
        }),
    ],
    [
      "transport rejection",
      async () => {
        throw new Error("secret-upstream-details");
      },
    ],
  ] satisfies ReadonlyArray<readonly [string, OidcTokenEndpointTransport]>)(
    "rejects and redacts a %s",
    async (_name, implementation) => {
      const transport = transportFrom(implementation);
      await expect(exchange(createExchanger(transport))).rejects.toEqual(
        new OidcAuthorizationCodeTokenExchangeUnavailableError(),
      );
      try {
        await exchange(createExchanger(transport));
      } catch (error) {
        expect(String(error)).not.toContain("secret-upstream-details");
        expect(String(error)).not.toContain(CLIENT_SECRET);
        expect(String(error)).not.toContain(AUTHORIZATION_CODE);
      }
    },
  );

  it("maps a bounded invalid_grant rejection to null without exposing provider details", async () => {
    const transport = transportFrom(async () =>
      tokenResponse(
        {
          error: "invalid_grant",
          error_description: `code ${AUTHORIZATION_CODE} verifier ${PKCE_VERIFIER}`,
          error_uri: "https://issuer.schedule.test/errors/invalid_grant",
        },
        { status: 400 },
      ),
    );

    await expect(exchange(createExchanger(transport))).resolves.toBeNull();
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["missing error", {}],
    ["non-string error", { error: 123 }],
    ["malformed error", { error: "INVALID GRANT" }],
    ["top-level array", [{ error: "invalid_grant" }]],
  ])("rejects a malformed 400 OAuth response: %s", async (_name, value) => {
    const transport = transportFrom(async () => tokenResponse(value, { status: 400 }));
    await expect(exchange(createExchanger(transport))).rejects.toEqual(
      new OidcAuthorizationCodeTokenExchangeUnavailableError(),
    );
  });

  it("treats a 401 invalid-client response as an operational failure", async () => {
    const transport = transportFrom(async () =>
      tokenResponse({ error: "invalid_client" }, { status: 401 }),
    );
    await expect(exchange(createExchanger(transport))).rejects.toEqual(
      new OidcAuthorizationCodeTokenExchangeUnavailableError(),
    );
  });

  it.each(["invalid_client", "invalid_request", "unauthorized_client"])(
    "treats a 400 %s response as an operational failure",
    async (error) => {
      const transport = transportFrom(async () => tokenResponse({ error }, { status: 400 }));
      await expect(exchange(createExchanger(transport))).rejects.toEqual(
        new OidcAuthorizationCodeTokenExchangeUnavailableError(),
      );
    },
  );

  it.each([
    ["top-level null", null],
    ["top-level array", []],
    ["missing access token", successfulBody({ access_token: undefined })],
    ["empty access token", successfulBody({ access_token: "" })],
    ["access token control", successfulBody({ access_token: "access\ntoken" })],
    ["oversized access token", successfulBody({ access_token: "a".repeat(16_385) })],
    ["missing token type", successfulBody({ token_type: undefined })],
    ["unsupported token type", successfulBody({ token_type: "MAC" })],
    ["missing ID token", successfulBody({ id_token: undefined })],
    ["non-compact ID token", successfulBody({ id_token: "not-a-jwt" })],
    ["oversized ID token", successfulBody({ id_token: `${"a".repeat(16_381)}.b.c` })],
    ["refresh token control", successfulBody({ refresh_token: "refresh\ntoken" })],
    ["invalid expiry", successfulBody({ expires_in: -1 })],
    ["oversized expiry", successfulBody({ expires_in: 315_360_001 })],
    ["invalid scope", successfulBody({ scope: "openid\\profile" })],
  ])("returns null for an unusable successful response: %s", async (_name, value) => {
    const transport = transportFrom(async () => tokenResponse(value));
    await expect(exchange(createExchanger(transport))).resolves.toBeNull();
  });

  it("accepts JSON parameters, case-insensitive Bearer, and absent optional fields", async () => {
    const transport = transportFrom(async () =>
      tokenResponse(
        successfulBody({
          token_type: "bEaReR",
          expires_in: undefined,
          refresh_token: undefined,
          scope: undefined,
        }),
        { headers: { "content-type": "application/json; charset=utf-8" } },
      ),
    );

    await expect(exchange(createExchanger(transport))).resolves.toEqual({ idToken: ID_TOKEN });
  });

  it("hard-bounds a transport that ignores abort and never retries", async () => {
    vi.useFakeTimers();
    let observedAbort = false;
    const transport = transportFrom(async (_resource, options) => {
      options.signal?.addEventListener("abort", () => {
        observedAbort = true;
      });
      return new Promise<Response>(() => undefined);
    });
    const pending = exchange(createExchanger(transport));
    const rejection = expect(pending).rejects.toEqual(
      new OidcAuthorizationCodeTokenExchangeUnavailableError(),
    );

    await vi.advanceTimersByTimeAsync(3_001);

    await rejection;
    expect(observedAbort).toBe(true);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("hard-bounds a response body that never finishes", async () => {
    vi.useFakeTimers();
    let observedAbort = false;
    let bodyCancelled = false;
    const transport = transportFrom(async (_resource, options) => {
      options.signal?.addEventListener("abort", () => {
        observedAbort = true;
      });
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"access_token":"pending"'));
        },
        cancel() {
          bodyCancelled = true;
        },
      });
      return new Response(stream, {
        headers: {
          "content-type": "application/json",
          "cache-control": "no-store",
          pragma: "no-cache",
        },
      });
    });
    const pending = exchange(createExchanger(transport));
    const rejection = expect(pending).rejects.toEqual(
      new OidcAuthorizationCodeTokenExchangeUnavailableError(),
    );

    await vi.advanceTimersByTimeAsync(3_001);

    await rejection;
    await vi.runAllTicks();
    expect(observedAbort).toBe(true);
    expect(bodyCancelled).toBe(true);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the hard-deadline timer after a rejected operation", async () => {
    vi.useFakeTimers();
    const transport = transportFrom(async () => {
      throw new Error("secret-upstream-details");
    });

    await expect(exchange(createExchanger(transport))).rejects.toEqual(
      new OidcAuthorizationCodeTokenExchangeUnavailableError(),
    );
    expect(transport).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the hard-deadline timer after a successful response", async () => {
    vi.useFakeTimers();
    let observedSignal: AbortSignal | null | undefined;
    const transport = transportFrom(async (_resource, options) => {
      observedSignal = options.signal;
      return tokenResponse();
    });

    await expect(exchange(createExchanger(transport))).resolves.toEqual({ idToken: ID_TOKEN });
    expect(observedSignal?.aborted).toBe(false);
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(3_001);

    expect(observedSignal?.aborted).toBe(false);
  });
});
