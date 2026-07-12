import type { DailyPlan, LocalDate, WorkspaceId } from "@schedule/domain";

import type { UnitOfWork } from "./ports.js";

export interface GetDailyPlanQuery {
  readonly workspaceId: WorkspaceId;
  readonly date: LocalDate;
  readonly requestRevision: number;
}

export class GetDailyPlan {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  execute(query: GetDailyPlanQuery): Promise<DailyPlan | null> {
    return this.unitOfWork.run(({ dailyPlans }) =>
      dailyPlans.findByRevision(query.workspaceId, query.date, query.requestRevision),
    );
  }
}
