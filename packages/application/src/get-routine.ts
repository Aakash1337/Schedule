import { DomainError, type Routine, type RoutineId, type WorkspaceId } from "@schedule/domain";

import type { UnitOfWork } from "./ports.js";

export interface GetRoutineQuery {
  readonly workspaceId: WorkspaceId;
  readonly routineId: RoutineId;
}

export class GetRoutine {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  execute(query: GetRoutineQuery): Promise<Routine> {
    return this.unitOfWork.run(async ({ workspaces, routines }) => {
      if ((await workspaces.findById(query.workspaceId)) === null) {
        throw new DomainError("workspace.not_found", "The workspace does not exist.");
      }
      const routine = await routines.findById(query.workspaceId, query.routineId);
      if (routine === null) {
        throw new DomainError("routine.not_found", "The routine does not exist.");
      }
      return routine;
    });
  }
}
