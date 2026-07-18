import type {
  CreateHostedWorkItemCommand,
  HostedWorkspaceAuthorization,
  UpdateHostedWorkItemStatusCommand,
  WorkItemPage,
} from "@schedule/application";
import { isValidLocalDate, localDate, workItemId, type WorkItem } from "@schedule/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  registerHostedWorkspaceBoundary,
  type HostedWorkspaceBoundaryDependencies,
  type HostedWorkspaceRequestAccess,
  withHostedWorkspaceNotFoundRedacted,
} from "./hosted-auth-boundary.js";
import { parseRequest } from "./http-errors.js";

const canonicalUuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const hostedWorkItemParams = z.strictObject({
  workspaceId: canonicalUuid,
  workItemId: canonicalUuid,
});
const emptyQuery = z.strictObject({});
const canonicalDecimal = z.string().regex(/^(0|[1-9]\d*)$/u);
const hostedWorkItemSnapshotQuery = z.strictObject({
  limit: canonicalDecimal.transform(Number).pipe(z.number().int().min(1).max(200)).default(100),
  offset: canonicalDecimal
    .transform(Number)
    .pipe(z.number().int().min(0).max(1_000_000))
    .default(0),
});
const hostedWorkItemCreateBody = z.strictObject({
  title: z.string().trim().min(1).max(240),
  priority: z.enum(["none", "low", "medium", "high", "urgent"]).default("none"),
  dueOn: z
    .string()
    .refine(isValidLocalDate, "Expected a valid Gregorian date in YYYY-MM-DD format.")
    .nullable()
    .default(null),
  planningDurationMinutes: z.number().int().positive().max(43_200).nullable().default(null),
});
const hostedWorkItemStatusBody = z.strictObject({
  expectedVersion: z.number().int().min(1).max(2_147_483_647),
  status: z.enum(["in_progress", "done"]),
});

export const HOSTED_WORK_ITEM_COLLECTION_ROUTE = "/v1/hosted/workspaces/:workspaceId/work-items";
export const HOSTED_WORK_ITEM_SNAPSHOT_ROUTE = `${HOSTED_WORK_ITEM_COLLECTION_ROUTE}/snapshot`;
export const HOSTED_WORK_ITEM_RESOURCE_ROUTE = `${HOSTED_WORK_ITEM_COLLECTION_ROUTE}/:workItemId`;

export interface HostedCreateWorkItemInput {
  readonly authorization: HostedWorkspaceAuthorization;
  readonly command: CreateHostedWorkItemCommand;
}

export interface HostedListWorkItemsInput {
  readonly authorization: HostedWorkspaceAuthorization;
}

export interface HostedListWorkItemSnapshotInput {
  readonly authorization: HostedWorkspaceAuthorization;
  readonly limit: number;
  readonly offset: number;
}

export interface HostedUpdateWorkItemStatusInput {
  readonly authorization: HostedWorkspaceAuthorization;
  readonly command: UpdateHostedWorkItemStatusCommand;
}

export interface HostedWorkItemServices {
  createWorkItem(input: HostedCreateWorkItemInput): Promise<WorkItem>;
  listWorkItems(input: HostedListWorkItemsInput): Promise<WorkItemPage>;
  listWorkItemSnapshot(input: HostedListWorkItemSnapshotInput): Promise<WorkItemPage>;
  updateWorkItemStatus(input: HostedUpdateWorkItemStatusInput): Promise<WorkItem>;
}

function hostedWorkItemProjection(item: WorkItem) {
  const { id, title, version, priority, dueOn, planningDurationMinutes } = item;
  return { id, title, version, priority, dueOn, planningDurationMinutes };
}

function hostedWorkItemSnapshotProjection(item: WorkItem) {
  const {
    id,
    parentWorkItemId,
    title,
    description,
    status,
    priority,
    dueOn,
    planningDurationMinutes,
    version,
    createdAt,
    updatedAt,
  } = item;
  return {
    id,
    parentWorkItemId,
    title,
    description,
    status,
    priority,
    dueOn,
    planningDurationMinutes,
    version,
    createdAt: createdAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
  };
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
      items: page.items.map(hostedWorkItemProjection),
      limit: page.limit,
      offset: page.offset,
    };
  });

  app.get(HOSTED_WORK_ITEM_SNAPSHOT_ROUTE, async (request) => {
    const query = parseRequest(hostedWorkItemSnapshotQuery, request.query);
    const authorization = access.authorization(request);
    const page = await withHostedWorkspaceNotFoundRedacted(() =>
      services.listWorkItemSnapshot({
        authorization,
        limit: query.limit,
        offset: query.offset,
      }),
    );
    return {
      items: page.items.map(hostedWorkItemSnapshotProjection),
      limit: page.limit,
      offset: page.offset,
    };
  });

  app.post(HOSTED_WORK_ITEM_COLLECTION_ROUTE, async (request, reply) => {
    const authorization = access.authorization(request);
    const body = parseRequest(hostedWorkItemCreateBody, request.body);
    const created = await withHostedWorkspaceNotFoundRedacted(() =>
      services.createWorkItem({
        authorization,
        command: {
          parentWorkItemId: null,
          title: body.title,
          description: null,
          status: "backlog",
          priority: body.priority,
          dueOn: body.dueOn === null ? null : localDate(body.dueOn),
          planningDurationMinutes: body.planningDurationMinutes,
        },
      }),
    );
    return reply.code(201).send(hostedWorkItemProjection(created));
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
