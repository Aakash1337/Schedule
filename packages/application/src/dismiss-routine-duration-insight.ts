import {
  calculateRoutineDurationInsight,
  createRoutineDurationInsightFeedback,
  DomainError,
  resolveRoutineDurationInsightFeedback,
  routineDurationInsightKeyPattern,
  routineDurationInsightLookbackDays,
  type RoutineDurationInsightFeedback,
  type RoutineDurationInsightFeedbackKind,
  type RoutineId,
  type WorkspaceId,
} from "@schedule/domain";

import type { Clock, UnitOfWork } from "./ports.js";

const millisecondsPerDay = 24 * 60 * 60 * 1_000;

export interface DismissRoutineDurationInsightCommand {
  readonly workspaceId: WorkspaceId;
  readonly routineId: RoutineId;
  readonly expectedVersion: number;
  readonly insightKey: string;
  readonly idempotencyKey: string;
}

type DurationInsightFeedbackCommand = DismissRoutineDurationInsightCommand;

function validateCommand(command: DurationInsightFeedbackCommand): string {
  if (!Number.isInteger(command.expectedVersion) || command.expectedVersion < 1) {
    throw new DomainError(
      "routine.expected_version_invalid",
      "Expected routine version must be a positive integer.",
    );
  }
  if (!routineDurationInsightKeyPattern.test(command.insightKey)) {
    throw new DomainError(
      "routine_duration_insight.insight_key_invalid",
      "A canonical duration insight key is required.",
    );
  }
  const idempotencyKey = command.idempotencyKey.trim();
  if (idempotencyKey.length < 1 || idempotencyKey.length > 160) {
    throw new DomainError(
      "routine_duration_insight.feedback_idempotency_key_invalid",
      "A duration insight feedback idempotency key must contain 1–160 characters.",
    );
  }
  return idempotencyKey;
}

function isExactReplay(
  feedback: RoutineDurationInsightFeedback,
  kind: RoutineDurationInsightFeedbackKind,
  command: DurationInsightFeedbackCommand,
  idempotencyKey: string,
): boolean {
  return (
    feedback.workspaceId === command.workspaceId &&
    feedback.routineId === command.routineId &&
    feedback.kind === kind &&
    feedback.insightKey === command.insightKey &&
    feedback.routineVersion === command.expectedVersion &&
    feedback.idempotencyKey === idempotencyKey
  );
}

/** @internal Shared atomic implementation for dismissal and reset commands. */
export async function mutateRoutineDurationInsightFeedback(
  unitOfWork: UnitOfWork,
  clock: Clock,
  kind: RoutineDurationInsightFeedbackKind,
  command: DurationInsightFeedbackCommand,
): Promise<RoutineDurationInsightFeedback> {
  const idempotencyKey = validateCommand(command);
  return unitOfWork.run(
    async ({ workspaces, routines, activityEvents, routineDurationInsightFeedback }) => {
      if ((await workspaces.findById(command.workspaceId)) === null) {
        throw new DomainError("workspace.not_found", "The workspace does not exist.");
      }
      await activityEvents.lockRoutineActivity(command.workspaceId, command.routineId);

      const replay = await routineDurationInsightFeedback.findByIdempotencyKey(
        command.workspaceId,
        idempotencyKey,
      );
      if (replay !== null) {
        if (!isExactReplay(replay, kind, command, idempotencyKey)) {
          throw new DomainError(
            "routine_duration_insight.idempotency_conflict",
            "This duration insight feedback key already belongs to another command.",
          );
        }
        return replay;
      }

      const routine = await routines.findById(command.workspaceId, command.routineId);
      if (routine === null) {
        throw new DomainError("routine.not_found", "The routine does not exist.");
      }
      if (routine.version !== command.expectedVersion) {
        throw new DomainError(
          "routine.version_conflict",
          "The routine changed before this duration insight feedback could be recorded.",
        );
      }

      const recordedAt = clock.now();
      const fromInclusive = new Date(
        recordedAt.getTime() - routineDurationInsightLookbackDays * millisecondsPerDay,
      );
      const evidence = await activityEvents.listDurationEvidence(
        command.workspaceId,
        command.routineId,
        fromInclusive,
        recordedAt,
      );
      const insight = calculateRoutineDurationInsight(routine, evidence, recordedAt);
      if (insight.insightKey === null || insight.insightKey !== command.insightKey) {
        throw new DomainError(
          "routine_duration_insight.evidence_conflict",
          "The duration evidence changed before this feedback could be recorded.",
        );
      }
      if (insight.observedMedianMinutes === null) {
        throw new DomainError(
          "routine_duration_insight.evidence_conflict",
          "The current duration insight has no actionable observation.",
        );
      }

      const latest = await routineDurationInsightFeedback.findLatestForKey(
        command.workspaceId,
        command.routineId,
        command.insightKey,
      );
      const resolved = resolveRoutineDurationInsightFeedback(
        insight,
        command.workspaceId,
        latest === null ? [] : [latest],
      );
      const expectedDisposition = kind === "dismissed" ? "available" : "dismissed";
      if (resolved.disposition !== expectedDisposition) {
        throw new DomainError(
          "routine_duration_insight.disposition_conflict",
          kind === "dismissed"
            ? "This duration insight is not available to dismiss."
            : "This duration insight has no active dismissal to reset.",
        );
      }

      return routineDurationInsightFeedback.append(
        createRoutineDurationInsightFeedback({
          ingestedSequence: 0,
          workspaceId: command.workspaceId,
          routineId: command.routineId,
          insightKey: command.insightKey,
          kind,
          routineVersion: insight.routineVersion,
          observedMedianMinutes: insight.observedMedianMinutes,
          suggestedExpectedMinutes: insight.suggestedExpectedMinutes,
          idempotencyKey,
          recordedAt,
        }),
      );
    },
    // The routine activity lock serializes evidence changes and feedback. Read committed ensures
    // every read after waiting on the lock observes the earlier holder's committed changes.
    { isolationLevel: "read_committed" },
  );
}

/** Dismisses one exact actionable duration insight without changing the routine. */
export class DismissRoutineDurationInsight {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(command: DismissRoutineDurationInsightCommand): Promise<RoutineDurationInsightFeedback> {
    return mutateRoutineDurationInsightFeedback(this.unitOfWork, this.clock, "dismissed", command);
  }
}
