import { describe, expect, it } from "vitest";

import {
  createCadencePolicy,
  createDailyPlanningRequest,
  createDurationRange,
  createRoutine,
  createStructuredTags,
  createWorkItem,
  createWorkspace,
  dailyPlanId,
  generateDailyPlan,
  planItemId,
  routineId,
  workItemId,
  workspaceId,
  type DailyPlan,
  type PlanWarning,
  type WorkItem,
} from "@schedule/domain";

import {
  GetSchedulingAdvice,
  SCHEDULING_ADVICE_VERSION,
  SCHEDULING_ADVISOR_OUTPUT_VERSION,
  type SchedulingAdvisor,
  type SchedulingAdvisorContext,
  type SchedulingAdvisorProviderResult,
  type SchedulingAdvisorSuggestion,
} from "./get-scheduling-advice.js";
import type { TransactionContext, UnitOfWork } from "./ports.js";

const workspace = createWorkspace({
  id: workspaceId("advisor-workspace"),
  name: "Private workspace name",
  now: new Date("2026-07-13T00:00:00.000Z"),
});
const otherWorkspace = workspaceId("advisor-other-workspace");
const routine = createRoutine({
  id: routineId("advisor-routine"),
  workspaceId: workspace.id,
  title: "Base routine",
  tags: createStructuredTags(),
  duration: createDurationRange({ expectedMinutes: 30 }),
  cadence: createCadencePolicy({ period: "week" }),
  now: new Date("2026-07-13T00:00:00.000Z"),
});
const planningRequest = createDailyPlanningRequest({
  workspaceId: workspace.id,
  date: "2026-07-15",
  timeZone: "UTC",
  availableWindows: [
    {
      startsAt: new Date("2026-07-15T09:00:00.000Z"),
      endsAt: new Date("2026-07-15T10:00:00.000Z"),
    },
  ],
  targetMinutes: 30,
  targetTaskCount: 1,
  seed: "advisor-plan",
});
const generatedPlan = generateDailyPlan({
  id: dailyPlanId("advisor-plan"),
  request: planningRequest,
  routines: [routine],
  events: [],
  generatedAt: new Date("2026-07-15T08:00:00.000Z"),
});
const generatedItem = generatedPlan.items[0];
if (generatedItem === undefined) throw new Error("The advisor test fixture needs one plan item.");

const basePlan: DailyPlan = {
  ...generatedPlan,
  items: [
    {
      ...generatedItem,
      id: planItemId("advisor-plan-item"),
      title: "Plan item",
      position: 0,
      reasons: ["Useful today"],
    },
  ],
};

const backlogItem = createWorkItem({
  id: workItemId("advisor-backlog-item"),
  workspaceId: workspace.id,
  title: "Backlog item",
  description: "A description that must never leave the application boundary.",
  priority: "high",
  dueOn: "2026-07-16",
  planningDurationMinutes: 45,
  now: new Date("2026-07-13T00:00:00.000Z"),
});

const command = {
  version: SCHEDULING_ADVICE_VERSION,
  requestId: "123e4567-e89b-42d3-a456-426614174000",
  workspaceId: workspace.id,
  date: planningRequest.date,
  focus: "both" as const,
  expectedPlanId: basePlan.id,
  expectedHeadVersion: 3,
};

function observationOutput(summary = "Keep the plan focused."): SchedulingAdvisorProviderResult {
  return {
    status: "available",
    output: {
      version: SCHEDULING_ADVISOR_OUTPUT_VERSION,
      summary,
      suggestions: [
        {
          kind: "plan_observation",
          targetType: null,
          targetId: null,
          title: "Protect the first block",
          rationale: "The current plan already fits the available time.",
          confidence: "medium",
        },
      ],
    },
  };
}

interface HarnessOptions {
  readonly plan?: DailyPlan | null;
  readonly backlog?: readonly WorkItem[];
  readonly provider?: string;
  readonly model?: string | null;
  readonly workspaceExists?: boolean;
}

function harness(options: HarnessOptions = {}) {
  let currentPlan = options.plan === undefined ? basePlan : options.plan;
  let headVersion = 3;
  let backlog = [...(options.backlog ?? [backlogItem])];
  let workspaceExists = options.workspaceExists ?? true;
  let providerImplementation = async (_context: SchedulingAdvisorContext) => observationOutput();
  const events: string[] = [];
  const contexts: SchedulingAdvisorContext[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  let runCount = 0;

  const transaction = {
    workspaces: {
      findById: async () => (workspaceExists ? workspace : null),
      list: async () => [],
      insert: async () => undefined,
    },
    dailyPlans: {
      findById: async () => currentPlan,
      findByRevision: async () => currentPlan,
      insertForRevision: async (plan: DailyPlan) => plan,
      findCurrent: async () => (currentPlan === null ? null : { plan: currentPlan, headVersion }),
      setItemLock: async () => {
        throw new Error("not used");
      },
      recordItemActivity: async () => {
        throw new Error("not used");
      },
      lockDay: async () => undefined,
      findMutation: async () => null,
      insertMutation: async () => undefined,
      listRoutineFeedbackForPlanning: async () => [],
      lockRoutineFeedback: async () => undefined,
      findLatestRoutineFeedback: async () => null,
      appendRoutineFeedback: async (feedback) => feedback,
    },
    workItems: {
      listPlanningCandidates: async () => backlog,
    } as TransactionContext["workItems"],
    routines: {} as TransactionContext["routines"],
    scheduleBlocks: {} as TransactionContext["scheduleBlocks"],
    auditEvents: {} as TransactionContext["auditEvents"],
    activityEvents: {} as TransactionContext["activityEvents"],
    routineDurationInsightFeedback: {} as TransactionContext["routineDurationInsightFeedback"],
  } satisfies TransactionContext;
  const unitOfWork: UnitOfWork = {
    run: async (operation) => {
      runCount += 1;
      events.push(`uow-${runCount}:start`);
      try {
        return await operation(transaction);
      } finally {
        events.push(`uow-${runCount}:end`);
      }
    },
  };
  const advisor: SchedulingAdvisor = {
    provider: options.provider ?? "ollama",
    model: options.model === undefined ? "gemma4:e4b" : options.model,
    advise: async (context, signal) => {
      events.push("advisor:start");
      contexts.push(context);
      signals.push(signal);
      const result = await providerImplementation(context);
      events.push("advisor:end");
      return result;
    },
  };
  const clockValues = [new Date("2026-07-15T08:30:00.000Z"), new Date("2026-07-15T08:30:00.125Z")];
  const useCase = new GetSchedulingAdvice(unitOfWork, advisor, {
    now: () => new Date(clockValues.shift() ?? "2026-07-15T08:30:00.125Z"),
  });

  return {
    useCase,
    contexts,
    events,
    signals,
    runCount: () => runCount,
    setProviderImplementation: (
      implementation: (
        context: SchedulingAdvisorContext,
      ) => Promise<SchedulingAdvisorProviderResult>,
    ) => {
      providerImplementation = implementation;
    },
    setPlan: (plan: DailyPlan | null) => {
      currentPlan = plan;
    },
    setHeadVersion: (value: number) => {
      headVersion = value;
    },
    setBacklog: (items: readonly WorkItem[]) => {
      backlog = [...items];
    },
    removeWorkspace: () => {
      workspaceExists = false;
    },
  };
}

describe("GetSchedulingAdvice", () => {
  it("builds a sanitized, minimal snapshot and calls the provider outside both transactions", async () => {
    const selectedWorkItem = createWorkItem({
      id: workItemId("selected-work-item"),
      workspaceId: workspace.id,
      title: "Already selected",
      planningDurationMinutes: 30,
    });
    const externalWorkItem = createWorkItem({
      id: workItemId("external-work-item"),
      workspaceId: otherWorkspace,
      title: "Other workspace secret",
      description: "Do not leak this either.",
      planningDurationMinutes: 30,
    });
    const hostilePlan: DailyPlan = {
      ...basePlan,
      warnings: ["target_minutes_unmet\u202e\u0000"] as unknown as readonly PlanWarning[],
      items: [
        {
          ...basePlan.items[0]!,
          title: "  Cafe\u0301\u202E \u0000 task   ",
          reasons: ["  First\t reason ", "Second\u2066 reason", "third", "dropped"],
        },
        {
          ...basePlan.items[0]!,
          id: planItemId("selected-plan-item"),
          position: 1,
          sourceType: "work_item",
          routineId: null,
          workItemId: selectedWorkItem.id,
          title: selectedWorkItem.title,
        },
      ],
      totalMinutes: 60,
    };
    const test = harness({
      plan: hostilePlan,
      backlog: [selectedWorkItem, externalWorkItem, backlogItem],
    });
    test.setProviderImplementation(async (context) => ({
      status: "available",
      output: {
        version: SCHEDULING_ADVISOR_OUTPUT_VERSION,
        summary: "Start with the first plan item.",
        suggestions: [
          {
            kind: "focus",
            targetType: "plan_item",
            targetId: context.plan.items[0]!.id,
            title: "Start here",
            rationale: "It is already first in the current plan.",
            confidence: "medium",
          },
          {
            kind: "consider_backlog",
            targetType: "work_item",
            targetId: context.backlog[0]!.id,
            title: "Keep this nearby",
            rationale: "It is the highest-priority eligible backlog item.",
            confidence: "low",
          },
        ],
      },
    }));

    const result = await test.useCase.execute({ ...command, expectedPlanId: hostilePlan.id });

    expect(test.events).toEqual([
      "uow-1:start",
      "uow-1:end",
      "advisor:start",
      "advisor:end",
      "uow-2:start",
      "uow-2:end",
    ]);
    expect(test.contexts[0]).toMatchObject({
      version: "schedule.advisor-context/v1",
      plan: {
        warnings: ["target_minutes_unmet"],
      },
      backlog: [{ id: backlogItem.id }],
    });
    expect(test.contexts[0]?.plan.items[0]).toMatchObject({
      title: "Café task",
      reasons: ["First reason", "Second reason", "third"],
    });
    const serializedContext = JSON.stringify(test.contexts[0]);
    expect(serializedContext).not.toContain("Private workspace name");
    expect(serializedContext).not.toContain("description");
    expect(serializedContext).not.toContain("Other workspace secret");
    expect(serializedContext).not.toContain(selectedWorkItem.id);
    expect(result).toMatchObject({
      status: "available",
      reason: null,
      input: { planItemCount: 2, backlogCount: 1 },
      provenance: { provider: "ollama", model: "gemma4:e4b", latencyMs: 125 },
      summary: "Start with the first plan item.",
    });
    expect(result.suggestions.map((suggestion) => suggestion.id)).toEqual(["advice-1", "advice-2"]);
  });

  it("returns deterministic unavailability without opening a verification transaction", async () => {
    const test = harness({ provider: "disabled", model: null });
    test.setProviderImplementation(async () => ({ status: "unavailable", reason: "disabled" }));

    const result = await test.useCase.execute(command);

    expect(test.runCount()).toBe(1);
    expect(result).toMatchObject({
      status: "unavailable",
      reason: "disabled",
      summary: null,
      suggestions: [],
      provenance: { provider: "disabled", model: null },
    });
  });

  it("contains provider exceptions as unreachable unavailability", async () => {
    const test = harness();
    test.setProviderImplementation(async () => {
      throw new Error("raw provider detail must not escape");
    });

    await expect(test.useCase.execute(command)).resolves.toMatchObject({
      status: "unavailable",
      reason: "unreachable",
    });
    expect(test.runCount()).toBe(1);
  });

  it("rejects stale expected identity before consulting the provider", async () => {
    const test = harness();

    await expect(
      test.useCase.execute({ ...command, expectedHeadVersion: 2 }),
    ).rejects.toMatchObject({ code: "advisor.snapshot_conflict" });
    expect(test.contexts).toHaveLength(0);
  });

  it("discards advice when the current plan changes during inference", async () => {
    const test = harness();
    test.setProviderImplementation(async () => {
      test.setHeadVersion(4);
      return observationOutput();
    });

    await expect(test.useCase.execute(command)).rejects.toMatchObject({
      code: "advisor.snapshot_conflict",
    });
    expect(test.runCount()).toBe(2);
  });

  it("detects eligible-backlog changes even when plan identity stays unchanged", async () => {
    const test = harness();
    test.setProviderImplementation(async () => {
      test.setBacklog([
        {
          ...backlogItem,
          title: "Changed while the model was working",
          version: backlogItem.version + 1,
        },
      ]);
      return observationOutput();
    });

    await expect(test.useCase.execute(command)).rejects.toMatchObject({
      code: "advisor.snapshot_conflict",
    });
  });

  it.each([
    {
      name: "unknown plan-item target",
      suggestion: {
        kind: "focus",
        targetType: "plan_item",
        targetId: "not-in-the-plan",
        title: "Unknown",
        rationale: "This ID was not supplied.",
        confidence: "low",
      },
    },
    {
      name: "backlog kind targeting a plan item",
      suggestion: {
        kind: "consider_backlog",
        targetType: "plan_item",
        targetId: basePlan.items[0]!.id,
        title: "Wrong relation",
        rationale: "The target type does not match the kind.",
        confidence: "medium",
      },
    },
    {
      name: "targeted plan observation",
      suggestion: {
        kind: "plan_observation",
        targetType: "plan_item",
        targetId: basePlan.items[0]!.id,
        title: "Wrong relation",
        rationale: "Observations cannot target an item.",
        confidence: "low",
      },
    },
  ])("turns invalid advice into safe unavailability: $name", async ({ suggestion }) => {
    const test = harness();
    test.setProviderImplementation(async () => ({
      status: "available",
      output: {
        version: SCHEDULING_ADVISOR_OUTPUT_VERSION,
        summary: "Invalid provider output.",
        suggestions: [suggestion as SchedulingAdvisorSuggestion],
      },
    }));

    await expect(test.useCase.execute(command)).resolves.toMatchObject({
      status: "unavailable",
      reason: "invalid_advice",
      suggestions: [],
    });
    expect(test.runCount()).toBe(1);
  });

  it("rejects duplicate, oversized, and structurally extended suggestions", async () => {
    const validSuggestion: SchedulingAdvisorSuggestion = {
      kind: "plan_observation",
      targetType: null,
      targetId: null,
      title: "One observation",
      rationale: "One rationale.",
      confidence: "low",
    };
    const invalidOutputs: readonly unknown[] = [
      { ...observationOutput(), output: { ...observationOutput().output, extra: true } },
      {
        status: "available",
        output: {
          version: SCHEDULING_ADVISOR_OUTPUT_VERSION,
          summary: "Duplicates.",
          suggestions: [validSuggestion, validSuggestion],
        },
      },
      {
        status: "available",
        output: {
          version: SCHEDULING_ADVISOR_OUTPUT_VERSION,
          summary: "Too many.",
          suggestions: Array.from({ length: 6 }, (_, index) => ({
            ...validSuggestion,
            title: `Observation ${index}`,
          })),
        },
      },
      {
        status: "available",
        output: {
          version: SCHEDULING_ADVISOR_OUTPUT_VERSION,
          summary: "Unknown key.",
          suggestions: [{ ...validSuggestion, action: "apply" }],
        },
      },
    ];

    for (const invalidOutput of invalidOutputs) {
      const test = harness();
      test.setProviderImplementation(async () => invalidOutput as SchedulingAdvisorProviderResult);
      const result = await test.useCase.execute(command);
      expect(result.status).toBe("unavailable");
      expect(["malformed_response", "invalid_advice"]).toContain(result.reason);
      expect(test.runCount()).toBe(1);
    }
  });

  it("deterministically truncates plan and backlog inputs to fifty entries", async () => {
    const manyItems = Array.from({ length: 51 }, (_, index) => ({
      ...basePlan.items[0]!,
      id: planItemId(`advisor-plan-item-${String(index).padStart(2, "0")}`),
      position: index,
      title: `Plan item ${index}`,
    }));
    const manyBacklogItems = Array.from({ length: 51 }, (_, index) =>
      createWorkItem({
        id: workItemId(`advisor-backlog-${String(index).padStart(2, "0")}`),
        workspaceId: workspace.id,
        title: `Backlog item ${index}`,
        priority: "low",
        planningDurationMinutes: 30,
      }),
    );
    const plan = { ...basePlan, items: manyItems, totalMinutes: 1_530 };
    const test = harness({ plan, backlog: manyBacklogItems });

    const result = await test.useCase.execute({ ...command, expectedPlanId: plan.id });

    expect(test.contexts[0]?.plan.items).toHaveLength(50);
    expect(test.contexts[0]?.backlog).toHaveLength(50);
    expect(result.input).toEqual({
      planItemCount: 50,
      backlogCount: 50,
      truncated: { planItems: true, backlog: true },
    });
  });

  it("fails closed when the bounded aggregate context still exceeds 64 KiB", async () => {
    const longIdentifier = (prefix: string, index: number) =>
      `${prefix}-${String(index).padStart(3, "0")}-${"x".repeat(119)}`.slice(0, 128);
    const longPlanItems = Array.from({ length: 50 }, (_, index) => ({
      ...basePlan.items[0]!,
      id: planItemId(longIdentifier("p", index)),
      position: index,
      title: "t".repeat(240),
      reasons: ["a".repeat(160), "b".repeat(160), "c".repeat(160)],
    }));
    const longBacklog = Array.from({ length: 50 }, (_, index) =>
      createWorkItem({
        id: workItemId(longIdentifier("w", index)),
        workspaceId: workspace.id,
        title: "z".repeat(240),
        priority: "medium",
        planningDurationMinutes: 30,
      }),
    );
    const plan = { ...basePlan, items: longPlanItems, totalMinutes: 1_500 };
    const test = harness({ plan, backlog: longBacklog });

    await expect(
      test.useCase.execute({ ...command, expectedPlanId: plan.id }),
    ).rejects.toMatchObject({ code: "advisor.context_too_large" });
    expect(test.contexts).toHaveLength(0);
  });

  it("validates the request before opening a transaction", async () => {
    const test = harness();

    await expect(
      test.useCase.execute({ ...command, requestId: "not-a-uuid" }),
    ).rejects.toMatchObject({ code: "advisor.request_invalid" });
    expect(test.runCount()).toBe(0);
  });

  it("restricts version 1 to combined plan-and-backlog review", async () => {
    for (const focus of ["today", "backlog"] as const) {
      const test = harness();

      await expect(
        test.useCase.execute({ ...command, focus: focus as "both" }),
      ).rejects.toMatchObject({ code: "advisor.request_invalid" });
      expect(test.runCount()).toBe(0);
    }
  });

  it("preserves exact request correlation and passes cancellation to the provider", async () => {
    const test = harness();
    const controller = new AbortController();
    const requestId = command.requestId.toUpperCase();

    const result = await test.useCase.execute({ ...command, requestId }, controller.signal);

    expect(test.contexts[0]?.requestId).toBe(requestId);
    expect(test.signals).toEqual([controller.signal]);
    expect(result.requestId).toBe(requestId);
  });

  it("distinguishes missing workspace and current-plan failures", async () => {
    const missingWorkspace = harness({ workspaceExists: false });
    await expect(missingWorkspace.useCase.execute(command)).rejects.toMatchObject({
      code: "workspace.not_found",
    });

    const missingPlan = harness({ plan: null });
    await expect(missingPlan.useCase.execute(command)).rejects.toMatchObject({
      code: "planning.current_not_found",
    });
  });

  it("maps a malformed provider envelope to safe unavailability", async () => {
    const test = harness({ provider: "surprising-provider\u202e", model: " model\u0000name " });
    test.setProviderImplementation(
      async () => ({ status: "unavailable", reason: "timeout", debug: "secret" }) as never,
    );

    await expect(test.useCase.execute(command)).resolves.toMatchObject({
      status: "unavailable",
      reason: "malformed_response",
      provenance: { provider: "unknown", model: "model name" },
    });
  });
});
