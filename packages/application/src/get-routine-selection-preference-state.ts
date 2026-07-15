import {
  canonicalRoutineSelectionPreferenceFeedback,
  DomainError,
  instantToLocalDate,
  routineSelectionPreferenceReason,
  routineSelectionPreferenceScore,
  type RoutineId,
  type WorkspaceId,
} from "@schedule/domain";

import type { Clock, UnitOfWork } from "./ports.js";

export interface GetRoutineSelectionPreferenceStateQuery {
  readonly workspaceId: WorkspaceId;
  readonly routineId: RoutineId;
  readonly timeZone: string;
}

export interface RoutineSelectionPreferenceStateView {
  readonly routineId: RoutineId;
  readonly feedbackVersion: number;
  readonly activeEventCount: number;
  readonly score: number;
  readonly reason: string | null;
  readonly updatedAt: Date | null;
}

/** Read-only projection for routine-catalogue/bootstrap consumers. */
export class GetRoutineSelectionPreferenceState {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(
    query: GetRoutineSelectionPreferenceStateQuery,
  ): Promise<RoutineSelectionPreferenceStateView> {
    const asOf = instantToLocalDate(this.clock.now(), query.timeZone);
    return this.unitOfWork.run(async ({ workspaces, routineSelectionPreferenceFeedback }) => {
      if ((await workspaces.findById(query.workspaceId)) === null) {
        throw new DomainError("workspace.not_found", "The workspace does not exist.");
      }
      const state = await routineSelectionPreferenceFeedback.findCurrentState(
        query.workspaceId,
        query.routineId,
      );
      if (state === null) {
        throw new DomainError("routine.not_found", "The routine does not exist.");
      }
      const feedback = await routineSelectionPreferenceFeedback.listForPlanning(
        query.workspaceId,
        [query.routineId],
        asOf,
      );
      const canonicalFeedback = canonicalRoutineSelectionPreferenceFeedback(
        feedback,
        query.workspaceId,
        asOf,
      );
      const score = routineSelectionPreferenceScore(
        canonicalFeedback,
        query.workspaceId,
        query.routineId,
        asOf,
      );
      return {
        routineId: query.routineId,
        feedbackVersion: state.feedbackVersion,
        activeEventCount: canonicalFeedback.length,
        score,
        reason: routineSelectionPreferenceReason(score),
        updatedAt: state.updatedAt,
      };
    });
  }
}
