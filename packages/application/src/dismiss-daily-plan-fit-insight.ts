import {
  calculateDailyPlanFitInsight,
  createDailyPlanFitInsightFeedback,
  dailyPlanFitInsightKeyPattern,
  dailyPlanFitInsightLookbackDays,
  dailyPlanFitInsightMaximumCandidatePlans,
  DomainError,
  isValidLocalDate,
  resolveDailyPlanFitInsightFeedback,
  type DailyPlanFitInsightFeedback,
  type DailyPlanFitInsightFeedbackKind,
  type LocalDate,
  type WorkspaceId,
} from "@schedule/domain";

import type { Clock, UnitOfWork } from "./ports.js";

export interface DismissDailyPlanFitInsightCommand {
  readonly workspaceId: WorkspaceId;
  readonly forDate: LocalDate;
  readonly insightKey: string;
  readonly idempotencyKey: string;
}

type DailyPlanFitFeedbackCommand = DismissDailyPlanFitInsightCommand;

function validateCommand(command: DailyPlanFitFeedbackCommand): string {
  if (!isValidLocalDate(command.forDate)) {
    throw new DomainError(
      "daily_plan_fit_insight.for_date_invalid",
      "A valid Plan Fit local date is required.",
    );
  }
  if (!dailyPlanFitInsightKeyPattern.test(command.insightKey)) {
    throw new DomainError(
      "daily_plan_fit_insight.insight_key_invalid",
      "A canonical Daily Plan Fit insight key is required.",
    );
  }
  const idempotencyKey = command.idempotencyKey.trim();
  if (idempotencyKey.length < 1 || idempotencyKey.length > 160) {
    throw new DomainError(
      "daily_plan_fit_insight.feedback_idempotency_key_invalid",
      "A Daily Plan Fit feedback idempotency key must contain 1–160 characters.",
    );
  }
  return idempotencyKey;
}

function isExactReplay(
  feedback: DailyPlanFitInsightFeedback,
  kind: DailyPlanFitInsightFeedbackKind,
  command: DailyPlanFitFeedbackCommand,
  idempotencyKey: string,
): boolean {
  return (
    feedback.workspaceId === command.workspaceId &&
    feedback.forDate === command.forDate &&
    feedback.insightKey === command.insightKey &&
    feedback.kind === kind &&
    feedback.idempotencyKey === idempotencyKey
  );
}

/** @internal Shared exact-key implementation for dismissal and reset commands. */
export async function mutateDailyPlanFitInsightFeedback(
  unitOfWork: UnitOfWork,
  clock: Clock,
  kind: DailyPlanFitInsightFeedbackKind,
  command: DailyPlanFitFeedbackCommand,
): Promise<DailyPlanFitInsightFeedback> {
  const idempotencyKey = validateCommand(command);
  return unitOfWork.run(
    async ({ workspaces, dailyPlans, dailyPlanFitInsightFeedback }) => {
      if ((await workspaces.findById(command.workspaceId)) === null) {
        throw new DomainError("workspace.not_found", "The workspace does not exist.");
      }
      await dailyPlanFitInsightFeedback.lockWorkspace(command.workspaceId);

      const replay = await dailyPlanFitInsightFeedback.findByIdempotencyKey(
        command.workspaceId,
        idempotencyKey,
      );
      if (replay !== null) {
        if (!isExactReplay(replay, kind, command, idempotencyKey)) {
          throw new DomainError(
            "daily_plan_fit_insight.idempotency_conflict",
            "This Daily Plan Fit feedback key already belongs to another command.",
          );
        }
        return replay;
      }

      const recordedAt = clock.now();
      const evidence = await dailyPlans.listFitEvidence(
        command.workspaceId,
        command.forDate,
        dailyPlanFitInsightLookbackDays,
        dailyPlanFitInsightMaximumCandidatePlans,
      );
      const insight = calculateDailyPlanFitInsight(
        command.workspaceId,
        command.forDate,
        evidence,
        recordedAt,
      );
      if (
        insight.status !== "suggested" ||
        insight.insightKey !== command.insightKey ||
        insight.typicalPlannedMinutes === null ||
        insight.typicalCompletedMinutes === null ||
        insight.typicalPlannedTaskCount === null ||
        insight.typicalCompletedTaskCount === null ||
        insight.suggestedTargetMinutes === null ||
        insight.suggestedTargetTaskCount === null
      ) {
        throw new DomainError(
          "daily_plan_fit_insight.evidence_conflict",
          "Resolved-plan evidence changed before this Daily Plan Fit feedback could be recorded.",
        );
      }

      const latest = await dailyPlanFitInsightFeedback.findLatestForKey(
        command.workspaceId,
        command.insightKey,
      );
      const resolved = resolveDailyPlanFitInsightFeedback(
        insight,
        command.workspaceId,
        latest === null ? [] : [latest],
      );
      const expectedDisposition = kind === "dismissed" ? "available" : "dismissed";
      if (resolved.disposition !== expectedDisposition) {
        throw new DomainError(
          "daily_plan_fit_insight.disposition_conflict",
          kind === "dismissed"
            ? "This Daily Plan Fit insight is not available to dismiss."
            : "This Daily Plan Fit insight has no active dismissal to reset.",
        );
      }

      return dailyPlanFitInsightFeedback.append(
        createDailyPlanFitInsightFeedback({
          ingestedSequence: 0,
          workspaceId: command.workspaceId,
          forDate: command.forDate,
          insightKey: command.insightKey,
          kind,
          sampleCount: insight.sampleCount,
          typicalPlannedMinutes: insight.typicalPlannedMinutes,
          typicalCompletedMinutes: insight.typicalCompletedMinutes,
          typicalPlannedTaskCount: insight.typicalPlannedTaskCount,
          typicalCompletedTaskCount: insight.typicalCompletedTaskCount,
          suggestedTargetMinutes: insight.suggestedTargetMinutes,
          suggestedTargetTaskCount: insight.suggestedTargetTaskCount,
          idempotencyKey,
          recordedAt,
        }),
      );
    },
    // Feedback has its own workspace lock. Read committed makes a waiter observe prior feedback.
    { isolationLevel: "read_committed" },
  );
}

export class DismissDailyPlanFitInsight {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(command: DismissDailyPlanFitInsightCommand): Promise<DailyPlanFitInsightFeedback> {
    return mutateDailyPlanFitInsightFeedback(this.unitOfWork, this.clock, "dismissed", command);
  }
}
