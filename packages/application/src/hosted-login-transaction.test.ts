import { randomBytes } from "node:crypto";

import { describe, expect, it } from "vitest";

import { hostedLoginTransactionId, type HostedLoginTransaction } from "@schedule/domain";

import {
  AesGcmHostedLoginPkceProtector,
  ConsumeHostedLoginTransaction,
  HmacHostedLoginTransactionCodec,
  PruneHostedLoginTransactions,
  StartHostedLoginTransaction,
  type HostedLoginTransactionContext,
  type HostedLoginTransactionCodec,
  type HostedLoginTransactionUnitOfWork,
} from "./hosted-login-transaction.js";
import type { UnitOfWorkOptions } from "./ports.js";

const initialNow = new Date("2026-07-16T00:00:00.000Z");
const primaryKey = Buffer.alloc(32, 1).toString("base64url");
const rotatedKey = Buffer.alloc(32, 2).toString("base64url");

function createHarness() {
  let now = new Date(initialNow);
  const stored = new Map<string, HostedLoginTransaction>();
  const isolationLevels: Array<UnitOfWorkOptions["isolationLevel"]> = [];
  const context: HostedLoginTransactionContext = {
    transactions: {
      findByStateDigestForUpdate: async (stateDigest) => stored.get(stateDigest) ?? null,
      insert: async (transaction) => {
        if (stored.has(transaction.stateDigest)) throw new Error("duplicate state digest");
        stored.set(transaction.stateDigest, transaction);
      },
      save: async (transaction, expectedVersion) => {
        expect(stored.get(transaction.stateDigest)?.version).toBe(expectedVersion);
        stored.set(transaction.stateDigest, transaction);
      },
      deleteExpiredBefore: async (cutoff, limit) => {
        const expired = [...stored.values()]
          .filter((transaction) => transaction.expiresAt.getTime() <= cutoff.getTime())
          .sort((left, right) => left.expiresAt.getTime() - right.expiresAt.getTime())
          .slice(0, limit);
        for (const transaction of expired) stored.delete(transaction.stateDigest);
        return expired.length;
      },
    },
    time: { current: async () => new Date(now) },
  };
  const unitOfWork: HostedLoginTransactionUnitOfWork = {
    run: async (operation, options) => {
      isolationLevels.push(options?.isolationLevel);
      return operation(context);
    },
  };
  return {
    unitOfWork,
    stored,
    isolationLevels,
    setNow(value: Date) {
      now = new Date(value);
    },
  };
}

function dependencies(harness = createHarness()) {
  const codec = new HmacHostedLoginTransactionCodec("hosted-login-pepper-32-bytes-minimum");
  const protector = new AesGcmHostedLoginPkceProtector({
    primaryKeyId: "primary",
    keys: { primary: primaryKey },
  });
  return { harness, codec, protector };
}

const startInput = {
  issuer: "https://identity.example/tenant",
  clientId: "schedule-web",
  redirectUri: "https://schedule.example/v1/auth/callback",
  returnToPath: "/today",
  ttlSeconds: 300,
} as const;

describe("hosted login transaction application foundation", () => {
  it("issues independent 256-bit values with purpose-separated digests", () => {
    const codec = new HmacHostedLoginTransactionCodec("hosted-login-pepper-32-bytes-minimum");
    const material = codec.issue();
    expect(material.state).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(material.browserBinding).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(material.nonce).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(material.pkceVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(material.pkceChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(material.stateDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(material.browserBindingDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(material.stateDigest).not.toBe(material.browserBindingDigest);
    expect(codec.stateDigestForLookup(material.state)).toEqual({
      digest: material.stateDigest,
      wellFormed: true,
    });
    expect(codec.verifyBrowserBinding(material.browserBinding, material.browserBindingDigest)).toBe(
      true,
    );
    expect(codec.verifyBrowserBinding(material.state, material.browserBindingDigest)).toBe(false);
    expect(codec.stateDigestForLookup("malformed").wellFormed).toBe(false);
  });

  it("protects PKCE verifiers with transaction-bound authenticated encryption and key rotation", () => {
    const transactionId = hostedLoginTransactionId();
    const verifier = randomBytes(32).toString("base64url");
    const original = new AesGcmHostedLoginPkceProtector({
      primaryKeyId: "old",
      keys: { old: primaryKey },
    });
    const protectedVerifier = original.protect(transactionId, verifier);
    expect(protectedVerifier).not.toContain(verifier);
    expect(original.unprotect(transactionId, protectedVerifier)).toBe(verifier);
    expect(() => original.unprotect(hostedLoginTransactionId(), protectedVerifier)).toThrowError(
      expect.objectContaining({ code: "hosted_login_transaction.pkce_protection_failed" }),
    );

    const rotated = new AesGcmHostedLoginPkceProtector({
      primaryKeyId: "new",
      keys: { old: primaryKey, new: rotatedKey },
    });
    expect(rotated.unprotect(transactionId, protectedVerifier)).toBe(verifier);
    expect(rotated.protect(transactionId, verifier).split(".")[1]).toBe("new");

    const aliased = new AesGcmHostedLoginPkceProtector({
      primaryKeyId: "old",
      keys: { old: primaryKey, alias: primaryKey },
    });
    const substitutedKeyId = protectedVerifier.replace("v1.old.", "v1.alias.");
    expect(() => aliased.unprotect(transactionId, substitutedKeyId)).toThrowError(
      expect.objectContaining({ code: "hosted_login_transaction.pkce_protection_failed" }),
    );
  });

  it("rejects inconsistent injected secret material before persistence", async () => {
    const { harness, codec, protector } = dependencies();
    const inconsistentCodec: HostedLoginTransactionCodec = {
      issue: () => ({ ...codec.issue(), pkceChallenge: "Z".repeat(43) }),
      stateDigestForLookup: (state) => codec.stateDigestForLookup(state),
      verifyBrowserBinding: (browserBinding, expectedDigest) =>
        codec.verifyBrowserBinding(browserBinding, expectedDigest),
      pkceChallenge: (pkceVerifier) => codec.pkceChallenge(pkceVerifier),
    };
    await expect(
      new StartHostedLoginTransaction(harness.unitOfWork, inconsistentCodec, protector).execute(
        startInput,
      ),
    ).rejects.toMatchObject({ code: "hosted_login_transaction.secret_material_invalid" });
    expect(harness.stored).toHaveLength(0);
  });

  it("persists no plaintext bearer values and consumes the exact transaction once", async () => {
    const { harness, codec, protector } = dependencies();
    const issued = await new StartHostedLoginTransaction(
      harness.unitOfWork,
      codec,
      protector,
    ).execute(startInput);
    const [stored] = harness.stored.values();
    expect(stored).toBeDefined();
    const persisted = JSON.stringify(stored);
    expect(persisted).not.toContain(issued.state);
    expect(persisted).not.toContain(issued.browserBinding);
    expect(stored?.protectedPkceVerifier).not.toContain(issued.pkceChallenge);
    expect(stored).toMatchObject({
      issuer: startInput.issuer,
      clientId: startInput.clientId,
      redirectUri: startInput.redirectUri,
      returnToPath: startInput.returnToPath,
      nonce: issued.nonce,
      pkceChallenge: issued.pkceChallenge,
      consumedAt: null,
    });

    const consume = new ConsumeHostedLoginTransaction(harness.unitOfWork, codec, protector);
    await expect(
      consume.execute({ state: issued.state, browserBinding: "A".repeat(43) }),
    ).resolves.toBeNull();
    const consumed = await consume.execute({
      state: issued.state,
      browserBinding: issued.browserBinding,
    });
    expect(consumed).toMatchObject({
      issuer: startInput.issuer,
      clientId: startInput.clientId,
      redirectUri: startInput.redirectUri,
      returnToPath: startInput.returnToPath,
      expectedNonce: issued.nonce,
      consumedAt: initialNow,
    });
    expect(consumed?.pkceVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    await expect(
      consume.execute({ state: issued.state, browserBinding: issued.browserBinding }),
    ).resolves.toBeNull();
  });

  it("rejects expiry at the exact boundary and prunes in bounded read-committed batches", async () => {
    const { harness, codec, protector } = dependencies();
    const start = new StartHostedLoginTransaction(harness.unitOfWork, codec, protector);
    const first = await start.execute({ ...startInput, ttlSeconds: 60 });
    await start.execute({ ...startInput, ttlSeconds: 60 });
    harness.setNow(new Date("2026-07-16T00:01:00.000Z"));

    await expect(
      new ConsumeHostedLoginTransaction(harness.unitOfWork, codec, protector).execute({
        state: first.state,
        browserBinding: first.browserBinding,
      }),
    ).resolves.toBeNull();
    await expect(new PruneHostedLoginTransactions(harness.unitOfWork).execute(1)).resolves.toBe(1);
    expect(harness.stored).toHaveLength(1);
    expect(harness.isolationLevels.at(-1)).toBe("read_committed");
  });

  it("fails closed before consumption when protected PKCE material is corrupted", async () => {
    const { harness, codec, protector } = dependencies();
    const issued = await new StartHostedLoginTransaction(
      harness.unitOfWork,
      codec,
      protector,
    ).execute(startInput);
    const [stored] = harness.stored.values();
    expect(stored).toBeDefined();
    const replacement = stored!.protectedPkceVerifier.endsWith("A") ? "B" : "A";
    harness.stored.set(stored!.stateDigest, {
      ...stored!,
      protectedPkceVerifier: `${stored!.protectedPkceVerifier.slice(0, -1)}${replacement}`,
    });

    await expect(
      new ConsumeHostedLoginTransaction(harness.unitOfWork, codec, protector).execute({
        state: issued.state,
        browserBinding: issued.browserBinding,
      }),
    ).rejects.toMatchObject({ code: "hosted_login_transaction.pkce_protection_failed" });
    expect(harness.stored.get(stored!.stateDigest)?.consumedAt).toBeNull();
  });
});
