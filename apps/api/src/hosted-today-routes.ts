import type { CurrentDailyPlan, HostedWorkspaceAuthorization } from "@schedule/application";
import {
  dailyPlanId,
  DomainError,
  instantToLocalDate,
  isIanaTimeZone,
  isValidLocalDate,
  localDate,
  planItemId,
  type DailyPlanId,
  type LocalDate,
  type PlanItemId,
} from "@schedule/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  registerHostedWorkspaceBoundary,
  type HostedWorkspaceBoundaryDependencies,
  type HostedWorkspaceRequestAccess,
  withHostedWorkspaceNotFoundRedacted,
} from "./hosted-auth-boundary.js";
import { parseRequest } from "./http-errors.js";

const hostedTodayQuery = z.strictObject({
  date: z
    .string()
    .refine(isValidLocalDate, "Expected a valid Gregorian date in YYYY-MM-DD format."),
});
const canonicalUuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const hostedTodayActivityParams = z.strictObject({
  workspaceId: canonicalUuid,
  itemId: canonicalUuid,
});
const hostedTodayActivityType = z.enum(["started", "completed", "skipped"]);
const hostedTodayActivityBody = z.strictObject({
  expectedPlanId: canonicalUuid,
  expectedHeadVersion: z.number().int().min(1).max(2_147_483_647),
  type: hostedTodayActivityType,
  occurredAt: z.string().datetime({ offset: true }),
});
const hostedTodayGenerationBody = z.strictObject({
  timeZone: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .refine(isIanaTimeZone, "Expected a valid IANA time zone."),
  window: z.strictObject({
    startsAt: z.string().datetime({ offset: true }),
    endsAt: z.string().datetime({ offset: true }),
  }),
  targetMinutes: z.number().int().min(1).max(1_440),
  targetTaskCount: z.number().int().min(1).max(64),
});
const hostedTodayGenerationRequest = z
  .strictObject({ query: hostedTodayQuery, body: hostedTodayGenerationBody })
  .superRefine(({ query, body }, context) => {
    const startsAt = new Date(body.window.startsAt);
    const endsAt = new Date(body.window.endsAt);
    if (
      !isIanaTimeZone(body.timeZone) ||
      !Number.isFinite(startsAt.getTime()) ||
      !Number.isFinite(endsAt.getTime())
    )
      return;
    if (endsAt <= startsAt) {
      context.addIssue({
        code: "custom",
        path: ["body", "window", "endsAt"],
        message: "The planning window must end after it starts.",
      });
      return;
    }
    const startsOn = instantToLocalDate(startsAt, body.timeZone);
    const endsOn = instantToLocalDate(new Date(endsAt.getTime() - 1), body.timeZone);
    if (startsOn !== query.date || endsOn !== query.date) {
      context.addIssue({
        code: "custom",
        path: ["body", "window"],
        message: "The planning window must stay within the requested local date.",
      });
    }
  });
const idempotencyKey = z.string().trim().min(1).max(160);

export const HOSTED_TODAY_ROUTE = "/v1/hosted/workspaces/:workspaceId/today";
export const HOSTED_TODAY_ACTIVITY_ROUTE = `${HOSTED_TODAY_ROUTE}/:itemId/activity-events`;

export interface HostedTodayInput {
  readonly authorization: HostedWorkspaceAuthorization;
  readonly date: LocalDate;
}

export interface HostedTodayActivityInput {
  readonly authorization: HostedWorkspaceAuthorization;
  readonly date: LocalDate;
  readonly expectedPlanId: DailyPlanId;
  readonly itemId: PlanItemId;
  readonly expectedHeadVersion: number;
  readonly type: z.infer<typeof hostedTodayActivityType>;
  readonly occurredAt: Date;
  readonly idempotencyKey: string;
}

export interface HostedTodayGenerationInput {
  readonly authorization: HostedWorkspaceAuthorization;
  readonly date: LocalDate;
  readonly timeZone: string;
  readonly window: Readonly<{ startsAt: Date; endsAt: Date }>;
  readonly targetMinutes: number;
  readonly targetTaskCount: number;
  readonly idempotencyKey: string;
}

export interface HostedTodayServices {
  getToday(input: HostedTodayInput): Promise<CurrentDailyPlan>;
  generateToday(input: HostedTodayGenerationInput): Promise<void>;
  recordActivity(input: HostedTodayActivityInput): Promise<void>;
}

async function registerHostedTodayRoutes(
  app: FastifyInstance,
  access: HostedWorkspaceRequestAccess,
  services: HostedTodayServices,
): Promise<void> {
  app.get(HOSTED_TODAY_ROUTE, async (request) => {
    const query = parseRequest(hostedTodayQuery, request.query);
    const authorization = access.authorization(request);
    const date = localDate(query.date);
    let current: CurrentDailyPlan;
    try {
      current = await withHostedWorkspaceNotFoundRedacted(() =>
        services.getToday({ authorization, date }),
      );
    } catch (error) {
      if (error instanceof DomainError && error.code === "planning.current_not_found") {
        return { date, planId: null, headVersion: null, items: [], totalMinutes: 0 };
      }
      throw error;
    }
    return {
      date,
      planId: current.plan.id,
      headVersion: current.headVersion,
      items: current.plan.items.map(({ id, title, scheduledMinutes, activityState }) => ({
        id,
        title,
        scheduledMinutes,
        activityState,
      })),
      totalMinutes: current.plan.totalMinutes,
    };
  });

  app.post(HOSTED_TODAY_ROUTE, async (request, reply) => {
    const parsed = parseRequest(hostedTodayGenerationRequest, {
      query: request.query,
      body: request.body,
    });
    const authorization = access.authorization(request);
    const key = parseRequest(idempotencyKey, request.headers["idempotency-key"]);
    await withHostedWorkspaceNotFoundRedacted(() =>
      services.generateToday({
        authorization,
        date: localDate(parsed.query.date),
        timeZone: parsed.body.timeZone,
        window: {
          startsAt: new Date(parsed.body.window.startsAt),
          endsAt: new Date(parsed.body.window.endsAt),
        },
        targetMinutes: parsed.body.targetMinutes,
        targetTaskCount: parsed.body.targetTaskCount,
        idempotencyKey: key,
      }),
    );
    return reply.code(204).send();
  });

  app.post(HOSTED_TODAY_ACTIVITY_ROUTE, async (request, reply) => {
    const authorization = access.authorization(request);
    const params = parseRequest(hostedTodayActivityParams, request.params);
    const query = parseRequest(hostedTodayQuery, request.query);
    const body = parseRequest(hostedTodayActivityBody, request.body);
    const key = parseRequest(idempotencyKey, request.headers["idempotency-key"]);
    await withHostedWorkspaceNotFoundRedacted(() =>
      services.recordActivity({
        authorization,
        date: localDate(query.date),
        expectedPlanId: dailyPlanId(body.expectedPlanId),
        itemId: planItemId(params.itemId),
        expectedHeadVersion: body.expectedHeadVersion,
        type: body.type,
        occurredAt: new Date(body.occurredAt),
        idempotencyKey: key,
      }),
    );
    return reply.code(204).send();
  });
}

export async function registerHostedTodayBoundary(
  app: FastifyInstance,
  boundary: HostedWorkspaceBoundaryDependencies,
  services: HostedTodayServices,
): Promise<void> {
  await registerHostedWorkspaceBoundary(app, boundary, async (hosted, access) =>
    registerHostedTodayRoutes(hosted, access, services),
  );
}
