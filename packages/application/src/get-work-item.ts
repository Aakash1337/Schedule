import { DomainError, type WorkItem, type WorkItemId, type WorkspaceId } from "@schedule/domain";

import type { UnitOfWork } from "./ports.js";

export interface GetWorkItemQuery {
  readonly workspaceId: WorkspaceId;
  readonly workItemId: WorkItemId;
}

export class GetWorkItem {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  execute(query: GetWorkItemQuery): Promise<WorkItem> {
    return this.unitOfWork.run(async ({ workItems, workspaces }) => {
      if ((await workspaces.findById(query.workspaceId)) === null) {
        throw new DomainError("workspace.not_found", "The workspace does not exist.");
      }
      const item = await workItems.findById(query.workspaceId, query.workItemId);
      if (item === null) {
        throw new DomainError("work_item.not_found", "The work item does not exist.");
      }
      return item;
    });
  }
}
