import { createWorkspace, localDate, type DomainError } from "@schedule/domain";
import { describe, expect, it, vi } from "vitest";

import { RedriveNotificationDelivery } from "./redrive-notification-delivery.js";
import type {
  AuditEventRecord,
  NotificationDeliveryHistoryItem,
  NotificationDeliveryRedriveResult,
  TransactionContext,
  UnitOfWork,
  UnitOfWorkOptions,
} from "./ports.js";

const workspace = createWorkspace({
  id: "0d5f891d-b486-48c6-976d-5bc774139661",
  name: "Redrive",
  now: new Date("2026-07-25T09:00:00.000Z"),
});
const delivery: NotificationDeliveryHistoryItem = {
  deliveryId: "8f3284d5-bd75-4c3a-a7c6-8161ee8f9083",
  intentId: "b89c5c5c-513a-498c-b75f-b0c36cd8ff37",
  kind: "one_off",
  targetType: "one_off",
  title: "Redrive me",
  scheduledFor: new Date("2026-07-25T08:00:00.000Z"),
  localDate: localDate("2026-07-25"),
  priority: 100,
  status: "pending",
  attempts: 5,
  availableAt: new Date("2026-07-25T09:01:00.000Z"),
  completedAt: null,
  lastFailureCode: "transport.rejected",
  createdAt: new Date("2026-07-25T08:00:00.000Z"),
  updatedAt: new Date("2026-07-25T09:01:00.000Z"),
};

function harness(result: NotificationDeliveryRedriveResult) {
  const lockWorkspace = vi.fn(async () => undefined);
  const redriveDeadLetterDelivery = vi.fn(async () => result);
  const audits: AuditEventRecord[] = [];
  const context = {
    notifications: { lockWorkspace, redriveDeadLetterDelivery },
    auditEvents: { append: async (event: AuditEventRecord) => void audits.push(event) },
  } as unknown as TransactionContext;
  const options: (UnitOfWorkOptions | undefined)[] = [];
  const unitOfWork: UnitOfWork = {
    run: async (operation, option) => {
      options.push(option);
      return operation(context);
    },
  };
  return {
    service: new RedriveNotificationDelivery(unitOfWork),
    lockWorkspace,
    redriveDeadLetterDelivery,
    audits,
    options,
  };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code } satisfies Partial<DomainError>);
}

describe("RedriveNotificationDelivery", () => {
  it("redrives the same provider-neutral delivery and atomically audits the database timestamp", async () => {
    const test = harness({ kind: "redriven", delivery });

    await expect(
      test.service.execute({
        workspaceId: workspace.id,
        deliveryId: delivery.deliveryId.toUpperCase(),
      }),
    ).resolves.toEqual(delivery);

    expect(test.lockWorkspace).toHaveBeenCalledWith(workspace.id);
    expect(test.redriveDeadLetterDelivery).toHaveBeenCalledWith(workspace.id, delivery.deliveryId);
    expect(test.audits).toEqual([
      expect.objectContaining({
        action: "notification_delivery.redriven",
        entityId: delivery.deliveryId,
        occurredAt: delivery.updatedAt,
        data: {
          intentId: delivery.intentId,
          attempts: 5,
          lastFailureCode: "transport.rejected",
        },
      }),
    ]);
    expect(test.options).toEqual([{ isolationLevel: "read_committed" }]);
  });

  it.each([
    [{ kind: "not_found" } as const, "notification_delivery.command_not_found", undefined],
    [
      { kind: "state_conflict", status: "delivered" } as const,
      "notification_delivery.redrive_conflict",
      "A delivery in delivered state cannot be redriven; only dead-letter deliveries can be redriven.",
    ],
  ])("reports explicit repository result %o", async (result, code, message) => {
    const test = harness(result);
    const redrive = test.service.execute({
      workspaceId: workspace.id,
      deliveryId: delivery.deliveryId,
    });
    await expectCode(redrive, code);
    if (message !== undefined) await expect(redrive).rejects.toMatchObject({ message });
    expect(test.audits).toEqual([]);
  });

  it("rejects malformed delivery identities before opening a transaction", async () => {
    const test = harness({ kind: "redriven", delivery });
    await expectCode(
      test.service.execute({ workspaceId: workspace.id, deliveryId: "not-a-uuid" }),
      "notification_delivery.delivery_id_invalid",
    );
    expect(test.redriveDeadLetterDelivery).not.toHaveBeenCalled();
  });
});
