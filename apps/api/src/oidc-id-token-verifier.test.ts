import {
  createLocalJWKSet,
  errors,
  exportJWK,
  generateKeyPair,
  SignJWT,
  UnsecuredJWT,
  type CryptoKey,
  type JWK,
  type JWTPayload,
  type JWTVerifyGetKey,
} from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  JoseOidcIdTokenVerifier,
  OidcIdTokenVerificationUnavailableError,
  type JoseOidcIdTokenVerifierOptions,
  type OidcIdTokenVerificationInput,
} from "./oidc-id-token-verifier.js";

const NOW = new Date("2026-07-16T12:00:00.000Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1_000);
const ISSUER = "https://issuer.schedule.test/tenant";
const CLIENT_ID = "schedule-hosted-client";
const NONCE = "N".repeat(43);
const SUBJECT = "provider-subject-123";
const KEY_ID = "provider-key-1";

let signingKey: CryptoKey;
let alternateSigningKey: CryptoKey;
let publicJwk: JWK;
let keyResolver: JWTVerifyGetKey;

beforeAll(async () => {
  const primary = await generateKeyPair("RS256", { extractable: true });
  const alternate = await generateKeyPair("RS256", { extractable: true });
  signingKey = primary.privateKey;
  alternateSigningKey = alternate.privateKey;
  publicJwk = {
    ...(await exportJWK(primary.publicKey)),
    alg: "RS256",
    kid: KEY_ID,
    use: "sig",
  };
  keyResolver = createLocalJWKSet({ keys: [publicJwk] });
});

function payload(overrides: Readonly<Record<string, unknown | undefined>> = {}): JWTPayload {
  const claims: JWTPayload = {
    iss: ISSUER,
    sub: SUBJECT,
    aud: CLIENT_ID,
    exp: NOW_SECONDS + 300,
    iat: NOW_SECONDS - 30,
    nonce: NONCE,
    email: "ignored-identity@example.test",
    name: "Ignored Display Name",
  };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete claims[name];
    else claims[name] = value;
  }
  return claims;
}

function protectedHeader(
  overrides: Readonly<Record<string, unknown | undefined>> = {},
): Record<string, unknown> {
  const header: Record<string, unknown> = { alg: "RS256", kid: KEY_ID, typ: "JWT" };
  for (const [name, value] of Object.entries(overrides)) {
    if (value === undefined) delete header[name];
    else header[name] = value;
  }
  return header;
}

async function sign(
  claimOverrides: Readonly<Record<string, unknown | undefined>> = {},
  headerOverrides: Readonly<Record<string, unknown | undefined>> = {},
  key: CryptoKey = signingKey,
): Promise<string> {
  const header = protectedHeader(headerOverrides);
  const criticalNames = Array.isArray(header.crit)
    ? header.crit.filter((name): name is string => typeof name === "string")
    : [];
  const signingOptions =
    criticalNames.length === 0
      ? undefined
      : { crit: Object.fromEntries(criticalNames.map((name) => [name, true])) };
  return new SignJWT(payload(claimOverrides)).setProtectedHeader(header).sign(key, signingOptions);
}

function createVerifier(
  overrides: Partial<JoseOidcIdTokenVerifierOptions> = {},
): JoseOidcIdTokenVerifier {
  return new JoseOidcIdTokenVerifier({
    keyResolver,
    algorithms: ["RS256"],
    clock: () => new Date(NOW),
    clockToleranceSeconds: 60,
    maxTokenAgeSeconds: 900,
    keyResolutionTimeoutMilliseconds: 1_000,
    ...overrides,
  });
}

function verificationInput(
  idToken: string,
  overrides: Partial<OidcIdTokenVerificationInput> = {},
): OidcIdTokenVerificationInput {
  return {
    idToken,
    issuer: ISSUER,
    clientId: CLIENT_ID,
    expectedNonce: NONCE,
    ...overrides,
  };
}

function expectStableUnavailable(error: unknown): void {
  expect(error).toBeInstanceOf(OidcIdTokenVerificationUnavailableError);
  expect(error).toMatchObject({
    name: "OidcIdTokenVerificationUnavailableError",
    code: "hosted_oidc.verification_unavailable",
    message: "Hosted OIDC identity verification is temporarily unavailable.",
  });
}

describe("JoseOidcIdTokenVerifier", () => {
  it("returns only the exact verified issuer and subject", async () => {
    const token = await sign();

    await expect(createVerifier().verify(verificationInput(token))).resolves.toEqual({
      issuer: ISSUER,
      subject: SUBJECT,
    });
  });

  it("uses bounded secure defaults when optional policy values are omitted", async () => {
    const currentSeconds = Math.floor(Date.now() / 1_000);
    const token = await sign({ iat: currentSeconds - 1, exp: currentSeconds + 120 });
    const verifier = new JoseOidcIdTokenVerifier({ keyResolver, algorithms: ["RS256"] });

    await expect(verifier.verify(verificationInput(token))).resolves.toEqual({
      issuer: ISSUER,
      subject: SUBJECT,
    });
  });

  it("accepts an optional active nbf claim and a correctly authorized multi-audience token", async () => {
    const token = await sign({
      aud: [CLIENT_ID, "schedule-companion-client"],
      azp: CLIENT_ID,
      nbf: NOW_SECONDS - 1,
    });

    await expect(createVerifier().verify(verificationInput(token))).resolves.toEqual({
      issuer: ISSUER,
      subject: SUBJECT,
    });
  });

  it("accepts a token at the exact configured age boundary", async () => {
    const token = await sign({ iat: NOW_SECONDS - 900 });

    await expect(createVerifier().verify(verificationInput(token))).resolves.toEqual({
      issuer: ISSUER,
      subject: SUBJECT,
    });
  });

  it.each([
    ["missing issuer", { iss: undefined }],
    ["wrong issuer", { iss: `${ISSUER}/other` }],
    ["missing subject", { sub: undefined }],
    ["empty subject", { sub: "" }],
    ["non-ASCII subject", { sub: "subject-☃" }],
    ["oversized subject", { sub: "s".repeat(256) }],
    ["missing audience", { aud: undefined }],
    ["wrong audience", { aud: "another-client" }],
    ["empty secondary audience", { aud: [CLIENT_ID, ""], azp: CLIENT_ID }],
    ["duplicate audience", { aud: [CLIENT_ID, CLIENT_ID], azp: CLIENT_ID }],
    ["multi-audience without azp", { aud: [CLIENT_ID, "another-client"] }],
    ["multi-audience with wrong azp", { aud: [CLIENT_ID, "another-client"], azp: "other" }],
    ["single audience with wrong azp", { azp: "other" }],
    ["missing nonce", { nonce: undefined }],
    ["wrong nonce", { nonce: "W".repeat(43) }],
    ["missing expiration", { exp: undefined }],
    ["expired beyond tolerance", { exp: NOW_SECONDS - 61 }],
    ["missing issued-at", { iat: undefined }],
    ["issued beyond the hard age cap despite clock tolerance", { iat: NOW_SECONDS - 901 }],
    ["issued in the future beyond tolerance", { iat: NOW_SECONDS + 61 }],
    ["zero-lifetime token", { iat: NOW_SECONDS + 30, exp: NOW_SECONDS + 30 }],
    ["future not-before beyond tolerance", { nbf: NOW_SECONDS + 61 }],
    ["not-before after expiration", { nbf: NOW_SECONDS + 301 }],
  ])("rejects a token with %s", async (_name, overrides) => {
    const token = await sign(overrides);

    await expect(createVerifier().verify(verificationInput(token))).resolves.toBeNull();
  });

  it("rejects a validly shaped token signed by the wrong key", async () => {
    const token = await sign({}, {}, alternateSigningKey);

    await expect(createVerifier().verify(verificationInput(token))).resolves.toBeNull();
  });

  it.each([
    ["missing kid", { kid: undefined }],
    ["empty kid", { kid: "" }],
    ["control-bearing kid", { kid: "provider\nkey" }],
    ["oversized kid", { kid: "k".repeat(257) }],
    ["untrusted jku", { jku: "https://attacker.example/jwks.json" }],
    ["untrusted x5u", { x5u: "https://attacker.example/certificate.pem" }],
    ["embedded jwk", { jwk: { kty: "RSA", kid: "attacker" } }],
    ["embedded x5c", { x5c: ["attacker-certificate"] }],
    ["critical extension", { crit: ["custom"], custom: true }],
    ["b64 extension", { b64: true }],
    ["unexpected typ", { typ: "access+jwt" }],
    ["non-string typ", { typ: 1 }],
  ])("rejects a token with %s before resolving a key", async (_name, headerOverrides) => {
    const resolver = vi.fn(keyResolver);
    const token = await sign({}, headerOverrides);

    await expect(
      createVerifier({ keyResolver: resolver }).verify(verificationInput(token)),
    ).resolves.toBeNull();
    expect(resolver).not.toHaveBeenCalled();
  });

  it("rejects an unknown key without treating it as an outage", async () => {
    const token = await sign({}, { kid: "unknown-key" });

    await expect(createVerifier().verify(verificationInput(token))).resolves.toBeNull();
  });

  it("rejects an ambiguous matching key set without treating it as an outage", async () => {
    const duplicateResolver = createLocalJWKSet({ keys: [publicJwk, { ...publicJwk }] });
    const token = await sign();

    await expect(
      createVerifier({ keyResolver: duplicateResolver }).verify(verificationInput(token)),
    ).resolves.toBeNull();
  });

  it("rejects symmetric and unsecured algorithms before resolving a key", async () => {
    const resolver = vi.fn(keyResolver);
    const symmetric = await new SignJWT(payload())
      .setProtectedHeader({ alg: "HS256", kid: KEY_ID, typ: "JWT" })
      .sign(new TextEncoder().encode("a-secret-that-is-long-enough-for-hs256"));
    const unsecured = new UnsecuredJWT(payload()).encode();
    const verifier = createVerifier({ keyResolver: resolver });

    await expect(verifier.verify(verificationInput(symmetric))).resolves.toBeNull();
    await expect(verifier.verify(verificationInput(unsecured))).resolves.toBeNull();
    expect(resolver).not.toHaveBeenCalled();
  });

  it.each([
    ["not compact", "not-a-jwt"],
    ["empty payload", "e30..signature"],
    ["invalid protected header", "not-json.cGF5bG9hZA.signature"],
    ["whitespace", "e30.cGF5bG9hZA.signature\n"],
    ["oversized", `e30.${"a".repeat(16 * 1_024)}.signature`],
  ])("rejects a %s token without resolving a key", async (_name, token) => {
    const resolver = vi.fn(keyResolver);

    await expect(
      createVerifier({ keyResolver: resolver }).verify(verificationInput(token)),
    ).resolves.toBeNull();
    expect(resolver).not.toHaveBeenCalled();
  });

  it("maps a signing-key resolver outage to a stable redacted operational failure", async () => {
    const token = await sign({ sub: "private-subject" });
    const privateFailure = "private jwks endpoint https://internal.example/token?secret=value";
    const verifier = createVerifier({
      keyResolver: async () => {
        throw new Error(privateFailure);
      },
    });

    let caught: unknown;
    try {
      await verifier.verify(verificationInput(token));
    } catch (error) {
      caught = error;
    }

    expectStableUnavailable(caught);
    const serialized = JSON.stringify(caught);
    expect(String(caught)).not.toContain(privateFailure);
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(NONCE);
    expect(serialized).not.toContain("private-subject");
    expect(serialized).not.toContain("internal.example");
  });

  it("maps a JWKS timeout to a stable operational failure", async () => {
    const token = await sign();
    const verifier = createVerifier({
      keyResolver: async () => {
        throw new errors.JWKSTimeout("private timeout details");
      },
    });

    await expect(verifier.verify(verificationInput(token))).rejects.toSatisfy((error: unknown) => {
      expectStableUnavailable(error);
      return true;
    });
  });

  it("bounds a stalled signing-key resolver with the same stable operational failure", async () => {
    const token = await sign();
    const verifier = createVerifier({
      keyResolver: () => new Promise(() => undefined),
      keyResolutionTimeoutMilliseconds: 100,
    });

    const startedAt = performance.now();
    await expect(verifier.verify(verificationInput(token))).rejects.toSatisfy((error: unknown) => {
      expectStableUnavailable(error);
      return true;
    });
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });

  it("re-samples time after a slow key lookup and rejects a token that expires while waiting", async () => {
    const events: string[] = [];
    const afterExpiry = new Date(NOW.getTime() + 2_000);
    const clock = vi
      .fn()
      .mockImplementationOnce(() => {
        events.push("clock-before");
        return new Date(NOW);
      })
      .mockImplementationOnce(() => {
        events.push("clock-after");
        return afterExpiry;
      });
    const delayedResolver: JWTVerifyGetKey = async (header, token) => {
      events.push("resolver-start");
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      events.push("resolver-end");
      return keyResolver(header, token);
    };
    const token = await sign({ exp: NOW_SECONDS + 1 });

    await expect(
      createVerifier({
        keyResolver: delayedResolver,
        clock,
        clockToleranceSeconds: 0,
      }).verify(verificationInput(token)),
    ).resolves.toBeNull();
    expect(events).toEqual(["clock-before", "resolver-start", "resolver-end", "clock-after"]);
    expect(clock).toHaveBeenCalledTimes(2);
  });

  it("maps an invalid resolver key and a failing clock to stable operational failures", async () => {
    const token = await sign();
    const invalidKeyResolver = (async () => ({ kty: "RSA" }) as JWK) as JWTVerifyGetKey;

    await expect(
      createVerifier({ keyResolver: invalidKeyResolver }).verify(verificationInput(token)),
    ).rejects.toBeInstanceOf(OidcIdTokenVerificationUnavailableError);
    await expect(
      createVerifier({
        clock: () => {
          throw new Error("private clock failure");
        },
      }).verify(verificationInput(token)),
    ).rejects.toBeInstanceOf(OidcIdTokenVerificationUnavailableError);
    await expect(
      createVerifier({ clock: () => new Date(Number.NaN) }).verify(verificationInput(token)),
    ).rejects.toBeInstanceOf(OidcIdTokenVerificationUnavailableError);
  });

  it.each([
    ["blank issuer", { issuer: " " }],
    ["malformed issuer", { issuer: "not a URL" }],
    ["non-HTTPS issuer", { issuer: "http://issuer.schedule.test" }],
    ["issuer query", { issuer: `${ISSUER}?tenant=private` }],
    ["blank client", { clientId: " " }],
    ["control-bearing client", { clientId: "client\nidentifier" }],
    ["malformed nonce", { expectedNonce: "too-short" }],
  ])("rejects inconsistent continuation metadata: %s", async (_name, overrides) => {
    const token = await sign();

    await expect(
      createVerifier().verify(verificationInput(token, overrides)),
    ).rejects.toBeInstanceOf(OidcIdTokenVerificationUnavailableError);
  });

  it.each([
    ["missing algorithms", { algorithms: undefined }],
    ["empty algorithms", { algorithms: [] }],
    ["duplicate algorithms", { algorithms: ["RS256", "RS256"] }],
    ["symmetric algorithm", { algorithms: ["HS256"] }],
    ["negative clock tolerance", { clockToleranceSeconds: -1 }],
    ["excessive clock tolerance", { clockToleranceSeconds: 121 }],
    ["zero max age", { maxTokenAgeSeconds: 0 }],
    ["excessive max age", { maxTokenAgeSeconds: 901 }],
    ["short key resolution timeout", { keyResolutionTimeoutMilliseconds: 99 }],
    ["long key resolution timeout", { keyResolutionTimeoutMilliseconds: 10_001 }],
  ])("fails closed on invalid verifier policy: %s", (_name, override) => {
    expect(
      () =>
        new JoseOidcIdTokenVerifier({
          keyResolver,
          algorithms: ["RS256"],
          clock: () => new Date(NOW),
          ...override,
        } as JoseOidcIdTokenVerifierOptions),
    ).toThrowError(OidcIdTokenVerificationUnavailableError);
  });
});
