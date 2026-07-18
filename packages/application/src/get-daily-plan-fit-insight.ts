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

import type {
  Clock,
  DailyPlanFitInsightFeedbackRepository,
  DailyPlanRepository,
  UnitOfWork,
  WorkspaceRepository,
} from "./ports.js";

export interface GetDailyPlanFitInsightQuery {
  readonly workspaceId: WorkspaceId;
  readonly forDate: LocalDate;
}

export interface DailyPlanFitInsightReadContext {
  readonly workspaces: Pick<WorkspaceRepository, "findById">;
  readonly dailyPlans: Pick<DailyPlanRepository, "listFitEvidence">;
  readonly dailyPlanFitInsightFeedback: Pick<
    DailyPlanFitInsightFeedbackRepository,
    "findLatestForKey"
  >;
}

/** Shared read core for product and credential-scoped integration transactions. */
export async function readDailyPlanFitInsight(
  context: DailyPlanFitInsightReadContext,
  query: GetDailyPlanFitInsightQuery,
  evaluatedAt: Date,
): Promise<DailyPlanFitInsight> {
  if (!isValidLocalDate(query.forDate)) {
    throw new DomainError(
      "daily_plan_fit_insight.for_date_invalid",
      "A valid Plan Fit local date is required.",
    );
  }
  if ((await context.workspaces.findById(query.workspaceId)) === null) {
    throw new DomainError("workspace.not_found", "The workspace does not exist.");
  }
  const evidence = await context.dailyPlans.listFitEvidence(
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
  const feedback = await context.dailyPlanFitInsightFeedback.findLatestForKey(
    query.workspaceId,
    insight.insightKey,
  );
  return resolveDailyPlanFitInsightFeedback(
    insight,
    query.workspaceId,
    feedback === null ? [] : [feedback],
  );
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
    return this.unitOfWork.run((context) => readDailyPlanFitInsight(context, query, evaluatedAt));
  }
}
