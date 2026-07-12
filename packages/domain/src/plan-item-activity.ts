import type { ActivityEventType } from "./activity-event.js";
import { invariant } from "./errors.js";

export const planItemActivityTypes = [
  "started",
  "completed",
  "skipped",
  "deferred",
  "dismissed",
] as const satisfies readonly ActivityEventType[];

export type PlanItemActivityType = (typeof planItemActivityTypes)[number];
export type PlanItemActivityActionType = PlanItemActivityType | "completion_reversed";

export function isPlanItemActivityType(value: string): value is PlanItemActivityType {
  return planItemActivityTypes.some((type) => type === value);
}

export function isPlanItemActivityActionType(value: string): value is PlanItemActivityActionType {
  return value === "completion_reversed" || isPlanItemActivityType(value);
}

export const planItemActivityStates = ["pending", ...planItemActivityTypes] as const;
export type PlanItemActivityState = (typeof planItemActivityStates)[number];

export function isTerminalPlanItemActivityState(state: PlanItemActivityState): boolean {
  return ["completed", "skipped", "deferred", "dismissed"].includes(state);
}

export function transitionPlanItemActivity(
  current: PlanItemActivityState,
  action: PlanItemActivityType,
): PlanItemActivityState {
  const allowed = current === "pending" || (current === "started" && action !== "started");
  invariant(
    allowed,
    "planning.item_activity_transition_invalid",
    `A plan item cannot transition from ${current} to ${action}.`,
  );
  return action;
}

export function reversePlanItemCompletion(current: PlanItemActivityState): "pending" {
  invariant(
    current === "completed",
    "planning.item_activity_transition_invalid",
    `A plan item completion cannot be reversed from ${current}.`,
  );
  return "pending";
}
