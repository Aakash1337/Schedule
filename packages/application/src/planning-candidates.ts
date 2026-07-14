import { DomainError } from "@schedule/domain";

export const maximumPlanningCandidatePool = 500;
export const maximumPlanningWorkItemDependencies = 2_000;

export function assertPlanningCandidatePoolSize(routineCount: number, workItemCount: number): void {
  if (routineCount + workItemCount > maximumPlanningCandidatePool) {
    throw new DomainError(
      "planning.candidate_pool_too_large",
      "The workspace has more than 500 planning candidates; reduce active routines or plannable work items before planning.",
    );
  }
}

export function assertPlanningWorkItemDependencyPoolSize(dependencyCount: number): void {
  if (dependencyCount > maximumPlanningWorkItemDependencies) {
    throw new DomainError(
      "planning.work_item_dependency_pool_too_large",
      "The workspace has more than 2,000 work-item dependencies; reduce the local dependency graph before planning.",
    );
  }
}
