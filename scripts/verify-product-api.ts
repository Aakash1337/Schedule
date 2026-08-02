import assert from "node:assert/strict";

import { buildApp } from "../apps/api/src/app.js";
import { createProductServices } from "../apps/api/src/product-services.js";
import { createDatabase, PostgresUnitOfWork } from "../packages/database/src/index.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://schedule:schedule@127.0.0.1:5432/schedule";
const connection = createDatabase(databaseUrl, 2);
const lockConnection = createDatabase(databaseUrl, 1);
const observerConnection = createDatabase(databaseUrl, 1);
const productClockBaseline = new Date("2026-07-15T07:00:00.000Z");
let productClockNow = new Date(productClockBaseline.getTime());
const app = await buildApp({
  readinessCheck: async () => {
    await connection.sql`select 1`;
  },
  productServices: createProductServices(new PostgresUnitOfWork(connection), {
    now: () => new Date(productClockNow.getTime()),
  }),
  productApiAccess: { mode: "local_unauthenticated" },
});
let createdWorkspaceId: string | null = null;
let isolatedWorkspaceId: string | null = null;
let feedbackWorkspaceId: string | null = null;
let routineGroupWorkspaceId: string | null = null;
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

function hasDatabaseConstraint(error: unknown, code: string, constraintName: string): boolean {
  return (
    hasDatabaseCode(error, code) &&
    typeof error === "object" &&
    error !== null &&
    "constraint_name" in error &&
    (error as { constraint_name?: unknown }).constraint_name === constraintName
  );
}

async function removeWorkspace(): Promise<void> {
  const workspaceIds = [
    createdWorkspaceId,
    isolatedWorkspaceId,
    feedbackWorkspaceId,
    routineGroupWorkspaceId,
  ].filter((workspaceId): workspaceId is string => workspaceId !== null);
  if (workspaceIds.length === 0) return;
  await connection.sql.begin(async (sql) => {
    await sql`select set_config('schedule.allow_activity_event_mutation', 'on', true)`;
    await sql`select set_config('schedule.allow_audit_event_mutation', 'on', true)`;
    await sql`select set_config('schedule.allow_plan_interaction_event_mutation', 'on', true)`;
    await sql`select set_config('schedule.allow_plan_mutation_change', 'on', true)`;
    await sql`select set_config('schedule.allow_routine_planning_feedback_event_change', 'on', true)`;
    await sql`select set_config('schedule.allow_routine_duration_insight_feedback_event_change', 'on', true)`;
    await sql`select set_config('schedule.allow_daily_plan_fit_insight_feedback_event_change', 'on', true)`;
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
  // EVIDENCE: work-item-deadline-product-api
  // The HTTP boundary accepts only calendar dates, returns them on every read shape, and supports an explicit clear.
  const deadlineWorkItemResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${createdWorkspaceId}/work-items`,
    payload: {
      title: "Deadline API verification",
      status: "backlog",
      priority: "low",
      dueOn: "2028-02-29",
    },
  });
  assert.equal(deadlineWorkItemResponse.statusCode, 201, deadlineWorkItemResponse.body);
  const deadlineWorkItem = deadlineWorkItemResponse.json<{
    id: string;
    version: number;
    dueOn: string | null;
  }>();
  assert.equal(deadlineWorkItem.dueOn, "2028-02-29");
  const deadlineWorkItemRead = await app.inject({
    method: "GET",
    url: `/v1/workspaces/${createdWorkspaceId}/work-items/${deadlineWorkItem.id}`,
  });
  assert.equal(deadlineWorkItemRead.statusCode, 200, deadlineWorkItemRead.body);
  assert.equal(deadlineWorkItemRead.json<{ dueOn: string | null }>().dueOn, "2028-02-29");
  const deadlineWorkItemList = await app.inject({
    method: "GET",
    url: `/v1/workspaces/${createdWorkspaceId}/work-items?limit=20`,
  });
  assert.equal(deadlineWorkItemList.statusCode, 200, deadlineWorkItemList.body);
  assert.equal(
    deadlineWorkItemList
      .json<{ items: { id: string; dueOn: string | null }[] }>()
      .items.find((item) => item.id === deadlineWorkItem.id)?.dueOn,
    "2028-02-29",
  );
  const deadlineUpdateResponse = await app.inject({
    method: "PATCH",
    url: `/v1/workspaces/${createdWorkspaceId}/work-items/${deadlineWorkItem.id}`,
    payload: { expectedVersion: deadlineWorkItem.version, dueOn: "2028-03-01" },
  });
  assert.equal(deadlineUpdateResponse.statusCode, 200, deadlineUpdateResponse.body);
  assert.equal(deadlineUpdateResponse.json<{ dueOn: string | null }>().dueOn, "2028-03-01");
  assert.equal(deadlineUpdateResponse.json<{ version: number }>().version, 2);
  const deadlineClearResponse = await app.inject({
    method: "PATCH",
    url: `/v1/workspaces/${createdWorkspaceId}/work-items/${deadlineWorkItem.id}`,
    payload: { expectedVersion: 2, dueOn: null },
  });
  assert.equal(deadlineClearResponse.statusCode, 200, deadlineClearResponse.body);
  assert.equal(deadlineClearResponse.json<{ dueOn: string | null; version: number }>().dueOn, null);
  assert.equal(deadlineClearResponse.json<{ version: number }>().version, 3);
  for (const dueOn of ["2027-02-29", "2028-2-29", "2028-02-30"]) {
    const invalidDateResponse: { statusCode: number; body: string } = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${createdWorkspaceId}/work-items`,
      payload: { title: "Invalid date", dueOn },
    });
    assert.equal(invalidDateResponse.statusCode, 400, invalidDateResponse.body);
  }
  const invalidDateUpdate = await app.inject({
    method: "PATCH",
    url: `/v1/workspaces/${createdWorkspaceId}/work-items/${deadlineWorkItem.id}`,
    payload: { expectedVersion: 3, dueOn: "2028-02-30" },
  });
  assert.equal(invalidDateUpdate.statusCode, 400, invalidDateUpdate.body);
  const secondWorkItemResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${createdWorkspaceId}/work-items`,
    payload: { title: "Exercise stable pagination", status: "backlog", priority: "low" },
  });
  assert.equal(secondWorkItemResponse.statusCode, 201, secondWorkItemResponse.body);
  const secondWorkItem = secondWorkItemResponse.json<{ id: string; version: number }>();
  // EVIDENCE: unified-planner-work-item-opt-in-api
  // Conventional work stays out of Today unless it explicitly supplies a planning duration.
  const plannableWorkItemResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${createdWorkspaceId}/work-items`,
    payload: {
      title: "Unified planner primary work",
      status: "in_progress",
      priority: "high",
      planningDurationMinutes: 30,
    },
  });
  assert.equal(plannableWorkItemResponse.statusCode, 201, plannableWorkItemResponse.body);
  const plannableWorkItem = plannableWorkItemResponse.json<{ id: string; version: number }>();
  const secondaryPlannableWorkItemResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${createdWorkspaceId}/work-items`,
    payload: {
      title: "Unified planner secondary work",
      status: "in_progress",
      priority: "medium",
      planningDurationMinutes: 15,
    },
  });
  assert.equal(
    secondaryPlannableWorkItemResponse.statusCode,
    201,
    secondaryPlannableWorkItemResponse.body,
  );
  const secondaryPlannableWorkItem = secondaryPlannableWorkItemResponse.json<{ id: string }>();
  const terminalWorkItemResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${createdWorkspaceId}/work-items`,
    payload: {
      title: "Completed work is not a planner candidate",
      status: "done",
      priority: "urgent",
      planningDurationMinutes: 15,
    },
  });
  assert.equal(terminalWorkItemResponse.statusCode, 201, terminalWorkItemResponse.body);
  const terminalWorkItem = terminalWorkItemResponse.json<{ id: string }>();
  const unifiedWorkPlanRequest = {
    method: "POST" as const,
    url: `/v1/workspaces/${createdWorkspaceId}/plans`,
    payload: {
      date: "2026-07-16",
      timeZone: "UTC",
      availableWindows: [
        {
          startsAt: "2026-07-16T08:00:00.000Z",
          endsAt: "2026-07-16T09:00:00.000Z",
        },
      ],
      targetMinutes: 45,
      targetTaskCount: 2,
      availableContexts: [],
      seed: "unified-work-item-api-verification",
      requestRevision: 1,
    },
  };
  const unifiedWorkPlanResponse = await app.inject(unifiedWorkPlanRequest);
  assert.equal(unifiedWorkPlanResponse.statusCode, 200, unifiedWorkPlanResponse.body);
  const unifiedWorkPlan = unifiedWorkPlanResponse.json<{
    id: string;
    items: {
      id: string;
      sourceType: string;
      routineId: string | null;
      workItemId: string | null;
      scheduledMinutes: number;
    }[];
  }>();
  assert.equal(unifiedWorkPlan.items.length, 2, "combined task-count budget must be honored");
  assert.equal(
    unifiedWorkPlan.items.reduce((total, item) => total + item.scheduledMinutes, 0),
    45,
    "combined time budget must be honored",
  );
  assert.deepEqual(
    new Set(unifiedWorkPlan.items.map((item) => item.workItemId)),
    new Set([plannableWorkItem.id, secondaryPlannableWorkItem.id]),
  );
  for (const item of unifiedWorkPlan.items) {
    assert.equal(item.sourceType, "work_item");
    assert.equal(item.routineId, null);
    assert.notEqual(item.workItemId, null);
  }
  assert.equal(
    unifiedWorkPlan.items.some((item) => item.workItemId === terminalWorkItem.id),
    false,
    "terminal work must be excluded even when it has a planning duration",
  );
  const [persistedUnifiedPlanItem] = await connection.sql<
    {
      source_type: string;
      routine_id: string | null;
      work_item_id: string | null;
      scheduled_minutes: number;
    }[]
  >`
    select source_type, routine_id::text, work_item_id::text, scheduled_minutes
    from daily_plan_items
    where workspace_id = ${createdWorkspaceId}
      and plan_id = ${unifiedWorkPlan.id}
    order by position asc
    limit 1
  `;
  assert.equal(persistedUnifiedPlanItem?.source_type, "work_item");
  assert.equal(persistedUnifiedPlanItem?.routine_id, null);
  assert.equal(
    [plannableWorkItem.id, secondaryPlannableWorkItem.id].includes(
      persistedUnifiedPlanItem?.work_item_id ?? "",
    ),
    true,
  );
  assert.equal(
    [15, 30].includes(persistedUnifiedPlanItem?.scheduled_minutes ?? 0),
    true,
    "persisted work source must retain its planned duration",
  );
  const unifiedActivityItem = unifiedWorkPlan.items.find(
    (item) => item.workItemId === plannableWorkItem.id,
  );
  assert.notEqual(unifiedActivityItem, undefined);
  const unifiedWorkCompletionRequest = {
    method: "POST" as const,
    url: `/v1/workspaces/${createdWorkspaceId}/plans/2026-07-16/items/${unifiedActivityItem!.id}/activity-events`,
    headers: { "idempotency-key": "unified-work-item-completion" },
    payload: {
      expectedPlanId: unifiedWorkPlan.id,
      expectedHeadVersion: 1,
      type: "completed",
      occurredAt: "2026-07-16T09:00:00.000Z",
      timeZone: "UTC",
      durationMinutes: 30,
    },
  };
  const unifiedWorkCompletionResponse = await app.inject(unifiedWorkCompletionRequest);
  const retriedUnifiedWorkCompletion = await app.inject(unifiedWorkCompletionRequest);
  assert.equal(unifiedWorkCompletionResponse.statusCode, 200, unifiedWorkCompletionResponse.body);
  assert.deepEqual(retriedUnifiedWorkCompletion.json(), unifiedWorkCompletionResponse.json());
  const unifiedWorkCompletion = unifiedWorkCompletionResponse.json<{
    activityState: string;
    headVersion: number;
    activityEvent: {
      id: string;
      sourceType: string;
      routineId: string | null;
      workItemId: string | null;
    };
  }>();
  assert.equal(unifiedWorkCompletion.activityState, "completed");
  assert.equal(unifiedWorkCompletion.headVersion, 2);
  assert.equal(unifiedWorkCompletion.activityEvent.sourceType, "work_item");
  assert.equal(unifiedWorkCompletion.activityEvent.routineId, null);
  assert.equal(unifiedWorkCompletion.activityEvent.workItemId, plannableWorkItem.id);
  const completedWorkItemResponse = await app.inject({
    method: "GET",
    url: `/v1/workspaces/${createdWorkspaceId}/work-items/${plannableWorkItem.id}`,
  });
  assert.equal(completedWorkItemResponse.statusCode, 200, completedWorkItemResponse.body);
  assert.equal(completedWorkItemResponse.json<{ status: string }>().status, "done");
  const [persistedUnifiedActivity] = await connection.sql<
    { source_type: string; routine_id: string | null; work_item_id: string | null }[]
  >`
    select source_type, routine_id::text, work_item_id::text
    from activity_events
    where workspace_id = ${createdWorkspaceId}
      and id = ${unifiedWorkCompletion.activityEvent.id}
  `;
  assert.deepEqual(persistedUnifiedActivity, {
    source_type: "work_item",
    routine_id: null,
    work_item_id: plannableWorkItem.id,
  });
  const unifiedWorkReversalResponse = await app.inject({
    ...unifiedWorkCompletionRequest,
    headers: { "idempotency-key": "unified-work-item-completion-reversal" },
    payload: {
      ...unifiedWorkCompletionRequest.payload,
      expectedHeadVersion: 2,
      type: "completion_reversed",
      occurredAt: "2026-07-16T09:05:00.000Z",
      durationMinutes: null,
    },
  });
  const retriedUnifiedWorkReversal = await app.inject({
    ...unifiedWorkCompletionRequest,
    headers: { "idempotency-key": "unified-work-item-completion-reversal" },
    payload: {
      ...unifiedWorkCompletionRequest.payload,
      expectedHeadVersion: 2,
      type: "completion_reversed",
      occurredAt: "2026-07-16T09:05:00.000Z",
      durationMinutes: null,
    },
  });
  assert.equal(unifiedWorkReversalResponse.statusCode, 200, unifiedWorkReversalResponse.body);
  assert.deepEqual(retriedUnifiedWorkReversal.json(), unifiedWorkReversalResponse.json());
  assert.equal(
    unifiedWorkReversalResponse.json<{ activityState: string; headVersion: number }>()
      .activityState,
    "pending",
  );
  assert.equal(
    unifiedWorkReversalResponse.json<{ activityState: string; headVersion: number }>().headVersion,
    3,
  );
  const reversedWorkItemResponse = await app.inject({
    method: "GET",
    url: `/v1/workspaces/${createdWorkspaceId}/work-items/${plannableWorkItem.id}`,
  });
  assert.equal(reversedWorkItemResponse.statusCode, 200, reversedWorkItemResponse.body);
  const reversedWorkItem = reversedWorkItemResponse.json<{ status: string; version: number }>();
  assert.equal(
    reversedWorkItem.status,
    "in_progress",
    "reversing an owned completion restores the pre-completion work status",
  );
  const isolateBaseWorkFromFollowUpPlan = await app.inject({
    method: "PATCH",
    url: `/v1/workspaces/${createdWorkspaceId}/work-items/${plannableWorkItem.id}`,
    payload: { expectedVersion: reversedWorkItem.version, status: "cancelled" },
  });
  assert.equal(
    isolateBaseWorkFromFollowUpPlan.statusCode,
    200,
    isolateBaseWorkFromFollowUpPlan.body,
  );
  const isolateSecondaryWorkFromFollowUpPlan = await app.inject({
    method: "PATCH",
    url: `/v1/workspaces/${createdWorkspaceId}/work-items/${secondaryPlannableWorkItem.id}`,
    payload: { expectedVersion: 1, status: "cancelled" },
  });
  assert.equal(
    isolateSecondaryWorkFromFollowUpPlan.statusCode,
    200,
    isolateSecondaryWorkFromFollowUpPlan.body,
  );

  // EVIDENCE: unified-planner-work-item-reversal-edit-guard-api
  // A user edit after completion owns the work item; a later reversal only reopens Today.
  const editedAfterCompletionWorkResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${createdWorkspaceId}/work-items`,
    payload: {
      title: "Edited after completion",
      status: "in_progress",
      priority: "high",
      planningDurationMinutes: 20,
    },
  });
  assert.equal(
    editedAfterCompletionWorkResponse.statusCode,
    201,
    editedAfterCompletionWorkResponse.body,
  );
  const editedAfterCompletionWork = editedAfterCompletionWorkResponse.json<{ id: string }>();
  const editGuardPlanResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${createdWorkspaceId}/plans`,
    payload: {
      date: "2026-07-17",
      timeZone: "UTC",
      availableWindows: [
        {
          startsAt: "2026-07-17T08:00:00.000Z",
          endsAt: "2026-07-17T09:00:00.000Z",
        },
      ],
      targetMinutes: 20,
      targetTaskCount: 1,
      availableContexts: [],
      seed: "unified-work-item-reversal-edit-guard",
      requestRevision: 1,
    },
  });
  assert.equal(editGuardPlanResponse.statusCode, 200, editGuardPlanResponse.body);
  const editGuardPlan = editGuardPlanResponse.json<{
    id: string;
    items: { id: string; workItemId: string | null }[];
  }>();
  const editGuardPlanItem = editGuardPlan.items.find(
    (item) => item.workItemId === editedAfterCompletionWork.id,
  );
  assert.notEqual(editGuardPlanItem, undefined);
  const editGuardCompletionResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${createdWorkspaceId}/plans/2026-07-17/items/${editGuardPlanItem!.id}/activity-events`,
    headers: { "idempotency-key": "unified-work-item-edit-guard-completion" },
    payload: {
      expectedPlanId: editGuardPlan.id,
      expectedHeadVersion: 1,
      type: "completed",
      occurredAt: "2026-07-17T09:00:00.000Z",
      timeZone: "UTC",
      durationMinutes: 20,
    },
  });
  assert.equal(editGuardCompletionResponse.statusCode, 200, editGuardCompletionResponse.body);
  const completedBeforeEdit = await app.inject({
    method: "GET",
    url: `/v1/workspaces/${createdWorkspaceId}/work-items/${editedAfterCompletionWork.id}`,
  });
  assert.equal(completedBeforeEdit.statusCode, 200, completedBeforeEdit.body);
  assert.equal(completedBeforeEdit.json<{ status: string; version: number }>().status, "done");
  const laterUserEditResponse = await app.inject({
    method: "PATCH",
    url: `/v1/workspaces/${createdWorkspaceId}/work-items/${editedAfterCompletionWork.id}`,
    payload: {
      expectedVersion: completedBeforeEdit.json<{ version: number }>().version,
      title: "User owns this later edit",
      status: "planned",
      planningDurationMinutes: 25,
    },
  });
  assert.equal(laterUserEditResponse.statusCode, 200, laterUserEditResponse.body);
  const laterUserEdit = laterUserEditResponse.json<{
    title: string;
    status: string;
    planningDurationMinutes: number | null;
    version: number;
  }>();
  assert.equal(laterUserEdit.status, "planned");
  const editGuardReversalResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${createdWorkspaceId}/plans/2026-07-17/items/${editGuardPlanItem!.id}/activity-events`,
    headers: { "idempotency-key": "unified-work-item-edit-guard-reversal" },
    payload: {
      expectedPlanId: editGuardPlan.id,
      expectedHeadVersion: 2,
      type: "completion_reversed",
      occurredAt: "2026-07-17T09:05:00.000Z",
      timeZone: "UTC",
      durationMinutes: null,
    },
  });
  assert.equal(editGuardReversalResponse.statusCode, 200, editGuardReversalResponse.body);
  assert.equal(
    editGuardReversalResponse.json<{ activityState: string }>().activityState,
    "pending",
    "the plan item reopens even when the source was edited later",
  );
  const workItemAfterGuardedReversal = await app.inject({
    method: "GET",
    url: `/v1/workspaces/${createdWorkspaceId}/work-items/${editedAfterCompletionWork.id}`,
  });
  assert.equal(workItemAfterGuardedReversal.statusCode, 200, workItemAfterGuardedReversal.body);
  const guardedReversalWorkItem = workItemAfterGuardedReversal.json<{
    title: string;
    status: string;
    planningDurationMinutes: number | null;
    version: number;
  }>();
  assert.equal(guardedReversalWorkItem.title, laterUserEdit.title);
  assert.equal(guardedReversalWorkItem.status, laterUserEdit.status);
  assert.equal(
    guardedReversalWorkItem.planningDurationMinutes,
    laterUserEdit.planningDurationMinutes,
  );
  assert.equal(guardedReversalWorkItem.version, laterUserEdit.version);

  // EVIDENCE: unified-planner-terminal-work-regeneration-api
  const terminalRegenerationWorkResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${isolatedWorkspaceId}/work-items`,
    payload: {
      title: "Terminal work must not regenerate",
      status: "in_progress",
      priority: "high",
      planningDurationMinutes: 20,
    },
  });
  assert.equal(
    terminalRegenerationWorkResponse.statusCode,
    201,
    terminalRegenerationWorkResponse.body,
  );
  const terminalRegenerationWork = terminalRegenerationWorkResponse.json<{ id: string }>();
  const terminalRegenerationPlanResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${isolatedWorkspaceId}/plans`,
    payload: {
      date: "2026-07-18",
      timeZone: "UTC",
      availableWindows: [
        {
          startsAt: "2026-07-18T08:00:00.000Z",
          endsAt: "2026-07-18T09:00:00.000Z",
        },
      ],
      targetMinutes: 20,
      targetTaskCount: 1,
      availableContexts: [],
      seed: "isolated-terminal-work-regeneration-v3",
      requestRevision: 1,
    },
  });
  assert.equal(
    terminalRegenerationPlanResponse.statusCode,
    200,
    terminalRegenerationPlanResponse.body,
  );
  const terminalRegenerationPlan = terminalRegenerationPlanResponse.json<{
    id: string;
    items: { id: string; workItemId: string | null }[];
  }>();
  const terminalRegenerationPlanItem = terminalRegenerationPlan.items.find(
    (item) => item.workItemId === terminalRegenerationWork.id,
  );
  assert.notEqual(terminalRegenerationPlanItem, undefined);
  const terminalCompletionResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${isolatedWorkspaceId}/plans/2026-07-18/items/${terminalRegenerationPlanItem!.id}/activity-events`,
    headers: { "idempotency-key": "unified-terminal-work-completion" },
    payload: {
      expectedPlanId: terminalRegenerationPlan.id,
      expectedHeadVersion: 1,
      type: "completed",
      occurredAt: "2026-07-18T09:00:00.000Z",
      timeZone: "UTC",
      durationMinutes: 20,
    },
  });
  assert.equal(terminalCompletionResponse.statusCode, 200, terminalCompletionResponse.body);
  const terminalRegenerationResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${isolatedWorkspaceId}/plans/2026-07-18/regenerations`,
    headers: { "idempotency-key": "unified-terminal-work-regeneration" },
    payload: {
      expectedPlanId: terminalRegenerationPlan.id,
      expectedHeadVersion: 2,
      request: {
        timeZone: "UTC",
        availableWindows: [
          {
            startsAt: "2026-07-18T08:00:00.000Z",
            endsAt: "2026-07-18T09:00:00.000Z",
          },
        ],
        targetMinutes: 20,
        targetTaskCount: 1,
        availableContexts: [],
        seed: "isolated-terminal-work-regeneration-next-v3",
      },
    },
  });
  assert.equal(terminalRegenerationResponse.statusCode, 200, terminalRegenerationResponse.body);
  assert.equal(
    terminalRegenerationResponse
      .json<{ items: { workItemId: string | null }[] }>()
      .items.some((item) => item.workItemId === terminalRegenerationWork.id),
    false,
    "completed work must not return during regeneration",
  );
  const originalTerminalRevision = await app.inject({
    method: "GET",
    url: `/v1/workspaces/${isolatedWorkspaceId}/plans/2026-07-18?revision=1`,
  });
  assert.equal(originalTerminalRevision.statusCode, 200, originalTerminalRevision.body);
  assert.equal(
    originalTerminalRevision.json<{ id: string }>().id,
    terminalRegenerationPlan.id,
    "regeneration must leave the prior immutable revision addressable",
  );
  assert.equal(
    originalTerminalRevision
      .json<{ items: { workItemId: string | null }[] }>()
      .items.some((item) => item.workItemId === terminalRegenerationWork.id),
    true,
  );

  // EVIDENCE: work-item-dependencies-product-api
  // The live API and PostgreSQL graph preserve set idempotency, tenant isolation, acyclicity,
  // immutable plan revisions, and done-only prerequisite eligibility.
  type DependencyDto = {
    readonly workspaceId: string;
    readonly prerequisiteWorkItemId: string;
    readonly dependentWorkItemId: string;
    readonly createdAt: string;
  };
  type DependencyPage = {
    readonly items: readonly DependencyDto[];
    readonly page: { readonly limit: number; readonly offset: number };
  };
  const listDependencies = async (workspaceId: string): Promise<DependencyPage> => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${workspaceId}/work-item-dependencies?limit=200&offset=0`,
    });
    assert.equal(response.statusCode, 200, response.body);
    return response.json<DependencyPage>();
  };
  const dependencyPairs = (page: DependencyPage): readonly string[] =>
    page.items
      .map((dependency) => `${dependency.dependentWorkItemId}:${dependency.prerequisiteWorkItemId}`)
      .sort();
  const dependencyAuditActions = async (): Promise<readonly string[]> => {
    const rows = await connection.sql<{ action: string }[]>`
      select action
      from audit_events
      where workspace_id = ${isolatedWorkspaceId}
        and entity_type = 'work_item_dependency'
    `;
    return rows.map((row) => row.action).sort();
  };

  const prerequisiteResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${isolatedWorkspaceId}/work-items`,
    payload: {
      title: "Dependency prerequisite",
      status: "backlog",
      priority: "medium",
    },
  });
  assert.equal(prerequisiteResponse.statusCode, 201, prerequisiteResponse.body);
  const prerequisite = prerequisiteResponse.json<{ id: string; status: string; version: number }>();
  const dependentResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${isolatedWorkspaceId}/work-items`,
    payload: {
      title: "Dependency-gated work",
      status: "backlog",
      priority: "urgent",
      planningDurationMinutes: 20,
    },
  });
  assert.equal(dependentResponse.statusCode, 201, dependentResponse.body);
  const dependent = dependentResponse.json<{ id: string; status: string; version: number }>();
  const tailResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${isolatedWorkspaceId}/work-items`,
    payload: {
      title: "Dependency cycle tail",
      status: "backlog",
      priority: "low",
    },
  });
  assert.equal(tailResponse.statusCode, 201, tailResponse.body);
  const tail = tailResponse.json<{ id: string; status: string; version: number }>();
  assert.deepEqual(await listDependencies(isolatedWorkspaceId), {
    items: [],
    page: { limit: 200, offset: 0 },
  });

  const dependencyPlanRequest = {
    date: "2026-07-19",
    timeZone: "UTC",
    availableWindows: [
      {
        startsAt: "2026-07-19T08:00:00.000Z",
        endsAt: "2026-07-19T09:00:00.000Z",
      },
    ],
    targetMinutes: 20,
    targetTaskCount: 1,
    availableContexts: [] as string[],
    seed: "dependency-before-edge-v5",
    requestRevision: 1,
  };
  const dependencyInitialPlanResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${isolatedWorkspaceId}/plans`,
    payload: dependencyPlanRequest,
  });
  assert.equal(dependencyInitialPlanResponse.statusCode, 200, dependencyInitialPlanResponse.body);
  const dependencyInitialPlan = dependencyInitialPlanResponse.json<{
    readonly id: string;
    readonly items: readonly { readonly workItemId: string | null }[];
  }>();
  assert.equal(
    dependencyInitialPlan.items.some((item) => item.workItemId === dependent.id),
    true,
    "the dependent must be selectable before its prerequisite edge exists",
  );

  const firstDependencyRequest = {
    method: "POST" as const,
    url: `/v1/workspaces/${isolatedWorkspaceId}/work-items/${dependent.id}/prerequisites`,
    payload: { prerequisiteWorkItemId: prerequisite.id },
  };
  const firstDependencyResponse = await app.inject(firstDependencyRequest);
  assert.equal(firstDependencyResponse.statusCode, 201, firstDependencyResponse.body);
  const firstDependency = firstDependencyResponse.json<DependencyDto>();
  assert.deepEqual(firstDependency, {
    workspaceId: isolatedWorkspaceId,
    prerequisiteWorkItemId: prerequisite.id,
    dependentWorkItemId: dependent.id,
    createdAt: firstDependency.createdAt,
  });
  assert.equal(new Date(firstDependency.createdAt).toISOString(), firstDependency.createdAt);
  const replayedFirstDependency = await app.inject(firstDependencyRequest);
  assert.equal(replayedFirstDependency.statusCode, 200, replayedFirstDependency.body);
  assert.deepEqual(replayedFirstDependency.json(), firstDependency);
  assert.deepEqual(await dependencyAuditActions(), ["work_item_dependency.added"]);

  const secondDependencyResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${isolatedWorkspaceId}/work-items/${prerequisite.id}/prerequisites`,
    payload: { prerequisiteWorkItemId: tail.id },
  });
  assert.equal(secondDependencyResponse.statusCode, 201, secondDependencyResponse.body);
  const expectedDependencyPairs = [
    `${dependent.id}:${prerequisite.id}`,
    `${prerequisite.id}:${tail.id}`,
  ].sort();
  const dependencyPage = await listDependencies(isolatedWorkspaceId);
  assert.deepEqual(dependencyPairs(dependencyPage), expectedDependencyPairs);
  assert.deepEqual(dependencyPage.page, { limit: 200, offset: 0 });
  assert.deepEqual(await dependencyAuditActions(), [
    "work_item_dependency.added",
    "work_item_dependency.added",
  ]);

  const unchangedDependentResponse = await app.inject({
    method: "GET",
    url: `/v1/workspaces/${isolatedWorkspaceId}/work-items/${dependent.id}`,
  });
  assert.equal(unchangedDependentResponse.statusCode, 200, unchangedDependentResponse.body);
  const unchangedDependent = unchangedDependentResponse.json<{
    status: string;
    version: number;
  }>();
  assert.equal(unchangedDependent.status, dependent.status);
  assert.equal(unchangedDependent.version, dependent.version);
  const planAfterDependencyEditResponse = await app.inject({
    method: "GET",
    url: `/v1/workspaces/${isolatedWorkspaceId}/plans/2026-07-19/current`,
  });
  assert.equal(
    planAfterDependencyEditResponse.statusCode,
    200,
    planAfterDependencyEditResponse.body,
  );
  const planAfterDependencyEdit = planAfterDependencyEditResponse.json<{
    readonly id: string;
    readonly headVersion: number;
    readonly items: readonly { readonly workItemId: string | null }[];
  }>();
  assert.equal(planAfterDependencyEdit.id, dependencyInitialPlan.id);
  assert.equal(planAfterDependencyEdit.headVersion, 1);
  assert.equal(
    planAfterDependencyEdit.items.some((item) => item.workItemId === dependent.id),
    true,
    "editing the graph must not mutate the current Today revision",
  );

  const cycleResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${isolatedWorkspaceId}/work-items/${tail.id}/prerequisites`,
    payload: { prerequisiteWorkItemId: dependent.id },
  });
  assert.equal(cycleResponse.statusCode, 409, cycleResponse.body);
  assert.equal(
    cycleResponse.json<{ error: { code: string } }>().error.code,
    "work_item_dependency.cycle_conflict",
  );
  assert.deepEqual(
    dependencyPairs(await listDependencies(isolatedWorkspaceId)),
    expectedDependencyPairs,
  );
  assert.deepEqual(await dependencyAuditActions(), [
    "work_item_dependency.added",
    "work_item_dependency.added",
  ]);

  const crossWorkspaceDependencyResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${isolatedWorkspaceId}/work-items/${dependent.id}/prerequisites`,
    payload: { prerequisiteWorkItemId: createdWorkItem.id },
  });
  assert.equal(
    crossWorkspaceDependencyResponse.statusCode,
    404,
    crossWorkspaceDependencyResponse.body,
  );
  assert.equal(
    crossWorkspaceDependencyResponse.json<{ error: { code: string } }>().error.code,
    "work_item.not_found",
  );
  assert.deepEqual(
    dependencyPairs(await listDependencies(isolatedWorkspaceId)),
    expectedDependencyPairs,
  );
  assert.deepEqual(await listDependencies(createdWorkspaceId), {
    items: [],
    page: { limit: 200, offset: 0 },
  });
  assert.deepEqual(await dependencyAuditActions(), [
    "work_item_dependency.added",
    "work_item_dependency.added",
  ]);

  const blockedDependencyPlanResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${isolatedWorkspaceId}/plans/2026-07-19/regenerations`,
    headers: { "idempotency-key": "dependency-blocked-regeneration" },
    payload: {
      expectedPlanId: dependencyInitialPlan.id,
      expectedHeadVersion: 1,
      request: {
        timeZone: "UTC",
        availableWindows: dependencyPlanRequest.availableWindows,
        targetMinutes: 20,
        targetTaskCount: 1,
        availableContexts: [],
        seed: "dependency-blocked-regeneration-v5",
      },
    },
  });
  assert.equal(blockedDependencyPlanResponse.statusCode, 200, blockedDependencyPlanResponse.body);
  const blockedDependencyPlan = blockedDependencyPlanResponse.json<{
    readonly id: string;
    readonly headVersion: number;
    readonly items: readonly { readonly workItemId: string | null }[];
    readonly exclusions: readonly {
      readonly workItemId: string | null;
      readonly codes: readonly string[];
    }[];
  }>();
  assert.equal(blockedDependencyPlan.headVersion, 2);
  assert.equal(
    blockedDependencyPlan.items.some((item) => item.workItemId === dependent.id),
    false,
    "explicit regeneration must remove an unlocked dependent with an unmet prerequisite",
  );
  assert.equal(
    blockedDependencyPlan.exclusions
      .find((exclusion) => exclusion.workItemId === dependent.id)
      ?.codes.includes("work_item_dependency_unsatisfied"),
    true,
  );
  const immutableDependencyRevisionResponse = await app.inject({
    method: "GET",
    url: `/v1/workspaces/${isolatedWorkspaceId}/plans/2026-07-19?revision=1`,
  });
  assert.equal(
    immutableDependencyRevisionResponse.statusCode,
    200,
    immutableDependencyRevisionResponse.body,
  );
  assert.equal(
    immutableDependencyRevisionResponse
      .json<{ items: { workItemId: string | null }[] }>()
      .items.some((item) => item.workItemId === dependent.id),
    true,
  );

  const completedPrerequisiteResponse = await app.inject({
    method: "PATCH",
    url: `/v1/workspaces/${isolatedWorkspaceId}/work-items/${prerequisite.id}`,
    payload: { expectedVersion: prerequisite.version, status: "done" },
  });
  assert.equal(completedPrerequisiteResponse.statusCode, 200, completedPrerequisiteResponse.body);
  assert.equal(completedPrerequisiteResponse.json<{ status: string }>().status, "done");
  const satisfiedDependencyPlanResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${isolatedWorkspaceId}/plans/2026-07-19/regenerations`,
    headers: { "idempotency-key": "dependency-satisfied-regeneration" },
    payload: {
      expectedPlanId: blockedDependencyPlan.id,
      expectedHeadVersion: blockedDependencyPlan.headVersion,
      request: {
        timeZone: "UTC",
        availableWindows: dependencyPlanRequest.availableWindows,
        targetMinutes: 20,
        targetTaskCount: 1,
        availableContexts: [],
        seed: "dependency-satisfied-regeneration-v5",
      },
    },
  });
  assert.equal(
    satisfiedDependencyPlanResponse.statusCode,
    200,
    satisfiedDependencyPlanResponse.body,
  );
  const satisfiedDependencyPlan = satisfiedDependencyPlanResponse.json<{
    readonly id: string;
    readonly headVersion: number;
    readonly items: readonly { readonly workItemId: string | null }[];
  }>();
  assert.equal(satisfiedDependencyPlan.headVersion, 3);
  assert.equal(
    satisfiedDependencyPlan.items.some((item) => item.workItemId === dependent.id),
    true,
    "a done direct prerequisite must make the dependent selectable again",
  );

  for (const [dependentWorkItemId, prerequisiteWorkItemId] of [
    [dependent.id, prerequisite.id],
    [prerequisite.id, tail.id],
  ] as const) {
    const removalResponse: { readonly statusCode: number; readonly body: string } =
      await app.inject({
        method: "DELETE",
        url: `/v1/workspaces/${isolatedWorkspaceId}/work-items/${dependentWorkItemId}/prerequisites/${prerequisiteWorkItemId}`,
      });
    assert.equal(removalResponse.statusCode, 204, removalResponse.body);
  }
  const replayedRemovalResponse = await app.inject({
    method: "DELETE",
    url: `/v1/workspaces/${isolatedWorkspaceId}/work-items/${dependent.id}/prerequisites/${prerequisite.id}`,
  });
  assert.equal(replayedRemovalResponse.statusCode, 204, replayedRemovalResponse.body);
  assert.deepEqual(await listDependencies(isolatedWorkspaceId), {
    items: [],
    page: { limit: 200, offset: 0 },
  });
  assert.deepEqual(await dependencyAuditActions(), [
    "work_item_dependency.added",
    "work_item_dependency.added",
    "work_item_dependency.removed",
    "work_item_dependency.removed",
  ]);
  const planAfterDependencyRemovalResponse = await app.inject({
    method: "GET",
    url: `/v1/workspaces/${isolatedWorkspaceId}/plans/2026-07-19/current`,
  });
  assert.equal(
    planAfterDependencyRemovalResponse.statusCode,
    200,
    planAfterDependencyRemovalResponse.body,
  );
  assert.equal(
    planAfterDependencyRemovalResponse.json<{ id: string; headVersion: number }>().id,
    satisfiedDependencyPlan.id,
  );
  assert.equal(
    planAfterDependencyRemovalResponse.json<{ id: string; headVersion: number }>().headVersion,
    3,
    "removing edges must not mutate the current Today head",
  );

  const reciprocalLeftResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${isolatedWorkspaceId}/work-items`,
    payload: {
      title: "Reciprocal dependency left",
      status: "backlog",
      priority: "medium",
    },
  });
  const reciprocalRightResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${isolatedWorkspaceId}/work-items`,
    payload: {
      title: "Reciprocal dependency right",
      status: "backlog",
      priority: "medium",
    },
  });
  assert.equal(reciprocalLeftResponse.statusCode, 201, reciprocalLeftResponse.body);
  assert.equal(reciprocalRightResponse.statusCode, 201, reciprocalRightResponse.body);
  const reciprocalLeft = reciprocalLeftResponse.json<{ id: string }>();
  const reciprocalRight = reciprocalRightResponse.json<{ id: string }>();
  const mixedCaseSelfDependencyResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${isolatedWorkspaceId}/work-items/${reciprocalLeft.id}/prerequisites`,
    payload: { prerequisiteWorkItemId: reciprocalLeft.id.toUpperCase() },
  });
  assert.equal(
    mixedCaseSelfDependencyResponse.statusCode,
    422,
    mixedCaseSelfDependencyResponse.body,
  );
  assert.equal(
    mixedCaseSelfDependencyResponse.json<{ error: { code: string } }>().error.code,
    "work_item_dependency.self_reference_invalid",
  );
  assert.deepEqual(await listDependencies(isolatedWorkspaceId), {
    items: [],
    page: { limit: 200, offset: 0 },
  });
  const reciprocalResponses = await Promise.all([
    app.inject({
      method: "POST",
      url: `/v1/workspaces/${isolatedWorkspaceId}/work-items/${reciprocalRight.id}/prerequisites`,
      payload: { prerequisiteWorkItemId: reciprocalLeft.id },
    }),
    app.inject({
      method: "POST",
      url: `/v1/workspaces/${isolatedWorkspaceId.toUpperCase()}/work-items/${reciprocalLeft.id.toUpperCase()}/prerequisites`,
      payload: { prerequisiteWorkItemId: reciprocalRight.id.toUpperCase() },
    }),
  ]);
  assert.deepEqual(
    reciprocalResponses.map((response) => response.statusCode).sort(),
    [201, 409],
    "concurrent reciprocal additions must serialize so exactly one edge wins",
  );
  const reciprocalWinner = reciprocalResponses.find((response) => response.statusCode === 201);
  const reciprocalLoser = reciprocalResponses.find((response) => response.statusCode === 409);
  assert.ok(reciprocalWinner !== undefined);
  assert.ok(reciprocalLoser !== undefined);
  assert.equal(
    reciprocalLoser.json<{ error: { code: string } }>().error.code,
    "work_item_dependency.cycle_conflict",
  );
  const winningDependency = reciprocalWinner.json<DependencyDto>();
  assert.deepEqual(dependencyPairs(await listDependencies(isolatedWorkspaceId)), [
    `${winningDependency.dependentWorkItemId}:${winningDependency.prerequisiteWorkItemId}`,
  ]);
  const reciprocalRemovalResponse = await app.inject({
    method: "DELETE",
    url: `/v1/workspaces/${isolatedWorkspaceId}/work-items/${winningDependency.dependentWorkItemId}/prerequisites/${winningDependency.prerequisiteWorkItemId}`,
  });
  assert.equal(reciprocalRemovalResponse.statusCode, 204, reciprocalRemovalResponse.body);
  assert.deepEqual(await listDependencies(isolatedWorkspaceId), {
    items: [],
    page: { limit: 200, offset: 0 },
  });
  assert.deepEqual(await dependencyAuditActions(), [
    "work_item_dependency.added",
    "work_item_dependency.added",
    "work_item_dependency.added",
    "work_item_dependency.removed",
    "work_item_dependency.removed",
    "work_item_dependency.removed",
  ]);

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
    url: `/v1/workspaces/${createdWorkspaceId}/work-items?limit=1&offset=100`,
  });
  assert.equal(allWorkItemsResponse.statusCode, 200, allWorkItemsResponse.body);
  assert.equal(firstWorkItemPage.statusCode, 200, firstWorkItemPage.body);
  assert.equal(secondWorkItemPage.statusCode, 200, secondWorkItemPage.body);
  assert.equal(emptyWorkItemPage.statusCode, 200, emptyWorkItemPage.body);
  assert.deepEqual(
    firstWorkItemPage.json<{ items: { id: string }[] }>().items.map((item) => item.id),
    allWorkItemsResponse
      .json<{ items: { id: string }[] }>()
      .items.slice(0, 1)
      .map((item) => item.id),
  );
  assert.deepEqual(
    secondWorkItemPage.json<{ items: { id: string }[] }>().items.map((item) => item.id),
    allWorkItemsResponse
      .json<{ items: { id: string }[] }>()
      .items.slice(1, 2)
      .map((item) => item.id),
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
      duration: { minimumMinutes: 20, expectedMinutes: 30, maximumMinutes: 60 },
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
  const crossWorkspaceDurationInsightRead = await app.inject({
    method: "GET",
    url: `/v1/workspaces/${isolatedWorkspaceId}/routines/${createdRoutineId}/duration-insight`,
  });
  assert.equal(
    crossWorkspaceDurationInsightRead.statusCode,
    404,
    crossWorkspaceDurationInsightRead.body,
  );
  const crossWorkspaceDurationInsightApproval = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${isolatedWorkspaceId}/routines/${createdRoutineId}/duration-insight/approve`,
    payload: {
      expectedVersion: 1,
      duration: {
        minimumMinutes: 20,
        expectedMinutes: 30,
        maximumMinutes: 60,
        splittable: false,
        minimumSessionMinutes: null,
        overheadMinutes: 0,
      },
    },
  });
  assert.equal(
    crossWorkspaceDurationInsightApproval.statusCode,
    404,
    crossWorkspaceDurationInsightApproval.body,
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
      duration: { minimumMinutes: 20, expectedMinutes: 30, maximumMinutes: 120 },
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
        source_type,
        work_item_id,
        type,
        occurred_at,
        local_date,
        time_zone,
        reference_event_id,
        idempotency_key,
        recorded_at
      ) values (
        ${createdWorkspaceId},
        'work_item',
        ${plannableWorkItem.id},
        'completion_reversed',
        '2026-07-15T09:46:00.000Z',
        '2026-07-15',
        'UTC',
        ${planItemActivity.activityEvent.id},
        'invalid-unattributed-plan-item-reversal',
        '2026-07-15T09:46:00.000Z'
      )
    `,
    (error) => hasDatabaseCode(error, "23503"),
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
  const lockKey = `${createdWorkspaceId}:routine:${createdRoutineId}`;
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

  // EVIDENCE: routine-duration-insight-api
  // Immutable completions, their latest correction, and a reversal produce one transparent
  // suggestion. Atomic approval revalidates current evidence and does not rewrite Today.
  const durationSamples = [
    { key: "duration-sample-1", occurredAt: "2026-07-11T06:00:00.000Z", minutes: 40 },
    { key: "duration-sample-2", occurredAt: "2026-07-12T06:00:00.000Z", minutes: 45 },
    { key: "duration-sample-3", occurredAt: "2026-07-13T06:00:00.000Z", minutes: 50 },
    { key: "duration-sample-4", occurredAt: "2026-07-14T06:00:00.000Z", minutes: 55 },
    {
      key: "duration-window-boundary",
      occurredAt: "2026-04-16T07:00:00.000Z",
      minutes: 50,
    },
    {
      key: "duration-before-window",
      occurredAt: "2026-04-16T06:59:59.999Z",
      minutes: 60,
    },
  ];
  const durationCompletionIds: string[] = [];
  const appendDurationSample = async (
    sample: (typeof durationSamples)[number],
  ): Promise<string> => {
    const sampleResponse = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${createdWorkspaceId}/routines/${createdRoutineId}/activity-events`,
      headers: { "idempotency-key": sample.key },
      payload: {
        type: "completed",
        occurredAt: sample.occurredAt,
        timeZone: "UTC",
        durationMinutes: sample.minutes,
      },
    });
    assert.equal(sampleResponse.statusCode, 200, sampleResponse.body);
    return (sampleResponse.json() as { id: string }).id;
  };
  for (const sample of durationSamples) {
    durationCompletionIds.push(await appendDurationSample(sample));
  }
  const durationCorrectionResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${createdWorkspaceId}/routines/${createdRoutineId}/activity-events`,
    headers: { "idempotency-key": "duration-sample-1-correction" },
    payload: {
      type: "duration_corrected",
      occurredAt: "2026-07-15T06:30:00.000Z",
      timeZone: "UTC",
      durationMinutes: 50,
      referenceEventId: durationCompletionIds[0],
    },
  });
  assert.equal(durationCorrectionResponse.statusCode, 200, durationCorrectionResponse.body);
  const durationReversalResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${createdWorkspaceId}/routines/${createdRoutineId}/activity-events`,
    headers: { "idempotency-key": "duration-sample-4-reversal" },
    payload: {
      type: "completion_reversed",
      occurredAt: "2026-07-15T06:40:00.000Z",
      timeZone: "UTC",
      referenceEventId: durationCompletionIds[3],
    },
  });
  assert.equal(durationReversalResponse.statusCode, 200, durationReversalResponse.body);

  const durationInsightResponse = await app.inject({
    method: "GET",
    url: `/v1/workspaces/${createdWorkspaceId}/routines/${createdRoutineId}/duration-insight`,
  });
  assert.equal(durationInsightResponse.statusCode, 200, durationInsightResponse.body);
  const durationInsight = durationInsightResponse.json<{
    routineId: string;
    routineVersion: number;
    status: string;
    sampleCount: number;
    minimumSamples: number;
    lookbackDays: number;
    currentExpectedMinutes: number;
    minimumMinutes: number;
    maximumMinutes: number;
    observedMedianMinutes: number | null;
    suggestedExpectedMinutes: number | null;
    insightKey: string | null;
    disposition: string;
    dismissedAt: string | null;
  }>();
  assert.match(durationInsight.insightKey ?? "", /^[0-9a-f]{64}$/);
  assert.deepEqual(durationInsight, {
    routineId: createdRoutineId,
    routineVersion: 2,
    status: "suggested",
    sampleCount: 4,
    minimumSamples: 3,
    lookbackDays: 90,
    evaluatedAt: "2026-07-15T07:00:00.000Z",
    windowStartedAt: "2026-04-16T07:00:00.000Z",
    currentExpectedMinutes: 30,
    minimumMinutes: 20,
    maximumMinutes: 60,
    observedMedianMinutes: 50,
    materialThresholdMinutes: 5,
    suggestedExpectedMinutes: 50,
    insightKey: durationInsight.insightKey,
    disposition: "available",
    dismissedAt: null,
  });
  const initialDurationInsightKey = durationInsight.insightKey!;

  // EVIDENCE: routine-duration-insight-feedback-api
  // Dismissal and reset are persisted, replay-safe dispositions. They never edit the routine or
  // Today, while a materially different evidence fingerprint becomes available again.
  const routineBeforeDurationFeedbackResponse = await app.inject({
    method: "GET",
    url: `/v1/workspaces/${createdWorkspaceId}/routines/${createdRoutineId}`,
  });
  assert.equal(
    routineBeforeDurationFeedbackResponse.statusCode,
    200,
    routineBeforeDurationFeedbackResponse.body,
  );
  const routineBeforeDurationFeedback = routineBeforeDurationFeedbackResponse.json();
  const planHeadsBeforeDurationFeedback = await connection.sql<
    { local_date: string; current_plan_id: string; version: number }[]
  >`
    select local_date::text, current_plan_id::text, version
    from daily_plan_heads
    where workspace_id = ${createdWorkspaceId}
    order by local_date, id
  `;
  const dismissDurationInsightRequest = {
    method: "POST" as const,
    url: `/v1/workspaces/${createdWorkspaceId}/routines/${createdRoutineId}/duration-insight/dismissals`,
    headers: { "idempotency-key": "duration-insight-dismiss-initial" },
    payload: { expectedVersion: 2, insightKey: initialDurationInsightKey },
  };
  const dismissDurationInsightResponse = await app.inject(dismissDurationInsightRequest);
  assert.equal(dismissDurationInsightResponse.statusCode, 200, dismissDurationInsightResponse.body);
  const dismissedDurationInsightEvent = dismissDurationInsightResponse.json<{
    id: string;
    workspaceId: string;
    routineId: string;
    insightKey: string;
    kind: string;
    routineVersion: number;
    observedMedianMinutes: number;
    suggestedExpectedMinutes: number | null;
    idempotencyKey: string;
    recordedAt: string;
  }>();
  assert.deepEqual(
    {
      workspaceId: dismissedDurationInsightEvent.workspaceId,
      routineId: dismissedDurationInsightEvent.routineId,
      insightKey: dismissedDurationInsightEvent.insightKey,
      kind: dismissedDurationInsightEvent.kind,
      routineVersion: dismissedDurationInsightEvent.routineVersion,
      observedMedianMinutes: dismissedDurationInsightEvent.observedMedianMinutes,
      suggestedExpectedMinutes: dismissedDurationInsightEvent.suggestedExpectedMinutes,
      idempotencyKey: dismissedDurationInsightEvent.idempotencyKey,
      recordedAt: dismissedDurationInsightEvent.recordedAt,
    },
    {
      workspaceId: createdWorkspaceId,
      routineId: createdRoutineId,
      insightKey: initialDurationInsightKey,
      kind: "dismissed",
      routineVersion: 2,
      observedMedianMinutes: 50,
      suggestedExpectedMinutes: 50,
      idempotencyKey: "duration-insight-dismiss-initial",
      recordedAt: "2026-07-15T07:00:00.000Z",
    },
  );
  const replayedDurationDismissal = await app.inject(dismissDurationInsightRequest);
  assert.equal(replayedDurationDismissal.statusCode, 200, replayedDurationDismissal.body);
  assert.deepEqual(replayedDurationDismissal.json(), dismissDurationInsightResponse.json());
  const conflictingDurationDismissal = await app.inject({
    ...dismissDurationInsightRequest,
    payload: { ...dismissDurationInsightRequest.payload, expectedVersion: 3 },
  });
  assert.equal(conflictingDurationDismissal.statusCode, 409, conflictingDurationDismissal.body);
  assert.equal(
    conflictingDurationDismissal.json<{ error: { code: string } }>().error.code,
    "routine_duration_insight.idempotency_conflict",
  );

  const dismissedDurationInsightReads = await Promise.all([
    app.inject({
      method: "GET",
      url: `/v1/workspaces/${createdWorkspaceId}/routines/${createdRoutineId}/duration-insight`,
    }),
    app.inject({
      method: "GET",
      url: `/v1/workspaces/${createdWorkspaceId}/routines/${createdRoutineId}/duration-insight`,
    }),
  ]);
  for (const dismissedDurationInsightRead of dismissedDurationInsightReads) {
    assert.equal(dismissedDurationInsightRead.statusCode, 200, dismissedDurationInsightRead.body);
    assert.deepEqual(
      dismissedDurationInsightRead.json<{
        insightKey: string | null;
        disposition: string;
        dismissedAt: string | null;
      }>(),
      {
        ...durationInsight,
        disposition: "dismissed",
        dismissedAt: dismissedDurationInsightEvent.recordedAt,
      },
    );
  }

  const resetDurationInsightRequest = {
    method: "POST" as const,
    url: `/v1/workspaces/${createdWorkspaceId}/routines/${createdRoutineId}/duration-insight/dismissal-resets`,
    headers: { "idempotency-key": "duration-insight-reset-initial" },
    payload: { expectedVersion: 2, insightKey: initialDurationInsightKey },
  };
  const resetDurationInsightResponse = await app.inject(resetDurationInsightRequest);
  assert.equal(resetDurationInsightResponse.statusCode, 200, resetDurationInsightResponse.body);
  const resetDurationInsightEvent = resetDurationInsightResponse.json<{
    insightKey: string;
    kind: string;
    idempotencyKey: string;
  }>();
  assert.deepEqual(
    {
      insightKey: resetDurationInsightEvent.insightKey,
      kind: resetDurationInsightEvent.kind,
      idempotencyKey: resetDurationInsightEvent.idempotencyKey,
    },
    {
      insightKey: initialDurationInsightKey,
      kind: "reset",
      idempotencyKey: "duration-insight-reset-initial",
    },
  );
  const replayedDurationReset = await app.inject(resetDurationInsightRequest);
  assert.equal(replayedDurationReset.statusCode, 200, replayedDurationReset.body);
  assert.deepEqual(replayedDurationReset.json(), resetDurationInsightResponse.json());
  const resetDurationInsightRead = await app.inject({
    method: "GET",
    url: `/v1/workspaces/${createdWorkspaceId}/routines/${createdRoutineId}/duration-insight`,
  });
  assert.equal(resetDurationInsightRead.statusCode, 200, resetDurationInsightRead.body);
  assert.equal(resetDurationInsightRead.json<{ disposition: string }>().disposition, "available");
  assert.equal(resetDurationInsightRead.json<{ dismissedAt: string | null }>().dismissedAt, null);

  const secondDurationDismissal = await app.inject({
    ...dismissDurationInsightRequest,
    headers: { "idempotency-key": "duration-insight-dismiss-before-new-evidence" },
  });
  assert.equal(secondDurationDismissal.statusCode, 200, secondDurationDismissal.body);
  const routineAfterDurationFeedbackResponse = await app.inject({
    method: "GET",
    url: `/v1/workspaces/${createdWorkspaceId}/routines/${createdRoutineId}`,
  });
  assert.equal(
    routineAfterDurationFeedbackResponse.statusCode,
    200,
    routineAfterDurationFeedbackResponse.body,
  );
  assert.deepEqual(routineAfterDurationFeedbackResponse.json(), routineBeforeDurationFeedback);
  const planHeadsAfterDurationFeedback = await connection.sql<
    { local_date: string; current_plan_id: string; version: number }[]
  >`
    select local_date::text, current_plan_id::text, version
    from daily_plan_heads
    where workspace_id = ${createdWorkspaceId}
    order by local_date, id
  `;
  assert.deepEqual(planHeadsAfterDurationFeedback, planHeadsBeforeDurationFeedback);

  // A Today completion does not read or update its routine row. This interleaving proves that the
  // approval captures its evidence cutoff after the lock wait and observes the preceding commit.
  for (const [index, minutes] of [40, 50, 60, 70].entries()) {
    const alternativeSampleResponse: { statusCode: number; body: string } = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${createdWorkspaceId}/routines/${alternativeRoutineId}/activity-events`,
      headers: { "idempotency-key": `duration-plan-race-sample-${index}` },
      payload: {
        type: "completed",
        occurredAt: `2026-07-${String(11 + index).padStart(2, "0")}T06:00:00.000Z`,
        timeZone: "UTC",
        durationMinutes: minutes,
      },
    });
    assert.equal(alternativeSampleResponse.statusCode, 200, alternativeSampleResponse.body);
  }
  const alternativeInsightBeforeRaceResponse = await app.inject({
    method: "GET",
    url: `/v1/workspaces/${createdWorkspaceId}/routines/${alternativeRoutineId}/duration-insight`,
  });
  assert.equal(
    alternativeInsightBeforeRaceResponse.statusCode,
    200,
    alternativeInsightBeforeRaceResponse.body,
  );
  const alternativeInsightBeforeRace = alternativeInsightBeforeRaceResponse.json<{
    routineVersion: number;
    status: string;
    sampleCount: number;
    observedMedianMinutes: number | null;
    suggestedExpectedMinutes: number | null;
    insightKey: string | null;
    disposition: string;
    dismissedAt: string | null;
  }>();
  assert.match(alternativeInsightBeforeRace.insightKey ?? "", /^[0-9a-f]{64}$/);
  assert.deepEqual(alternativeInsightBeforeRace, {
    routineId: alternativeRoutineId,
    routineVersion: 1,
    status: "suggested",
    sampleCount: 4,
    minimumSamples: 3,
    lookbackDays: 90,
    evaluatedAt: "2026-07-15T07:00:00.000Z",
    windowStartedAt: "2026-04-16T07:00:00.000Z",
    currentExpectedMinutes: 30,
    minimumMinutes: 20,
    maximumMinutes: 120,
    observedMedianMinutes: 55,
    materialThresholdMinutes: 5,
    suggestedExpectedMinutes: 55,
    insightKey: alternativeInsightBeforeRace.insightKey,
    disposition: "available",
    dismissedAt: null,
  });

  let markPlanCompletionLockAcquired: () => void = () => undefined;
  const planCompletionLockAcquired = new Promise<void>((resolve) => {
    markPlanCompletionLockAcquired = resolve;
  });
  const releasePlanCompletionLock = new Promise<void>((resolve) => {
    releaseConcurrencyLock = resolve;
  });
  const alternativeRoutineLockKey = `${createdWorkspaceId}:routine:${alternativeRoutineId}`;
  heldLock = lockConnection.sql.begin(async (sql) => {
    await sql`select pg_advisory_xact_lock(hashtextextended(${alternativeRoutineLockKey}, 0))`;
    markPlanCompletionLockAcquired();
    await releasePlanCompletionLock;
  });
  await planCompletionLockAcquired;
  const queuedPlanCompletion = app.inject({
    method: "POST",
    url: `/v1/workspaces/${createdWorkspaceId}/plans/2026-07-15/items/${replacement.items[0]!.id}/activity-events`,
    headers: { "idempotency-key": "duration-plan-race-completion" },
    payload: {
      expectedPlanId: replacement.id,
      expectedHeadVersion: 7,
      type: "completed",
      occurredAt: "2026-07-15T07:00:30.000Z",
      timeZone: "UTC",
      durationMinutes: 20,
    },
  });
  let planCompletionWaiterObserved = false;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const [waiters] = await observerConnection.sql<{ value: number }[]>`
      select count(*)::int as value
      from pg_locks
      where locktype = 'advisory' and not granted
    `;
    if ((waiters?.value ?? 0) >= 1) {
      planCompletionWaiterObserved = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(
    planCompletionWaiterObserved,
    true,
    "plan-item completion did not reach its routine activity lock",
  );
  const stalePlanEvidenceApproval = app.inject({
    method: "POST",
    url: `/v1/workspaces/${createdWorkspaceId}/routines/${alternativeRoutineId}/duration-insight/approve`,
    payload: {
      expectedVersion: 1,
      duration: {
        minimumMinutes: 20,
        expectedMinutes: 55,
        maximumMinutes: 120,
        splittable: false,
        minimumSessionMinutes: null,
        overheadMinutes: 0,
      },
    },
  });
  let planEvidenceApprovalWaiterObserved = false;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const [waiters] = await observerConnection.sql<{ value: number }[]>`
      select count(*)::int as value
      from pg_locks
      where locktype = 'advisory' and not granted
    `;
    if ((waiters?.value ?? 0) >= 2) {
      planEvidenceApprovalWaiterObserved = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(
    planEvidenceApprovalWaiterObserved,
    true,
    "duration approval did not wait behind the queued plan-item completion",
  );
  productClockNow = new Date("2026-07-15T07:01:00.000Z");
  releaseHeldConcurrencyLock();
  await heldLock;
  heldLock = null;
  const queuedPlanCompletionResponse = await queuedPlanCompletion;
  assert.equal(queuedPlanCompletionResponse.statusCode, 200, queuedPlanCompletionResponse.body);
  assert.equal(queuedPlanCompletionResponse.json<{ headVersion: number }>().headVersion, 8);
  const stalePlanEvidenceApprovalResponse = await stalePlanEvidenceApproval;
  assert.equal(
    stalePlanEvidenceApprovalResponse.statusCode,
    409,
    stalePlanEvidenceApprovalResponse.body,
  );
  assert.equal(
    stalePlanEvidenceApprovalResponse.json<{ error: { code: string } }>().error.code,
    "routine_duration_insight.evidence_conflict",
  );
  const alternativeInsightAfterRaceResponse = await app.inject({
    method: "GET",
    url: `/v1/workspaces/${createdWorkspaceId}/routines/${alternativeRoutineId}/duration-insight`,
  });
  assert.equal(
    alternativeInsightAfterRaceResponse.statusCode,
    200,
    alternativeInsightAfterRaceResponse.body,
  );
  const alternativeInsightAfterRace = alternativeInsightAfterRaceResponse.json<{
    sampleCount: number;
    observedMedianMinutes: number | null;
    suggestedExpectedMinutes: number | null;
  }>();
  assert.equal(alternativeInsightAfterRace.sampleCount, 5);
  assert.equal(alternativeInsightAfterRace.observedMedianMinutes, 50);
  assert.equal(alternativeInsightAfterRace.suggestedExpectedMinutes, 50);
  productClockNow = new Date(productClockBaseline.getTime());

  let markDurationApprovalLockAcquired: () => void = () => undefined;
  const durationApprovalLockAcquired = new Promise<void>((resolve) => {
    markDurationApprovalLockAcquired = resolve;
  });
  const releaseDurationApprovalLock = new Promise<void>((resolve) => {
    releaseConcurrencyLock = resolve;
  });
  heldLock = lockConnection.sql.begin(async (sql) => {
    await sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
    markDurationApprovalLockAcquired();
    await releaseDurationApprovalLock;
  });
  await durationApprovalLockAcquired;
  const evidenceChange = app.inject({
    method: "POST",
    url: `/v1/workspaces/${createdWorkspaceId}/routines/${createdRoutineId}/activity-events`,
    headers: { "idempotency-key": "duration-sample-3-late-correction" },
    payload: {
      type: "duration_corrected",
      occurredAt: "2026-07-15T06:50:00.000Z",
      timeZone: "UTC",
      durationMinutes: 25,
      referenceEventId: durationCompletionIds[2],
    },
  });
  let durationCorrectionWaiterObserved = false;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const [waiters] = await observerConnection.sql<{ value: number }[]>`
      select count(*)::int as value
      from pg_locks
      where locktype = 'advisory' and not granted
    `;
    if ((waiters?.value ?? 0) >= 1) {
      durationCorrectionWaiterObserved = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(
    durationCorrectionWaiterObserved,
    true,
    "duration correction did not reach its referenced activity insert",
  );
  const staleEvidenceApproval = app.inject({
    method: "POST",
    url: `/v1/workspaces/${createdWorkspaceId}/routines/${createdRoutineId}/duration-insight/approve`,
    payload: {
      expectedVersion: 2,
      duration: {
        minimumMinutes: 20,
        expectedMinutes: 50,
        maximumMinutes: 60,
        splittable: false,
        minimumSessionMinutes: null,
        overheadMinutes: 0,
      },
    },
  });
  let durationApprovalWaiterObserved = false;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const [waiters] = await observerConnection.sql<{ value: number }[]>`
      select count(*)::int as value
      from pg_locks
      where locktype = 'advisory' and not granted
    `;
    if ((waiters?.value ?? 0) >= 2) {
      durationApprovalWaiterObserved = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(
    durationApprovalWaiterObserved,
    true,
    "duration approval did not reach its versioned save",
  );
  releaseHeldConcurrencyLock();
  await heldLock;
  heldLock = null;
  const evidenceChangeResponse = await evidenceChange;
  assert.equal(evidenceChangeResponse.statusCode, 200, evidenceChangeResponse.body);
  const staleEvidenceApprovalResponse = await staleEvidenceApproval;
  assert.equal(staleEvidenceApprovalResponse.statusCode, 409, staleEvidenceApprovalResponse.body);
  assert.equal(
    staleEvidenceApprovalResponse.json<{ error: { code: string } }>().error.code,
    "routine_duration_insight.evidence_conflict",
  );
  const refreshedDurationInsightResponse = await app.inject({
    method: "GET",
    url: `/v1/workspaces/${createdWorkspaceId}/routines/${createdRoutineId}/duration-insight`,
  });
  assert.equal(
    refreshedDurationInsightResponse.statusCode,
    200,
    refreshedDurationInsightResponse.body,
  );
  const refreshedDurationInsight = refreshedDurationInsightResponse.json<{
    routineVersion: number;
    status: string;
    sampleCount: number;
    currentExpectedMinutes: number;
    observedMedianMinutes: number | null;
    suggestedExpectedMinutes: number | null;
    insightKey: string | null;
    disposition: string;
    dismissedAt: string | null;
  }>();
  assert.match(refreshedDurationInsight.insightKey ?? "", /^[0-9a-f]{64}$/);
  assert.notEqual(
    refreshedDurationInsight.insightKey,
    initialDurationInsightKey,
    "materially changed evidence must produce a new duration-insight key",
  );
  assert.deepEqual(refreshedDurationInsight, {
    routineId: createdRoutineId,
    routineVersion: 2,
    status: "suggested",
    sampleCount: 4,
    minimumSamples: 3,
    lookbackDays: 90,
    evaluatedAt: "2026-07-15T07:00:00.000Z",
    windowStartedAt: "2026-04-16T07:00:00.000Z",
    currentExpectedMinutes: 30,
    minimumMinutes: 20,
    maximumMinutes: 60,
    observedMedianMinutes: 48,
    materialThresholdMinutes: 5,
    suggestedExpectedMinutes: 48,
    insightKey: refreshedDurationInsight.insightKey,
    disposition: "available",
    dismissedAt: null,
  });
  const planHeadsBeforeDurationApproval = await connection.sql<
    { local_date: string; current_plan_id: string; version: number }[]
  >`
    select local_date::text, current_plan_id::text, version
    from daily_plan_heads
    where workspace_id = ${createdWorkspaceId}
    order by local_date, id
  `;
  const durationApprovalResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${createdWorkspaceId}/routines/${createdRoutineId}/duration-insight/approve`,
    payload: {
      expectedVersion: 2,
      duration: {
        minimumMinutes: 20,
        expectedMinutes: 48,
        maximumMinutes: 60,
        splittable: false,
        minimumSessionMinutes: null,
        overheadMinutes: 0,
      },
    },
  });
  assert.equal(durationApprovalResponse.statusCode, 200, durationApprovalResponse.body);
  const approvedDurationRoutine = durationApprovalResponse.json<{
    id: string;
    version: number;
    duration: {
      minimumMinutes: number;
      expectedMinutes: number;
      maximumMinutes: number;
      splittable: boolean;
      minimumSessionMinutes: number | null;
      overheadMinutes: number;
    };
  }>();
  assert.equal(approvedDurationRoutine.id, createdRoutineId);
  assert.equal(approvedDurationRoutine.version, 3);
  assert.deepEqual(approvedDurationRoutine.duration, {
    minimumMinutes: 20,
    expectedMinutes: 48,
    maximumMinutes: 60,
    splittable: false,
    minimumSessionMinutes: null,
    overheadMinutes: 0,
  });
  const planHeadsAfterDurationApproval = await connection.sql<
    { local_date: string; current_plan_id: string; version: number }[]
  >`
    select local_date::text, current_plan_id::text, version
    from daily_plan_heads
    where workspace_id = ${createdWorkspaceId}
    order by local_date, id
  `;
  assert.deepEqual(planHeadsAfterDurationApproval, planHeadsBeforeDurationApproval);

  const alignedDurationInsightResponse = await app.inject({
    method: "GET",
    url: `/v1/workspaces/${createdWorkspaceId}/routines/${createdRoutineId}/duration-insight`,
  });
  assert.equal(alignedDurationInsightResponse.statusCode, 200, alignedDurationInsightResponse.body);
  const alignedDurationInsight = alignedDurationInsightResponse.json<{
    routineVersion: number;
    status: string;
    currentExpectedMinutes: number;
    observedMedianMinutes: number | null;
    suggestedExpectedMinutes: number | null;
    insightKey: string | null;
    disposition: string;
    dismissedAt: string | null;
  }>();
  assert.equal(alignedDurationInsight.routineVersion, 3);
  assert.equal(alignedDurationInsight.status, "aligned");
  assert.equal(alignedDurationInsight.currentExpectedMinutes, 48);
  assert.equal(alignedDurationInsight.observedMedianMinutes, 48);
  assert.equal(alignedDurationInsight.suggestedExpectedMinutes, null);
  assert.equal(alignedDurationInsight.insightKey, null);
  assert.equal(alignedDurationInsight.disposition, "available");
  assert.equal(alignedDurationInsight.dismissedAt, null);
  const staleDurationApprovalResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${createdWorkspaceId}/routines/${createdRoutineId}/duration-insight/approve`,
    payload: {
      expectedVersion: 2,
      duration: {
        minimumMinutes: 20,
        expectedMinutes: 48,
        maximumMinutes: 60,
        splittable: false,
        minimumSessionMinutes: null,
        overheadMinutes: 0,
      },
    },
  });
  assert.equal(staleDurationApprovalResponse.statusCode, 409, staleDurationApprovalResponse.body);
  assert.equal(
    staleDurationApprovalResponse.json<{ error: { code: string } }>().error.code,
    "routine.version_conflict",
  );
  const missingRoutineResponse = await app.inject({
    method: "GET",
    url: `/v1/workspaces/${createdWorkspaceId}/routines/77777777-7777-4777-8777-777777777777`,
  });
  assert.equal(missingRoutineResponse.statusCode, 404, missingRoutineResponse.body);

  // EVIDENCE: temporary-routine-feedback-postgres-api
  // Feedback is an immutable, tenant-bound planning input. It creates a fresh
  // plan revision without disguising the user's preference as routine activity
  // or silently changing the routine's cadence.
  {
    type FeedbackPlan = {
      id: string;
      headVersion: number;
      requestRevision: number;
      items: {
        id: string;
        sourceType: "routine" | "work_item";
        routineId: string | null;
        workItemId: string | null;
      }[];
      exclusions: { routineId: string | null; codes: string[] }[];
    };
    type FeedbackRow = {
      id: string;
      ingestedSequence: number;
      kind: "not_today" | "not_this_week" | "reset";
      effectiveOn: string;
      effectiveThrough: string | null;
      timeZone: string;
      sourcePlanId: string;
      sourcePlanItemId: string | null;
      idempotencyKey: string;
    };
    type RoutinePersistenceSnapshot = {
      version: number;
      cadencePeriod: string;
      rollingIntervalDays: number | null;
      targetCompletions: number;
      minimumCompletions: number | null;
      maximumCompletions: number | null;
      minimumSpacingDays: number;
      preferredWeekdays: number[];
      excludedWeekdays: number[];
      discourageConsecutiveDays: boolean;
      prohibitConsecutiveDays: boolean;
      weekStartsOn: number;
      startsOn: string | null;
      pausedUntil: string | null;
      endsOn: string | null;
      updatedAt: string;
    };

    const feedbackWorkspaceResponse = await app.inject({
      method: "POST",
      url: "/v1/workspaces",
      payload: { name: "Temporary feedback PostgreSQL verification" },
    });
    assert.equal(feedbackWorkspaceResponse.statusCode, 201, feedbackWorkspaceResponse.body);
    feedbackWorkspaceId = feedbackWorkspaceResponse.json<{ id: string }>().id;
    const temporaryFeedbackWorkspaceId = feedbackWorkspaceId;
    if (isolatedWorkspaceId === null) throw new Error("Isolation workspace was not created.");
    const tenantIsolationWorkspaceId = isolatedWorkspaceId;

    const feedbackRoutineResponse = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${temporaryFeedbackWorkspaceId}/routines`,
      payload: {
        title: "Temporary-feedback routine",
        tags: {
          priority: "high",
          contexts: ["feedback-verification"],
          categories: ["verification"],
        },
        duration: { minimumMinutes: 20, expectedMinutes: 30, maximumMinutes: 45 },
        cadence: {
          period: "week",
          targetCompletions: 1,
          maximumCompletions: 2,
          weekStartsOn: 1,
        },
      },
    });
    assert.equal(feedbackRoutineResponse.statusCode, 201, feedbackRoutineResponse.body);
    const temporaryFeedbackRoutineId = feedbackRoutineResponse.json<{ id: string }>().id;
    const provenanceRoutineResponse = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${temporaryFeedbackWorkspaceId}/routines`,
      payload: {
        title: "Different provenance routine",
        tags: {
          priority: "low",
          contexts: ["different-provenance"],
          categories: ["verification"],
        },
        duration: { minimumMinutes: 15, expectedMinutes: 20, maximumMinutes: 30 },
        cadence: { period: "day", targetCompletions: 1 },
      },
    });
    assert.equal(provenanceRoutineResponse.statusCode, 201, provenanceRoutineResponse.body);
    const provenanceRoutineId = provenanceRoutineResponse.json<{ id: string }>().id;

    const loadRoutineSnapshot = async (): Promise<RoutinePersistenceSnapshot> => {
      const [snapshot] = await connection.sql<RoutinePersistenceSnapshot[]>`
        select
          version,
          cadence_period as "cadencePeriod",
          rolling_interval_days as "rollingIntervalDays",
          target_completions as "targetCompletions",
          minimum_completions as "minimumCompletions",
          maximum_completions as "maximumCompletions",
          minimum_spacing_days as "minimumSpacingDays",
          preferred_weekdays as "preferredWeekdays",
          excluded_weekdays as "excludedWeekdays",
          discourage_consecutive_days as "discourageConsecutiveDays",
          prohibit_consecutive_days as "prohibitConsecutiveDays",
          week_starts_on as "weekStartsOn",
          starts_on::text as "startsOn",
          paused_until::text as "pausedUntil",
          ends_on::text as "endsOn",
          updated_at::text as "updatedAt"
        from routines
        where workspace_id = ${temporaryFeedbackWorkspaceId}
          and id = ${temporaryFeedbackRoutineId}
      `;
      assert.notEqual(snapshot, undefined);
      return snapshot!;
    };
    const loadActivityCount = async (): Promise<number> => {
      const [row] = await connection.sql<{ count: number }[]>`
        select count(*)::int as count
        from activity_events
        where workspace_id = ${temporaryFeedbackWorkspaceId}
      `;
      return row?.count ?? -1;
    };
    const loadFeedbackRows = (): Promise<FeedbackRow[]> =>
      connection.sql<FeedbackRow[]>`
        select
          id::text,
          ingested_sequence::int as "ingestedSequence",
          kind,
          effective_on::text as "effectiveOn",
          effective_through::text as "effectiveThrough",
          time_zone as "timeZone",
          source_plan_id::text as "sourcePlanId",
          source_plan_item_id::text as "sourcePlanItemId",
          idempotency_key as "idempotencyKey"
        from routine_planning_feedback_events
        where workspace_id = ${temporaryFeedbackWorkspaceId}
        order by ingested_sequence
      `;
    const loadPlanCount = async (): Promise<number> => {
      const [row] = await connection.sql<{ count: number }[]>`
        select count(*)::int as count
        from daily_plans
        where workspace_id = ${temporaryFeedbackWorkspaceId}
          and local_date = '2026-07-15'
      `;
      return row?.count ?? -1;
    };
    const loadMutationKinds = async (): Promise<string[]> => {
      const rows = await connection.sql<{ kind: string }[]>`
        select kind
        from plan_mutations
        where workspace_id = ${temporaryFeedbackWorkspaceId}
          and local_date = '2026-07-15'
        order by result_head_version
      `;
      return rows.map((row) => row.kind);
    };

    const routineSnapshotBeforeFeedback = await loadRoutineSnapshot();
    const activityCountBeforeFeedback = await loadActivityCount();
    assert.equal(activityCountBeforeFeedback, 0);
    const feedbackPlanRequest = {
      timeZone: "UTC",
      availableWindows: [
        {
          startsAt: "2026-07-15T12:00:00.000Z",
          endsAt: "2026-07-15T13:00:00.000Z",
        },
      ],
      targetMinutes: 30,
      targetTaskCount: 1,
      availableContexts: ["feedback-verification"],
      seed: "temporary-feedback-initial",
    };
    const initialFeedbackPlanResponse = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${temporaryFeedbackWorkspaceId}/plans`,
      payload: {
        ...feedbackPlanRequest,
        date: "2026-07-15",
        requestRevision: 1,
      },
    });
    assert.equal(initialFeedbackPlanResponse.statusCode, 200, initialFeedbackPlanResponse.body);
    const initialFeedbackPlan =
      initialFeedbackPlanResponse.json<Omit<FeedbackPlan, "headVersion">>();
    assert.equal(initialFeedbackPlan.requestRevision, 1);
    assert.equal(initialFeedbackPlan.items.length, 1);
    assert.equal(initialFeedbackPlan.items[0]?.routineId, temporaryFeedbackRoutineId);
    assert.equal(await loadPlanCount(), 1);

    const initialFeedbackCurrentResponse = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${temporaryFeedbackWorkspaceId}/plans/2026-07-15/current`,
    });
    assert.equal(
      initialFeedbackCurrentResponse.statusCode,
      200,
      initialFeedbackCurrentResponse.body,
    );
    assert.equal(initialFeedbackCurrentResponse.json<{ headVersion: number }>().headVersion, 1);

    await assert.rejects(
      connection.sql`
        insert into routine_planning_feedback_events (
          workspace_id,
          routine_id,
          kind,
          effective_on,
          effective_through,
          time_zone,
          source_plan_id,
          source_plan_item_id,
          idempotency_key,
          recorded_at
        ) values (
          ${temporaryFeedbackWorkspaceId},
          ${provenanceRoutineId},
          'not_today',
          '2026-07-15',
          '2026-07-15',
          'UTC',
          ${initialFeedbackPlan.id},
          ${initialFeedbackPlan.items[0]!.id},
          'temporary-feedback-mismatched-routine-provenance',
          '2026-07-15T07:00:00.000Z'
        )
      `,
      (error) =>
        hasDatabaseConstraint(
          error,
          "23503",
          "routine_planning_feedback_events_source_routine_item_fk",
        ),
    );
    assert.equal((await loadFeedbackRows()).length, 0);

    const provenanceWorkResponse = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${temporaryFeedbackWorkspaceId}/work-items`,
      payload: {
        title: "Work-item provenance fixture",
        status: "in_progress",
        priority: "low",
        planningDurationMinutes: 20,
      },
    });
    assert.equal(provenanceWorkResponse.statusCode, 201, provenanceWorkResponse.body);
    const provenanceWork = provenanceWorkResponse.json<{ id: string; version: number }>();
    const provenanceWorkPlanResponse = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${temporaryFeedbackWorkspaceId}/plans`,
      payload: {
        date: "2026-07-14",
        timeZone: "UTC",
        availableWindows: [
          {
            startsAt: "2026-07-14T12:00:00.000Z",
            endsAt: "2026-07-14T13:00:00.000Z",
          },
        ],
        targetMinutes: 20,
        targetTaskCount: 1,
        availableContexts: [],
        seed: "temporary-feedback-work-provenance",
        requestRevision: 1,
      },
    });
    assert.equal(provenanceWorkPlanResponse.statusCode, 200, provenanceWorkPlanResponse.body);
    const provenanceWorkPlan = provenanceWorkPlanResponse.json<FeedbackPlan>();
    assert.equal(provenanceWorkPlan.items.length, 1);
    assert.equal(provenanceWorkPlan.items[0]?.sourceType, "work_item");
    assert.equal(provenanceWorkPlan.items[0]?.workItemId, provenanceWork.id);
    await assert.rejects(
      connection.sql`
        insert into routine_planning_feedback_events (
          workspace_id,
          routine_id,
          kind,
          effective_on,
          effective_through,
          time_zone,
          source_plan_id,
          source_plan_item_id,
          idempotency_key,
          recorded_at
        ) values (
          ${temporaryFeedbackWorkspaceId},
          ${temporaryFeedbackRoutineId},
          'not_today',
          '2026-07-14',
          '2026-07-14',
          'UTC',
          ${provenanceWorkPlan.id},
          ${provenanceWorkPlan.items[0]!.id},
          'temporary-feedback-work-item-provenance',
          '2026-07-15T07:00:00.000Z'
        )
      `,
      (error) =>
        hasDatabaseConstraint(
          error,
          "23503",
          "routine_planning_feedback_events_source_routine_item_fk",
        ),
    );
    assert.equal((await loadFeedbackRows()).length, 0);
    const retireProvenanceWorkResponse = await app.inject({
      method: "PATCH",
      url: `/v1/workspaces/${temporaryFeedbackWorkspaceId}/work-items/${provenanceWork.id}`,
      payload: { expectedVersion: provenanceWork.version, status: "cancelled" },
    });
    assert.equal(retireProvenanceWorkResponse.statusCode, 200, retireProvenanceWorkResponse.body);

    const crossTenantFeedbackResponse = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${tenantIsolationWorkspaceId}/plans/2026-07-15/items/${initialFeedbackPlan.items[0]!.id}/routine-feedback`,
      headers: { "idempotency-key": "temporary-feedback-cross-tenant" },
      payload: {
        expectedPlanId: initialFeedbackPlan.id,
        expectedHeadVersion: 1,
        kind: "not_today",
        request: { ...feedbackPlanRequest, seed: "temporary-feedback-cross-tenant" },
      },
    });
    assert.equal(crossTenantFeedbackResponse.statusCode, 404, crossTenantFeedbackResponse.body);
    assert.equal((await loadFeedbackRows()).length, 0);
    assert.equal(await loadPlanCount(), 1);
    await assert.rejects(
      connection.sql`
        insert into routine_planning_feedback_events (
          workspace_id,
          routine_id,
          kind,
          effective_on,
          effective_through,
          time_zone,
          source_plan_id,
          source_plan_item_id,
          idempotency_key,
          recorded_at
        ) values (
          ${tenantIsolationWorkspaceId},
          ${temporaryFeedbackRoutineId},
          'not_today',
          '2026-07-15',
          '2026-07-15',
          'UTC',
          ${initialFeedbackPlan.id},
          ${initialFeedbackPlan.items[0]!.id},
          'temporary-feedback-invalid-cross-tenant-provenance',
          '2026-07-15T07:00:00.000Z'
        )
      `,
      (error) => hasDatabaseCode(error, "23503"),
    );
    assert.equal((await loadFeedbackRows()).length, 0);

    const notTodayRequest = {
      method: "POST" as const,
      url: `/v1/workspaces/${temporaryFeedbackWorkspaceId}/plans/2026-07-15/items/${initialFeedbackPlan.items[0]!.id}/routine-feedback`,
      headers: { "idempotency-key": "temporary-feedback-not-today" },
      payload: {
        expectedPlanId: initialFeedbackPlan.id,
        expectedHeadVersion: 1,
        kind: "not_today" as const,
        request: { ...feedbackPlanRequest, seed: "temporary-feedback-not-today" },
      },
    };
    const notTodayResponse = await app.inject(notTodayRequest);
    assert.equal(notTodayResponse.statusCode, 200, notTodayResponse.body);
    const notTodayPlan = notTodayResponse.json<FeedbackPlan>();
    assert.equal(notTodayPlan.headVersion, 2);
    assert.equal(notTodayPlan.requestRevision, 2);
    assert.notEqual(notTodayPlan.id, initialFeedbackPlan.id);
    assert.equal(
      notTodayPlan.items.some((item) => item.routineId === temporaryFeedbackRoutineId),
      false,
    );
    assert.equal(
      notTodayPlan.exclusions
        .find((exclusion) => exclusion.routineId === temporaryFeedbackRoutineId)
        ?.codes.includes("feedback_not_today"),
      true,
    );
    let feedbackRows = await loadFeedbackRows();
    assert.equal(feedbackRows.length, 1);
    assert.deepEqual(feedbackRows[0], {
      id: feedbackRows[0]!.id,
      ingestedSequence: feedbackRows[0]!.ingestedSequence,
      kind: "not_today",
      effectiveOn: "2026-07-15",
      effectiveThrough: "2026-07-15",
      timeZone: "UTC",
      sourcePlanId: initialFeedbackPlan.id,
      sourcePlanItemId: initialFeedbackPlan.items[0]!.id,
      idempotencyKey: "temporary-feedback-not-today",
    });
    assert.equal(feedbackRows[0]!.ingestedSequence > 0, true);
    assert.equal(await loadPlanCount(), 2);
    assert.deepEqual(await loadMutationKinds(), ["feedback"]);

    const replayedNotTodayResponse = await app.inject(notTodayRequest);
    assert.equal(replayedNotTodayResponse.statusCode, 200, replayedNotTodayResponse.body);
    assert.deepEqual(replayedNotTodayResponse.json(), notTodayResponse.json());
    assert.deepEqual(await loadFeedbackRows(), feedbackRows);
    assert.equal(await loadPlanCount(), 2);
    assert.deepEqual(await loadMutationKinds(), ["feedback"]);

    const conflictingNotTodayResponse = await app.inject({
      ...notTodayRequest,
      payload: { ...notTodayRequest.payload, kind: "not_this_week" },
    });
    assert.equal(conflictingNotTodayResponse.statusCode, 409, conflictingNotTodayResponse.body);
    assert.equal(
      conflictingNotTodayResponse.json<{ error: { code: string } }>().error.code,
      "planning.idempotency_conflict",
    );
    assert.deepEqual(await loadFeedbackRows(), feedbackRows);
    assert.equal(await loadPlanCount(), 2);

    const resetNotTodayResponse = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${temporaryFeedbackWorkspaceId}/plans/2026-07-15/routines/${temporaryFeedbackRoutineId}/routine-feedback-resets`,
      headers: { "idempotency-key": "temporary-feedback-reset-today" },
      payload: {
        expectedPlanId: notTodayPlan.id,
        expectedHeadVersion: 2,
        request: { ...feedbackPlanRequest, seed: "temporary-feedback-reset-today" },
      },
    });
    assert.equal(resetNotTodayResponse.statusCode, 200, resetNotTodayResponse.body);
    const resetNotTodayPlan = resetNotTodayResponse.json<FeedbackPlan>();
    assert.equal(resetNotTodayPlan.headVersion, 3);
    assert.equal(resetNotTodayPlan.requestRevision, 3);
    assert.equal(resetNotTodayPlan.items[0]?.routineId, temporaryFeedbackRoutineId);
    assert.equal(
      resetNotTodayPlan.exclusions.some((exclusion) =>
        exclusion.codes.some((code) => code.startsWith("feedback_")),
      ),
      false,
    );
    feedbackRows = await loadFeedbackRows();
    assert.equal(feedbackRows.length, 2);
    assert.deepEqual(feedbackRows[1], {
      id: feedbackRows[1]!.id,
      ingestedSequence: feedbackRows[1]!.ingestedSequence,
      kind: "reset",
      effectiveOn: "2026-07-15",
      effectiveThrough: null,
      timeZone: "UTC",
      sourcePlanId: notTodayPlan.id,
      sourcePlanItemId: null,
      idempotencyKey: "temporary-feedback-reset-today",
    });
    assert.equal(feedbackRows[1]!.ingestedSequence > feedbackRows[0]!.ingestedSequence, true);
    assert.equal(await loadPlanCount(), 3);

    const notThisWeekResponse = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${temporaryFeedbackWorkspaceId}/plans/2026-07-15/items/${resetNotTodayPlan.items[0]!.id}/routine-feedback`,
      headers: { "idempotency-key": "temporary-feedback-not-this-week" },
      payload: {
        expectedPlanId: resetNotTodayPlan.id,
        expectedHeadVersion: 3,
        kind: "not_this_week",
        request: { ...feedbackPlanRequest, seed: "temporary-feedback-not-this-week" },
      },
    });
    assert.equal(notThisWeekResponse.statusCode, 200, notThisWeekResponse.body);
    const notThisWeekPlan = notThisWeekResponse.json<FeedbackPlan>();
    assert.equal(notThisWeekPlan.headVersion, 4);
    assert.equal(notThisWeekPlan.requestRevision, 4);
    assert.equal(
      notThisWeekPlan.exclusions
        .find((exclusion) => exclusion.routineId === temporaryFeedbackRoutineId)
        ?.codes.includes("feedback_not_this_week"),
      true,
    );
    feedbackRows = await loadFeedbackRows();
    assert.equal(feedbackRows.length, 3);
    assert.deepEqual(feedbackRows[2], {
      id: feedbackRows[2]!.id,
      ingestedSequence: feedbackRows[2]!.ingestedSequence,
      kind: "not_this_week",
      effectiveOn: "2026-07-15",
      effectiveThrough: "2026-07-19",
      timeZone: "UTC",
      sourcePlanId: resetNotTodayPlan.id,
      sourcePlanItemId: resetNotTodayPlan.items[0]!.id,
      idempotencyKey: "temporary-feedback-not-this-week",
    });
    assert.equal(feedbackRows[2]!.ingestedSequence > feedbackRows[1]!.ingestedSequence, true);
    assert.equal(await loadPlanCount(), 4);

    const resetNotThisWeekResponse = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${temporaryFeedbackWorkspaceId}/plans/2026-07-15/routines/${temporaryFeedbackRoutineId}/routine-feedback-resets`,
      headers: { "idempotency-key": "temporary-feedback-reset-week" },
      payload: {
        expectedPlanId: notThisWeekPlan.id,
        expectedHeadVersion: 4,
        request: { ...feedbackPlanRequest, seed: "temporary-feedback-reset-week" },
      },
    });
    assert.equal(resetNotThisWeekResponse.statusCode, 200, resetNotThisWeekResponse.body);
    const resetNotThisWeekPlan = resetNotThisWeekResponse.json<FeedbackPlan>();
    assert.equal(resetNotThisWeekPlan.headVersion, 5);
    assert.equal(resetNotThisWeekPlan.requestRevision, 5);
    assert.equal(resetNotThisWeekPlan.items[0]?.routineId, temporaryFeedbackRoutineId);
    assert.equal(
      resetNotThisWeekPlan.exclusions.some((exclusion) =>
        exclusion.codes.some((code) => code.startsWith("feedback_")),
      ),
      false,
    );
    feedbackRows = await loadFeedbackRows();
    assert.equal(feedbackRows.length, 4);
    assert.deepEqual(
      feedbackRows.map((row) => row.kind),
      ["not_today", "reset", "not_this_week", "reset"],
    );
    assert.deepEqual(feedbackRows[3], {
      id: feedbackRows[3]!.id,
      ingestedSequence: feedbackRows[3]!.ingestedSequence,
      kind: "reset",
      effectiveOn: "2026-07-15",
      effectiveThrough: null,
      timeZone: "UTC",
      sourcePlanId: notThisWeekPlan.id,
      sourcePlanItemId: null,
      idempotencyKey: "temporary-feedback-reset-week",
    });
    assert.equal(feedbackRows[3]!.ingestedSequence > feedbackRows[2]!.ingestedSequence, true);
    assert.equal(await loadPlanCount(), 5);
    assert.deepEqual(await loadMutationKinds(), [
      "feedback",
      "feedback_reset",
      "feedback",
      "feedback_reset",
    ]);

    const finalFeedbackHeadRows = await connection.sql<
      { currentPlanId: string; version: number }[]
    >`
      select current_plan_id::text as "currentPlanId", version
      from daily_plan_heads
      where workspace_id = ${temporaryFeedbackWorkspaceId}
        and local_date = '2026-07-15'
    `;
    assert.equal(finalFeedbackHeadRows.length, 1);
    assert.deepEqual(finalFeedbackHeadRows[0], {
      currentPlanId: resetNotThisWeekPlan.id,
      version: 5,
    });
    assert.deepEqual(await loadRoutineSnapshot(), routineSnapshotBeforeFeedback);
    assert.equal(await loadActivityCount(), activityCountBeforeFeedback);

    await assert.rejects(
      connection.sql`
        update routine_planning_feedback_events
        set effective_through = '2026-07-16'
        where workspace_id = ${temporaryFeedbackWorkspaceId}
          and id = ${feedbackRows[0]!.id}
      `,
      (error) => hasDatabaseCode(error, "55000"),
    );
    await assert.rejects(
      connection.sql`
        delete from routine_planning_feedback_events
        where workspace_id = ${temporaryFeedbackWorkspaceId}
          and id = ${feedbackRows[0]!.id}
      `,
      (error) => hasDatabaseCode(error, "55000"),
    );
    assert.deepEqual(await loadFeedbackRows(), feedbackRows);

    const crossDatePlanRequest = {
      timeZone: "UTC",
      availableWindows: [
        {
          startsAt: "2026-07-16T12:00:00.000Z",
          endsAt: "2026-07-16T13:00:00.000Z",
        },
      ],
      targetMinutes: 30,
      targetTaskCount: 1,
      availableContexts: ["feedback-verification"],
      seed: "temporary-feedback-cross-date-plan",
    };
    const crossDatePlanResponse = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${temporaryFeedbackWorkspaceId}/plans`,
      payload: {
        ...crossDatePlanRequest,
        date: "2026-07-16",
        requestRevision: 1,
      },
    });
    assert.equal(crossDatePlanResponse.statusCode, 200, crossDatePlanResponse.body);
    const crossDatePlan = crossDatePlanResponse.json<FeedbackPlan>();
    assert.equal(crossDatePlan.items.length, 1);
    assert.equal(crossDatePlan.items[0]?.routineId, temporaryFeedbackRoutineId);

    const reusedCrossDateKeyResponse = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${temporaryFeedbackWorkspaceId}/plans/2026-07-16/items/${crossDatePlan.items[0]!.id}/routine-feedback`,
      headers: { "idempotency-key": "temporary-feedback-not-today" },
      payload: {
        expectedPlanId: crossDatePlan.id,
        expectedHeadVersion: 1,
        kind: "not_today",
        request: {
          ...crossDatePlanRequest,
          seed: "temporary-feedback-cross-date-apply",
        },
      },
    });
    assert.equal(reusedCrossDateKeyResponse.statusCode, 200, reusedCrossDateKeyResponse.body);
    const reusedCrossDateKeyPlan = reusedCrossDateKeyResponse.json<FeedbackPlan>();
    assert.equal(reusedCrossDateKeyPlan.headVersion, 2);
    feedbackRows = await loadFeedbackRows();
    assert.equal(feedbackRows.length, 5);
    assert.deepEqual(
      feedbackRows
        .filter((row) => row.idempotencyKey === "temporary-feedback-not-today")
        .map((row) => row.effectiveOn),
      ["2026-07-15", "2026-07-16"],
    );

    const resetCrossDateFeedbackResponse = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${temporaryFeedbackWorkspaceId}/plans/2026-07-16/routines/${temporaryFeedbackRoutineId}/routine-feedback-resets`,
      headers: { "idempotency-key": "temporary-feedback-cross-date-reset" },
      payload: {
        expectedPlanId: reusedCrossDateKeyPlan.id,
        expectedHeadVersion: 2,
        request: {
          ...crossDatePlanRequest,
          seed: "temporary-feedback-cross-date-reset",
        },
      },
    });
    assert.equal(
      resetCrossDateFeedbackResponse.statusCode,
      200,
      resetCrossDateFeedbackResponse.body,
    );
    const resetCrossDateFeedbackPlan = resetCrossDateFeedbackResponse.json<FeedbackPlan>();
    assert.equal(resetCrossDateFeedbackPlan.headVersion, 3);
    assert.equal(resetCrossDateFeedbackPlan.items[0]?.routineId, temporaryFeedbackRoutineId);
    feedbackRows = await loadFeedbackRows();
    assert.equal(feedbackRows.length, 6);

    const raceFixturePlanRequest = {
      timeZone: "UTC",
      availableWindows: [
        {
          startsAt: "2026-07-18T12:00:00.000Z",
          endsAt: "2026-07-18T13:00:00.000Z",
        },
      ],
      targetMinutes: 30,
      targetTaskCount: 1,
      availableContexts: ["feedback-verification"],
      seed: "temporary-feedback-race-fixture-plan",
    };
    const raceFixturePlanResponse = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${temporaryFeedbackWorkspaceId}/plans`,
      payload: {
        ...raceFixturePlanRequest,
        date: "2026-07-18",
        requestRevision: 1,
      },
    });
    assert.equal(raceFixturePlanResponse.statusCode, 200, raceFixturePlanResponse.body);
    const raceFixturePlan = raceFixturePlanResponse.json<FeedbackPlan>();
    assert.equal(raceFixturePlan.items.length, 1);
    assert.equal(raceFixturePlan.items[0]?.routineId, temporaryFeedbackRoutineId);

    const staleFeedbackPlanRequest = {
      timeZone: "UTC",
      availableWindows: [
        {
          startsAt: "2026-07-17T12:00:00.000Z",
          endsAt: "2026-07-17T13:00:00.000Z",
        },
      ],
      targetMinutes: 30,
      targetTaskCount: 1,
      availableContexts: ["feedback-verification"],
      seed: "temporary-feedback-stale-head-plan",
    };
    const staleFeedbackPlanResponse = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${temporaryFeedbackWorkspaceId}/plans`,
      payload: {
        ...staleFeedbackPlanRequest,
        date: "2026-07-17",
        requestRevision: 1,
      },
    });
    assert.equal(staleFeedbackPlanResponse.statusCode, 200, staleFeedbackPlanResponse.body);
    const staleFeedbackPlan = staleFeedbackPlanResponse.json<FeedbackPlan>();
    assert.equal(staleFeedbackPlan.items.length, 1);
    assert.equal(staleFeedbackPlan.items[0]?.routineId, temporaryFeedbackRoutineId);

    let markFeedbackFixturePrepared: () => void = () => undefined;
    const feedbackFixturePrepared = new Promise<void>((resolve) => {
      markFeedbackFixturePrepared = resolve;
    });
    const releaseFeedbackFixture = new Promise<void>((resolve) => {
      releaseConcurrencyLock = resolve;
    });
    const feedbackLockKey = `${temporaryFeedbackWorkspaceId}:planning-feedback:${temporaryFeedbackRoutineId}`;
    let feedbackLockHolderPid: number | null = null;
    heldLock = lockConnection.sql.begin(async (sql) => {
      const [backend] = await sql<{ pid: number }[]>`
        select pg_backend_pid()::int as pid
      `;
      feedbackLockHolderPid = backend?.pid ?? null;
      await sql`select pg_advisory_xact_lock(hashtextextended(${feedbackLockKey}, 0))`;
      await sql`
        insert into routine_planning_feedback_events (
          workspace_id,
          routine_id,
          kind,
          effective_on,
          effective_through,
          time_zone,
          source_plan_id,
          source_plan_item_id,
          idempotency_key,
          recorded_at
        ) values (
          ${temporaryFeedbackWorkspaceId},
          ${temporaryFeedbackRoutineId},
          'not_today',
          '2026-07-18',
          '2026-07-18',
          'UTC',
          ${raceFixturePlan.id},
          ${raceFixturePlan.items[0]!.id},
          'temporary-feedback-race-newer',
          '2026-07-15T07:00:00.000Z'
        )
      `;
      markFeedbackFixturePrepared();
      await releaseFeedbackFixture;
    });
    await feedbackFixturePrepared;
    assert.notEqual(feedbackLockHolderPid, null, "the feedback lock holder PID was not captured");
    assert.equal(
      (await loadFeedbackRows()).length,
      6,
      "the newer cross-date feedback must remain invisible before its transaction commits",
    );

    const staleFeedbackPlanRevisionCount = await connection.sql<{ count: number }[]>`
      select count(*)::int as count
      from daily_plans
      where workspace_id = ${temporaryFeedbackWorkspaceId}
        and local_date = '2026-07-17'
    `;
    assert.equal(staleFeedbackPlanRevisionCount[0]?.count, 1);
    const staleFeedbackMutation = app.inject({
      method: "POST",
      url: `/v1/workspaces/${temporaryFeedbackWorkspaceId}/plans/2026-07-17/items/${staleFeedbackPlan.items[0]!.id}/routine-feedback`,
      headers: { "idempotency-key": "temporary-feedback-stale-head" },
      payload: {
        expectedPlanId: staleFeedbackPlan.id,
        expectedHeadVersion: 1,
        kind: "not_today",
        request: staleFeedbackPlanRequest,
      },
    });
    let feedbackWaiterObserved = false;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const [waiters] = await observerConnection.sql<{ value: number }[]>`
        select count(*)::int as value
        from pg_locks waiter
        join pg_locks holder
          on holder.pid = ${feedbackLockHolderPid}
         and holder.locktype = 'advisory'
         and holder.granted
         and holder.database is not distinct from waiter.database
         and holder.classid = waiter.classid
         and holder.objid = waiter.objid
         and holder.objsubid = waiter.objsubid
        where waiter.locktype = 'advisory'
          and not waiter.granted
      `;
      if ((waiters?.value ?? 0) >= 1) {
        feedbackWaiterObserved = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(
      feedbackWaiterObserved,
      true,
      "the stale feedback mutation did not wait on its routine feedback head lock",
    );
    assert.equal((await loadFeedbackRows()).length, 6);
    releaseHeldConcurrencyLock();
    await heldLock;
    heldLock = null;

    const staleFeedbackMutationResponse = await staleFeedbackMutation;
    assert.equal(staleFeedbackMutationResponse.statusCode, 409, staleFeedbackMutationResponse.body);
    assert.equal(
      staleFeedbackMutationResponse.json<{ error: { code: string } }>().error.code,
      "planning.feedback_head_conflict",
    );
    feedbackRows = await loadFeedbackRows();
    assert.equal(feedbackRows.length, 7);
    assert.deepEqual(
      feedbackRows
        .filter((row) => row.idempotencyKey === "temporary-feedback-not-today")
        .map((row) => row.effectiveOn),
      ["2026-07-15", "2026-07-16"],
    );
    assert.equal(
      feedbackRows.some((row) => row.idempotencyKey === "temporary-feedback-stale-head"),
      false,
    );
    const staleFeedbackPlanRevisionCountAfter = await connection.sql<{ count: number }[]>`
      select count(*)::int as count
      from daily_plans
      where workspace_id = ${temporaryFeedbackWorkspaceId}
        and local_date = '2026-07-17'
    `;
    assert.equal(staleFeedbackPlanRevisionCountAfter[0]?.count, 1);
    process.stdout.write("temporary-routine-feedback-postgres-api verification passed\n");
  }

  {
    const groupWorkspaceResponse = await app.inject({
      method: "POST",
      url: "/v1/workspaces",
      payload: { name: "Routine groups verification" },
    });
    assert.equal(groupWorkspaceResponse.statusCode, 201, groupWorkspaceResponse.body);
    const groupWorkspaceId = groupWorkspaceResponse.json<{ id: string }>().id;
    routineGroupWorkspaceId = groupWorkspaceId;
    const createGroupRoutine = async (title: string) => {
      const response = await app.inject({
        method: "POST",
        url: `/v1/workspaces/${groupWorkspaceId}/routines`,
        payload: {
          title,
          tags: { priority: "medium", contexts: ["computer"] },
          duration: { minimumMinutes: 30, expectedMinutes: 30, maximumMinutes: 30 },
          cadence: { period: "week", targetCompletions: 3, maximumCompletions: 4 },
        },
      });
      assert.equal(response.statusCode, 201, response.body);
      return response.json<{ id: string }>().id;
    };
    const spanishRoutineId = await createGroupRoutine("Practice Spanish");
    const japaneseRoutineId = await createGroupRoutine("Study Japanese");
    const groupPlanningSettings = {
      timeZone: "UTC",
      availableWindows: [
        {
          startsAt: "2026-07-20T08:00:00.000Z",
          endsAt: "2026-07-20T09:00:00.000Z",
        },
      ],
      targetMinutes: 30,
      maximumMinutes: 60,
      targetTaskCount: 1,
      maximumTaskCount: 2,
      availableContexts: ["computer"],
      seed: "routine-groups-initial",
    };
    const initialGroupPlanResponse = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${groupWorkspaceId}/plans`,
      payload: {
        ...groupPlanningSettings,
        date: "2026-07-20",
        requestRevision: 1,
      },
    });
    assert.equal(initialGroupPlanResponse.statusCode, 200, initialGroupPlanResponse.body);
    const initialGroupPlan = initialGroupPlanResponse.json<{
      id: string;
      items: { routineId: string }[];
    }>();
    assert.equal(initialGroupPlan.items.length, 1);
    const initiallySelectedRoutineId = initialGroupPlan.items[0]!.routineId;
    const routineToAdd =
      initiallySelectedRoutineId === spanishRoutineId ? japaneseRoutineId : spanishRoutineId;

    const createGroupResponse = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${groupWorkspaceId}/routine-groups`,
      payload: { name: "Languages", description: "Languages I am learning" },
    });
    assert.equal(createGroupResponse.statusCode, 201, createGroupResponse.body);
    const createdGroup = createGroupResponse.json<{ id: string; version: number }>();
    const duplicateGroupResponse = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${groupWorkspaceId}/routine-groups`,
      payload: { name: "  languages  " },
    });
    assert.equal(duplicateGroupResponse.statusCode, 409, duplicateGroupResponse.body);
    assert.equal(
      duplicateGroupResponse.json<{ error: { code: string } }>().error.code,
      "routine_group.name_conflict",
    );

    const replaceGroupsPath = `/v1/workspaces/${groupWorkspaceId}/routines/${routineToAdd}/groups`;
    const assignedGroupResponse = await app.inject({
      method: "PUT",
      url: replaceGroupsPath,
      payload: { expectedGroupIds: [], groupIds: [createdGroup.id] },
    });
    const assignedGroupReplay = await app.inject({
      method: "PUT",
      url: replaceGroupsPath,
      payload: {
        expectedGroupIds: [createdGroup.id],
        groupIds: [createdGroup.id],
      },
    });
    assert.deepEqual(assignedGroupResponse.json(), { groupIds: [createdGroup.id] });
    assert.deepEqual(assignedGroupReplay.json(), { groupIds: [createdGroup.id] });
    const groupMembershipsResponse = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${groupWorkspaceId}/routine-group-memberships`,
    });
    assert.deepEqual(
      groupMembershipsResponse
        .json<{ items: { groupId: string; routineId: string }[] }>()
        .items.map(({ groupId, routineId }) => ({ groupId, routineId })),
      [{ groupId: createdGroup.id, routineId: routineToAdd }],
    );
    const staleGroupReplacement = await app.inject({
      method: "PUT",
      url: replaceGroupsPath,
      payload: { expectedGroupIds: [], groupIds: [] },
    });
    assert.equal(staleGroupReplacement.statusCode, 409, staleGroupReplacement.body);
    assert.equal(
      staleGroupReplacement.json<{ error: { code: string } }>().error.code,
      "routine_group.membership_conflict",
    );
    const removedGroups = await app.inject({
      method: "PUT",
      url: replaceGroupsPath,
      payload: { expectedGroupIds: [createdGroup.id], groupIds: [] },
    });
    assert.equal(removedGroups.statusCode, 200, removedGroups.body);
    assert.deepEqual(removedGroups.json(), { groupIds: [] });
    const restoredGroup = await app.inject({
      method: "PUT",
      url: replaceGroupsPath,
      payload: { expectedGroupIds: [], groupIds: [createdGroup.id] },
    });
    assert.deepEqual(restoredGroup.json(), { groupIds: [createdGroup.id] });

    const renamedGroupResponse = await app.inject({
      method: "PATCH",
      url: `/v1/workspaces/${groupWorkspaceId}/routine-groups/${createdGroup.id}`,
      payload: { expectedVersion: 1, name: "Language learning" },
    });
    assert.equal(renamedGroupResponse.statusCode, 200, renamedGroupResponse.body);
    assert.equal(renamedGroupResponse.json<{ version: number }>().version, 2);

    const additionPayload = {
      expectedPlanId: initialGroupPlan.id,
      expectedHeadVersion: 1,
      request: {
        ...groupPlanningSettings,
        seed: "routine-groups-addition",
      },
    };
    const additionPath = `/v1/workspaces/${groupWorkspaceId}/plans/2026-07-20/routines/${routineToAdd}/additions`;
    const addedRoutineResponse = await app.inject({
      method: "POST",
      url: additionPath,
      headers: { "idempotency-key": "routine-groups-add-to-today" },
      payload: additionPayload,
    });
    assert.equal(addedRoutineResponse.statusCode, 200, addedRoutineResponse.body);
    const addedRoutinePlan = addedRoutineResponse.json<{
      id: string;
      headVersion: number;
      items: { routineId: string }[];
    }>();
    assert.equal(addedRoutinePlan.headVersion, 2);
    assert.deepEqual(
      addedRoutinePlan.items.map((item) => item.routineId).sort(),
      [spanishRoutineId, japaneseRoutineId].sort(),
    );
    const additionReplay = await app.inject({
      method: "POST",
      url: additionPath,
      headers: { "idempotency-key": "routine-groups-add-to-today" },
      payload: additionPayload,
    });
    assert.deepEqual(additionReplay.json(), addedRoutineResponse.json());
    const alreadyPresentResponse = await app.inject({
      method: "POST",
      url: additionPath,
      headers: { "idempotency-key": "routine-groups-already-present" },
      payload: {
        ...additionPayload,
        expectedPlanId: addedRoutinePlan.id,
        expectedHeadVersion: 2,
        request: { ...additionPayload.request, seed: "routine-groups-already-present" },
      },
    });
    assert.equal(alreadyPresentResponse.statusCode, 200, alreadyPresentResponse.body);
    assert.equal(alreadyPresentResponse.json<{ id: string }>().id, addedRoutinePlan.id);
    assert.equal(alreadyPresentResponse.json<{ headVersion: number }>().headVersion, 2);

    const deleteGroupResponse = await app.inject({
      method: "DELETE",
      url: `/v1/workspaces/${groupWorkspaceId}/routine-groups/${createdGroup.id}`,
      payload: { expectedVersion: 2 },
    });
    assert.equal(deleteGroupResponse.statusCode, 204, deleteGroupResponse.body);
    const retainedRoutines = await app.inject({
      method: "GET",
      url: `/v1/workspaces/${groupWorkspaceId}/routines?status=active`,
    });
    assert.deepEqual(
      retainedRoutines
        .json<{ items: { id: string }[] }>()
        .items.map((item) => item.id)
        .sort(),
      [spanishRoutineId, japaneseRoutineId].sort(),
    );
    const [groupPersistence] = await connection.sql<
      { group_count: number; membership_count: number; mutation_count: number }[]
    >`
      select
        (select count(*)::int from routine_groups where workspace_id = ${groupWorkspaceId}) as group_count,
        (select count(*)::int from routine_group_memberships where workspace_id = ${groupWorkspaceId}) as membership_count,
        (select count(*)::int from plan_mutations where workspace_id = ${groupWorkspaceId} and kind = 'add_routine') as mutation_count
    `;
    assert.deepEqual(groupPersistence, {
      group_count: 0,
      membership_count: 0,
      mutation_count: 2,
    });
    process.stdout.write("routine-groups-and-add-to-today-postgres-api verification passed\n");
  }

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
