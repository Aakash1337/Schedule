import { isTerminalPlanItemActivityState, type WorkspaceId } from "@schedule/domain";

import type { NotificationRepository, RecordedPlanItemActivityResult } from "./ports.js";

/**
 * Removes reminder intents made obsolete by a newly recorded plan-item activity.
 *
 * Callers must hold the workspace notification lock before recording the activity. Keeping the
 * notification-lock -> day-lock order avoids deadlocks with other plan mutations.
 */
export async function invalidatePlanItemActivityIntents(
  notifications: Pick<NotificationRepository, "deleteIntentsForTarget">,
  workspaceId: WorkspaceId,
  result: RecordedPlanItemActivityResult,
): Promise<void> {
  if (result.replayed) return;

  if (isTerminalPlanItemActivityState(result.activityState)) {
    await notifications.deleteIntentsForTarget(
      workspaceId,
      "daily_plan",
      result.planId,
      "daily_follow_up",
    );
  }
  if (
    result.activityState === "completed" &&
    result.activityEvent.sourceType === "work_item" &&
    result.activityEvent.workItemId !== null
  ) {
    await notifications.deleteIntentsForTarget(
      workspaceId,
      "work_item",
      result.activityEvent.workItemId,
      "work_item_due",
    );
  }
}
