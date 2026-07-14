import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  createScheduleBlock,
  createWorkItem,
  createWorkspace,
  dailyPlanId,
  localDate,
  planItemId,
  recordActivityEvent,
  scheduleBlockId,
  workItemId,
  workspaceId,
  type DailyPlan,
  type ScheduleBlock,
  type WorkItem,
} from "@schedule/domain";

import {
  AuthenticateIntegrationCredential,
  ConfirmIntegrationCommand,
  GetIntegrationToday,
  ListIntegrationCredentials,
  ListIntegrationWorkItems,
  PrepareIntegrationCommand,
  ProvisionIntegrationCredential,
  RevokeIntegrationCredential,
} from "./integration-gateway.js";
import type {
  AuditEventRecord,
  IntegrationCommand,
  IntegrationConfirmationRecord,
  IntegrationCredential,
  IntegrationPrincipal,
  IntegrationRequestRecord,
  IntegrationTransactionContext,
  IntegrationUnitOfWork,
  RecordPlanItemActivityInput,
} from "./ports.js";

const WORKSPACE_ID = workspaceId("10000000-0000-4000-8000-000000000001");
const OTHER_WORKSPACE_ID = workspaceId("10000000-0000-4000-8000-000000000002");
const CREDENTIAL_ID = "20000000-0000-4000-8000-000000000001";
const OTHER_CREDENTIAL_ID = "20000000-0000-4000-8000-000000000002";
const SECRET_HASH = "a".repeat(64);
const PLAN_ID = dailyPlanId("30000000-0000-4000-8000-000000000001");
const PLAN_ITEM_ID = planItemId("40000000-0000-4000-8000-000000000001");
const SOURCE_WORK_ITEM_ID = workItemId("50000000-0000-4000-8000-000000000001");
const BASE_NOW = new Date("2026-07-13T12:00:00.000Z");

function copy<T>(value: T): T {
  return structuredClone(value);
}

function createHarness() {
  let currentTime = new Date(BASE_NOW);
  let failAudit = false;
  let failRequestSucceed = false;
  let unitOfWorkRuns = 0;
  const workspace = createWorkspace({
    id: WORKSPACE_ID,
    name: "Integration Test",
    now: new Date("2026-07-01T00:00:00.000Z"),
  });
  const credential: IntegrationCredential = {
    id: CREDENTIAL_ID,
    workspaceId: WORKSPACE_ID,
    name: "Hermes",
    secretHash: SECRET_HASH,
    scopes: ["schedule:read", "schedule:write"],
    active: true,
    expiresAt: new Date("2027-01-01T00:00:00.000Z"),
    revokedAt: null,
    version: 1,
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    updatedAt: new Date("2026-07-01T00:00:00.000Z"),
  };
  const credentials: IntegrationCredential[] = [credential];
  const findCredentialByIdForUpdate = vi.fn(async (id: string) =>
    credentials.find((item) => item.id === id),
  );
  const confirmations: IntegrationConfirmationRecord[] = [];
  const requests: IntegrationRequestRecord[] = [];
  const workItems: WorkItem[] = [];
  const scheduleBlocks: ScheduleBlock[] = [];
  const audits: AuditEventRecord[] = [];
  const activityInputs: RecordPlanItemActivityInput[] = [];
  const invalidatedTargets: string[] = [];
  let notificationLocks = 0;
  const workItemListCalls: {
    workspaceId: string;
    status: string | undefined;
    priority: string | undefined;
    limit: number;
    offset: number;
  }[] = [];
  const verifyCalls: { secret: string; secretHash: string }[] = [];
  const currentPlan: DailyPlan = {
    id: PLAN_ID,
    workspaceId: WORKSPACE_ID,
    date: localDate("2026-07-13"),
    timeZone: "UTC",
    items: [],
    totalMinutes: 0,
    fitness: 0,
    algorithmVersion: "test",
    configVersion: "test",
    prngVersion: "test",
    seed: "test",
    requestRevision: 1,
    inputHash: "test",
    inputSnapshot: {
      request: { targetMinutes: 60, availableContexts: ["home"] },
      routines: [{ title: "private snapshot data" }],
      events: [{ reason: "private history" }],
    },
    exclusions: [],
    warnings: [],
    generatedAt: new Date("2026-07-13T08:00:00.000Z"),
  };

  function replace<T>(target: T[], source: readonly T[]): void {
    target.splice(0, target.length, ...source.map(copy));
  }

  const context: IntegrationTransactionContext = {
    credentials: {
      findById: async (id) => credentials.find((item) => item.id === id) ?? null,
      findByIdForUpdate: async (id) => (await findCredentialByIdForUpdate(id)) ?? null,
      list: async (id) => credentials.filter((item) => item.workspaceId === id),
      insert: async (item) => {
        if (credentials.some((candidate) => candidate.id === item.id)) throw new Error("duplicate");
        credentials.push(item);
      },
      save: async (item, expectedVersion) => {
        const index = credentials.findIndex(
          (candidate) => candidate.id === item.id && candidate.version === expectedVersion,
        );
        if (index < 0) throw new Error("version conflict");
        credentials[index] = item;
      },
    },
    confirmations: {
      findByRequestId: async (credentialId, requestId) =>
        confirmations.find(
          (item) => item.credentialId === credentialId && item.requestId === requestId,
        ) ?? null,
      findByIdForUpdate: async (credentialId, confirmationId) =>
        confirmations.find(
          (item) => item.credentialId === credentialId && item.id === confirmationId,
        ) ?? null,
      insertOrFind: async (record) => {
        const existing = confirmations.find(
          (item) =>
            item.credentialId === record.credentialId && item.requestId === record.requestId,
        );
        if (existing !== undefined) return { kind: "existing" as const, confirmation: existing };
        confirmations.push(record);
        return { kind: "inserted" as const, confirmation: record };
      },
      consume: async (credentialId, confirmationId, consumedAt) => {
        const index = confirmations.findIndex(
          (item) => item.credentialId === credentialId && item.id === confirmationId,
        );
        const item = confirmations[index];
        if (
          item === undefined ||
          item.consumedAt !== null ||
          item.expiresAt.getTime() <= consumedAt.getTime()
        ) {
          return false;
        }
        confirmations[index] = { ...item, consumedAt: new Date(consumedAt) };
        return true;
      },
    },
    requests: {
      reserve: async (input) => {
        const existing = requests.find(
          (item) =>
            item.credentialId === input.credentialId &&
            item.idempotencyKey === input.idempotencyKey,
        );
        if (existing !== undefined) {
          if (
            existing.workspaceId !== input.workspaceId ||
            existing.confirmationId !== input.confirmationId ||
            existing.operation !== input.operation ||
            existing.commandHash !== input.commandHash
          ) {
            throw Object.assign(new Error("receipt conflict"), {
              code: "integration.receipt_conflict",
            });
          }
          if (existing.state !== "succeeded") throw new Error("processing receipt");
          return { kind: "replay" as const, request: existing };
        }
        const record: IntegrationRequestRecord = {
          ...input,
          state: "processing",
          result: null,
          completedAt: null,
        };
        requests.push(record);
        return { kind: "reserved" as const, request: record };
      },
      succeed: async (id, result, completedAt) => {
        if (failRequestSucceed) throw new Error("receipt unavailable");
        const index = requests.findIndex((item) => item.id === id);
        const request = requests[index];
        if (request === undefined) throw new Error("missing request");
        const succeeded: IntegrationRequestRecord = {
          ...request,
          state: "succeeded",
          result: copy(result),
          completedAt: new Date(completedAt),
        };
        requests[index] = succeeded;
        return succeeded;
      },
    },
    workspaces: {
      findById: async (id) => (id === WORKSPACE_ID ? workspace : null),
      list: async () => [workspace],
      insert: async () => undefined,
    },
    workItems: {
      findById: async (workspaceIdValue, id) =>
        workItems.find((item) => item.workspaceId === workspaceIdValue && item.id === id) ?? null,
      list: async (workspaceIdValue, status, priority, limit, offset) => {
        workItemListCalls.push({
          workspaceId: workspaceIdValue,
          status,
          priority,
          limit,
          offset,
        });
        return workItems
          .filter(
            (item) =>
              item.workspaceId === workspaceIdValue &&
              (status === undefined || item.status === status) &&
              (priority === undefined || item.priority === priority),
          )
          .slice(offset, offset + limit);
      },
      listPlanningCandidates: async () => workItems,
      insert: async (item) => {
        workItems.push(item);
      },
      save: async (item, expectedVersion) => {
        const index = workItems.findIndex(
          (candidate) => candidate.id === item.id && candidate.version === expectedVersion,
        );
        if (index < 0) throw new Error("work item version conflict");
        workItems[index] = item;
      },
    },
    scheduleBlocks: {
      findById: async (workspaceIdValue, id) =>
        scheduleBlocks.find((item) => item.workspaceId === workspaceIdValue && item.id === id) ??
        null,
      listOverlapping: async () => scheduleBlocks,
      insert: async (block) => {
        scheduleBlocks.push(block);
      },
      save: async (block, expectedVersion) => {
        const index = scheduleBlocks.findIndex(
          (candidate) => candidate.id === block.id && candidate.version === expectedVersion,
        );
        if (index < 0) throw new Error("schedule version conflict");
        scheduleBlocks[index] = block;
      },
      delete: async () => undefined,
    },
    auditEvents: {
      append: async (event) => {
        if (failAudit) throw new Error("audit unavailable");
        audits.push(event);
      },
    },
    dailyPlans: {
      findById: async () => currentPlan,
      findByRevision: async () => currentPlan,
      insertForRevision: async () => currentPlan,
      findCurrent: async (workspaceIdValue, date) =>
        workspaceIdValue === WORKSPACE_ID && date === currentPlan.date
          ? { plan: currentPlan, headVersion: 1 }
          : null,
      findCurrentForDates: async (workspaceIdValue, dates) =>
        workspaceIdValue === WORKSPACE_ID && dates.includes(currentPlan.date)
          ? new Map([[currentPlan.date, { plan: currentPlan, headVersion: 1 }]])
          : new Map(),
      setItemLock: async () => {
        throw new Error("not used");
      },
      recordItemActivity: async (input) => {
        activityInputs.push(input);
        const event = recordActivityEvent({
          workspaceId: input.workspaceId,
          sourceType: "work_item",
          workItemId: SOURCE_WORK_ITEM_ID,
          planId: input.expectedPlanId,
          planItemId: input.itemId,
          type: input.type,
          occurredAt: input.occurredAt,
          timeZone: input.timeZone,
          durationMinutes: input.durationMinutes,
          reason: input.reason,
          idempotencyKey: input.idempotencyKey,
          metadata: input.metadata,
          recordedAt: input.now,
        });
        return {
          planId: input.expectedPlanId,
          itemId: input.itemId,
          activityState: input.type === "completion_reversed" ? "pending" : input.type,
          activityEvent: event,
          headVersion: input.expectedHeadVersion + 1,
          replayed: false,
        };
      },
      lockDay: async () => undefined,
      lockRoutineFeedback: async () => undefined,
      findLatestRoutineFeedback: async () => null,
      findMutation: async () => null,
      insertMutation: async () => undefined,
      listRoutineFeedbackForPlanning: async () => [],
      appendRoutineFeedback: async (feedback) => feedback,
    },
    notifications: {
      lockWorkspace: async () => {
        notificationLocks += 1;
      },
      deleteIntentsForTarget: async (_workspaceId, targetType, targetId, kind) => {
        invalidatedTargets.push(`${targetType}:${targetId}:${kind ?? "all"}`);
        return 1;
      },
    } as IntegrationTransactionContext["notifications"],
  };

  const unitOfWork: IntegrationUnitOfWork = {
    run: async (operation) => {
      unitOfWorkRuns += 1;
      const snapshot = {
        credentials: copy(credentials),
        confirmations: copy(confirmations),
        requests: copy(requests),
        workItems: copy(workItems),
        scheduleBlocks: copy(scheduleBlocks),
        audits: copy(audits),
        activityInputs: copy(activityInputs),
        invalidatedTargets: copy(invalidatedTargets),
        notificationLocks,
      };
      try {
        return await operation(context);
      } catch (error) {
        replace(credentials, snapshot.credentials);
        replace(confirmations, snapshot.confirmations);
        replace(requests, snapshot.requests);
        replace(workItems, snapshot.workItems);
        replace(scheduleBlocks, snapshot.scheduleBlocks);
        replace(audits, snapshot.audits);
        replace(activityInputs, snapshot.activityInputs);
        replace(invalidatedTargets, snapshot.invalidatedTargets);
        notificationLocks = snapshot.notificationLocks;
        throw error;
      }
    },
  };
  const clock = { now: () => new Date(currentTime) };
  const secretVerifier = {
    verify: async (secret: string, secretHash: string) => {
      verifyCalls.push({ secret, secretHash });
      return secret === "secret" && secretHash === SECRET_HASH;
    },
  };
  const principal: IntegrationPrincipal = {
    credentialId: CREDENTIAL_ID,
    workspaceId: WORKSPACE_ID,
    scopes: ["schedule:read", "schedule:write"],
  };
  return {
    unitOfWork,
    clock,
    secretVerifier,
    principal,
    workspace,
    credentials,
    confirmations,
    requests,
    workItems,
    scheduleBlocks,
    audits,
    activityInputs,
    invalidatedTargets,
    getNotificationLocks() {
      return notificationLocks;
    },
    workItemListCalls,
    getUnitOfWorkRuns() {
      return unitOfWorkRuns;
    },
    verifyCalls,
    findCredentialByIdForUpdate,
    setNow(value: string) {
      currentTime = new Date(value);
    },
    setFailAudit(value: boolean) {
      failAudit = value;
    },
    setFailRequestSucceed(value: boolean) {
      failRequestSucceed = value;
    },
    services: {
      authenticate: new AuthenticateIntegrationCredential(unitOfWork, clock, secretVerifier),
      getToday: new GetIntegrationToday(unitOfWork, clock),
      listWorkItems: new ListIntegrationWorkItems(unitOfWork, clock),
      prepare: new PrepareIntegrationCommand(unitOfWork, clock),
      confirm: new ConfirmIntegrationCommand(unitOfWork, clock),
      provision: new ProvisionIntegrationCredential(unitOfWork, clock),
      revoke: new RevokeIntegrationCredential(unitOfWork, clock),
      listCredentials: new ListIntegrationCredentials(unitOfWork),
    },
  };
}

async function prepareAndConfirm(
  test: ReturnType<typeof createHarness>,
  requestId: string,
  command: IntegrationCommand,
) {
  const prepared = await test.services.prepare.execute({
    principal: test.principal,
    requestId,
    command,
  });
  return test.services.confirm.execute({
    principal: test.principal,
    confirmationId: prepared.confirmationId,
    idempotencyKey: `confirm-${requestId}`,
  });
}

describe("integration credential boundary", () => {
  it("uses one generic authentication failure for missing, invalid, revoked, and expired credentials", async () => {
    const scenarios = ["missing", "invalid", "revoked", "expired"] as const;
    const failures: { code?: string; message?: string }[] = [];
    for (const scenario of scenarios) {
      const test = createHarness();
      if (scenario === "revoked") {
        test.credentials[0] = { ...test.credentials[0]!, active: false, revokedAt: BASE_NOW };
      }
      if (scenario === "expired") {
        test.credentials[0] = { ...test.credentials[0]!, expiresAt: BASE_NOW };
      }
      const promise = test.services.authenticate.execute({
        credentialId:
          scenario === "missing" ? "20000000-0000-4000-8000-000000000099" : CREDENTIAL_ID,
        secret: scenario === "invalid" ? "wrong" : "secret",
        requiredScope: "schedule:read",
      });
      try {
        await promise;
      } catch (error) {
        failures.push(error as { code?: string; message?: string });
      }
      expect(test.verifyCalls).toHaveLength(1);
    }
    expect(failures).toHaveLength(4);
    expect(new Set(failures.map((failure) => failure.code))).toEqual(
      new Set(["integration.authentication_failed"]),
    );
    expect(new Set(failures.map((failure) => failure.message)).size).toBe(1);
  });

  it("enforces scopes and re-fetches the credential rather than trusting principal fields", async () => {
    const test = createHarness();
    test.credentials[0] = { ...test.credentials[0]!, scopes: ["schedule:read"] };
    await expect(
      test.services.authenticate.execute({
        credentialId: CREDENTIAL_ID,
        secret: "secret",
        requiredScope: "schedule:write",
      }),
    ).rejects.toMatchObject({ code: "integration.scope_denied" });

    const result = await test.services.getToday.execute({
      principal: { ...test.principal, workspaceId: OTHER_WORKSPACE_ID, scopes: [] },
      date: "2026-07-13",
    });
    expect(result.workspaceId).toBe(WORKSPACE_ID);
  });

  it("provisions, lists, and idempotently revokes credentials without exposing their hash", async () => {
    const test = createHarness();
    const created = await test.services.provision.execute({
      id: "20000000-0000-4000-8000-000000000002",
      workspaceId: WORKSPACE_ID,
      name: "Phone assistant",
      scopes: ["schedule:write", "schedule:read", "schedule:write"],
      secretHash: "b".repeat(64),
    });
    expect(created).toMatchObject({
      name: "Phone assistant",
      scopes: ["schedule:read", "schedule:write"],
    });
    expect(created).not.toHaveProperty("secretHash");
    expect(await test.services.listCredentials.execute({ workspaceId: WORKSPACE_ID })).toHaveLength(
      2,
    );

    const revoked = await test.services.revoke.execute({ credentialId: created.id });
    const replay = await test.services.revoke.execute({ credentialId: created.id });
    expect(revoked).toEqual(replay);
    expect(revoked).toMatchObject({ active: false, version: 2 });
    expect(test.findCredentialByIdForUpdate).toHaveBeenCalledTimes(2);
    expect(
      test.audits.filter((event) => event.action === "integration.credential_revoked"),
    ).toHaveLength(1);
  });

  it("rejects non-hex secret digests and non-UUID credential IDs before persistence", async () => {
    const test = createHarness();
    expect(() =>
      test.services.provision.execute({
        id: "not-a-uuid",
        workspaceId: WORKSPACE_ID,
        name: "Bad",
        scopes: ["schedule:read"],
        secretHash: SECRET_HASH,
      }),
    ).toThrow(expect.objectContaining({ code: "integration.credential_id_invalid" }));
    expect(() =>
      test.services.provision.execute({
        workspaceId: WORKSPACE_ID,
        name: "Bad",
        scopes: ["schedule:read"],
        secretHash: "A".repeat(64),
      }),
    ).toThrow(expect.objectContaining({ code: "integration.secret_hash_invalid" }));
  });
});

describe("integration work-item reads", () => {
  it("lists credential-scoped work items with stable filters, paging, and public DTOs", async () => {
    const test = createHarness();
    const first = createWorkItem({
      id: workItemId("50000000-0000-4000-8000-000000000011"),
      workspaceId: WORKSPACE_ID,
      title: "First",
      status: "backlog",
      priority: "medium",
      now: new Date("2026-07-10T08:00:00.000Z"),
    });
    const second = createWorkItem({
      id: workItemId("50000000-0000-4000-8000-000000000012"),
      workspaceId: WORKSPACE_ID,
      title: "Second",
      status: "in_progress",
      priority: "high",
      now: new Date("2026-07-11T08:00:00.000Z"),
    });
    const third = createWorkItem({
      id: workItemId("50000000-0000-4000-8000-000000000013"),
      workspaceId: WORKSPACE_ID,
      title: "Third",
      status: "backlog",
      priority: "medium",
      now: new Date("2026-07-12T08:00:00.000Z"),
    });
    test.workItems.push(first, second, third);

    const filtered = await test.services.listWorkItems.execute({
      principal: test.principal,
      status: "backlog",
      priority: "medium",
      limit: 1,
      offset: 1,
    });
    expect(filtered).toEqual({
      items: [
        expect.objectContaining({
          id: third.id,
          workspaceId: WORKSPACE_ID,
          title: "Third",
          version: 1,
          createdAt: "2026-07-12T08:00:00.000Z",
          updatedAt: "2026-07-12T08:00:00.000Z",
        }),
      ],
      page: { limit: 1, offset: 1 },
    });
    expect(test.workItemListCalls).toEqual([
      {
        workspaceId: WORKSPACE_ID,
        status: "backlog",
        priority: "medium",
        limit: 1,
        offset: 1,
      },
    ]);
    expect(test.audits).toHaveLength(0);

    const defaults = await test.services.listWorkItems.execute({ principal: test.principal });
    expect(defaults.items.map((item) => item.id)).toEqual([first.id, second.id, third.id]);
    expect(defaults.page).toEqual({ limit: 100, offset: 0 });
  });

  it("derives workspace and scope exclusively from the revalidated credential", async () => {
    const test = createHarness();
    const primary = createWorkItem({
      id: workItemId("50000000-0000-4000-8000-000000000021"),
      workspaceId: WORKSPACE_ID,
      title: "Private",
      now: BASE_NOW,
    });
    const foreign = createWorkItem({
      id: workItemId("50000000-0000-4000-8000-000000000022"),
      workspaceId: OTHER_WORKSPACE_ID,
      title: "Foreign",
      now: BASE_NOW,
    });
    test.workItems.push(primary, foreign);

    const result = await test.services.listWorkItems.execute({
      principal: { ...test.principal, workspaceId: OTHER_WORKSPACE_ID, scopes: [] },
    });
    expect(result.items.map((item) => item.id)).toEqual([primary.id]);
    expect(test.workItemListCalls[0]?.workspaceId).toBe(WORKSPACE_ID);

    test.credentials[0] = { ...test.credentials[0]!, scopes: ["schedule:write"] };
    await expect(
      test.services.listWorkItems.execute({ principal: test.principal }),
    ).rejects.toMatchObject({ code: "integration.scope_denied" });
    expect(test.workItemListCalls).toHaveLength(1);
  });

  it("revalidates credential revocation and expiry before listing", async () => {
    for (const credentialPatch of [
      { active: false, revokedAt: BASE_NOW },
      { expiresAt: BASE_NOW },
    ] as const) {
      const test = createHarness();
      test.credentials[0] = { ...test.credentials[0]!, ...credentialPatch };
      await expect(
        test.services.listWorkItems.execute({ principal: test.principal }),
      ).rejects.toMatchObject({ code: "integration.authentication_failed" });
      expect(test.workItemListCalls).toHaveLength(0);
    }
  });

  it("requires a valid clock timestamp before opening the unit of work", () => {
    const test = createHarness();
    const service = new ListIntegrationWorkItems(test.unitOfWork, {
      now: () => new Date("not-a-timestamp"),
    });
    expect(() => service.execute({ principal: test.principal })).toThrow(
      expect.objectContaining({ code: "integration.timestamp_invalid" }),
    );
    expect(test.getUnitOfWorkRuns()).toBe(0);
    expect(test.workItemListCalls).toHaveLength(0);
  });

  it("rejects invalid filters and paging before entering the unit of work", async () => {
    const invalidQueries = [
      { status: "unknown" },
      { priority: "unknown" },
      { limit: 0 },
      { limit: 201 },
      { limit: 1.5 },
      { offset: -1 },
      { offset: 1_000_001 },
      { offset: 0.5 },
    ];
    for (const query of invalidQueries) {
      const test = createHarness();
      const before = test.getUnitOfWorkRuns();
      expect(() =>
        test.services.listWorkItems.execute({ principal: test.principal, ...query }),
      ).toThrow(
        expect.objectContaining({ code: expect.stringMatching(/^integration\.work_item_/) }),
      );
      expect(test.getUnitOfWorkRuns()).toBe(before);
      expect(test.workItemListCalls).toHaveLength(0);
    }
  });

  it("fails before listing when the credential workspace has disappeared", async () => {
    const test = createHarness();
    test.credentials.push({
      ...test.credentials[0]!,
      id: OTHER_CREDENTIAL_ID,
      workspaceId: OTHER_WORKSPACE_ID,
    });
    await expect(
      test.services.listWorkItems.execute({
        principal: {
          credentialId: OTHER_CREDENTIAL_ID,
          workspaceId: WORKSPACE_ID,
          scopes: ["schedule:read"],
        },
      }),
    ).rejects.toMatchObject({ code: "workspace.not_found" });
    expect(test.workItemListCalls).toHaveLength(0);
  });
});

describe("integration Today and preparation", () => {
  it("returns the public Today projection without planner snapshots or history", async () => {
    const test = createHarness();
    const result = await test.services.getToday.execute({
      principal: test.principal,
      date: "2026-07-13",
    });
    expect(result.plan).not.toHaveProperty("inputSnapshot");
    expect(result.plan).not.toHaveProperty("routines");
    expect(result.plan).not.toHaveProperty("events");
    expect(result.plan).toHaveProperty("request", {
      targetMinutes: 60,
      availableContexts: ["home"],
    });
    expect(JSON.stringify(result)).toContain("2026-07-13T08:00:00.000Z");
  });

  it("replays an identical preparation and conflicts on request ID reuse", async () => {
    const test = createHarness();
    const first = await test.services.prepare.execute({
      principal: test.principal,
      requestId: "message-1",
      command: { type: "work_item.create", title: "Prepare release" },
    });
    const replay = await test.services.prepare.execute({
      principal: test.principal,
      requestId: "message-1",
      command: { title: "Prepare release", type: "work_item.create" },
    });
    expect(replay).toEqual(first);
    expect(replay.command).toEqual({ type: "work_item.create", title: "Prepare release" });
    expect(first.expiresAt).toBe("2026-07-13T12:10:00.000Z");
    expect(test.confirmations).toHaveLength(1);
    expect(
      test.audits.filter((event) => event.action === "integration.command_prepared"),
    ).toHaveLength(1);

    await expect(
      test.services.prepare.execute({
        principal: test.principal,
        requestId: "message-1",
        command: { type: "work_item.create", title: "Different" },
      }),
    ).rejects.toMatchObject({ code: "integration.request_conflict" });
  });

  it("produces exact confirmation summaries that disclose every material change", async () => {
    const test = createHarness();
    const cases: readonly { command: IntegrationCommand; summary: string }[] = [
      {
        command: {
          type: "work_item.create",
          title: "  Task  ",
          description: "Read the release notes",
        },
        summary:
          "Create work item “Task” (status backlog, priority none, not included in daily planning, no due date, description “Read the release notes”).",
      },
      {
        command: {
          type: "work_item.update",
          workItemId: SOURCE_WORK_ITEM_ID,
          expectedVersion: 1,
          status: "cancelled",
          planningDurationMinutes: null,
        },
        summary: `Update work item ${SOURCE_WORK_ITEM_ID}: set status to cancelled; remove from daily planning.`,
      },
      {
        command: {
          type: "work_item.update",
          workItemId: SOURCE_WORK_ITEM_ID,
          expectedVersion: 1,
          dueOn: "2026-08-01",
        },
        summary: `Update work item ${SOURCE_WORK_ITEM_ID}: set due date to 2026-08-01.`,
      },
      {
        command: {
          type: "schedule_block.create",
          workItemId: SOURCE_WORK_ITEM_ID,
          title: "Focus",
          startsAt: "2026-07-13T14:00:00.000Z",
          endsAt: "2026-07-13T15:00:00.000Z",
          timeZone: "UTC",
        },
        summary: `Create “Focus” schedule block from 2026-07-13T14:00:00.000Z to 2026-07-13T15:00:00.000Z (UTC, linked to work item ${SOURCE_WORK_ITEM_ID}).`,
      },
      {
        command: {
          type: "schedule_block.update",
          scheduleBlockId: "60000000-0000-4000-8000-000000000001",
          expectedVersion: 1,
          title: null,
          workItemId: null,
          startsAt: "2026-07-13T16:00:00.000Z",
          timeZone: "America/La_Paz",
        },
        summary:
          "Update schedule block 60000000-0000-4000-8000-000000000001: title: clear it; remove linked work item; set start to 2026-07-13T16:00:00.000Z; set time zone to America/La_Paz.",
      },
      {
        command: {
          type: "plan_item.activity",
          date: "2026-07-13",
          expectedPlanId: PLAN_ID,
          itemId: PLAN_ITEM_ID,
          expectedHeadVersion: 1,
          activityType: "completed",
          occurredAt: "2026-07-13T12:05:00.000Z",
          timeZone: "UTC",
          durationMinutes: 25,
          reason: "Finished during focus time",
        },
        summary: `Record completed for plan item ${PLAN_ITEM_ID} (on plan date 2026-07-13, at 2026-07-13T12:05:00.000Z, 25 actual minutes, reason “Finished during focus time”).`,
      },
    ];
    for (const [index, item] of cases.entries()) {
      const prepared = await test.services.prepare.execute({
        principal: test.principal,
        requestId: `summary-${index}`,
        command: item.command,
      });
      expect(prepared.summary).toBe(item.summary);
    }
  });

  it("returns the exact stored command while bounding and sanitizing its advisory summary", async () => {
    const test = createHarness();
    const command = {
      type: "work_item.create",
      title: "Review \u202Ehidden\u202C\nnotes",
      description: `Long \u2066description\u2069 ${"x".repeat(3_981)}`,
      priority: "urgent",
      planningDurationMinutes: 30,
    } as const satisfies IntegrationCommand;
    const first = await test.services.prepare.execute({
      principal: test.principal,
      requestId: "advisory-summary-safety",
      command,
    });
    const originalResponse = structuredClone(first);

    expect(first.command).toEqual(command);
    expect((first.command as typeof command).description).toHaveLength(4_000);
    expect(first.commandDisplay).toContain("\\u202E");
    expect(first.commandDisplay).toContain("\\u202C");
    expect(first.commandDisplay).toContain("\\u000A");
    expect(first.commandDisplay).toContain("\\u2066");
    expect(first.commandDisplay).not.toContain("\u202E");
    expect(JSON.parse(first.commandDisplay)).toEqual(command);
    expect(createHash("sha256").update(first.commandDisplay).digest("hex")).toBe(first.commandHash);
    expect(first.summary.length).toBeLessThanOrEqual(500);
    expect(first.summary).toContain("Review hidden notes");
    expect(first.summary).toContain("description “Long description");
    expect(first.summary).toContain("…");
    for (const character of first.summary) {
      const codePoint = character.codePointAt(0)!;
      expect(
        codePoint <= 0x1f ||
          (codePoint >= 0x7f && codePoint <= 0x9f) ||
          codePoint === 0x061c ||
          (codePoint >= 0x200b && codePoint <= 0x200f) ||
          (codePoint >= 0x2028 && codePoint <= 0x202e) ||
          (codePoint >= 0x2066 && codePoint <= 0x206f),
      ).toBe(false);
    }

    (first.command as unknown as { title: string }).title = "caller mutation";
    const replay = await test.services.prepare.execute({
      principal: test.principal,
      requestId: "advisory-summary-safety",
      command,
    });
    expect(replay).toEqual(originalResponse);
    expect(replay.command).toEqual(command);
    expect(replay.commandDisplay).toBe(originalResponse.commandDisplay);
  });

  it("strictly rejects unknown fields, empty updates, and non-completion durations", async () => {
    const test = createHarness();
    const invalidCommands = [
      { type: "work_item.create", title: "Task", workspaceId: WORKSPACE_ID },
      { type: "work_item.create", title: "   " },
      { type: "work_item.create", title: "Task", description: "x".repeat(4_001) },
      { type: "work_item.create", title: "Task", dueOn: "2026-02-29" },
      { type: "work_item.create", title: "Task", dueOn: "2026-07-32" },
      { type: "work_item.update", workItemId: SOURCE_WORK_ITEM_ID, expectedVersion: 1, dueOn: 1 },
      { type: "work_item.update", workItemId: SOURCE_WORK_ITEM_ID, expectedVersion: 1 },
      {
        type: "schedule_block.update",
        scheduleBlockId: "60000000-0000-4000-8000-000000000001",
        expectedVersion: 1,
      },
      {
        type: "schedule_block.create",
        startsAt: "2026-07-13T15:00:00.000Z",
        endsAt: "2026-07-13T14:00:00.000Z",
        timeZone: "UTC",
      },
      {
        type: "schedule_block.create",
        startsAt: "2026-07-13T14:00:00.000Z",
        endsAt: "2026-07-13T15:00:00.000Z",
        timeZone: "Mars/Olympus_Mons",
      },
      {
        type: "plan_item.activity",
        date: "2026-07-13",
        expectedPlanId: PLAN_ID,
        itemId: PLAN_ITEM_ID,
        expectedHeadVersion: 1,
        activityType: "skipped",
        occurredAt: BASE_NOW.toISOString(),
        timeZone: "UTC",
        durationMinutes: 15,
      },
      {
        type: "plan_item.activity",
        date: "2026-07-13",
        expectedPlanId: PLAN_ID,
        itemId: PLAN_ITEM_ID,
        expectedHeadVersion: 1,
        activityType: "completed",
        occurredAt: BASE_NOW.toISOString(),
        timeZone: "UTC",
        metadata: Object.fromEntries(
          Array.from({ length: 9 }, (_, index) => [`field${index}`, index]),
        ),
      },
    ];
    for (const [index, command] of invalidCommands.entries()) {
      expect(() =>
        test.services.prepare.execute({
          principal: test.principal,
          requestId: `invalid-${index}`,
          command: command as IntegrationCommand,
        }),
      ).toThrow(expect.objectContaining({ code: "integration.command_invalid" }));
    }
    expect(test.confirmations).toHaveLength(0);
  });

  it("rolls back a prepared confirmation when its audit event cannot be persisted", async () => {
    const test = createHarness();
    test.setFailAudit(true);
    await expect(
      test.services.prepare.execute({
        principal: test.principal,
        requestId: "prepare-audit-failure",
        command: { type: "work_item.create", title: "Do not strand" },
      }),
    ).rejects.toThrow("audit unavailable");
    expect(test.confirmations).toHaveLength(0);
    expect(test.audits).toHaveLength(0);
  });
});

describe("integration confirmation execution", () => {
  it("canonicalizes, executes, clears, and replays work-item due dates", async () => {
    const test = createHarness();
    const withDueDate = await test.services.prepare.execute({
      principal: test.principal,
      requestId: "due-date-canonical",
      command: { type: "work_item.create", title: "File return", dueOn: "2026-07-31" },
    });
    const withoutDueDate = await test.services.prepare.execute({
      principal: test.principal,
      requestId: "due-date-omitted",
      command: { type: "work_item.create", title: "File return" },
    });
    expect(withDueDate.commandDisplay).toContain('"dueOn":"2026-07-31"');
    expect(withDueDate.commandHash).not.toBe(withoutDueDate.commandHash);
    expect(withDueDate.summary).toContain("due 2026-07-31");

    const created = await test.services.confirm.execute({
      principal: test.principal,
      confirmationId: withDueDate.confirmationId,
      idempotencyKey: "due-date-create",
    });
    if (created.outcome.type !== "work_item.created") throw new Error("unexpected outcome");
    expect(created.receiptVersion).toBe(1);
    expect(created.outcome.workItem.dueOn).toBe("2026-07-31");

    const clear = await prepareAndConfirm(test, "due-date-clear", {
      type: "work_item.update",
      workItemId: created.outcome.workItem.id,
      expectedVersion: 1,
      dueOn: null,
    });
    expect(clear.outcome).toMatchObject({
      type: "work_item.updated",
      workItem: { dueOn: null, version: 2 },
    });
    expect(
      test.workItems.find((item) => item.id === created.outcome.workItem.id)?.dueOn,
    ).toBeNull();

    const replay = await test.services.confirm.execute({
      principal: test.principal,
      confirmationId: withDueDate.confirmationId,
      idempotencyKey: "due-date-create",
    });
    expect(replay).toEqual(created);
    expect(test.getNotificationLocks()).toBe(2);
    expect(test.invalidatedTargets).toEqual([`work_item:${created.outcome.workItem.id}:all`]);

    const storedResult = test.requests.find(
      (request) => request.idempotencyKey === "due-date-create",
    )?.result;
    if (storedResult?.outcome.type !== "work_item.created") throw new Error("unexpected outcome");
    const { dueOn: _dueOn, ...workItemWithoutDueDate } = storedResult.outcome.workItem;
    void _dueOn;
    const requestIndex = test.requests.findIndex(
      (request) => request.idempotencyKey === "due-date-create",
    );
    test.requests[requestIndex] = {
      ...test.requests[requestIndex]!,
      result: {
        ...storedResult,
        outcome: {
          ...storedResult.outcome,
          workItem: workItemWithoutDueDate as typeof storedResult.outcome.workItem,
        },
      },
    };
    await expect(
      test.services.confirm.execute({
        principal: test.principal,
        confirmationId: withDueDate.confirmationId,
        idempotencyKey: "due-date-create",
      }),
    ).rejects.toMatchObject({ code: "integration.receipt_corrupt" });

    const legacySource = await test.services.confirm.execute({
      principal: test.principal,
      confirmationId: withoutDueDate.confirmationId,
      idempotencyKey: "due-date-legacy-replay",
    });
    if (legacySource.outcome.type !== "work_item.created") throw new Error("unexpected outcome");
    expect(legacySource.receiptVersion).toBe(1);
    expect(legacySource.outcome.workItem.dueOn).toBeNull();
    const { receiptVersion: _receiptVersion, ...legacyEnvelope } = legacySource;
    const { dueOn: _legacyDueOn, ...legacyWorkItem } = legacySource.outcome.workItem;
    void _receiptVersion;
    void _legacyDueOn;
    const legacyResult = {
      ...legacyEnvelope,
      outcome: { ...legacySource.outcome, workItem: legacyWorkItem },
    } as typeof legacySource;
    const legacyRequestIndex = test.requests.findIndex(
      (request) => request.idempotencyKey === "due-date-legacy-replay",
    );
    test.requests[legacyRequestIndex] = {
      ...test.requests[legacyRequestIndex]!,
      result: legacyResult,
    };
    const legacyReplay = await test.services.confirm.execute({
      principal: test.principal,
      confirmationId: withoutDueDate.confirmationId,
      idempotencyKey: "due-date-legacy-replay",
    });
    expect(legacyReplay).toEqual(legacyResult);
  });

  it("expires and consumes confirmations once while replaying the same receipt exactly", async () => {
    const expiredTest = createHarness();
    const expired = await expiredTest.services.prepare.execute({
      principal: expiredTest.principal,
      requestId: "expired",
      command: { type: "work_item.create", title: "Too late" },
    });
    expiredTest.setNow("2026-07-13T12:10:00.000Z");
    await expect(
      expiredTest.services.confirm.execute({
        principal: expiredTest.principal,
        confirmationId: expired.confirmationId,
        idempotencyKey: "expired-confirmation",
      }),
    ).rejects.toMatchObject({ code: "integration.confirmation_expired" });
    expect(expiredTest.requests).toHaveLength(0);
    expect(expiredTest.workItems).toHaveLength(0);

    const test = createHarness();
    const prepared = await test.services.prepare.execute({
      principal: test.principal,
      requestId: "once",
      command: { type: "work_item.create", title: "Only once" },
    });
    const first = await test.services.confirm.execute({
      principal: test.principal,
      confirmationId: prepared.confirmationId,
      idempotencyKey: "receipt-once",
    });
    const replay = await test.services.confirm.execute({
      principal: test.principal,
      confirmationId: prepared.confirmationId,
      idempotencyKey: "receipt-once",
    });
    expect(JSON.stringify(replay)).toBe(JSON.stringify(first));
    expect(test.workItems).toHaveLength(1);
    expect(
      test.audits.filter((event) => event.action === "integration.command_confirmed"),
    ).toHaveLength(1);
    const storedResult = test.requests[0]!.result!;
    if (storedResult.outcome.type !== "work_item.created") throw new Error("unexpected outcome");
    test.requests[0] = {
      ...test.requests[0]!,
      result: {
        ...storedResult,
        outcome: {
          ...storedResult.outcome,
          workItem: { ...storedResult.outcome.workItem, workspaceId: OTHER_WORKSPACE_ID },
        },
      },
    };
    await expect(
      test.services.confirm.execute({
        principal: test.principal,
        confirmationId: prepared.confirmationId,
        idempotencyKey: "receipt-once",
      }),
    ).rejects.toMatchObject({ code: "integration.receipt_corrupt" });
    await expect(
      test.services.confirm.execute({
        principal: test.principal,
        confirmationId: prepared.confirmationId,
        idempotencyKey: "different-receipt",
      }),
    ).rejects.toMatchObject({ code: "integration.confirmation_consumed" });
  });

  it("conflicts when a receipt key is reused for a different confirmation", async () => {
    const test = createHarness();
    const first = await test.services.prepare.execute({
      principal: test.principal,
      requestId: "receipt-a",
      command: { type: "work_item.create", title: "A" },
    });
    const second = await test.services.prepare.execute({
      principal: test.principal,
      requestId: "receipt-b",
      command: { type: "work_item.create", title: "B" },
    });
    await test.services.confirm.execute({
      principal: test.principal,
      confirmationId: first.confirmationId,
      idempotencyKey: "same-receipt",
    });
    await expect(
      test.services.confirm.execute({
        principal: test.principal,
        confirmationId: second.confirmationId,
        idempotencyKey: "same-receipt",
      }),
    ).rejects.toMatchObject({ code: "integration.receipt_conflict" });
    expect(test.workItems.map((item) => item.title)).toEqual(["A"]);
  });

  it("fails closed when a stored receipt outcome is structurally malformed", async () => {
    const test = createHarness();
    const prepared = await test.services.prepare.execute({
      principal: test.principal,
      requestId: "malformed-receipt",
      command: { type: "work_item.create", title: "Valid first result" },
    });
    await test.services.confirm.execute({
      principal: test.principal,
      confirmationId: prepared.confirmationId,
      idempotencyKey: "malformed-receipt-confirm",
    });
    const storedResult = test.requests[0]!.result!;
    if (storedResult.outcome.type !== "work_item.created") throw new Error("unexpected outcome");
    test.requests[0] = {
      ...test.requests[0]!,
      result: {
        ...storedResult,
        outcome: {
          ...storedResult.outcome,
          workItem: {
            ...storedResult.outcome.workItem,
            title: { unexpected: "object" } as unknown as string,
          },
        },
      },
    };
    await expect(
      test.services.confirm.execute({
        principal: test.principal,
        confirmationId: prepared.confirmationId,
        idempotencyKey: "malformed-receipt-confirm",
      }),
    ).rejects.toMatchObject({ code: "integration.receipt_corrupt" });
  });

  it("isolates foreign work, blocks, confirmations, and receipt keys by credential workspace", async () => {
    const test = createHarness();
    test.credentials.push({
      ...test.credentials[0]!,
      id: OTHER_CREDENTIAL_ID,
      workspaceId: OTHER_WORKSPACE_ID,
      name: "Other workspace assistant",
    });
    const otherPrincipal: IntegrationPrincipal = {
      credentialId: OTHER_CREDENTIAL_ID,
      workspaceId: OTHER_WORKSPACE_ID,
      scopes: ["schedule:read", "schedule:write"],
    };
    const foreignWork = createWorkItem({
      id: workItemId("50000000-0000-4000-8000-000000000099"),
      workspaceId: OTHER_WORKSPACE_ID,
      title: "Foreign work",
      now: BASE_NOW,
    });
    const foreignBlock = createScheduleBlock({
      id: scheduleBlockId("60000000-0000-4000-8000-000000000099"),
      workspaceId: OTHER_WORKSPACE_ID,
      title: "Foreign block",
      startsAt: new Date("2026-07-13T14:00:00.000Z"),
      endsAt: new Date("2026-07-13T15:00:00.000Z"),
      timeZone: "UTC",
      now: BASE_NOW,
    });
    test.workItems.push(foreignWork);
    test.scheduleBlocks.push(foreignBlock);

    const workUpdate = await test.services.prepare.execute({
      principal: test.principal,
      requestId: "foreign-work",
      command: {
        type: "work_item.update",
        workItemId: foreignWork.id,
        expectedVersion: 1,
        title: "Stolen",
      },
    });
    await expect(
      test.services.confirm.execute({
        principal: test.principal,
        confirmationId: workUpdate.confirmationId,
        idempotencyKey: "foreign-work-confirm",
      }),
    ).rejects.toMatchObject({ code: "work_item.not_found" });
    expect(test.workItems[0]).toEqual(foreignWork);

    const blockUpdate = await test.services.prepare.execute({
      principal: test.principal,
      requestId: "foreign-block",
      command: {
        type: "schedule_block.update",
        scheduleBlockId: foreignBlock.id,
        expectedVersion: 1,
        title: "Stolen",
      },
    });
    await expect(
      test.services.confirm.execute({
        principal: test.principal,
        confirmationId: blockUpdate.confirmationId,
        idempotencyKey: "foreign-block-confirm",
      }),
    ).rejects.toMatchObject({ code: "schedule_block.not_found" });
    expect(test.scheduleBlocks[0]).toEqual(foreignBlock);

    const primaryPrepared = await test.services.prepare.execute({
      principal: test.principal,
      requestId: "primary-shared-receipt",
      command: { type: "work_item.create", title: "Primary" },
    });
    const primaryResult = await test.services.confirm.execute({
      principal: test.principal,
      confirmationId: primaryPrepared.confirmationId,
      idempotencyKey: "shared-across-credentials",
    });
    const otherPrepared = await test.services.prepare.execute({
      principal: otherPrincipal,
      requestId: "other-shared-receipt",
      command: { type: "work_item.create", title: "Other" },
    });
    const otherResult = await test.services.confirm.execute({
      principal: otherPrincipal,
      confirmationId: otherPrepared.confirmationId,
      idempotencyKey: "shared-across-credentials",
    });
    expect(primaryResult.outcome).toMatchObject({ workItem: { workspaceId: WORKSPACE_ID } });
    expect(otherResult.outcome).toMatchObject({ workItem: { workspaceId: OTHER_WORKSPACE_ID } });

    const hidden = await test.services.prepare.execute({
      principal: otherPrincipal,
      requestId: "foreign-confirmation",
      command: { type: "work_item.create", title: "Hidden" },
    });
    await expect(
      test.services.confirm.execute({
        principal: test.principal,
        confirmationId: hidden.confirmationId,
        idempotencyKey: "foreign-confirmation-access",
      }),
    ).rejects.toMatchObject({ code: "integration.confirmation_not_found" });
  });

  it("revalidates revocation and verifies stored command integrity before dispatch", async () => {
    const revokedTest = createHarness();
    const prepared = await revokedTest.services.prepare.execute({
      principal: revokedTest.principal,
      requestId: "revoke-race",
      command: { type: "work_item.create", title: "Blocked" },
    });
    revokedTest.credentials[0] = {
      ...revokedTest.credentials[0]!,
      active: false,
      revokedAt: BASE_NOW,
    };
    await expect(
      revokedTest.services.confirm.execute({
        principal: revokedTest.principal,
        confirmationId: prepared.confirmationId,
        idempotencyKey: "revoke-race-confirm",
      }),
    ).rejects.toMatchObject({ code: "integration.authentication_failed" });

    const corruptTest = createHarness();
    const corrupt = await corruptTest.services.prepare.execute({
      principal: corruptTest.principal,
      requestId: "corrupt",
      command: { type: "work_item.create", title: "Original" },
    });
    corruptTest.confirmations[0] = {
      ...corruptTest.confirmations[0]!,
      command: { type: "work_item.create", title: "Tampered" },
    };
    await expect(
      corruptTest.services.confirm.execute({
        principal: corruptTest.principal,
        confirmationId: corrupt.confirmationId,
        idempotencyKey: "corrupt-confirm",
      }),
    ).rejects.toMatchObject({ code: "integration.confirmation_corrupt" });
    expect(corruptTest.workItems).toHaveLength(0);
  });

  it("dispatches every supported command with tenant-bound repositories and JSON-ready results", async () => {
    const test = createHarness();
    const seededWork = createWorkItem({
      id: SOURCE_WORK_ITEM_ID,
      workspaceId: WORKSPACE_ID,
      title: "Seeded",
      now: BASE_NOW,
    });
    test.workItems.push(seededWork);
    const seededBlock = createScheduleBlock({
      id: scheduleBlockId("60000000-0000-4000-8000-000000000001"),
      workspaceId: WORKSPACE_ID,
      title: "Seed block",
      startsAt: new Date("2026-07-13T14:00:00.000Z"),
      endsAt: new Date("2026-07-13T15:00:00.000Z"),
      timeZone: "UTC",
      now: BASE_NOW,
    });
    test.scheduleBlocks.push(seededBlock);

    const createdWork = await prepareAndConfirm(test, "work-create", {
      type: "work_item.create",
      title: "From Hermes",
      priority: "high",
      planningDurationMinutes: 45,
    });
    const updatedWork = await prepareAndConfirm(test, "work-update", {
      type: "work_item.update",
      workItemId: SOURCE_WORK_ITEM_ID,
      expectedVersion: 1,
      status: "in_progress",
    });
    const createdBlock = await prepareAndConfirm(test, "block-create", {
      type: "schedule_block.create",
      workItemId: SOURCE_WORK_ITEM_ID,
      title: "Hermes block",
      startsAt: "2026-07-13T16:00:00.000Z",
      endsAt: "2026-07-13T17:00:00.000Z",
      timeZone: "UTC",
    });
    const updatedBlock = await prepareAndConfirm(test, "block-update", {
      type: "schedule_block.update",
      scheduleBlockId: seededBlock.id,
      expectedVersion: 1,
      title: "Updated block",
    });
    const activity = await prepareAndConfirm(test, "plan-activity", {
      type: "plan_item.activity",
      date: "2026-07-13",
      expectedPlanId: PLAN_ID,
      itemId: PLAN_ITEM_ID,
      expectedHeadVersion: 1,
      activityType: "completed",
      occurredAt: "2026-07-13T12:05:00.000Z",
      timeZone: "UTC",
      durationMinutes: 25,
      reason: "Done by phone",
      metadata: { channel: "whatsapp" },
    });

    expect(createdWork.outcome.type).toBe("work_item.created");
    expect(updatedWork.outcome).toMatchObject({
      type: "work_item.updated",
      workItem: { workspaceId: WORKSPACE_ID, status: "in_progress", version: 2 },
    });
    expect(createdBlock.outcome.type).toBe("schedule_block.created");
    expect(updatedBlock.outcome).toMatchObject({
      type: "schedule_block.updated",
      scheduleBlock: { title: "Updated block", version: 2 },
    });
    expect(activity.outcome).toMatchObject({
      type: "plan_item.activity_recorded",
      planItemActivity: { activityState: "completed", headVersion: 2 },
    });
    expect(activity.outcome).not.toHaveProperty("planItemActivity.activityEvent.idempotencyKey");
    expect(test.activityInputs[0]?.workspaceId).toBe(WORKSPACE_ID);
    expect(test.activityInputs[0]?.idempotencyKey).toMatch(/^integration:[0-9a-f]{64}$/);
    expect(test.invalidatedTargets).toEqual([
      `work_item:${SOURCE_WORK_ITEM_ID}:all`,
      `schedule_block:${seededBlock.id}:all`,
      `daily_plan:${PLAN_ID}:daily_follow_up`,
      `work_item:${SOURCE_WORK_ITEM_ID}:work_item_due`,
    ]);
    expect(
      JSON.parse(JSON.stringify([createdWork, updatedWork, createdBlock, updatedBlock, activity])),
    ).toBeDefined();
    expect(
      test.audits.filter((event) => event.action === "integration.command_confirmed"),
    ).toHaveLength(5);
  });

  it("rolls back mutation, confirmation consumption, and receipt when audit persistence fails", async () => {
    const test = createHarness();
    const prepared = await test.services.prepare.execute({
      principal: test.principal,
      requestId: "atomic",
      command: { type: "work_item.create", title: "Atomic" },
    });
    test.setFailAudit(true);
    await expect(
      test.services.confirm.execute({
        principal: test.principal,
        confirmationId: prepared.confirmationId,
        idempotencyKey: "atomic-confirm",
      }),
    ).rejects.toThrow("audit unavailable");
    expect(test.workItems).toHaveLength(0);
    expect(test.requests).toHaveLength(0);
    expect(test.confirmations[0]?.consumedAt).toBeNull();
  });

  it("rolls back the mutation and audit when receipt completion fails", async () => {
    const test = createHarness();
    const prepared = await test.services.prepare.execute({
      principal: test.principal,
      requestId: "receipt-atomic",
      command: { type: "work_item.create", title: "Receipt atomic" },
    });
    test.setFailRequestSucceed(true);
    await expect(
      test.services.confirm.execute({
        principal: test.principal,
        confirmationId: prepared.confirmationId,
        idempotencyKey: "receipt-atomic-confirm",
      }),
    ).rejects.toThrow("receipt unavailable");
    expect(test.workItems).toHaveLength(0);
    expect(test.requests).toHaveLength(0);
    expect(test.confirmations[0]?.consumedAt).toBeNull();
    expect(test.audits.map((event) => event.action)).toEqual(["integration.command_prepared"]);
  });
});
