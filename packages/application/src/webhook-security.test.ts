import { describe, expect, it } from "vitest";

import {
  WebhookSecurityError,
  decryptWebhookSigningSecret,
  encryptWebhookSigningSecret,
  generateWebhookSigningSecret,
  sha256WebhookBody,
  signWebhookDelivery,
  verifyWebhookSignature,
} from "./webhook-security.js";

const CONTEXT = {
  workspaceId: "10000000-0000-4000-8000-000000000001",
  endpointId: "20000000-0000-4000-8000-000000000002",
  secretId: "30000000-0000-4000-8000-000000000003",
  masterKeyId: "master_2026",
} as const;
const DELIVERY_ID = "40000000-0000-4000-8000-000000000004";
const SIGNING_SECRET = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";
const MASTER_KEY = "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI";
const NONCE = "AwMDAwMDAwMDAwMD";
const BODY = '{"hello":"world"}';
const UNIX_SECONDS = 1_783_929_600;

describe("webhook signing-secret encryption", () => {
  it("matches the AES-256-GCM fixed vector and round trips", () => {
    const envelope = encryptWebhookSigningSecret({
      ...CONTEXT,
      signingSecret: SIGNING_SECRET,
      masterKey: MASTER_KEY,
      nonce: NONCE,
    });

    expect(envelope).toEqual({
      version: "v1",
      masterKeyId: "master_2026",
      nonce: NONCE,
      ciphertext: "xPz6KBb-eHDcpEUxg4ZItAHKElk_8E4--VUem2Hu52w",
      tag: "Scymj-JmCoHSrlca5HwlwA",
    });
    expect(decryptWebhookSigningSecret({ ...CONTEXT, envelope, masterKey: MASTER_KEY })).toBe(
      SIGNING_SECRET,
    );
  });

  it("generates exactly 32 bytes and permits deterministic random injection", () => {
    expect(generateWebhookSigningSecret((size) => Buffer.alloc(size, 9))).toBe(
      "CQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQk",
    );
    expect(Buffer.from(generateWebhookSigningSecret(), "base64url")).toHaveLength(32);
  });

  it.each([
    ["a wrong master key", { masterKey: Buffer.alloc(32, 4).toString("base64url") }],
    ["a different workspace", { workspaceId: "10000000-0000-4000-8000-000000000009" }],
    ["a different endpoint", { endpointId: "20000000-0000-4000-8000-000000000009" }],
    ["a different secret id", { secretId: "30000000-0000-4000-8000-000000000009" }],
    ["a different master key id", { masterKeyId: "master_2027" }],
  ])("rejects %s through authenticated AAD", (_description, override) => {
    const envelope = encryptWebhookSigningSecret({
      ...CONTEXT,
      signingSecret: SIGNING_SECRET,
      masterKey: MASTER_KEY,
      nonce: NONCE,
    });
    expect(() =>
      decryptWebhookSigningSecret({
        ...CONTEXT,
        ...override,
        envelope,
        masterKey: "masterKey" in override ? override.masterKey : MASTER_KEY,
      }),
    ).toThrow(WebhookSecurityError);
  });

  it.each(["ciphertext", "tag", "nonce"] as const)("rejects tampered %s", (field) => {
    const envelope = encryptWebhookSigningSecret({
      ...CONTEXT,
      signingSecret: SIGNING_SECRET,
      masterKey: MASTER_KEY,
      nonce: NONCE,
    });
    const original = envelope[field];
    const replacement = `${original.slice(0, -1)}${original.endsWith("A") ? "B" : "A"}`;
    expect(() =>
      decryptWebhookSigningSecret({
        ...CONTEXT,
        masterKey: MASTER_KEY,
        envelope: { ...envelope, [field]: replacement },
      }),
    ).toThrow(WebhookSecurityError);
  });

  it("rejects malformed and noncanonical secret/envelope inputs without exposing them", () => {
    const invalidSecrets = [
      `${SIGNING_SECRET}=`,
      `${SIGNING_SECRET.slice(0, -1)}+`,
      Buffer.alloc(31).toString("base64url"),
      "",
    ];
    for (const signingSecret of invalidSecrets) {
      expect(() =>
        encryptWebhookSigningSecret({
          ...CONTEXT,
          signingSecret,
          masterKey: MASTER_KEY,
          nonce: NONCE,
        }),
      ).toThrow("Invalid webhook security input.");
    }
    expect(() =>
      encryptWebhookSigningSecret({
        ...CONTEXT,
        workspaceId: "abcdef12-0000-4000-8000-000000000001".toUpperCase(),
        signingSecret: SIGNING_SECRET,
        masterKey: MASTER_KEY,
        nonce: NONCE,
      }),
    ).toThrow(WebhookSecurityError);
    expect(() =>
      encryptWebhookSigningSecret({
        ...CONTEXT,
        masterKeyId: "master/key",
        signingSecret: SIGNING_SECRET,
        masterKey: MASTER_KEY,
        nonce: NONCE,
      }),
    ).toThrow(WebhookSecurityError);
  });
});

describe("webhook delivery signatures", () => {
  it("uses the exact UTF-8 body in its hash and fixed HMAC vector", () => {
    expect(sha256WebhookBody(BODY)).toBe(
      "93a23971a914e5eacbf0a8d25154cda309c3c1c72fbb9914d47c60f3cb681588",
    );
    expect(
      signWebhookDelivery({
        signingSecret: SIGNING_SECRET,
        deliveryId: DELIVERY_ID,
        unixSeconds: UNIX_SECONDS,
        rawBody: BODY,
      }),
    ).toBe("WTrQYa1L1oDYNiq9kfUsQVCCjG_L8H3LW34w37uYQoA");
  });

  it("verifies only the original delivery, timestamp, body, and canonical signature", () => {
    const signed = {
      signingSecret: SIGNING_SECRET,
      deliveryId: DELIVERY_ID,
      unixSeconds: UNIX_SECONDS,
      rawBody: BODY,
      signature: "WTrQYa1L1oDYNiq9kfUsQVCCjG_L8H3LW34w37uYQoA",
    };
    expect(verifyWebhookSignature(signed)).toBe(true);
    expect(verifyWebhookSignature({ ...signed, rawBody: `${BODY} ` })).toBe(false);
    expect(verifyWebhookSignature({ ...signed, unixSeconds: UNIX_SECONDS + 1 })).toBe(false);
    expect(verifyWebhookSignature({ ...signed, signature: `${signed.signature}=` })).toBe(false);
    expect(verifyWebhookSignature({ ...signed, signature: "a".repeat(43) })).toBe(false);
  });

  it("rejects invalid signing inputs and bounds bodies and timestamps", () => {
    const base = {
      signingSecret: SIGNING_SECRET,
      deliveryId: DELIVERY_ID,
      unixSeconds: UNIX_SECONDS,
      rawBody: BODY,
    };
    expect(() =>
      signWebhookDelivery({
        ...base,
        deliveryId: "abcdef12-0000-4000-8000-000000000004".toUpperCase(),
      }),
    ).toThrow(WebhookSecurityError);
    expect(() => signWebhookDelivery({ ...base, unixSeconds: -1 })).toThrow(WebhookSecurityError);
    expect(() => signWebhookDelivery({ ...base, unixSeconds: 1.5 })).toThrow(WebhookSecurityError);
    expect(() => signWebhookDelivery({ ...base, rawBody: "x".repeat(1_048_577) })).toThrow(
      WebhookSecurityError,
    );
  });
});
