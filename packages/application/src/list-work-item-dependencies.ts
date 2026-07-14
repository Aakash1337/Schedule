import { DomainError, type WorkItemDependency, type WorkspaceId } from "@schedule/domain";

import type { UnitOfWork } from "./ports.js";

export interface ListWorkItemDependenciesQuery {
  readonly workspaceId: WorkspaceId;
  readonly limit?: number;
  readonly offset?: number;
}

export interface WorkItemDependencyPage {
  readonly items: readonly WorkItemDependency[];
  readonly limit: number;
  readonly offset: number;
}

export class ListWorkItemDependencies {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  execute(query: ListWorkItemDependenciesQuery): Promise<WorkItemDependencyPage> {
    const limit = query.limit ?? 100;
    const offset = query.offset ?? 0;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new DomainError(
        "work_item_dependency.limit_invalid",
        "Dependency limit must be from 1 to 200.",
      );
    }
    if (!Number.isInteger(offset) || offset < 0 || offset > 1_000_000) {
      throw new DomainError(
        "work_item_dependency.offset_invalid",
        "Dependency offset must be from 0 to 1,000,000.",
      );
    }
    return this.unitOfWork.run(async ({ workspaces, workItemDependencies }) => {
      if ((await workspaces.findById(query.workspaceId)) === null) {
        throw new DomainError("workspace.not_found", "The workspace does not exist.");
      }
      const items = await workItemDependencies.list(query.workspaceId, limit, offset);
      return { items, limit, offset };
    });
  }
}
