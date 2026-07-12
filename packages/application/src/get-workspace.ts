import { DomainError, type Workspace, type WorkspaceId } from "@schedule/domain";

import type { UnitOfWork } from "./ports.js";

export interface GetWorkspaceQuery {
  readonly workspaceId: WorkspaceId;
}

export class GetWorkspace {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  execute(query: GetWorkspaceQuery): Promise<Workspace> {
    return this.unitOfWork.run(async ({ workspaces }) => {
      const workspace = await workspaces.findById(query.workspaceId);
      if (workspace === null) {
        throw new DomainError("workspace.not_found", "The workspace does not exist.");
      }
      return workspace;
    });
  }
}
