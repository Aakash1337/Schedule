import type {
  CreateHostedWorkItemCommand,
  HostedWorkspaceAuthorization,
  WorkItemPage,
} from "@schedule/application";
import { DomainError, localDate, workItemId, workspaceId, type WorkItem } from "@schedule/domain";
import type { FastifyInstance, FastifyRequest } from "fastify";
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
const emptyQuery = z.strictObject({});

export const HOSTED_WORK_ITEM_COLLECTION_ROUTE = "/v1/hosted/workspaces/:workspaceId/work-items";

export interface HostedCreateWorkItemInput {
  readonly authorization: HostedWorkspaceAuthorization;
  readonly command: CreateHostedWorkItemCommand;
}

export interface HostedListWorkItemsInput {
  readonly authorization: HostedWorkspaceAuthorization;
}

export interface HostedWorkItemServices {
  createWorkItem(input: HostedCreateWorkItemInput): Promise<WorkItem>;
  listWorkItems(input: HostedListWorkItemsInput): Promise<WorkItemPage>;
}

function requestAuthorization(
  request: FastifyRequest,
  access: HostedWorkspaceRequestAccess,
): HostedWorkspaceAuthorization {
  const params = parseRequest(hostedWorkspaceParams, request.params);
  const authorization = access.authorization(request);
  if (authorization.workspaceId !== workspaceId(params.workspaceId)) {
    throw new DomainError("workspace.not_found", "The requested workspace does not exist.");
  }
  return authorization;
}

async function withWorkspaceNotFoundRedacted<Result>(
  operation: () => Promise<Result>,
): Promise<Result> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof DomainError && error.code === "workspace.not_found") {
      throw new DomainError("workspace.not_found", "The requested workspace does not exist.");
    }
    throw error;
  }
}

async function registerHostedWorkItemRoutes(
  app: FastifyInstance,
  access: HostedWorkspaceRequestAccess,
  services: HostedWorkItemServices,
): Promise<void> {
  app.get(HOSTED_WORK_ITEM_COLLECTION_ROUTE, async (request) => {
    parseRequest(emptyQuery, request.query);
    const authorization = requestAuthorization(request, access);
    const page = await withWorkspaceNotFoundRedacted(() =>
      services.listWorkItems({ authorization }),
    );
    return {
      items: page.items.map(({ id, title }) => ({ id, title })),
      limit: page.limit,
      offset: page.offset,
    };
  });

  app.post(HOSTED_WORK_ITEM_COLLECTION_ROUTE, async (request, reply) => {
    const authorization = requestAuthorization(request, access);
    const body = parseRequest(workItemCreateBodySchema, request.body);
    const created = await withWorkspaceNotFoundRedacted(() =>
      services.createWorkItem({
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
      }),
    );
    return reply.code(201).send(created);
  });
}

/** Inseparable composition of the hosted boundary and its work-item routes. */
export async function registerHostedWorkItemBoundary(
  app: FastifyInstance,
  boundary: HostedWorkspaceBoundaryDependencies,
  services: HostedWorkItemServices,
): Promise<void> {
  await registerHostedWorkspaceBoundary(app, boundary, async (hosted, access) =>
    registerHostedWorkItemRoutes(hosted, access, services),
  );
}
