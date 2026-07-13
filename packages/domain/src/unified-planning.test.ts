import { describe, expect, it } from "vitest";

import {
  createDailyPlanningRequest,
  createRoutine,
  createWorkItem,
  dailyPlanId,
  generateDailyPlan,
  recordActivityEvent,
  replanDailyPlan,
  routineId,
  workItemId,
  workspaceId,
} from "./index.js";

const workspace = workspaceId("unified-workspace");
const request = (revision = 1) =>
  createDailyPlanningRequest({
    workspaceId: workspace,
    date: "2026-07-15",
    timeZone: "UTC",
    availableWindows: [
      { startsAt: new Date("2026-07-15T09:00:00Z"), endsAt: new Date("2026-07-15T10:00:00Z") },
    ],
    targetMinutes: 60,
    targetTaskCount: 2,
    seed: "unified-seed",
    requestRevision: revision,
  });

describe("unified planner candidates", () => {
  it("uses opted-in eligible work items with typed sources and hard budgets", () => {
    const work = createWorkItem({
      id: workItemId("work-a"),
      workspaceId: workspace,
      title: "Ship draft",
      priority: "urgent",
      planningDurationMinutes: 45,
      now: new Date("2026-07-01T00:00:00Z"),
    });
    const tooLarge = createWorkItem({
      id: workItemId("work-b"),
      workspaceId: workspace,
      title: "Too large",
      priority: "urgent",
      planningDurationMinutes: 90,
      now: new Date("2026-07-01T00:00:00Z"),
    });
    const plan = generateDailyPlan({
      id: dailyPlanId("unified-plan"),
      request: request(),
      routines: [],
      workItems: [work, tooLarge],
      events: [],
    });
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({
      sourceType: "work_item",
      routineId: null,
      workItemId: work.id,
      scheduledMinutes: 45,
      partialSession: false,
      score: 5_000,
    });
    expect(plan.exclusions).toContainEqual(
      expect.objectContaining({
        sourceType: "work_item",
        workItemId: tooLarge.id,
        codes: ["duration_does_not_fit"],
      }),
    );
  });

  it("keeps null-duration and terminal work items out of the planner", () => {
    const optedOut = createWorkItem({
      id: workItemId("work-off"),
      workspaceId: workspace,
      title: "Off",
      now: new Date(),
    });
    const done = createWorkItem({
      id: workItemId("work-done"),
      workspaceId: workspace,
      title: "Done",
      status: "done",
      planningDurationMinutes: 20,
      now: new Date(),
    });
    const plan = generateDailyPlan({
      request: request(),
      routines: [],
      workItems: [optedOut, done],
      events: [],
    });
    expect(plan.items).toHaveLength(0);
    expect(plan.exclusions.map((item) => item.codes)).toEqual(
      expect.arrayContaining([["work_item_not_plannable"], ["work_item_status_ineligible"]]),
    );
  });

  it("is deterministic and distinguishes routine and work sources with the same raw id", () => {
    const shared = "shared-source";
    const routine = createRoutine({
      id: routineId(shared),
      workspaceId: workspace,
      title: "Routine",
      tags: {
        priority: "low",
        energy: "medium",
        contexts: [],
        categories: [],
        preference: "neutral",
      },
      duration: { expectedMinutes: 20, minimumMinutes: 20, overheadMinutes: 0, splittable: false },
      cadence: {
        period: "week",
        targetCompletions: 1,
        minimumCompletions: null,
        maximumCompletions: null,
        startsOn: null,
        endsOn: null,
        pausedUntil: null,
        excludedWeekdays: [],
        preferredWeekdays: [],
        weekStartsOn: 1,
        rollingIntervalDays: null,
        minimumSpacingDays: 0,
        prohibitConsecutiveDays: false,
        discourageConsecutiveDays: false,
      },
    });
    const work = createWorkItem({
      id: workItemId(shared),
      workspaceId: workspace,
      title: "Work",
      planningDurationMinutes: 20,
      priority: "high",
      now: new Date(),
    });
    const input = {
      request: request(),
      routines: [routine],
      workItems: [work],
      events: [],
    } as const;
    const first = generateDailyPlan({ ...input, id: dailyPlanId("deterministic-source") });
    const second = generateDailyPlan({ ...input, id: dailyPlanId("deterministic-source") });
    expect(first.items.map((item) => [item.sourceType, item.id])).toEqual(
      second.items.map((item) => [item.sourceType, item.id]),
    );
    expect(
      new Set(
        first.items.map(
          (item) =>
            `${item.sourceType}:${item.sourceType === "routine" ? item.routineId : item.workItemId}`,
        ),
      ).size,
    ).toBe(2);
  });

  it("does not resurrect a terminal work-item sibling during replanning", () => {
    const work = createWorkItem({
      id: workItemId("terminal-work"),
      workspaceId: workspace,
      title: "Terminal",
      planningDurationMinutes: 30,
      priority: "urgent",
      now: new Date(),
    });
    const source = generateDailyPlan({
      id: dailyPlanId("terminal-source"),
      request: request(),
      routines: [],
      workItems: [work],
      events: [],
    });
    const terminalSource = {
      ...source,
      items: source.items.map((item) => ({ ...item, activityState: "completed" as const })),
    };
    const replanned = replanDailyPlan({
      sourcePlan: terminalSource,
      request: request(2),
      anchoredItems: [],
      routines: [],
      workItems: [work],
      events: [],
      kind: "regenerate",
    });
    expect(replanned.items).toHaveLength(0);
  });

  it("rejects forged retained anchors even when their plan-item id is valid", () => {
    const work = createWorkItem({
      id: workItemId("anchor-work"),
      workspaceId: workspace,
      title: "Anchor",
      planningDurationMinutes: 30,
      priority: "urgent",
      now: new Date(),
    });
    const source = generateDailyPlan({
      id: dailyPlanId("anchor-source"),
      request: request(),
      routines: [],
      workItems: [work],
      events: [],
    });
    const anchor = source.items[0]!;
    const replan = (forged: typeof anchor) =>
      replanDailyPlan({
        sourcePlan: source,
        request: request(2),
        anchoredItems: [forged],
        routines: [],
        workItems: [work],
        events: [],
        kind: "regenerate",
      });
    const expectTampered = (forged: typeof anchor) => {
      try {
        replan(forged);
      } catch (error) {
        expect(error).toMatchObject({ code: "planning.anchor_tampered" });
        return;
      }
      throw new Error("Expected a forged anchor to be rejected.");
    };
    expectTampered({
      ...anchor,
      sourceType: "routine",
      routineId: routineId("forged-routine"),
      workItemId: null,
    });
    expectTampered({ ...anchor, title: "Forged payload", scheduledMinutes: 1 });
  });

  it("records work-item activity with a typed identity", () => {
    const event = recordActivityEvent({
      workspaceId: workspace,
      workItemId: workItemId("activity-work"),
      type: "completed",
      occurredAt: new Date("2026-07-15T10:00:00Z"),
      timeZone: "UTC",
    });
    expect(event).toMatchObject({
      sourceType: "work_item",
      routineId: null,
      workItemId: workItemId("activity-work"),
    });
  });

  it("allows system completion metadata alongside normal user metadata", () => {
    const metadata = Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [`field_${index}`, index]),
    );
    expect(() =>
      recordActivityEvent({
        workspaceId: workspace,
        workItemId: workItemId("metadata-work"),
        type: "completed",
        occurredAt: new Date("2026-07-15T10:00:00Z"),
        timeZone: "UTC",
        metadata,
      }),
    ).not.toThrow();
  });
});
