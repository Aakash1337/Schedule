import { describe, expect, it } from "vitest";

import type { TransactionContext, UnitOfWork, Workspace } from "@schedule/application";
import {
  activityEventId,
  calculateRoutineDurationInsight,
  createCadencePolicy,
  createDurationRange,
  createRoutine,
  createStructuredTags,
  createWorkspace,
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
});
