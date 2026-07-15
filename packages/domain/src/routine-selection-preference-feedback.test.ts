import { describe, expect, it } from "vitest";

import {
  canonicalRoutineSelectionPreferenceFeedback,
  createRoutineSelectionPreferenceFeedback,
  dailyPlanId,
  localDate,
  planItemId,
  routineId,
  routineSelectionPreferenceFeedbackId,
  routineSelectionPreferenceReason,
  routineSelectionPreferenceScore,
  workspaceId,
  type RoutineSelectionPreferenceFeedbackKind,
} from "./index.js";

const workspace = workspaceId("selection-preference-workspace");
const otherWorkspace = workspaceId("selection-preference-other-workspace");
const routine = routineId("selection-preference-routine");

function feedback(
  id: string,
  kind: RoutineSelectionPreferenceFeedbackKind,
  sequence: number,
  effectiveOn = "2026-07-15",
) {
  return createRoutineSelectionPreferenceFeedback({
    id: routineSelectionPreferenceFeedbackId(id),
    ingestedSequence: sequence,
    workspaceId: workspace,
    routineId: routine,
    kind,
    effectiveOn,
    timeZone: "America/La_Paz",
    sourcePlanId: dailyPlanId("selection-preference-source-plan"),
    sourcePlanItemId: kind === "reset" ? null : planItemId(`selection-preference-source-${id}`),
    idempotencyKey: `selection-preference-${id}`,
    recordedAt: new Date("2026-07-15T12:00:00.000Z"),
  });
}

describe("routine selection preference feedback", () => {
  it("creates immutable routine feedback with optional, internally consistent provenance", () => {
    const recordedAt = new Date("2026-07-15T12:00:00.000Z");
    const created = createRoutineSelectionPreferenceFeedback({
      ...feedback("more", "more_often", 0),
      recordedAt,
      idempotencyKey: "  selection-preference-more  ",
    });
    recordedAt.setUTCFullYear(2030);

    expect(created.idempotencyKey).toBe("selection-preference-more");
    expect(created.recordedAt.toISOString()).toBe("2026-07-15T12:00:00.000Z");
    expect(
      createRoutineSelectionPreferenceFeedback({
        ...feedback("routine-only", "less_often", 1),
        sourcePlanId: null,
        sourcePlanItemId: null,
      }).sourcePlanId,
    ).toBeNull();
    expect(() =>
      createRoutineSelectionPreferenceFeedback({
        ...feedback("missing", "less_often", 1),
        sourcePlanId: null,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "planning.selection_preference_feedback_source_plan_invalid",
      }),
    );
    expect(() =>
      createRoutineSelectionPreferenceFeedback({
        ...feedback("reset-item", "reset", 2),
        sourcePlanItemId: planItemId("unexpected-reset-item"),
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "planning.selection_preference_feedback_source_item_invalid",
      }),
    );
  });

  it("uses the last eight non-reset events after the latest reset, independent of input order", () => {
    const beforeReset = feedback("before-reset", "more_often", 1);
    const reset = feedback("reset", "reset", 2);
    const afterReset = Array.from({ length: 9 }, (_, index) =>
      feedback(`after-${index}`, index % 2 === 0 ? "more_often" : "less_often", index + 3),
    );
    const otherTenant = { ...feedback("other", "more_often", 99), workspaceId: otherWorkspace };
    const forward = canonicalRoutineSelectionPreferenceFeedback(
      [beforeReset, ...afterReset, otherTenant, reset],
      workspace,
      localDate("2026-07-15"),
    );
    const reversed = canonicalRoutineSelectionPreferenceFeedback(
      [reset, otherTenant, ...afterReset.slice().reverse(), beforeReset],
      workspace,
      localDate("2026-07-15"),
    );

    expect(forward.map((event) => event.id)).toEqual(afterReset.slice(1).map((event) => event.id));
    expect(reversed).toEqual(forward);
  });

  it("uses an inclusive local 90-day window and clamps a directional score to [-400, 400]", () => {
    const asOf = localDate("2026-07-15");
    const boundary = feedback("boundary", "more_often", 1, "2026-04-17");
    const outside = feedback("outside", "less_often", 2, "2026-04-16");
    const positive = Array.from({ length: 8 }, (_, index) =>
      feedback(`positive-${index}`, "more_often", index + 3),
    );
    const negative = Array.from({ length: 8 }, (_, index) =>
      feedback(`negative-${index}`, "less_often", index + 20),
    );

    expect(
      canonicalRoutineSelectionPreferenceFeedback([outside, boundary], workspace, asOf).map(
        (event) => event.id,
      ),
    ).toEqual([boundary.id]);
    expect(routineSelectionPreferenceScore(positive, workspace, routine, asOf)).toBe(400);
    expect(routineSelectionPreferenceScore(negative, workspace, routine, asOf)).toBe(-400);
    expect(routineSelectionPreferenceReason(200)).toBe(
      "You asked to see this routine more often (+200).",
    );
    expect(routineSelectionPreferenceReason(-100)).toBe(
      "You asked to see this routine less often (-100).",
    );
    expect(routineSelectionPreferenceReason(0)).toBeNull();
  });
});
