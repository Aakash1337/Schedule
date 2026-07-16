import type { WorkspacePage } from "@schedule/application";
import type { UserId } from "@schedule/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  registerHostedPrincipalBoundary,
  type HostedPrincipalBoundaryDependencies,
} from "./hosted-auth-boundary.js";
import { parseRequest } from "./http-errors.js";

export const HOSTED_WORKSPACE_LIST_ROUTE = "/v1/hosted/workspaces";

const workspaceListQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(20).default(20),
  offset: z.coerce.number().int().min(0).max(1_000).default(0),
});

export interface HostedWorkspaceServices {
  listWorkspaces(input: {
    readonly userId: UserId;
    readonly limit: number;
    readonly offset: number;
  }): Promise<WorkspacePage>;
}

export async function registerHostedWorkspaceRoutes(
  app: FastifyInstance,
  boundary: HostedPrincipalBoundaryDependencies,
  services: HostedWorkspaceServices,
): Promise<void> {
  await registerHostedPrincipalBoundary(app, boundary, async (hosted, access) => {
    hosted.get(HOSTED_WORKSPACE_LIST_ROUTE, async (request) => {
      const query = parseRequest(workspaceListQuery, request.query);
      return services.listWorkspaces({
        userId: access.principal(request).userId,
        limit: query.limit,
        offset: query.offset,
      });
    });
  });
}
