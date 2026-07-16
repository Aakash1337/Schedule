import type { IssuedHostedLoginTransaction } from "@schedule/application";
import { describe, expect, it } from "vitest";

import {
  OidcAuthorizationRequestConfigurationError,
  StrictOidcAuthorizationRequestBuilder,
  type OidcAuthorizationRequestConfiguration,
} from "./oidc-authorization-request.js";

const ISSUER = "https://issuer.schedule.test/tenant";
const AUTHORIZATION_ENDPOINT = "https://login.schedule.test/oauth2/authorize";
const CLIENT_ID = "schedule-hosted-client";
const REDIRECT_URI = "https://schedule.test/v1/auth/callback";
const STATE = "S".repeat(43);
const BROWSER_BINDING = "B".repeat(43);
const NONCE = "N".repeat(43);
const PKCE_CHALLENGE = "P".repeat(43);

function configuration(
  overrides: Partial<OidcAuthorizationRequestConfiguration> = {},
): OidcAuthorizationRequestConfiguration {
  return {
    issuer: ISSUER,
    authorizationEndpoint: AUTHORIZATION_ENDPOINT,
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    scopes: ["profile", "openid", "email"],
    ...overrides,
  };
}

function issued(
  overrides: Partial<IssuedHostedLoginTransaction> = {},
): IssuedHostedLoginTransaction {
  return {
    issuer: ISSUER,
    clientId: CLIENT_ID,
    redirectUri: REDIRECT_URI,
    state: STATE,
    browserBinding: BROWSER_BINDING,
    nonce: NONCE,
    pkceChallenge: PKCE_CHALLENGE,
    pkceMethod: "S256",
    expiresAt: new Date("2099-07-16T12:15:00.000Z"),
    ...overrides,
  };
}

function expectStableConfigurationError(error: unknown): void {
  expect(error).toBeInstanceOf(OidcAuthorizationRequestConfigurationError);
  expect(error).toMatchObject({
    name: "OidcAuthorizationRequestConfigurationError",
    code: "hosted_oidc.authorization_request_invalid",
    message: "The hosted OIDC authorization request could not be created.",
  });
}

describe("StrictOidcAuthorizationRequestBuilder", () => {
  it("builds one deterministic authorization-code request from exact transaction values", () => {
    const result = new StrictOidcAuthorizationRequestBuilder(configuration()).build(issued());
    const url = new URL(result.url);

    expect(Object.isFrozen(result)).toBe(true);
    expect(url.origin).toBe("https://login.schedule.test");
    expect(url.pathname).toBe("/oauth2/authorize");
    expect([...url.searchParams.keys()]).toEqual([
      "response_type",
      "client_id",
      "redirect_uri",
      "scope",
      "state",
      "nonce",
      "code_challenge",
      "code_challenge_method",
    ]);
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scope: "openid email profile",
      state: STATE,
      nonce: NONCE,
      code_challenge: PKCE_CHALLENGE,
      code_challenge_method: "S256",
    });
    for (const name of url.searchParams.keys())
      expect(url.searchParams.getAll(name)).toHaveLength(1);
  });

  it("canonicalizes scope order and snapshots mutable configuration", () => {
    const scopes = ["z-scope", "openid", "a-scope"];
    const mutable = { ...configuration(), scopes };
    const builder = new StrictOidcAuthorizationRequestBuilder(mutable);
    scopes.splice(0, scopes.length, "openid", "mutated");
    mutable.clientId = "mutated-client";
    mutable.redirectUri = "https://attacker.example/callback";

    const params = new URL(builder.build(issued()).url).searchParams;
    expect(params.get("scope")).toBe("openid a-scope z-scope");
    expect(params.get("client_id")).toBe(CLIENT_ID);
    expect(params.get("redirect_uri")).toBe(REDIRECT_URI);
  });

  it("reads accessor-backed scope elements exactly once before validating them", () => {
    const scopes = ["openid", "profile"];
    let reads = 0;
    Object.defineProperty(scopes, 1, {
      configurable: true,
      enumerable: true,
      get() {
        reads += 1;
        return reads === 1 ? "profile" : "bad scope";
      },
    });

    const builder = new StrictOidcAuthorizationRequestBuilder(configuration({ scopes }));
    expect(new URL(builder.build(issued()).url).searchParams.get("scope")).toBe("openid profile");
    expect(reads).toBe(1);
  });

  it("percent-encodes trusted values without allowing parameter injection", () => {
    const clientId = "client&prompt=none";
    const redirectUri = "https://schedule.test/v1/auth/callback?tenant=a&next=/today";
    const builder = new StrictOidcAuthorizationRequestBuilder(
      configuration({
        clientId,
        redirectUri,
        scopes: ["openid", "profile&admin=true"],
      }),
    );
    const url = new URL(builder.build(issued({ clientId, redirectUri })).url);

    expect(url.searchParams.get("client_id")).toBe(clientId);
    expect(url.searchParams.get("redirect_uri")).toBe(redirectUri);
    expect(url.searchParams.get("scope")).toBe("openid profile&admin=true");
    expect(url.searchParams.has("prompt")).toBe(false);
    expect(url.searchParams.has("admin")).toBe(false);
  });

  it("retains trusted non-reserved authorization endpoint query parameters", () => {
    const builder = new StrictOidcAuthorizationRequestBuilder(
      configuration({ authorizationEndpoint: `${AUTHORIZATION_ENDPOINT}?tenant=acme&ui=branded` }),
    );
    const url = new URL(builder.build(issued()).url);

    expect(url.searchParams.get("tenant")).toBe("acme");
    expect(url.searchParams.get("ui")).toBe("branded");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.getAll("state")).toEqual([STATE]);
  });

  it.each([
    ["missing configuration", null],
    ["blank issuer", configuration({ issuer: " " })],
    ["malformed issuer", configuration({ issuer: "not-a-url" })],
    ["unsafe issuer whitespace", configuration({ issuer: "https://issuer.schedule.test/a b" })],
    ["non-HTTPS issuer", configuration({ issuer: "http://issuer.schedule.test" })],
    ["issuer credentials", configuration({ issuer: "https://user:pass@issuer.schedule.test" })],
    ["issuer query", configuration({ issuer: `${ISSUER}?tenant=private` })],
    ["issuer fragment", configuration({ issuer: `${ISSUER}#private` })],
    ["oversized issuer", configuration({ issuer: `https://issuer.test/${"i".repeat(2_100)}` })],
    ["blank authorization endpoint", configuration({ authorizationEndpoint: " " })],
    ["malformed authorization endpoint", configuration({ authorizationEndpoint: "not-a-url" })],
    [
      "unsafe authorization endpoint backslash",
      configuration({ authorizationEndpoint: "https://login.schedule.test/oauth2\\authorize" }),
    ],
    [
      "non-HTTPS authorization endpoint",
      configuration({ authorizationEndpoint: "http://login.schedule.test/authorize" }),
    ],
    [
      "authorization endpoint credentials",
      configuration({ authorizationEndpoint: "https://user:pass@login.schedule.test/authorize" }),
    ],
    [
      "authorization endpoint control-bearing query",
      configuration({ authorizationEndpoint: `${AUTHORIZATION_ENDPOINT}?tenant=acme%0Aprivate` }),
    ],
    [
      "too many authorization endpoint query parameters",
      configuration({
        authorizationEndpoint: `${AUTHORIZATION_ENDPOINT}?${Array.from(
          { length: 17 },
          (_value, index) => `p${String(index)}=v`,
        ).join("&")}`,
      }),
    ],
    [
      "authorization endpoint fragment",
      configuration({ authorizationEndpoint: `${AUTHORIZATION_ENDPOINT}#private` }),
    ],
    [
      "oversized authorization endpoint",
      configuration({ authorizationEndpoint: `https://login.test/${"a".repeat(2_100)}` }),
    ],
    ["blank client identifier", configuration({ clientId: " " })],
    ["trimmed client identifier", configuration({ clientId: " client" })],
    ["control-bearing client identifier", configuration({ clientId: "client\nidentifier" })],
    ["oversized client identifier", configuration({ clientId: "c".repeat(513) })],
    ["non-HTTPS redirect URI", configuration({ redirectUri: "http://schedule.test/callback" })],
    [
      "redirect URI credentials",
      configuration({ redirectUri: "https://user:pass@schedule.test/callback" }),
    ],
    ["redirect URI fragment", configuration({ redirectUri: `${REDIRECT_URI}#private` })],
    [
      "control-bearing redirect URI",
      configuration({ redirectUri: "https://schedule.test/call\nback" }),
    ],
    [
      "oversized redirect URI",
      configuration({ redirectUri: `https://schedule.test/${"r".repeat(2_100)}` }),
    ],
    ["missing scope array", configuration({ scopes: undefined as never })],
    ["empty scope array", configuration({ scopes: [] })],
    ["too many scopes", configuration({ scopes: ["openid", ...Array(16).fill("scope")] })],
    ["missing openid scope", configuration({ scopes: ["profile", "email"] })],
    ["duplicate scope", configuration({ scopes: ["openid", "profile", "profile"] })],
    ["blank scope", configuration({ scopes: ["openid", ""] })],
    ["space-bearing scope", configuration({ scopes: ["openid", "read write"] })],
    ["quote-bearing scope", configuration({ scopes: ["openid", 'profile"admin'] })],
    ["backslash-bearing scope", configuration({ scopes: ["openid", "profile\\admin"] })],
    ["non-ASCII scope", configuration({ scopes: ["openid", "profilé"] })],
    ["control-bearing scope", configuration({ scopes: ["openid", "profile\nadmin"] })],
    ["oversized scope", configuration({ scopes: ["openid", "s".repeat(129)] })],
    [
      "oversized combined scope value",
      configuration({
        scopes: [
          "openid",
          "a".repeat(120),
          "b".repeat(120),
          "c".repeat(120),
          "d".repeat(120),
          "e".repeat(120),
        ],
      }),
    ],
  ])("rejects invalid trusted configuration: %s", (_name, candidate) => {
    expect(
      () =>
        new StrictOidcAuthorizationRequestBuilder(
          candidate as OidcAuthorizationRequestConfiguration,
        ),
    ).toThrowError(OidcAuthorizationRequestConfigurationError);
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
  ])("rejects a trusted endpoint query collision with %s", (parameter) => {
    expect(
      () =>
        new StrictOidcAuthorizationRequestBuilder(
          configuration({
            authorizationEndpoint: `${AUTHORIZATION_ENDPOINT}?${parameter}=provider-fixed`,
          }),
        ),
    ).toThrowError(OidcAuthorizationRequestConfigurationError);
  });

  it("rejects malformed builder options before retaining configuration", () => {
    expect(
      () =>
        new StrictOidcAuthorizationRequestBuilder(configuration(), {
          clock: 1 as unknown as () => Date,
        }),
    ).toThrowError(OidcAuthorizationRequestConfigurationError);
    expect(
      () =>
        new StrictOidcAuthorizationRequestBuilder(
          configuration(),
          null as unknown as { clock: () => Date },
        ),
    ).toThrowError(OidcAuthorizationRequestConfigurationError);
  });

  it.each([
    ["missing transaction", null],
    ["wrong issuer", issued({ issuer: `${ISSUER}/other` })],
    ["malformed issuer", issued({ issuer: "not-a-url" })],
    ["wrong client identifier", issued({ clientId: "another-client" })],
    ["malformed client identifier", issued({ clientId: "client\nidentifier" })],
    ["wrong redirect URI", issued({ redirectUri: `${REDIRECT_URI}/other` })],
    ["malformed redirect URI", issued({ redirectUri: "not-a-url" })],
    ["malformed state", issued({ state: "too-short" })],
    ["malformed browser binding", issued({ browserBinding: "too-short" })],
    ["malformed nonce", issued({ nonce: "too-short" })],
    ["malformed PKCE challenge", issued({ pkceChallenge: "too-short" })],
    ["wrong PKCE method", issued({ pkceMethod: "plain" as "S256" })],
    ["invalid expiry", issued({ expiresAt: new Date(Number.NaN) })],
    ["non-Date expiry", issued({ expiresAt: "2026-07-16" as unknown as Date })],
  ])("rejects inconsistent issued transaction material: %s", (_name, transaction) => {
    expect(() =>
      new StrictOidcAuthorizationRequestBuilder(configuration()).build(
        transaction as IssuedHostedLoginTransaction,
      ),
    ).toThrowError(OidcAuthorizationRequestConfigurationError);
  });

  it("bounds the final percent-encoded authorization URL", () => {
    const redirectUri = `https://schedule.test/${"☃".repeat(1_000)}`;
    const builder = new StrictOidcAuthorizationRequestBuilder(configuration({ redirectUri }));

    expect(() => builder.build(issued({ redirectUri }))).toThrowError(
      OidcAuthorizationRequestConfigurationError,
    );
  });

  it("requires the transaction to remain usable at the exact trusted clock boundary", () => {
    const now = new Date("2026-07-16T12:00:00.000Z");
    const builder = new StrictOidcAuthorizationRequestBuilder(configuration(), {
      clock: () => new Date(now),
    });

    expect(() => builder.build(issued({ expiresAt: new Date(now) }))).toThrowError(
      OidcAuthorizationRequestConfigurationError,
    );
    expect(() => builder.build(issued({ expiresAt: new Date(now.getTime() + 1) }))).not.toThrow();
  });

  it("maps clock and hostile getter failures to the stable redacted error", () => {
    const privateFailure = "private getter or clock details";
    const hostileConfiguration = new Proxy(configuration(), {
      get() {
        throw new Error(privateFailure);
      },
    });
    let configurationFailure: unknown;
    try {
      new StrictOidcAuthorizationRequestBuilder(hostileConfiguration);
    } catch (error) {
      configurationFailure = error;
    }
    expectStableConfigurationError(configurationFailure);
    expect(String(configurationFailure)).not.toContain(privateFailure);

    const hostileTransaction = new Proxy(issued(), {
      get() {
        throw new Error(privateFailure);
      },
    });
    const failingClockBuilder = new StrictOidcAuthorizationRequestBuilder(configuration(), {
      clock: () => {
        throw new Error(privateFailure);
      },
    });
    const invalidClockBuilder = new StrictOidcAuthorizationRequestBuilder(configuration(), {
      clock: () => new Date(Number.NaN),
    });
    for (const operation of [
      () => new StrictOidcAuthorizationRequestBuilder(configuration()).build(hostileTransaction),
      () => failingClockBuilder.build(issued()),
      () => invalidClockBuilder.build(issued()),
    ]) {
      let caught: unknown;
      try {
        operation();
      } catch (error) {
        caught = error;
      }
      expectStableConfigurationError(caught);
      expect(String(caught)).not.toContain(privateFailure);
    }
  });

  it("never exposes supplied configuration or transaction values in its failure", () => {
    const privateIssuer = "https://private-issuer.example/secret-tenant";
    const privateState = "Q".repeat(43);
    const builder = new StrictOidcAuthorizationRequestBuilder(
      configuration({ issuer: privateIssuer }),
    );

    let caught: unknown;
    try {
      builder.build(issued({ state: privateState }));
    } catch (error) {
      caught = error;
    }

    expectStableConfigurationError(caught);
    const serialized = JSON.stringify(caught);
    expect(String(caught)).not.toContain(privateIssuer);
    expect(String(caught)).not.toContain(privateState);
    expect(serialized).not.toContain(privateIssuer);
    expect(serialized).not.toContain(privateState);
  });
});
