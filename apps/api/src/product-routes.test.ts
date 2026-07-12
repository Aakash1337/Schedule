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
  scheduleBlockId,
  updateRoutine as applyRoutineUpdate,
  updateScheduleBlock as applyScheduleBlockUpdate,
  updateWorkItem as applyWorkItemUpdate,
  workItemId,
  workspaceId,
  type DailyPlan,
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
    generateDailyPlan: async (command) => {
      storedPlan = generateDailyPlan({
        id: dailyPlanId(planUuid),
        request: command.request,
        routines: [routine],
        events: [],
        generatedAt: new Date("2026-07-15T07:00:00.000Z"),
      });
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
    getDailyPlan: async () => storedPlan,
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
      },
    });
    const listed = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${workspaceUuid}/work-items?status=planned&priority=urgent&limit=20`,
    });
    const updated = await app.inject({
      method: "PATCH",
      url: `/v1/workspaces/${workspaceUuid}/work-items/${workItemUuid}`,
      payload: { expectedVersion: 1, status: "in_progress", priority: "high" },
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
      version: 1,
    });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({
      items: [{ id: workItemUuid }],
      page: { limit: 20, offset: 0 },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json()).toMatchObject({ status: "in_progress", priority: "high", version: 2 });
    expect(retrieved.json()).toEqual(updated.json());
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

  it("limits concurrent plan generation", async () => {
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
    const throttled = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceUuid}/plans`,
      payload,
    });
    releasePlan();

    expect(throttled.statusCode).toBe(429);
    expect(throttled.json()).toMatchObject({
      error: { code: "planning.concurrency_limit_reached" },
    });
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
