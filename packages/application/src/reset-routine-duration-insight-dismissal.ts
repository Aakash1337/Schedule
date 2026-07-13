import type { RoutineDurationInsightFeedback, RoutineId, WorkspaceId } from "@schedule/domain";

import { mutateRoutineDurationInsightFeedback } from "./dismiss-routine-duration-insight.js";
import type { Clock, UnitOfWork } from "./ports.js";

export interface ResetRoutineDurationInsightDismissalCommand {
  readonly workspaceId: WorkspaceId;
  readonly routineId: RoutineId;
  readonly expectedVersion: number;
  readonly insightKey: string;
  readonly idempotencyKey: string;
}

/** Restores one exact dismissed duration insight when its evidence is still current. */
export class ResetRoutineDurationInsightDismissal {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(
    command: ResetRoutineDurationInsightDismissalCommand,
  ): Promise<RoutineDurationInsightFeedback> {
    return mutateRoutineDurationInsightFeedback(this.unitOfWork, this.clock, "reset", command);
  }
}
