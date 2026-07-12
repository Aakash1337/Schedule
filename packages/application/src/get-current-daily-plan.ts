import { DomainError, type LocalDate, type WorkspaceId } from "@schedule/domain";

import type { CurrentDailyPlan, UnitOfWork } from "./ports.js";

export interface GetCurrentDailyPlanQuery {
  readonly workspaceId: WorkspaceId;
  readonly date: LocalDate;
}

export class GetCurrentDailyPlan {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  execute(query: GetCurrentDailyPlanQuery): Promise<CurrentDailyPlan> {
    return this.unitOfWork.run(async ({ workspaces, dailyPlans }) => {
      if ((await workspaces.findById(query.workspaceId)) === null) {
        throw new DomainError("workspace.not_found", "The workspace does not exist.");
      }
      const current = await dailyPlans.findCurrent(query.workspaceId, query.date);
      if (current === null) {
        throw new DomainError(
          "planning.current_not_found",
          "No current plan exists for this date.",
        );
      }
      return current;
    });
  }
}
