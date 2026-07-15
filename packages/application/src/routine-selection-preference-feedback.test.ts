import {
  createCadencePolicy,
  createDurationRange,
  createRoutine,
  createRoutineSelectionPreferenceFeedback,
  createStructuredTags,
  createWorkspace,
  dailyPlanId,
  routineSelectionPreferenceFeedbackId,
  ROUTINE_SELECTION_PREFERENCE_MAX_RECORDED_EVENTS,
  type RoutineSelectionPreferenceFeedback,
} from "@schedule/domain";
import { describe, expect, it } from "vitest";

import { GetRoutineSelectionPreferenceState } from "./get-routine-selection-preference-state.js";
import { RecordRoutineSelectionPreferenceFeedback } from "./record-routine-selection-preference-feedback.js";
import type {
  RoutineSelectionPreferenceFeedbackReceipt,
  TransactionContext,
  UnitOfWork,
} from "./ports.js";

const now = new Date("2026-07-15T01:30:00.000Z");
const workspace = createWorkspace({ name: "Preference tests", now });
const routine = createRoutine({
  workspaceId: workspace.id,
  title: "Review inbox",
  tags: createStructuredTags({ priority: "medium" }),
  duration: createDurationRange({ minimumMinutes: 15, expectedMinutes: 30, maximumMinutes: 45 }),
  cadence: createCadencePolicy({ period: "week", targetCompletions: 1 }),
  now,
});

function harness() {
  let feedbackVersion = 0;
  const feedback: RoutineSelectionPreferenceFeedback[] = [];
  let lockCalls = 0;
  let idempotencyLockCalls = 0;
  const repository = {
    lockIdempotencyKey: async () => {
      idempotencyLockCalls += 1;
    },
    findCurrentState: async () => ({
      feedbackVersion,
      updatedAt: feedback.length === 0 ? null : feedback.at(-1)!.recordedAt,
    }),
    findByIdempotencyKey: async (_workspaceId: string, idempotencyKey: string) => {
      const index = feedback.findIndex((candidate) => candidate.idempotencyKey === idempotencyKey);
      const item = feedback[index];
      return item === undefined ? null : { feedback: item, feedbackVersion: index + 1 };
    },
    lockAndGetCurrentVersion: async () => {
      lockCalls += 1;
      return feedbackVersion;
    },
    listForPlanning: async () => feedback,
    listForPlanningThroughVersion: async (
      _workspaceId: string,
      _routineId: string,
      _throughDate: string,
      throughFeedbackVersion: number,
    ) => feedback.filter((item) => item.ingestedSequence <= throughFeedbackVersion),
    appendAndAdvance: async (item: RoutineSelectionPreferenceFeedback, expected: number) => {
      expect(expected).toBe(feedbackVersion);
      feedbackVersion += 1;
      const stored = { ...item, ingestedSequence: feedbackVersion };
      feedback.push(stored);
      return {
        feedback: stored,
        feedbackVersion,
      } satisfies RoutineSelectionPreferenceFeedbackReceipt;
    },
  };
  const context = {
    workspaces: { findById: async () => workspace },
    dailyPlans: { findById: async () => null },
    routineSelectionPreferenceFeedback: repository,
  } as TransactionContext;
  const unitOfWork: UnitOfWork = { run: async (operation) => operation(context) };
  return {
    record: new RecordRoutineSelectionPreferenceFeedback(unitOfWork, { now: () => now }),
    read: new GetRoutineSelectionPreferenceState(unitOfWork, { now: () => now }),
    feedback,
    get feedbackVersion() {
      return feedbackVersion;
    },
    get lockCalls() {
      return lockCalls;
    },
    get idempotencyLockCalls() {
      return idempotencyLockCalls;
    },
    repository,
  };
}

describe("routine selection preference feedback", () => {
  it("returns a zero-version read projection without mutating a routine or plan", async () => {
    const test = harness();

    await expect(
      test.read.execute({
        workspaceId: workspace.id,
        routineId: routine.id,
        timeZone: "America/La_Paz",
      }),
    ).resolves.toMatchObject({
      routineId: routine.id,
      feedbackVersion: 0,
      activeEventCount: 0,
      score: 0,
      reason: null,
      updatedAt: null,
    });
  });

  it("records an append-only preference and projects its new version and score", async () => {
    const test = harness();
    const result = await test.record.execute({
      workspaceId: workspace.id,
      routineId: routine.id,
      expectedFeedbackVersion: 0,
      kind: "more_often",
      timeZone: "America/La_Paz",
      idempotencyKey: "prefer-inbox",
    });

    expect(result).toMatchObject({ feedbackVersion: 1, activeEventCount: 1, score: 100 });
    await expect(
      test.read.execute({
        workspaceId: workspace.id,
        routineId: routine.id,
        timeZone: "America/La_Paz",
      }),
    ).resolves.toMatchObject({
      feedbackVersion: 1,
      activeEventCount: 1,
      score: 100,
      updatedAt: now,
    });

    await test.record.execute({
      workspaceId: workspace.id,
      routineId: routine.id,
      expectedFeedbackVersion: 1,
      kind: "reset",
      timeZone: "America/La_Paz",
      idempotencyKey: "reset-inbox-preference",
    });
    await expect(
      test.read.execute({
        workspaceId: workspace.id,
        routineId: routine.id,
        timeZone: "America/La_Paz",
      }),
    ).resolves.toMatchObject({ feedbackVersion: 2, activeEventCount: 0, score: 0, reason: null });
  });

  it("rechecks the receipt after the routine lock so an ordered duplicate does not advance twice", async () => {
    const test = harness();
    const first = await test.record.execute({
      workspaceId: workspace.id,
      routineId: routine.id,
      expectedFeedbackVersion: 0,
      kind: "less_often",
      timeZone: "America/La_Paz",
      idempotencyKey: "same-key",
    });
    const replay = await test.record.execute({
      workspaceId: workspace.id,
      routineId: routine.id,
      expectedFeedbackVersion: 0,
      kind: "less_often",
      timeZone: "America/La_Paz",
      idempotencyKey: "same-key",
    });

    expect(replay).toEqual(first);
    expect(test.feedbackVersion).toBe(1);
    expect(test.idempotencyLockCalls).toBe(2);
  });

  it("replays the exact accepted projection after newer preference events", async () => {
    const test = harness();
    const first = await test.record.execute({
      workspaceId: workspace.id,
      routineId: routine.id,
      expectedFeedbackVersion: 0,
      kind: "more_often",
      timeZone: "America/La_Paz",
      idempotencyKey: "first-projection",
    });
    await test.record.execute({
      workspaceId: workspace.id,
      routineId: routine.id,
      expectedFeedbackVersion: 1,
      kind: "more_often",
      timeZone: "America/La_Paz",
      idempotencyKey: "newer-projection",
    });

    await expect(
      test.record.execute({
        workspaceId: workspace.id,
        routineId: routine.id,
        expectedFeedbackVersion: 0,
        kind: "more_often",
        timeZone: "America/La_Paz",
        idempotencyKey: "first-projection",
      }),
    ).resolves.toEqual(first);
    expect(first).toMatchObject({ feedbackVersion: 1, activeEventCount: 1, score: 100 });
  });

  it("rejects new events at the finite routine history capacity", async () => {
    let appendCalls = 0;
    const context = {
      workspaces: { findById: async () => workspace },
      dailyPlans: { findById: async () => null },
      routineSelectionPreferenceFeedback: {
        lockIdempotencyKey: async () => undefined,
        findByIdempotencyKey: async () => null,
        lockAndGetCurrentVersion: async () => ROUTINE_SELECTION_PREFERENCE_MAX_RECORDED_EVENTS,
        appendAndAdvance: async () => {
          appendCalls += 1;
          throw new Error("capacity must be checked before append");
        },
      },
    } as TransactionContext;
    const useCase = new RecordRoutineSelectionPreferenceFeedback(
      { run: async (operation) => operation(context) },
      { now: () => now },
    );

    await expect(
      useCase.execute({
        workspaceId: workspace.id,
        routineId: routine.id,
        expectedFeedbackVersion: ROUTINE_SELECTION_PREFERENCE_MAX_RECORDED_EVENTS,
        kind: "less_often",
        timeZone: "UTC",
        idempotencyKey: "over-capacity",
      }),
    ).rejects.toMatchObject({ code: "planning.selection_preference_capacity_reached" });
    expect(appendCalls).toBe(0);
  });

  it("rejects nonexistent source-plan provenance before appending", async () => {
    const test = harness();
    await expect(
      test.record.execute({
        workspaceId: workspace.id,
        routineId: routine.id,
        expectedFeedbackVersion: 0,
        kind: "more_often",
        timeZone: "UTC",
        sourcePlanId: dailyPlanId("00000000-0000-4000-8000-000000000777"),
        idempotencyKey: "missing-source-plan",
      }),
    ).rejects.toMatchObject({ code: "planning.selection_preference_source_not_found" });
    expect(test.feedback).toHaveLength(0);
  });

  it("returns the accepted projection that becomes visible only after waiting for the feedback lock", async () => {
    const recorded = createRoutineSelectionPreferenceFeedback({
      id: routineSelectionPreferenceFeedbackId("00000000-0000-4000-8000-000000000901"),
      ingestedSequence: 1,
      workspaceId: workspace.id,
      routineId: routine.id,
      kind: "more_often",
      effectiveOn: "2026-07-14",
      timeZone: "America/La_Paz",
      sourcePlanId: null,
      sourcePlanItemId: null,
      idempotencyKey: "waited-duplicate",
      recordedAt: now,
    });
    let locked = false;
    let appendCalls = 0;
    const context = {
      workspaces: { findById: async () => workspace },
      dailyPlans: { findById: async () => null },
      routineSelectionPreferenceFeedback: {
        lockIdempotencyKey: async () => undefined,
        findByIdempotencyKey: async () =>
          locked ? { feedback: recorded, feedbackVersion: 1 } : null,
        lockAndGetCurrentVersion: async () => {
          locked = true;
          return 1;
        },
        listForPlanningThroughVersion: async () => [recorded],
        appendAndAdvance: async () => {
          appendCalls += 1;
          throw new Error("append must not run for a waited duplicate");
        },
      },
    } as TransactionContext;
    const unitOfWork: UnitOfWork = { run: async (operation) => operation(context) };
    const useCase = new RecordRoutineSelectionPreferenceFeedback(unitOfWork, { now: () => now });

    await expect(
      useCase.execute({
        workspaceId: workspace.id,
        routineId: routine.id,
        expectedFeedbackVersion: 0,
        kind: "more_often",
        timeZone: "America/La_Paz",
        idempotencyKey: "waited-duplicate",
      }),
    ).resolves.toMatchObject({
      routineId: routine.id,
      feedbackVersion: 1,
      activeEventCount: 1,
      score: 100,
      updatedAt: now,
    });
    expect(appendCalls).toBe(0);
  });
});
