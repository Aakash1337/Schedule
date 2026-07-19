import { createHash, timingSafeEqual } from "node:crypto";

const canonicalTokenPattern = /^[A-Za-z0-9_-]{43}$/u;

export interface DesktopProductAuthenticator {
  verify(authorization: string | string[] | undefined): boolean;
}

export function createDesktopProductAuthenticator(
  expectedTokenDigest: string,
): DesktopProductAuthenticator {
  const expected = Buffer.from(expectedTokenDigest, "base64url");
  if (expected.length !== 32 || expected.toString("base64url") !== expectedTokenDigest) {
    throw new TypeError("The desktop API token digest is invalid.");
  }

  return Object.freeze({
    verify(authorization: string | string[] | undefined): boolean {
      const candidate =
        typeof authorization === "string" &&
        authorization.length === 50 &&
        authorization.startsWith("Bearer ")
          ? authorization.slice(7)
          : "";
      const actual = createHash("sha256").update(candidate, "utf8").digest();
      return canonicalTokenPattern.test(candidate) && timingSafeEqual(actual, expected);
    },
  });
}
