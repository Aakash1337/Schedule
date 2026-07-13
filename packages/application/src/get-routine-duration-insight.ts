import {
  calculateRoutineDurationInsight,
  DomainError,
  routineDurationInsightLookbackDays,
  type RoutineDurationInsight,
  type RoutineId,
  type WorkspaceId,
} from "@schedule/domain";

import type { Clock, UnitOfWork } from "./ports.js";

const millisecondsPerDay = 24 * 60 * 60 * 1_000;

export interface GetRoutineDurationInsightQuery {
  readonly workspaceId: WorkspaceId;
  readonly routineId: RoutineId;
}

/** Reads an explainable duration calibration without mutating the routine. */
export class GetRoutineDurationInsight {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(query: GetRoutineDurationInsightQuery): Promise<RoutineDurationInsight> {
    const evaluatedAt = this.clock.now();
    const fromInclusive = new Date(
      evaluatedAt.getTime() - routineDurationInsightLookbackDays * millisecondsPerDay,
    );

    return this.unitOfWork.run(async ({ workspaces, routines, activityEvents }) => {
      if ((await workspaces.findById(query.workspaceId)) === null) {
        throw new DomainError("workspace.not_found", "The workspace does not exist.");
      }
      const routine = await routines.findById(query.workspaceId, query.routineId);
      if (routine === null) {
        throw new DomainError("routine.not_found", "The routine does not exist.");
      }
      const evidence = await activityEvents.listDurationEvidence(
        query.workspaceId,
        query.routineId,
        fromInclusive,
        evaluatedAt,
      );
      return calculateRoutineDurationInsight(routine, evidence, evaluatedAt);
    });
  }
}
