import {
  calculateDailyPlanFitEffectiveness,
  type DailyPlanFitEffectiveness,
} from "@schedule/domain";

import type {
  ListDailyPlanFitUsageOutcomes,
  ListDailyPlanFitUsageOutcomesQuery,
} from "./list-daily-plan-fit-usage-outcomes.js";

/** Produces a bounded descriptive aggregate without opening a second transaction or writing state. */
export class GetDailyPlanFitEffectiveness {
  constructor(private readonly listUsageOutcomes: Pick<ListDailyPlanFitUsageOutcomes, "execute">) {}

  async execute(query: ListDailyPlanFitUsageOutcomesQuery): Promise<DailyPlanFitEffectiveness> {
    return calculateDailyPlanFitEffectiveness(await this.listUsageOutcomes.execute(query));
  }
}
