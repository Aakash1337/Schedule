import { DomainError, type Workspace } from "@schedule/domain";

import type { UnitOfWork } from "./ports.js";

export interface ListWorkspacesQuery {
  readonly limit?: number;
  readonly offset?: number;
}

export interface WorkspacePage {
  readonly items: readonly Workspace[];
  readonly limit: number;
  readonly offset: number;
}

export class ListWorkspaces {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  execute(query: ListWorkspacesQuery = {}): Promise<WorkspacePage> {
    const limit = query.limit ?? 20;
    const offset = query.offset ?? 0;
    if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
      throw new DomainError("workspace.limit_invalid", "Workspace limit must be from 1 to 20.");
    }
    if (!Number.isInteger(offset) || offset < 0 || offset > 1_000_000) {
      throw new DomainError(
        "workspace.offset_invalid",
        "Workspace offset must be from 0 to 1,000,000.",
      );
    }
    return this.unitOfWork.run(async ({ workspaces }) => ({
      items: await workspaces.list(limit, offset),
      limit,
      offset,
    }));
  }
}
