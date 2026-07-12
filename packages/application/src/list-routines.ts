import { DomainError, type Routine, type RoutineStatus, type WorkspaceId } from "@schedule/domain";

import type { UnitOfWork } from "./ports.js";

export interface ListRoutinesQuery {
  readonly workspaceId: WorkspaceId;
  readonly status?: RoutineStatus;
  readonly limit?: number;
  readonly offset?: number;
}

export class ListRoutines {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  execute(query: ListRoutinesQuery): Promise<readonly Routine[]> {
    return this.unitOfWork.run(async ({ workspaces, routines }) => {
      if ((await workspaces.findById(query.workspaceId)) === null) {
        throw new DomainError("workspace.not_found", "The workspace does not exist.");
      }
      const limit = query.limit ?? 100;
      const offset = query.offset ?? 0;
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
        throw new DomainError("routine.list_limit_invalid", "Routine list limit must be 1–200.");
      }
      if (!Number.isInteger(offset) || offset < 0 || offset > 1_000_000) {
        throw new DomainError(
          "routine.list_offset_invalid",
          "Routine list offset must be between 0 and 1,000,000.",
        );
      }
      return routines.list(query.workspaceId, query.status, limit, offset);
    });
  }
}
