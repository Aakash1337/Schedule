import { DomainError, type WorkspaceId } from "@schedule/domain";

import type { NotificationDeliveryHistoryItem, UnitOfWork } from "./ports.js";

const DAY_MILLISECONDS = 86_400_000;
const MAXIMUM_NOTIFICATION_DELIVERY_LIST_DAYS = 31;
const MAXIMUM_NOTIFICATION_DELIVERY_OFFSET = 1_000_000;

export interface ListNotificationDeliveriesQuery {
  readonly workspaceId: WorkspaceId;
  readonly fromInclusive: Date;
  readonly throughExclusive: Date;
  readonly limit: number;
  readonly offset: number;
}

export class ListNotificationDeliveries {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  execute(
    query: ListNotificationDeliveriesQuery,
  ): Promise<readonly NotificationDeliveryHistoryItem[]> {
    if (
      !Number.isFinite(query.fromInclusive.getTime()) ||
      !Number.isFinite(query.throughExclusive.getTime()) ||
      query.throughExclusive <= query.fromInclusive
    ) {
      throw new DomainError(
        "notification_delivery.range_invalid",
        "A valid increasing delivery-history time range is required.",
      );
    }
    if (
      query.throughExclusive.getTime() - query.fromInclusive.getTime() >
      MAXIMUM_NOTIFICATION_DELIVERY_LIST_DAYS * DAY_MILLISECONDS
    ) {
      throw new DomainError(
        "notification_delivery.range_too_large",
        "A delivery-history range cannot exceed 31 days.",
      );
    }
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 500) {
      throw new DomainError(
        "notification_delivery.limit_invalid",
        "Limit must be between 1 and 500.",
      );
    }
    if (
      !Number.isInteger(query.offset) ||
      query.offset < 0 ||
      query.offset > MAXIMUM_NOTIFICATION_DELIVERY_OFFSET
    ) {
      throw new DomainError(
        "notification_delivery.offset_invalid",
        "Offset must be between 0 and 1,000,000.",
      );
    }

    return this.unitOfWork.run(async ({ notifications, workspaces }) => {
      if ((await workspaces.findById(query.workspaceId)) === null) {
        throw new DomainError("workspace.not_found", "The workspace does not exist.");
      }
      return notifications.listDeliveryHistory(
        query.workspaceId,
        query.fromInclusive,
        query.throughExclusive,
        query.limit,
        query.offset,
      );
    });
  }
}
