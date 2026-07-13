import { describe, expect, it } from "vitest";

import {
  activeRoutinePlanningFeedback,
  canonicalRoutinePlanningFeedback,
  createRoutinePlanningFeedback,
  dailyPlanId,
  localDate,
  planItemId,
  routineId,
  routinePlanningFeedbackId,
  workspaceId,
  type RoutinePlanningFeedbackKind,
} from "./index.js";

const workspace = workspaceId("feedback-workspace");
const otherWorkspace = workspaceId("feedback-other-workspace");
const routine = routineId("feedback-routine");

function feedback(
  id: string,
  kind: RoutinePlanningFeedbackKind,
  sequence: number,
  effectiveOn = "2026-07-15",
) {
  return createRoutinePlanningFeedback({
    id: routinePlanningFeedbackId(id),
    ingestedSequence: sequence,
    workspaceId: workspace,
    routineId: routine,
    kind,
    effectiveOn,
    weekStartsOn: 1,
    timeZone: "America/La_Paz",
    sourcePlanId: dailyPlanId("feedback-source-plan"),
    sourcePlanItemId: kind === "reset" ? null : planItemId(`feedback-source-item-${id}`),
    idempotencyKey: `feedback-${id}`,
    recordedAt: new Date("2026-07-15T12:00:00.000Z"),
  });
}

describe("temporary routine planning feedback", () => {
  it("derives inclusive day and routine-week boundaries without server-time arithmetic", () => {
    const today = feedback("today", "not_today", 1);
    const thisWeek = feedback("week", "not_this_week", 2);
    const sundayWeek = createRoutinePlanningFeedback({
      ...thisWeek,
      id: routinePlanningFeedbackId("sunday-week"),
      ingestedSequence: 3,
      effectiveOn: "2026-07-15",
      weekStartsOn: 0,
      sourcePlanItemId: planItemId("sunday-week-item"),
    });

    expect(today.effectiveThrough).toBe("2026-07-15");
    expect(thisWeek.effectiveThrough).toBe("2026-07-19");
    expect(sundayWeek.effectiveThrough).toBe("2026-07-18");
    expect(feedback("reset-boundary", "reset", 4).effectiveThrough).toBeNull();
  });

  it("requires suppression provenance while keeping resets explicitly item-free", () => {
    expect(() =>
      createRoutinePlanningFeedback({
        ...feedback("missing-item-base", "not_today", 1),
        id: routinePlanningFeedbackId("missing-item"),
        weekStartsOn: 1,
        sourcePlanItemId: null,
      }),
    ).toThrowError(expect.objectContaining({ code: "planning.feedback_source_item_invalid" }));
    expect(() =>
      createRoutinePlanningFeedback({
        ...feedback("reset-item-base", "reset", 1),
        id: routinePlanningFeedbackId("reset-item"),
        weekStartsOn: 1,
        sourcePlanItemId: planItemId("unexpected-reset-item"),
      }),
    ).toThrowError(expect.objectContaining({ code: "planning.feedback_source_item_invalid" }));
  });

  it("chooses the latest sequence then id, independent of input order and tenant noise", () => {
    const earliest = feedback("a", "not_this_week", 1);
    const tieWinner = feedback("z", "not_today", 2);
    const tieLoser = feedback("b", "not_this_week", 2);
    const otherTenant = { ...feedback("other", "not_this_week", 99), workspaceId: otherWorkspace };
    const forward = canonicalRoutinePlanningFeedback(
      [earliest, tieWinner, otherTenant, tieLoser],
      workspace,
      localDate("2026-07-15"),
    );
    const reversed = canonicalRoutinePlanningFeedback(
      [tieLoser, otherTenant, tieWinner, earliest],
      workspace,
      localDate("2026-07-15"),
    );

    expect(forward).toEqual([tieWinner]);
    expect(reversed).toEqual(forward);
  });

  it("ignores future-effective events and treats the latest reset or expiry as inactive", () => {
    const suppression = feedback("suppression", "not_this_week", 1);
    const reset = feedback("reset", "reset", 2);
    const future = feedback("future", "not_this_week", 3, "2026-07-20");
    const asOf = localDate("2026-07-15");

    expect(canonicalRoutinePlanningFeedback([future, reset, suppression], workspace, asOf)).toEqual(
      [reset],
    );
    expect(
      activeRoutinePlanningFeedback([suppression, reset, future], workspace, routine, asOf),
    ).toBe(null);
    expect(
      activeRoutinePlanningFeedback([suppression], workspace, routine, localDate("2026-07-20")),
    ).toBe(null);
  });

  it("copies the recording instant and validates the persistence placeholder sequence", () => {
    const recordedAt = new Date("2026-07-15T12:00:00.000Z");
    const created = createRoutinePlanningFeedback({
      ...feedback("copy-base", "not_today", 0),
      id: routinePlanningFeedbackId("copy"),
      ingestedSequence: 0,
      weekStartsOn: 1,
      recordedAt,
      sourcePlanItemId: planItemId("copy-item"),
    });
    recordedAt.setUTCFullYear(2030);

    expect(created.ingestedSequence).toBe(0);
    expect(created.recordedAt.toISOString()).toBe("2026-07-15T12:00:00.000Z");
    expect(() =>
      createRoutinePlanningFeedback({
        ...created,
        ingestedSequence: -1,
        weekStartsOn: 1,
      }),
    ).toThrowError(expect.objectContaining({ code: "planning.feedback_sequence_invalid" }));
  });
});
