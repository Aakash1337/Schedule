import {
  canonicalRoutineSelectionPreferenceFeedback,
  createRoutineSelectionPreferenceFeedback,
  DomainError,
  instantToLocalDate,
  ROUTINE_SELECTION_PREFERENCE_MAX_RECORDED_EVENTS,
  routineSelectionPreferenceReason,
  routineSelectionPreferenceScore,
  type DailyPlanId,
  type PlanItemId,
  type RoutineId,
  type RoutineSelectionPreferenceFeedbackKind,
  type WorkspaceId,
} from "@schedule/domain";

import type { Clock, RoutineSelectionPreferenceFeedbackReceipt, UnitOfWork } from "./ports.js";
import type { RoutineSelectionPreferenceStateView } from "./get-routine-selection-preference-state.js";

export interface RecordRoutineSelectionPreferenceFeedbackCommand {
  readonly workspaceId: WorkspaceId;
  readonly routineId: RoutineId;
  /** The independent routine-local preference head observed by the caller. */
  readonly expectedFeedbackVersion: number;
  readonly kind: RoutineSelectionPreferenceFeedbackKind;
  readonly timeZone: string;
  readonly sourcePlanId?: DailyPlanId | null;
  readonly sourcePlanItemId?: PlanItemId | null;
  readonly idempotencyKey: string;
}

function validateCommand(command: RecordRoutineSelectionPreferenceFeedbackCommand): string {
  if (
    !Number.isSafeInteger(command.expectedFeedbackVersion) ||
    command.expectedFeedbackVersion < 0
  ) {
    throw new DomainError(
      "planning.selection_preference_version_invalid",
      "Expected routine selection preference version must be a non-negative integer.",
    );
  }
  const idempotencyKey = command.idempotencyKey.trim();
  if (idempotencyKey.length < 1 || idempotencyKey.length > 160) {
    throw new DomainError(
      "planning.selection_preference_idempotency_key_invalid",
      "A selection preference idempotency key must contain 1–160 characters.",
    );
  }
  if (command.sourcePlanItemId != null && command.sourcePlanId == null) {
    throw new DomainError(
      "planning.selection_preference_source_plan_invalid",
      "Selection preference feedback with a source item must identify its source plan.",
    );
  }
  if (command.kind === "reset" && command.sourcePlanItemId != null) {
    throw new DomainError(
      "planning.selection_preference_source_item_invalid",
      "A selection preference reset cannot identify a source plan item.",
    );
  }
  return idempotencyKey;
}

function isExactReplay(
  receipt: RoutineSelectionPreferenceFeedbackReceipt,
  command: RecordRoutineSelectionPreferenceFeedbackCommand,
  idempotencyKey: string,
): boolean {
  const sourcePlanId = command.sourcePlanId ?? null;
  const sourcePlanItemId = command.sourcePlanItemId ?? null;
  return (
    receipt.feedbackVersion === command.expectedFeedbackVersion + 1 &&
    receipt.feedback.workspaceId === command.workspaceId &&
    receipt.feedback.routineId === command.routineId &&
    receipt.feedback.kind === command.kind &&
    receipt.feedback.timeZone === command.timeZone &&
    receipt.feedback.sourcePlanId === sourcePlanId &&
    receipt.feedback.sourcePlanItemId === sourcePlanItemId &&
    receipt.feedback.idempotencyKey === idempotencyKey
  );
}

/**
 * Records one future-planning preference without changing a routine, current
 * plan, or activity history. The idempotency receipt is checked before the
 * routine's feedback-version fence so retrying an accepted command remains
 * safe after later preference changes.
 */
export class RecordRoutineSelectionPreferenceFeedback {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(
    command: RecordRoutineSelectionPreferenceFeedbackCommand,
  ): Promise<RoutineSelectionPreferenceStateView> {
    const idempotencyKey = validateCommand(command);
    return this.unitOfWork.run(
      async ({ workspaces, dailyPlans, routineSelectionPreferenceFeedback }) => {
        if ((await workspaces.findById(command.workspaceId)) === null) {
          throw new DomainError("workspace.not_found", "The workspace does not exist.");
        }
        const projectReceipt = async (
          receipt: RoutineSelectionPreferenceFeedbackReceipt,
        ): Promise<RoutineSelectionPreferenceStateView> => {
          const feedback = await routineSelectionPreferenceFeedback.listForPlanningThroughVersion(
            command.workspaceId,
            command.routineId,
            receipt.feedback.effectiveOn,
            receipt.feedbackVersion,
          );
          const canonicalFeedback = canonicalRoutineSelectionPreferenceFeedback(
            feedback,
            command.workspaceId,
            receipt.feedback.effectiveOn,
          );
          const score = routineSelectionPreferenceScore(
            canonicalFeedback,
            command.workspaceId,
            command.routineId,
            receipt.feedback.effectiveOn,
          );
          return {
            routineId: command.routineId,
            feedbackVersion: receipt.feedbackVersion,
            activeEventCount: canonicalFeedback.length,
            score,
            reason: routineSelectionPreferenceReason(score),
            updatedAt: receipt.feedback.recordedAt,
          };
        };
        await routineSelectionPreferenceFeedback.lockIdempotencyKey(
          command.workspaceId,
          idempotencyKey,
        );
        const replay = await routineSelectionPreferenceFeedback.findByIdempotencyKey(
          command.workspaceId,
          idempotencyKey,
        );
        if (replay !== null) {
          if (!isExactReplay(replay, command, idempotencyKey)) {
            throw new DomainError(
              "planning.selection_preference_idempotency_conflict",
              "This selection preference idempotency key already belongs to another command.",
            );
          }
          return projectReceipt(replay);
        }

        const currentVersion = await routineSelectionPreferenceFeedback.lockAndGetCurrentVersion(
          command.workspaceId,
          command.routineId,
        );
        // A same-key request can arrive while this command waited for the
        // routine-local lock. Re-read its receipt before applying the fence so
        // both callers receive the identical accepted result.
        const replayAfterLock = await routineSelectionPreferenceFeedback.findByIdempotencyKey(
          command.workspaceId,
          idempotencyKey,
        );
        if (replayAfterLock !== null) {
          if (!isExactReplay(replayAfterLock, command, idempotencyKey)) {
            throw new DomainError(
              "planning.selection_preference_idempotency_conflict",
              "This selection preference idempotency key already belongs to another command.",
            );
          }
          return projectReceipt(replayAfterLock);
        }
        if (currentVersion !== command.expectedFeedbackVersion) {
          throw new DomainError(
            "planning.selection_preference_version_conflict",
            "Routine selection preference feedback changed before this instruction was recorded.",
          );
        }
        if (currentVersion >= ROUTINE_SELECTION_PREFERENCE_MAX_RECORDED_EVENTS) {
          throw new DomainError(
            "planning.selection_preference_capacity_reached",
            `A routine cannot retain more than ${String(ROUTINE_SELECTION_PREFERENCE_MAX_RECORDED_EVENTS)} selection preference events.`,
          );
        }
        const sourcePlanId = command.sourcePlanId ?? null;
        const sourcePlanItemId = command.sourcePlanItemId ?? null;
        if (sourcePlanId !== null) {
          const sourcePlan = await dailyPlans.findById(command.workspaceId, sourcePlanId);
          const sourceItem =
            sourcePlanItemId === null
              ? null
              : sourcePlan?.items.find((item) => item.id === sourcePlanItemId);
          if (
            sourcePlan === null ||
            (sourcePlanItemId !== null &&
              (sourceItem == null || sourceItem.routineId !== command.routineId))
          ) {
            throw new DomainError(
              "planning.selection_preference_source_not_found",
              "The selection preference source plan or routine item does not exist.",
            );
          }
        }
        const recordedAt = this.clock.now();
        const receipt = await routineSelectionPreferenceFeedback.appendAndAdvance(
          createRoutineSelectionPreferenceFeedback({
            ingestedSequence: 0,
            workspaceId: command.workspaceId,
            routineId: command.routineId,
            kind: command.kind,
            effectiveOn: instantToLocalDate(recordedAt, command.timeZone),
            timeZone: command.timeZone,
            sourcePlanId: command.sourcePlanId ?? null,
            sourcePlanItemId: command.sourcePlanItemId ?? null,
            idempotencyKey,
            recordedAt,
          }),
          command.expectedFeedbackVersion,
        );
        return projectReceipt(receipt);
      },
      { isolationLevel: "read_committed" },
    );
  }
}
