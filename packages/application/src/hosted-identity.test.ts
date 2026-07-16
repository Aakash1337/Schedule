import { describe, expect, it } from "vitest";

import {
  browserSessionId,
  createHostedUser,
  revokeBrowserSession,
  userId,
  workspaceId,
  type BrowserSession,
  type ExternalIdentity,
  type HostedUser,
  type Workspace,
  type WorkspaceMembership,
} from "@schedule/domain";

import {
  DisableHostedUser,
  AuthorizeHostedWorkspace,
  FindOrProvisionHostedUser,
  HmacBrowserSessionTokenCodec,
  IssueBrowserSession,
  ListHostedWorkspaces,
  ProvisionHostedWorkspace,
  ReactivateWorkspaceMembership,
  ResolveBrowserSession,
  RevokeWorkspaceMembership,
  RotateBrowserSession,
  type IdentityTransactionContext,
  type IdentityUnitOfWork,
} from "./hosted-identity.js";
import type { UnitOfWorkOptions } from "./ports.js";

const initialNow = new Date("2026-07-15T00:00:00.000Z");

function exactIdentityKey(issuer: string, subject: string): string {
  return JSON.stringify([issuer, subject]);
}

function createHarness() {
  let now = new Date(initialNow);
  const users = new Map<string, HostedUser>();
  const identities = new Map<string, ExternalIdentity>();
  const sessions = new Map<string, BrowserSession>();
  const memberships = new Map<string, WorkspaceMembership>();
  const workspaces = new Map<string, Workspace>();
  const isolationLevels: Array<UnitOfWorkOptions["isolationLevel"]> = [];

  const context: IdentityTransactionContext = {
    users: {
      findByIdForUpdate: async (id) => users.get(id) ?? null,
      insert: async (user) => {
        users.set(user.id, user);
      },
      save: async (user, expectedVersion) => {
        expect(users.get(user.id)?.version).toBe(expectedVersion);
        users.set(user.id, user);
      },
    },
    externalIdentities: {
      lockExact: async () => undefined,
      findExact: async (issuer, subject) =>
        identities.get(exactIdentityKey(issuer, subject)) ?? null,
      insert: async (identity) => {
        const key = exactIdentityKey(identity.issuer, identity.subject);
        if (identities.has(key)) throw new Error("duplicate identity");
        identities.set(key, identity);
      },
    },
    browserSessions: {
      findById: async (id) => sessions.get(id) ?? null,
      findByIdForUpdate: async (id) => sessions.get(id) ?? null,
      insert: async (session) => {
        if (
          [...sessions.values()].some(
            (candidate) => candidate.secretDigest === session.secretDigest,
          )
        ) {
          throw new Error("duplicate session digest");
        }
        sessions.set(session.id, session);
      },
      save: async (session, expectedVersion) => {
        expect(sessions.get(session.id)?.version).toBe(expectedVersion);
        sessions.set(session.id, session);
      },
      revokeAllForUser: async (id, revokedAt, reason) => {
        let count = 0;
        for (const session of sessions.values()) {
          if (session.userId !== id || session.revokedAt !== null) continue;
          sessions.set(session.id, revokeBrowserSession(session, reason, revokedAt));
          count += 1;
        }
        return count;
      },
    },
    memberships: {
      findByUserAndWorkspace: async (id, workspace) =>
        memberships.get(`${workspace}:${id}`) ?? null,
      findByUserAndWorkspaceForUpdate: async (id, workspace) =>
        memberships.get(`${workspace}:${id}`) ?? null,
      insert: async (membership) => {
        const key = `${membership.workspaceId}:${membership.userId}`;
        if (memberships.has(key)) throw new Error("duplicate membership");
        memberships.set(key, membership);
      },
      save: async (membership, expectedVersion) => {
        const key = `${membership.workspaceId}:${membership.userId}`;
        expect(memberships.get(key)?.version).toBe(expectedVersion);
        memberships.set(key, membership);
      },
    },
    workspaces: {
      insert: async (workspace) => {
        workspaces.set(workspace.id, workspace);
      },
      listActiveForUser: async (id, limit, offset) =>
        [...memberships.values()]
          .filter((membership) => membership.userId === id && membership.status === "active")
          .map((membership) => workspaces.get(membership.workspaceId))
          .filter((workspace): workspace is Workspace => workspace !== undefined)
          .sort((left, right) => left.id.localeCompare(right.id))
          .slice(offset, offset + limit),
    },
    time: { current: async () => new Date(now) },
  };
  const unitOfWork: IdentityUnitOfWork = {
    run: async (operation, options) => {
      isolationLevels.push(options?.isolationLevel);
      return operation(context);
    },
  };
  return {
    context,
    unitOfWork,
    users,
    identities,
    sessions,
    memberships,
    workspaces,
    isolationLevels,
    setNow: (value: Date) => {
      now = new Date(value);
    },
  };
}

describe("hosted identity application foundation", () => {
  it("creates 256-bit session secrets and compares only peppered digests", () => {
    const codec = new HmacBrowserSessionTokenCodec("p".repeat(32));
    const material = codec.issue();

    expect(material.secret).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(material.secretDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(
      codec.verify({ selector: material.selector, secret: material.secret }, material.secretDigest),
    ).toBe(true);
    expect(
      codec.verify({ selector: material.selector, secret: "A".repeat(43) }, material.secretDigest),
    ).toBe(false);
    expect(() => new HmacBrowserSessionTokenCodec("short")).toThrow(/at least 32 bytes/);
  });

  it("provisions an exact identity and default workspace once under read-committed lock semantics", async () => {
    const harness = createHarness();
    const service = new FindOrProvisionHostedUser(harness.unitOfWork);

    const created = await service.execute({ issuer: "Issuer", subject: "Subject" });
    const replay = await service.execute({ issuer: "Issuer", subject: "Subject" });
    const caseDistinct = await service.execute({ issuer: "issuer", subject: "Subject" });

    expect(created.created).toBe(true);
    expect(replay).toMatchObject({ created: false, user: { id: created.user.id } });
    expect(caseDistinct.user.id).not.toBe(created.user.id);
    expect(harness.users).toHaveLength(2);
    expect(harness.identities).toHaveLength(2);
    expect(harness.workspaces.size).toBe(2);
    expect(harness.memberships.size).toBe(2);
    expect([...harness.workspaces.values()].every(({ name }) => name === "My Schedule")).toBe(true);
    expect([...harness.memberships.values()].every(({ status }) => status === "active")).toBe(true);
    expect(harness.isolationLevels).toEqual(["read_committed", "read_committed", "read_committed"]);
  });

  it("atomically prepares a workspace and its first binary membership", async () => {
    const harness = createHarness();
    const user = createHostedUser({ id: userId("workspace-owner"), now: initialNow });
    harness.users.set(user.id, user);

    const result = await new ProvisionHostedWorkspace(harness.unitOfWork).execute({
      userId: user.id,
      name: " Hosted schedule ",
    });

    expect(result.workspace.name).toBe("Hosted schedule");
    expect(result.membership).toMatchObject({ status: "active", userId: user.id });
    expect(harness.workspaces.has(result.workspace.id)).toBe(true);
    expect(harness.memberships.has(`${result.workspace.id}:${user.id}`)).toBe(true);
  });

  it("lists only the principal's active hosted workspaces with bounded paging", async () => {
    const harness = createHarness();
    const primary = await new FindOrProvisionHostedUser(harness.unitOfWork).execute({
      issuer: "Issuer",
      subject: "Primary",
    });
    const secondary = await new FindOrProvisionHostedUser(harness.unitOfWork).execute({
      issuer: "Issuer",
      subject: "Secondary",
    });
    const extra = await new ProvisionHostedWorkspace(harness.unitOfWork).execute({
      userId: primary.user.id,
      name: "Later workspace",
    });
    await new RevokeWorkspaceMembership(harness.unitOfWork).execute(
      primary.user.id,
      extra.workspace.id,
    );
    const service = new ListHostedWorkspaces(harness.unitOfWork);

    await expect(service.execute({ userId: primary.user.id, limit: 1 })).resolves.toMatchObject({
      items: [{ name: "My Schedule" }],
      limit: 1,
      offset: 0,
    });
    await expect(service.execute({ userId: secondary.user.id })).resolves.toMatchObject({
      items: [{ name: "My Schedule" }],
    });
    const transactionCount = harness.isolationLevels.length;
    expect(() => service.execute({ userId: primary.user.id, limit: 21 })).toThrow(
      "Hosted workspace limit must be from 1 to 20.",
    );
    expect(() => service.execute({ userId: primary.user.id, offset: 1_001 })).toThrow(
      "Hosted workspace offset must be from 0 to 1,000.",
    );
    expect(harness.isolationLevels).toHaveLength(transactionCount);
    expect(harness.isolationLevels.at(-1)).toBe("read_committed");
  });

  it("authorizes only active exact memberships and returns an immutable scoped context", async () => {
    const harness = createHarness();
    const user = createHostedUser({ id: userId("authorized-user"), now: initialNow });
    harness.users.set(user.id, user);
    const provisioned = await new ProvisionHostedWorkspace(harness.unitOfWork).execute({
      userId: user.id,
      name: "Authorized workspace",
    });
    const principal = {
      userId: user.id,
      sessionId: browserSessionId("00000000-0000-4000-8000-000000000123"),
    };
    const service = new AuthorizeHostedWorkspace(harness.unitOfWork);

    const authorized = await service.execute(principal, provisioned.workspace.id);
    expect(authorized).toEqual({ ...principal, workspaceId: provisioned.workspace.id });
    expect(Object.isFrozen(authorized)).toBe(true);
    await expect(
      service.execute(principal, workspaceId("00000000-0000-4000-8000-000000000999")),
    ).resolves.toBeNull();

    await new RevokeWorkspaceMembership(harness.unitOfWork).execute(
      user.id,
      provisioned.workspace.id,
    );
    await expect(service.execute(principal, provisioned.workspace.id)).resolves.toBeNull();
    expect(harness.isolationLevels.at(-1)).toBe("read_committed");
  });

  it("issues digest-only persistence and resolves a session with a bounded idle touch", async () => {
    const harness = createHarness();
    const user = createHostedUser({ id: userId("session-user"), now: initialNow });
    harness.users.set(user.id, user);
    const codec = new HmacBrowserSessionTokenCodec("q".repeat(32));
    const issued = await new IssueBrowserSession(harness.unitOfWork, codec).execute({
      userId: user.id,
      idleTimeoutSeconds: 3_600,
      absoluteTtlSeconds: 86_400,
    });

    const persisted = [...harness.sessions.values()][0];
    expect(persisted?.secretDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(persisted)).not.toContain(issued.token.secret);
    expect(issued).not.toHaveProperty("secretDigest");

    harness.setNow(new Date("2026-07-15T00:30:00.000Z"));
    await expect(
      new ResolveBrowserSession(harness.unitOfWork, codec).execute(issued.token),
    ).resolves.toMatchObject({
      userId: user.id,
      sessionId: issued.token.selector,
    });
    expect(harness.sessions.get(issued.token.selector)?.lastSeenAt).toEqual(
      new Date("2026-07-15T00:30:00.000Z"),
    );
  });

  it("locks the user before the session after a non-locking ownership probe", async () => {
    const harness = createHarness();
    const user = createHostedUser({ id: userId("lock-order-user"), now: initialNow });
    harness.users.set(user.id, user);
    const codec = new HmacBrowserSessionTokenCodec("l".repeat(32));
    const issued = await new IssueBrowserSession(harness.unitOfWork, codec).execute({
      userId: user.id,
      idleTimeoutSeconds: 3_600,
      absoluteTtlSeconds: 86_400,
    });
    const order: string[] = [];
    const findSession = harness.context.browserSessions.findById;
    const lockUser = harness.context.users.findByIdForUpdate;
    const lockSession = harness.context.browserSessions.findByIdForUpdate;
    harness.context.browserSessions.findById = async (id) => {
      order.push("session_probe");
      return findSession(id);
    };
    harness.context.users.findByIdForUpdate = async (id) => {
      order.push("user_lock");
      return lockUser(id);
    };
    harness.context.browserSessions.findByIdForUpdate = async (id) => {
      order.push("session_lock");
      return lockSession(id);
    };

    await expect(
      new ResolveBrowserSession(harness.unitOfWork, codec).execute(issued.token),
    ).resolves.toMatchObject({ userId: user.id });
    expect(order).toEqual(["session_probe", "user_lock", "session_lock"]);
  });

  it("returns the same null result for malformed, unknown, expired, revoked, and disabled sessions", async () => {
    const harness = createHarness();
    const user = createHostedUser({ id: userId("generic-user"), now: initialNow });
    harness.users.set(user.id, user);
    const codec = new HmacBrowserSessionTokenCodec("r".repeat(32));
    const issued = await new IssueBrowserSession(harness.unitOfWork, codec).execute({
      userId: user.id,
      idleTimeoutSeconds: 60,
      absoluteTtlSeconds: 600,
    });
    const resolve = new ResolveBrowserSession(harness.unitOfWork, codec);

    await expect(resolve.execute({ selector: "bad", secret: "bad" })).resolves.toBeNull();
    await expect(
      resolve.execute({ selector: browserSessionId(), secret: issued.token.secret }),
    ).resolves.toBeNull();
    harness.setNow(new Date("2026-07-15T00:01:00.000Z"));
    await expect(resolve.execute(issued.token)).resolves.toBeNull();

    harness.setNow(initialNow);
    const stored = harness.sessions.get(issued.token.selector);
    if (stored === undefined) throw new Error("Test session was not persisted.");
    harness.sessions.set(stored.id, revokeBrowserSession(stored, "signed_out", initialNow));
    await expect(resolve.execute(issued.token)).resolves.toBeNull();
    harness.sessions.set(stored.id, stored);
    harness.users.set(user.id, { ...user, status: "disabled", disabledAt: initialNow, version: 2 });
    await expect(resolve.execute(issued.token)).resolves.toBeNull();
  });

  it("rotates without extending absolute lifetime and rejects replay of the old token", async () => {
    const harness = createHarness();
    const user = createHostedUser({ id: userId("rotate-user"), now: initialNow });
    harness.users.set(user.id, user);
    const codec = new HmacBrowserSessionTokenCodec("s".repeat(32));
    const issued = await new IssueBrowserSession(harness.unitOfWork, codec).execute({
      userId: user.id,
      idleTimeoutSeconds: 3_600,
      absoluteTtlSeconds: 86_400,
    });
    harness.setNow(new Date("2026-07-15T00:59:00.000Z"));

    const rotated = await new RotateBrowserSession(harness.unitOfWork, codec).execute(issued.token);

    expect(rotated?.token.selector).not.toBe(issued.token.selector);
    expect(rotated?.absoluteExpiresAt).toEqual(issued.absoluteExpiresAt);
    expect(harness.sessions.get(issued.token.selector)).toMatchObject({
      revokedAt: new Date("2026-07-15T00:59:00.000Z"),
      revocationReason: "rotated",
    });
    await expect(
      new ResolveBrowserSession(harness.unitOfWork, codec).execute(issued.token),
    ).resolves.toBeNull();
  });

  it("disables a user and revokes every global session atomically", async () => {
    const harness = createHarness();
    const user = createHostedUser({ id: userId("disable-user"), now: initialNow });
    harness.users.set(user.id, user);
    const codec = new HmacBrowserSessionTokenCodec("t".repeat(32));
    await new IssueBrowserSession(harness.unitOfWork, codec).execute({
      userId: user.id,
      idleTimeoutSeconds: 3_600,
      absoluteTtlSeconds: 86_400,
    });
    await new IssueBrowserSession(harness.unitOfWork, codec).execute({
      userId: user.id,
      idleTimeoutSeconds: 3_600,
      absoluteTtlSeconds: 86_400,
    });

    const disabled = await new DisableHostedUser(harness.unitOfWork).execute(user.id);

    expect(disabled.status).toBe("disabled");
    expect([...harness.sessions.values()]).toHaveLength(2);
    expect(
      [...harness.sessions.values()].every(
        (session) => session.revocationReason === "user_disabled",
      ),
    ).toBe(true);
  });

  it("revokes one membership without revoking the user's global session and can reactivate it", async () => {
    const harness = createHarness();
    const user = createHostedUser({ id: userId("membership-user"), now: initialNow });
    harness.users.set(user.id, user);
    const workspace = workspaceId("membership-workspace");
    harness.memberships.set(`${workspace}:${user.id}`, {
      userId: user.id,
      workspaceId: workspace,
      status: "active",
      revokedAt: null,
      version: 1,
      createdAt: initialNow,
      updatedAt: initialNow,
    });
    const session = {
      id: browserSessionId("membership-session"),
      userId: user.id,
      secretDigest: "b".repeat(64),
      idleTimeoutSeconds: 3_600,
      issuedAt: initialNow,
      lastSeenAt: initialNow,
      idleExpiresAt: new Date("2026-07-15T01:00:00.000Z"),
      absoluteExpiresAt: new Date("2026-07-16T00:00:00.000Z"),
      revokedAt: null,
      revocationReason: null,
      version: 1,
    } satisfies BrowserSession;
    harness.sessions.set(session.id, session);

    const revoked = await new RevokeWorkspaceMembership(harness.unitOfWork).execute(
      user.id,
      workspace,
    );
    harness.setNow(new Date("2026-07-15T01:00:00.000Z"));
    const active = await new ReactivateWorkspaceMembership(harness.unitOfWork).execute(
      user.id,
      workspace,
    );

    expect(revoked.status).toBe("revoked");
    expect(active.status).toBe("active");
    expect(harness.sessions.get(session.id)?.revokedAt).toBeNull();
  });
});
