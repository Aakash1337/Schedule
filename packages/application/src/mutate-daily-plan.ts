import { createHash } from "node:crypto";

import {
  DomainError,
  isTerminalPlanItemActivityState,
  replanDailyPlan,
  type DailyPlan,
  type DailyPlanId,
  type DailyPlanningRequest,
  type PlanItemId,
  type PlanMutationKind,
  type WorkspaceId,
} from "@schedule/domain";

import type { Clock, CurrentDailyPlan, UnitOfWork } from "./ports.js";
import { assertPlanningCandidatePoolSize } from "./planning-candidates.js";

interface BaseMutationCommand {
  readonly workspaceId: WorkspaceId;
  readonly expectedPlanId: DailyPlanId;
  readonly expectedHeadVersion: number;
  readonly request: DailyPlanningRequest;
  readonly idempotencyKey: string;
}

export type RegenerateDailyPlanCommand = BaseMutationCommand;
export interface ReplacePlanItemCommand extends BaseMutationCommand {
  readonly targetItemId: PlanItemId;
}

function payloadHash(kind: PlanMutationKind, command: BaseMutationCommand, target?: PlanItemId) {
  const { requestRevision: _ignoredRequestRevision, ...effectiveRequest } = command.request;
  void _ignoredRequestRevision;
  return createHash("sha256")
    .update(
      JSON.stringify({
        kind,
        expectedPlanId: command.expectedPlanId,
        expectedHeadVersion: command.expectedHeadVersion,
        request: effectiveRequest,
        targetItemId: target ?? null,
      }),
    )
    .digest("hex");
}

export class MutateDailyPlan {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  regenerate(command: RegenerateDailyPlanCommand): Promise<CurrentDailyPlan> {
    return this.execute("regenerate", command);
  }

  replace(command: ReplacePlanItemCommand): Promise<CurrentDailyPlan> {
    return this.execute("replace", command, command.targetItemId);
  }

  private execute(
    kind: PlanMutationKind,
    command: BaseMutationCommand,
    targetItemId?: PlanItemId,
  ): Promise<CurrentDailyPlan> {
    if (!Number.isInteger(command.expectedHeadVersion) || command.expectedHeadVersion < 1) {
      throw new DomainError("planning.head_version_invalid", "Expected head version is invalid.");
    }
    const idempotencyKey = command.idempotencyKey.trim();
    if (idempotencyKey.length < 1 || idempotencyKey.length > 160) {
      throw new DomainError(
        "planning.idempotency_key_invalid",
        "A plan mutation idempotency key must contain 1–160 characters.",
      );
    }
    const hash = payloadHash(kind, command, targetItemId);
    const now = this.clock.now();
    return this.unitOfWork.run(async ({ routines, workItems, activityEvents, dailyPlans }) => {
      await dailyPlans.lockDay(command.workspaceId, command.request.date);
      const prior = await dailyPlans.findMutation(
        command.workspaceId,
        command.request.date,
        idempotencyKey,
      );
      if (prior !== null) {
        if (prior.payloadHash !== hash) {
          throw new DomainError(
            "planning.idempotency_conflict",
            "This plan mutation key already belongs to another command.",
          );
        }
        const plan = await dailyPlans.findById(command.workspaceId, prior.resultPlanId);
        if (plan === null) throw new DomainError("planning.result_not_found", "Result missing.");
        return { plan, headVersion: prior.resultHeadVersion };
      }
      const current = await dailyPlans.findCurrent(command.workspaceId, command.request.date);
      if (current === null) {
        throw new DomainError(
          "planning.current_not_found",
          "No current plan exists for this date.",
        );
      }
      if (
        current.plan.id !== command.expectedPlanId ||
        current.headVersion !== command.expectedHeadVersion
      ) {
        throw new DomainError("planning.head_conflict", "The current plan has changed.");
      }
      if (
        command.request.workspaceId !== command.workspaceId ||
        command.request.date !== current.plan.date
      ) {
        throw new DomainError("planning.source_mismatch", "Mutation request scope is invalid.");
      }
      let anchors = current.plan.items.filter(
        (item) => item.locked && !isTerminalPlanItemActivityState(item.activityState),
      );
      let excludedRoutineIds: NonNullable<DailyPlan["items"][number]["routineId"]>[] = [];
      let excludedWorkItemIds: NonNullable<DailyPlan["items"][number]["workItemId"]>[] = [];
      if (kind === "replace") {
        const target = current.plan.items.find((item) => item.id === targetItemId);
        if (target === undefined) {
          throw new DomainError("planning.item_not_found", "The plan item does not exist.");
        }
        if (target.locked) {
          throw new DomainError("planning.item_locked", "A locked item cannot be replaced.");
        }
        anchors = current.plan.items.filter(
          (item) => item.id !== target.id && !isTerminalPlanItemActivityState(item.activityState),
        );
        if (target.sourceType === "routine") {
          if (target.routineId === null) {
            throw new DomainError(
              "planning.source_invalid",
              "The plan item has no routine source.",
            );
          }
          excludedRoutineIds = [target.routineId];
        } else {
          if (target.workItemId === null) {
            throw new DomainError(
              "planning.source_invalid",
              "The plan item has no work item source.",
            );
          }
          excludedWorkItemIds = [target.workItemId];
        }
      }
      const request = {
        ...command.request,
        requestRevision: current.plan.requestRevision + 1,
      };
      const [routineCandidates, workItemCandidates, events] = await Promise.all([
        routines.listPlanningCandidates(command.workspaceId, request.date),
        workItems.listPlanningCandidates(command.workspaceId),
        activityEvents.listForPlanning(command.workspaceId, request.date),
      ]);
      assertPlanningCandidatePoolSize(routineCandidates.length, workItemCandidates.length);
      const generated = replanDailyPlan({
        sourcePlan: current.plan,
        request,
        routines: routineCandidates,
        workItems: workItemCandidates,
        events,
        anchoredItems: anchors,
        excludedRoutineIds,
        excludedWorkItemIds,
        kind,
        generatedAt: now,
      });
      const plan = await dailyPlans.insertForRevision(generated);
      if (plan.inputHash !== generated.inputHash) {
        throw new DomainError(
          "planning.revision_conflict",
          "The allocated revision already belongs to different planning inputs.",
        );
      }
      const resultHeadVersion = current.headVersion + 1;
      await dailyPlans.insertMutation({
        workspaceId: command.workspaceId,
        date: request.date,
        idempotencyKey,
        payloadHash: hash,
        kind,
        sourcePlanId: current.plan.id,
        resultPlanId: plan.id,
        resultHeadVersion,
        createdAt: now,
      });
      return { plan, headVersion: resultHeadVersion };
    });
  }
}
