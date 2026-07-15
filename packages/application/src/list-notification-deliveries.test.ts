import { createWorkspace, localDate, workspaceId, type DomainError } from "@schedule/domain";
import { describe, expect, it, vi } from "vitest";

import { ListNotificationDeliveries } from "./list-notification-deliveries.js";
import type { NotificationDeliveryHistoryItem, TransactionContext, UnitOfWork } from "./ports.js";

const workspace = createWorkspace({
  id: workspaceId("workspace-delivery-history"),
  name: "Delivery history",
  now: new Date("2026-07-14T08:00:00.000Z"),
});

const historyItem: NotificationDeliveryHistoryItem = {
  deliveryId: "delivery-history-id",
  intentId: "intent-history-id",
  kind: "one_off",
  targetType: "one_off",
  title: "Bring the parcel",
  scheduledFor: new Date("2026-07-14T12:00:00.000Z"),
  localDate: localDate("2026-07-14"),
  priority: 100,
  status: "delivered",
  attempts: 1,
  availableAt: new Date("2026-07-14T12:00:00.000Z"),
  completedAt: new Date("2026-07-14T12:00:05.000Z"),
  lastFailureCode: null,
  createdAt: new Date("2026-07-14T12:00:01.000Z"),
  updatedAt: new Date("2026-07-14T12:00:05.000Z"),
};

function harness(exists = true) {
  const listDeliveryHistory = vi.fn(async () => [historyItem] as const);
  const context = {
    workspaces: { findById: async () => (exists ? workspace : null) },
    notifications: { listDeliveryHistory },
  } as unknown as TransactionContext;
  const unitOfWork: UnitOfWork = {
    run: async (operation) => operation(context),
  };
  return { list: new ListNotificationDeliveries(unitOfWork), listDeliveryHistory };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code } satisfies Partial<DomainError>);
}

describe("ListNotificationDeliveries", () => {
  const query = {
    workspaceId: workspace.id,
    fromInclusive: new Date("2026-07-01T00:00:00.000Z"),
    throughExclusive: new Date("2026-07-15T00:00:00.000Z"),
    limit: 100,
    offset: 0,
  };

  it("returns the bounded product-safe delivery projection", async () => {
    const { list, listDeliveryHistory } = harness();
    await expect(list.execute(query)).resolves.toEqual([historyItem]);
    expect(listDeliveryHistory).toHaveBeenCalledWith(
      workspace.id,
      query.fromInclusive,
      query.throughExclusive,
      100,
      0,
    );
  });

  it.each([
    [{ ...query, throughExclusive: query.fromInclusive }, "notification_delivery.range_invalid"],
    [
      { ...query, throughExclusive: new Date("2026-08-02T00:00:00.000Z") },
      "notification_delivery.range_too_large",
    ],
    [{ ...query, limit: 0 }, "notification_delivery.limit_invalid"],
    [{ ...query, limit: 501 }, "notification_delivery.limit_invalid"],
    [{ ...query, offset: -1 }, "notification_delivery.offset_invalid"],
    [{ ...query, offset: 1_000_001 }, "notification_delivery.offset_invalid"],
  ] as const)("rejects an invalid bounded query", async (invalid, code) => {
    await expectCode(
      Promise.resolve().then(() => harness().list.execute(invalid)),
      code,
    );
  });

  it("rejects a missing workspace before reading history", async () => {
    const { list, listDeliveryHistory } = harness(false);
    await expectCode(list.execute(query), "workspace.not_found");
    expect(listDeliveryHistory).not.toHaveBeenCalled();
  });
});
