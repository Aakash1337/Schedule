import { describe, expect, it } from "vitest";

import {
  createDailyPlanningRequest,
  createWorkItem,
  createWorkItemDependency,
  dailyPlanId,
  evaluateWorkItemForPlan,
  generateDailyPlan,
  replanDailyPlan,
  workItemId,
  workspaceId,
  type PlanningWorkItemDependency,
  type WorkItem,
  type WorkItemStatus,
} from "./index.js";

const workspace = workspaceId("work-item-dependency-workspace");
const otherWorkspace = workspaceId("work-item-dependency-other-workspace");
const createdAt = new Date("2026-07-01T00:00:00.000Z");

function workItem(
  id: string,
  options: {
    readonly workspaceId?: ReturnType<typeof workspaceId>;
    readonly status?: WorkItemStatus;
    readonly planningDurationMinutes?: number | null;
  } = {},
): WorkItem {
  return createWorkItem({
    id: workItemId(id),
    workspaceId: options.workspaceId ?? workspace,
    title: id,
    status: options.status,
    priority: "high",
    planningDurationMinutes:
      options.planningDurationMinutes === undefined ? 20 : options.planningDurationMinutes,
    now: createdAt,
  });
}

function request(revision = 1) {
  return createDailyPlanningRequest({
    workspaceId: workspace,
    date: "2026-07-15",
    timeZone: "UTC",
    availableWindows: [
      {
        startsAt: new Date("2026-07-15T09:00:00.000Z"),
        endsAt: new Date("2026-07-15T10:00:00.000Z"),
      },
    ],
    targetMinutes: 20,
    maximumMinutes: 60,
    targetTaskCount: 1,
    maximumTaskCount: 3,
    seed: "work-item-dependencies",
    requestRevision: revision,
  });
}

function dependency(
  prerequisiteWorkItemId: string,
  dependentWorkItemId: string,
  prerequisiteStatus: WorkItemStatus,
  overrides: Partial<PlanningWorkItemDependency> = {},
): PlanningWorkItemDependency {
  return {
    workspaceId: workspace,
    prerequisiteWorkItemId: workItemId(prerequisiteWorkItemId),
    dependentWorkItemId: workItemId(dependentWorkItemId),
    prerequisiteStatus,
    createdAt,
    ...overrides,
  };
}

describe("work item dependencies", () => {
  it("creates a tenant-scoped directed edge and copies its timestamp", () => {
    const timestamp = new Date("2026-07-14T12:00:00.000Z");
    const result = createWorkItemDependency({
      workspaceId: workspace,
      prerequisiteWorkItemId: workItemId("prerequisite"),
      dependentWorkItemId: workItemId("dependent"),
      createdAt: timestamp,
    });
    timestamp.setUTCFullYear(2030);

    expect(result).toMatchObject({
      workspaceId: workspace,
      prerequisiteWorkItemId: "prerequisite",
      dependentWorkItemId: "dependent",
    });
    expect(result.createdAt.toISOString()).toBe("2026-07-14T12:00:00.000Z");
    expect(result.createdAt).not.toBe(timestamp);
  });

  it("rejects self references and invalid timestamps with stable errors", () => {
    expect(() =>
      createWorkItemDependency({
        workspaceId: workspace,
        prerequisiteWorkItemId: workItemId("same"),
        dependentWorkItemId: workItemId("same"),
        createdAt,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "work_item_dependency.self_reference_invalid" }),
    );
    expect(() =>
      createWorkItemDependency({
        workspaceId: workspace,
        prerequisiteWorkItemId: workItemId("prerequisite"),
        dependentWorkItemId: workItemId("dependent"),
        createdAt: new Date("invalid"),
      }),
    ).toThrowError(expect.objectContaining({ code: "work_item_dependency.timestamp_invalid" }));
  });

  it("rejects mixed-case spellings of one PostgreSQL UUID without folding arbitrary IDs", () => {
    expect(() =>
      createWorkItemDependency({
        workspaceId: workspace,
        prerequisiteWorkItemId: workItemId("A0B1C2D3-E4F5-4678-9ABC-DEF012345678"),
        dependentWorkItemId: workItemId("a0b1c2d3-e4f5-4678-9abc-def012345678"),
        createdAt,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "work_item_dependency.self_reference_invalid" }),
    );
    expect(() =>
      createWorkItemDependency({
        workspaceId: workspace,
        prerequisiteWorkItemId: workItemId("Arbitrary-Test-Id"),
        dependentWorkItemId: workItemId("arbitrary-test-id"),
        createdAt,
      }),
    ).not.toThrow();
  });

  it.each([
    ["backlog", false],
    ["planned", false],
    ["in_progress", false],
    ["blocked", false],
    ["done", true],
    ["cancelled", false],
  ] as const)("treats prerequisite status %s as satisfied=%s", (status, satisfied) => {
    const dependent = workItem(`status-dependent-${status}`);
    const evaluation = evaluateWorkItemForPlan(dependent, request(), undefined, [
      dependency(`status-prerequisite-${status}`, dependent.id, status),
    ]);

    expect(evaluation.eligible).toBe(satisfied);
    expect(evaluation.exclusionCodes.includes("work_item_dependency_unsatisfied")).toBe(!satisfied);
  });

  it("requires every direct prerequisite to be done", () => {
    const dependent = workItem("multiple-dependent");
    const allDone = [
      dependency("multiple-a", dependent.id, "done"),
      dependency("multiple-b", dependent.id, "done"),
      dependency("unrelated-prerequisite", "unrelated-dependent", "blocked"),
    ];
    const oneBlocked = [
      allDone[0]!,
      dependency("multiple-b", dependent.id, "blocked"),
      allDone[2]!,
    ];

    expect(evaluateWorkItemForPlan(dependent, request(), undefined, allDone)).toMatchObject({
      eligible: true,
      exclusionCodes: [],
    });
    expect(evaluateWorkItemForPlan(dependent, request(), undefined, oneBlocked)).toMatchObject({
      eligible: false,
      exclusionCodes: ["work_item_dependency_unsatisfied"],
    });
  });

  it("allows prerequisite rows outside the candidate list and snapshots them canonically", () => {
    const dependent = workItem("canonical-dependent");
    const first = dependency("canonical-b", dependent.id, "done", {
      createdAt: new Date("2026-07-02T00:00:00.000Z"),
    });
    const second = dependency("canonical-a", dependent.id, "done", {
      createdAt: new Date("2026-07-03T00:00:00.000Z"),
    });
    const base = {
      id: dailyPlanId("canonical-dependency-plan"),
      request: request(),
      routines: [],
      workItems: [dependent],
      events: [],
    } as const;
    const forward = generateDailyPlan({ ...base, workItemDependencies: [first, second] });
    const reverse = generateDailyPlan({ ...base, workItemDependencies: [second, first] });

    expect(reverse.inputHash).toBe(forward.inputHash);
    expect(reverse.items).toEqual(forward.items);
    expect(forward.inputSnapshot).toMatchObject({
      workItemDependencies: [
        { prerequisiteWorkItemId: "canonical-a", dependentWorkItemId: dependent.id },
        { prerequisiteWorkItemId: "canonical-b", dependentWorkItemId: dependent.id },
      ],
    });

    const changedStatus = generateDailyPlan({
      ...base,
      workItemDependencies: [first, { ...second, prerequisiteStatus: "blocked" }],
    });
    expect(changedStatus.inputHash).not.toBe(forward.inputHash);
    expect(changedStatus.items).toHaveLength(0);
    expect(changedStatus.exclusions).toContainEqual(
      expect.objectContaining({
        workItemId: dependent.id,
        codes: ["work_item_dependency_unsatisfied"],
      }),
    );
  });

  it.each([
    [
      "tenant mismatch",
      [
        dependency("invalid-prerequisite", "invalid-dependent", "done", {
          workspaceId: otherWorkspace,
        }),
      ],
      [workItem("invalid-dependent")],
      "planning.work_item_dependency_workspace_mismatch",
    ],
    [
      "missing dependent",
      [dependency("invalid-prerequisite", "missing-dependent", "done")],
      [workItem("different-dependent")],
      "planning.work_item_dependency_reference_invalid",
    ],
    [
      "cross-tenant dependent reference",
      [dependency("invalid-prerequisite", "cross-tenant-dependent", "done")],
      [workItem("cross-tenant-dependent", { workspaceId: otherWorkspace })],
      "planning.work_item_dependency_reference_invalid",
    ],
    [
      "self reference",
      [dependency("invalid-self", "invalid-self", "done")],
      [workItem("invalid-self")],
      "work_item_dependency.self_reference_invalid",
    ],
    [
      "invalid status",
      [
        dependency("invalid-prerequisite", "invalid-dependent", "done", {
          prerequisiteStatus: "unknown" as never,
        }),
      ],
      [workItem("invalid-dependent")],
      "planning.work_item_dependency_status_invalid",
    ],
    [
      "invalid timestamp",
      [
        dependency("invalid-prerequisite", "invalid-dependent", "done", {
          createdAt: new Date("invalid"),
        }),
      ],
      [workItem("invalid-dependent")],
      "work_item_dependency.timestamp_invalid",
    ],
    [
      "record shape",
      [null as never],
      [workItem("invalid-dependent")],
      "planning.work_item_dependency_invalid",
    ],
  ])("rejects malformed %s dependency state", (_label, dependencies, workItems, code) => {
    expect(() =>
      generateDailyPlan({
        request: request(),
        routines: [],
        workItems,
        workItemDependencies: dependencies,
        events: [],
      }),
    ).toThrowError(expect.objectContaining({ code }));
  });

  it("rejects duplicate edges and contradictory candidate status snapshots", () => {
    const prerequisite = workItem("conflict-prerequisite", { status: "done" });
    const dependent = workItem("conflict-dependent");
    const edge = dependency(prerequisite.id, dependent.id, "done");
    const input = {
      request: request(),
      routines: [],
      workItems: [prerequisite, dependent],
      events: [],
    } as const;

    expect(() =>
      generateDailyPlan({ ...input, workItemDependencies: [edge, { ...edge }] }),
    ).toThrowError(expect.objectContaining({ code: "planning.duplicate_work_item_dependency" }));
    expect(() =>
      generateDailyPlan({
        ...input,
        workItemDependencies: [{ ...edge, prerequisiteStatus: "blocked" }],
      }),
    ).toThrowError(
      expect.objectContaining({ code: "planning.work_item_dependency_status_conflict" }),
    );
  });

  it("passes dependency state through replanning while retaining anchored items", () => {
    const dependent = workItem("replan-dependent");
    const source = generateDailyPlan({
      id: dailyPlanId("dependency-replan-source"),
      request: request(),
      routines: [],
      workItems: [dependent],
      events: [],
    });
    const blocked = dependency("replan-prerequisite", dependent.id, "blocked");
    const unanchored = replanDailyPlan({
      sourcePlan: source,
      request: request(2),
      anchoredItems: [],
      routines: [],
      workItems: [dependent],
      workItemDependencies: [blocked],
      events: [],
      kind: "regenerate",
    });
    const anchored = replanDailyPlan({
      sourcePlan: source,
      request: request(2),
      anchoredItems: [source.items[0]!],
      routines: [],
      workItems: [dependent],
      workItemDependencies: [blocked],
      events: [],
      kind: "regenerate",
    });

    expect(unanchored.items).toHaveLength(0);
    expect(unanchored.exclusions).toContainEqual(
      expect.objectContaining({
        workItemId: dependent.id,
        codes: ["work_item_dependency_unsatisfied"],
      }),
    );
    expect(anchored.items).toHaveLength(1);
    expect(anchored.items[0]).toMatchObject({ workItemId: dependent.id, position: 0 });
    expect(anchored.inputSnapshot).toMatchObject({
      workItemDependencies: [
        expect.objectContaining({
          prerequisiteWorkItemId: "replan-prerequisite",
          dependentWorkItemId: dependent.id,
          prerequisiteStatus: "blocked",
        }),
      ],
      plannerInput: { workItemDependencies: [] },
    });
  });
});
