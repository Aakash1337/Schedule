import { DomainError, workspaceId } from "@schedule/domain";
import { describe, expect, it, vi } from "vitest";

import {
  ClaimNotificationDelivery,
  RecordNotificationDeliveryReceipt,
} from "./notification-delivery.js";
import type {
  IntegrationCredential,
  IntegrationTransactionContext,
  IntegrationUnitOfWork,
  NotificationDeliveryRequestRecord,
} from "./ports.js";

const WORKSPACE_ID = workspaceId("00000000-0000-4000-8000-000000000001");
const CREDENTIAL_ID = "00000000-0000-4000-8000-000000000002";
const DELIVERY_ID = "00000000-0000-4000-8000-000000000003";
const CLAIM_TOKEN = "00000000-0000-4000-8000-000000000004";
const NOW = new Date("2026-07-14T12:00:00.000Z");

function testContext(
  scopes: IntegrationCredential["scopes"] = ["schedule:delivery"],
  active = true,
) {
  const credential: IntegrationCredential = {
    id: CREDENTIAL_ID,
    workspaceId: WORKSPACE_ID,
    name: "Hermes delivery adapter",
    secretHash: "a".repeat(64),
    scopes,
    active,
    expiresAt: null,
    revokedAt: active ? null : new Date(NOW),
    version: 1,
    createdAt: new Date(NOW),
    updatedAt: new Date(NOW),
  };
  const requests = new Map<string, NotificationDeliveryRequestRecord>();
  const audits: unknown[] = [];
  const isolationLevels: unknown[] = [];
  const findById = vi.fn(async (id: string) => (id === credential.id ? credential : null));
  const findByIdForUpdate = vi.fn(async (id: string) => (id === credential.id ? credential : null));
  const claimNext = vi.fn(async () => ({
    deliveryId: DELIVERY_ID,
    intentId: DELIVERY_ID,
    kind: "one_off" as const,
    targetType: "one_off" as const,
    title: "Take medication",
    scheduledFor: new Date("2026-07-14T11:59:00.000Z"),
    localDate: "2026-07-14" as const,
    priority: 90,
    attempt: 1,
    claimToken: CLAIM_TOKEN,
    leaseExpiresAt: new Date("2026-07-14T12:05:00.000Z"),
  }));
  const settle = vi.fn(async () => ({
    deliveryId: DELIVERY_ID,
    status: "retry_scheduled" as const,
  }));
  let locks = 0;
  const context = {
    credentials: {
      findById,
      findByIdForUpdate,
    },
    notifications: {
      lockWorkspace: async () => {
        locks += 1;
      },
    },
    notificationDeliveries: {
      currentTime: async () => new Date(NOW),
      claimNext,
      settle,
    },
    notificationDeliveryRequests: {
      reserve: async (
        input: Parameters<
          IntegrationTransactionContext["notificationDeliveryRequests"]["reserve"]
        >[0],
      ) => {
        const key = `${input.credentialId}:${input.idempotencyKey}`;
        const existing = requests.get(key);
        if (existing !== undefined) {
          if (
            existing.workspaceId !== input.workspaceId ||
            existing.operation !== input.operation ||
            existing.requestHash !== input.requestHash
          ) {
            throw new DomainError("notification_delivery.request_conflict", "Conflicting request.");
          }
          return { kind: "replay" as const, request: existing };
        }
        const record: NotificationDeliveryRequestRecord = {
          ...input,
          state: "processing",
          result: null,
          completedAt: null,
        };
        requests.set(key, record);
        return { kind: "reserved" as const, request: record };
      },
      succeed: async (
        id: string,
        result: Parameters<
          IntegrationTransactionContext["notificationDeliveryRequests"]["succeed"]
        >[1],
        completedAt: Date,
      ) => {
        const entry = [...requests.entries()].find(([, value]) => value.id === id);
        if (entry === undefined) throw new Error("missing request");
        const record: NotificationDeliveryRequestRecord = {
          ...entry[1],
          state: "succeeded",
          result,
          completedAt: new Date(completedAt),
        };
        requests.set(entry[0], record);
        return record;
      },
    },
    auditEvents: {
      append: async (event: unknown) => {
        audits.push(event);
      },
    },
  } as unknown as IntegrationTransactionContext;
  const unitOfWork: IntegrationUnitOfWork = {
    run: async (operation, options) => {
      isolationLevels.push(options?.isolationLevel);
      return operation(context);
    },
  };
  const principal = {
    credentialId: CREDENTIAL_ID,
    workspaceId: WORKSPACE_ID,
    scopes: ["schedule:delivery" as const],
  };
  return {
    credential,
    requests,
    audits,
    isolationLevels,
    findById,
    findByIdForUpdate,
    claimNext,
    settle,
    unitOfWork,
    principal,
    get locks() {
      return locks;
    },
  };
}

describe("notification delivery application services", () => {
  it("claims one bounded command and exactly replays an idempotent request", async () => {
    const test = testContext();
    const service = new ClaimNotificationDelivery(test.unitOfWork);

    const first = await service.execute({
      principal: test.principal,
      idempotencyKey: " claim-1 ",
    });
    const replay = await service.execute({
      principal: test.principal,
      idempotencyKey: "claim-1",
    });

    expect(first).toEqual(replay);
    expect(first.command).toMatchObject({
      deliveryId: DELIVERY_ID,
      intentId: DELIVERY_ID,
      dedupeKey: DELIVERY_ID,
      title: "Take medication",
      attempt: 1,
      claimToken: CLAIM_TOKEN,
    });
    expect(first.command?.scheduledFor).toBe("2026-07-14T11:59:00.000Z");
    expect(test.claimNext).toHaveBeenCalledTimes(1);
    expect(test.findById).toHaveBeenCalledTimes(2);
    expect(test.findByIdForUpdate).toHaveBeenCalledTimes(2);
    expect(test.audits).toHaveLength(1);
    expect(test.locks).toBe(2);
    expect(test.isolationLevels).toEqual(["read_committed", "read_committed"]);
  });

  it("revalidates the delivery-only scope inside the transaction", async () => {
    const test = testContext(["schedule:read"]);
    const service = new ClaimNotificationDelivery(test.unitOfWork);

    await expect(
      service.execute({ principal: test.principal, idempotencyKey: "claim-1" }),
    ).rejects.toMatchObject({ code: "integration.scope_denied" });
    expect(test.claimNext).not.toHaveBeenCalled();
  });

  it("rejects a credential revoked after the outer authentication step", async () => {
    const test = testContext(["schedule:delivery"], false);
    const service = new ClaimNotificationDelivery(test.unitOfWork);

    await expect(
      service.execute({ principal: test.principal, idempotencyKey: "claim-1" }),
    ).rejects.toMatchObject({ code: "integration.authentication_failed" });
    expect(test.claimNext).not.toHaveBeenCalled();
  });

  it("normalizes retry receipts and exactly replays the stored result", async () => {
    const test = testContext();
    const service = new RecordNotificationDeliveryReceipt(test.unitOfWork);
    const input = {
      principal: test.principal,
      idempotencyKey: "receipt-1",
      deliveryId: DELIVERY_ID.toUpperCase(),
      claimToken: CLAIM_TOKEN.toUpperCase(),
      outcome: "retryable_failure" as const,
      failureCode: "transport.unavailable",
      retryAfterSeconds: 30,
    };

    const first = await service.execute(input);
    const replay = await service.execute(input);

    expect(first).toEqual({ deliveryId: DELIVERY_ID, status: "retry_scheduled" });
    expect(replay).toEqual(first);
    expect(test.settle).toHaveBeenCalledTimes(1);
    expect(test.findById).toHaveBeenCalledTimes(2);
    expect(test.findByIdForUpdate).toHaveBeenCalledTimes(2);
    expect(test.settle).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryId: DELIVERY_ID,
        claimToken: CLAIM_TOKEN,
        failureCode: "transport.unavailable",
        retryAfterSeconds: 30,
      }),
    );
  });

  it("rejects free-form or contradictory receipt fields before persistence", async () => {
    const test = testContext();
    const service = new RecordNotificationDeliveryReceipt(test.unitOfWork);

    expect(() =>
      service.execute({
        principal: test.principal,
        idempotencyKey: "receipt-1",
        deliveryId: DELIVERY_ID,
        claimToken: CLAIM_TOKEN,
        outcome: "retryable_failure",
        failureCode: "Raw provider error: phone number +123",
        retryAfterSeconds: 10,
      }),
    ).toThrow(expect.objectContaining({ code: "notification_delivery.failure_code_invalid" }));
    expect(() =>
      service.execute({
        principal: test.principal,
        idempotencyKey: "receipt-2",
        deliveryId: DELIVERY_ID,
        claimToken: CLAIM_TOKEN,
        outcome: "delivered",
        retryAfterSeconds: 10,
      }),
    ).toThrow(expect.objectContaining({ code: "notification_delivery.retry_after_invalid" }));
    expect(test.settle).not.toHaveBeenCalled();
  });
});
