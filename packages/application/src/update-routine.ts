import {
  DomainError,
  updateRoutine,
  type CadencePolicy,
  type DurationRange,
  type Routine,
  type RoutineId,
  type RoutineStatus,
  type StructuredTags,
  type WorkspaceId,
} from "@schedule/domain";

import type { Clock, UnitOfWork } from "./ports.js";

export interface UpdateRoutineCommand {
  readonly workspaceId: WorkspaceId;
  readonly routineId: RoutineId;
  readonly expectedVersion: number;
  readonly title?: string;
  readonly description?: string | null;
  readonly tags?: StructuredTags;
  readonly duration?: DurationRange;
  readonly cadence?: CadencePolicy;
  readonly status?: RoutineStatus;
}

export class UpdateRoutine {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(command: UpdateRoutineCommand): Promise<Routine> {
    if (!Number.isInteger(command.expectedVersion) || command.expectedVersion < 1) {
      throw new DomainError(
        "routine.expected_version_invalid",
        "Expected routine version must be a positive integer.",
      );
    }
    const { workspaceId, routineId, expectedVersion, ...changes } = command;
    if (Object.keys(changes).length === 0) {
      throw new DomainError("routine.update_empty", "At least one routine change is required.");
    }
    const now = this.clock.now();
    return this.unitOfWork.run(async ({ workspaces, routines }) => {
      if ((await workspaces.findById(workspaceId)) === null) {
        throw new DomainError("workspace.not_found", "The workspace does not exist.");
      }
      const existing = await routines.findById(workspaceId, routineId);
      if (existing === null) {
        throw new DomainError("routine.not_found", "The routine does not exist.");
      }
      if (existing.version !== expectedVersion) {
        throw new DomainError(
          "routine.version_conflict",
          "The routine changed before this update could be applied.",
        );
      }
      const updated = updateRoutine(existing, { ...changes, now });
      if (updated === existing) return existing;
      await routines.save(updated, expectedVersion);
      return updated;
    });
  }
}
