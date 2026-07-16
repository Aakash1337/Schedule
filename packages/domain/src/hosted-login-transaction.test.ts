import { describe, expect, it } from "vitest";

import {
  consumeHostedLoginTransaction,
  createHostedLoginTransaction,
  hostedLoginTransactionIsUsable,
} from "./hosted-login-transaction.js";

const now = new Date("2026-07-16T00:00:00.000Z");

function validInput() {
  return {
    stateDigest: "a".repeat(64),
    browserBindingDigest: "b".repeat(64),
    issuer: "https://identity.example/tenant",
    clientId: "schedule-web",
    redirectUri: "https://schedule.example/v1/auth/callback",
    returnToPath: "/today?from=login",
    nonce: "N".repeat(43),
    pkceChallenge: "C".repeat(43),
    protectedPkceVerifier: "v1.primary.ciphertext",
    ttlSeconds: 300,
    now,
  } as const;
}

describe("hosted login transaction domain", () => {
  it("creates a bounded S256 transaction without plaintext state or browser binding", () => {
    const transaction = createHostedLoginTransaction(validInput());
    expect(transaction).toMatchObject({
      pkceMethod: "S256",
      consumedAt: null,
      version: 1,
      expiresAt: new Date("2026-07-16T00:05:00.000Z"),
    });
    expect(transaction).not.toHaveProperty("state");
    expect(transaction).not.toHaveProperty("browserBinding");
    expect(transaction).not.toHaveProperty("pkceVerifier");
  });

  it("is usable strictly before expiry and consumes exactly once in the domain", () => {
    const transaction = createHostedLoginTransaction(validInput());
    expect(hostedLoginTransactionIsUsable(transaction, new Date("2026-07-16T00:04:59.999Z"))).toBe(
      true,
    );
    expect(hostedLoginTransactionIsUsable(transaction, new Date("2026-07-16T00:05:00.000Z"))).toBe(
      false,
    );

    const consumed = consumeHostedLoginTransaction(
      transaction,
      new Date("2026-07-16T00:01:00.000Z"),
    );
    expect(consumed).toMatchObject({
      consumedAt: new Date("2026-07-16T00:01:00.000Z"),
      version: 2,
    });
    expect(() => consumeHostedLoginTransaction(consumed, consumed.consumedAt!)).toThrowError(
      expect.objectContaining({ code: "hosted_login_transaction.unavailable" }),
    );
  });

  it.each([
    ["state digest", { stateDigest: "plaintext" }, "state_digest_invalid"],
    ["browser digest", { browserBindingDigest: "plaintext" }, "browser_binding_digest_invalid"],
    ["insecure issuer", { issuer: "http://identity.example" }, "issuer_invalid"],
    ["issuer query", { issuer: "https://identity.example/?tenant=a" }, "issuer_invalid"],
    [
      "redirect fragment",
      { redirectUri: "https://schedule.example/callback#token" },
      "redirect_uri_invalid",
    ],
    ["external return path", { returnToPath: "//evil.example" }, "return_to_invalid"],
    ["short nonce", { nonce: "short" }, "nonce_invalid"],
    ["short challenge", { pkceChallenge: "short" }, "pkce_challenge_invalid"],
    ["short TTL", { ttlSeconds: 59 }, "ttl_invalid"],
    ["long TTL", { ttlSeconds: 901 }, "ttl_invalid"],
  ] as const)("rejects invalid %s", (_label, override, code) => {
    expect(() => createHostedLoginTransaction({ ...validInput(), ...override })).toThrowError(
      expect.objectContaining({ code: `hosted_login_transaction.${code}` }),
    );
  });
});
