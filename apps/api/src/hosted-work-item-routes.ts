import type {
  CreateHostedWorkItemCommand,
  HostedWorkspaceAuthorization,
} from "@schedule/application";
import { DomainError, localDate, workItemId, workspaceId, type WorkItem } from "@schedule/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  registerHostedWorkspaceBoundary,
  type HostedWorkspaceBoundaryDependencies,
  type HostedWorkspaceRequestAccess,
} from "./hosted-auth-boundary.js";
import { parseRequest } from "./http-errors.js";
import { workItemCreateBodySchema } from "./product-routes.js";

const canonicalUuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const hostedWorkspaceParams = z.strictObject({ workspaceId: canonicalUuid });

export const HOSTED_WORK_ITEM_CREATE_ROUTE = "/v1/hosted/workspaces/:workspaceId/work-items";

export interface HostedCreateWorkItemInput {
  readonly authorization: HostedWorkspaceAuthorization;
  readonly command: CreateHostedWorkItemCommand;
}

export interface HostedWorkItemServices {
  createWorkItem(input: HostedCreateWorkItemInput): Promise<WorkItem>;
}

async function registerHostedWorkItemRoutes(
  app: FastifyInstance,
  access: HostedWorkspaceRequestAccess,
  services: HostedWorkItemServices,
): Promise<void> {
  app.post(HOSTED_WORK_ITEM_CREATE_ROUTE, async (request, reply) => {
    const params = parseRequest(hostedWorkspaceParams, request.params);
    const authorization = access.authorization(request);
    const requestedWorkspaceId = workspaceId(params.workspaceId);
    if (authorization.workspaceId !== requestedWorkspaceId) {
      throw new DomainError("workspace.not_found", "The requested workspace does not exist.");
    }
    const body = parseRequest(workItemCreateBodySchema, request.body);
    let created: WorkItem;
    try {
      created = await services.createWorkItem({
        authorization,
        command: {
          parentWorkItemId:
            body.parentWorkItemId === null ? null : workItemId(body.parentWorkItemId),
          title: body.title,
          description: body.description,
          status: body.status,
          priority: body.priority,
          dueOn: body.dueOn === null ? null : localDate(body.dueOn),
          planningDurationMinutes: body.planningDurationMinutes,
        },
      });
    } catch (error) {
      if (error instanceof DomainError && error.code === "workspace.not_found") {
        throw new DomainError("workspace.not_found", "The requested workspace does not exist.");
      }
      throw error;
    }
    return reply.code(201).send(created);
  });
}

/** Dormant, inseparable composition of the hosted boundary and its work-item routes. */
export async function registerHostedWorkItemBoundary(
  app: FastifyInstance,
  boundary: HostedWorkspaceBoundaryDependencies,
  services: HostedWorkItemServices,
): Promise<void> {
  await registerHostedWorkspaceBoundary(app, boundary, async (hosted, access) =>
    registerHostedWorkItemRoutes(hosted, access, services),
  );
}
