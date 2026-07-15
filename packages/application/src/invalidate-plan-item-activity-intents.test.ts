import { describe, expect, it } from "vitest";

import {
  activityEventId,
  dailyPlanId,
  planItemId,
  recordActivityEvent,
  routineId,
  workItemId,
  workspaceId,
  type PlanItemActivityState,
} from "@schedule/domain";

import { invalidatePlanItemActivityIntents } from "./invalidate-plan-item-activity-intents.js";
import type { RecordedPlanItemActivityResult } from "./ports.js";

describe("invalidatePlanItemActivityIntents", () => {
  const workspace = workspaceId("activity-intent-workspace");
  const plan = dailyPlanId("activity-intent-plan");
  const item = planItemId("activity-intent-item");

  function result(
    activityState: Exclude<PlanItemActivityState, "pending">,
    options: { source?: "routine" | "work_item"; replayed?: boolean } = {},
  ): RecordedPlanItemActivityResult {
    return {
      planId: plan,
      itemId: item,
      activityState,
      activityEvent: recordActivityEvent({
        id: activityEventId(`activity-intent-${activityState}`),
        workspaceId: workspace,
        ...(options.source === "work_item"
          ? { sourceType: "work_item", workItemId: workItemId("activity-intent-work") }
          : { routineId: routineId("activity-intent-routine") }),
        planId: plan,
        planItemId: item,
        type: activityState,
        occurredAt: new Date("2026-07-15T10:00:00.000Z"),
        timeZone: "UTC",
        durationMinutes: activityState === "completed" ? 30 : null,
        reason: null,
        metadata: {},
        idempotencyKey: `activity-intent-${activityState}`,
        recordedAt: new Date("2026-07-15T10:01:00.000Z"),
      }),
      headVersion: 2,
      replayed: options.replayed ?? false,
    };
  }

  it.each(["completed", "skipped", "deferred", "dismissed"] as const)(
    "invalidates daily follow-up intents for %s activity",
    async (activityState) => {
      const calls: string[] = [];
      await invalidatePlanItemActivityIntents(
        {
          deleteIntentsForTarget: async (_workspaceId, targetType, targetId, kind) => {
            calls.push(`${targetType}:${targetId}:${kind ?? "all"}`);
            return 1;
          },
        },
        workspace,
        result(activityState),
      );
      expect(calls).toEqual([`daily_plan:${plan}:daily_follow_up`]);
    },
  );

  it("also invalidates a completed work item's due intent", async () => {
    const calls: string[] = [];
    await invalidatePlanItemActivityIntents(
      {
        deleteIntentsForTarget: async (_workspaceId, targetType, targetId, kind) => {
          calls.push(`${targetType}:${targetId}:${kind ?? "all"}`);
          return 1;
        },
      },
      workspace,
      result("completed", { source: "work_item" }),
    );
    expect(calls).toEqual([
      `daily_plan:${plan}:daily_follow_up`,
      `work_item:${workItemId("activity-intent-work")}:work_item_due`,
    ]);
  });

  it("does nothing for a nonterminal activity or an idempotent replay", async () => {
    const calls: string[] = [];
    const notifications = {
      deleteIntentsForTarget: async () => {
        calls.push("unexpected");
        return 1;
      },
    };
    await invalidatePlanItemActivityIntents(notifications, workspace, result("started"));
    await invalidatePlanItemActivityIntents(
      notifications,
      workspace,
      result("completed", { replayed: true }),
    );
    expect(calls).toEqual([]);
  });
});
