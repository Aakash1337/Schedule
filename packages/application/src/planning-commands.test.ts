import { describe, expect, it } from "vitest";

import {
  createCadencePolicy,
  createDurationRange,
  createStructuredTags,
  createWorkspace,
  dailyPlanId,
  workspaceId,
  type ActivityEvent,
  type Routine,
} from "@schedule/domain";

import { CreateRoutine } from "./create-routine.js";
import type { TransactionContext, UnitOfWork } from "./ports.js";
import { RecordActivityEvent } from "./record-activity-event.js";

describe("routine planning commands", () => {
  const workspace = workspaceId("planning-command-workspace");
  const now = new Date("2026-07-15T12:00:00.000Z");

  function harness() {
    let insertedRoutine: Routine | null = null;
    let appendedEvent: ActivityEvent | null = null;
    const context = {
      workspaces: {
        findById: async () => createWorkspace({ id: workspace, name: "Test", now }),
        list: async () => [],
        insert: async () => undefined,
      },
      routines: {
        findById: async () => insertedRoutine,
        list: async () => (insertedRoutine === null ? [] : [insertedRoutine]),
        listPlanningCandidates: async () => (insertedRoutine === null ? [] : [insertedRoutine]),
        insert: async (routine: Routine) => {
          insertedRoutine = routine;
        },
        save: async (routine: Routine) => {
          insertedRoutine = routine;
        },
      },
      activityEvents: {
        findById: async () => appendedEvent,
        listForPlanning: async () => (appendedEvent === null ? [] : [appendedEvent]),
        append: async (event: ActivityEvent) => {
          appendedEvent = event;
          return event;
        },
        listHistory: async () => ({
          items: appendedEvent === null ? [] : [appendedEvent],
          nextCursor: null,
        }),
      },
      workItems: {} as TransactionContext["workItems"],
      scheduleBlocks: {} as TransactionContext["scheduleBlocks"],
      auditEvents: {} as TransactionContext["auditEvents"],
      dailyPlans: {
        findById: async () => null,
      } as TransactionContext["dailyPlans"],
    } satisfies TransactionContext;
    const unitOfWork: UnitOfWork = { run: async (operation) => operation(context) };
    const clock = { now: () => new Date(now) };
    return {
      createRoutine: new CreateRoutine(unitOfWork, clock),
      recordEvent: new RecordActivityEvent(unitOfWork, clock),
      getRoutine: () => insertedRoutine,
      getEvent: () => appendedEvent,
    };
  }

  it("creates a reusable routine through the application boundary", async () => {
    const test = harness();
    const routine = await test.createRoutine.execute({
      workspaceId: workspace,
      title: "Practice Spanish",
      tags: createStructuredTags({ priority: "high", categories: ["learning"] }),
      duration: createDurationRange({ expectedMinutes: 45 }),
      cadence: createCadencePolicy({ period: "week", targetCompletions: 3 }),
    });

    expect(test.getRoutine()).toBe(routine);
    expect(routine.createdAt).toEqual(now);
  });

  it("records an idempotent activity fact through the application boundary", async () => {
    const test = harness();
    const routine = await test.createRoutine.execute({
      workspaceId: workspace,
      title: "Command routine",
      tags: createStructuredTags(),
      duration: createDurationRange({ expectedMinutes: 30 }),
      cadence: createCadencePolicy({ period: "week" }),
    });
    const event = await test.recordEvent.execute({
      workspaceId: workspace,
      routineId: routine.id,
      type: "completed",
      occurredAt: new Date("2026-07-15T10:00:00.000Z"),
      timeZone: "UTC",
      durationMinutes: 40,
      idempotencyKey: "completion-from-device-1",
    });

    expect(test.getEvent()).toBe(event);
    expect(event.recordedAt).toEqual(now);
    expect(event.localDate).toBe("2026-07-15");
  });

  it("rejects missing plans and non-completion activity references", async () => {
    const test = harness();
    const routine = await test.createRoutine.execute({
      workspaceId: workspace,
      title: "Reference routine",
      tags: createStructuredTags(),
      duration: createDurationRange({ expectedMinutes: 30 }),
      cadence: createCadencePolicy({ period: "week" }),
    });
    await expect(
      test.recordEvent.execute({
        workspaceId: workspace,
        routineId: routine.id,
        planId: dailyPlanId("missing-plan"),
        type: "completed",
        occurredAt: new Date("2026-07-15T10:00:00.000Z"),
        timeZone: "UTC",
        idempotencyKey: "missing-plan-event",
      }),
    ).rejects.toMatchObject({ code: "plan.not_found" });

    const suggestion = await test.recordEvent.execute({
      workspaceId: workspace,
      routineId: routine.id,
      type: "suggested",
      occurredAt: new Date("2026-07-15T10:00:00.000Z"),
      timeZone: "UTC",
      idempotencyKey: "suggestion",
    });
    await expect(
      test.recordEvent.execute({
        workspaceId: workspace,
        routineId: routine.id,
        type: "duration_corrected",
        occurredAt: new Date("2026-07-15T11:00:00.000Z"),
        timeZone: "UTC",
        durationMinutes: 20,
        referenceEventId: suggestion.id,
        idempotencyKey: "invalid-correction",
      }),
    ).rejects.toMatchObject({ code: "activity.reference_invalid" });
  });
});
