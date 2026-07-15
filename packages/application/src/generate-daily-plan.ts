import {
  DomainError,
  generateDailyPlan,
  type DailyPlan,
  type DailyPlanningRequest,
  type PlannerConfig,
} from "@schedule/domain";

import type { Clock, UnitOfWork } from "./ports.js";
import {
  assertPlanningCandidatePoolSize,
  assertPlanningWorkItemDependencyPoolSize,
  maximumPlanningCandidatePool,
  maximumPlanningWorkItemDependencies,
} from "./planning-candidates.js";

export interface GenerateDailyPlanCommand {
  readonly request: DailyPlanningRequest;
  readonly config?: PlannerConfig;
}

export class GenerateDailyPlan {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(command: GenerateDailyPlanCommand): Promise<DailyPlan> {
    return this.unitOfWork.run(
      async ({
        workspaces,
        routines,
        workItemDependencies,
        activityEvents,
        dailyPlans,
        routineSelectionPreferenceFeedback,
      }) => {
        if ((await workspaces.findById(command.request.workspaceId)) === null) {
          throw new DomainError("workspace.not_found", "The workspace does not exist.");
        }
        await dailyPlans.lockDay(command.request.workspaceId, command.request.date);
        const existingRevision = await dailyPlans.findByRevision(
          command.request.workspaceId,
          command.request.date,
          command.request.requestRevision,
        );
        if (existingRevision === null) {
          const current = await dailyPlans.findCurrent(
            command.request.workspaceId,
            command.request.date,
          );
          if (current !== null || command.request.requestRevision !== 1) {
            throw new DomainError(
              "planning.revision_creation_conflict",
              "Generic plan generation may create only revision 1 or retry an existing revision; use a plan mutation endpoint to create later revisions.",
            );
          }
        }
        const routineCandidates = await routines.listPlanningCandidates(
          command.request.workspaceId,
          command.request.date,
        );
        const [planningWorkItemGraph, events, routineFeedback, selectionPreferenceFeedback] =
          await Promise.all([
            workItemDependencies.loadPlanningGraph(
              command.request.workspaceId,
              maximumPlanningCandidatePool + 1,
              maximumPlanningWorkItemDependencies + 1,
            ),
            activityEvents.listForPlanning(command.request.workspaceId, command.request.date),
            dailyPlans.listRoutineFeedbackForPlanning(
              command.request.workspaceId,
              command.request.date,
            ),
            routineSelectionPreferenceFeedback.listForPlanning(
              command.request.workspaceId,
              routineCandidates.map((routine) => routine.id),
              command.request.date,
            ),
          ]);
        assertPlanningCandidatePoolSize(
          routineCandidates.length,
          planningWorkItemGraph.workItems.length,
        );
        assertPlanningWorkItemDependencyPoolSize(planningWorkItemGraph.dependencies.length);
        const generated = generateDailyPlan({
          request: command.request,
          routines: routineCandidates,
          workItems: planningWorkItemGraph.workItems,
          workItemDependencies: planningWorkItemGraph.dependencies,
          events,
          routineFeedback,
          routineSelectionPreferenceFeedback: selectionPreferenceFeedback,
          generatedAt: this.clock.now(),
          ...(command.config === undefined ? {} : { config: command.config }),
        });
        const persisted = await dailyPlans.insertForRevision(generated);
        if (persisted.inputHash !== generated.inputHash) {
          throw new DomainError(
            "planning.revision_conflict",
            "This planning revision already exists for a different input snapshot.",
          );
        }
        return persisted;
      },
    );
  }
}
