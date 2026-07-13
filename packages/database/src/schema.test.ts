import { getTableName } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/pg-core";
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

  it("constrains routine weekday arrays at the database boundary", () => {
    const checkNames = getTableConfig(routines).checks.map((constraint) => constraint.name);

    expect(checkNames).toEqual(
      expect.arrayContaining([
        "routines_preferred_weekdays_valid",
        "routines_preferred_weekdays_unique",
        "routines_preferred_weekdays_one_dimensional",
        "routines_excluded_weekdays_valid",
        "routines_excluded_weekdays_unique",
        "routines_excluded_weekdays_one_dimensional",
        "routines_weekdays_disjoint",
      ]),
    );
  });

  it("models unified planner sources with tenant-scoped foreign keys", () => {
    const itemConfig = getTableConfig(dailyPlanItems);
    const activityConfig = getTableConfig(activityEvents);
    const workItemConfig = getTableConfig(workItems);

    expect(itemConfig.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(["source_type", "routine_id", "work_item_id"]),
    );
    expect(activityConfig.columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(["source_type", "routine_id", "work_item_id"]),
    );
    expect(workItemConfig.columns.map((column) => column.name)).toContain(
      "planning_duration_minutes",
    );
    expect(itemConfig.checks.map((constraint) => constraint.name)).toContain(
      "daily_plan_items_source_valid",
    );
    expect(activityConfig.checks.map((constraint) => constraint.name)).toContain(
      "activity_events_source_valid",
    );
    expect(itemConfig.foreignKeys.map((constraint) => constraint.getName())).toContain(
      "daily_plan_items_work_item_tenant_fk",
    );
    expect(activityConfig.foreignKeys.map((constraint) => constraint.getName())).toContain(
      "activity_events_work_item_tenant_fk",
    );
  });
});
