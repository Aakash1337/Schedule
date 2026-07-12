import {
  DomainError,
  createRoutine,
  type CadencePolicy,
  type DurationRange,
  type Routine,
  type RoutineStatus,
  type StructuredTags,
  type WorkspaceId,
} from "@schedule/domain";

import type { Clock, UnitOfWork } from "./ports.js";

export interface CreateRoutineCommand {
  readonly workspaceId: WorkspaceId;
  readonly title: string;
  readonly description?: string | null;
  readonly tags: StructuredTags;
  readonly duration: DurationRange;
  readonly cadence: CadencePolicy;
  readonly status?: RoutineStatus;
}

export class CreateRoutine {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(command: CreateRoutineCommand): Promise<Routine> {
    const routine = createRoutine({ ...command, now: this.clock.now() });
    return this.unitOfWork.run(async ({ routines, workspaces }) => {
      if ((await workspaces.findById(command.workspaceId)) === null) {
        throw new DomainError("workspace.not_found", "The workspace does not exist.");
      }
      await routines.insert(routine);
      return routine;
    });
  }
}
