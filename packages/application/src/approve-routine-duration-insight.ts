import {
  calculateRoutineDurationInsight,
  DomainError,
  routineDurationInsightLookbackDays,
  updateRoutine,
  type DurationRange,
  type Routine,
  type RoutineId,
  type WorkspaceId,
} from "@schedule/domain";

import type { Clock, UnitOfWork } from "./ports.js";

const millisecondsPerDay = 24 * 60 * 60 * 1_000;

export interface ApproveRoutineDurationInsightCommand {
  readonly workspaceId: WorkspaceId;
  readonly routineId: RoutineId;
  readonly expectedVersion: number;
  readonly duration: DurationRange;
}

function preservesUserOwnedDurationRange(
  current: DurationRange,
  candidate: DurationRange,
): boolean {
  return (
    candidate.minimumMinutes === current.minimumMinutes &&
    candidate.maximumMinutes === current.maximumMinutes &&
    candidate.splittable === current.splittable &&
    candidate.minimumSessionMinutes === current.minimumSessionMinutes &&
    candidate.overheadMinutes === current.overheadMinutes
  );
}

/** Atomically revalidates and applies one explicitly approved duration suggestion. */
export class ApproveRoutineDurationInsight {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(command: ApproveRoutineDurationInsightCommand): Promise<Routine> {
    if (!Number.isInteger(command.expectedVersion) || command.expectedVersion < 1) {
      throw new DomainError(
        "routine.expected_version_invalid",
        "Expected routine version must be a positive integer.",
      );
    }
    const now = this.clock.now();
    const fromInclusive = new Date(
      now.getTime() - routineDurationInsightLookbackDays * millisecondsPerDay,
    );

    return this.unitOfWork.run(
      async ({ workspaces, routines, activityEvents }) => {
        if ((await workspaces.findById(command.workspaceId)) === null) {
          throw new DomainError("workspace.not_found", "The workspace does not exist.");
        }
        await activityEvents.lockRoutineActivity(command.workspaceId, command.routineId);
        const existing = await routines.findById(command.workspaceId, command.routineId);
        if (existing === null) {
          throw new DomainError("routine.not_found", "The routine does not exist.");
        }
        if (existing.version !== command.expectedVersion) {
          throw new DomainError(
            "routine.version_conflict",
            "The routine changed before this duration insight could be applied.",
          );
        }
        if (!preservesUserOwnedDurationRange(existing.duration, command.duration)) {
          throw new DomainError(
            "routine_duration_insight.approval_scope_invalid",
            "Duration insight approval may only change the expected duration.",
          );
        }

        const evidence = await activityEvents.listDurationEvidence(
          command.workspaceId,
          command.routineId,
          fromInclusive,
          now,
        );
        const insight = calculateRoutineDurationInsight(existing, evidence, now);
        if (
          insight.status !== "suggested" ||
          insight.suggestedExpectedMinutes !== command.duration.expectedMinutes
        ) {
          throw new DomainError(
            "routine_duration_insight.evidence_conflict",
            "The duration evidence changed before this suggestion could be applied.",
          );
        }

        const updated = updateRoutine(existing, { duration: command.duration, now });
        await routines.save(updated, command.expectedVersion);
        return updated;
      },
      // Each statement after the advisory lock must receive a fresh snapshot so a completion
      // committed by an earlier lock holder is included in the evidence revalidation.
      { isolationLevel: "read_committed" },
    );
  }
}
