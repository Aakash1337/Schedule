import { getTableName } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import {
  activityEvents,
  dailyPlanHeads,
  dailyPlanItemStates,
  dailyPlanItems,
  dailyPlans,
  outboxEvents,
  planInteractionEvents,
  planMutations,
  routines,
  scheduleBlocks,
  workItems,
  workspaces,
} from "./schema.js";

describe("database schema", () => {
  it("uses stable table names for core infrastructure", () => {
    expect(getTableName(workspaces)).toBe("workspaces");
    expect(getTableName(workItems)).toBe("work_items");
    expect(getTableName(scheduleBlocks)).toBe("schedule_blocks");
    expect(getTableName(outboxEvents)).toBe("outbox_events");
    expect(getTableName(routines)).toBe("routines");
    expect(getTableName(activityEvents)).toBe("activity_events");
    expect(getTableName(dailyPlans)).toBe("daily_plans");
    expect(getTableName(dailyPlanItems)).toBe("daily_plan_items");
    expect(getTableName(dailyPlanHeads)).toBe("daily_plan_heads");
    expect(getTableName(dailyPlanItemStates)).toBe("daily_plan_item_states");
    expect(getTableName(planInteractionEvents)).toBe("plan_interaction_events");
    expect(getTableName(planMutations)).toBe("plan_mutations");
  });
});
