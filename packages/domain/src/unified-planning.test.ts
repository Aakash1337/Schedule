import { describe, expect, it } from "vitest";

import {
  createDailyPlanningRequest,
  createRoutine,
  createWorkItem,
  DEFAULT_PLANNER_CONFIG,
  dailyPlanId,
  evaluateWorkItemForPlan,
  generateDailyPlan,
  localDate,
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

  it("adds deterministic deadline pressure without bypassing work-item constraints", () => {
    const dueDates = [
      ["no-deadline", null, 2_000],
      ["today", localDate("2026-07-15"), 5_000],
      ["future", localDate("2026-07-17"), 4_600],
      ["horizon", localDate("2026-07-29"), 2_200],
      ["overdue", localDate("2026-07-13"), 6_000],
      ["overdue-capped", localDate("2026-06-20"), 7_000],
      ["outside", localDate("2026-07-30"), 2_000],
    ] as const;
    const items = dueDates.map(([id, dueOn]) =>
      createWorkItem({
        id: workItemId(`deadline-${id}`),
        workspaceId: workspace,
        title: id,
        priority: "medium",
        dueOn,
        planningDurationMinutes: 10,
        now: new Date("2026-07-01T00:00:00Z"),
      }),
    );
    const deadlineRequest = createDailyPlanningRequest({
      workspaceId: workspace,
      date: "2026-07-15",
      timeZone: "UTC",
      availableWindows: [
        { startsAt: new Date("2026-07-15T09:00:00Z"), endsAt: new Date("2026-07-15T10:00:00Z") },
      ],
      targetMinutes: 50,
      targetTaskCount: 5,
      seed: "deadline-seed",
    });
    const evaluations = items.map((item) => evaluateWorkItemForPlan(item, deadlineRequest));
    const plan = generateDailyPlan({
      id: dailyPlanId("deadline-plan"),
      request: deadlineRequest,
      routines: [],
      workItems: items,
      events: [],
    });
    const byWorkItemId = new Map(
      evaluations.map((evaluation) => [evaluation.workItemId, evaluation]),
    );

    expect(byWorkItemId.get(workItemId("deadline-no-deadline"))).toMatchObject({
      score: 2_000,
      scoreComponents: { priority: 2_000 },
    });
    expect(byWorkItemId.get(workItemId("deadline-today"))).toMatchObject({
      score: 5_000,
      scoreComponents: { deadlinePressure: 3_000 },
    });
    expect(byWorkItemId.get(workItemId("deadline-future"))).toMatchObject({
      score: 4_600,
      scoreComponents: { deadlinePressure: 2_600 },
    });
    expect(byWorkItemId.get(workItemId("deadline-horizon"))).toMatchObject({
      score: 2_200,
      scoreComponents: { deadlinePressure: 200 },
    });
    expect(byWorkItemId.get(workItemId("deadline-overdue"))).toMatchObject({
      score: 6_000,
      scoreComponents: { deadlinePressure: 4_000 },
    });
    expect(byWorkItemId.get(workItemId("deadline-overdue-capped"))).toMatchObject({
      score: 7_000,
      scoreComponents: { deadlinePressure: 5_000 },
    });
    expect(byWorkItemId.get(workItemId("deadline-outside"))).toMatchObject({
      score: 2_000,
      scoreComponents: { deadlinePressure: 0 },
    });
    expect(
      [...evaluations]
        .sort((left, right) => right.score - left.score)
        .map((evaluation) => evaluation.workItemId),
    ).toEqual([
      workItemId("deadline-overdue-capped"),
      workItemId("deadline-overdue"),
      workItemId("deadline-today"),
      workItemId("deadline-future"),
      workItemId("deadline-horizon"),
      workItemId("deadline-no-deadline"),
      workItemId("deadline-outside"),
    ]);
    expect(plan.inputSnapshot).toMatchObject({
      config: { algorithmVersion: "deterministic-planner-v7", configVersion: "default-weights-v5" },
      workItems: expect.arrayContaining([expect.objectContaining({ dueOn: "2026-07-15" })]),
    });
    const repeated = generateDailyPlan({
      id: dailyPlanId("deadline-plan"),
      request: deadlineRequest,
      routines: [],
      workItems: [...items].reverse(),
      events: [],
    });
    expect(repeated.inputHash).toBe(plan.inputHash);
    expect(repeated.items).toEqual(plan.items);

    const ineligible = createWorkItem({
      id: workItemId("deadline-ineligible"),
      workspaceId: workspace,
      title: "Ineligible",
      dueOn: localDate("2026-07-15"),
      planningDurationMinutes: null,
      now: new Date("2026-07-01T00:00:00Z"),
    });
    expect(
      generateDailyPlan({
        request: deadlineRequest,
        routines: [],
        workItems: [ineligible],
        events: [],
      }).exclusions,
    ).toContainEqual(
      expect.objectContaining({ workItemId: ineligible.id, codes: ["work_item_not_plannable"] }),
    );
    expect(() =>
      generateDailyPlan({
        request: deadlineRequest,
        routines: [],
        events: [],
        config: { ...DEFAULT_PLANNER_CONFIG, workItemDeadlineHorizonDays: -1 },
      }),
    ).toThrowError(
      expect.objectContaining({ code: "planning.work_item_deadline_horizon_invalid" }),
    );
    expect(() =>
      generateDailyPlan({
        request: deadlineRequest,
        routines: [],
        events: [],
        config: {
          ...DEFAULT_PLANNER_CONFIG,
          workItemDeadlineHorizonDays: Number.MAX_SAFE_INTEGER + 1,
        },
      }),
    ).toThrowError(
      expect.objectContaining({ code: "planning.work_item_deadline_horizon_invalid" }),
    );
    expect(() =>
      generateDailyPlan({
        request: deadlineRequest,
        routines: [],
        events: [],
        config: {
          ...DEFAULT_PLANNER_CONFIG,
          score: { ...DEFAULT_PLANNER_CONFIG.score, workItemDeadlineFuturePerDay: -1 },
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "planning.work_item_deadline_score_invalid" }));
    expect(() =>
      generateDailyPlan({
        request: deadlineRequest,
        routines: [],
        events: [],
        config: {
          ...DEFAULT_PLANNER_CONFIG,
          workItemDeadlineHorizonDays: 2,
          score: {
            ...DEFAULT_PLANNER_CONFIG.score,
            workItemDeadlineFuturePerDay: 500_001,
          },
        },
      }),
    ).toThrowError(
      expect.objectContaining({ code: "planning.work_item_deadline_future_range_invalid" }),
    );
    expect(() =>
      generateDailyPlan({
        request: deadlineRequest,
        routines: [],
        events: [],
        config: {
          ...DEFAULT_PLANNER_CONFIG,
          score: {
            ...DEFAULT_PLANNER_CONFIG.score,
            workItemDeadlineOverdueBase: 5_001,
            workItemDeadlineOverdueMaximum: 5_000,
          },
        },
      }),
    ).toThrowError(
      expect.objectContaining({ code: "planning.work_item_deadline_overdue_bounds_invalid" }),
    );
    expect(() =>
      generateDailyPlan({
        request: deadlineRequest,
        routines: [],
        events: [],
        config: { ...DEFAULT_PLANNER_CONFIG, workItemDeadlineHorizonDays: 0 },
      }),
    ).not.toThrow();

    const zeroFutureWeight = evaluateWorkItemForPlan(items[2]!, deadlineRequest, {
      ...DEFAULT_PLANNER_CONFIG,
      score: { ...DEFAULT_PLANNER_CONFIG.score, workItemDeadlineFuturePerDay: 0 },
    });
    expect(zeroFutureWeight.scoreComponents.deadlinePressure).toBe(0);
    expect(zeroFutureWeight.reasons).toContain("Due in 2 day(s) (+0 deadline pressure).");
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
