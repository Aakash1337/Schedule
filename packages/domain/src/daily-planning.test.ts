import { describe, expect, it } from "vitest";

import {
  DEFAULT_PLANNER_CONFIG,
  DomainError,
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
  replanDailyPlan,
  routineId,
  workspaceId,
  type ActivityEvent,
  type Routine,
} from "./index.js";

const workspace = workspaceId("workspace-planner-tests");
const generatedAt = new Date("2026-07-15T11:00:00.000Z");

function routine(
  id: string,
  options: {
    readonly expectedMinutes?: number;
    readonly minimumSessionMinutes?: number;
    readonly splittable?: boolean;
    readonly target?: number;
    readonly maximum?: number | null;
    readonly spacing?: number;
    readonly prohibitConsecutiveDays?: boolean;
    readonly contexts?: readonly string[];
    readonly priority?: "low" | "medium" | "high" | "critical";
    readonly status?: "active" | "paused" | "archived";
  } = {},
): Routine {
  const expectedMinutes = options.expectedMinutes ?? 30;
  const splittable = options.splittable ?? false;
  return createRoutine({
    id: routineId(id),
    workspaceId: workspace,
    title: id,
    tags: createStructuredTags({
      priority: options.priority ?? "medium",
      contexts: options.contexts,
      categories: [id.includes("health") ? "health" : "learning"],
    }),
    duration: createDurationRange({
      expectedMinutes,
      minimumMinutes: splittable ? Math.min(expectedMinutes, 25) : expectedMinutes,
      maximumMinutes: expectedMinutes,
      splittable,
      ...(splittable ? { minimumSessionMinutes: options.minimumSessionMinutes ?? 20 } : {}),
    }),
    cadence: createCadencePolicy({
      period: "week",
      targetCompletions: options.target ?? 3,
      maximumCompletions: options.maximum ?? 4,
      minimumSpacingDays: options.spacing ?? 0,
      prohibitConsecutiveDays: options.prohibitConsecutiveDays,
    }),
    status: options.status,
    now: new Date("2026-07-01T00:00:00.000Z"),
  });
}

function event(
  id: string,
  targetRoutine: Routine,
  type: ActivityEvent["type"],
  date: string,
  referenceEventId?: ReturnType<typeof activityEventId>,
): ActivityEvent {
  return recordActivityEvent({
    id: activityEventId(id),
    workspaceId: workspace,
    routineId: targetRoutine.id,
    type,
    occurredAt: new Date(`${date}T12:00:00.000Z`),
    timeZone: "UTC",
    ...(referenceEventId === undefined ? {} : { referenceEventId }),
    recordedAt: new Date(`${date}T12:01:00.000Z`),
  });
}

function request(
  seed = "2026-07-15:1",
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
    targetMinutes: 90,
    maximumMinutes: 120,
    targetTaskCount: 3,
    maximumTaskCount: 4,
    availableContexts: ["computer"],
    seed,
    ...overrides,
  });
}

describe("deterministic daily planning", () => {
  it("counts completions rather than suggestions and enforces a cadence maximum", () => {
    const study = routine("study", { target: 3, maximum: 3 });
    const suggestions = [
      event("suggested-1", study, "suggested", "2026-07-13"),
      event("suggested-2", study, "suggested", "2026-07-14"),
    ];
    expect(evaluateRoutineForPlan(study, suggestions, request()).periodCompletions).toBe(0);

    const completions = [
      event("completed-1", study, "completed", "2026-07-13"),
      event("completed-2", study, "completed", "2026-07-14"),
      event("completed-3", study, "completed", "2026-07-15"),
    ];
    const evaluation = evaluateRoutineForPlan(study, completions, request());
    expect(evaluation.eligible).toBe(false);
    expect(evaluation.exclusionCodes).toContain("maximum_reached");
  });

  it("heavily lowers weight after a target but keeps the routine eligible below its maximum", () => {
    const satisfied = routine("satisfied", { target: 3, maximum: 4 });
    const neglected = routine("neglected", { target: 3, maximum: 4 });
    const events = [
      event("satisfied-1", satisfied, "completed", "2026-07-13"),
      event("satisfied-2", satisfied, "completed", "2026-07-14"),
      event("satisfied-3", satisfied, "completed", "2026-07-15"),
    ];
    const satisfiedEvaluation = evaluateRoutineForPlan(satisfied, events, request());
    const neglectedEvaluation = evaluateRoutineForPlan(neglected, events, request());

    expect(satisfiedEvaluation.eligible).toBe(true);
    expect(satisfiedEvaluation.targetReached).toBe(true);
    expect(satisfiedEvaluation.score).toBeLessThan(neglectedEvaluation.score);
  });

  it("honors spacing and immutable completion reversals", () => {
    const spaced = routine("spaced", { spacing: 1 });
    const completionId = activityEventId("spaced-completion");
    const completion = event("spaced-completion", spaced, "completed", "2026-07-14");
    const spacedEvaluation = evaluateRoutineForPlan(spaced, [completion], request());
    expect(spacedEvaluation.exclusionCodes).toContain("minimum_spacing");

    const reversal = event(
      "spaced-reversal",
      spaced,
      "completion_reversed",
      "2026-07-15",
      completionId,
    );
    const reversedEvaluation = evaluateRoutineForPlan(spaced, [completion, reversal], request());
    expect(reversedEvaluation.periodCompletions).toBe(0);
    expect(reversedEvaluation.eligible).toBe(true);
  });

  it("orders completion history by preserved local date across time-zone changes", () => {
    const spaced = routine("time-zone-spaced", { spacing: 1 });
    const newerLocalDate = recordActivityEvent({
      id: activityEventId("newer-local-date"),
      workspaceId: workspace,
      routineId: spaced.id,
      type: "completed",
      occurredAt: new Date("2026-07-14T10:00:00.000Z"),
      timeZone: "Pacific/Kiritimati",
      recordedAt: new Date("2026-07-14T10:01:00.000Z"),
    });
    const laterInstantButOlderLocalDate = recordActivityEvent({
      id: activityEventId("later-instant"),
      workspaceId: workspace,
      routineId: spaced.id,
      type: "completed",
      occurredAt: new Date("2026-07-14T20:00:00.000Z"),
      timeZone: "Etc/GMT+12",
      recordedAt: new Date("2026-07-14T20:01:00.000Z"),
    });
    const evaluation = evaluateRoutineForPlan(
      spaced,
      [newerLocalDate, laterInstantButOlderLocalDate],
      request("time-zone-history", { date: "2026-07-16" }),
    );

    expect(newerLocalDate.localDate).toBe("2026-07-15");
    expect(laterInstantButOlderLocalDate.localDate).toBe("2026-07-14");
    expect(evaluation.lastCompletedOn).toBe("2026-07-15");
    expect(evaluation.exclusionCodes).toContain("minimum_spacing");
  });

  it("produces the same plan and hash regardless of input ordering", () => {
    const routines = [
      routine("alpha", { priority: "high" }),
      routine("beta"),
      routine("gamma", { priority: "low" }),
      routine("delta"),
    ];
    const first = generateDailyPlan({
      id: dailyPlanId("stable-plan"),
      request: request("stable-seed"),
      routines,
      events: [],
      generatedAt,
    });
    const second = generateDailyPlan({
      id: dailyPlanId("stable-plan"),
      request: request("stable-seed"),
      routines: [...routines].reverse(),
      events: [],
      generatedAt,
    });

    expect(second).toEqual(first);
  });

  it("rejects duplicate routine snapshots instead of producing duplicate plan items", () => {
    const duplicated = routine("duplicate");
    expect(() =>
      generateDailyPlan({
        request: request("duplicate-seed"),
        routines: [duplicated, duplicated],
        events: [],
        generatedAt,
      }),
    ).toThrowError(DomainError);
  });

  it("regenerates only residual capacity while carrying locked items exactly", () => {
    const routines = [routine("anchor"), routine("second"), routine("alternative")];
    const source = generateDailyPlan({
      id: dailyPlanId("source-regeneration"),
      request: request("source-seed", { targetMinutes: 60, targetTaskCount: 2 }),
      routines,
      events: [],
      generatedAt,
    });
    const anchored = {
      ...source.items[0]!,
      locked: true,
      activityState: "started" as const,
      lastActivityEventId: activityEventId("source-started"),
      activityUpdatedAt: new Date("2026-07-15T08:15:00.000Z"),
    };
    const regenerated = replanDailyPlan({
      id: dailyPlanId("regenerated-plan"),
      sourcePlan: source,
      request: request("regenerated-seed", {
        targetMinutes: 60,
        targetTaskCount: 2,
        requestRevision: 2,
      }),
      routines,
      events: [],
      anchoredItems: [anchored],
      kind: "regenerate",
      generatedAt,
    });

    const retained = regenerated.items.find((item) => item.routineId === anchored.routineId)!;
    expect(retained).toMatchObject({
      position: anchored.position,
      windowIndex: anchored.windowIndex,
      scheduledMinutes: anchored.scheduledMinutes,
      locked: true,
      activityState: "pending",
      lastActivityEventId: null,
      activityUpdatedAt: null,
    });
    expect(retained.id).not.toBe(anchored.id);
    expect(new Set(regenerated.items.map((item) => item.routineId)).size).toBe(
      regenerated.items.length,
    );
    expect(regenerated.inputSnapshot).toMatchObject({
      kind: "regenerate",
      sourcePlanId: source.id,
    });
  });

  it("replaces one item without reshuffling anchored siblings", () => {
    const routines = [routine("replace-me"), routine("keep-me"), routine("replacement")];
    const source = generateDailyPlan({
      id: dailyPlanId("source-replacement"),
      request: request("replace-source", { targetMinutes: 60, targetTaskCount: 2 }),
      routines: routines.slice(0, 2),
      events: [],
      generatedAt,
    });
    const target = source.items[0]!;
    const sibling = source.items[1]!;
    const replaced = replanDailyPlan({
      id: dailyPlanId("replacement-plan"),
      sourcePlan: source,
      request: request("replace-next", {
        targetMinutes: 60,
        targetTaskCount: 2,
        requestRevision: 2,
      }),
      routines,
      events: [],
      anchoredItems: [sibling],
      excludedRoutineIds: [target.routineId],
      kind: "replace",
      generatedAt,
    });

    expect(replaced.items.some((item) => item.routineId === target.routineId)).toBe(false);
    expect(replaced.items.find((item) => item.routineId === sibling.routineId)).toMatchObject({
      position: sibling.position,
      scheduledMinutes: sibling.scheduledMinutes,
    });
    expect(replaced.items).toHaveLength(2);
  });

  it("rejects retained items that no longer fit the requested windows", () => {
    const candidate = routine("too-large", { expectedMinutes: 45 });
    const source = generateDailyPlan({
      id: dailyPlanId("source-infeasible"),
      request: request("wide-window"),
      routines: [candidate],
      events: [],
      generatedAt,
    });
    expect(() =>
      replanDailyPlan({
        sourcePlan: source,
        request: request("narrow-window", {
          requestRevision: 2,
          availableWindows: [
            {
              startsAt: new Date("2026-07-15T08:00:00.000Z"),
              endsAt: new Date("2026-07-15T08:30:00.000Z"),
            },
          ],
        }),
        routines: [candidate],
        events: [],
        anchoredItems: [{ ...source.items[0]!, locked: true }],
        kind: "regenerate",
      }),
    ).toThrowError(DomainError);
  });

  it("preserves original window indices and canonicalizes anchor order", () => {
    const twoWindows = [
      {
        startsAt: new Date("2026-07-15T08:00:00.000Z"),
        endsAt: new Date("2026-07-15T08:30:00.000Z"),
      },
      {
        startsAt: new Date("2026-07-15T09:00:00.000Z"),
        endsAt: new Date("2026-07-15T09:30:00.000Z"),
      },
    ];
    const candidates = [routine("window-anchor"), routine("window-second"), routine("window-new")];
    const source = generateDailyPlan({
      id: dailyPlanId("window-source"),
      request: request("window-source", {
        availableWindows: twoWindows,
        targetMinutes: 60,
        maximumMinutes: 60,
        targetTaskCount: 2,
        maximumTaskCount: 2,
      }),
      routines: candidates.slice(0, 2),
      events: [],
      generatedAt,
    });
    const anchors = source.items.map((item) => ({ ...item, locked: true }));
    const nextRequest = request("window-next", {
      requestRevision: 2,
      availableWindows: twoWindows,
      targetMinutes: 60,
      maximumMinutes: 60,
      targetTaskCount: 2,
      maximumTaskCount: 2,
    });
    const forward = replanDailyPlan({
      id: dailyPlanId("window-result"),
      sourcePlan: source,
      request: nextRequest,
      routines: candidates,
      events: [],
      anchoredItems: anchors,
      kind: "regenerate",
      generatedAt,
    });
    const reversed = replanDailyPlan({
      id: dailyPlanId("window-result"),
      sourcePlan: source,
      request: nextRequest,
      routines: candidates,
      events: [],
      anchoredItems: [...anchors].reverse(),
      kind: "regenerate",
      generatedAt,
    });
    const partial = replanDailyPlan({
      id: dailyPlanId("window-partial"),
      sourcePlan: source,
      request: nextRequest,
      routines: candidates,
      events: [],
      anchoredItems: [anchors.find((item) => item.windowIndex === 0)!],
      kind: "regenerate",
      generatedAt,
    });

    expect(forward.items.map((item) => item.windowIndex)).toEqual([0, 1]);
    expect(partial.items.map((item) => item.windowIndex)).toEqual([0, 1]);
    expect(reversed.inputHash).toBe(forward.inputHash);
  });

  it("rejects fractional custom scoring configuration", () => {
    expect(() =>
      generateDailyPlan({
        request: request("invalid-config"),
        routines: [routine("configured")],
        events: [],
        config: {
          ...DEFAULT_PLANNER_CONFIG,
          score: { ...DEFAULT_PLANNER_CONFIG.score, cadenceDeficit: 1.5 },
        },
        generatedAt,
      }),
    ).toThrowError(DomainError);
  });

  it("fits both the requested time and task count without exceeding hard bounds", () => {
    const plan = generateDailyPlan({
      request: request("fit-seed", {
        targetMinutes: 100,
        maximumMinutes: 120,
        targetTaskCount: 2,
        maximumTaskCount: 3,
      }),
      routines: [
        routine("one", { expectedMinutes: 40 }),
        routine("two", { expectedMinutes: 40 }),
        routine("three", { expectedMinutes: 40 }),
      ],
      events: [],
      generatedAt,
    });

    expect(plan.items).toHaveLength(3);
    expect(plan.totalMinutes).toBe(120);
    expect(plan.warnings).not.toContain("target_minutes_unmet");
    expect(plan.items.map((item) => item.routineId).length).toBe(
      new Set(plan.items.map((item) => item.routineId)).size,
    );
  });

  it("uses a partial session only for a splittable routine", () => {
    const smallWindowRequest = request("split-seed", {
      availableWindows: [
        {
          startsAt: new Date("2026-07-15T08:00:00.000Z"),
          endsAt: new Date("2026-07-15T08:30:00.000Z"),
        },
      ],
      targetMinutes: 30,
      maximumMinutes: 30,
      targetTaskCount: 1,
      maximumTaskCount: 1,
    });
    const solid = routine("solid", { expectedMinutes: 45 });
    const split = routine("split", {
      expectedMinutes: 45,
      splittable: true,
      minimumSessionMinutes: 20,
    });
    const plan = generateDailyPlan({
      request: smallWindowRequest,
      routines: [solid, split],
      events: [],
      generatedAt,
    });

    expect(plan.exclusions.find((item) => item.routineId === solid.id)?.codes).toContain(
      "duration_does_not_fit",
    );
    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]?.routineId).toBe(split.id);
    expect(plan.items[0]?.partialSession).toBe(true);
    expect(plan.items[0]?.scheduledMinutes).toBe(30);
  });

  it("never lets exploration bypass a hard context exclusion", () => {
    const unavailable = routine("errand", { contexts: ["errands"] });
    const plan = generateDailyPlan({
      request: request("context-seed"),
      routines: [unavailable, routine("computer-work", { contexts: ["computer"] })],
      events: [],
      generatedAt,
    });

    expect(plan.items.some((item) => item.routineId === unavailable.id)).toBe(false);
    expect(plan.exclusions[0]?.codes).toContain("context_unavailable");
  });

  it("retains a low but nonzero exploration rate after the cadence target is met", () => {
    const due = routine("due", { target: 1, maximum: 2 });
    const satisfied = routine("already-done", { target: 1, maximum: 2 });
    const events = [event("already-done-completion", satisfied, "completed", "2026-07-14")];
    let satisfiedSelections = 0;
    for (let seed = 0; seed < 300; seed += 1) {
      const plan = generateDailyPlan({
        request: request(`simulation-${seed}`, {
          targetMinutes: 30,
          maximumMinutes: 30,
          targetTaskCount: 1,
          maximumTaskCount: 1,
        }),
        routines: [due, satisfied],
        events,
        generatedAt,
      });
      if (plan.items[0]?.routineId === satisfied.id) satisfiedSelections += 1;
    }

    expect(satisfiedSelections).toBeGreaterThan(0);
    expect(satisfiedSelections).toBeLessThan(30);
  });
});
