import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type {
  ActivityHistoryCursor,
  ActivityHistoryPage,
  CreateRoutineCommand,
  CreateWorkspaceCommand,
  CurrentDailyPlan,
  GenerateDailyPlanCommand,
  GetCurrentDailyPlanQuery,
  GetDailyPlanQuery,
  GetRoutineQuery,
  ListRoutineActivityQuery,
  ListRoutinesQuery,
  PlanItemLockResult,
  RecordActivityEventCommand,
  SetPlanItemLockCommand,
  UpdateRoutineCommand,
} from "@schedule/application";
import {
  activityEventId,
  createCadencePolicy,
  createDailyPlanningRequest,
  createDurationRange,
  createStructuredTags,
  dailyPlanId,
  localDate,
  planItemId,
  routineId,
  workspaceId,
  type ActivityEvent,
  type DailyPlan,
  type JsonValue,
  type Routine,
  type Workspace,
  type Weekday,
} from "@schedule/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  parseRequest,
  RequestThrottledError,
  RequestValidationError,
  ResourceNotFoundError,
} from "./http-errors.js";

export interface ProductServices {
  createWorkspace(command: CreateWorkspaceCommand): Promise<Workspace>;
  createRoutine(command: CreateRoutineCommand): Promise<Routine>;
  getRoutine(query: GetRoutineQuery): Promise<Routine>;
  updateRoutine(command: UpdateRoutineCommand): Promise<Routine>;
  listRoutines(query: ListRoutinesQuery): Promise<readonly Routine[]>;
  listRoutineActivity(query: ListRoutineActivityQuery): Promise<ActivityHistoryPage>;
  recordActivityEvent(command: RecordActivityEventCommand): Promise<ActivityEvent>;
  generateDailyPlan(command: GenerateDailyPlanCommand): Promise<DailyPlan>;
  getCurrentDailyPlan(query: GetCurrentDailyPlanQuery): Promise<CurrentDailyPlan>;
  setPlanItemLock(command: SetPlanItemLockCommand): Promise<PlanItemLockResult>;
  getDailyPlan(query: GetDailyPlanQuery): Promise<DailyPlan | null>;
}

export interface ProductApiLimits {
  readonly requestsPerMinute: number;
  readonly maxConcurrentPlans: number;
}

const DEFAULT_PRODUCT_API_LIMITS: ProductApiLimits = {
  requestsPerMinute: 240,
  maxConcurrentPlans: 2,
};

function installRateLimit(app: FastifyInstance, requestsPerMinute: number): void {
  const buckets = new Map<string, { startedAt: number; count: number }>();
  let requestCount = 0;
  app.addHook("onRequest", async (request) => {
    const now = Date.now();
    const current = buckets.get(request.ip);
    const bucket =
      current === undefined || now - current.startedAt >= 60_000
        ? { startedAt: now, count: 0 }
        : current;
    bucket.count += 1;
    buckets.set(request.ip, bucket);
    if (bucket.count > requestsPerMinute) throw new RequestThrottledError();

    requestCount += 1;
    if (requestCount % 256 === 0) {
      for (const [address, candidate] of buckets) {
        if (now - candidate.startedAt >= 60_000) buckets.delete(address);
      }
    }
  });
}

const uuid = z.string().uuid();
const localDateText = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD.");
const instant = z.string().datetime({ offset: true });
const workspaceParams = z.strictObject({ workspaceId: uuid });
const routineParams = z.strictObject({ workspaceId: uuid, routineId: uuid });
const planParams = z.strictObject({ workspaceId: uuid, date: localDateText });
const planItemParams = z.strictObject({ workspaceId: uuid, date: localDateText, itemId: uuid });

const workspaceBody = z.strictObject({ name: z.string().trim().min(1).max(160) });
const tagsBody = z
  .strictObject({
    priority: z.enum(["low", "medium", "high", "critical"]).default("medium"),
    effort: z.enum(["quick", "short", "medium", "deep"]).default("medium"),
    energy: z.enum(["low", "normal", "high"]).default("normal"),
    preference: z.enum(["enjoyable", "neutral", "unpleasant"]).default("neutral"),
    contexts: z.array(z.string().min(1).max(64)).max(32).default([]),
    categories: z.array(z.string().min(1).max(64)).max(32).default([]),
    freeForm: z.array(z.string().min(1).max(64)).max(32).default([]),
  })
  .default({
    priority: "medium",
    effort: "medium",
    energy: "normal",
    preference: "neutral",
    contexts: [],
    categories: [],
    freeForm: [],
  });
const durationBody = z.strictObject({
  expectedMinutes: z.number().int().positive().max(43_200),
  minimumMinutes: z.number().int().positive().max(43_200).optional(),
  maximumMinutes: z.number().int().positive().max(43_200).optional(),
  splittable: z.boolean().default(false),
  minimumSessionMinutes: z.number().int().positive().max(43_200).nullable().default(null),
  overheadMinutes: z.number().int().nonnegative().max(1_440).default(0),
});
const cadenceBody = z.strictObject({
  period: z.enum(["day", "week", "month", "rolling_days"]),
  rollingIntervalDays: z.number().int().positive().max(3_650).nullable().default(null),
  targetCompletions: z.number().int().positive().max(10_000).default(1),
  minimumCompletions: z.number().int().positive().max(10_000).nullable().default(null),
  maximumCompletions: z.number().int().positive().max(10_000).nullable().default(null),
  minimumSpacingDays: z.number().int().nonnegative().max(3_650).default(0),
  preferredWeekdays: z.array(z.number().int().min(0).max(6)).max(7).default([]),
  excludedWeekdays: z.array(z.number().int().min(0).max(6)).max(7).default([]),
  discourageConsecutiveDays: z.boolean().default(false),
  prohibitConsecutiveDays: z.boolean().default(false),
  weekStartsOn: z.number().int().min(0).max(6).default(1),
  startsOn: localDateText.nullable().default(null),
  pausedUntil: localDateText.nullable().default(null),
  endsOn: localDateText.nullable().default(null),
});
const routineBody = z.strictObject({
  title: z.string().trim().min(1).max(240),
  description: z.string().max(4_000).nullable().default(null),
  status: z.enum(["active", "paused", "archived"]).default("active"),
  tags: tagsBody,
  duration: durationBody,
  cadence: cadenceBody,
});
const routineQuery = z.strictObject({
  status: z.enum(["active", "paused", "archived"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

const replacementTagsBody = z.strictObject({
  priority: z.enum(["low", "medium", "high", "critical"]),
  effort: z.enum(["quick", "short", "medium", "deep"]),
  energy: z.enum(["low", "normal", "high"]),
  preference: z.enum(["enjoyable", "neutral", "unpleasant"]),
  contexts: z.array(z.string().min(1).max(64)).max(32),
  categories: z.array(z.string().min(1).max(64)).max(32),
  freeForm: z.array(z.string().min(1).max(64)).max(32),
});
const replacementDurationBody = z.strictObject({
  expectedMinutes: z.number().int().positive().max(43_200),
  minimumMinutes: z.number().int().positive().max(43_200),
  maximumMinutes: z.number().int().positive().max(43_200),
  splittable: z.boolean(),
  minimumSessionMinutes: z.number().int().positive().max(43_200).nullable(),
  overheadMinutes: z.number().int().nonnegative().max(1_440),
});
const replacementCadenceBody = z.strictObject({
  period: z.enum(["day", "week", "month", "rolling_days"]),
  rollingIntervalDays: z.number().int().positive().max(3_650).nullable(),
  targetCompletions: z.number().int().positive().max(10_000),
  minimumCompletions: z.number().int().positive().max(10_000).nullable(),
  maximumCompletions: z.number().int().positive().max(10_000).nullable(),
  minimumSpacingDays: z.number().int().nonnegative().max(3_650),
  preferredWeekdays: z.array(z.number().int().min(0).max(6)).max(7),
  excludedWeekdays: z.array(z.number().int().min(0).max(6)).max(7),
  discourageConsecutiveDays: z.boolean(),
  prohibitConsecutiveDays: z.boolean(),
  weekStartsOn: z.number().int().min(0).max(6),
  startsOn: localDateText.nullable(),
  pausedUntil: localDateText.nullable(),
  endsOn: localDateText.nullable(),
});
const updateRoutineBody = z
  .strictObject({
    expectedVersion: z.number().int().positive().max(2_147_483_647),
    title: z.string().trim().min(1).max(240).optional(),
    description: z.string().max(4_000).nullable().optional(),
    status: z.enum(["active", "paused", "archived"]).optional(),
    tags: replacementTagsBody.optional(),
    duration: replacementDurationBody.optional(),
    cadence: replacementCadenceBody.optional(),
  })
  .refine(
    (body) =>
      body.title !== undefined ||
      body.description !== undefined ||
      body.status !== undefined ||
      body.tags !== undefined ||
      body.duration !== undefined ||
      body.cadence !== undefined,
    { message: "At least one routine change is required." },
  );
const activityHistoryQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z
    .string()
    .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
    .max(1_024)
    .optional(),
});
const activityHistoryCursor = z.strictObject({
  v: z.literal(1),
  workspaceId: uuid,
  routineId: uuid,
  watermark: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  before: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

const metadataValue = z.union([z.string().max(256), z.number().finite(), z.boolean(), z.null()]);
const activityBody = z.strictObject({
  type: z.enum([
    "suggested",
    "accepted",
    "started",
    "completed",
    "skipped",
    "deferred",
    "dismissed",
    "duration_corrected",
    "completion_reversed",
  ]),
  occurredAt: instant,
  timeZone: z.string().trim().min(1).max(80),
  planId: uuid.nullable().default(null),
  durationMinutes: z.number().int().positive().max(43_200).nullable().default(null),
  reason: z.string().max(500).nullable().default(null),
  referenceEventId: uuid.nullable().default(null),
  metadata: z
    .record(z.string().min(1).max(64), metadataValue)
    .refine((value) => Object.keys(value).length <= 8, {
      message: "Metadata cannot contain more than 8 fields.",
    })
    .default({}),
});

const planBody = z.strictObject({
  date: localDateText,
  timeZone: z.string().trim().min(1).max(80),
  availableWindows: z
    .array(z.strictObject({ startsAt: instant, endsAt: instant }))
    .max(64)
    .default([]),
  targetMinutes: z.number().int().positive().max(43_200),
  minimumMinutes: z.number().int().nonnegative().max(43_200).optional(),
  maximumMinutes: z.number().int().positive().max(43_200).optional(),
  targetTaskCount: z.number().int().positive().max(512),
  minimumTaskCount: z.number().int().nonnegative().max(512).optional(),
  maximumTaskCount: z.number().int().positive().max(512).optional(),
  fitPreference: z.enum(["time", "task_count", "balanced"]).default("balanced"),
  energy: z.enum(["low", "normal", "high"]).nullable().default(null),
  availableContexts: z.array(z.string().min(1).max(64)).max(32).default([]),
  seed: z.string().trim().min(1).max(240),
  requestRevision: z.number().int().positive().max(1_000_000).default(1),
});
const planQuery = z.strictObject({ revision: z.coerce.number().int().positive().max(1_000_000) });
const planItemLockBody = z.strictObject({
  expectedPlanId: uuid,
  expectedHeadVersion: z.number().int().positive().max(2_147_483_647),
  locked: z.boolean(),
});
const idempotencyKey = z.string().trim().min(1).max(160);

function publicPlan(
  plan: DailyPlan,
): Omit<DailyPlan, "inputSnapshot"> & { readonly request: JsonValue | null } {
  const { inputSnapshot, ...result } = plan;
  const request =
    typeof inputSnapshot === "object" &&
    inputSnapshot !== null &&
    !Array.isArray(inputSnapshot) &&
    "request" in inputSnapshot
      ? inputSnapshot.request
      : null;
  return { ...result, request };
}

function publicActivityEvent(event: ActivityEvent): Omit<ActivityEvent, "idempotencyKey"> {
  const { idempotencyKey, ...result } = event;
  void idempotencyKey;
  return result;
}

function encodeActivityCursor(
  cursor: ActivityHistoryCursor | null,
  scope: { workspaceId: string; routineId: string },
  signingKey: Buffer,
): string | null {
  if (cursor === null) return null;
  const payload = Buffer.from(JSON.stringify({ v: 1, ...scope, ...cursor }), "utf8").toString(
    "base64url",
  );
  const signature = createHmac("sha256", signingKey).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function decodeActivityCursor(
  value: string,
  scope: { workspaceId: string; routineId: string },
  signingKey: Buffer,
): ActivityHistoryCursor {
  try {
    const [payload, signature, extra] = value.split(".");
    if (payload === undefined || signature === undefined || extra !== undefined) {
      throw new Error("Malformed cursor.");
    }
    const suppliedSignature = Buffer.from(signature, "base64url");
    const expectedSignature = createHmac("sha256", signingKey).update(payload).digest();
    if (
      suppliedSignature.toString("base64url") !== signature ||
      suppliedSignature.length !== expectedSignature.length ||
      !timingSafeEqual(suppliedSignature, expectedSignature)
    ) {
      throw new Error("Cursor signature mismatch.");
    }
    const decoded = Buffer.from(payload, "base64url");
    if (decoded.toString("base64url") !== payload) throw new Error("Non-canonical cursor.");
    const parsed = activityHistoryCursor.parse(JSON.parse(decoded.toString("utf8")));
    if (
      parsed.workspaceId !== scope.workspaceId ||
      parsed.routineId !== scope.routineId ||
      parsed.before > parsed.watermark
    ) {
      throw new Error("Cursor is outside its scope or watermark.");
    }
    return { watermark: parsed.watermark, before: parsed.before };
  } catch {
    throw new RequestValidationError([{ path: "cursor", message: "Invalid activity cursor." }]);
  }
}

export async function registerProductRoutes(
  app: FastifyInstance,
  services: ProductServices,
  limits: ProductApiLimits = DEFAULT_PRODUCT_API_LIMITS,
): Promise<void> {
  installRateLimit(app, limits.requestsPerMinute);
  const cursorSigningKey = randomBytes(32);
  let concurrentPlans = 0;
  app.post("/v1/workspaces", async (request, reply) => {
    const body = parseRequest(workspaceBody, request.body);
    const created = await services.createWorkspace(body);
    return reply.code(201).send(created);
  });

  app.post("/v1/workspaces/:workspaceId/routines", async (request, reply) => {
    const params = parseRequest(workspaceParams, request.params);
    const body = parseRequest(routineBody, request.body);
    const created = await services.createRoutine({
      workspaceId: workspaceId(params.workspaceId),
      title: body.title,
      description: body.description,
      status: body.status,
      tags: createStructuredTags(body.tags),
      duration: createDurationRange({
        expectedMinutes: body.duration.expectedMinutes,
        minimumMinutes: body.duration.minimumMinutes ?? body.duration.expectedMinutes,
        maximumMinutes: body.duration.maximumMinutes ?? body.duration.expectedMinutes,
        splittable: body.duration.splittable,
        minimumSessionMinutes: body.duration.minimumSessionMinutes,
        overheadMinutes: body.duration.overheadMinutes,
      }),
      cadence: createCadencePolicy({
        ...body.cadence,
        preferredWeekdays: body.cadence.preferredWeekdays as Weekday[],
        excludedWeekdays: body.cadence.excludedWeekdays as Weekday[],
        weekStartsOn: body.cadence.weekStartsOn as Weekday,
      }),
    });
    return reply.code(201).send(created);
  });

  app.get("/v1/workspaces/:workspaceId/routines", async (request) => {
    const params = parseRequest(workspaceParams, request.params);
    const query = parseRequest(routineQuery, request.query);
    const items = await services.listRoutines({
      workspaceId: workspaceId(params.workspaceId),
      ...(query.status === undefined ? {} : { status: query.status }),
      limit: query.limit,
      offset: query.offset,
    });
    return { items, page: { limit: query.limit, offset: query.offset } };
  });

  app.get("/v1/workspaces/:workspaceId/routines/:routineId", async (request) => {
    const params = parseRequest(routineParams, request.params);
    return services.getRoutine({
      workspaceId: workspaceId(params.workspaceId),
      routineId: routineId(params.routineId),
    });
  });

  app.patch("/v1/workspaces/:workspaceId/routines/:routineId", async (request) => {
    const params = parseRequest(routineParams, request.params);
    const body = parseRequest(updateRoutineBody, request.body);
    return services.updateRoutine({
      workspaceId: workspaceId(params.workspaceId),
      routineId: routineId(params.routineId),
      expectedVersion: body.expectedVersion,
      ...(body.title === undefined ? {} : { title: body.title }),
      ...(body.description === undefined ? {} : { description: body.description }),
      ...(body.status === undefined ? {} : { status: body.status }),
      ...(body.tags === undefined ? {} : { tags: createStructuredTags(body.tags) }),
      ...(body.duration === undefined ? {} : { duration: createDurationRange(body.duration) }),
      ...(body.cadence === undefined
        ? {}
        : {
            cadence: createCadencePolicy({
              ...body.cadence,
              preferredWeekdays: body.cadence.preferredWeekdays as Weekday[],
              excludedWeekdays: body.cadence.excludedWeekdays as Weekday[],
              weekStartsOn: body.cadence.weekStartsOn as Weekday,
            }),
          }),
    });
  });

  app.get("/v1/workspaces/:workspaceId/routines/:routineId/activity-events", async (request) => {
    const params = parseRequest(routineParams, request.params);
    const query = parseRequest(activityHistoryQuery, request.query);
    const scope = { workspaceId: params.workspaceId, routineId: params.routineId };
    const page = await services.listRoutineActivity({
      workspaceId: workspaceId(params.workspaceId),
      routineId: routineId(params.routineId),
      limit: query.limit,
      ...(query.cursor === undefined
        ? {}
        : { cursor: decodeActivityCursor(query.cursor, scope, cursorSigningKey) }),
    });
    return {
      items: page.items.map(publicActivityEvent),
      page: {
        limit: query.limit,
        nextCursor: encodeActivityCursor(page.nextCursor, scope, cursorSigningKey),
      },
    };
  });

  app.post("/v1/workspaces/:workspaceId/routines/:routineId/activity-events", async (request) => {
    const params = parseRequest(routineParams, request.params);
    const body = parseRequest(activityBody, request.body);
    const key = parseRequest(idempotencyKey, request.headers["idempotency-key"]);
    return publicActivityEvent(
      await services.recordActivityEvent({
        workspaceId: workspaceId(params.workspaceId),
        routineId: routineId(params.routineId),
        planId: body.planId === null ? null : dailyPlanId(body.planId),
        type: body.type,
        occurredAt: new Date(body.occurredAt),
        timeZone: body.timeZone,
        durationMinutes: body.durationMinutes,
        reason: body.reason,
        referenceEventId:
          body.referenceEventId === null ? null : activityEventId(body.referenceEventId),
        idempotencyKey: key,
        metadata: body.metadata,
      }),
    );
  });

  app.post("/v1/workspaces/:workspaceId/plans", async (request) => {
    if (concurrentPlans >= limits.maxConcurrentPlans) {
      throw new RequestThrottledError("planning.concurrency_limit_reached");
    }
    concurrentPlans += 1;
    try {
      const params = parseRequest(workspaceParams, request.params);
      const body = parseRequest(planBody, request.body);
      const planningRequest = createDailyPlanningRequest({
        workspaceId: workspaceId(params.workspaceId),
        date: body.date,
        timeZone: body.timeZone,
        availableWindows: body.availableWindows.map((window) => ({
          startsAt: new Date(window.startsAt),
          endsAt: new Date(window.endsAt),
        })),
        targetMinutes: body.targetMinutes,
        ...(body.minimumMinutes === undefined ? {} : { minimumMinutes: body.minimumMinutes }),
        ...(body.maximumMinutes === undefined ? {} : { maximumMinutes: body.maximumMinutes }),
        targetTaskCount: body.targetTaskCount,
        ...(body.minimumTaskCount === undefined ? {} : { minimumTaskCount: body.minimumTaskCount }),
        ...(body.maximumTaskCount === undefined ? {} : { maximumTaskCount: body.maximumTaskCount }),
        fitPreference: body.fitPreference,
        energy: body.energy,
        availableContexts: body.availableContexts,
        seed: body.seed,
        requestRevision: body.requestRevision,
      });
      return publicPlan(await services.generateDailyPlan({ request: planningRequest }));
    } finally {
      concurrentPlans -= 1;
    }
  });

  app.get("/v1/workspaces/:workspaceId/plans/:date", async (request) => {
    const params = parseRequest(planParams, request.params);
    const query = parseRequest(planQuery, request.query);
    const plan = await services.getDailyPlan({
      workspaceId: workspaceId(params.workspaceId),
      date: localDate(params.date),
      requestRevision: query.revision,
    });
    if (plan === null) throw new ResourceNotFoundError("plan");
    return publicPlan(plan);
  });

  app.get("/v1/workspaces/:workspaceId/plans/:date/current", async (request) => {
    const params = parseRequest(planParams, request.params);
    const current = await services.getCurrentDailyPlan({
      workspaceId: workspaceId(params.workspaceId),
      date: localDate(params.date),
    });
    return { ...publicPlan(current.plan), headVersion: current.headVersion };
  });

  app.patch("/v1/workspaces/:workspaceId/plans/:date/items/:itemId/lock", async (request) => {
    const params = parseRequest(planItemParams, request.params);
    const body = parseRequest(planItemLockBody, request.body);
    const key = parseRequest(idempotencyKey, request.headers["idempotency-key"]);
    return services.setPlanItemLock({
      workspaceId: workspaceId(params.workspaceId),
      date: localDate(params.date),
      expectedPlanId: dailyPlanId(body.expectedPlanId),
      itemId: planItemId(params.itemId),
      expectedHeadVersion: body.expectedHeadVersion,
      locked: body.locked,
      idempotencyKey: key,
    });
  });
}
