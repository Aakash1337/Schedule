import { describe, expect, it } from "vitest";

import {
  activityEventId,
  createCadencePolicy,
  createDailyPlanningRequest,
  createDurationRange,
  createRoutine,
  createStructuredTags,
  dailyPlanId,
  evaluateRoutineForPlan,
  generateDailyPlan,
  recordActivityEvent,
  routineId,
  workspaceId,
  type ActivityEvent,
  type CreateCadencePolicyInput,
  type Routine,
} from "./index.js";

const workspace = workspaceId("workspace-planner-evaluation");
const otherWorkspace = workspaceId("workspace-planner-evaluation-other");
const generatedAt = new Date("2026-07-15T11:00:00.000Z");

function routine(
  id: string,
  options: {
    readonly workspaceId?: ReturnType<typeof workspaceId>;
    readonly status?: "active" | "paused" | "archived";
    readonly priority?: "low" | "medium" | "high" | "critical";
    readonly expectedMinutes?: number;
    readonly category?: string;
    readonly cadence?: Partial<CreateCadencePolicyInput>;
  } = {},
): Routine {
  return createRoutine({
    id: routineId(id),
    workspaceId: options.workspaceId ?? workspace,
    title: id,
    status: options.status,
    tags: createStructuredTags({
      priority: options.priority ?? "medium",
      contexts: ["computer"],
      categories: [options.category ?? id],
    }),
    duration: createDurationRange({ expectedMinutes: options.expectedMinutes ?? 30 }),
    cadence: createCadencePolicy({
      period: "week",
      targetCompletions: 3,
      ...options.cadence,
    }),
    now: new Date("2026-07-01T00:00:00.000Z"),
  });
}

function request(
  seed = "evaluation-seed",
  overrides: Partial<Parameters<typeof createDailyPlanningRequest>[0]> = {},
) {
  return createDailyPlanningRequest({
    workspaceId: workspace,
    date: "2026-07-15",
    timeZone: "UTC",
    availableWindows: [
      {
        startsAt: new Date("2026-07-15T08:00:00.000Z"),
        endsAt: new Date("2026-07-15T12:00:00.000Z"),
      },
    ],
    targetMinutes: 60,
    maximumMinutes: 60,
    targetTaskCount: 2,
    maximumTaskCount: 2,
    availableContexts: ["computer"],
    seed,
    ...overrides,
  });
}

function completion(id: string, target: Routine, date: string): ActivityEvent {
  return recordActivityEvent({
    id: activityEventId(id),
    workspaceId: workspace,
    routineId: target.id,
    type: "completed",
    occurredAt: new Date(`${date}T12:00:00.000Z`),
    timeZone: "UTC",
    recordedAt: new Date(`${date}T12:01:00.000Z`),
  });
}

function plan(
  seed: string,
  routines: readonly Routine[],
  events: readonly ActivityEvent[] = [],
  overrides: Partial<Parameters<typeof createDailyPlanningRequest>[0]> = {},
) {
  return generateDailyPlan({
    id: dailyPlanId(`evaluation-${seed}`),
    request: request(seed, overrides),
    routines,
    events,
    generatedAt,
  });
}

describe("planner evaluation guarantees", () => {
  it("enforces every hard eligibility boundary independently", () => {
    const cases = [
      [routine("wrong-workspace", { workspaceId: otherWorkspace }), "workspace_mismatch"],
      [routine("paused-status", { status: "paused" }), "routine_inactive"],
      [routine("future", { cadence: { startsOn: "2026-07-16" } }), "not_started"],
      [routine("expired", { cadence: { endsOn: "2026-07-14" } }), "ended"],
      [
        routine("temporarily-paused", { cadence: { pausedUntil: "2026-07-15" } }),
        "temporarily_paused",
      ],
      [routine("weekday-excluded", { cadence: { excludedWeekdays: [3] } }), "excluded_weekday"],
    ] as const;

    for (const [candidate, code] of cases) {
      const evaluation = evaluateRoutineForPlan(candidate, [], request());
      expect(evaluation.eligible, candidate.title).toBe(false);
      expect(evaluation.exclusionCodes, candidate.title).toContain(code);
    }

    const consecutive = routine("no-consecutive", {
      cadence: { prohibitConsecutiveDays: true },
    });
    const evaluation = evaluateRoutineForPlan(
      consecutive,
      [completion("no-consecutive-yesterday", consecutive, "2026-07-14")],
      request(),
    );
    expect(evaluation.eligible).toBe(false);
    expect(evaluation.exclusionCodes).toContain("consecutive_day_prohibited");
  });

  it("preserves priority and history ranking under paired deterministic inputs", () => {
    const highPriority = routine("paired-high", { priority: "high" });
    const lowPriority = routine("paired-low", { priority: "low" });
    const fixedRequest = request("paired-ranking");

    expect(evaluateRoutineForPlan(highPriority, [], fixedRequest).score).toBeGreaterThan(
      evaluateRoutineForPlan(lowPriority, [], fixedRequest).score,
    );

    const neglected = routine("paired-neglected", { priority: "medium" });
    const recentlyCompleted = routine("paired-recent", { priority: "medium" });
    expect(evaluateRoutineForPlan(neglected, [], fixedRequest).score).toBeGreaterThan(
      evaluateRoutineForPlan(
        recentlyCompleted,
        [completion("paired-recent-completion", recentlyCompleted, "2026-07-14")],
        fixedRequest,
      ).score,
    );
  });

  it("prefers category diversity across paired deterministic scenarios", () => {
    const sameCategoryA = routine("same-category-a", { category: "learning" });
    const sameCategoryB = routine("same-category-b", { category: "learning" });
    const diverse = routine("category-third", { category: "health" });
    const sameCategoryThird = routine("category-third", { category: "learning" });
    let diverseSelections = 0;
    let controlSelections = 0;

    for (const index of Array.from({ length: 64 }, (_, seedIndex) => seedIndex)) {
      const seed = `category-oracle-${index}`;
      const diverseResult = plan(seed, [sameCategoryA, sameCategoryB, diverse]);
      const controlResult = plan(seed, [sameCategoryA, sameCategoryB, sameCategoryThird]);

      expect(diverseResult.items, `diverse seed ${index}`).toHaveLength(2);
      expect(controlResult.items, `control seed ${index}`).toHaveLength(2);
      expect(diverseResult.totalMinutes, `diverse seed ${index}`).toBe(60);
      expect(controlResult.totalMinutes, `control seed ${index}`).toBe(60);
      if (diverseResult.items.some((item) => item.routineId === diverse.id)) {
        diverseSelections += 1;
      }
      if (controlResult.items.some((item) => item.routineId === sameCategoryThird.id)) {
        controlSelections += 1;
      }
    }

    expect(diverseSelections).toBeGreaterThan(controlSelections);
  });

  it("never violates minute, task-count, or window capacity invariants", () => {
    const result = plan(
      "capacity-invariants",
      [
        routine("capacity-one", { expectedMinutes: 30 }),
        routine("capacity-two", { expectedMinutes: 30 }),
        routine("capacity-three", { expectedMinutes: 30 }),
      ],
      [],
      {
        availableWindows: [
          {
            startsAt: new Date("2026-07-15T08:00:00.000Z"),
            endsAt: new Date("2026-07-15T08:45:00.000Z"),
          },
        ],
        targetMinutes: 45,
        maximumMinutes: 45,
        targetTaskCount: 2,
        maximumTaskCount: 2,
      },
    );

    expect(result.totalMinutes).toBeLessThanOrEqual(45);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.scheduledMinutes).toBe(30);
    expect(new Set(result.items.map((item) => item.routineId)).size).toBe(result.items.length);
  });

  it("is repeatable across seeds and preserves plan-item invariants", () => {
    const routines = [
      routine("repeat-a", { priority: "high" }),
      routine("repeat-b", { priority: "medium" }),
      routine("repeat-c", { priority: "low" }),
    ];
    const seeds = Array.from({ length: 24 }, (_, index) => `repeatable-${index}`);

    for (const seed of seeds) {
      const first = plan(seed, routines);
      const second = plan(seed, [...routines].reverse());
      expect(second).toEqual(first);
      expect(first.items.map((item) => item.position)).toEqual(
        first.items.map((_, index) => index),
      );
      expect(first.items.every((item) => item.scheduledMinutes > 0)).toBe(true);
      expect(first.items.length).toBeLessThanOrEqual(first.inputSnapshot.request.maximumTaskCount);
      expect(first.totalMinutes).toBeLessThanOrEqual(first.inputSnapshot.request.maximumMinutes);
      expect(new Set(first.items.map((item) => item.routineId)).size).toBe(first.items.length);
      const minutesByWindow = new Map<number, number>();
      for (const item of first.items) {
        expect(Number.isInteger(item.windowIndex)).toBe(true);
        expect(item.windowIndex).toBeGreaterThanOrEqual(0);
        expect(item.windowIndex).toBeLessThan(first.inputSnapshot.request.availableWindows.length);
        minutesByWindow.set(
          item.windowIndex,
          (minutesByWindow.get(item.windowIndex) ?? 0) + item.scheduledMinutes,
        );
      }
      for (const [windowIndex, scheduledMinutes] of minutesByWindow) {
        const window = first.inputSnapshot.request.availableWindows[windowIndex];
        if (window === undefined) throw new Error(`Missing evaluated window ${windowIndex}.`);
        const startsAt = Date.parse(String(window.startsAt));
        const endsAt = Date.parse(String(window.endsAt));
        expect(Number.isFinite(startsAt)).toBe(true);
        expect(Number.isFinite(endsAt)).toBe(true);
        expect(scheduledMinutes).toBeLessThanOrEqual((endsAt - startsAt) / 60_000);
      }
    }
  });
});
