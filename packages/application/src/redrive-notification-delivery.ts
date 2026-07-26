import { DomainError, type WorkspaceId } from "@schedule/domain";

import type { NotificationDeliveryHistoryItem, UnitOfWork } from "./ports.js";

export interface RedriveNotificationDeliveryCommand {
  readonly workspaceId: WorkspaceId;
  readonly deliveryId: string;
}

function normalizeDeliveryId(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  ) {
    throw new DomainError(
      "notification_delivery.delivery_id_invalid",
      "deliveryId must be a UUID.",
    );
  }
  return value.toLowerCase();
}

/** Requeues one existing dead-letter command without invoking or selecting a provider. */
export class RedriveNotificationDelivery {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async execute(
    command: RedriveNotificationDeliveryCommand,
  ): Promise<NotificationDeliveryHistoryItem> {
    const deliveryId = normalizeDeliveryId(command.deliveryId);
    return this.unitOfWork.run(
      async ({ auditEvents, notifications }) => {
        await notifications.lockWorkspace(command.workspaceId);
        const result = await notifications.redriveDeadLetterDelivery(
          command.workspaceId,
          deliveryId,
        );
        if (result.kind === "not_found") {
          throw new DomainError(
            "notification_delivery.command_not_found",
            "The delivery command does not exist in this workspace.",
          );
        }
        if (result.kind === "state_conflict") {
          throw new DomainError(
            "notification_delivery.redrive_conflict",
            `A delivery in ${result.status} state cannot be redriven; only dead-letter deliveries can be redriven.`,
          );
        }
        await auditEvents.append({
          workspaceId: command.workspaceId,
          action: "notification_delivery.redriven",
          entityType: "notification_delivery",
          entityId: result.delivery.deliveryId,
          data: {
            intentId: result.delivery.intentId,
            attempts: result.delivery.attempts,
            lastFailureCode: result.delivery.lastFailureCode,
          },
          occurredAt: result.delivery.updatedAt,
        });
        return result.delivery;
      },
      { isolationLevel: "read_committed" },
    );
  }
}
