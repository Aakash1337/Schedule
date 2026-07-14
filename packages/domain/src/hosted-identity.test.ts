import { describe, expect, it } from "vitest";

import { browserSessionId, userId, workspaceId } from "./ids.js";
import {
  browserSessionIsUsable,
  createBrowserSession,
  createExternalIdentity,
  createHostedUser,
  createWorkspaceMembership,
  disableHostedUser,
  reactivateWorkspaceMembership,
  revokeBrowserSession,
  revokeWorkspaceMembership,
  touchBrowserSession,
} from "./hosted-identity.js";

const issuedAt = new Date("2026-07-15T00:00:00.000Z");
const digest = "a".repeat(64);

describe("hosted identity domain", () => {
  it("preserves exact issuer and subject bytes without claim-based normalization", () => {
    const identity = createExternalIdentity({
      userId: userId("user-exact"),
      issuer: "https://Identity.Example/tenant ",
      subject: " Subject-A ",
      now: issuedAt,
    });
    expect(identity).toMatchObject({
      issuer: "https://Identity.Example/tenant ",
      subject: " Subject-A ",
    });
  });

  it("disables users once with an explicit lifecycle version", () => {
    const user = createHostedUser({ id: userId("user-disable"), now: issuedAt });
    const disabled = disableHostedUser(user, new Date("2026-07-15T01:00:00.000Z"));
    expect(disabled).toMatchObject({ status: "disabled", version: 2 });
    expect(disableHostedUser(disabled, new Date("2026-07-15T02:00:00.000Z"))).toBe(disabled);
  });

  it("caps idle extension at the immutable absolute expiry", () => {
    const session = createBrowserSession({
      id: browserSessionId("session-touch"),
      userId: userId("user-session"),
      secretDigest: digest,
      idleTimeoutSeconds: 3_600,
      absoluteExpiresAt: new Date("2026-07-15T01:30:00.000Z"),
      now: issuedAt,
    });
    const touched = touchBrowserSession(session, new Date("2026-07-15T00:59:00.000Z"));
    expect(touched.idleExpiresAt).toEqual(new Date("2026-07-15T01:30:00.000Z"));
    expect(touched.absoluteExpiresAt).toEqual(session.absoluteExpiresAt);
    expect(touched.version).toBe(2);
  });

  it("fails session availability at idle, absolute, and revocation boundaries", () => {
    const session = createBrowserSession({
      userId: userId("user-boundary"),
      secretDigest: digest,
      idleTimeoutSeconds: 60,
      absoluteExpiresAt: new Date("2026-07-15T00:10:00.000Z"),
      now: issuedAt,
    });
    expect(browserSessionIsUsable(session, new Date("2026-07-15T00:00:59.999Z"))).toBe(true);
    expect(browserSessionIsUsable(session, new Date("2026-07-15T00:01:00.000Z"))).toBe(false);
    const revoked = revokeBrowserSession(session, "signed_out", issuedAt);
    expect(browserSessionIsUsable(revoked, issuedAt)).toBe(false);
    expect(revoked).toMatchObject({ revocationReason: "signed_out", version: 2 });
  });

  it("retains a binary membership lifecycle without introducing roles", () => {
    const membership = createWorkspaceMembership({
      userId: userId("user-member"),
      workspaceId: workspaceId("workspace-member"),
      now: issuedAt,
    });
    const revoked = revokeWorkspaceMembership(membership, new Date("2026-07-15T01:00:00.000Z"));
    const active = reactivateWorkspaceMembership(revoked, new Date("2026-07-15T02:00:00.000Z"));
    expect(revoked).toMatchObject({ status: "revoked", version: 2 });
    expect(active).toMatchObject({ status: "active", revokedAt: null, version: 3 });
    expect(active).not.toHaveProperty("role");
  });

  it.each([
    ["empty issuer", { issuer: "", subject: "subject" }, "external_identity.issuer_required"],
    ["empty subject", { issuer: "issuer", subject: "" }, "external_identity.subject_required"],
  ] as const)("rejects %s", (_label, identity, code) => {
    expect(() =>
      createExternalIdentity({ userId: userId("invalid-user"), ...identity, now: issuedAt }),
    ).toThrowError(expect.objectContaining({ code }));
  });

  it("rejects malformed digests and invalid expiry order", () => {
    expect(() =>
      createBrowserSession({
        userId: userId("invalid-session-user"),
        secretDigest: "plaintext-secret",
        idleTimeoutSeconds: 60,
        absoluteExpiresAt: new Date("2026-07-15T00:10:00.000Z"),
        now: issuedAt,
      }),
    ).toThrowError(expect.objectContaining({ code: "browser_session.digest_invalid" }));
    expect(() =>
      createBrowserSession({
        userId: userId("invalid-session-user"),
        secretDigest: digest,
        idleTimeoutSeconds: 60,
        absoluteExpiresAt: issuedAt,
        now: issuedAt,
      }),
    ).toThrowError(expect.objectContaining({ code: "browser_session.absolute_expiry_invalid" }));
  });
});
