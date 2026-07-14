import { describe, expect, it } from "vitest";

import type {
  SchedulingAdvisor,
  SchedulingAdvisorContext,
  TransactionContext,
  UnitOfWork,
  WorkItemDependencyRepository,
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
  createWorkItem,
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
  type WorkItemDependency,
} from "@schedule/domain";

import { createProductServices } from "./product-services.js";

function createWorkItemDependencyRepositoryStub(): WorkItemDependencyRepository {
  return {
    lockWorkspace: async () => undefined,
    find: async () => null,
    list: async () => [],
    listForPlanning: async () => [],
    loadPlanningGraph: async () => ({ workItems: [], dependencies: [] }),
    wouldCreateCycle: async () => false,
    insert: async () => undefined,
    delete: async () => false,
  };
}

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
      workItemDependencies: createWorkItemDependencyRepositoryStub(),
    } as TransactionContext;
    const unitOfWork: UnitOfWork = {
      run: async (operation) => operation(context),
    };
    const services = createProductServices(unitOfWork, {
      now: () => new Date("2026-07-15T12:00:00.000Z"),
    });

    expect(Object.keys(services).sort()).toEqual([
      "addWorkItemDependency",
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
      "listWorkItemDependencies",
      "listWorkItems",
      "listWorkspaces",
      "recordActivityEvent",
      "recordPlanItemActivity",
      "regenerateDailyPlan",
      "removeWorkItemDependency",
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
        services.addWorkItemDependency({
          workspaceId: missingWorkspace,
          prerequisiteWorkItemId: workItemId("missing-prerequisite"),
          dependentWorkItemId: workItemId("missing-dependent"),
        }),
      ).rejects.toMatchObject({ code: "workspace.not_found" }),
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
        services.listWorkItemDependencies({
          workspaceId: missingWorkspace,
          limit: 10,
          offset: 0,
        }),
      ).rejects.toMatchObject({ code: "workspace.not_found" }),
      expect(
        services.removeWorkItemDependency({
          workspaceId: missingWorkspace,
          prerequisiteWorkItemId: workItemId("missing-prerequisite-removal"),
          dependentWorkItemId: workItemId("missing-dependent-removal"),
        }),
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
      workItemDependencies: createWorkItemDependencyRepositoryStub(),
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

  it("delegates dependency creation, replay, listing, and idempotent removal", async () => {
    const now = new Date("2026-07-15T12:00:00.000Z");
    const workspace = createWorkspace({
      id: workspaceId("dependency-service-workspace"),
      name: "Dependencies",
      now,
    });
    const prerequisite = createWorkItem({
      id: workItemId("dependency-service-prerequisite"),
      workspaceId: workspace.id,
      title: "Prepare outline",
      now,
    });
    const dependent = createWorkItem({
      id: workItemId("dependency-service-dependent"),
      workspaceId: workspace.id,
      title: "Write report",
      now,
    });
    let dependency: WorkItemDependency | null = null;
    const audits: unknown[] = [];
    const context = {
      workspaces: {
        findById: async () => workspace,
      },
      workItems: {
        findById: async (_workspaceId: string, id: string) => {
          if (id === prerequisite.id) return prerequisite;
          if (id === dependent.id) return dependent;
          return null;
        },
      },
      workItemDependencies: {
        lockWorkspace: async () => undefined,
        find: async () => dependency,
        list: async (_workspaceId: string, limit: number, offset: number) =>
          (dependency === null ? [] : [dependency]).slice(offset, offset + limit),
        loadPlanningGraph: async (
          _workspaceId: string,
          workItemLimit: number,
          dependencyLimit: number,
        ) => {
          const workItems = [prerequisite, dependent]
            .filter(
              (item) =>
                ["backlog", "planned", "in_progress"].includes(item.status) &&
                item.planningDurationMinutes !== null,
            )
            .slice(0, workItemLimit);
          const candidateIds = new Set(workItems.map((item) => item.id));
          return {
            workItems,
            dependencies:
              dependency !== null && candidateIds.has(dependency.dependentWorkItemId)
                ? [{ ...dependency, prerequisiteStatus: prerequisite.status }].slice(
                    0,
                    dependencyLimit,
                  )
                : [],
          };
        },
        wouldCreateCycle: async () => false,
        insert: async (created: WorkItemDependency) => {
          dependency = created;
        },
        delete: async () => {
          if (dependency === null) return false;
          dependency = null;
          return true;
        },
      },
      auditEvents: {
        append: async (event: unknown) => {
          audits.push(event);
        },
      },
    } as TransactionContext;
    const services = createProductServices(
      { run: async (operation) => operation(context) },
      { now: () => now },
    );
    const command = {
      workspaceId: workspace.id,
      prerequisiteWorkItemId: prerequisite.id,
      dependentWorkItemId: dependent.id,
    };

    const created = await services.addWorkItemDependency(command);
    const replayed = await services.addWorkItemDependency(command);
    const listed = await services.listWorkItemDependencies({
      workspaceId: workspace.id,
      limit: 10,
      offset: 0,
    });
    await services.removeWorkItemDependency(command);
    await services.removeWorkItemDependency(command);
    const empty = await services.listWorkItemDependencies({
      workspaceId: workspace.id,
      limit: 10,
      offset: 0,
    });

    expect(created).toMatchObject({ created: true, dependency: command });
    expect(created.dependency.createdAt).toEqual(now);
    expect(replayed).toEqual({ dependency: created.dependency, created: false });
    expect(listed).toEqual({ items: [created.dependency], limit: 10, offset: 0 });
    expect(empty).toEqual({ items: [], limit: 10, offset: 0 });
    expect(audits.length).toBeGreaterThanOrEqual(1);
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
      workItemDependencies: createWorkItemDependencyRepositoryStub(),
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
      workItemDependencies: createWorkItemDependencyRepositoryStub(),
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
