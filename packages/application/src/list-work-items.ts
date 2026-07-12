import {
  DomainError,
  type WorkItem,
  type WorkItemPriority,
  type WorkItemStatus,
  type WorkspaceId,
} from "@schedule/domain";

import type { UnitOfWork } from "./ports.js";

export interface ListWorkItemsQuery {
  readonly workspaceId: WorkspaceId;
  readonly status?: WorkItemStatus;
  readonly priority?: WorkItemPriority;
  readonly limit?: number;
  readonly offset?: number;
}

export interface WorkItemPage {
  readonly items: readonly WorkItem[];
  readonly limit: number;
  readonly offset: number;
}

export class ListWorkItems {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  execute(query: ListWorkItemsQuery): Promise<WorkItemPage> {
    const limit = query.limit ?? 100;
    const offset = query.offset ?? 0;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new DomainError("work_item.limit_invalid", "Work item limit must be from 1 to 200.");
    }
    if (!Number.isInteger(offset) || offset < 0 || offset > 1_000_000) {
      throw new DomainError(
        "work_item.offset_invalid",
        "Work item offset must be from 0 to 1,000,000.",
      );
    }
    return this.unitOfWork.run(async ({ workItems, workspaces }) => {
      if ((await workspaces.findById(query.workspaceId)) === null) {
        throw new DomainError("workspace.not_found", "The workspace does not exist.");
      }
      const items = await workItems.list(
        query.workspaceId,
        query.status,
        query.priority,
        limit,
        offset,
      );
      return { items, limit, offset };
    });
  }
}
