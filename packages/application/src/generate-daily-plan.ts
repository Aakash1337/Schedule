import {
  calculateDailyPlanFitInsight,
  createDailyPlanFitInsightFeedback,
  dailyPlanFitInsightLookbackDays,
  dailyPlanFitInsightMaximumCandidatePlans,
  DomainError,
  generateDailyPlan,
  resolveDailyPlanFitInsightFeedback,
  type DailyPlan,
  type DailyPlanFitInsight,
  type DailyPlanFitInsightFeedback,
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
        dailyPlanFitInsightFeedback,
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
        const generatedAt = this.clock.now();
        const planFitInsightKey = command.request.planFitInsightKey ?? null;
        let planFitInsight: DailyPlanFitInsight | null = null;
        let usageReplay: DailyPlanFitInsightFeedback | null = null;
        if (planFitInsightKey !== null) {
          await dailyPlanFitInsightFeedback.lockWorkspace(command.request.workspaceId);
          if (existingRevision !== null) {
            usageReplay = await dailyPlanFitInsightFeedback.findByIdempotencyKey(
              command.request.workspaceId,
              `plan-fit-used:${existingRevision.id}`,
            );
            if (
              usageReplay === null ||
              usageReplay.kind !== "used" ||
              usageReplay.planId !== existingRevision.id ||
              usageReplay.insightKey !== planFitInsightKey ||
              usageReplay.forDate !== command.request.date ||
              usageReplay.appliedTargetMinutes !== command.request.targetMinutes ||
              usageReplay.appliedTargetTaskCount !== command.request.targetTaskCount
            ) {
              throw new DomainError(
                "daily_plan_fit_insight.usage_replay_conflict",
                "This planning revision does not have the exact Plan Fit usage receipt.",
              );
            }
          } else {
            const evidence = await dailyPlans.listFitEvidence(
              command.request.workspaceId,
              command.request.date,
              dailyPlanFitInsightLookbackDays,
              dailyPlanFitInsightMaximumCandidatePlans,
            );
            const calculated = calculateDailyPlanFitInsight(
              command.request.workspaceId,
              command.request.date,
              evidence,
              generatedAt,
            );
            const latest =
              calculated.insightKey === null
                ? null
                : await dailyPlanFitInsightFeedback.findLatestForKey(
                    command.request.workspaceId,
                    calculated.insightKey,
                  );
            const resolved = resolveDailyPlanFitInsightFeedback(
              calculated,
              command.request.workspaceId,
              latest === null ? [] : [latest],
            );
            if (
              resolved.status !== "suggested" ||
              resolved.disposition !== "available" ||
              resolved.insightKey !== planFitInsightKey ||
              resolved.typicalPlannedMinutes === null ||
              resolved.typicalCompletedMinutes === null ||
              resolved.typicalPlannedTaskCount === null ||
              resolved.typicalCompletedTaskCount === null ||
              resolved.suggestedTargetMinutes === null ||
              resolved.suggestedTargetTaskCount === null
            ) {
              throw new DomainError(
                "daily_plan_fit_insight.evidence_conflict",
                "Resolved-plan evidence changed before this Plan Fit selection could be used.",
              );
            }
            planFitInsight = resolved;
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
          generatedAt,
          ...(command.config === undefined ? {} : { config: command.config }),
        });
        const persisted = await dailyPlans.insertForRevision(generated);
        if (persisted.inputHash !== generated.inputHash) {
          throw new DomainError(
            "planning.revision_conflict",
            "This planning revision already exists for a different input snapshot.",
          );
        }
        if (planFitInsight !== null) {
          await dailyPlanFitInsightFeedback.append(
            createDailyPlanFitInsightFeedback({
              ingestedSequence: 0,
              workspaceId: command.request.workspaceId,
              forDate: command.request.date,
              insightKey: planFitInsight.insightKey!,
              kind: "used",
              planId: persisted.id,
              sampleCount: planFitInsight.sampleCount,
              typicalPlannedMinutes: planFitInsight.typicalPlannedMinutes!,
              typicalCompletedMinutes: planFitInsight.typicalCompletedMinutes!,
              typicalPlannedTaskCount: planFitInsight.typicalPlannedTaskCount!,
              typicalCompletedTaskCount: planFitInsight.typicalCompletedTaskCount!,
              suggestedTargetMinutes: planFitInsight.suggestedTargetMinutes!,
              suggestedTargetTaskCount: planFitInsight.suggestedTargetTaskCount!,
              appliedTargetMinutes: command.request.targetMinutes,
              appliedTargetTaskCount: command.request.targetTaskCount,
              idempotencyKey: `plan-fit-used:${persisted.id}`,
              recordedAt: generatedAt,
            }),
          );
        } else if (usageReplay !== null && usageReplay.planId !== persisted.id) {
          throw new DomainError(
            "daily_plan_fit_insight.usage_replay_conflict",
            "The Plan Fit usage receipt does not match the persisted planning revision.",
          );
        }
        return persisted;
      },
    );
  }
}
