import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createIntegrationSecretVerifier } from "./integration-services.js";

describe("integration secret verifier", () => {
  it("verifies the documented HMAC-SHA256 lowercase-hex credential digest", async () => {
    const pepper = "integration-test-pepper-that-is-at-least-32-characters";
    const secret = Buffer.alloc(32, 11).toString("base64url");
    const digest = createHmac("sha256", pepper).update(secret, "utf8").digest("hex");
    const verifier = createIntegrationSecretVerifier(pepper);

    await expect(verifier.verify(secret, digest)).resolves.toBe(true);
    await expect(verifier.verify(`${secret}a`, digest)).resolves.toBe(false);
    await expect(verifier.verify(secret, digest.toUpperCase())).resolves.toBe(false);
    await expect(verifier.verify(secret, "not-a-digest")).resolves.toBe(false);
  });

  it("refuses a weak pepper", () => {
    expect(() => createIntegrationSecretVerifier("too-short")).toThrow(
      "must contain at least 32 characters",
    );
  });
});
