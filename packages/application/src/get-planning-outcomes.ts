import {
  addLocalDays,
  calculatePlanningOutcomes,
  DomainError,
  isValidLocalDate,
  planningOutcomesLookbackDays,
  type LocalDate,
  type PlanningOutcomes,
  type WorkspaceId,
} from "@schedule/domain";

import type { UnitOfWork } from "./ports.js";

export interface GetPlanningOutcomesQuery {
  readonly workspaceId: WorkspaceId;
  /** The selected local date; only the 30 dates before it are summarized. */
  readonly forDate: LocalDate;
}

/** Reads a fixed prior-date window without writing telemetry or changing planner behavior. */
export class GetPlanningOutcomes {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  async execute(query: GetPlanningOutcomesQuery): Promise<PlanningOutcomes> {
    if (!isValidLocalDate(query.forDate)) {
      throw new DomainError(
        "planning.outcomes_date_invalid",
        "A valid planning-outcomes local date is required.",
      );
    }
    const dates = Array.from({ length: planningOutcomesLookbackDays }, (_, index) =>
      addLocalDays(query.forDate, index - planningOutcomesLookbackDays),
    );
    return this.unitOfWork.run(async ({ workspaces, dailyPlans }) => {
      if ((await workspaces.findById(query.workspaceId)) === null) {
        throw new DomainError("workspace.not_found", "The workspace does not exist.");
      }
      const current = await dailyPlans.findCurrentForDates(query.workspaceId, dates);
      return calculatePlanningOutcomes(
        query.workspaceId,
        query.forDate,
        [...current.values()].map((entry) => entry.plan),
      );
    });
  }
}
