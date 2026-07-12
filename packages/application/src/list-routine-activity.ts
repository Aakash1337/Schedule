import { DomainError, type RoutineId, type WorkspaceId } from "@schedule/domain";

import type { ActivityHistoryCursor, ActivityHistoryPage, UnitOfWork } from "./ports.js";

export interface ListRoutineActivityQuery {
  readonly workspaceId: WorkspaceId;
  readonly routineId: RoutineId;
  readonly limit?: number;
  readonly cursor?: ActivityHistoryCursor;
}

export class ListRoutineActivity {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  execute(query: ListRoutineActivityQuery): Promise<ActivityHistoryPage> {
    return this.unitOfWork.run(async ({ workspaces, routines, activityEvents }) => {
      if ((await workspaces.findById(query.workspaceId)) === null) {
        throw new DomainError("workspace.not_found", "The workspace does not exist.");
      }
      if ((await routines.findById(query.workspaceId, query.routineId)) === null) {
        throw new DomainError("routine.not_found", "The routine does not exist.");
      }
      const limit = query.limit ?? 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
        throw new DomainError("activity.history_limit_invalid", "History limit must be 1–200.");
      }
      if (
        query.cursor !== undefined &&
        (!Number.isSafeInteger(query.cursor.watermark) ||
          !Number.isSafeInteger(query.cursor.before) ||
          query.cursor.watermark < 1 ||
          query.cursor.before < 1 ||
          query.cursor.before > query.cursor.watermark)
      ) {
        throw new DomainError("activity.history_cursor_invalid", "Activity cursor is invalid.");
      }
      return activityEvents.listHistory(query.workspaceId, query.routineId, limit, query.cursor);
    });
  }
}
