import type {
  ConfirmIntegrationCommandInput,
  ConfirmedIntegrationCommandResult,
  IntegrationCommand,
  IntegrationCredentialScope,
  IntegrationPrincipal,
  IntegrationTodayResult,
  PreparedIntegrationCommand,
} from "@schedule/application";
import { isValidLocalDate } from "@schedule/domain";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  IntegrationAuthenticationError,
  RequestThrottledError,
  UnsupportedMediaTypeError,
  parseRequest,
} from "./http-errors.js";

export const INTEGRATION_API_VERSION = "schedule.integration/v1" as const;

export interface IntegrationServices {
  authenticateCredential(input: {
    readonly credentialId: string;
    readonly secret: string;
    readonly requiredScope: IntegrationCredentialScope;
  }): Promise<IntegrationPrincipal>;
  getToday(input: {
    readonly principal: IntegrationPrincipal;
    readonly date: string;
  }): Promise<IntegrationTodayResult>;
  prepareCommand(input: {
    readonly principal: IntegrationPrincipal;
    readonly requestId: string;
    readonly command: IntegrationCommand;
  }): Promise<PreparedIntegrationCommand>;
  confirmCommand(input: ConfirmIntegrationCommandInput): Promise<ConfirmedIntegrationCommandResult>;
}

export interface IntegrationApiLimits {
  readonly requestsPerMinute: number;
  readonly maxTrackedClients?: number;
}

const DEFAULT_INTEGRATION_API_LIMITS: Required<IntegrationApiLimits> = {
  requestsPerMinute: 120,
  maxTrackedClients: 4_096,
};

const uuid = z.string().uuid();
const localDateText = z
  .string()
  .refine(isValidLocalDate, "Expected a valid Gregorian date in YYYY-MM-DD format.");
const instant = z.string().datetime({ offset: true });
const version = z.literal(INTEGRATION_API_VERSION);
const expectedVersion = z.number().int().positive().max(2_147_483_647);
const workItemStatus = z.enum([
  "backlog",
  "planned",
  "in_progress",
  "blocked",
  "done",
  "cancelled",
]);
const workItemPriority = z.enum(["none", "low", "medium", "high", "urgent"]);

const createWorkItemCommand = z.strictObject({
  type: z.literal("work_item.create"),
  title: z.string().trim().min(1).max(240),
  description: z.string().max(4_000).nullable().optional(),
  status: workItemStatus.optional(),
  priority: workItemPriority.optional(),
  planningDurationMinutes: z.number().int().positive().max(43_200).nullable().optional(),
});

const updateWorkItemCommand = z
  .strictObject({
    type: z.literal("work_item.update"),
    workItemId: uuid,
    expectedVersion,
    title: z.string().trim().min(1).max(240).optional(),
    description: z.string().max(4_000).nullable().optional(),
    status: workItemStatus.optional(),
    priority: workItemPriority.optional(),
    planningDurationMinutes: z.number().int().positive().max(43_200).nullable().optional(),
  })
  .refine(
    (command) =>
      command.title !== undefined ||
      command.description !== undefined ||
      command.status !== undefined ||
      command.priority !== undefined ||
      command.planningDurationMinutes !== undefined,
    { message: "At least one work item change is required." },
  );

const createScheduleBlockCommand = z.strictObject({
  type: z.literal("schedule_block.create"),
  workItemId: uuid.nullable().optional(),
  title: z.string().max(240).nullable().optional(),
  startsAt: instant,
  endsAt: instant,
  timeZone: z.string().trim().min(1).max(80),
});

const updateScheduleBlockCommand = z
  .strictObject({
    type: z.literal("schedule_block.update"),
    scheduleBlockId: uuid,
    expectedVersion,
    workItemId: uuid.nullable().optional(),
    title: z.string().max(240).nullable().optional(),
    startsAt: instant.optional(),
    endsAt: instant.optional(),
    timeZone: z.string().trim().min(1).max(80).optional(),
  })
  .refine(
    (command) =>
      command.workItemId !== undefined ||
      command.title !== undefined ||
      command.startsAt !== undefined ||
      command.endsAt !== undefined ||
      command.timeZone !== undefined,
    { message: "At least one schedule block change is required." },
  );

const metadataValue = z.union([z.string().max(256), z.number().finite(), z.boolean(), z.null()]);
const activityMetadata = z
  .record(z.string().min(1).max(64), metadataValue)
  .refine((value) => Object.keys(value).length <= 8, {
    message: "Metadata cannot contain more than 8 fields.",
  });
const planItemActivityCommand = z
  .strictObject({
    type: z.literal("plan_item.activity"),
    date: localDateText,
    expectedPlanId: uuid,
    itemId: uuid,
    expectedHeadVersion: expectedVersion,
    activityType: z.enum([
      "started",
      "completed",
      "skipped",
      "deferred",
      "dismissed",
      "completion_reversed",
    ]),
    occurredAt: instant,
    timeZone: z.string().trim().min(1).max(80),
    durationMinutes: z.number().int().positive().max(43_200).nullable().optional(),
    reason: z.string().max(500).nullable().optional(),
    metadata: activityMetadata.optional(),
  })
  .refine(
    (command) =>
      command.durationMinutes === undefined ||
      command.durationMinutes === null ||
      command.activityType === "completed",
    { message: "Duration can only be recorded for a completed plan item." },
  );

const integrationCommand = z.union([
  createWorkItemCommand,
  updateWorkItemCommand,
  createScheduleBlockCommand,
  updateScheduleBlockCommand,
  planItemActivityCommand,
]);
const prepareBody = z.strictObject({
  version,
  requestId: uuid,
  command: integrationCommand,
});
const confirmBody = z.strictObject({
  version,
  confirmationId: uuid,
});
const todayQuery = z.strictObject({ date: localDateText });
const idempotencyKey = z.string().trim().min(1).max(160);

interface CredentialToken {
  readonly credentialId: string;
  readonly secret: string;
}

/**
 * Parse the bounded bearer credential without ever including it in an error.
 * The base64url round trip rejects permissive decoder edge cases and padding.
 */
export function parseIntegrationAuthorization(value: string | undefined): CredentialToken {
  if (value === undefined || value.length > 512) throw new IntegrationAuthenticationError();
  const match = /^Bearer ([^.\s]+)\.([A-Za-z0-9_-]+)$/i.exec(value);
  if (match === null) throw new IntegrationAuthenticationError();
  const credentialId = uuid.safeParse(match[1]);
  const secretText = match[2];
  if (!credentialId.success || secretText === undefined) {
    throw new IntegrationAuthenticationError();
  }

  const secretBytes = Buffer.from(secretText, "base64url");
  if (
    secretBytes.byteLength < 32 ||
    secretBytes.byteLength > 128 ||
    secretBytes.toString("base64url") !== secretText
  ) {
    throw new IntegrationAuthenticationError();
  }
  return { credentialId: credentialId.data.toLowerCase(), secret: secretText };
}

interface Bucket {
  readonly startedAt: number;
  count: number;
}

function createBoundedRateLimiter(requestsPerMinute: number, maxTrackedClients: number) {
  const buckets = new Map<string, Bucket>();
  let calls = 0;

  return (key: string, reply: { header(name: string, value: string): unknown }): void => {
    const now = Date.now();
    const existing = buckets.get(key);
    const bucket =
      existing === undefined || now - existing.startedAt >= 60_000
        ? { startedAt: now, count: 0 }
        : existing;

    if (existing === undefined && buckets.size >= maxTrackedClients) {
      for (const [candidateKey, candidate] of buckets) {
        if (now - candidate.startedAt >= 60_000) buckets.delete(candidateKey);
      }
      if (buckets.size >= maxTrackedClients) {
        const leastRecentlyUsedKey = buckets.keys().next().value as string | undefined;
        if (leastRecentlyUsedKey !== undefined) buckets.delete(leastRecentlyUsedKey);
      }
    }

    bucket.count += 1;
    buckets.delete(key);
    buckets.set(key, bucket);
    if (bucket.count > requestsPerMinute) {
      const retryAfterSeconds = Math.max(1, Math.ceil((60_000 - (now - bucket.startedAt)) / 1_000));
      reply.header("retry-after", String(retryAfterSeconds));
      throw new RequestThrottledError("integration.rate_limit_exceeded");
    }

    calls += 1;
    if (calls % 256 === 0) {
      for (const [candidateKey, candidate] of buckets) {
        if (now - candidate.startedAt >= 60_000) buckets.delete(candidateKey);
      }
    }
  };
}

function requireJson(request: FastifyRequest): void {
  const contentType = request.headers["content-type"];
  if (contentType === undefined || !/^application\/json(?:\s*;|$)/i.test(contentType)) {
    throw new UnsupportedMediaTypeError();
  }
}

function envelope<RequestId extends string, Data>(requestId: RequestId, data: Data) {
  return { version: INTEGRATION_API_VERSION, requestId, data } as const;
}

export async function registerIntegrationRoutes(
  app: FastifyInstance,
  services: IntegrationServices,
  limits: IntegrationApiLimits = DEFAULT_INTEGRATION_API_LIMITS,
): Promise<void> {
  if (
    !Number.isInteger(limits.requestsPerMinute) ||
    limits.requestsPerMinute < 1 ||
    limits.requestsPerMinute > 1_000
  ) {
    throw new Error("Integration requests per minute must be an integer between 1 and 1000.");
  }
  const configuredMaxTrackedClients =
    limits.maxTrackedClients ?? DEFAULT_INTEGRATION_API_LIMITS.maxTrackedClients;
  if (
    !Number.isInteger(configuredMaxTrackedClients) ||
    configuredMaxTrackedClients < 32 ||
    configuredMaxTrackedClients > 65_536
  ) {
    throw new Error("Integration client tracking capacity must be an integer from 32 to 65536.");
  }
  const requestsPerMinute = limits.requestsPerMinute;
  const maxTrackedClients = configuredMaxTrackedClients;
  const limitIp = createBoundedRateLimiter(requestsPerMinute, maxTrackedClients);
  const limitCredential = createBoundedRateLimiter(requestsPerMinute, maxTrackedClients);

  app.addHook("onRequest", async (request, reply) => {
    reply.header("cache-control", "no-store");
    limitIp(request.ip, reply);
  });

  async function authenticate(
    request: FastifyRequest,
    reply: { header(name: string, value: string): unknown },
    requiredScope: IntegrationCredentialScope,
  ): Promise<IntegrationPrincipal> {
    const token = parseIntegrationAuthorization(request.headers.authorization);
    // Limit the presented credential ID before authentication so failed guesses cannot
    // distribute around the credential control. IP limiting still bounds random-ID churn.
    limitCredential(token.credentialId, reply);
    const principal = await services.authenticateCredential({ ...token, requiredScope });
    return principal;
  }

  app.get("/v1/integrations/today", async (request, reply) => {
    const principal = await authenticate(request, reply, "schedule:read");
    const query = parseRequest(todayQuery, request.query);
    const result = await services.getToday({ principal, date: query.date });
    return envelope(request.id, result);
  });

  app.post("/v1/integrations/commands/prepare", async (request, reply) => {
    const principal = await authenticate(request, reply, "schedule:write");
    requireJson(request);
    const body = parseRequest(prepareBody, request.body);
    const result = await services.prepareCommand({
      principal,
      requestId: body.requestId,
      // The strict JSON schema cannot produce present `undefined` values. Zod's inferred
      // optional-property type is wider than the application's exact optional type.
      command: body.command as IntegrationCommand,
    });
    return reply.code(201).send(envelope(body.requestId, result));
  });

  app.post("/v1/integrations/commands/confirm", async (request, reply) => {
    const principal = await authenticate(request, reply, "schedule:write");
    requireJson(request);
    const body = parseRequest(confirmBody, request.body);
    const key = parseRequest(idempotencyKey, request.headers["idempotency-key"]);
    const result = await services.confirmCommand({
      principal,
      confirmationId: body.confirmationId,
      idempotencyKey: key,
    });
    return envelope(body.confirmationId, result);
  });
}
