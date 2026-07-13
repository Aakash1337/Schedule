import { afterEach, describe, expect, it } from "vitest";

import { DomainError } from "@schedule/domain";
import {
  activityEventId,
  createCadencePolicy,
  createDurationRange,
  createRoutine,
  createScheduleBlock,
  createStructuredTags,
  createWorkItem,
  createWorkspace,
  dailyPlanId,
  generateDailyPlan,
  recordActivityEvent,
  routineId,
  routineDurationInsightFeedbackId,
  scheduleBlockId,
  updateRoutine as applyRoutineUpdate,
  updateScheduleBlock as applyScheduleBlockUpdate,
  updateWorkItem as applyWorkItemUpdate,
  workItemId,
  workspaceId,
  type DailyPlan,
  type RoutineDurationInsight,
  type RoutineDurationInsightFeedback,
} from "@schedule/domain";

import { buildApp } from "./app.js";
import type { ProductServices } from "./product-routes.js";

const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
const workspaceUuid = "11111111-1111-4111-8111-111111111111";
const routineUuid = "22222222-2222-4222-8222-222222222222";
const eventUuid = "33333333-3333-4333-8333-333333333333";
const planUuid = "44444444-4444-4444-8444-444444444444";
const workItemUuid = "55555555-5555-4555-8555-555555555555";
const scheduleBlockUuid = "66666666-6666-4666-8666-666666666666";
const durationFeedbackUuid = "77777777-7777-4777-8777-777777777777";
const durationInsightKey = "a".repeat(64);
const workspace = createWorkspace({
  id: workspaceId(workspaceUuid),
  name: "Local workspace",
  now: new Date("2026-07-15T07:00:00.000Z"),
});
const routine = createRoutine({
  id: routineId(routineUuid),
  workspaceId: workspace.id,
  title: "Practice Spanish",
  tags: createStructuredTags({
    priority: "high",
    contexts: ["computer"],
    categories: ["learning"],
  }),
  duration: createDurationRange({ expectedMinutes: 30 }),
  cadence: createCadencePolicy({
    period: "week",
    targetCompletions: 3,
    maximumCompletions: 4,
  }),
  now: new Date("2026-07-15T07:00:00.000Z"),
});
const durationInsight = {
  routineId: routine.id,
  routineVersion: routine.version,
  status: "aligned",
  insightKey: null,
  disposition: "available",
  dismissedAt: null,
  sampleCount: 3,
  minimumSamples: 3,
  lookbackDays: 90,
  evaluatedAt: new Date("2026-07-15T12:00:00.000Z"),
  windowStartedAt: new Date("2026-04-16T12:00:00.000Z"),
  currentExpectedMinutes: 30,
  minimumMinutes: 30,
  maximumMinutes: 30,
  observedMedianMinutes: 30,
  materialThresholdMinutes: 5,
  suggestedExpectedMinutes: null,
} satisfies RoutineDurationInsight;
const durationInsightFeedback = {
  id: routineDurationInsightFeedbackId(durationFeedbackUuid),
  ingestedSequence: 1,
  workspaceId: workspace.id,
  routineId: routine.id,
  insightKey: durationInsightKey,
  kind: "dismissed",
  routineVersion: routine.version,
  observedMedianMinutes: 35,
  suggestedExpectedMinutes: 35,
  idempotencyKey: "dismiss-duration-insight",
  recordedAt: new Date("2026-07-15T12:02:00.000Z"),
} satisfies RoutineDurationInsightFeedback;

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function createHarness(overrides: Partial<ProductServices> = {}) {
  let storedPlan: DailyPlan | null = null;
  let storedWorkItem: ReturnType<typeof createWorkItem> | null = null;
  let storedScheduleBlock: ReturnType<typeof createScheduleBlock> | null = null;
  const activity = recordActivityEvent({
    id: activityEventId(eventUuid),
    workspaceId: workspace.id,
    routineId: routine.id,
    type: "completed",
    occurredAt: new Date("2026-07-15T10:00:00.000Z"),
    timeZone: "UTC",
    durationMinutes: 32,
    idempotencyKey: "completion-device-1",
    recordedAt: new Date("2026-07-15T12:01:00.000Z"),
  });
  const services: ProductServices = {
    approveRoutineDurationInsight: async (command) =>
      applyRoutineUpdate(routine, {
        duration: command.duration,
        now: new Date("2026-07-15T12:00:00.000Z"),
      }),
    dismissRoutineDurationInsight: async () => durationInsightFeedback,
    createWorkspace: async (command) => createWorkspace({ ...command, id: workspace.id }),
    getWorkspace: async () => workspace,
    listWorkspaces: async (query) => ({
      items: [workspace],
      limit: query.limit ?? 20,
      offset: query.offset ?? 0,
    }),
    createRoutine: async (command) => createRoutine({ ...command, id: routine.id }),
    createWorkItem: async (command) => {
      storedWorkItem = createWorkItem({
        ...command,
        id: workItemId(workItemUuid),
        now: new Date("2026-07-15T12:00:00.000Z"),
      });
      return storedWorkItem;
    },
    getWorkItem: async () => {
      if (storedWorkItem === null) throw new DomainError("work_item.not_found", "Missing.");
      return storedWorkItem;
    },
    listWorkItems: async (query) => ({
      items:
        storedWorkItem !== null &&
        (query.status === undefined || query.status === storedWorkItem.status) &&
        (query.priority === undefined || query.priority === storedWorkItem.priority)
          ? [storedWorkItem]
          : [],
      limit: query.limit ?? 100,
      offset: query.offset ?? 0,
    }),
    updateWorkItem: async (command) => {
      if (storedWorkItem === null) throw new DomainError("work_item.not_found", "Missing.");
      storedWorkItem = applyWorkItemUpdate(storedWorkItem, {
        ...(command.title === undefined ? {} : { title: command.title }),
        ...(command.description === undefined ? {} : { description: command.description }),
        ...(command.status === undefined ? {} : { status: command.status }),
        ...(command.priority === undefined ? {} : { priority: command.priority }),
        ...(command.dueOn === undefined ? {} : { dueOn: command.dueOn }),
        ...(command.planningDurationMinutes === undefined
          ? {}
          : { planningDurationMinutes: command.planningDurationMinutes }),
        now: new Date("2026-07-15T12:01:00.000Z"),
      });
      return storedWorkItem;
    },
    createScheduleBlock: async (command) => {
      storedScheduleBlock = createScheduleBlock({
        ...command,
        id: scheduleBlockId(scheduleBlockUuid),
        now: new Date("2026-07-15T12:00:00.000Z"),
      });
      return storedScheduleBlock;
    },
    getScheduleBlock: async () => {
      if (storedScheduleBlock === null) {
        throw new DomainError("schedule_block.not_found", "Missing.");
      }
      return storedScheduleBlock;
    },
    listScheduleBlocks: async (query) => ({
      items:
        storedScheduleBlock !== null &&
        storedScheduleBlock.startsAt < query.to &&
        storedScheduleBlock.endsAt > query.from
          ? [storedScheduleBlock]
          : [],
      limit: query.limit ?? 100,
      offset: query.offset ?? 0,
    }),
    updateScheduleBlock: async (command) => {
      if (storedScheduleBlock === null) {
        throw new DomainError("schedule_block.not_found", "Missing.");
      }
      storedScheduleBlock = applyScheduleBlockUpdate(storedScheduleBlock, {
        ...(command.workItemId === undefined ? {} : { workItemId: command.workItemId }),
        ...(command.title === undefined ? {} : { title: command.title }),
        ...(command.startsAt === undefined ? {} : { startsAt: command.startsAt }),
        ...(command.endsAt === undefined ? {} : { endsAt: command.endsAt }),
        ...(command.timeZone === undefined ? {} : { timeZone: command.timeZone }),
        now: new Date("2026-07-15T12:01:00.000Z"),
      });
      return storedScheduleBlock;
    },
    deleteScheduleBlock: async () => {
      if (storedScheduleBlock === null) {
        throw new DomainError("schedule_block.not_found", "Missing.");
      }
      storedScheduleBlock = null;
    },
    getRoutine: async () => routine,
    getRoutineDurationInsight: async () => durationInsight,
    updateRoutine: async (command) =>
      applyRoutineUpdate(routine, {
        ...(command.title === undefined ? {} : { title: command.title }),
        ...(command.description === undefined ? {} : { description: command.description }),
        ...(command.tags === undefined ? {} : { tags: command.tags }),
        ...(command.duration === undefined ? {} : { duration: command.duration }),
        ...(command.cadence === undefined ? {} : { cadence: command.cadence }),
        ...(command.status === undefined ? {} : { status: command.status }),
        now: new Date("2026-07-15T12:00:00.000Z"),
      }),
    listRoutines: async () => [routine],
    listRoutineActivity: async () => ({ items: [activity], nextCursor: null }),
    recordActivityEvent: async (command) =>
      recordActivityEvent({
        ...command,
        id: activityEventId(eventUuid),
        recordedAt: new Date("2026-07-15T12:01:00.000Z"),
      }),
    recordPlanItemActivity: async (command) => ({
      planId: command.expectedPlanId,
      itemId: command.itemId,
      activityState: command.type === "completion_reversed" ? "pending" : command.type,
      activityEvent: recordActivityEvent({
        ...command,
        id: activityEventId(eventUuid),
        routineId: routine.id,
        planId: command.expectedPlanId,
        planItemId: command.itemId,
        recordedAt: new Date("2026-07-15T12:01:00.000Z"),
      }),
      headVersion: command.expectedHeadVersion + 1,
    }),
    resetRoutineDurationInsightDismissal: async () => ({
      ...durationInsightFeedback,
      kind: "reset",
      idempotencyKey: "reset-duration-insight",
    }),
    generateDailyPlan: async (command) => {
      const generated = generateDailyPlan({
        id: dailyPlanId(planUuid),
        request: command.request,
        routines: [routine],
        events: [],
        generatedAt: new Date("2026-07-15T07:00:00.000Z"),
      });
      if (storedPlan === null) {
        if (command.request.requestRevision !== 1) {
          throw new DomainError(
            "planning.revision_creation_conflict",
            "Generic generation cannot allocate a later revision.",
          );
        }
        storedPlan = generated;
      } else if (storedPlan.requestRevision !== command.request.requestRevision) {
        throw new DomainError(
          "planning.revision_creation_conflict",
          "Generic generation cannot allocate a later revision.",
        );
      } else if (storedPlan.inputHash !== generated.inputHash) {
        throw new DomainError("planning.revision_conflict", "The revision input changed.");
      }
      return storedPlan;
    },
    getCurrentDailyPlan: async () => {
      if (storedPlan === null) throw new DomainError("planning.current_not_found", "Missing.");
      return { plan: storedPlan, headVersion: 1 };
    },
    setPlanItemLock: async (command) => ({
      planId: command.expectedPlanId,
      itemId: command.itemId,
      locked: command.locked,
      headVersion: command.expectedHeadVersion + 1,
    }),
    regenerateDailyPlan: async (command) => {
      if (storedPlan === null) throw new DomainError("planning.current_not_found", "Missing.");
      return { plan: storedPlan, headVersion: command.expectedHeadVersion + 1 };
    },
    replacePlanItem: async (command) => {
      if (storedPlan === null) throw new DomainError("planning.current_not_found", "Missing.");
      return { plan: storedPlan, headVersion: command.expectedHeadVersion + 1 };
    },
    applyRoutineFeedback: async (command) => {
      if (storedPlan === null) throw new DomainError("planning.current_not_found", "Missing.");
      return { plan: storedPlan, headVersion: command.expectedHeadVersion + 1 };
    },
    resetRoutineFeedback: async (command) => {
      if (storedPlan === null) throw new DomainError("planning.current_not_found", "Missing.");
      return { plan: storedPlan, headVersion: command.expectedHeadVersion + 1 };
    },
    getDailyPlan: async (query) =>
      storedPlan?.requestRevision === query.requestRevision ? storedPlan : null,
    ...overrides,
  };
  return { services };
}

async function appWith(services: ProductServices) {
  const app = await buildApp({ productServices: services });
  apps.push(app);
  return app;
}

describe("local product API", () => {
  it("rejects DNS-rebinding and hostname-suffix tricks before product routing", async () => {
    const app = await appWith(createHarness().services);

    for (const host of [
      "attacker.example",
      "localhost:invalid",
      "localhost.attacker.example",
      "127.0.0.1.attacker.example",
      "::1",
      "[::1].attacker.example",
    ]) {
      const response = await app.inject({
        method: "GET",
        url: "/v1/workspaces",
        headers: { host },
      });
      expect(response.statusCode, host).toBe(403);
      expect(response.json(), host).toMatchObject({
        error: { code: "request.host_not_allowed" },
      });
    }

    const health = await app.inject({
      method: "GET",
      url: "/health/live",
      headers: { host: "attacker.example" },
    });
    const info = await app.inject({
      method: "GET",
      url: "/v1/system/info",
      headers: { host: "attacker.example" },
    });
    expect(health.statusCode).toBe(200);
    expect(info.statusCode).toBe(200);
  });

  it("accepts direct and Vite-proxied loopback Host authorities", async () => {
    const app = await appWith(createHarness().services);

    for (const host of ["localhost:5173", "127.0.0.1:4000", "127.20.30.40:5173", "[::1]:4000"]) {
      const response = await app.inject({
        method: "GET",
        url: "/v1/workspaces",
        headers: { host },
      });
      expect(response.statusCode, host).toBe(200);
    }
  });

  it("creates a workspace and reports product endpoints enabled", async () => {
    const app = await appWith(createHarness().services);
    const response = await app.inject({
      method: "POST",
      url: "/v1/workspaces",
      payload: { name: " Local workspace " },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ id: workspaceUuid, name: "Local workspace" });
    const listed = await app.inject({ method: "GET", url: "/v1/workspaces?limit=10" });
    const retrieved = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${workspaceUuid}`,
    });
    expect(listed.json()).toMatchObject({
      items: [{ id: workspaceUuid }],
      page: { limit: 10, offset: 0 },
    });
    expect(retrieved.json()).toMatchObject({ id: workspaceUuid });
    const info = await app.inject({ method: "GET", url: "/v1/system/info" });
    expect(info.json()).toMatchObject({ productEndpointsEnabled: true });
  });

  it("supports backlog and status-based Kanban work-item flows", async () => {
    const app = await appWith(createHarness().services);
    const created = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceUuid}/work-items`,
      payload: {
        title: "Ship the MVP",
        description: "Finish the local product loop",
        status: "planned",
        priority: "urgent",
        planningDurationMinutes: 45,
      },
    });
    const listed = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${workspaceUuid}/work-items?status=planned&priority=urgent&limit=20`,
    });
    const updated = await app.inject({
      method: "PATCH",
      url: `/v1/workspaces/${workspaceUuid}/work-items/${workItemUuid}`,
      payload: {
        expectedVersion: 1,
        status: "in_progress",
        priority: "high",
        planningDurationMinutes: 30,
      },
    });
    const retrieved = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${workspaceUuid}/work-items/${workItemUuid}`,
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      id: workItemUuid,
      title: "Ship the MVP",
      status: "planned",
      priority: "urgent",
      planningDurationMinutes: 45,
      version: 1,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({
      items: [{ id: workItemUuid }],
      page: { limit: 20, offset: 0 },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      status: "in_progress",
      priority: "high",
      planningDurationMinutes: 30,
      version: 2,
    });
    expect(retrieved.json()).toEqual(updated.json());
  });

  it("enforces planning-duration bounds for work-item create and update", async () => {
    const app = await appWith(createHarness().services);
    const created = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceUuid}/work-items`,
      payload: { title: "Long focus", planningDurationMinutes: 43_200 },
    });
    const invalidCreateLow = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceUuid}/work-items`,
      payload: { title: "Invalid low", planningDurationMinutes: 0 },
    });
    const invalidCreateHigh = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceUuid}/work-items`,
      payload: { title: "Invalid high", planningDurationMinutes: 43_201 },
    });
    const removed = await app.inject({
      method: "PATCH",
      url: `/v1/workspaces/${workspaceUuid}/work-items/${workItemUuid}`,
      payload: { expectedVersion: 1, planningDurationMinutes: null },
    });
    const updated = await app.inject({
      method: "PATCH",
      url: `/v1/workspaces/${workspaceUuid}/work-items/${workItemUuid}`,
      payload: { expectedVersion: 2, planningDurationMinutes: 43_200 },
    });
    const invalidUpdateLow = await app.inject({
      method: "PATCH",
      url: `/v1/workspaces/${workspaceUuid}/work-items/${workItemUuid}`,
      payload: { expectedVersion: 3, planningDurationMinutes: 0 },
    });
    const invalidUpdateHigh = await app.inject({
      method: "PATCH",
      url: `/v1/workspaces/${workspaceUuid}/work-items/${workItemUuid}`,
      payload: { expectedVersion: 3, planningDurationMinutes: 43_201 },
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ planningDurationMinutes: 43_200 });
    expect(removed.json()).toMatchObject({ planningDurationMinutes: null, version: 2 });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ planningDurationMinutes: 43_200, version: 3 });
    for (const response of [
      invalidCreateLow,
      invalidCreateHigh,
      invalidUpdateLow,
      invalidUpdateHigh,
    ]) {
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: "request.validation_failed" } });
    }
  });

  it("validates and round-trips nullable Gregorian work-item due dates", async () => {
    const app = await appWith(createHarness().services);
    const created = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceUuid}/work-items`,
      payload: { title: "File taxes", dueOn: "2028-02-29" },
    });
    const listed = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${workspaceUuid}/work-items`,
    });
    const retrieved = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${workspaceUuid}/work-items/${workItemUuid}`,
    });
    const updated = await app.inject({
      method: "PATCH",
      url: `/v1/workspaces/${workspaceUuid}/work-items/${workItemUuid}`,
      payload: { expectedVersion: 1, dueOn: "2028-03-01" },
    });
    const cleared = await app.inject({
      method: "PATCH",
      url: `/v1/workspaces/${workspaceUuid}/work-items/${workItemUuid}`,
      payload: { expectedVersion: 2, dueOn: null },
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ dueOn: "2028-02-29" });
    expect(listed.json()).toMatchObject({ items: [{ id: workItemUuid, dueOn: "2028-02-29" }] });
    expect(retrieved.json()).toMatchObject({ dueOn: "2028-02-29" });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ dueOn: "2028-03-01", version: 2 });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toMatchObject({ dueOn: null, version: 3 });
  });

  it("rejects impossible and noncanonical work-item due dates", async () => {
    const app = await appWith(createHarness().services);
    const invalidCreate = await Promise.all(
      ["2027-02-29", "2028-2-29", "2028-02-30"].map((dueOn) =>
        app.inject({
          method: "POST",
          url: `/v1/workspaces/${workspaceUuid}/work-items`,
          payload: { title: "Invalid date", dueOn },
        }),
      ),
    );
    const created = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceUuid}/work-items`,
      payload: { title: "Existing task" },
    });
    const invalidUpdate = await Promise.all(
      ["2027-02-29", "2028-2-29", "2028-02-30"].map((dueOn) =>
        app.inject({
          method: "PATCH",
          url: `/v1/workspaces/${workspaceUuid}/work-items/${workItemUuid}`,
          payload: { expectedVersion: 1, dueOn },
        }),
      ),
    );
    const noOpUpdate = await app.inject({
      method: "PATCH",
      url: `/v1/workspaces/${workspaceUuid}/work-items/${workItemUuid}`,
      payload: { expectedVersion: 1 },
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ dueOn: null });
    for (const response of [...invalidCreate, ...invalidUpdate, noOpUpdate]) {
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: "request.validation_failed" } });
    }
  });

  it("supports linked calendar-block range, update, and delete flows", async () => {
    const app = await appWith(createHarness().services);
    await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceUuid}/work-items`,
      payload: { title: "Calendar work" },
    });
    const created = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceUuid}/schedule-blocks`,
      payload: {
        workItemId: workItemUuid,
        title: "Focus block",
        startsAt: "2026-07-15T10:00:00.000Z",
        endsAt: "2026-07-15T11:00:00.000Z",
        timeZone: "UTC",
      },
    });
    const listed = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${workspaceUuid}/schedule-blocks?from=2026-07-15T10%3A30%3A00.000Z&to=2026-07-15T11%3A30%3A00.000Z`,
    });
    const updated = await app.inject({
      method: "PATCH",
      url: `/v1/workspaces/${workspaceUuid}/schedule-blocks/${scheduleBlockUuid}`,
      payload: { expectedVersion: 1, title: "Deep focus", timeZone: "America/La_Paz" },
    });
    const deleted = await app.inject({
      method: "DELETE",
      url: `/v1/workspaces/${workspaceUuid}/schedule-blocks/${scheduleBlockUuid}`,
      payload: { expectedVersion: 2 },
    });
    const absent = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${workspaceUuid}/schedule-blocks/${scheduleBlockUuid}`,
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      id: scheduleBlockUuid,
      workItemId: workItemUuid,
      version: 1,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({
      items: [{ id: scheduleBlockUuid }],
      page: { limit: 100, offset: 0 },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      title: "Deep focus",
      timeZone: "America/La_Paz",
      version: 2,
    });
    expect(updated.json().startsAt).toBe(created.json().startsAt);
    expect(deleted.statusCode).toBe(204);
    expect(absent.statusCode).toBe(404);
  });

  it("creates and lists a structured routine", async () => {
    let listedStatus: string | undefined;
    let listedLimit: number | undefined;
    let listedOffset: number | undefined;
    const harness = createHarness({
      listRoutines: async (query) => {
        listedStatus = query.status;
        listedLimit = query.limit;
        listedOffset = query.offset;
        return [routine];
      },
    });
    const app = await appWith(harness.services);
    const created = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceUuid}/routines`,
      payload: {
        title: "Practice Spanish",
        tags: { priority: "high", contexts: ["computer"], categories: ["learning"] },
        duration: { expectedMinutes: 30 },
        cadence: { period: "week", targetCompletions: 3, maximumCompletions: 4 },
      },
    });
    const listed = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${workspaceUuid}/routines?status=active`,
    });

    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ id: routineUuid, tags: { priority: "high" } });
    expect(listed.statusCode).toBe(200);
    expect(listed.json().items).toHaveLength(1);
    expect(listedStatus).toBe("active");
    expect(listedLimit).toBe(100);
    expect(listedOffset).toBe(0);
  });

  it("gets and updates a routine with an expected version", async () => {
    let receivedVersion: number | undefined;
    const harness = createHarness({
      updateRoutine: async (command) => {
        receivedVersion = command.expectedVersion;
        return applyRoutineUpdate(routine, {
          ...(command.title === undefined ? {} : { title: command.title }),
          ...(command.status === undefined ? {} : { status: command.status }),
          now: new Date("2026-07-15T12:00:00.000Z"),
        });
      },
    });
    const app = await appWith(harness.services);
    const retrieved = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${workspaceUuid}/routines/${routineUuid}`,
    });
    const updated = await app.inject({
      method: "PATCH",
      url: `/v1/workspaces/${workspaceUuid}/routines/${routineUuid}`,
      payload: { expectedVersion: 1, title: "Conversation practice", status: "paused" },
    });

    expect(retrieved.statusCode).toBe(200);
    expect(retrieved.json()).toMatchObject({ id: routineUuid, version: 1 });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({
      title: "Conversation practice",
      status: "paused",
      version: 2,
    });
    expect(receivedVersion).toBe(1);
  });

  it("requires complete nested replacements and maps stale routine updates to 409", async () => {
    const app = await appWith(
      createHarness({
        updateRoutine: async () => {
          throw new DomainError("routine.version_conflict", "The routine changed.");
        },
      }).services,
    );
    const incompleteTags = await app.inject({
      method: "PATCH",
      url: `/v1/workspaces/${workspaceUuid}/routines/${routineUuid}`,
      payload: { expectedVersion: 1, tags: { priority: "high" } },
    });
    const empty = await app.inject({
      method: "PATCH",
      url: `/v1/workspaces/${workspaceUuid}/routines/${routineUuid}`,
      payload: { expectedVersion: 1 },
    });
    const stale = await app.inject({
      method: "PATCH",
      url: `/v1/workspaces/${workspaceUuid}/routines/${routineUuid}`,
      payload: { expectedVersion: 1, status: "paused" },
    });

    expect(incompleteTags.statusCode).toBe(400);
    expect(empty.statusCode).toBe(400);
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: { code: "routine.version_conflict" } });
  });

  it("returns a scoped routine duration insight and validates both path identifiers", async () => {
    const calls: unknown[] = [];
    const app = await appWith(
      createHarness({
        getRoutineDurationInsight: async (query) => {
          calls.push(query);
          return durationInsight;
        },
      }).services,
    );

    const response = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${workspaceUuid}/routines/${routineUuid}/duration-insight`,
    });
    const invalid = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${workspaceUuid}/routines/not-a-uuid/duration-insight`,
    });
    const invalidWorkspace = await app.inject({
      method: "GET",
      url: `/v1/workspaces/not-a-uuid/routines/${routineUuid}/duration-insight`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      routineId: routineUuid,
      routineVersion: 1,
      status: "aligned",
      insightKey: null,
      disposition: "available",
      dismissedAt: null,
      sampleCount: 3,
      minimumSamples: 3,
      lookbackDays: 90,
      evaluatedAt: "2026-07-15T12:00:00.000Z",
      windowStartedAt: "2026-04-16T12:00:00.000Z",
      currentExpectedMinutes: 30,
      minimumMinutes: 30,
      maximumMinutes: 30,
      observedMedianMinutes: 30,
      materialThresholdMinutes: 5,
      suggestedExpectedMinutes: null,
    });
    expect(calls).toEqual([{ workspaceId: workspace.id, routineId: routine.id }]);
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: { code: "request.validation_failed" } });
    expect(invalidWorkspace.statusCode).toBe(400);
    expect(invalidWorkspace.json()).toMatchObject({
      error: { code: "request.validation_failed" },
    });
    expect(calls).toHaveLength(1);
  });

  it("maps a missing routine duration insight to 404", async () => {
    const app = await appWith(
      createHarness({
        getRoutineDurationInsight: async () => {
          throw new DomainError("routine.not_found", "The routine does not exist.");
        },
      }).services,
    );

    const response = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${workspaceUuid}/routines/${routineUuid}/duration-insight`,
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: { code: "routine.not_found" } });
  });

  it("approves a complete duration insight replacement through its atomic service", async () => {
    const commands: unknown[] = [];
    const app = await appWith(
      createHarness({
        approveRoutineDurationInsight: async (command) => {
          commands.push(command);
          return routine;
        },
      }).services,
    );
    const payload = {
      expectedVersion: 1,
      duration: {
        expectedMinutes: 30,
        minimumMinutes: 30,
        maximumMinutes: 30,
        splittable: false,
        minimumSessionMinutes: null,
        overheadMinutes: 0,
      },
    };

    const response = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceUuid}/routines/${routineUuid}/duration-insight/approve`,
      payload,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: routineUuid, version: 1 });
    expect(commands).toEqual([
      {
        workspaceId: workspace.id,
        routineId: routine.id,
        expectedVersion: 1,
        duration: payload.duration,
      },
    ]);
  });

  it("rejects incomplete duration approvals before invoking the service", async () => {
    let calls = 0;
    const app = await appWith(
      createHarness({
        approveRoutineDurationInsight: async () => {
          calls += 1;
          return routine;
        },
      }).services,
    );

    const response = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceUuid}/routines/${routineUuid}/duration-insight/approve`,
      payload: { expectedVersion: 1, duration: { expectedMinutes: 30 } },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "request.validation_failed" } });
    expect(calls).toBe(0);
  });

  it("maps changed duration evidence during approval to 409", async () => {
    const app = await appWith(
      createHarness({
        approveRoutineDurationInsight: async () => {
          throw new DomainError(
            "routine_duration_insight.evidence_conflict",
            "The duration evidence changed.",
          );
        },
      }).services,
    );

    const response = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceUuid}/routines/${routineUuid}/duration-insight/approve`,
      payload: {
        expectedVersion: 1,
        duration: {
          expectedMinutes: 30,
          minimumMinutes: 30,
          maximumMinutes: 30,
          splittable: false,
          minimumSessionMinutes: null,
          overheadMinutes: 0,
        },
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      error: { code: "routine_duration_insight.evidence_conflict" },
    });
  });

  it("dismisses and resets one exact duration insight through idempotent commands", async () => {
    const dismissedCommands: unknown[] = [];
    const resetCommands: unknown[] = [];
    const app = await appWith(
      createHarness({
        dismissRoutineDurationInsight: async (command) => {
          dismissedCommands.push(command);
          return durationInsightFeedback;
        },
        resetRoutineDurationInsightDismissal: async (command) => {
          resetCommands.push(command);
          return {
            ...durationInsightFeedback,
            kind: "reset",
            idempotencyKey: "reset-duration-insight",
          };
        },
      }).services,
    );
    const payload = { expectedVersion: 1, insightKey: durationInsightKey };

    const dismissed = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceUuid}/routines/${routineUuid}/duration-insight/dismissals`,
      headers: { "idempotency-key": "dismiss-duration-insight" },
      payload,
    });
    const reset = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceUuid}/routines/${routineUuid}/duration-insight/dismissal-resets`,
      headers: { "idempotency-key": "reset-duration-insight" },
      payload,
    });

    expect(dismissed.statusCode).toBe(200);
    expect(dismissed.json()).toEqual({
      id: durationFeedbackUuid,
      ingestedSequence: 1,
      workspaceId: workspaceUuid,
      routineId: routineUuid,
      insightKey: durationInsightKey,
      kind: "dismissed",
      routineVersion: 1,
      observedMedianMinutes: 35,
      suggestedExpectedMinutes: 35,
      idempotencyKey: "dismiss-duration-insight",
      recordedAt: "2026-07-15T12:02:00.000Z",
    });
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toMatchObject({
      id: durationFeedbackUuid,
      kind: "reset",
      idempotencyKey: "reset-duration-insight",
      recordedAt: "2026-07-15T12:02:00.000Z",
    });
    expect(dismissedCommands).toEqual([
      {
        workspaceId: workspace.id,
        routineId: routine.id,
        expectedVersion: 1,
        insightKey: durationInsightKey,
        idempotencyKey: "dismiss-duration-insight",
      },
    ]);
    expect(resetCommands).toEqual([
      {
        workspaceId: workspace.id,
        routineId: routine.id,
        expectedVersion: 1,
        insightKey: durationInsightKey,
        idempotencyKey: "reset-duration-insight",
      },
    ]);
  });

  it("requires idempotency and a strict duration-insight feedback payload", async () => {
    let calls = 0;
    const app = await appWith(
      createHarness({
        dismissRoutineDurationInsight: async () => {
          calls += 1;
          return durationInsightFeedback;
        },
        resetRoutineDurationInsightDismissal: async () => {
          calls += 1;
          return { ...durationInsightFeedback, kind: "reset" };
        },
      }).services,
    );
    const path = `/v1/workspaces/${workspaceUuid}/routines/${routineUuid}/duration-insight`;
    const missingHeader = await app.inject({
      method: "POST",
      url: `${path}/dismissals`,
      payload: { expectedVersion: 1, insightKey: durationInsightKey },
    });
    const malformedKey = await app.inject({
      method: "POST",
      url: `${path}/dismissals`,
      headers: { "idempotency-key": "invalid-key" },
      payload: { expectedVersion: 1, insightKey: durationInsightKey.toUpperCase() },
    });
    const unknownField = await app.inject({
      method: "POST",
      url: `${path}/dismissal-resets`,
      headers: { "idempotency-key": "unknown-field" },
      payload: { expectedVersion: 1, insightKey: durationInsightKey, force: true },
    });
    const invalidVersion = await app.inject({
      method: "POST",
      url: `${path}/dismissal-resets`,
      headers: { "idempotency-key": "invalid-version" },
      payload: { expectedVersion: 0, insightKey: durationInsightKey },
    });

    for (const response of [missingHeader, malformedKey, unknownField, invalidVersion]) {
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ error: { code: "request.validation_failed" } });
    }
    expect(calls).toBe(0);
  });

  it("maps duration-insight feedback scope and conflict errors", async () => {
    const app = await appWith(
      createHarness({
        dismissRoutineDurationInsight: async (command) => {
          if (command.idempotencyKey === "conflicting-dismissal") {
            throw new DomainError(
              "routine_duration_insight.idempotency_conflict",
              "The idempotency key belongs to another command.",
            );
          }
          throw new DomainError("routine.version_conflict", "The routine changed.");
        },
        resetRoutineDurationInsightDismissal: async () => {
          throw new DomainError("routine.not_found", "The routine does not exist.");
        },
      }).services,
    );
    const path = `/v1/workspaces/${workspaceUuid}/routines/${routineUuid}/duration-insight`;
    const payload = { expectedVersion: 1, insightKey: durationInsightKey };
    const conflict = await app.inject({
      method: "POST",
      url: `${path}/dismissals`,
      headers: { "idempotency-key": "stale-dismissal" },
      payload,
    });
    const missing = await app.inject({
      method: "POST",
      url: `${path}/dismissal-resets`,
      headers: { "idempotency-key": "missing-reset" },
      payload,
    });
    const idempotencyConflict = await app.inject({
      method: "POST",
      url: `${path}/dismissals`,
      headers: { "idempotency-key": "conflicting-dismissal" },
      payload,
    });

    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: { code: "routine.version_conflict" } });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: { code: "routine.not_found" } });
    expect(idempotencyConflict.statusCode).toBe(409);
    expect(idempotencyConflict.json()).toMatchObject({
      error: { code: "routine_duration_insight.idempotency_conflict" },
    });
  });

  it("returns stable cursor-paginated activity history without idempotency keys", async () => {
    const calls: unknown[] = [];
    const app = await appWith(
      createHarness({
        listRoutineActivity: async (query) => {
          calls.push(query.cursor ?? null);
          const activity = recordActivityEvent({
            id: activityEventId(eventUuid),
            workspaceId: workspace.id,
            routineId: routine.id,
            type: "completed",
            occurredAt: new Date("2026-07-15T10:00:00.000Z"),
            timeZone: "UTC",
            idempotencyKey: "private-retry-key",
            recordedAt: new Date("2026-07-15T12:01:00.000Z"),
          });
          return {
            items: [activity],
            nextCursor: query.cursor === undefined ? { watermark: 19, before: 17 } : null,
          };
        },
      }).services,
    );
    const first = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${workspaceUuid}/routines/${routineUuid}/activity-events?limit=1`,
    });
    const token = first.json().page.nextCursor as string;
    const tamperedToken = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
    const second = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${workspaceUuid}/routines/${routineUuid}/activity-events?limit=1&cursor=${encodeURIComponent(token)}`,
    });
    const invalid = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${workspaceUuid}/routines/${routineUuid}/activity-events?cursor=not_a_cursor`,
    });
    const tampered = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${workspaceUuid}/routines/${routineUuid}/activity-events?cursor=${encodeURIComponent(tamperedToken)}`,
    });

    expect(first.statusCode).toBe(200);
    expect(first.json().items[0]).not.toHaveProperty("idempotencyKey");
    expect(second.statusCode).toBe(200);
    expect(second.json().page.nextCursor).toBeNull();
    expect(calls).toEqual([null, { watermark: 19, before: 17 }]);
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: { code: "request.validation_failed" } });
    expect(tampered.statusCode).toBe(400);
  });

  it("returns 404 for missing routine retrieval and update", async () => {
    const app = await appWith(
      createHarness({
        getRoutine: async () => {
          throw new DomainError("routine.not_found", "The routine does not exist.");
        },
        updateRoutine: async () => {
          throw new DomainError("routine.not_found", "The routine does not exist.");
        },
      }).services,
    );
    const retrieved = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${workspaceUuid}/routines/${routineUuid}`,
    });
    const updated = await app.inject({
      method: "PATCH",
      url: `/v1/workspaces/${workspaceUuid}/routines/${routineUuid}`,
      payload: { expectedVersion: 1, status: "paused" },
    });

    expect(retrieved.statusCode).toBe(404);
    expect(updated.statusCode).toBe(404);
    expect(updated.json()).toMatchObject({ error: { code: "routine.not_found" } });
  });

  it("returns structured validation and domain errors without stack details", async () => {
    const app = await appWith(createHarness().services);
    const malformed = await app.inject({
      method: "GET",
      url: "/v1/workspaces/not-a-uuid/routines",
    });
    const invalidCadence = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceUuid}/routines`,
      payload: {
        title: "Invalid",
        duration: { expectedMinutes: 30 },
        cadence: { period: "week", targetCompletions: 1, minimumCompletions: 2 },
      },
    });

    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toMatchObject({
      error: { code: "request.validation_failed" },
    });
    expect(invalidCadence.statusCode).toBe(422);
    expect(invalidCadence.json()).toMatchObject({
      error: { code: "cadence.minimum_exceeds_target" },
    });
    expect(invalidCadence.body).not.toContain("daily-planning.ts");
  });

  it("rejects impossible local dates at every HTTP boundary", async () => {
    const app = await appWith(createHarness().services);
    const invalidCadenceDate = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceUuid}/routines`,
      payload: {
        title: "Impossible cadence",
        duration: { expectedMinutes: 30 },
        cadence: { period: "week", targetCompletions: 1, startsOn: "2026-02-29" },
      },
    });
    const invalidPlanDate = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceUuid}/plans`,
      payload: {
        date: "2026-02-29",
        timeZone: "UTC",
        targetMinutes: 30,
        targetTaskCount: 1,
        seed: "impossible-date",
      },
    });
    const invalidPathDate = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${workspaceUuid}/plans/1900-02-29/current`,
    });

    for (const response of [invalidCadenceDate, invalidPlanDate, invalidPathDate]) {
      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        error: {
          code: "request.validation_failed",
          details: [
            expect.objectContaining({
              message: "Expected a valid Gregorian date in YYYY-MM-DD format.",
            }),
          ],
        },
      });
    }
  });

  it("requires an idempotency key and records an activity event", async () => {
    const app = await appWith(createHarness().services);
    const payload = {
      type: "completed",
      occurredAt: "2026-07-15T10:00:00.000Z",
      timeZone: "UTC",
      durationMinutes: 32,
    };
    const missingKey = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceUuid}/routines/${routineUuid}/activity-events`,
      payload,
    });
    const recorded = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceUuid}/routines/${routineUuid}/activity-events`,
      headers: { "idempotency-key": "completion-device-1" },
      payload,
    });
    const retried = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceUuid}/routines/${routineUuid}/activity-events`,
      headers: { "idempotency-key": "completion-device-1" },
      payload,
    });

    expect(missingKey.statusCode).toBe(400);
    expect(recorded.statusCode).toBe(200);
    expect(recorded.json()).toMatchObject({
      id: eventUuid,
      localDate: "2026-07-15",
    });
    expect(recorded.json()).not.toHaveProperty("idempotencyKey");
    expect(retried.json()).toEqual(recorded.json());
  });

  it("generates and retrieves an exact plan revision without exposing its input snapshot", async () => {
    const app = await appWith(createHarness().services);
    const generated = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceUuid}/plans`,
      payload: {
        date: "2026-07-15",
        timeZone: "UTC",
        availableWindows: [
          { startsAt: "2026-07-15T08:00:00.000Z", endsAt: "2026-07-15T09:00:00.000Z" },
        ],
        targetMinutes: 30,
        targetTaskCount: 1,
        availableContexts: ["computer"],
        seed: "api-plan",
        requestRevision: 1,
      },
    });
    const retrieved = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${workspaceUuid}/plans/2026-07-15?revision=1`,
    });

    expect(generated.statusCode).toBe(200);
    expect(generated.json()).toMatchObject({ id: planUuid, requestRevision: 1 });
    expect(generated.json()).not.toHaveProperty("inputSnapshot");
    expect(generated.json().request.availableWindows).toHaveLength(1);
    expect(retrieved.statusCode).toBe(200);
    expect(retrieved.json()).toEqual(generated.json());
  });

  it("allows exact generic retries but rejects generic creation of a later revision", async () => {
    const app = await appWith(createHarness().services);
    const payload = {
      date: "2026-07-15",
      timeZone: "UTC",
      targetMinutes: 30,
      targetTaskCount: 1,
      seed: "generic-retry",
      requestRevision: 1,
    };
    const created = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceUuid}/plans`,
      payload,
    });
    const retried = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceUuid}/plans`,
      payload,
    });
    const laterRevision = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceUuid}/plans`,
      payload: { ...payload, seed: "generic-revision-2", requestRevision: 2 },
    });

    expect(created.statusCode).toBe(200);
    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toEqual(created.json());
    expect(laterRevision.statusCode).toBe(409);
    expect(laterRevision.json()).toMatchObject({
      error: { code: "planning.revision_creation_conflict" },
    });
  });

  it("retrieves the current Today plan and locks an item optimistically", async () => {
    const app = await appWith(createHarness().services);
    const generated = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceUuid}/plans`,
      payload: {
        date: "2026-07-15",
        timeZone: "UTC",
        availableWindows: [
          { startsAt: "2026-07-15T08:00:00.000Z", endsAt: "2026-07-15T09:00:00.000Z" },
        ],
        targetMinutes: 30,
        targetTaskCount: 1,
        availableContexts: ["computer"],
        seed: "today-plan",
      },
    });
    const itemId = generated.json().items[0].id as string;
    const current = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${workspaceUuid}/plans/2026-07-15/current`,
    });
    const locked = await app.inject({
      method: "PATCH",
      url: `/v1/workspaces/${workspaceUuid}/plans/2026-07-15/items/${itemId}/lock`,
      headers: { "idempotency-key": "lock-first-item" },
      payload: { expectedPlanId: planUuid, expectedHeadVersion: 1, locked: true },
    });

    expect(current.statusCode).toBe(200);
    expect(current.json()).toMatchObject({ id: planUuid, headVersion: 1 });
    expect(locked.statusCode).toBe(200);
    expect(locked.json()).toMatchObject({ itemId, locked: true, headVersion: 2 });
  });

  it("records activity against an exact current-plan item", async () => {
    const app = await appWith(createHarness().services);
    const generated = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceUuid}/plans`,
      payload: {
        date: "2026-07-15",
        timeZone: "UTC",
        availableWindows: [
          { startsAt: "2026-07-15T08:00:00.000Z", endsAt: "2026-07-15T09:00:00.000Z" },
        ],
        targetMinutes: 30,
        targetTaskCount: 1,
        availableContexts: ["computer"],
        seed: "today-activity",
      },
    });
    const itemId = generated.json().items[0].id as string;
    const completed = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceUuid}/plans/2026-07-15/items/${itemId}/activity-events`,
      headers: { "idempotency-key": "complete-first-item" },
      payload: {
        expectedPlanId: planUuid,
        expectedHeadVersion: 1,
        type: "completed",
        occurredAt: "2026-07-15T10:00:00.000Z",
        timeZone: "UTC",
        durationMinutes: 28,
      },
    });

    expect(completed.statusCode).toBe(200);
    expect(completed.json()).toMatchObject({
      planId: planUuid,
      itemId,
      activityState: "completed",
      headVersion: 2,
      activityEvent: {
        planId: planUuid,
        planItemId: itemId,
        routineId: routineUuid,
        type: "completed",
        durationMinutes: 28,
      },
    });
    expect(completed.json().activityEvent).not.toHaveProperty("idempotencyKey");
  });

  it("applies and resets routine feedback through dedicated idempotent plan mutations", async () => {
    const app = await appWith(createHarness().services);
    const planningRequest = {
      timeZone: "UTC",
      availableWindows: [
        { startsAt: "2026-07-15T08:00:00.000Z", endsAt: "2026-07-15T09:00:00.000Z" },
      ],
      targetMinutes: 30,
      targetTaskCount: 1,
      availableContexts: ["computer"],
      seed: "feedback-api",
    };
    const generated = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceUuid}/plans`,
      payload: { ...planningRequest, date: "2026-07-15" },
    });
    const itemId = generated.json().items[0].id as string;
    const mutationBody = {
      expectedPlanId: planUuid,
      expectedHeadVersion: 1,
      kind: "not_this_week",
      request: planningRequest,
    };

    const applied = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceUuid}/plans/2026-07-15/items/${itemId}/routine-feedback`,
      headers: { "idempotency-key": "feedback-api-week" },
      payload: mutationBody,
    });
    const invalidKind = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceUuid}/plans/2026-07-15/items/${itemId}/routine-feedback`,
      headers: { "idempotency-key": "feedback-api-invalid" },
      payload: { ...mutationBody, kind: "forever" },
    });
    const reset = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceUuid}/plans/2026-07-15/routines/${routineUuid}/routine-feedback-resets`,
      headers: { "idempotency-key": "feedback-api-reset" },
      payload: {
        expectedPlanId: planUuid,
        expectedHeadVersion: 2,
        request: { ...planningRequest, seed: "feedback-api-reset" },
      },
    });

    expect(applied.statusCode).toBe(200);
    expect(applied.json()).toMatchObject({ id: planUuid, headVersion: 2 });
    expect(invalidKind.statusCode).toBe(400);
    expect(reset.statusCode).toBe(200);
    expect(reset.json()).toMatchObject({ id: planUuid, headVersion: 3 });
  });

  it("returns 404 for an absent exact plan and 409 for idempotency conflicts", async () => {
    const app = await appWith(
      createHarness({
        getDailyPlan: async () => null,
        recordActivityEvent: async () => {
          throw new DomainError(
            "activity.idempotency_conflict",
            "This key already belongs to another event.",
          );
        },
      }).services,
    );
    const absent = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${workspaceUuid}/plans/2026-07-15?revision=1`,
    });
    const conflict = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceUuid}/routines/${routineUuid}/activity-events`,
      headers: { "idempotency-key": "conflicting-key" },
      payload: {
        type: "completed",
        occurredAt: "2026-07-15T10:00:00.000Z",
        timeZone: "UTC",
      },
    });

    expect(absent.statusCode).toBe(404);
    expect(absent.json()).toMatchObject({ error: { code: "plan.not_found" } });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: { code: "activity.idempotency_conflict" } });
  });

  it("bounds local request volume and body size without affecting health routes", async () => {
    const app = await buildApp({
      productServices: createHarness().services,
      productApiLimits: { requestsPerMinute: 1, maxConcurrentPlans: 1 },
    });
    apps.push(app);
    const first = await app.inject({
      method: "POST",
      url: "/v1/workspaces",
      payload: { name: "One" },
    });
    const throttled = await app.inject({
      method: "POST",
      url: "/v1/workspaces",
      payload: { name: "Two" },
    });
    const health = await app.inject({ method: "GET", url: "/health/live" });

    expect(first.statusCode).toBe(201);
    expect(throttled.statusCode).toBe(429);
    expect(throttled.json()).toMatchObject({ error: { code: "request.rate_limit_exceeded" } });
    expect(Number(throttled.headers["retry-after"])).toBeGreaterThan(0);
    expect(health.statusCode).toBe(200);

    const bodyLimitApp = await appWith(createHarness().services);
    const oversized = await bodyLimitApp.inject({
      method: "POST",
      url: "/v1/workspaces",
      payload: { name: "x".repeat(300_000) },
    });
    expect(oversized.statusCode).toBe(413);
    expect(oversized.json()).toMatchObject({ error: { code: "request.body_too_large" } });
  });

  it("shares the concurrency limit across every plan-generation mutation", async () => {
    let releasePlan: () => void = () => undefined;
    let markStarted: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releasePlan = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const app = await buildApp({
      productServices: createHarness({
        generateDailyPlan: async (command) => {
          markStarted();
          await gate;
          return generateDailyPlan({
            id: dailyPlanId(planUuid),
            request: command.request,
            routines: [routine],
            events: [],
            generatedAt: new Date("2026-07-15T07:00:00.000Z"),
          });
        },
      }).services,
      productApiLimits: { requestsPerMinute: 100, maxConcurrentPlans: 1 },
    });
    apps.push(app);
    const payload = {
      date: "2026-07-15",
      timeZone: "UTC",
      availableWindows: [
        {
          startsAt: "2026-07-15T08:00:00.000Z",
          endsAt: "2026-07-15T09:00:00.000Z",
        },
      ],
      targetMinutes: 30,
      targetTaskCount: 1,
      availableContexts: ["computer"],
      seed: "concurrency-test",
    };
    const firstResponse = app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceUuid}/plans`,
      payload,
    });
    await started;
    const mutationPayload = {
      expectedPlanId: planUuid,
      expectedHeadVersion: 1,
      request: {
        timeZone: payload.timeZone,
        availableWindows: payload.availableWindows,
        targetMinutes: payload.targetMinutes,
        targetTaskCount: payload.targetTaskCount,
        availableContexts: payload.availableContexts,
        seed: "concurrency-mutation-test",
      },
    };
    const throttledRegeneration = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceUuid}/plans/2026-07-15/regenerations`,
      headers: { "idempotency-key": "concurrency-regeneration" },
      payload: mutationPayload,
    });
    const throttledReplacement = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceUuid}/plans/2026-07-15/items/${routineUuid}/replacement`,
      headers: { "idempotency-key": "concurrency-replacement" },
      payload: mutationPayload,
    });
    const throttledFeedback = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceUuid}/plans/2026-07-15/items/${routineUuid}/routine-feedback`,
      headers: { "idempotency-key": "concurrency-feedback" },
      payload: { ...mutationPayload, kind: "not_today" },
    });
    const throttledFeedbackReset = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceUuid}/plans/2026-07-15/routines/${routineUuid}/routine-feedback-resets`,
      headers: { "idempotency-key": "concurrency-feedback-reset" },
      payload: mutationPayload,
    });
    releasePlan();

    for (const throttled of [
      throttledRegeneration,
      throttledReplacement,
      throttledFeedback,
      throttledFeedbackReset,
    ]) {
      expect(throttled.statusCode).toBe(429);
      expect(throttled.json()).toMatchObject({
        error: { code: "planning.concurrency_limit_reached" },
      });
    }
    expect((await firstResponse).statusCode).toBe(200);
  });

  it("redacts unexpected service errors", async () => {
    const app = await appWith(
      createHarness({
        createWorkspace: async () => {
          throw new Error("database password should never leak");
        },
      }).services,
    );
    const response = await app.inject({
      method: "POST",
      url: "/v1/workspaces",
      payload: { name: "Failure" },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: { code: "internal.unexpected_error" } });
    expect(response.body).not.toContain("password");
  });
});
