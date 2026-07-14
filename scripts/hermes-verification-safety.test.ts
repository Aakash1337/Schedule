import { describe, expect, it } from "vitest";

import { requireLocalHermesVerificationDatabaseUrl } from "./hermes-verification-safety.js";

describe("Hermes verification database safety", () => {
  it("accepts only the expected authenticated loopback Schedule database", () => {
    expect(
      requireLocalHermesVerificationDatabaseUrl(
        "postgres://schedule:schedule@127.0.0.1:5432/schedule",
      ),
    ).toBe("postgres://schedule:schedule@127.0.0.1:5432/schedule");
  });

  it.each([
    "postgres://schedule:schedule@database.example:5432/schedule",
    "postgres://schedule:schedule@localhost:5432/schedule",
    "postgres://schedule:schedule@127.0.0.2:5432/schedule",
    "postgres://schedule:schedule@127.0.0.1:5432/production",
    "postgres://schedule@127.0.0.1:5432/schedule",
    "postgres://schedule:schedule@127.0.0.1:5432/schedule?sslmode=require",
    "not-a-database-url",
  ])("rejects unsafe source target %s", (value) => {
    expect(() => requireLocalHermesVerificationDatabaseUrl(value)).toThrow(
      /Hermes adapter verification/u,
    );
  });
});
