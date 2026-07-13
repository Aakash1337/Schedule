import { describe, expect, it } from "vitest";

import {
  activityEventId,
  calculateRoutineDurationInsight,
  createCadencePolicy,
  createDurationRange,
  createRoutine,
  createRoutineDurationInsightFeedback,
  createStructuredTags,
  latestRoutineDurationInsightFeedback,
  recordActivityEvent,
  resolveRoutineDurationInsightFeedback,
  routineDurationInsightFeedbackId,
  routineId,
  workspaceId,
  type RoutineDurationInsight,
  type RoutineDurationInsightFeedbackKind,
} from "./index.js";

const workspace = workspaceId("duration-feedback-workspace");
const otherWorkspace = workspaceId("duration-feedback-other-workspace");
const routine = createRoutine({
  id: routineId("duration-feedback-routine"),
  workspaceId: workspace,
  title: "Practice piano",
  tags: createStructuredTags(),
  duration: createDurationRange({ minimumMinutes: 20, expectedMinutes: 45, maximumMinutes: 70 }),
  cadence: createCadencePolicy({ period: "week" }),
  now: new Date("2026-01-01T00:00:00.000Z"),
});
const evaluatedAt = new Date("2026-07-13T12:00:00.000Z");

function actionableInsight(): RoutineDurationInsight & { readonly insightKey: string } {
  const events = [50, 55, 60].map((durationMinutes, index) => {
    const occurredAt = new Date(evaluatedAt.getTime() - (index + 1) * 24 * 60 * 60 * 1_000);
    return recordActivityEvent({
      id: activityEventId(`duration-feedback-completion-${index}`),
      workspaceId: workspace,
      routineId: routine.id,
      type: "completed",
      occurredAt,
      recordedAt: occurredAt,
      timeZone: "UTC",
      durationMinutes,
    });
  });
  const insight = calculateRoutineDurationInsight(routine, events, evaluatedAt);
  if (insight.insightKey === null) throw new Error("Expected actionable test insight.");
  return insight as RoutineDurationInsight & { readonly insightKey: string };
}

const insight = actionableInsight();

function feedback(
  id: string,
  kind: RoutineDurationInsightFeedbackKind,
  sequence: number,
  overrides: Partial<Parameters<typeof createRoutineDurationInsightFeedback>[0]> = {},
) {
  return createRoutineDurationInsightFeedback({
    id: routineDurationInsightFeedbackId(id),
    ingestedSequence: sequence,
    workspaceId: workspace,
    routineId: routine.id,
    insightKey: insight.insightKey,
    kind,
    routineVersion: insight.routineVersion,
    observedMedianMinutes: insight.observedMedianMinutes!,
    suggestedExpectedMinutes: insight.suggestedExpectedMinutes,
    idempotencyKey: `duration-feedback-${id}`,
    recordedAt: new Date(Date.parse("2026-07-13T12:00:00.000Z") + sequence * 1_000),
    ...overrides,
  });
}

describe("routine duration insight feedback", () => {
  it("creates an immutable audit snapshot, trims idempotency, and copies its timestamp", () => {
    const recordedAt = new Date("2026-07-13T12:30:00.000Z");
    const created = createRoutineDurationInsightFeedback({
      ...feedback("base", "dismissed", 1),
      id: routineDurationInsightFeedbackId("created"),
      ingestedSequence: 0,
      idempotencyKey: "  dismiss-once  ",
      recordedAt,
    });
    recordedAt.setUTCFullYear(2030);

    expect(created).toMatchObject({
      id: "created",
      ingestedSequence: 0,
      workspaceId: workspace,
      routineId: routine.id,
      insightKey: insight.insightKey,
      kind: "dismissed",
      routineVersion: insight.routineVersion,
      observedMedianMinutes: 55,
      suggestedExpectedMinutes: 55,
      idempotencyKey: "dismiss-once",
    });
    expect(created.recordedAt.toISOString()).toBe("2026-07-13T12:30:00.000Z");
    expect(created.recordedAt).not.toBe(recordedAt);
  });

  it("uses a non-empty branded feedback identifier", () => {
    expect(routineDurationInsightFeedbackId("feedback-id")).toBe("feedback-id");
    expect(() => routineDurationInsightFeedbackId("   ")).toThrow(
      "RoutineDurationInsightFeedbackId cannot be empty.",
    );
  });

  it.each([
    ["kind", { kind: "ignored" }, "routine_duration_insight.feedback_kind_invalid"],
    [
      "negative sequence",
      { ingestedSequence: -1 },
      "routine_duration_insight.feedback_sequence_invalid",
    ],
    [
      "fractional sequence",
      { ingestedSequence: 1.5 },
      "routine_duration_insight.feedback_sequence_invalid",
    ],
    [
      "uppercase insight key",
      { insightKey: "A".repeat(64) },
      "routine_duration_insight.feedback_key_invalid",
    ],
    [
      "short insight key",
      { insightKey: "a".repeat(63) },
      "routine_duration_insight.feedback_key_invalid",
    ],
    ["routine version", { routineVersion: 0 }, "routine_duration_insight.feedback_version_invalid"],
    [
      "observed minutes",
      { observedMedianMinutes: 0 },
      "routine_duration_insight.feedback_observed_minutes_invalid",
    ],
    [
      "suggested minutes",
      { suggestedExpectedMinutes: 2.5 },
      "routine_duration_insight.feedback_suggested_minutes_invalid",
    ],
    [
      "empty idempotency key",
      { idempotencyKey: "   " },
      "routine_duration_insight.feedback_idempotency_key_invalid",
    ],
    [
      "long idempotency key",
      { idempotencyKey: "x".repeat(161) },
      "routine_duration_insight.feedback_idempotency_key_invalid",
    ],
    [
      "recording timestamp",
      { recordedAt: new Date("invalid") },
      "routine_duration_insight.feedback_recorded_at_invalid",
    ],
  ])("rejects invalid %s", (_label, override, code) => {
    expect(() =>
      createRoutineDurationInsightFeedback({
        ...feedback("validation-base", "dismissed", 1),
        ...(override as object),
      } as Parameters<typeof createRoutineDurationInsightFeedback>[0]),
    ).toThrowError(expect.objectContaining({ code }));
  });

  it("accepts a null suggested snapshot for actionable range review", () => {
    expect(
      feedback("range-review", "dismissed", 1, { suggestedExpectedMinutes: null }),
    ).toMatchObject({ suggestedExpectedMinutes: null });
  });

  it("chooses the latest exact-scope key by sequence then id, independent of input order", () => {
    const first = feedback("first", "dismissed", 1);
    const tieLoser = feedback("a-tie", "reset", 2);
    const tieWinner = feedback("z-tie", "dismissed", 2);
    const differentKey = feedback("different-key", "reset", 99, {
      insightKey: "b".repeat(64),
    });
    const differentTenant = feedback("different-tenant", "reset", 99, {
      workspaceId: otherWorkspace,
    });
    const differentRoutine = feedback("different-routine", "reset", 99, {
      routineId: routineId("duration-feedback-other-routine"),
    });
    const events = [first, tieWinner, differentKey, differentTenant, differentRoutine, tieLoser];

    expect(
      latestRoutineDurationInsightFeedback(events, workspace, routine.id, insight.insightKey),
    ).toEqual(tieWinner);
    expect(
      latestRoutineDurationInsightFeedback(
        [...events].reverse(),
        workspace,
        routine.id,
        insight.insightKey,
      ),
    ).toEqual(tieWinner);
  });

  it("resolves dismissal and reset append-only without mutating inputs", () => {
    const dismissed = feedback("dismissed", "dismissed", 1);
    const reset = feedback("reset", "reset", 2);
    const before = dismissed.recordedAt.getTime();
    const dismissedInsight = resolveRoutineDurationInsightFeedback(insight, workspace, [dismissed]);
    const resetInsight = resolveRoutineDurationInsightFeedback(dismissedInsight, workspace, [
      reset,
      dismissed,
    ]);

    expect(dismissedInsight).toMatchObject({
      insightKey: insight.insightKey,
      disposition: "dismissed",
      dismissedAt: dismissed.recordedAt,
    });
    expect(dismissedInsight).not.toBe(insight);
    expect(dismissedInsight.dismissedAt).not.toBe(dismissed.recordedAt);
    expect(resetInsight).toMatchObject({ disposition: "available", dismissedAt: null });
    expect(resetInsight).not.toBe(dismissedInsight);
    expect(insight).toMatchObject({ disposition: "available", dismissedAt: null });
    expect(dismissed.recordedAt.getTime()).toBe(before);
  });

  it("does not carry a dismissal to a different evidence key or informational insight", () => {
    const dismissed = feedback("dismissed", "dismissed", 1);
    const changedKey: RoutineDurationInsight = {
      ...insight,
      insightKey: "c".repeat(64),
    };
    const informational: RoutineDurationInsight = {
      ...insight,
      status: "aligned",
      insightKey: null,
      suggestedExpectedMinutes: null,
    };

    expect(resolveRoutineDurationInsightFeedback(changedKey, workspace, [dismissed])).toBe(
      changedKey,
    );
    expect(resolveRoutineDurationInsightFeedback(informational, workspace, [dismissed])).toBe(
      informational,
    );
  });
});
