import assert from "node:assert/strict";

import { buildApp } from "../apps/api/src/app.js";
import { createProductServices } from "../apps/api/src/product-services.js";
import { createDatabase, PostgresUnitOfWork } from "../packages/database/src/index.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://schedule:schedule@127.0.0.1:5432/schedule";
const connection = createDatabase(databaseUrl, 2);
const lockConnection = createDatabase(databaseUrl, 1);
const observerConnection = createDatabase(databaseUrl, 1);
const app = await buildApp({
  readinessCheck: async () => {
    await connection.sql`select 1`;
  },
  productServices: createProductServices(new PostgresUnitOfWork(connection), {
    now: () => new Date("2026-07-15T07:00:00.000Z"),
  }),
});
let createdWorkspaceId: string | null = null;
let isolatedWorkspaceId: string | null = null;
let releaseConcurrencyLock: (() => void) | null = null;
let heldLock: Promise<unknown> | null = null;

function releaseHeldConcurrencyLock(): void {
  const release = releaseConcurrencyLock;
  if (release !== null) release();
  releaseConcurrencyLock = null;
}

function hasDatabaseCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

async function removeWorkspace(): Promise<void> {
  const workspaceIds = [createdWorkspaceId, isolatedWorkspaceId].filter(
    (workspaceId): workspaceId is string => workspaceId !== null,
  );
  if (workspaceIds.length === 0) return;
  await connection.sql.begin(async (sql) => {
    await sql`select set_config('schedule.allow_activity_event_mutation', 'on', true)`;
    await sql`select set_config('schedule.allow_audit_event_mutation', 'on', true)`;
    await sql`select set_config('schedule.allow_plan_interaction_event_mutation', 'on', true)`;
    await sql`select set_config('schedule.allow_plan_mutation_change', 'on', true)`;
    await sql`delete from workspaces where id = any(${workspaceIds})`;
  });
}

try {
  const ready = await app.inject({ method: "GET", url: "/health/ready" });
  assert.equal(ready.statusCode, 200);

  const workspaceResponse = await app.inject({
    method: "POST",
    url: "/v1/workspaces",
    payload: { name: "Product API verification" },
  });
  assert.equal(workspaceResponse.statusCode, 201, workspaceResponse.body);
  createdWorkspaceId = workspaceResponse.json<{ id: string }>().id;
  const workspaceListResponse = await app.inject({ method: "GET", url: "/v1/workspaces" });
  assert.equal(workspaceListResponse.statusCode, 200, workspaceListResponse.body);
  assert.equal(
    workspaceListResponse
      .json<{ items: { id: string }[] }>()
      .items.some((workspace) => workspace.id === createdWorkspaceId),
    true,
  );
  const workspaceGetResponse = await app.inject({
    method: "GET",
    url: `/v1/workspaces/${createdWorkspaceId}`,
  });
  assert.equal(workspaceGetResponse.statusCode, 200, workspaceGetResponse.body);
  const isolatedWorkspaceResponse = await app.inject({
    method: "POST",
    url: "/v1/workspaces",
    payload: { name: "Product API isolation verification" },
  });
  assert.equal(isolatedWorkspaceResponse.statusCode, 201, isolatedWorkspaceResponse.body);
  isolatedWorkspaceId = isolatedWorkspaceResponse.json<{ id: string }>().id;

  const workItemResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${createdWorkspaceId}/work-items`,
    payload: {
      title: "Ship local MVP",
      description: "Exercise the backlog and calendar vertical slice",
      status: "planned",
      priority: "urgent",
    },
  });
  assert.equal(workItemResponse.statusCode, 201, workItemResponse.body);
  const createdWorkItem = workItemResponse.json<{ id: string; version: number }>();
  const secondWorkItemResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${createdWorkspaceId}/work-items`,
    payload: { title: "Exercise stable pagination", status: "backlog", priority: "low" },
  });
  assert.equal(secondWorkItemResponse.statusCode, 201, secondWorkItemResponse.body);
  const secondWorkItem = secondWorkItemResponse.json<{ id: string; version: number }>();
  const crossWorkspaceWorkItemRead = await app.inject({
    method: "GET",
    url: `/v1/workspaces/${isolatedWorkspaceId}/work-items/${createdWorkItem.id}`,
  });
  assert.equal(crossWorkspaceWorkItemRead.statusCode, 404, crossWorkspaceWorkItemRead.body);
  const crossWorkspaceWorkItemMutation = await app.inject({
    method: "PATCH",
    url: `/v1/workspaces/${isolatedWorkspaceId}/work-items/${createdWorkItem.id}`,
    payload: { expectedVersion: 1, title: "Cross-workspace write" },
  });
  assert.equal(crossWorkspaceWorkItemMutation.statusCode, 404, crossWorkspaceWorkItemMutation.body);
  const sourceWorkItemAfterIsolationCheck = await app.inject({
    method: "GET",
    url: `/v1/workspaces/${createdWorkspaceId}/work-items/${createdWorkItem.id}`,
  });
  assert.equal(
    sourceWorkItemAfterIsolationCheck.statusCode,
    200,
    sourceWorkItemAfterIsolationCheck.body,
  );
  assert.equal(sourceWorkItemAfterIsolationCheck.json<{ title: string }>().title, "Ship local MVP");
  assert.equal(sourceWorkItemAfterIsolationCheck.json<{ version: number }>().version, 1);
  const workItemListResponse = await app.inject({
    method: "GET",
    url: `/v1/workspaces/${createdWorkspaceId}/work-items?status=planned&priority=urgent&limit=20`,
  });
  assert.equal(workItemListResponse.statusCode, 200, workItemListResponse.body);
  assert.deepEqual(
    workItemListResponse.json<{ items: { id: string }[] }>().items.map((item) => item.id),
    [createdWorkItem.id],
  );
  const allWorkItemsResponse = await app.inject({
    method: "GET",
    url: `/v1/workspaces/${createdWorkspaceId}/work-items?limit=20`,
  });
  const firstWorkItemPage = await app.inject({
    method: "GET",
    url: `/v1/workspaces/${createdWorkspaceId}/work-items?limit=1&offset=0`,
  });
  const secondWorkItemPage = await app.inject({
    method: "GET",
    url: `/v1/workspaces/${createdWorkspaceId}/work-items?limit=1&offset=1`,
  });
  const emptyWorkItemPage = await app.inject({
    method: "GET",
    url: `/v1/workspaces/${createdWorkspaceId}/work-items?limit=1&offset=2`,
  });
  assert.equal(allWorkItemsResponse.statusCode, 200, allWorkItemsResponse.body);
  assert.equal(firstWorkItemPage.statusCode, 200, firstWorkItemPage.body);
  assert.equal(secondWorkItemPage.statusCode, 200, secondWorkItemPage.body);
  assert.equal(emptyWorkItemPage.statusCode, 200, emptyWorkItemPage.body);
  assert.deepEqual(
    [
      ...firstWorkItemPage.json<{ items: { id: string }[] }>().items,
      ...secondWorkItemPage.json<{ items: { id: string }[] }>().items,
    ].map((item) => item.id),
    allWorkItemsResponse.json<{ items: { id: string }[] }>().items.map((item) => item.id),
  );
  assert.equal(emptyWorkItemPage.json<{ items: unknown[] }>().items.length, 0);
  const workItemUpdateResponse = await app.inject({
    method: "PATCH",
    url: `/v1/workspaces/${createdWorkspaceId}/work-items/${createdWorkItem.id}`,
    payload: { expectedVersion: 1, status: "in_progress", priority: "high" },
  });
  assert.equal(workItemUpdateResponse.statusCode, 200, workItemUpdateResponse.body);
  assert.equal(workItemUpdateResponse.json<{ version: number }>().version, 2);
  const staleWorkItemUpdate = await app.inject({
    method: "PATCH",
    url: `/v1/workspaces/${createdWorkspaceId}/work-items/${createdWorkItem.id}`,
    payload: { expectedVersion: 1, status: "done" },
  });
  assert.equal(staleWorkItemUpdate.statusCode, 409, staleWorkItemUpdate.body);
  const concurrentWorkItemUpdates = await Promise.all([
    app.inject({
      method: "PATCH",
      url: `/v1/workspaces/${createdWorkspaceId}/work-items/${secondWorkItem.id}`,
      payload: { expectedVersion: 1, status: "planned" },
    }),
    app.inject({
      method: "PATCH",
      url: `/v1/workspaces/${createdWorkspaceId}/work-items/${secondWorkItem.id}`,
      payload: { expectedVersion: 1, status: "done" },
    }),
  ]);
  assert.deepEqual(
    concurrentWorkItemUpdates.map((response) => response.statusCode).sort(),
    [200, 409],
  );

  const crossWorkspaceScheduleBlockCreation = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${isolatedWorkspaceId}/schedule-blocks`,
    payload: {
      workItemId: createdWorkItem.id,
      title: "Cross-workspace linked block",
      startsAt: "2026-07-15T12:00:00.000Z",
      endsAt: "2026-07-15T13:00:00.000Z",
      timeZone: "UTC",
    },
  });
  assert.equal(
    crossWorkspaceScheduleBlockCreation.statusCode,
    404,
    crossWorkspaceScheduleBlockCreation.body,
  );
  const scheduleBlockResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${createdWorkspaceId}/schedule-blocks`,
    payload: {
      workItemId: createdWorkItem.id,
      title: "MVP focus block",
      startsAt: "2026-07-15T13:00:00.000Z",
      endsAt: "2026-07-15T14:00:00.000Z",
      timeZone: "UTC",
    },
  });
  assert.equal(scheduleBlockResponse.statusCode, 201, scheduleBlockResponse.body);
  const createdScheduleBlock = scheduleBlockResponse.json<{
    id: string;
    startsAt: string;
    endsAt: string;
    version: number;
  }>();
  const crossWorkspaceScheduleBlockRead = await app.inject({
    method: "GET",
    url: `/v1/workspaces/${isolatedWorkspaceId}/schedule-blocks/${createdScheduleBlock.id}`,
  });
  assert.equal(
    crossWorkspaceScheduleBlockRead.statusCode,
    404,
    crossWorkspaceScheduleBlockRead.body,
  );
  const crossWorkspaceScheduleBlockMutation = await app.inject({
    method: "PATCH",
    url: `/v1/workspaces/${isolatedWorkspaceId}/schedule-blocks/${createdScheduleBlock.id}`,
    payload: { expectedVersion: 1, title: "Cross-workspace block write" },
  });
  assert.equal(
    crossWorkspaceScheduleBlockMutation.statusCode,
    404,
    crossWorkspaceScheduleBlockMutation.body,
  );
  const crossWorkspaceScheduleBlockDelete = await app.inject({
    method: "DELETE",
    url: `/v1/workspaces/${isolatedWorkspaceId}/schedule-blocks/${createdScheduleBlock.id}`,
    payload: { expectedVersion: 1 },
  });
  assert.equal(
    crossWorkspaceScheduleBlockDelete.statusCode,
    404,
    crossWorkspaceScheduleBlockDelete.body,
  );
  const sourceScheduleBlockAfterIsolationCheck = await app.inject({
    method: "GET",
    url: `/v1/workspaces/${createdWorkspaceId}/schedule-blocks/${createdScheduleBlock.id}`,
  });
  assert.equal(
    sourceScheduleBlockAfterIsolationCheck.statusCode,
    200,
    sourceScheduleBlockAfterIsolationCheck.body,
  );
  assert.equal(
    sourceScheduleBlockAfterIsolationCheck.json<{ title: string }>().title,
    "MVP focus block",
  );
  assert.equal(sourceScheduleBlockAfterIsolationCheck.json<{ version: number }>().version, 1);
  const overlappingBlocksResponse = await app.inject({
    method: "GET",
    url: `/v1/workspaces/${createdWorkspaceId}/schedule-blocks?from=2026-07-15T13%3A30%3A00.000Z&to=2026-07-15T14%3A30%3A00.000Z`,
  });
  assert.equal(overlappingBlocksResponse.statusCode, 200, overlappingBlocksResponse.body);
  assert.deepEqual(
    overlappingBlocksResponse.json<{ items: { id: string }[] }>().items.map((block) => block.id),
    [createdScheduleBlock.id],
  );
  const touchingBlocksResponse = await app.inject({
    method: "GET",
    url: `/v1/workspaces/${createdWorkspaceId}/schedule-blocks?from=2026-07-15T14%3A00%3A00.000Z&to=2026-07-15T15%3A00%3A00.000Z`,
  });
  assert.equal(touchingBlocksResponse.statusCode, 200, touchingBlocksResponse.body);
  assert.equal(touchingBlocksResponse.json<{ items: unknown[] }>().items.length, 0);
  const scheduleBlockUpdateResponse = await app.inject({
    method: "PATCH",
    url: `/v1/workspaces/${createdWorkspaceId}/schedule-blocks/${createdScheduleBlock.id}`,
    payload: { expectedVersion: 1, title: "Deep MVP focus", timeZone: "America/La_Paz" },
  });
  assert.equal(scheduleBlockUpdateResponse.statusCode, 200, scheduleBlockUpdateResponse.body);
  const updatedScheduleBlock = scheduleBlockUpdateResponse.json<{
    startsAt: string;
    endsAt: string;
    version: number;
  }>();
  assert.equal(updatedScheduleBlock.version, 2);
  assert.equal(updatedScheduleBlock.startsAt, createdScheduleBlock.startsAt);
  assert.equal(updatedScheduleBlock.endsAt, createdScheduleBlock.endsAt);
  const staleScheduleBlockUpdate = await app.inject({
    method: "PATCH",
    url: `/v1/workspaces/${createdWorkspaceId}/schedule-blocks/${createdScheduleBlock.id}`,
    payload: { expectedVersion: 1, title: "Stale title" },
  });
  assert.equal(staleScheduleBlockUpdate.statusCode, 409, staleScheduleBlockUpdate.body);
  const scheduleBlockDeleteResponse = await app.inject({
    method: "DELETE",
    url: `/v1/workspaces/${createdWorkspaceId}/schedule-blocks/${createdScheduleBlock.id}`,
    payload: { expectedVersion: 2 },
  });
  assert.equal(scheduleBlockDeleteResponse.statusCode, 204, scheduleBlockDeleteResponse.body);
  const [scheduleBlockAudit] = await connection.sql<
    { action: string; entity_id: string; data: { title: string; version: number } }[]
  >`
    select action, entity_id::text, data
    from audit_events
    where workspace_id = ${createdWorkspaceId}
      and action = 'schedule_block.deleted'
  `;
  assert.equal(scheduleBlockAudit?.entity_id, createdScheduleBlock.id);
  assert.deepEqual(scheduleBlockAudit?.data, {
    workItemId: createdWorkItem.id,
    title: "Deep MVP focus",
    startsAt: createdScheduleBlock.startsAt,
    endsAt: createdScheduleBlock.endsAt,
    timeZone: "America/La_Paz",
    version: 2,
    createdAt: scheduleBlockResponse.json<{ createdAt: string }>().createdAt,
    updatedAt: scheduleBlockUpdateResponse.json<{ updatedAt: string }>().updatedAt,
  });
  await assert.rejects(
    connection.sql`
      update audit_events
      set action = 'tampered'
      where workspace_id = ${createdWorkspaceId}
        and entity_id = ${createdScheduleBlock.id}
    `,
    (error) => hasDatabaseCode(error, "55000"),
  );
  await assert.rejects(
    connection.sql`
      delete from audit_events
      where workspace_id = ${createdWorkspaceId}
        and entity_id = ${createdScheduleBlock.id}
    `,
    (error) => hasDatabaseCode(error, "55000"),
  );
  await assert.rejects(
    connection.sql`delete from workspaces where id = ${createdWorkspaceId}`,
    (error) => hasDatabaseCode(error, "55000"),
  );

  const routineResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${createdWorkspaceId}/routines`,
    payload: {
      title: "API-backed routine",
      tags: {
        priority: "high",
        contexts: ["computer"],
        categories: ["verification"],
      },
      duration: { expectedMinutes: 30 },
      cadence: { period: "week", targetCompletions: 3, maximumCompletions: 4 },
    },
  });
  assert.equal(routineResponse.statusCode, 201, routineResponse.body);
  const createdRoutineId = routineResponse.json<{ id: string }>().id;
  const crossWorkspaceRoutineRead = await app.inject({
    method: "GET",
    url: `/v1/workspaces/${isolatedWorkspaceId}/routines/${createdRoutineId}`,
  });
  assert.equal(crossWorkspaceRoutineRead.statusCode, 404, crossWorkspaceRoutineRead.body);
  const crossWorkspaceRoutineMutation = await app.inject({
    method: "PATCH",
    url: `/v1/workspaces/${isolatedWorkspaceId}/routines/${createdRoutineId}`,
    payload: { expectedVersion: 1, title: "Cross-workspace routine write" },
  });
  assert.equal(crossWorkspaceRoutineMutation.statusCode, 404, crossWorkspaceRoutineMutation.body);
  const sourceRoutineAfterIsolationCheck = await app.inject({
    method: "GET",
    url: `/v1/workspaces/${createdWorkspaceId}/routines/${createdRoutineId}`,
  });
  assert.equal(
    sourceRoutineAfterIsolationCheck.statusCode,
    200,
    sourceRoutineAfterIsolationCheck.body,
  );
  assert.equal(
    sourceRoutineAfterIsolationCheck.json<{ title: string }>().title,
    "API-backed routine",
  );
  assert.equal(sourceRoutineAfterIsolationCheck.json<{ status: string }>().status, "active");
  assert.equal(sourceRoutineAfterIsolationCheck.json<{ version: number }>().version, 1);
  const crossWorkspaceRoutineActivityRead = await app.inject({
    method: "GET",
    url: `/v1/workspaces/${isolatedWorkspaceId}/routines/${createdRoutineId}/activity-events`,
  });
  assert.equal(
    crossWorkspaceRoutineActivityRead.statusCode,
    404,
    crossWorkspaceRoutineActivityRead.body,
  );
  const crossWorkspaceRoutineActivity = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${isolatedWorkspaceId}/routines/${createdRoutineId}/activity-events`,
    headers: { "idempotency-key": "cross-workspace-routine-activity" },
    payload: {
      type: "skipped",
      occurredAt: "2026-07-15T08:00:00.000Z",
      timeZone: "UTC",
    },
  });
  assert.equal(crossWorkspaceRoutineActivity.statusCode, 404, crossWorkspaceRoutineActivity.body);
  const sourceRoutineActivityAfterIsolationCheck = await app.inject({
    method: "GET",
    url: `/v1/workspaces/${createdWorkspaceId}/routines/${createdRoutineId}/activity-events`,
  });
  assert.equal(
    sourceRoutineActivityAfterIsolationCheck.statusCode,
    200,
    sourceRoutineActivityAfterIsolationCheck.body,
  );
  assert.equal(
    sourceRoutineActivityAfterIsolationCheck.json<{ items: unknown[] }>().items.length,
    0,
  );

  const listResponse = await app.inject({
    method: "GET",
    url: `/v1/workspaces/${createdWorkspaceId}/routines?status=active`,
  });
  assert.equal(listResponse.statusCode, 200, listResponse.body);
  assert.deepEqual(
    listResponse.json<{ items: { id: string }[] }>().items.map((item) => item.id),
    [createdRoutineId],
  );

  const missingReferenceResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${createdWorkspaceId}/routines/${createdRoutineId}/activity-events`,
    headers: { "idempotency-key": "missing-reference" },
    payload: {
      type: "duration_corrected",
      occurredAt: "2026-07-15T09:00:00.000Z",
      timeZone: "UTC",
      durationMinutes: 30,
      referenceEventId: "88888888-8888-4888-8888-888888888888",
    },
  });
  assert.equal(missingReferenceResponse.statusCode, 404, missingReferenceResponse.body);

  const missingWorkspaceResponse = await app.inject({
    method: "GET",
    url: "/v1/workspaces/99999999-9999-4999-8999-999999999999/routines",
  });
  assert.equal(missingWorkspaceResponse.statusCode, 404, missingWorkspaceResponse.body);

  const planRequest = {
    method: "POST",
    url: `/v1/workspaces/${createdWorkspaceId}/plans`,
    payload: {
      date: "2026-07-15",
      timeZone: "UTC",
      availableWindows: [
        {
          startsAt: "2026-07-15T08:00:00.000Z",
          endsAt: "2026-07-15T09:00:00.000Z",
        },
      ],
      targetMinutes: 30,
      targetTaskCount: 1,
      availableContexts: ["computer"],
      seed: "product-api-verification",
      requestRevision: 1,
    },
  } as const;
  const planResponse = await app.inject(planRequest);
  assert.equal(planResponse.statusCode, 200, planResponse.body);
  const plan = planResponse.json<{ id: string; items: { id: string; routineId: string }[] }>();
  assert.equal(plan.items[0]?.routineId, createdRoutineId);

  const retrievedResponse = await app.inject({
    method: "GET",
    url: `/v1/workspaces/${createdWorkspaceId}/plans/2026-07-15?revision=1`,
  });
  assert.equal(retrievedResponse.statusCode, 200, retrievedResponse.body);
  assert.equal(retrievedResponse.json<{ id: string }>().id, plan.id);

  const crossWorkspaceRevisionPlanRead = await app.inject({
    method: "GET",
    url: `/v1/workspaces/${isolatedWorkspaceId}/plans/2026-07-15?revision=1`,
  });
  assert.equal(crossWorkspaceRevisionPlanRead.statusCode, 404, crossWorkspaceRevisionPlanRead.body);

  const crossWorkspaceCurrentPlanRead = await app.inject({
    method: "GET",
    url: `/v1/workspaces/${isolatedWorkspaceId}/plans/2026-07-15/current`,
  });
  assert.equal(crossWorkspaceCurrentPlanRead.statusCode, 404, crossWorkspaceCurrentPlanRead.body);
  const crossWorkspacePlanMutation = await app.inject({
    method: "PATCH",
    url: `/v1/workspaces/${isolatedWorkspaceId}/plans/2026-07-15/items/${plan.items[0]!.id}/lock`,
    headers: { "idempotency-key": "cross-workspace-plan-lock" },
    payload: { expectedPlanId: plan.id, expectedHeadVersion: 1, locked: true },
  });
  assert.equal(crossWorkspacePlanMutation.statusCode, 404, crossWorkspacePlanMutation.body);
  const crossWorkspacePlanItemActivity = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${isolatedWorkspaceId}/plans/2026-07-15/items/${plan.items[0]!.id}/activity-events`,
    headers: { "idempotency-key": "cross-workspace-plan-item-activity" },
    payload: {
      expectedPlanId: plan.id,
      expectedHeadVersion: 1,
      type: "completed",
      occurredAt: "2026-07-15T08:30:00.000Z",
      timeZone: "UTC",
      durationMinutes: 30,
    },
  });
  assert.equal(crossWorkspacePlanItemActivity.statusCode, 404, crossWorkspacePlanItemActivity.body);
  const sourcePlanAfterIsolationCheck = await app.inject({
    method: "GET",
    url: `/v1/workspaces/${createdWorkspaceId}/plans/2026-07-15/current`,
  });
  assert.equal(sourcePlanAfterIsolationCheck.statusCode, 200, sourcePlanAfterIsolationCheck.body);
  assert.equal(sourcePlanAfterIsolationCheck.json<{ headVersion: number }>().headVersion, 1);
  assert.equal(
    sourcePlanAfterIsolationCheck.json<{
      items: { locked: boolean; activityState: string }[];
    }>().items[0]?.locked,
    false,
  );
  assert.equal(
    sourcePlanAfterIsolationCheck.json<{
      items: { locked: boolean; activityState: string }[];
    }>().items[0]?.activityState,
    "pending",
  );

  const missingGenericRevisionResponse = await app.inject({
    ...planRequest,
    payload: {
      ...planRequest.payload,
      seed: "product-api-forbidden-generic-revision",
      requestRevision: 2,
    },
  });
  assert.equal(missingGenericRevisionResponse.statusCode, 409, missingGenericRevisionResponse.body);
  assert.equal(
    missingGenericRevisionResponse.json<{ error: { code: string } }>().error.code,
    "planning.revision_creation_conflict",
  );

  const currentPlanResponse = await app.inject({
    method: "GET",
    url: `/v1/workspaces/${createdWorkspaceId}/plans/2026-07-15/current`,
  });
  assert.equal(currentPlanResponse.statusCode, 200, currentPlanResponse.body);
  assert.equal(currentPlanResponse.json<{ headVersion: number }>().headVersion, 1);
  const lockRequest = {
    method: "PATCH" as const,
    url: `/v1/workspaces/${createdWorkspaceId}/plans/2026-07-15/items/${plan.items[0]!.id}/lock`,
    headers: { "idempotency-key": "product-api-lock" },
    payload: { expectedPlanId: plan.id, expectedHeadVersion: 1, locked: true },
  };
  const lockResponse = await app.inject(lockRequest);
  const retriedLockResponse = await app.inject(lockRequest);
  assert.equal(lockResponse.statusCode, 200, lockResponse.body);
  assert.equal(retriedLockResponse.statusCode, 200, retriedLockResponse.body);
  assert.deepEqual(retriedLockResponse.json(), lockResponse.json());
  assert.equal(lockResponse.json<{ headVersion: number }>().headVersion, 2);
  const planInteractionAuditBeforeConflict = await connection.sql<
    { count: number; resultHeadVersion: number }[]
  >`
    select count(*)::int as count, max(result_head_version)::int as "resultHeadVersion"
    from plan_interaction_events
    where workspace_id = ${createdWorkspaceId}
      and idempotency_key = 'product-api-lock'
  `;
  assert.equal(planInteractionAuditBeforeConflict.length, 1);
  assert.equal(planInteractionAuditBeforeConflict[0]?.count, 1);
  assert.equal(planInteractionAuditBeforeConflict[0]?.resultHeadVersion, 2);
  const changedPayloadLockConflict = await app.inject({
    ...lockRequest,
    payload: { ...lockRequest.payload, locked: false },
  });
  assert.equal(changedPayloadLockConflict.statusCode, 409, changedPayloadLockConflict.body);
  assert.equal(
    changedPayloadLockConflict.json<{ error: { code: string } }>().error.code,
    "planning.idempotency_conflict",
  );
  const sourcePlanAfterIdempotencyConflict = await app.inject({
    method: "GET",
    url: `/v1/workspaces/${createdWorkspaceId}/plans/2026-07-15/current`,
  });
  assert.equal(
    sourcePlanAfterIdempotencyConflict.statusCode,
    200,
    sourcePlanAfterIdempotencyConflict.body,
  );
  assert.equal(sourcePlanAfterIdempotencyConflict.json<{ headVersion: number }>().headVersion, 2);
  assert.equal(
    sourcePlanAfterIdempotencyConflict.json<{ items: { locked: boolean }[] }>().items[0]?.locked,
    true,
  );
  const planInteractionAuditAfterConflict = await connection.sql<
    { count: number; resultHeadVersion: number }[]
  >`
    select count(*)::int as count, max(result_head_version)::int as "resultHeadVersion"
    from plan_interaction_events
    where workspace_id = ${createdWorkspaceId}
      and idempotency_key = 'product-api-lock'
  `;
  assert.equal(planInteractionAuditAfterConflict.length, 1);
  assert.equal(planInteractionAuditAfterConflict[0]?.count, 1);
  assert.equal(planInteractionAuditAfterConflict[0]?.resultHeadVersion, 2);
  const staleLockResponse = await app.inject({
    ...lockRequest,
    headers: { "idempotency-key": "product-api-stale-lock" },
  });
  assert.equal(staleLockResponse.statusCode, 409, staleLockResponse.body);
  const currentLockedResponse = await app.inject({
    method: "GET",
    url: `/v1/workspaces/${createdWorkspaceId}/plans/2026-07-15/current`,
  });
  assert.equal(currentLockedResponse.statusCode, 200, currentLockedResponse.body);
  assert.equal(currentLockedResponse.json<{ headVersion: number }>().headVersion, 2);
  assert.equal(
    currentLockedResponse.json<{ items: { locked: boolean }[] }>().items[0]?.locked,
    true,
  );

  const mutationRequest = {
    timeZone: "UTC",
    availableWindows: [
      {
        startsAt: "2026-07-15T08:00:00.000Z",
        endsAt: "2026-07-15T09:00:00.000Z",
      },
    ],
    targetMinutes: 30,
    targetTaskCount: 1,
    availableContexts: ["computer"],
    seed: "product-api-regeneration",
  };
  const regenerationRequest = {
    method: "POST" as const,
    url: `/v1/workspaces/${createdWorkspaceId}/plans/2026-07-15/regenerations`,
    headers: { "idempotency-key": "product-api-regeneration" },
    payload: {
      expectedPlanId: plan.id,
      expectedHeadVersion: 2,
      request: mutationRequest,
    },
  };
  const crossWorkspacePlanRegeneration = await app.inject({
    ...regenerationRequest,
    url: `/v1/workspaces/${isolatedWorkspaceId}/plans/2026-07-15/regenerations`,
    headers: { "idempotency-key": "cross-workspace-plan-regeneration" },
  });
  assert.equal(crossWorkspacePlanRegeneration.statusCode, 404, crossWorkspacePlanRegeneration.body);
  const sourcePlanAfterCrossWorkspaceRegeneration = await app.inject({
    method: "GET",
    url: `/v1/workspaces/${createdWorkspaceId}/plans/2026-07-15/current`,
  });
  assert.equal(
    sourcePlanAfterCrossWorkspaceRegeneration.statusCode,
    200,
    sourcePlanAfterCrossWorkspaceRegeneration.body,
  );
  assert.equal(
    sourcePlanAfterCrossWorkspaceRegeneration.json<{ headVersion: number }>().headVersion,
    2,
  );
  const regenerationResponse = await app.inject(regenerationRequest);
  const retriedRegeneration = await app.inject(regenerationRequest);
  assert.equal(regenerationResponse.statusCode, 200, regenerationResponse.body);
  assert.deepEqual(retriedRegeneration.json(), regenerationResponse.json());
  const regenerated = regenerationResponse.json<{
    id: string;
    headVersion: number;
    requestRevision: number;
    items: { id: string; routineId: string; locked: boolean }[];
  }>();
  assert.equal(regenerated.headVersion, 3);
  assert.equal(regenerated.requestRevision, 2);
  assert.notEqual(regenerationResponse.json<{ request: unknown }>().request, null);
  assert.equal(regenerated.items[0]?.routineId, createdRoutineId);
  assert.equal(regenerated.items[0]?.locked, true);

  const unlockResponse = await app.inject({
    method: "PATCH",
    url: `/v1/workspaces/${createdWorkspaceId}/plans/2026-07-15/items/${regenerated.items[0]!.id}/lock`,
    headers: { "idempotency-key": "product-api-unlock-regenerated" },
    payload: { expectedPlanId: regenerated.id, expectedHeadVersion: 3, locked: false },
  });
  assert.equal(unlockResponse.statusCode, 200, unlockResponse.body);

  const alternativeRoutineResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${createdWorkspaceId}/routines`,
    payload: {
      title: "Replacement routine",
      tags: { priority: "medium", contexts: ["computer"], categories: ["verification"] },
      duration: { expectedMinutes: 30 },
      cadence: { period: "week", targetCompletions: 1 },
    },
  });
  assert.equal(alternativeRoutineResponse.statusCode, 201, alternativeRoutineResponse.body);
  const alternativeRoutineId = alternativeRoutineResponse.json<{ id: string }>().id;
  const crossWorkspacePlanReplacement = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${isolatedWorkspaceId}/plans/2026-07-15/items/${regenerated.items[0]!.id}/replacement`,
    headers: { "idempotency-key": "cross-workspace-plan-replacement" },
    payload: {
      expectedPlanId: regenerated.id,
      expectedHeadVersion: 4,
      request: { ...mutationRequest, seed: "cross-workspace-plan-replacement" },
    },
  });
  assert.equal(crossWorkspacePlanReplacement.statusCode, 404, crossWorkspacePlanReplacement.body);
  const sourcePlanAfterCrossWorkspaceReplacement = await app.inject({
    method: "GET",
    url: `/v1/workspaces/${createdWorkspaceId}/plans/2026-07-15/current`,
  });
  assert.equal(
    sourcePlanAfterCrossWorkspaceReplacement.statusCode,
    200,
    sourcePlanAfterCrossWorkspaceReplacement.body,
  );
  const unchangedBeforeReplacement = sourcePlanAfterCrossWorkspaceReplacement.json<{
    headVersion: number;
    items: { routineId: string; locked: boolean }[];
  }>();
  assert.equal(unchangedBeforeReplacement.headVersion, 4);
  assert.equal(unchangedBeforeReplacement.items[0]?.routineId, createdRoutineId);
  assert.equal(unchangedBeforeReplacement.items[0]?.locked, false);
  const replacementResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${createdWorkspaceId}/plans/2026-07-15/items/${regenerated.items[0]!.id}/replacement`,
    headers: { "idempotency-key": "product-api-replacement" },
    payload: {
      expectedPlanId: regenerated.id,
      expectedHeadVersion: 4,
      request: { ...mutationRequest, seed: "product-api-replacement" },
    },
  });
  assert.equal(replacementResponse.statusCode, 200, replacementResponse.body);
  const replacement = replacementResponse.json<{
    id: string;
    headVersion: number;
    requestRevision: number;
    items: { id: string; routineId: string }[];
  }>();
  assert.equal(replacement.headVersion, 5);
  assert.equal(replacement.requestRevision, 3);
  assert.equal(replacement.items[0]?.routineId, alternativeRoutineId);

  const planItemActivityRequest = {
    method: "POST" as const,
    url: `/v1/workspaces/${createdWorkspaceId}/plans/2026-07-15/items/${replacement.items[0]!.id}/activity-events`,
    headers: { "idempotency-key": "product-api-plan-item-completion" },
    payload: {
      expectedPlanId: replacement.id,
      expectedHeadVersion: 5,
      type: "completed",
      occurredAt: "2026-07-15T09:30:00.000Z",
      timeZone: "UTC",
      durationMinutes: 29,
      metadata: { source: "today" },
    },
  };
  const planItemActivityResponse = await app.inject(planItemActivityRequest);
  const retriedPlanItemActivity = await app.inject(planItemActivityRequest);
  assert.equal(planItemActivityResponse.statusCode, 200, planItemActivityResponse.body);
  assert.deepEqual(retriedPlanItemActivity.json(), planItemActivityResponse.json());
  const planItemActivity = planItemActivityResponse.json<{
    activityState: string;
    headVersion: number;
    activityEvent: { id: string; planId: string; planItemId: string; routineId: string };
  }>();
  assert.equal(planItemActivity.activityState, "completed");
  assert.equal(planItemActivity.headVersion, 6);
  assert.equal(planItemActivity.activityEvent.planId, replacement.id);
  assert.equal(planItemActivity.activityEvent.planItemId, replacement.items[0]!.id);
  assert.equal(planItemActivity.activityEvent.routineId, alternativeRoutineId);
  const projectedActivityResponse = await app.inject({
    method: "GET",
    url: `/v1/workspaces/${createdWorkspaceId}/plans/2026-07-15/current`,
  });
  assert.equal(projectedActivityResponse.statusCode, 200, projectedActivityResponse.body);
  const projectedActivity = projectedActivityResponse.json<{
    headVersion: number;
    items: { activityState: string; lastActivityEventId: string | null }[];
  }>();
  assert.equal(projectedActivity.headVersion, 6);
  assert.equal(projectedActivity.items[0]?.activityState, "completed");
  assert.equal(projectedActivity.items[0]?.lastActivityEventId, planItemActivity.activityEvent.id);
  const unsupportedPlanItemReversal = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${createdWorkspaceId}/routines/${alternativeRoutineId}/activity-events`,
    headers: { "idempotency-key": "product-api-plan-item-reversal" },
    payload: {
      type: "completion_reversed",
      occurredAt: "2026-07-15T09:45:00.000Z",
      timeZone: "UTC",
      referenceEventId: planItemActivity.activityEvent.id,
    },
  });
  assert.equal(unsupportedPlanItemReversal.statusCode, 422, unsupportedPlanItemReversal.body);
  assert.equal(
    unsupportedPlanItemReversal.json<{ error: { code: string } }>().error.code,
    "planning.item_activity_reversal_requires_item_flow",
  );
  await assert.rejects(
    connection.sql`
      insert into activity_events (
        workspace_id,
        routine_id,
        type,
        occurred_at,
        local_date,
        time_zone,
        reference_event_id,
        idempotency_key,
        recorded_at
      ) values (
        ${createdWorkspaceId},
        ${alternativeRoutineId},
        'completion_reversed',
        '2026-07-15T09:46:00.000Z',
        '2026-07-15',
        'UTC',
        ${planItemActivity.activityEvent.id},
        'invalid-unattributed-plan-item-reversal',
        '2026-07-15T09:46:00.000Z'
      )
    `,
    (error) => hasDatabaseCode(error, "23514"),
  );
  const invalidTerminalTransition = await app.inject({
    ...planItemActivityRequest,
    headers: { "idempotency-key": "product-api-plan-item-restart" },
    payload: {
      ...planItemActivityRequest.payload,
      expectedHeadVersion: 6,
      type: "started",
      durationMinutes: null,
    },
  });
  assert.equal(invalidTerminalTransition.statusCode, 422, invalidTerminalTransition.body);
  assert.equal(
    invalidTerminalTransition.json<{ error: { code: string } }>().error.code,
    "planning.item_activity_transition_invalid",
  );
  const planItemReversalRequest = {
    ...planItemActivityRequest,
    headers: { "idempotency-key": "product-api-plan-item-reversal-audited" },
    payload: {
      ...planItemActivityRequest.payload,
      expectedHeadVersion: 6,
      type: "completion_reversed",
      occurredAt: "2026-07-15T09:50:00.000Z",
      durationMinutes: null,
    },
  };
  const planItemReversalResponse = await app.inject(planItemReversalRequest);
  const retriedPlanItemReversal = await app.inject(planItemReversalRequest);
  assert.equal(planItemReversalResponse.statusCode, 200, planItemReversalResponse.body);
  assert.deepEqual(retriedPlanItemReversal.json(), planItemReversalResponse.json());
  const planItemReversal = planItemReversalResponse.json<{
    activityState: string;
    headVersion: number;
    activityEvent: { id: string; type: string; referenceEventId: string | null };
  }>();
  assert.equal(planItemReversal.activityState, "pending");
  assert.equal(planItemReversal.headVersion, 7);
  assert.equal(planItemReversal.activityEvent.type, "completion_reversed");
  assert.equal(planItemReversal.activityEvent.referenceEventId, planItemActivity.activityEvent.id);
  const reopenedActivityResponse = await app.inject({
    method: "GET",
    url: `/v1/workspaces/${createdWorkspaceId}/plans/2026-07-15/current`,
  });
  assert.equal(reopenedActivityResponse.statusCode, 200, reopenedActivityResponse.body);
  const reopenedActivity = reopenedActivityResponse.json<{
    headVersion: number;
    items: { activityState: string; lastActivityEventId: string | null }[];
  }>();
  assert.equal(reopenedActivity.headVersion, 7);
  assert.equal(reopenedActivity.items[0]?.activityState, "pending");
  assert.equal(reopenedActivity.items[0]?.lastActivityEventId, planItemReversal.activityEvent.id);
  await assert.rejects(
    connection.sql`
      update daily_plan_item_states
      set activity_state = 'skipped'
      where workspace_id = ${createdWorkspaceId}
        and plan_id = ${replacement.id}
        and item_id = ${replacement.items[0]!.id}
    `,
    (error) => hasDatabaseCode(error, "23514"),
  );
  await assert.rejects(
    connection.sql`
      update plan_interaction_events
      set result_head_version = 999
      where workspace_id = ${createdWorkspaceId}
        and idempotency_key = 'product-api-plan-item-reversal-audited'
    `,
    (error) => hasDatabaseCode(error, "55000"),
  );

  const activityRequest = {
    method: "POST" as const,
    url: `/v1/workspaces/${createdWorkspaceId}/routines/${createdRoutineId}/activity-events`,
    headers: { "idempotency-key": "product-api-completion" },
    payload: {
      type: "completed",
      occurredAt: "2026-07-15T10:00:00.000Z",
      timeZone: "UTC",
      durationMinutes: 31,
      metadata: { z: "last", a: "first" },
    },
  };
  const completionResponse = await app.inject(activityRequest);
  const retriedCompletionResponse = await app.inject({
    ...activityRequest,
    payload: { ...activityRequest.payload, metadata: { a: "first", z: "last" } },
  });
  assert.equal(completionResponse.statusCode, 200, completionResponse.body);
  assert.equal(retriedCompletionResponse.statusCode, 200, retriedCompletionResponse.body);
  assert.equal("idempotencyKey" in completionResponse.json<Record<string, unknown>>(), false);
  assert.equal(
    completionResponse.json<{ id: string }>().id,
    retriedCompletionResponse.json<{ id: string }>().id,
  );

  const conflictingCompletion = await app.inject({
    ...activityRequest,
    payload: { ...activityRequest.payload, durationMinutes: 99 },
  });
  assert.equal(conflictingCompletion.statusCode, 409, conflictingCompletion.body);

  const appendActivity = async (key: string, type: "skipped" | "deferred", hour: number) => {
    const response = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${createdWorkspaceId}/routines/${createdRoutineId}/activity-events`,
      headers: { "idempotency-key": key },
      payload: {
        type,
        occurredAt: `2026-07-15T${String(hour).padStart(2, "0")}:00:00.000Z`,
        timeZone: "UTC",
      },
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json<{ id: string }>().id;
  };
  const secondEventId = await appendActivity("product-api-skipped", "skipped", 11);
  const thirdEventId = await appendActivity("product-api-deferred", "deferred", 12);
  const firstHistoryResponse = await app.inject({
    method: "GET",
    url: `/v1/workspaces/${createdWorkspaceId}/routines/${createdRoutineId}/activity-events?limit=2`,
  });
  assert.equal(firstHistoryResponse.statusCode, 200, firstHistoryResponse.body);
  const firstHistory = firstHistoryResponse.json<{
    items: { id: string; idempotencyKey?: string }[];
    page: { nextCursor: string | null };
  }>();
  assert.deepEqual(
    firstHistory.items.map((item) => item.id),
    [thirdEventId, secondEventId],
  );
  assert.equal("idempotencyKey" in firstHistory.items[0]!, false);
  assert.notEqual(firstHistory.page.nextCursor, null);

  const laterEventId = await appendActivity("product-api-later", "skipped", 13);
  const secondHistoryResponse = await app.inject({
    method: "GET",
    url: `/v1/workspaces/${createdWorkspaceId}/routines/${createdRoutineId}/activity-events?limit=2&cursor=${encodeURIComponent(firstHistory.page.nextCursor!)}`,
  });
  assert.equal(secondHistoryResponse.statusCode, 200, secondHistoryResponse.body);
  const secondHistory = secondHistoryResponse.json<{
    items: { id: string }[];
    page: { nextCursor: string | null };
  }>();
  assert.deepEqual(
    secondHistory.items.map((item) => item.id),
    [completionResponse.json<{ id: string }>().id],
  );
  assert.equal(
    secondHistory.items.some((item) => item.id === laterEventId),
    false,
  );
  assert.equal(secondHistory.page.nextCursor, null);

  let markLockAcquired: () => void = () => undefined;
  const lockAcquired = new Promise<void>((resolve) => {
    markLockAcquired = resolve;
  });
  const releaseLock = new Promise<void>((resolve) => {
    releaseConcurrencyLock = resolve;
  });
  const lockKey = `${createdWorkspaceId}:${createdRoutineId}`;
  heldLock = lockConnection.sql.begin(async (sql) => {
    await sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
    markLockAcquired();
    await releaseLock;
  });
  await lockAcquired;
  const [sequenceBefore] = await observerConnection.sql<{ value: string }[]>`
    select last_value::text as value from activity_events_ingested_sequence_seq
  `;
  const blockedAppend = app.inject({
    method: "POST",
    url: `/v1/workspaces/${createdWorkspaceId}/routines/${createdRoutineId}/activity-events`,
    headers: { "idempotency-key": "product-api-lock-order" },
    payload: {
      type: "deferred",
      occurredAt: "2026-07-15T14:00:00.000Z",
      timeZone: "UTC",
    },
  });
  let waiterObserved = false;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const [waiters] = await observerConnection.sql<{ value: number }[]>`
      select count(*)::int as value
      from pg_locks
      where locktype = 'advisory' and not granted
    `;
    if ((waiters?.value ?? 0) > 0) {
      waiterObserved = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(waiterObserved, true, "activity append did not wait for its routine lock");
  const [sequenceWhileBlocked] = await observerConnection.sql<{ value: string }[]>`
    select last_value::text as value from activity_events_ingested_sequence_seq
  `;
  assert.equal(sequenceWhileBlocked?.value, sequenceBefore?.value);
  releaseHeldConcurrencyLock();
  await heldLock;
  heldLock = null;
  const orderedAppendResponse = await blockedAppend;
  assert.equal(orderedAppendResponse.statusCode, 200, orderedAppendResponse.body);

  const updateResponse = await app.inject({
    method: "PATCH",
    url: `/v1/workspaces/${createdWorkspaceId}/routines/${createdRoutineId}`,
    payload: {
      expectedVersion: 1,
      title: "Updated API-backed routine",
      status: "paused",
    },
  });
  assert.equal(updateResponse.statusCode, 200, updateResponse.body);
  const updatedRoutine = updateResponse.json<{ title: string; status: string; version: number }>();
  assert.equal(updatedRoutine.title, "Updated API-backed routine");
  assert.equal(updatedRoutine.status, "paused");
  assert.equal(updatedRoutine.version, 2);
  const getRoutineResponse = await app.inject({
    method: "GET",
    url: `/v1/workspaces/${createdWorkspaceId}/routines/${createdRoutineId}`,
  });
  assert.equal(getRoutineResponse.statusCode, 200, getRoutineResponse.body);
  assert.equal(getRoutineResponse.json<{ version: number }>().version, 2);
  const staleUpdateResponse = await app.inject({
    method: "PATCH",
    url: `/v1/workspaces/${createdWorkspaceId}/routines/${createdRoutineId}`,
    payload: { expectedVersion: 1, status: "active" },
  });
  assert.equal(staleUpdateResponse.statusCode, 409, staleUpdateResponse.body);
  assert.equal(
    staleUpdateResponse.json<{ error: { code: string } }>().error.code,
    "routine.version_conflict",
  );
  const missingRoutineResponse = await app.inject({
    method: "GET",
    url: `/v1/workspaces/${createdWorkspaceId}/routines/77777777-7777-4777-8777-777777777777`,
  });
  assert.equal(missingRoutineResponse.statusCode, 404, missingRoutineResponse.body);

  const stalePlanRevision = await app.inject(planRequest);
  assert.equal(stalePlanRevision.statusCode, 409, stalePlanRevision.body);
  assert.equal(
    stalePlanRevision.json<{ error: { code: string } }>().error.code,
    "planning.revision_conflict",
  );

  process.stdout.write("product API verification passed\n");
} finally {
  releaseHeldConcurrencyLock();
  if (heldLock !== null) await heldLock.catch(() => undefined);
  await Promise.all([app.close(), lockConnection.close(), observerConnection.close()]);
  await removeWorkspace();
  await connection.close();
}
