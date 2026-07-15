import type { DailyPlanFitInsightFeedback, LocalDate, WorkspaceId } from "@schedule/domain";

import { mutateDailyPlanFitInsightFeedback } from "./dismiss-daily-plan-fit-insight.js";
import type { Clock, UnitOfWork } from "./ports.js";

export interface ResetDailyPlanFitInsightDismissalCommand {
  readonly workspaceId: WorkspaceId;
  readonly forDate: LocalDate;
  readonly insightKey: string;
  readonly idempotencyKey: string;
}

export class ResetDailyPlanFitInsightDismissal {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(command: ResetDailyPlanFitInsightDismissalCommand): Promise<DailyPlanFitInsightFeedback> {
    return mutateDailyPlanFitInsightFeedback(this.unitOfWork, this.clock, "reset", command);
  }
}
