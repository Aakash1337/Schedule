import { describe, expect, it } from "vitest";

import {
  activityEventId,
  calculateRoutineDurationInsight,
  createCadencePolicy,
  createDurationRange,
  createRoutine,
  createStructuredTags,
  recordActivityEvent,
  routineId,
  workspaceId,
  type ActivityEvent,
} from "./index.js";

const workspace = workspaceId("duration-insight-workspace");
const otherWorkspace = workspaceId("duration-insight-other-workspace");
const routine = createRoutine({
  id: routineId("duration-insight-routine"),
  workspaceId: workspace,
  title: "Practice piano",
  tags: createStructuredTags(),
  duration: createDurationRange({ minimumMinutes: 20, expectedMinutes: 45, maximumMinutes: 70 }),
  cadence: createCadencePolicy({ period: "week" }),
  now: new Date("2026-01-01T00:00:00.000Z"),
});
const evaluatedAt = new Date("2026-07-13T12:00:00.000Z");

function at(daysBeforeEvaluation: number): Date {
  return new Date(evaluatedAt.getTime() - daysBeforeEvaluation * 24 * 60 * 60 * 1_000);
}

function completion(
  id: string,
  durationMinutes: number,
  daysBeforeEvaluation: number,
  overrides: Partial<Parameters<typeof recordActivityEvent>[0]> = {},
): ActivityEvent {
  const occurredAt = overrides.occurredAt ?? at(daysBeforeEvaluation);
  return recordActivityEvent({
    id: activityEventId(id),
    workspaceId: workspace,
    routineId: routine.id,
    type: "completed",
    occurredAt,
    timeZone: "UTC",
    durationMinutes,
    recordedAt: overrides.recordedAt ?? occurredAt,
    ...overrides,
  });
}

function correction(
  id: string,
  completionId: ActivityEvent["id"],
  durationMinutes: number,
  recordedAt: Date,
): ActivityEvent {
  return recordActivityEvent({
    id: activityEventId(id),
    workspaceId: workspace,
    routineId: routine.id,
    type: "duration_corrected",
    occurredAt: recordedAt,
    recordedAt,
    timeZone: "UTC",
    durationMinutes,
    referenceEventId: completionId,
  });
}

describe("routine duration insight", () => {
  it("reports transparent insufficient history without inventing a median", () => {
    const result = calculateRoutineDurationInsight(
      routine,
      [completion("one", 40, 1), completion("two", 50, 2)],
      evaluatedAt,
    );

    expect(result).toMatchObject({
      routineId: routine.id,
      routineVersion: 1,
      status: "insufficient_history",
      insightKey: null,
      disposition: "available",
      dismissedAt: null,
      sampleCount: 2,
      minimumSamples: 3,
      lookbackDays: 90,
      currentExpectedMinutes: 45,
      minimumMinutes: 20,
      maximumMinutes: 70,
      observedMedianMinutes: null,
      suggestedExpectedMinutes: null,
      materialThresholdMinutes: 5,
    });
    expect(result.evaluatedAt).not.toBe(evaluatedAt);
    expect(result.evaluatedAt).toEqual(evaluatedAt);
    expect(result.windowStartedAt).toEqual(at(90));
  });

  it("uses an inclusive 90-day window and ignores future, unrelated, and invalid samples", () => {
    const insideBoundary = completion("boundary", 40, 90);
    const justOutside = completion("outside", 65, 90, {
      occurredAt: new Date(at(90).getTime() - 1),
    });
    const futureOccurrence = completion("future-occurrence", 65, 1, {
      occurredAt: new Date(evaluatedAt.getTime() + 1),
    });
    const futureRecording = completion("future-recording", 65, 1, {
      recordedAt: new Date(evaluatedAt.getTime() + 1),
    });
    const otherRoutine = completion("other-routine", 65, 1, {
      routineId: routineId("other-routine"),
    });
    const otherTenant = completion("other-workspace", 65, 1, { workspaceId: otherWorkspace });
    const fractionalDuration = {
      ...completion("fractional", 40, 1),
      durationMinutes: 40.5,
    } satisfies ActivityEvent;
    const result = calculateRoutineDurationInsight(
      routine,
      [
        insideBoundary,
        justOutside,
        futureOccurrence,
        futureRecording,
        otherRoutine,
        otherTenant,
        fractionalDuration,
      ],
      evaluatedAt,
    );

    expect(result).toMatchObject({ status: "insufficient_history", sampleCount: 1 });
  });

  it("rejects an invalid evaluation timestamp with a stable domain error", () => {
    expect(() =>
      calculateRoutineDurationInsight(routine, [], "not-a-date" as unknown as Date),
    ).toThrowError(
      expect.objectContaining({ code: "routine_duration_insight.evaluated_at_invalid" }),
    );
  });

  it("uses the latest non-future correction by recorded time then lexicographic id", () => {
    const first = completion("first", 40, 3);
    const second = completion("second", 50, 2);
    const third = completion("third", 60, 1);
    const earliest = correction("a-correction", first.id, 51, at(1));
    const sameMomentLaterId = correction("z-correction", first.id, 55, at(1));
    const future = correction(
      "future-correction",
      first.id,
      65,
      new Date(evaluatedAt.getTime() + 1),
    );
    const result = calculateRoutineDurationInsight(
      routine,
      [first, second, third, future, sameMomentLaterId, earliest],
      evaluatedAt,
    );

    expect(result).toMatchObject({
      status: "suggested",
      sampleCount: 3,
      observedMedianMinutes: 55,
      suggestedExpectedMinutes: 55,
    });
  });

  it("applies an amendment outside the sample window and removes reversed completions", () => {
    const first = completion("first", 40, 4);
    const second = completion("second", 50, 3);
    const third = completion("third", 60, 2);
    const fourth = completion("fourth", 65, 1);
    const outsideWindowCorrection = correction("late-correction", first.id, 45, at(91));
    const reversal = recordActivityEvent({
      id: activityEventId("reverse-fourth"),
      workspaceId: workspace,
      routineId: routine.id,
      type: "completion_reversed",
      occurredAt: at(0),
      recordedAt: at(0),
      timeZone: "UTC",
      referenceEventId: fourth.id,
    });
    const result = calculateRoutineDurationInsight(
      routine,
      [first, second, third, fourth, outsideWindowCorrection, reversal],
      evaluatedAt,
    );

    expect(result).toMatchObject({
      status: "suggested",
      sampleCount: 3,
      observedMedianMinutes: 50,
      suggestedExpectedMinutes: 50,
    });
  });

  it("rounds even-sample medians half-up and requires a material difference", () => {
    const aligned = calculateRoutineDurationInsight(
      routine,
      [
        completion("one", 44, 1),
        completion("two", 45, 2),
        completion("three", 46, 3),
        completion("four", 47, 4),
      ],
      evaluatedAt,
    );
    const suggestedAtThreshold = calculateRoutineDurationInsight(
      routine,
      [completion("five", 50, 1), completion("six", 50, 2), completion("seven", 50, 3)],
      evaluatedAt,
    );

    expect(aligned).toMatchObject({ status: "aligned", observedMedianMinutes: 46 });
    expect(suggestedAtThreshold).toMatchObject({
      status: "suggested",
      observedMedianMinutes: 50,
      suggestedExpectedMinutes: 50,
    });
  });

  it("requires range review before considering the material threshold", () => {
    const result = calculateRoutineDurationInsight(
      routine,
      [completion("one", 75, 1), completion("two", 80, 2), completion("three", 85, 3)],
      evaluatedAt,
    );

    expect(result).toMatchObject({
      status: "review_range",
      observedMedianMinutes: 80,
      suggestedExpectedMinutes: null,
    });
  });

  it("is input-order invariant and does not mutate input events or dates", () => {
    const events = [completion("one", 30, 1), completion("two", 45, 2), completion("three", 60, 3)];
    const before = events.map((event) => ({
      id: event.id,
      occurredAt: event.occurredAt.getTime(),
      recordedAt: event.recordedAt.getTime(),
    }));
    const normal = calculateRoutineDurationInsight(routine, events, evaluatedAt);
    const reversed = calculateRoutineDurationInsight(routine, [...events].reverse(), evaluatedAt);

    expect(reversed).toEqual(normal);
    expect(events.map((event) => event.id)).toEqual(["one", "two", "three"]);
    expect(
      events.map((event) => ({
        id: event.id,
        occurredAt: event.occurredAt.getTime(),
        recordedAt: event.recordedAt.getTime(),
      })),
    ).toEqual(before);
  });

  it("content-addresses actionable insights with lowercase SHA-256 keys", () => {
    const suggested = calculateRoutineDurationInsight(
      routine,
      [completion("one", 55, 1), completion("two", 55, 2), completion("three", 55, 3)],
      evaluatedAt,
    );
    const reviewRange = calculateRoutineDurationInsight(
      routine,
      [completion("four", 80, 1), completion("five", 80, 2), completion("six", 80, 3)],
      evaluatedAt,
    );

    expect(suggested).toMatchObject({
      status: "suggested",
      disposition: "available",
      dismissedAt: null,
    });
    expect(reviewRange).toMatchObject({
      status: "review_range",
      disposition: "available",
      dismissedAt: null,
    });
    expect(suggested.insightKey).toMatch(/^[0-9a-f]{64}$/);
    expect(reviewRange.insightKey).toMatch(/^[0-9a-f]{64}$/);
    expect(reviewRange.insightKey).not.toBe(suggested.insightKey);
  });

  it("does not key informational aligned or insufficient-history states", () => {
    const aligned = calculateRoutineDurationInsight(
      routine,
      [completion("one", 45, 1), completion("two", 45, 2), completion("three", 45, 3)],
      evaluatedAt,
    );
    const insufficient = calculateRoutineDurationInsight(
      routine,
      [completion("four", 55, 1), completion("five", 55, 2)],
      evaluatedAt,
    );

    expect(aligned).toMatchObject({ status: "aligned", insightKey: null });
    expect(insufficient).toMatchObject({ status: "insufficient_history", insightKey: null });
  });

  it("keeps the key stable across evaluation time, event order, and routine presentation changes", () => {
    const events = [completion("one", 50, 3), completion("two", 55, 2), completion("three", 60, 1)];
    const baseline = calculateRoutineDurationInsight(routine, events, evaluatedAt);
    const presentationOnlyChange: typeof routine = {
      ...routine,
      title: "Renamed piano practice",
      description: "Presentation-only change",
      version: routine.version + 1,
      updatedAt: new Date("2026-07-13T10:00:00.000Z"),
    };
    const laterEvaluation = new Date(evaluatedAt.getTime() + 60 * 60 * 1_000);
    const reordered = calculateRoutineDurationInsight(
      presentationOnlyChange,
      [...events].reverse(),
      laterEvaluation,
    );

    expect(baseline.status).toBe("suggested");
    expect(reordered.status).toBe("suggested");
    expect(reordered.insightKey).toBe(baseline.insightKey);
    expect(reordered.routineVersion).not.toBe(baseline.routineVersion);
    expect(reordered.evaluatedAt).not.toEqual(baseline.evaluatedAt);
  });

  it("changes the key when relevant duration policy or effective evidence changes", () => {
    const first = completion("one", 50, 3);
    const second = completion("two", 55, 2);
    const third = completion("three", 60, 1);
    const baseline = calculateRoutineDurationInsight(routine, [first, second, third], evaluatedAt);
    const changedPolicy = calculateRoutineDurationInsight(
      {
        ...routine,
        duration: { ...routine.duration, expectedMinutes: 46 },
      },
      [first, second, third],
      evaluatedAt,
    );
    const sameMedianChangedEvidence = calculateRoutineDurationInsight(
      routine,
      [{ ...first, durationMinutes: 51 }, second, third],
      evaluatedAt,
    );

    expect(baseline.status).toBe("suggested");
    expect(changedPolicy.status).toBe("suggested");
    expect(sameMedianChangedEvidence).toMatchObject({
      status: "suggested",
      observedMedianMinutes: 55,
    });
    expect(changedPolicy.insightKey).not.toBe(baseline.insightKey);
    expect(sameMedianChangedEvidence.insightKey).not.toBe(baseline.insightKey);
  });

  it("keys the effective latest correction and reversal while ignoring unrelated noise", () => {
    const first = completion("one", 50, 4);
    const second = completion("two", 55, 3);
    const third = completion("three", 60, 2);
    const fourth = completion("four", 65, 1);
    const baseline = calculateRoutineDurationInsight(
      routine,
      [first, second, third, fourth],
      evaluatedAt,
    );
    const amended = correction("correction", first.id, 52, at(0));
    const corrected = calculateRoutineDurationInsight(
      routine,
      [fourth, amended, third, first, second],
      evaluatedAt,
    );
    const reversal = recordActivityEvent({
      id: activityEventId("reversal"),
      workspaceId: workspace,
      routineId: routine.id,
      type: "completion_reversed",
      occurredAt: at(0),
      recordedAt: at(0),
      timeZone: "UTC",
      referenceEventId: first.id,
    });
    const reversed = calculateRoutineDurationInsight(
      routine,
      [reversal, fourth, amended, third, first, second],
      evaluatedAt,
    );
    const unrelated = completion("unrelated", 10, 1, { routineId: routineId("noise") });
    const withNoise = calculateRoutineDurationInsight(
      routine,
      [unrelated, first, second, third, fourth],
      evaluatedAt,
    );

    expect(corrected.insightKey).not.toBe(baseline.insightKey);
    expect(reversed.insightKey).not.toBe(corrected.insightKey);
    expect(withNoise.insightKey).toBe(baseline.insightKey);
  });
});
