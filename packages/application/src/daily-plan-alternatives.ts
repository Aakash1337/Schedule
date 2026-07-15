import { createHash } from "node:crypto";

import {
  DomainError,
  isTerminalPlanItemActivityState,
  previewReplanDailyPlanAlternatives,
  replanDailyPlan,
  type DailyPlanAlternative,
  type DailyPlanId,
  type DailyPlanningRequest,
  type WorkspaceId,
} from "@schedule/domain";

import type { Clock, CurrentDailyPlan, TransactionContext, UnitOfWork } from "./ports.js";
import {
  assertPlanningCandidatePoolSize,
  assertPlanningWorkItemDependencyPoolSize,
  maximumPlanningCandidatePool,
  maximumPlanningWorkItemDependencies,
} from "./planning-candidates.js";

interface AlternativeFence {
  readonly workspaceId: WorkspaceId;
  readonly expectedPlanId: DailyPlanId;
  readonly expectedHeadVersion: number;
  readonly request: DailyPlanningRequest;
}

export type PreviewDailyPlanAlternativesCommand = AlternativeFence;

export interface SelectDailyPlanAlternativeCommand extends AlternativeFence {
  readonly candidateKey: string;
  readonly idempotencyKey: string;
}

export interface DailyPlanAlternativesResult {
  readonly sourcePlanId: DailyPlanId;
  readonly sourceHeadVersion: number;
  readonly alternatives: readonly DailyPlanAlternative[];
}

function validateFence(command: AlternativeFence): void {
  if (!Number.isInteger(command.expectedHeadVersion) || command.expectedHeadVersion < 1) {
    throw new DomainError("planning.head_version_invalid", "Expected head version is invalid.");
  }
}

function assertScope(command: AlternativeFence, current: CurrentDailyPlan): void {
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
    throw new DomainError("planning.source_mismatch", "Alternative request scope is invalid.");
  }
}

function selectionPayloadHash(command: SelectDailyPlanAlternativeCommand): string {
  const { requestRevision: _ignoredRequestRevision, ...effectiveRequest } = command.request;
  void _ignoredRequestRevision;
  return createHash("sha256")
    .update(
      JSON.stringify({
        kind: "alternative_select",
        expectedPlanId: command.expectedPlanId,
        expectedHeadVersion: command.expectedHeadVersion,
        request: effectiveRequest,
        candidateKey: command.candidateKey,
      }),
    )
    .digest("hex");
}

async function loadPlanningInputs(
  context: TransactionContext,
  command: AlternativeFence,
  current: CurrentDailyPlan,
  generatedAt: Date,
) {
  const request = {
    ...command.request,
    requestRevision: current.plan.requestRevision + 1,
  };
  const [routines, graph, events, routineFeedback] = await Promise.all([
    context.routines.listPlanningCandidates(command.workspaceId, request.date),
    context.workItemDependencies.loadPlanningGraph(
      command.workspaceId,
      maximumPlanningCandidatePool + 1,
      maximumPlanningWorkItemDependencies + 1,
    ),
    context.activityEvents.listForPlanning(command.workspaceId, request.date),
    context.dailyPlans.listRoutineFeedbackForPlanning(command.workspaceId, request.date),
  ]);
  assertPlanningCandidatePoolSize(routines.length, graph.workItems.length);
  assertPlanningWorkItemDependencyPoolSize(graph.dependencies.length);
  return {
    sourcePlan: current.plan,
    request,
    routines,
    workItems: graph.workItems,
    workItemDependencies: graph.dependencies,
    events,
    routineFeedback,
    anchoredItems: current.plan.items.filter(
      (item) => item.locked && !isTerminalPlanItemActivityState(item.activityState),
    ),
    kind: "alternative_select" as const,
    generatedAt,
  };
}

export class DailyPlanAlternatives {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  preview(command: PreviewDailyPlanAlternativesCommand): Promise<DailyPlanAlternativesResult> {
    validateFence(command);
    return this.unitOfWork.run(async (context) => {
      await context.dailyPlans.lockDay(command.workspaceId, command.request.date);
      const current = await context.dailyPlans.findCurrent(
        command.workspaceId,
        command.request.date,
      );
      if (current === null) {
        throw new DomainError(
          "planning.current_not_found",
          "No current plan exists for this date.",
        );
      }
      assertScope(command, current);
      const input = await loadPlanningInputs(context, command, current, this.clock.now());
      const preview = previewReplanDailyPlanAlternatives(input);
      return {
        sourcePlanId: current.plan.id,
        sourceHeadVersion: current.headVersion,
        alternatives: preview.alternatives,
      };
    });
  }

  select(command: SelectDailyPlanAlternativeCommand): Promise<CurrentDailyPlan> {
    validateFence(command);
    const candidateKey = command.candidateKey.trim().toLocaleLowerCase("en-US");
    if (!/^[a-f0-9]{64}$/.test(candidateKey)) {
      throw new DomainError(
        "planning.alternative_key_invalid",
        "A valid daily-plan alternative key is required.",
      );
    }
    const idempotencyKey = command.idempotencyKey.trim();
    if (idempotencyKey.length < 1 || idempotencyKey.length > 160) {
      throw new DomainError(
        "planning.idempotency_key_invalid",
        "A plan mutation idempotency key must contain 1–160 characters.",
      );
    }
    const effectiveCommand = { ...command, candidateKey, idempotencyKey };
    const payloadHash = selectionPayloadHash(effectiveCommand);
    const now = this.clock.now();
    return this.unitOfWork.run(async (context) => {
      await context.notifications.lockWorkspace(command.workspaceId);
      await context.dailyPlans.lockDay(command.workspaceId, command.request.date);
      const prior = await context.dailyPlans.findMutation(
        command.workspaceId,
        command.request.date,
        idempotencyKey,
      );
      if (prior !== null) {
        if (prior.payloadHash !== payloadHash) {
          throw new DomainError(
            "planning.idempotency_conflict",
            "This plan mutation key already belongs to another command.",
          );
        }
        const plan = await context.dailyPlans.findById(command.workspaceId, prior.resultPlanId);
        if (plan === null) throw new DomainError("planning.result_not_found", "Result missing.");
        return { plan, headVersion: prior.resultHeadVersion };
      }
      const current = await context.dailyPlans.findCurrent(
        command.workspaceId,
        command.request.date,
      );
      if (current === null) {
        throw new DomainError(
          "planning.current_not_found",
          "No current plan exists for this date.",
        );
      }
      assertScope(command, current);
      const input = await loadPlanningInputs(context, command, current, now);
      const preview = previewReplanDailyPlanAlternatives(input);
      if (!preview.alternatives.some((candidate) => candidate.candidateKey === candidateKey)) {
        throw new DomainError(
          "planning.alternative_stale",
          "The selected daily-plan alternative is no longer available.",
        );
      }
      const generated = replanDailyPlan({ ...input, selectedAlternativeKey: candidateKey });
      const plan = await context.dailyPlans.insertForRevision(generated);
      if (plan.inputHash !== generated.inputHash) {
        throw new DomainError(
          "planning.revision_conflict",
          "The allocated revision already belongs to different planning inputs.",
        );
      }
      const resultHeadVersion = current.headVersion + 1;
      await context.dailyPlans.insertMutation({
        workspaceId: command.workspaceId,
        date: command.request.date,
        idempotencyKey,
        payloadHash,
        kind: "alternative_select",
        sourcePlanId: current.plan.id,
        resultPlanId: plan.id,
        resultHeadVersion,
        createdAt: now,
      });
      await context.notifications.deleteIntentsForTarget(
        command.workspaceId,
        "daily_plan",
        current.plan.id,
      );
      return { plan, headVersion: resultHeadVersion };
    });
  }
}
