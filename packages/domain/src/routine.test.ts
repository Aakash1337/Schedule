import { describe, expect, it } from "vitest";

import {
  DomainError,
  activityEventId,
  createCadencePolicy,
  createDurationRange,
  createRoutine,
  createStructuredTags,
  recordActivityEvent,
  routineId,
  updateRoutine,
  workspaceId,
} from "./index.js";

describe("routine domain model", () => {
  const workspace = workspaceId("workspace-routine-tests");

  it("creates a routine with normalized structured tags and a cadence policy", () => {
    const routine = createRoutine({
      id: routineId("routine-study"),
      workspaceId: workspace,
      title: " Study Spanish ",
      tags: createStructuredTags({
        priority: "high",
        contexts: [" Computer ", "computer"],
        categories: ["Learning"],
      }),
      duration: createDurationRange({
        minimumMinutes: 30,
        expectedMinutes: 45,
        maximumMinutes: 60,
        splittable: true,
        minimumSessionMinutes: 20,
      }),
      cadence: createCadencePolicy({
        period: "week",
        targetCompletions: 3,
        minimumCompletions: 2,
        maximumCompletions: 4,
        minimumSpacingDays: 1,
        preferredWeekdays: [1, 3, 5],
      }),
    });

    expect(routine.title).toBe("Study Spanish");
    expect(routine.tags.contexts).toEqual(["computer"]);
    expect(routine.tags.categories).toEqual(["learning"]);
    expect(routine.cadence.targetCompletions).toBe(3);
  });

  it("rejects inverted duration estimates", () => {
    expect(() =>
      createDurationRange({
        minimumMinutes: 60,
        expectedMinutes: 45,
        maximumMinutes: 90,
      }),
    ).toThrowError(DomainError);
  });

  it("rejects conflicting cadence weekdays and bounds", () => {
    expect(() =>
      createCadencePolicy({
        period: "week",
        targetCompletions: 2,
        minimumCompletions: 3,
      }),
    ).toThrowError(DomainError);

    expect(() =>
      createCadencePolicy({
        period: "week",
        preferredWeekdays: [2],
        excludedWeekdays: [2],
      }),
    ).toThrowError(DomainError);
  });

  it("records local civil time and append-only correction references", () => {
    const completionId = activityEventId("completion-1");
    const completion = recordActivityEvent({
      id: completionId,
      workspaceId: workspace,
      routineId: routineId("routine-study"),
      type: "completed",
      occurredAt: new Date("2026-07-13T02:30:00.000Z"),
      timeZone: "America/La_Paz",
      durationMinutes: 42,
      recordedAt: new Date("2026-07-13T02:31:00.000Z"),
    });
    const correction = recordActivityEvent({
      workspaceId: workspace,
      routineId: routineId("routine-study"),
      type: "duration_corrected",
      occurredAt: new Date("2026-07-13T02:32:00.000Z"),
      timeZone: "America/La_Paz",
      durationMinutes: 47,
      referenceEventId: completionId,
      recordedAt: new Date("2026-07-13T02:32:00.000Z"),
    });

    expect(completion.localDate).toBe("2026-07-12");
    expect(correction.referenceEventId).toBe(completionId);
  });

  it("requires a referenced completion when recording a reversal", () => {
    expect(() =>
      recordActivityEvent({
        workspaceId: workspace,
        routineId: routineId("routine-study"),
        type: "completion_reversed",
        occurredAt: new Date("2026-07-13T12:00:00.000Z"),
        timeZone: "UTC",
      }),
    ).toThrowError(DomainError);
  });

  it("rejects references on ordinary activity events", () => {
    expect(() =>
      recordActivityEvent({
        workspaceId: workspace,
        routineId: routineId("routine-study"),
        type: "suggested",
        occurredAt: new Date("2026-07-13T12:00:00.000Z"),
        timeZone: "UTC",
        referenceEventId: activityEventId("unrelated-event"),
      }),
    ).toThrowError(DomainError);
  });

  it("bounds activity metadata included in planner snapshots", () => {
    expect(() =>
      recordActivityEvent({
        workspaceId: workspace,
        routineId: routineId("routine-study"),
        type: "completed",
        occurredAt: new Date("2026-07-13T12:00:00.000Z"),
        timeZone: "UTC",
        metadata: Object.fromEntries(
          Array.from({ length: 9 }, (_, index) => [`field-${index}`, index]),
        ),
      }),
    ).toThrowError(DomainError);
  });

  it("updates a routine once and preserves its version for an effective no-op", () => {
    const original = createRoutine({
      workspaceId: workspace,
      title: "Practice Spanish",
      tags: createStructuredTags({ priority: "high" }),
      duration: createDurationRange({ expectedMinutes: 30 }),
      cadence: createCadencePolicy({ period: "week", targetCompletions: 3 }),
      now: new Date("2026-07-01T00:00:00.000Z"),
    });
    const updated = updateRoutine(original, {
      title: " Practice Spanish daily ",
      status: "paused",
      now: new Date("2026-07-15T00:00:00.000Z"),
    });
    const noOp = updateRoutine(updated, {
      title: "Practice Spanish daily",
      status: "paused",
      now: new Date("2026-07-16T00:00:00.000Z"),
    });

    expect(updated.title).toBe("Practice Spanish daily");
    expect(updated.status).toBe("paused");
    expect(updated.version).toBe(2);
    expect(noOp).toBe(updated);
  });

  it("rejects a real update after the database version range is exhausted", () => {
    const original = createRoutine({
      workspaceId: workspace,
      title: "Long-lived routine",
      tags: createStructuredTags(),
      duration: createDurationRange({ expectedMinutes: 30 }),
      cadence: createCadencePolicy({ period: "week" }),
    });
    const exhausted = { ...original, version: 2_147_483_647 };

    expect(() => updateRoutine(exhausted, { status: "archived" })).toThrowError(
      expect.objectContaining({ code: "routine.version_exhausted" }),
    );
    expect(updateRoutine(exhausted, { title: original.title })).toBe(exhausted);
  });
});
