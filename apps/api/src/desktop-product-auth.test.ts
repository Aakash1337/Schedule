import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createDesktopProductAuthenticator } from "./desktop-product-auth.js";

const token = Buffer.alloc(32, 7).toString("base64url");
const digest = createHash("sha256").update(token, "utf8").digest("base64url");

describe("desktop product authentication", () => {
  it("accepts only the exact canonical bearer credential", () => {
    const authenticator = createDesktopProductAuthenticator(digest);

    expect(authenticator.verify(`Bearer ${token}`)).toBe(true);
    for (const value of [
      undefined,
      [],
      `bearer ${token}`,
      `Bearer  ${token}`,
      `Bearer ${token}=`,
      `Bearer ${Buffer.alloc(32, 8).toString("base64url")}`,
    ]) {
      expect(authenticator.verify(value)).toBe(false);
    }
  });

  it("rejects malformed configured digests without disclosing them", () => {
    expect(() => createDesktopProductAuthenticator("not-a-digest")).toThrow(
      "The desktop API token digest is invalid.",
    );
  });
});
