import {
  calculateDailyPlanFitUsageOutcome,
  DomainError,
  type DailyPlanFitUsageOutcome,
  type WorkspaceId,
} from "@schedule/domain";

import type { UnitOfWork } from "./ports.js";

export const maximumDailyPlanFitUsageOutcomes = 28;

export interface ListDailyPlanFitUsageOutcomesQuery {
  readonly workspaceId: WorkspaceId;
  readonly limit: number;
}

/** Reads explicit Plan Fit uses and resolved outcomes without changing planner state. */
export class ListDailyPlanFitUsageOutcomes {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async execute(
    query: ListDailyPlanFitUsageOutcomesQuery,
  ): Promise<readonly DailyPlanFitUsageOutcome[]> {
    if (
      !Number.isSafeInteger(query.limit) ||
      query.limit < 1 ||
      query.limit > maximumDailyPlanFitUsageOutcomes
    ) {
      throw new DomainError(
        "daily_plan_fit_insight.usage_limit_invalid",
        `Daily Plan Fit usage history must request between 1 and ${maximumDailyPlanFitUsageOutcomes} entries.`,
      );
    }
    return this.unitOfWork.run(async ({ workspaces, dailyPlans, dailyPlanFitInsightFeedback }) => {
      if ((await workspaces.findById(query.workspaceId)) === null) {
        throw new DomainError("workspace.not_found", "The workspace does not exist.");
      }
      const usages = await dailyPlanFitInsightFeedback.listUsed(query.workspaceId, query.limit);
      const dates = [...new Set(usages.map((usage) => usage.forDate))];
      const currentByDate = await dailyPlans.findCurrentForDates(query.workspaceId, dates);
      return usages.map((usage) =>
        calculateDailyPlanFitUsageOutcome(usage, currentByDate.get(usage.forDate) ?? null),
      );
    });
  }
}
