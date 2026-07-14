import { describe, expect, it } from "vitest";

import type {
  SchedulingAdvisor,
  SchedulingAdvisorContext,
  TransactionContext,
  UnitOfWork,
  Workspace,
} from "@schedule/application";
import {
  activityEventId,
  calculateRoutineDurationInsight,
  createCadencePolicy,
  createDailyPlanningRequest,
  createDurationRange,
  createRoutine,
  createStructuredTags,
  createWorkspace,
  dailyPlanId,
  generateDailyPlan,
  localDate,
  recordActivityEvent,
  routineId,
  scheduleBlockId,
  workItemId,
  workspaceId,
  type RoutineDurationInsightFeedback,
} from "@schedule/domain";

import { createProductServices } from "./product-services.js";

describe("createProductServices", () => {
  it("exposes the complete product handler surface and delegates workspace creation", async () => {
    const inserted: Workspace[] = [];
    const context = {
      workspaces: {
        findById: async () => null,
        list: async () => [],
        insert: async (workspace: Workspace) => {
          inserted.push(workspace);
        },
      },
    } as TransactionContext;
    const unitOfWork: UnitOfWork = {
      run: async (operation) => operation(context),
    };
    const services = createProductServices(unitOfWork, {
      now: () => new Date("2026-07-15T12:00:00.000Z"),
    });

    expect(Object.keys(services).sort()).toEqual([
      "applyRoutineFeedback",
      "approveRoutineDurationInsight",
      "createRoutine",
      "createScheduleBlock",
      "createWorkItem",
      "createWorkspace",
      "deleteScheduleBlock",
      "dismissRoutineDurationInsight",
      "generateDailyPlan",
      "getCurrentDailyPlan",
      "getDailyPlan",
      "getRoutine",
      "getRoutineDurationInsight",
      "getScheduleBlock",
      "getSchedulingAdvice",
      "getWorkItem",
      "getWorkspace",
      "listRoutineActivity",
      "listRoutines",
      "listScheduleBlocks",
      "listWorkItems",
      "listWorkspaces",
      "recordActivityEvent",
      "recordPlanItemActivity",
      "regenerateDailyPlan",
      "replacePlanItem",
      "resetRoutineDurationInsightDismissal",
      "resetRoutineFeedback",
      "setPlanItemLock",
      "updateRoutine",
      "updateScheduleBlock",
      "updateWorkItem",
    ]);

    const created = await services.createWorkspace({ name: "  Local workspace  " });

    expect(created).toMatchObject({ name: "Local workspace" });
    expect(created.createdAt).toEqual(new Date("2026-07-15T12:00:00.000Z"));
    expect(inserted).toEqual([created]);

    const missingWorkspace = workspaceId("missing-workspace");
    await expect(services.listWorkspaces({ limit: 10, offset: 0 })).resolves.toMatchObject({
      items: [],
    });
    await Promise.all([
      expect(
        services.approveRoutineDurationInsight({
          workspaceId: missingWorkspace,
          routineId: routineId("missing-routine-duration-approval"),
          expectedVersion: 1,
          duration: {
            expectedMinutes: 30,
            minimumMinutes: 30,
            maximumMinutes: 30,
            splittable: false,
            minimumSessionMinutes: null,
            overheadMinutes: 0,
          },
        }),
      ).rejects.toMatchObject({ code: "workspace.not_found" }),
      expect(
        services.dismissRoutineDurationInsight({
          workspaceId: missingWorkspace,
          routineId: routineId("missing-routine-duration-dismissal"),
          expectedVersion: 1,
          insightKey: "a".repeat(64),
          idempotencyKey: "missing-duration-dismissal",
        }),
      ).rejects.toMatchObject({ code: "workspace.not_found" }),
      expect(services.getWorkspace({ workspaceId: missingWorkspace })).rejects.toMatchObject({
        code: "workspace.not_found",
      }),
      expect(
        services.getRoutine({
          workspaceId: missingWorkspace,
          routineId: routineId("missing-routine"),
        }),
      ).rejects.toMatchObject({ code: "workspace.not_found" }),
      expect(
        services.getRoutineDurationInsight({
          workspaceId: missingWorkspace,
          routineId: routineId("missing-routine-duration-insight"),
        }),
      ).rejects.toMatchObject({ code: "workspace.not_found" }),
      expect(
        services.resetRoutineDurationInsightDismissal({
          workspaceId: missingWorkspace,
          routineId: routineId("missing-routine-duration-dismissal-reset"),
          expectedVersion: 1,
          insightKey: "b".repeat(64),
          idempotencyKey: "missing-duration-dismissal-reset",
        }),
      ).rejects.toMatchObject({ code: "workspace.not_found" }),
      expect(
        services.listRoutines({ workspaceId: missingWorkspace, limit: 10, offset: 0 }),
      ).rejects.toMatchObject({
        code: "workspace.not_found",
      }),
      expect(
        services.getWorkItem({
          workspaceId: missingWorkspace,
          workItemId: workItemId("missing-work"),
        }),
      ).rejects.toMatchObject({ code: "workspace.not_found" }),
      expect(
        services.listWorkItems({ workspaceId: missingWorkspace, limit: 10, offset: 0 }),
      ).rejects.toMatchObject({ code: "workspace.not_found" }),
      expect(
        services.getScheduleBlock({
          workspaceId: missingWorkspace,
          scheduleBlockId: scheduleBlockId("missing-block"),
        }),
      ).rejects.toMatchObject({ code: "workspace.not_found" }),
      expect(
        services.listScheduleBlocks({
          workspaceId: missingWorkspace,
          from: new Date("2026-07-15T00:00:00.000Z"),
          to: new Date("2026-07-16T00:00:00.000Z"),
          limit: 10,
          offset: 0,
        }),
      ).rejects.toMatchObject({ code: "workspace.not_found" }),
    ]);
  });

  it("delegates duration-insight dismissal and reset to their atomic use cases", async () => {
    const now = new Date("2026-07-15T12:00:00.000Z");
    const workspace = createWorkspace({
      id: workspaceId("duration-feedback-service-workspace"),
      name: "Duration feedback",
      now,
    });
    const routine = createRoutine({
      id: routineId("duration-feedback-service-routine"),
      workspaceId: workspace.id,
      title: "Practice",
      tags: createStructuredTags(),
      duration: createDurationRange({
        expectedMinutes: 30,
        minimumMinutes: 20,
        maximumMinutes: 60,
      }),
      cadence: createCadencePolicy({ period: "week", targetCompletions: 3 }),
      now,
    });
    const evidence = [1, 2, 3].map((sequence) =>
      recordActivityEvent({
        id: activityEventId(`duration-feedback-service-event-${sequence}`),
        workspaceId: workspace.id,
        routineId: routine.id,
        type: "completed",
        occurredAt: new Date(`2026-07-${10 + sequence}T10:00:00.000Z`),
        timeZone: "UTC",
        durationMinutes: 40,
        idempotencyKey: `duration-feedback-service-${sequence}`,
        recordedAt: new Date(`2026-07-${10 + sequence}T10:01:00.000Z`),
      }),
    );
    const insight = calculateRoutineDurationInsight(routine, evidence, now);
    expect(insight.insightKey).not.toBeNull();
    let sequence = 0;
    const feedback: RoutineDurationInsightFeedback[] = [];
    const context = {
      workspaces: { findById: async () => workspace },
      routines: { findById: async () => routine },
      activityEvents: {
        lockRoutineActivity: async () => undefined,
        listDurationEvidence: async () => evidence,
      },
      routineDurationInsightFeedback: {
        findLatestForKey: async () => feedback.at(-1) ?? null,
        findByIdempotencyKey: async (_workspaceId: string, key: string) =>
          feedback.find((event) => event.idempotencyKey === key) ?? null,
        append: async (event: RoutineDurationInsightFeedback) => {
          const stored = { ...event, ingestedSequence: ++sequence };
          feedback.push(stored);
          return stored;
        },
      },
    } as TransactionContext;
    const unitOfWork: UnitOfWork = {
      run: async (operation) => operation(context),
    };
    const services = createProductServices(unitOfWork, { now: () => now });
    const command = {
      workspaceId: workspace.id,
      routineId: routine.id,
      expectedVersion: routine.version,
      insightKey: insight.insightKey!,
    };

    const dismissed = await services.dismissRoutineDurationInsight({
      ...command,
      idempotencyKey: "dismiss-service-insight",
    });
    const reset = await services.resetRoutineDurationInsightDismissal({
      ...command,
      idempotencyKey: "reset-service-insight",
    });

    expect(dismissed).toMatchObject({ kind: "dismissed", ingestedSequence: 1 });
    expect(reset).toMatchObject({ kind: "reset", ingestedSequence: 2 });
    expect(feedback).toEqual([dismissed, reset]);
  });

  it("defaults to disabled, read-only advice without provider or verification work", async () => {
    const now = new Date("2026-07-15T12:00:00.000Z");
    const workspace = createWorkspace({
      id: workspaceId("11111111-1111-4111-8111-111111111111"),
      name: "Advisor service",
      now,
    });
    const routine = createRoutine({
      id: routineId("22222222-2222-4222-8222-222222222222"),
      workspaceId: workspace.id,
      title: "Practice",
      tags: createStructuredTags(),
      duration: createDurationRange({ expectedMinutes: 30 }),
      cadence: createCadencePolicy({ period: "day", targetCompletions: 1 }),
      now,
    });
    const request = createDailyPlanningRequest({
      workspaceId: workspace.id,
      date: "2026-07-15",
      timeZone: "UTC",
      availableWindows: [
        {
          startsAt: new Date("2026-07-15T13:00:00.000Z"),
          endsAt: new Date("2026-07-15T14:00:00.000Z"),
        },
      ],
      targetMinutes: 30,
      targetTaskCount: 1,
      seed: "advisor-service-disabled",
    });
    const plan = generateDailyPlan({
      id: dailyPlanId("44444444-4444-4444-8444-444444444444"),
      request,
      routines: [routine],
      events: [],
      generatedAt: now,
    });
    const context = {
      workspaces: { findById: async () => workspace },
      dailyPlans: { findCurrent: async () => ({ plan, headVersion: 4 }) },
      workItems: { listPlanningCandidates: async () => [] },
    } as TransactionContext;
    let unitOfWorkRuns = 0;
    const unitOfWork: UnitOfWork = {
      run: async (operation) => {
        unitOfWorkRuns += 1;
        return operation(context);
      },
    };
    const services = createProductServices(unitOfWork, { now: () => now });

    const result = await services.getSchedulingAdvice({
      version: "schedule.advisor/v1",
      requestId: "88888888-8888-4888-8888-888888888888",
      workspaceId: workspace.id,
      date: localDate("2026-07-15"),
      focus: "both",
      expectedPlanId: plan.id,
      expectedHeadVersion: 4,
    });

    expect(result).toMatchObject({
      status: "unavailable",
      reason: "disabled",
      provenance: { provider: "disabled", model: null, latencyMs: 0 },
      summary: null,
      suggestions: [],
    });
    expect(unitOfWorkRuns).toBe(1);
  });

  it("delegates advice to the supplied provider and verifies the unchanged snapshot", async () => {
    const now = new Date("2026-07-15T12:00:00.000Z");
    const workspace = createWorkspace({
      id: workspaceId("11111111-1111-4111-8111-111111111111"),
      name: "Advisor service",
      now,
    });
    const request = createDailyPlanningRequest({
      workspaceId: workspace.id,
      date: "2026-07-15",
      timeZone: "UTC",
      availableWindows: [],
      targetMinutes: 30,
      targetTaskCount: 1,
      seed: "advisor-service-provider",
    });
    const plan = generateDailyPlan({
      id: dailyPlanId("44444444-4444-4444-8444-444444444444"),
      request,
      routines: [],
      events: [],
      generatedAt: now,
    });
    const context = {
      workspaces: { findById: async () => workspace },
      dailyPlans: { findCurrent: async () => ({ plan, headVersion: 2 }) },
      workItems: { listPlanningCandidates: async () => [] },
    } as TransactionContext;
    let unitOfWorkRuns = 0;
    let received: SchedulingAdvisorContext | null = null;
    const advisor: SchedulingAdvisor = {
      provider: "ollama",
      model: "fixture-v1",
      advise: async (advisorContext) => {
        received = advisorContext;
        return {
          status: "available",
          output: {
            version: "schedule.advisor-output/v1",
            summary: "Keep the day intentional.",
            suggestions: [
              {
                kind: "plan_observation",
                targetType: null,
                targetId: null,
                title: "Review the open plan",
                rationale: "The plan has room for an intentional choice.",
                confidence: "medium",
              },
            ],
          },
        };
      },
    };
    const unitOfWork: UnitOfWork = {
      run: async (operation) => {
        unitOfWorkRuns += 1;
        return operation(context);
      },
    };
    const services = createProductServices(unitOfWork, { now: () => now }, advisor);

    const result = await services.getSchedulingAdvice({
      version: "schedule.advisor/v1",
      requestId: "88888888-8888-4888-8888-888888888888",
      workspaceId: workspace.id,
      date: localDate("2026-07-15"),
      focus: "both",
      expectedPlanId: plan.id,
      expectedHeadVersion: 2,
    });

    expect(received).toMatchObject({
      version: "schedule.advisor-context/v1",
      requestId: "88888888-8888-4888-8888-888888888888",
      date: "2026-07-15",
      focus: "both",
      plan: { id: plan.id, headVersion: 2 },
      backlog: [],
    });
    expect(result).toMatchObject({
      status: "available",
      reason: null,
      provenance: { provider: "ollama", model: "fixture-v1" },
      summary: "Keep the day intentional.",
      suggestions: [{ id: "advice-1", kind: "plan_observation" }],
    });
    expect(unitOfWorkRuns).toBe(2);
  });
});
