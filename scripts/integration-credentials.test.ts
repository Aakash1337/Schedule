import { describe, expect, it } from "vitest";

import {
  formatIntegrationCredentialToken,
  generateIntegrationCredentialSecret,
  hashIntegrationCredentialSecret,
  parseIntegrationCredentialArguments,
} from "./integration-credentials.js";

const workspaceId = "0191c54f-f691-7b8b-9d87-16f1c99128f9";
const credentialId = "0191c54f-f691-7f98-8ab4-bbc507f1abe5";
const malformedArgumentSets: readonly (readonly string[])[] = [
  [],
  ["unknown"],
  ["create", "--workspace", workspaceId],
  ["create", "--workspace", "not-a-uuid", "--name", "Hermes"],
  ["create", "--workspace", workspaceId, "--name", ""],
  ["create", "--workspace", workspaceId, "--name", "bad\nname"],
  ["create", "--workspace", workspaceId, "--name", "Hermes", "--scopes", "admin"],
  [
    "create",
    "--workspace",
    workspaceId,
    "--name",
    "Hermes",
    "--scopes",
    "schedule:read,schedule:read",
  ],
  ["revoke", "--credential", "not-a-uuid"],
  ["list", "--workspace", workspaceId, "--unexpected", "value"],
];

describe("integration credential CLI argument parsing", () => {
  it("parses create with secure default scopes", () => {
    expect(
      parseIntegrationCredentialArguments([
        "create",
        "--workspace",
        workspaceId,
        "--name",
        "  Hermes phone bridge  ",
      ]),
    ).toEqual({
      kind: "create",
      workspaceId,
      name: "Hermes phone bridge",
      scopes: ["schedule:read", "schedule:write"],
    });
  });

  it("parses explicit scopes and inline options canonically", () => {
    expect(
      parseIntegrationCredentialArguments([
        "--",
        "create",
        `--workspace=${workspaceId.toUpperCase()}`,
        "--name=Read-only bridge",
        "--scopes=schedule:read",
      ]),
    ).toEqual({
      kind: "create",
      workspaceId,
      name: "Read-only bridge",
      scopes: ["schedule:read"],
    });
  });

  it("parses revoke and list without requiring a database", () => {
    expect(parseIntegrationCredentialArguments(["revoke", "--credential", credentialId])).toEqual({
      kind: "revoke",
      credentialId,
    });
    expect(parseIntegrationCredentialArguments(["list", "--workspace", workspaceId])).toEqual({
      kind: "list",
      workspaceId,
    });
  });

  malformedArgumentSets.forEach((args, index) => {
    it(`rejects malformed or unsafe argument set ${String(index + 1)}`, () => {
      expect(() => parseIntegrationCredentialArguments(args)).toThrow(/Usage:/);
    });
  });
});

describe("integration credential secret handling", () => {
  it("generates exactly 32 random bytes as base64url without padding", () => {
    const secret = generateIntegrationCredentialSecret((size) => {
      expect(size).toBe(32);
      return Buffer.alloc(size, 0xab);
    });

    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(secret).not.toContain("=");
    expect(Buffer.from(secret, "base64url")).toHaveLength(32);
  });

  it("refuses an entropy source that returns fewer than 32 bytes", () => {
    expect(() => generateIntegrationCredentialSecret(() => Buffer.alloc(31))).toThrow(
      /at least 32 random bytes/,
    );
  });

  it("creates a deterministic keyed digest without embedding the secret", () => {
    const secret = generateIntegrationCredentialSecret(() => Buffer.alloc(32, 0x42));
    const first = hashIntegrationCredentialSecret(secret, "a".repeat(32));
    const repeated = hashIntegrationCredentialSecret(secret, "a".repeat(32));
    const otherPepper = hashIntegrationCredentialSecret(secret, "b".repeat(32));

    expect(first).toBe("ac2428e1b4aae3d6a859cc7865426113e00eea57566a5745a5673299664d8447");
    expect(first).toBe(repeated);
    expect(first).not.toBe(otherPepper);
    expect(first).not.toContain(secret);
  });

  it("rejects weak peppers and malformed secrets", () => {
    const secret = generateIntegrationCredentialSecret(() => Buffer.alloc(32, 0x11));
    expect(() => hashIntegrationCredentialSecret(secret, "weak")).toThrow(/at least 32/);
    expect(() => hashIntegrationCredentialSecret("plain text", "a".repeat(32))).toThrow(
      /base64url/,
    );
  });

  it("formats the one-time bearer token as id dot secret", () => {
    const secret = generateIntegrationCredentialSecret(() => Buffer.alloc(32, 0x24));
    expect(formatIntegrationCredentialToken(credentialId.toUpperCase(), secret)).toBe(
      `${credentialId}.${secret}`,
    );
  });
});
