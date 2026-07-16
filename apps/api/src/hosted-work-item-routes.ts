import type {
  CreateHostedWorkItemCommand,
  HostedWorkspaceAuthorization,
  UpdateHostedWorkItemStatusCommand,
  WorkItemPage,
} from "@schedule/application";
import { localDate, workItemId, type WorkItem } from "@schedule/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  registerHostedWorkspaceBoundary,
  type HostedWorkspaceBoundaryDependencies,
  type HostedWorkspaceRequestAccess,
  withHostedWorkspaceNotFoundRedacted,
} from "./hosted-auth-boundary.js";
import { parseRequest } from "./http-errors.js";
import { workItemCreateBodySchema } from "./product-routes.js";

const canonicalUuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const hostedWorkItemParams = z.strictObject({
  workspaceId: canonicalUuid,
  workItemId: canonicalUuid,
});
const emptyQuery = z.strictObject({});
const hostedWorkItemStatusBody = z.strictObject({
  expectedVersion: z.number().int().min(1).max(2_147_483_647),
  status: z.enum(["in_progress", "done"]),
});

export const HOSTED_WORK_ITEM_COLLECTION_ROUTE = "/v1/hosted/workspaces/:workspaceId/work-items";
export const HOSTED_WORK_ITEM_RESOURCE_ROUTE = `${HOSTED_WORK_ITEM_COLLECTION_ROUTE}/:workItemId`;

export interface HostedCreateWorkItemInput {
  readonly authorization: HostedWorkspaceAuthorization;
  readonly command: CreateHostedWorkItemCommand;
}

export interface HostedListWorkItemsInput {
  readonly authorization: HostedWorkspaceAuthorization;
}

export interface HostedUpdateWorkItemStatusInput {
  readonly authorization: HostedWorkspaceAuthorization;
  readonly command: UpdateHostedWorkItemStatusCommand;
}

export interface HostedWorkItemServices {
  createWorkItem(input: HostedCreateWorkItemInput): Promise<WorkItem>;
  listWorkItems(input: HostedListWorkItemsInput): Promise<WorkItemPage>;
  updateWorkItemStatus(input: HostedUpdateWorkItemStatusInput): Promise<WorkItem>;
}

async function registerHostedWorkItemRoutes(
  app: FastifyInstance,
  access: HostedWorkspaceRequestAccess,
  services: HostedWorkItemServices,
): Promise<void> {
  app.get(HOSTED_WORK_ITEM_COLLECTION_ROUTE, async (request) => {
    parseRequest(emptyQuery, request.query);
    const authorization = access.authorization(request);
    const page = await withHostedWorkspaceNotFoundRedacted(() =>
      services.listWorkItems({ authorization }),
    );
    return {
      items: page.items.map(({ id, title, version }) => ({ id, title, version })),
      limit: page.limit,
      offset: page.offset,
    };
  });

  app.post(HOSTED_WORK_ITEM_COLLECTION_ROUTE, async (request, reply) => {
    const authorization = access.authorization(request);
    const body = parseRequest(workItemCreateBodySchema, request.body);
    const created = await withHostedWorkspaceNotFoundRedacted(() =>
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

  app.patch(HOSTED_WORK_ITEM_RESOURCE_ROUTE, async (request, reply) => {
    const authorization = access.authorization(request);
    const params = parseRequest(hostedWorkItemParams, request.params);
    const body = parseRequest(hostedWorkItemStatusBody, request.body);
    await withHostedWorkspaceNotFoundRedacted(() =>
      services.updateWorkItemStatus({
        authorization,
        command: {
          workItemId: workItemId(params.workItemId),
          expectedVersion: body.expectedVersion,
          status: body.status,
        },
      }),
    );
    return reply.code(204).send();
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
