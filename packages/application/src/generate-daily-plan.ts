import {
  DomainError,
  generateDailyPlan,
  type DailyPlan,
  type DailyPlanningRequest,
  type PlannerConfig,
} from "@schedule/domain";

import type { Clock, UnitOfWork } from "./ports.js";
import { assertPlanningCandidatePoolSize } from "./planning-candidates.js";

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
      async ({ workspaces, routines, workItems, activityEvents, dailyPlans }) => {
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
        const [routineCandidates, workItemCandidates, events] = await Promise.all([
          routines.listPlanningCandidates(command.request.workspaceId, command.request.date),
          workItems.listPlanningCandidates(command.request.workspaceId),
          activityEvents.listForPlanning(command.request.workspaceId, command.request.date),
        ]);
        assertPlanningCandidatePoolSize(routineCandidates.length, workItemCandidates.length);
        const generated = generateDailyPlan({
          request: command.request,
          routines: routineCandidates,
          workItems: workItemCandidates,
          events,
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
