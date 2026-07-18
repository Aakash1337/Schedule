import { createHmac, timingSafeEqual } from "node:crypto";

import type {
  CreateHostedWorkItemCommand,
  HostedWorkItemSyncBootstrapPage,
  HostedWorkItemSyncChangePage,
  HostedWorkspaceAuthorization,
  UpdateHostedWorkItemStatusCommand,
  WorkItemPage,
} from "@schedule/application";
import { HostedWorkItemSyncStoreError } from "@schedule/application";
import {
  DomainError,
  isValidLocalDate,
  localDate,
  workItemId,
  type WorkItem,
} from "@schedule/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  registerHostedWorkspaceBoundary,
  type HostedWorkspaceBoundaryDependencies,
  type HostedWorkspaceRequestAccess,
  withHostedWorkspaceNotFoundRedacted,
} from "./hosted-auth-boundary.js";
import { parseRequest, RequestValidationError } from "./http-errors.js";

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
const syncCursorValue = z
  .string()
  .regex(/^(0|[1-9]\d*)$/u)
  .refine((value) => BigInt(value) <= 9_223_372_036_854_775_807n);
const syncCursorToken = z
  .string()
  .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u)
  .max(1_024);
const hostedWorkItemSyncQuery = z.strictObject({
  limit: canonicalDecimal.transform(Number).pipe(z.number().int().min(1).max(200)).default(100),
  cursor: syncCursorToken.optional(),
});
const hostedWorkItemSyncChangesQuery = hostedWorkItemSyncQuery.extend({ cursor: syncCursorToken });
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
export const HOSTED_WORK_ITEM_SYNC_BOOTSTRAP_ROUTE = `${HOSTED_WORK_ITEM_COLLECTION_ROUTE}/sync/bootstrap`;
export const HOSTED_WORK_ITEM_SYNC_CHANGES_ROUTE = `${HOSTED_WORK_ITEM_COLLECTION_ROUTE}/sync/changes`;
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

export interface HostedBootstrapWorkItemSyncInput {
  readonly authorization: HostedWorkspaceAuthorization;
  readonly limit: number;
  readonly checkpoint?: string;
  readonly afterId?: WorkItem["id"];
}

export interface HostedListWorkItemSyncChangesInput {
  readonly authorization: HostedWorkspaceAuthorization;
  readonly limit: number;
  readonly afterCursor: string;
  readonly throughCursor?: string;
}

export interface HostedWorkItemServices {
  readonly syncCursorSigningKey: Uint8Array;
  createWorkItem(input: HostedCreateWorkItemInput): Promise<WorkItem>;
  listWorkItems(input: HostedListWorkItemsInput): Promise<WorkItemPage>;
  listWorkItemSnapshot(input: HostedListWorkItemSnapshotInput): Promise<WorkItemPage>;
  bootstrapWorkItemSync(
    input: HostedBootstrapWorkItemSyncInput,
  ): Promise<HostedWorkItemSyncBootstrapPage>;
  listWorkItemSyncChanges(
    input: HostedListWorkItemSyncChangesInput,
  ): Promise<HostedWorkItemSyncChangePage>;
  updateWorkItemStatus(input: HostedUpdateWorkItemStatusInput): Promise<WorkItem>;
}

const syncCheckpointToken = z.strictObject({
  v: z.literal(1),
  mode: z.literal("checkpoint"),
  workspaceId: canonicalUuid,
  cursor: syncCursorValue,
});
const syncBootstrapToken = z.strictObject({
  v: z.literal(1),
  mode: z.literal("bootstrap"),
  workspaceId: canonicalUuid,
  checkpoint: syncCursorValue,
  afterId: canonicalUuid,
});
const syncDeltaToken = z.strictObject({
  v: z.literal(1),
  mode: z.literal("delta"),
  workspaceId: canonicalUuid,
  throughCursor: syncCursorValue,
  lastCursor: syncCursorValue,
});
const hostedWorkItemSyncToken = z.discriminatedUnion("mode", [
  syncCheckpointToken,
  syncBootstrapToken,
  syncDeltaToken,
]);
type HostedWorkItemSyncToken = z.infer<typeof hostedWorkItemSyncToken>;

function invalidSyncCursor(): RequestValidationError {
  return new RequestValidationError([{ path: "cursor", message: "Invalid sync cursor." }]);
}

function encodeSyncToken(value: HostedWorkItemSyncToken, signingKey: Uint8Array): string {
  const payload = Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  const signature = createHmac("sha256", signingKey).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function decodeSyncToken(
  value: string,
  workspace: string,
  signingKey: Uint8Array,
): HostedWorkItemSyncToken {
  try {
    const [payload, signature, extra] = value.split(".");
    if (payload === undefined || signature === undefined || extra !== undefined) {
      throw new Error("Malformed token.");
    }
    const suppliedSignature = Buffer.from(signature, "base64url");
    const expectedSignature = createHmac("sha256", signingKey).update(payload).digest();
    if (
      suppliedSignature.toString("base64url") !== signature ||
      suppliedSignature.length !== expectedSignature.length ||
      !timingSafeEqual(suppliedSignature, expectedSignature)
    ) {
      throw new Error("Invalid token signature.");
    }
    const decoded = Buffer.from(payload, "base64url");
    if (decoded.toString("base64url") !== payload) throw new Error("Non-canonical token.");
    const token = hostedWorkItemSyncToken.parse(JSON.parse(decoded.toString("utf8")));
    if (
      Buffer.from(JSON.stringify(token), "utf8").toString("base64url") !== payload ||
      token.workspaceId !== workspace
    ) {
      throw new Error("Token is outside its scope.");
    }
    return token;
  } catch {
    throw invalidSyncCursor();
  }
}

async function syncOperation<Result>(operation: () => Promise<Result>): Promise<Result> {
  try {
    return await operation();
  } catch (error) {
    if (!(error instanceof HostedWorkItemSyncStoreError)) throw error;
    if (error.reason === "expired") {
      throw new DomainError(
        "hosted_sync.cursor_expired",
        "The sync cursor is no longer available. Start a fresh bootstrap.",
      );
    }
    if (error.reason === "invalid") throw invalidSyncCursor();
    throw error;
  }
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

  app.get(HOSTED_WORK_ITEM_SYNC_BOOTSTRAP_ROUTE, async (request) => {
    const authorization = access.authorization(request);
    const query = parseRequest(hostedWorkItemSyncQuery, request.query);
    const token =
      query.cursor === undefined
        ? undefined
        : decodeSyncToken(query.cursor, authorization.workspaceId, services.syncCursorSigningKey);
    if (token !== undefined && token.mode !== "bootstrap") throw invalidSyncCursor();
    const page = await withHostedWorkspaceNotFoundRedacted(() =>
      syncOperation(() =>
        services.bootstrapWorkItemSync({
          authorization,
          limit: query.limit,
          ...(token === undefined
            ? {}
            : { checkpoint: token.checkpoint, afterId: workItemId(token.afterId) }),
        }),
      ),
    );
    return {
      protocolVersion: 1,
      items: page.items.map(hostedWorkItemSnapshotProjection),
      checkpoint: encodeSyncToken(
        {
          v: 1,
          mode: "checkpoint",
          workspaceId: authorization.workspaceId,
          cursor: page.checkpoint,
        },
        services.syncCursorSigningKey,
      ),
      nextCursor:
        page.nextAfterId === null
          ? null
          : encodeSyncToken(
              {
                v: 1,
                mode: "bootstrap",
                workspaceId: authorization.workspaceId,
                checkpoint: page.checkpoint,
                afterId: page.nextAfterId,
              },
              services.syncCursorSigningKey,
            ),
    };
  });

  app.get(HOSTED_WORK_ITEM_SYNC_CHANGES_ROUTE, async (request) => {
    const authorization = access.authorization(request);
    const query = parseRequest(hostedWorkItemSyncChangesQuery, request.query);
    const token = decodeSyncToken(
      query.cursor,
      authorization.workspaceId,
      services.syncCursorSigningKey,
    );
    if (token.mode === "bootstrap") throw invalidSyncCursor();
    const page = await withHostedWorkspaceNotFoundRedacted(() =>
      syncOperation(() =>
        services.listWorkItemSyncChanges({
          authorization,
          limit: query.limit,
          afterCursor: token.mode === "checkpoint" ? token.cursor : token.lastCursor,
          ...(token.mode === "delta" ? { throughCursor: token.throughCursor } : {}),
        }),
      ),
    );
    return {
      protocolVersion: 1,
      changes: page.changes.map((change) =>
        change.type === "upsert"
          ? { type: "upsert" as const, item: hostedWorkItemSnapshotProjection(change.item) }
          : { type: "delete" as const, workItemId: change.workItemId },
      ),
      checkpoint: encodeSyncToken(
        {
          v: 1,
          mode: "checkpoint",
          workspaceId: authorization.workspaceId,
          cursor: page.throughCursor,
        },
        services.syncCursorSigningKey,
      ),
      nextCursor:
        page.nextAfterCursor === null
          ? null
          : encodeSyncToken(
              {
                v: 1,
                mode: "delta",
                workspaceId: authorization.workspaceId,
                throughCursor: page.throughCursor,
                lastCursor: page.nextAfterCursor,
              },
              services.syncCursorSigningKey,
            ),
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
  if (services.syncCursorSigningKey.byteLength !== 32) {
    throw new Error("Hosted work-item sync cursor signing key must contain 32 bytes.");
  }
  await registerHostedWorkspaceBoundary(app, boundary, async (hosted, access) =>
    registerHostedWorkItemRoutes(hosted, access, services),
  );
}
