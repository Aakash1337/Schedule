import { createHash } from "node:crypto";

import {
  DomainError,
  createRoutinePlanningFeedback,
  isTerminalPlanItemActivityState,
  replanDailyPlan,
  routinePlanningFeedbackId,
  type DailyPlan,
  type DailyPlanId,
  type DailyPlanningRequest,
  type JsonValue,
  type PlanItemId,
  type PlanMutationKind,
  type RoutineId,
  type RoutinePlanningFeedbackSuppressionKind,
  type WorkspaceId,
} from "@schedule/domain";

import type { Clock, CurrentDailyPlan, UnitOfWork } from "./ports.js";
import {
  assertPlanningCandidatePoolSize,
  assertPlanningWorkItemDependencyPoolSize,
  maximumPlanningCandidatePool,
  maximumPlanningWorkItemDependencies,
} from "./planning-candidates.js";

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
export interface ApplyRoutinePlanningFeedbackCommand extends BaseMutationCommand {
  readonly targetItemId: PlanItemId;
  readonly kind: RoutinePlanningFeedbackSuppressionKind;
}
export interface ResetRoutinePlanningFeedbackCommand extends BaseMutationCommand {
  readonly routineId: RoutineId;
}

interface MutationDetails {
  readonly targetItemId?: PlanItemId;
  readonly feedbackKind?: RoutinePlanningFeedbackSuppressionKind;
  readonly routineId?: RoutineId;
}

function jsonObject(value: JsonValue): Readonly<Record<string, JsonValue>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, JsonValue>>)
    : null;
}

/**
 * Plans carry the feedback head they observed inside their immutable planner snapshot.
 * Initial plans store it directly; mutations wrap the fresh planner input once.
 */
interface ObservedFeedbackHead {
  readonly id: string;
  readonly ingestedSequence: number;
}

function observedFeedbackHead(plan: DailyPlan, routineId: RoutineId): ObservedFeedbackHead | null {
  const snapshot = jsonObject(plan.inputSnapshot);
  if (snapshot === null) {
    throw new DomainError(
      "planning.feedback_snapshot_invalid",
      "The source plan does not contain a valid planner snapshot.",
    );
  }
  let plannerInput = snapshot;
  if (snapshot.plannerInput !== undefined) {
    const nestedPlannerInput = jsonObject(snapshot.plannerInput);
    if (nestedPlannerInput === null) {
      throw new DomainError(
        "planning.feedback_snapshot_invalid",
        "The source plan contains invalid nested planner metadata.",
      );
    }
    plannerInput = nestedPlannerInput;
  }
  const value = plannerInput.routineFeedback;
  // Planner versions before routine feedback did not include this collection.
  if (value === undefined) return null;
  if (!Array.isArray(value)) {
    throw new DomainError(
      "planning.feedback_snapshot_invalid",
      "The source plan contains invalid routine feedback metadata.",
    );
  }

  let head: ObservedFeedbackHead | null = null;
  for (const candidate of value) {
    const feedback = jsonObject(candidate);
    if (
      feedback === null ||
      typeof feedback.id !== "string" ||
      typeof feedback.routineId !== "string"
    ) {
      throw new DomainError(
        "planning.feedback_snapshot_invalid",
        "The source plan contains a malformed routine feedback entry.",
      );
    }
    const ingestedSequence = feedback.ingestedSequence;
    if (!Number.isSafeInteger(ingestedSequence) || (ingestedSequence as number) < 1) {
      throw new DomainError(
        "planning.feedback_snapshot_invalid",
        "The source plan contains an invalid routine feedback sequence.",
      );
    }
    if (feedback.routineId !== routineId) continue;
    if (
      head === null ||
      (ingestedSequence as number) > head.ingestedSequence ||
      ((ingestedSequence as number) === head.ingestedSequence && feedback.id > head.id)
    ) {
      head = { id: feedback.id, ingestedSequence: ingestedSequence as number };
    }
  }
  return head;
}

function payloadHash(
  kind: PlanMutationKind,
  command: BaseMutationCommand,
  details: MutationDetails = {},
) {
  const { requestRevision: _ignoredRequestRevision, ...effectiveRequest } = command.request;
  void _ignoredRequestRevision;
  return createHash("sha256")
    .update(
      JSON.stringify({
        kind,
        expectedPlanId: command.expectedPlanId,
        expectedHeadVersion: command.expectedHeadVersion,
        request: effectiveRequest,
        targetItemId: details.targetItemId ?? null,
        feedbackKind: details.feedbackKind ?? null,
        routineId: details.routineId ?? null,
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
    return this.execute("replace", command, { targetItemId: command.targetItemId });
  }

  applyRoutineFeedback(command: ApplyRoutinePlanningFeedbackCommand): Promise<CurrentDailyPlan> {
    return this.execute("feedback", command, {
      targetItemId: command.targetItemId,
      feedbackKind: command.kind,
    });
  }

  resetRoutineFeedback(command: ResetRoutinePlanningFeedbackCommand): Promise<CurrentDailyPlan> {
    return this.execute("feedback_reset", command, { routineId: command.routineId });
  }

  private execute(
    kind: PlanMutationKind,
    command: BaseMutationCommand,
    details: MutationDetails = {},
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
    const hash = payloadHash(kind, command, details);
    const now = this.clock.now();
    return this.unitOfWork.run(
      async ({ routines, workItemDependencies, activityEvents, dailyPlans, notifications }) => {
        await notifications.lockWorkspace(command.workspaceId);
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
        let feedbackRoutineId: RoutineId | null = null;
        let feedbackSourceItemId: PlanItemId | null = null;
        if (kind === "replace") {
          const target = current.plan.items.find((item) => item.id === details.targetItemId);
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
        } else if (kind === "feedback") {
          const target = current.plan.items.find((item) => item.id === details.targetItemId);
          if (target === undefined) {
            throw new DomainError("planning.item_not_found", "The plan item does not exist.");
          }
          if (target.locked) {
            throw new DomainError("planning.item_locked", "A locked item cannot receive feedback.");
          }
          if (target.activityState !== "pending") {
            throw new DomainError(
              "planning.feedback_item_not_pending",
              "Only a pending routine can receive temporary planning feedback.",
            );
          }
          if (target.sourceType !== "routine" || target.routineId === null) {
            throw new DomainError(
              "planning.feedback_routine_required",
              "Temporary planning feedback applies only to routine items.",
            );
          }
          anchors = current.plan.items.filter(
            (item) => item.id !== target.id && !isTerminalPlanItemActivityState(item.activityState),
          );
          feedbackRoutineId = target.routineId;
          feedbackSourceItemId = target.id;
        } else if (kind === "feedback_reset") {
          feedbackRoutineId = details.routineId ?? null;
          if (feedbackRoutineId === null) {
            throw new DomainError(
              "planning.feedback_routine_required",
              "A routine is required to reset planning feedback.",
            );
          }
        }
        if (feedbackRoutineId !== null) {
          await dailyPlans.lockRoutineFeedback(command.workspaceId, feedbackRoutineId);
          const latestFeedback = await dailyPlans.findLatestRoutineFeedback(
            command.workspaceId,
            feedbackRoutineId,
          );
          const observedHead = observedFeedbackHead(current.plan, feedbackRoutineId);
          if (
            (latestFeedback?.ingestedSequence ?? null) !==
              (observedHead?.ingestedSequence ?? null) ||
            (latestFeedback?.id ?? null) !== (observedHead?.id ?? null)
          ) {
            throw new DomainError(
              "planning.feedback_head_conflict",
              "Routine planning feedback changed after this plan was generated.",
            );
          }
        }
        const request = {
          ...command.request,
          requestRevision: current.plan.requestRevision + 1,
        };
        const [routineCandidates, planningWorkItemGraph, events, priorFeedback] = await Promise.all(
          [
            routines.listPlanningCandidates(command.workspaceId, request.date),
            workItemDependencies.loadPlanningGraph(
              command.workspaceId,
              maximumPlanningCandidatePool + 1,
              maximumPlanningWorkItemDependencies + 1,
            ),
            activityEvents.listForPlanning(command.workspaceId, request.date),
            dailyPlans.listRoutineFeedbackForPlanning(command.workspaceId, request.date),
          ],
        );
        assertPlanningCandidatePoolSize(
          routineCandidates.length,
          planningWorkItemGraph.workItems.length,
        );
        assertPlanningWorkItemDependencyPoolSize(planningWorkItemGraph.dependencies.length);
        let routineFeedback = priorFeedback;
        if (feedbackRoutineId !== null) {
          const routine = routineCandidates.find((candidate) => candidate.id === feedbackRoutineId);
          if (routine === undefined) {
            throw new DomainError(
              "planning.feedback_routine_not_found",
              "The feedback routine is not available in this workspace.",
            );
          }
          const feedbackKind = kind === "feedback" ? details.feedbackKind : "reset";
          if (feedbackKind === undefined) {
            throw new DomainError(
              "planning.feedback_kind_invalid",
              "A supported temporary feedback kind is required.",
            );
          }
          const recorded = await dailyPlans.appendRoutineFeedback(
            createRoutinePlanningFeedback({
              id: routinePlanningFeedbackId(),
              ingestedSequence: 0,
              workspaceId: command.workspaceId,
              routineId: feedbackRoutineId,
              kind: feedbackKind,
              effectiveOn: request.date,
              weekStartsOn: routine.cadence.weekStartsOn,
              timeZone: request.timeZone,
              sourcePlanId: current.plan.id,
              sourcePlanItemId: feedbackSourceItemId,
              idempotencyKey,
              recordedAt: now,
            }),
          );
          routineFeedback = [
            ...priorFeedback.filter((feedback) => feedback.id !== recorded.id),
            recorded,
          ];
        }
        const generated = replanDailyPlan({
          sourcePlan: current.plan,
          request,
          routines: routineCandidates,
          workItems: planningWorkItemGraph.workItems,
          workItemDependencies: planningWorkItemGraph.dependencies,
          events,
          routineFeedback,
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
        await notifications.deleteIntentsForTarget(
          command.workspaceId,
          "daily_plan",
          current.plan.id,
        );
        return { plan, headVersion: resultHeadVersion };
      },
      // A feedback mutation takes a per-routine lock after its per-day lock. Read committed gives
      // the post-wait head query a fresh snapshot, so a newer instruction from another date is
      // observed directly rather than relying on serializable conflict detection.
      kind === "feedback" || kind === "feedback_reset"
        ? { isolationLevel: "read_committed" }
        : undefined,
    );
  }
}
