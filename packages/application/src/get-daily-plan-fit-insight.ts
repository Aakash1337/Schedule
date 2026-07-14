import {
  calculateDailyPlanFitInsight,
  dailyPlanFitInsightLookbackDays,
  dailyPlanFitInsightMaximumCandidatePlans,
  DomainError,
  isValidLocalDate,
  resolveDailyPlanFitInsightFeedback,
  type DailyPlanFitInsight,
  type LocalDate,
  type WorkspaceId,
} from "@schedule/domain";

import type { Clock, UnitOfWork } from "./ports.js";

export interface GetDailyPlanFitInsightQuery {
  readonly workspaceId: WorkspaceId;
  readonly forDate: LocalDate;
}

/** Reads deterministic target guidance without mutating planner settings or generating a plan. */
export class GetDailyPlanFitInsight {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(query: GetDailyPlanFitInsightQuery): Promise<DailyPlanFitInsight> {
    if (!isValidLocalDate(query.forDate)) {
      throw new DomainError(
        "daily_plan_fit_insight.for_date_invalid",
        "A valid Plan Fit local date is required.",
      );
    }
    const evaluatedAt = this.clock.now();
    return this.unitOfWork.run(async ({ workspaces, dailyPlans, dailyPlanFitInsightFeedback }) => {
      if ((await workspaces.findById(query.workspaceId)) === null) {
        throw new DomainError("workspace.not_found", "The workspace does not exist.");
      }
      const evidence = await dailyPlans.listFitEvidence(
        query.workspaceId,
        query.forDate,
        dailyPlanFitInsightLookbackDays,
        dailyPlanFitInsightMaximumCandidatePlans,
      );
      const insight = calculateDailyPlanFitInsight(
        query.workspaceId,
        query.forDate,
        evidence,
        evaluatedAt,
      );
      if (insight.insightKey === null) return insight;
      const feedback = await dailyPlanFitInsightFeedback.findLatestForKey(
        query.workspaceId,
        insight.insightKey,
      );
      return resolveDailyPlanFitInsightFeedback(
        insight,
        query.workspaceId,
        feedback === null ? [] : [feedback],
      );
    });
  }
}
