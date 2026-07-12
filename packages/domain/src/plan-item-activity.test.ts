import { describe, expect, it } from "vitest";

import { DomainError } from "./errors.js";
import {
  isTerminalPlanItemActivityState,
  planItemActivityTypes,
  reversePlanItemCompletion,
  transitionPlanItemActivity,
} from "./plan-item-activity.js";

describe("plan item activity lifecycle", () => {
  it.each(planItemActivityTypes)("allows pending to transition to %s", (action) => {
    expect(transitionPlanItemActivity("pending", action)).toBe(action);
  });

  it.each(["completed", "skipped", "deferred", "dismissed"] as const)(
    "allows started to transition to %s",
    (action) => {
      expect(transitionPlanItemActivity("started", action)).toBe(action);
    },
  );

  it.each([
    ["started", "started"],
    ["completed", "started"],
    ["skipped", "completed"],
    ["deferred", "dismissed"],
    ["dismissed", "started"],
  ] as const)("rejects %s to %s", (current, action) => {
    expect(() => transitionPlanItemActivity(current, action)).toThrowError(DomainError);
  });

  it("identifies only completed, skipped, deferred, and dismissed as terminal", () => {
    expect(isTerminalPlanItemActivityState("pending")).toBe(false);
    expect(isTerminalPlanItemActivityState("started")).toBe(false);
    expect(isTerminalPlanItemActivityState("completed")).toBe(true);
    expect(isTerminalPlanItemActivityState("skipped")).toBe(true);
    expect(isTerminalPlanItemActivityState("deferred")).toBe(true);
    expect(isTerminalPlanItemActivityState("dismissed")).toBe(true);
  });

  it("reopens only a completed item through completion reversal", () => {
    expect(reversePlanItemCompletion("completed")).toBe("pending");
    expect(() => reversePlanItemCompletion("pending")).toThrowError(DomainError);
    expect(() => reversePlanItemCompletion("started")).toThrowError(DomainError);
    expect(() => reversePlanItemCompletion("skipped")).toThrowError(DomainError);
  });
});
