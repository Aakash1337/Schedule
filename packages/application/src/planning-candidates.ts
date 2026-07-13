import { DomainError } from "@schedule/domain";

export const maximumPlanningCandidatePool = 500;

export function assertPlanningCandidatePoolSize(routineCount: number, workItemCount: number): void {
  if (routineCount + workItemCount > maximumPlanningCandidatePool) {
    throw new DomainError(
      "planning.candidate_pool_too_large",
      "The workspace has more than 500 planning candidates; reduce active routines or plannable work items before planning.",
    );
  }
}
