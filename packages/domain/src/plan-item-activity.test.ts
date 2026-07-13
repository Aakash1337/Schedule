import { describe, expect, it } from "vitest";

import { DomainError } from "./errors.js";
import {
  isTerminalPlanItemActivityState,
  isPlanItemActivityActionType,
  isPlanItemActivityType,
  planItemActivityTypes,
  reversePlanItemCompletion,
  transitionPlanItemActivity,
} from "./plan-item-activity.js";

describe("plan item activity lifecycle", () => {
  it("recognizes supported activity values without accepting arbitrary strings", () => {
    expect(isPlanItemActivityType("completed")).toBe(true);
    expect(isPlanItemActivityType("accepted")).toBe(false);
    expect(isPlanItemActivityActionType("completion_reversed")).toBe(true);
    expect(isPlanItemActivityActionType("accepted")).toBe(false);
  });
  const transitionOracle = {
    pending: {
      started: "started",
      completed: "completed",
      skipped: "skipped",
      deferred: "deferred",
      dismissed: "dismissed",
    },
    started: {
      started: "planning.item_activity_transition_invalid",
      completed: "completed",
      skipped: "skipped",
      deferred: "deferred",
      dismissed: "dismissed",
    },
    completed: Object.fromEntries(
      planItemActivityTypes.map((action) => [action, "planning.item_activity_transition_invalid"]),
    ),
    skipped: Object.fromEntries(
      planItemActivityTypes.map((action) => [action, "planning.item_activity_transition_invalid"]),
    ),
    deferred: Object.fromEntries(
      planItemActivityTypes.map((action) => [action, "planning.item_activity_transition_invalid"]),
    ),
    dismissed: Object.fromEntries(
      planItemActivityTypes.map((action) => [action, "planning.item_activity_transition_invalid"]),
    ),
  } as const;

  it.each(
    Object.entries(transitionOracle).flatMap(([current, outcomes]) =>
      Object.entries(outcomes).map(([action, outcome]) => [current, action, outcome] as const),
    ),
  )("enforces the transition oracle for %s + %s", (current, action, outcome) => {
    if (outcome === "planning.item_activity_transition_invalid") {
      expect(() =>
        transitionPlanItemActivity(
          current as Parameters<typeof transitionPlanItemActivity>[0],
          action as Parameters<typeof transitionPlanItemActivity>[1],
        ),
      ).toThrowError(expect.objectContaining({ code: outcome }));
      return;
    }
    expect(
      transitionPlanItemActivity(
        current as Parameters<typeof transitionPlanItemActivity>[0],
        action as Parameters<typeof transitionPlanItemActivity>[1],
      ),
    ).toBe(outcome);
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
    expect(() => reversePlanItemCompletion("deferred")).toThrowError(DomainError);
    expect(() => reversePlanItemCompletion("dismissed")).toThrowError(DomainError);
  });
});
