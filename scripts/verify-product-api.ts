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
let releaseConcurrencyLock: (() => void) | null = null;
let heldLock: Promise<unknown> | null = null;

async function removeWorkspace(): Promise<void> {
  if (createdWorkspaceId === null) return;
  await connection.sql.begin(async (sql) => {
    await sql`select set_config('schedule.allow_activity_event_mutation', 'on', true)`;
    await sql`select set_config('schedule.allow_plan_interaction_event_mutation', 'on', true)`;
    await sql`select set_config('schedule.allow_plan_mutation_change', 'on', true)`;
    await sql`delete from workspaces where id = ${createdWorkspaceId}`;
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
    headVersion: number;
    requestRevision: number;
    items: { routineId: string }[];
  }>();
  assert.equal(replacement.headVersion, 5);
  assert.equal(replacement.requestRevision, 3);
  assert.equal(replacement.items[0]?.routineId, alternativeRoutineId);

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
  releaseConcurrencyLock?.();
  releaseConcurrencyLock = null;
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
  releaseConcurrencyLock?.();
  if (heldLock !== null) await heldLock.catch(() => undefined);
  await Promise.all([app.close(), lockConnection.close(), observerConnection.close()]);
  await removeWorkspace();
  await connection.close();
}
