import {
  exportJWK,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type FetchImplementation,
  type JWK,
} from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  JoseOidcIdTokenVerifier,
  OidcIdTokenVerificationUnavailableError,
} from "./oidc-id-token-verifier.js";
import {
  createOidcRemoteJwksResolver,
  OidcRemoteJwksResolverConfigurationError,
  type OidcRemoteJwksResolverOptions,
} from "./oidc-remote-jwks-resolver.js";

const NOW = new Date("2026-07-16T12:00:00.000Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1_000);
const ISSUER = "https://issuer.schedule.test/tenant";
const JWKS_URI = "https://keys.schedule.test/oidc/jwks.json?provider=schedule";
const CLIENT_ID = "schedule-hosted-client";
const NONCE = "N".repeat(43);
const SUBJECT = "provider-subject-123";
const PRIMARY_KEY_ID = "provider-key-1";
const ROTATED_KEY_ID = "provider-key-2";

let primaryPrivateKey: CryptoKey;
let rotatedPrivateKey: CryptoKey;
let primaryPublicJwk: JWK;
let rotatedPublicJwk: JWK;

beforeAll(async () => {
  const primary = await generateKeyPair("RS256", { extractable: true });
  const rotated = await generateKeyPair("RS256", { extractable: true });
  primaryPrivateKey = primary.privateKey;
  rotatedPrivateKey = rotated.privateKey;
  primaryPublicJwk = {
    ...(await exportJWK(primary.publicKey)),
    alg: "RS256",
    kid: PRIMARY_KEY_ID,
    use: "sig",
  };
  rotatedPublicJwk = {
    ...(await exportJWK(rotated.publicKey)),
    alg: "RS256",
    kid: ROTATED_KEY_ID,
    use: "sig",
  };
});

afterEach(() => {
  vi.useRealTimers();
});

function jwksResponse(
  keys: readonly JWK[] = [primaryPublicJwk],
  init: ResponseInit = {},
): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/jwk-set+json");
  return new Response(JSON.stringify({ keys }), { ...init, headers });
}

function transportFrom(
  implementation: FetchImplementation = async () => jwksResponse(),
): FetchImplementation & ReturnType<typeof vi.fn> {
  return vi.fn(implementation) as FetchImplementation & ReturnType<typeof vi.fn>;
}

function createResolver(
  transport: FetchImplementation,
  overrides: Partial<OidcRemoteJwksResolverOptions> = {},
) {
  return createOidcRemoteJwksResolver({
    issuer: ISSUER,
    jwksUri: JWKS_URI,
    transport,
    ...overrides,
  });
}

function createVerifier(
  keyResolver: ReturnType<typeof createResolver>["keyResolver"],
  keyResolutionTimeoutMilliseconds = 1_000,
) {
  return new JoseOidcIdTokenVerifier({
    keyResolver,
    algorithms: ["RS256"],
    clock: () => new Date(NOW),
    clockToleranceSeconds: 60,
    maxTokenAgeSeconds: 900,
    keyResolutionTimeoutMilliseconds,
  });
}

async function sign(
  key: CryptoKey = primaryPrivateKey,
  kid = PRIMARY_KEY_ID,
  extraHeader: Readonly<Record<string, unknown>> = {},
): Promise<string> {
  return new SignJWT({
    iss: ISSUER,
    sub: SUBJECT,
    aud: CLIENT_ID,
    exp: NOW_SECONDS + 300,
    iat: NOW_SECONDS - 30,
    nonce: NONCE,
  })
    .setProtectedHeader({ alg: "RS256", kid, typ: "JWT", ...extraHeader })
    .sign(key);
}

async function verifyWith(transport: FetchImplementation, token?: string) {
  const resolver = createResolver(transport);
  return createVerifier(resolver.keyResolver).verify({
    idToken: token ?? (await sign()),
    issuer: ISSUER,
    clientId: CLIENT_ID,
    expectedNonce: NONCE,
  });
}

describe("createOidcRemoteJwksResolver", () => {
  it("binds an exact provider snapshot to a frozen cached resolver", async () => {
    const transport = transportFrom();
    const source = { issuer: ISSUER, jwksUri: JWKS_URI, transport };
    const resolver = createOidcRemoteJwksResolver(source);
    source.issuer = "https://changed.schedule.test/tenant";
    source.jwksUri = "https://changed.schedule.test/jwks.json";

    expect(Object.isFrozen(resolver)).toBe(true);
    expect(resolver.issuer).toBe(ISSUER);
    expect(resolver.jwksUri).toBe(JWKS_URI);
    expect(
      await createVerifier(resolver.keyResolver).verify({
        idToken: await sign(),
        issuer: ISSUER,
        clientId: CLIENT_ID,
        expectedNonce: NONCE,
      }),
    ).toEqual({ issuer: ISSUER, subject: SUBJECT });
  });

  it("reads accessor-backed configuration exactly once", () => {
    const transport = transportFrom();
    const reads = { issuer: 0, jwksUri: 0, transport: 0 };
    const options = Object.defineProperties(
      {},
      {
        issuer: { enumerable: true, get: () => ((reads.issuer += 1), ISSUER) },
        jwksUri: { enumerable: true, get: () => ((reads.jwksUri += 1), JWKS_URI) },
        transport: { enumerable: true, get: () => ((reads.transport += 1), transport) },
      },
    ) as OidcRemoteJwksResolverOptions;

    const resolver = createOidcRemoteJwksResolver(options);

    expect(reads).toEqual({ issuer: 1, jwksUri: 1, transport: 1 });
    expect(resolver).toMatchObject({ issuer: ISSUER, jwksUri: JWKS_URI });
  });

  it("redacts hostile configuration getters", () => {
    const options = Object.defineProperty({}, "issuer", {
      get: () => {
        throw new Error("secret-provider-config");
      },
    });

    expect(() => createOidcRemoteJwksResolver(options as OidcRemoteJwksResolverOptions)).toThrow(
      new OidcRemoteJwksResolverConfigurationError(),
    );
    try {
      createOidcRemoteJwksResolver(options as OidcRemoteJwksResolverOptions);
    } catch (error) {
      expect(String(error)).not.toContain("secret-provider-config");
    }
  });

  it.each([
    ["non-object options", null],
    ["HTTP issuer", { issuer: "http://issuer.schedule.test", jwksUri: JWKS_URI }],
    ["issuer query", { issuer: `${ISSUER}?tenant=other`, jwksUri: JWKS_URI }],
    ["issuer fragment", { issuer: `${ISSUER}#fragment`, jwksUri: JWKS_URI }],
    ["issuer credentials", { issuer: "https://user:pass@issuer.schedule.test", jwksUri: JWKS_URI }],
    ["HTTP JWKS URI", { issuer: ISSUER, jwksUri: "http://keys.schedule.test/jwks.json" }],
    ["JWKS fragment", { issuer: ISSUER, jwksUri: `${JWKS_URI}#fragment` }],
    ["JWKS credentials", { issuer: ISSUER, jwksUri: "https://user@keys.schedule.test/jwks.json" }],
    [
      "noncanonical default port",
      { issuer: ISSUER, jwksUri: "https://keys.schedule.test:443/jwks.json" },
    ],
    ["noncanonical hostname", { issuer: ISSUER, jwksUri: "https://KEYS.schedule.test/jwks.json" }],
    ["raw whitespace", { issuer: ISSUER, jwksUri: "https://keys.schedule.test/jwks json" }],
    ["raw backslash", { issuer: ISSUER, jwksUri: "https://keys.schedule.test\\jwks.json" }],
    [
      "oversized URI",
      { issuer: ISSUER, jwksUri: `https://keys.schedule.test/${"a".repeat(2_100)}` },
    ],
    ["missing transport", { issuer: ISSUER, jwksUri: JWKS_URI, transport: undefined }],
  ])("rejects and redacts %s", (_name, partial) => {
    const value = partial === null ? null : { transport: transportFrom(), ...partial };
    expect(() => createOidcRemoteJwksResolver(value as OidcRemoteJwksResolverOptions)).toThrow(
      OidcRemoteJwksResolverConfigurationError,
    );
  });

  it("allows the interoperable root issuer spelling without a trailing slash", () => {
    const resolver = createResolver(transportFrom(), { issuer: "https://issuer.schedule.test" });
    expect(resolver.issuer).toBe("https://issuer.schedule.test");
  });

  it("makes one exact, credential-free GET and caches a valid key", async () => {
    const transport = transportFrom();
    const resolver = createResolver(transport);
    const verifier = createVerifier(resolver.keyResolver);
    const input = {
      idToken: await sign(),
      issuer: ISSUER,
      clientId: CLIENT_ID,
      expectedNonce: NONCE,
    };

    await expect(verifier.verify(input)).resolves.toEqual({ issuer: ISSUER, subject: SUBJECT });
    await expect(verifier.verify(input)).resolves.toEqual({ issuer: ISSUER, subject: SUBJECT });
    expect(transport).toHaveBeenCalledTimes(1);
    const [resource, options] = transport.mock.calls[0] as Parameters<FetchImplementation>;
    expect(resource).toBe(JWKS_URI);
    expect(options.method).toBe("GET");
    expect(options.redirect).toBe("manual");
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.headers.get("accept")).toContain("application/json");
    expect(options.headers.get("accept-encoding")).toBe("identity");
    expect(options.headers.has("authorization")).toBe(false);
    expect(options.headers.has("cookie")).toBe(false);
  });

  it.each([
    [
      "redirect",
      async () =>
        jwksResponse(undefined, { status: 302, headers: { location: "https://evil.test" } }),
    ],
    [
      "redirected successful response",
      async () => {
        const response = jwksResponse();
        Object.defineProperty(response, "redirected", { value: true });
        return response;
      },
    ],
    [
      "mismatched final response URL",
      async () => {
        const response = jwksResponse();
        Object.defineProperty(response, "url", {
          value: "https://keys.schedule.test/other/jwks.json",
        });
        return response;
      },
    ],
    ["no content", async () => new Response(null, { status: 204 })],
    ["server error", async () => jwksResponse(undefined, { status: 503 })],
    [
      "wrong media type",
      async () =>
        new Response(JSON.stringify({ keys: [primaryPublicJwk] }), {
          headers: { "content-type": "text/html" },
        }),
    ],
    [
      "declared oversized body",
      async () =>
        jwksResponse(undefined, {
          headers: { "content-type": "application/json", "content-length": "65537" },
        }),
    ],
    [
      "mismatched declared body",
      async () =>
        jwksResponse(undefined, {
          headers: { "content-type": "application/json", "content-length": "1" },
        }),
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
    [
      "missing keys",
      async () => new Response("{}", { headers: { "content-type": "application/json" } }),
    ],
    [
      "empty keys",
      async () => new Response('{"keys":[]}', { headers: { "content-type": "application/json" } }),
    ],
    [
      "non-object key",
      async () =>
        new Response('{"keys":[null]}', { headers: { "content-type": "application/json" } }),
    ],
    [
      "too many keys",
      async () =>
        new Response(JSON.stringify({ keys: Array.from({ length: 33 }, () => ({ kty: "RSA" })) }), {
          headers: { "content-type": "application/json" },
        }),
    ],
    [
      "streamed oversized body",
      async () =>
        new Response(new Uint8Array(65_537), { headers: { "content-type": "application/json" } }),
    ],
    [
      "transport rejection",
      async () => {
        throw new Error("secret-upstream-details");
      },
    ],
  ] satisfies ReadonlyArray<readonly [string, FetchImplementation]>)(
    "maps %s to one redacted verifier availability error",
    async (_name, implementation) => {
      const transport = transportFrom(implementation);
      await expect(verifyWith(transport)).rejects.toEqual(
        new OidcIdTokenVerificationUnavailableError(),
      );
      await expect(verifyWith(transport)).rejects.not.toThrow(/secret-upstream-details/u);
    },
  );

  it("accepts JSON media-type parameters", async () => {
    const transport = transportFrom(async () =>
      jwksResponse(undefined, { headers: { "content-type": "application/json; charset=utf-8" } }),
    );
    await expect(verifyWith(transport)).resolves.toEqual({ issuer: ISSUER, subject: SUBJECT });
  });

  it("hard-bounds an abort-ignoring transport and allows a later retry", async () => {
    vi.useFakeTimers();
    let calls = 0;
    let observedAbort = false;
    const transport = transportFrom(async (_resource, options) => {
      calls += 1;
      if (calls > 1) return jwksResponse();
      options.signal.addEventListener("abort", () => {
        observedAbort = true;
      });
      return new Promise<Response>(() => undefined);
    });
    const resolver = createResolver(transport);
    const verifier = createVerifier(resolver.keyResolver, 5_000);
    const input = {
      idToken: await sign(),
      issuer: ISSUER,
      clientId: CLIENT_ID,
      expectedNonce: NONCE,
    };
    const pending = verifier.verify(input);
    const rejection = expect(pending).rejects.toEqual(
      new OidcIdTokenVerificationUnavailableError(),
    );

    await vi.advanceTimersByTimeAsync(3_001);

    await rejection;
    expect(observedAbort).toBe(true);
    expect(transport).toHaveBeenCalledTimes(1);
    await expect(verifier.verify(input)).resolves.toEqual({ issuer: ISSUER, subject: SUBJECT });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("treats an unknown key as invalid credentials without attacker-driven reloads during cooldown", async () => {
    const transport = transportFrom();
    const resolver = createResolver(transport);
    const verifier = createVerifier(resolver.keyResolver);
    const token = await sign(rotatedPrivateKey, ROTATED_KEY_ID);
    const input = {
      idToken: token,
      issuer: ISSUER,
      clientId: CLIENT_ID,
      expectedNonce: NONCE,
    };

    await expect(verifier.verify(input)).resolves.toBeNull();
    await expect(verifier.verify(input)).resolves.toBeNull();
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("refreshes once after cooldown and accepts provider key rotation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    let calls = 0;
    const transport = transportFrom(async () => {
      calls += 1;
      return calls === 1 ? jwksResponse([primaryPublicJwk]) : jwksResponse([rotatedPublicJwk]);
    });
    const resolver = createResolver(transport);
    const verifier = createVerifier(resolver.keyResolver);

    await expect(
      verifier.verify({
        idToken: await sign(),
        issuer: ISSUER,
        clientId: CLIENT_ID,
        expectedNonce: NONCE,
      }),
    ).resolves.toEqual({ issuer: ISSUER, subject: SUBJECT });
    await vi.advanceTimersByTimeAsync(30_001);
    await expect(
      verifier.verify({
        idToken: await sign(rotatedPrivateKey, ROTATED_KEY_ID),
        issuer: ISSUER,
        clientId: CLIENT_ID,
        expectedNonce: NONCE,
      }),
    ).resolves.toEqual({ issuer: ISSUER, subject: SUBJECT });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("refreshes a matching cached key set after its five-minute maximum age", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const transport = transportFrom();
    const resolver = createResolver(transport);
    const verifier = createVerifier(resolver.keyResolver);
    const input = {
      idToken: await sign(),
      issuer: ISSUER,
      clientId: CLIENT_ID,
      expectedNonce: NONCE,
    };

    await expect(verifier.verify(input)).resolves.toEqual({ issuer: ISSUER, subject: SUBJECT });
    await vi.advanceTimersByTimeAsync(300_001);
    await expect(verifier.verify(input)).resolves.toEqual({ issuer: ISSUER, subject: SUBJECT });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight JWKS request across concurrent verification", async () => {
    let release!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const transport = transportFrom(async () => response);
    const resolver = createResolver(transport);
    const verifier = createVerifier(resolver.keyResolver);
    const input = {
      idToken: await sign(),
      issuer: ISSUER,
      clientId: CLIENT_ID,
      expectedNonce: NONCE,
    };

    const first = verifier.verify(input);
    const second = verifier.verify(input);
    await vi.waitFor(() => expect(transport).toHaveBeenCalledTimes(1));
    release(jwksResponse());

    await expect(Promise.all([first, second])).resolves.toEqual([
      { issuer: ISSUER, subject: SUBJECT },
      { issuer: ISSUER, subject: SUBJECT },
    ]);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it("rejects token-controlled jku before the resolver can reach transport", async () => {
    const transport = transportFrom();
    const resolver = createResolver(transport);
    const verifier = createVerifier(resolver.keyResolver);
    const token = await sign(primaryPrivateKey, PRIMARY_KEY_ID, {
      jku: "https://attacker.example.test/jwks.json",
    });

    await expect(
      verifier.verify({
        idToken: token,
        issuer: ISSUER,
        clientId: CLIENT_ID,
        expectedNonce: NONCE,
      }),
    ).resolves.toBeNull();
    expect(transport).not.toHaveBeenCalled();
  });
});
