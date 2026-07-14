import { DomainError, type WorkItem, type WorkItemId, type WorkspaceId } from "@schedule/domain";

import type { UnitOfWork } from "./ports.js";

export interface ListWorkItemChildrenQuery {
  readonly workspaceId: WorkspaceId;
  readonly parentWorkItemId: WorkItemId;
  readonly limit?: number;
  readonly offset?: number;
}

export interface WorkItemChildrenPage {
  readonly items: readonly WorkItem[];
  readonly limit: number;
  readonly offset: number;
}

export class ListWorkItemChildren {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  execute(query: ListWorkItemChildrenQuery): Promise<WorkItemChildrenPage> {
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
      if ((await workItems.findById(query.workspaceId, query.parentWorkItemId)) === null) {
        throw new DomainError("work_item.not_found", "The parent work item does not exist.");
      }
      const items = await workItems.list(
        query.workspaceId,
        undefined,
        undefined,
        limit,
        offset,
        query.parentWorkItemId,
      );
      return { items, limit, offset };
    });
  }
}
