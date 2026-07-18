import type { CurrentDailyPlan, HostedWorkspaceAuthorization } from "@schedule/application";
import { DomainError, isValidLocalDate, localDate, type LocalDate } from "@schedule/domain";
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

export const HOSTED_TODAY_ROUTE = "/v1/hosted/workspaces/:workspaceId/today";

export interface HostedTodayInput {
  readonly authorization: HostedWorkspaceAuthorization;
  readonly date: LocalDate;
}

export interface HostedTodayServices {
  getToday(input: HostedTodayInput): Promise<CurrentDailyPlan>;
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
        return { date, items: [], totalMinutes: 0 };
      }
      throw error;
    }
    return {
      date,
      items: current.plan.items.map(({ title, scheduledMinutes, activityState }) => ({
        title,
        scheduledMinutes,
        activityState,
      })),
      totalMinutes: current.plan.totalMinutes,
    };
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
