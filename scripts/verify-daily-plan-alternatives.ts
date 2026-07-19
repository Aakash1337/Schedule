import assert from "node:assert/strict";

import { buildApp } from "../apps/api/src/app.js";
import { createProductServices } from "../apps/api/src/product-services.js";
import { createDatabase, PostgresUnitOfWork } from "../packages/database/src/index.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://schedule:schedule@127.0.0.1:5432/schedule";
const connection = createDatabase(databaseUrl, 3);
let app: Awaited<ReturnType<typeof buildApp>> | null = null;
let workspaceId: string | null = null;

const planningRequest = {
  timeZone: "UTC",
  availableWindows: [
    {
      startsAt: "2026-07-15T08:00:00.000Z",
      endsAt: "2026-07-15T09:00:00.000Z",
    },
  ],
  targetMinutes: 60,
  maximumMinutes: 60,
  targetTaskCount: 2,
  maximumTaskCount: 2,
  fitPreference: "balanced",
  energy: null,
  availableContexts: [],
};

try {
  app = await buildApp({
    readinessCheck: async () => {
      await connection.sql`select 1`;
    },
    productServices: createProductServices(new PostgresUnitOfWork(connection), {
      now: () => new Date("2026-07-15T07:30:00.000Z"),
    }),
    productApiAccess: { mode: "local_unauthenticated" },
  });
  const workspaceResponse = await app.inject({
    method: "POST",
    url: "/v1/workspaces",
    payload: { name: "Daily-plan alternatives verification" },
  });
  assert.equal(workspaceResponse.statusCode, 201, workspaceResponse.body);
  workspaceId = workspaceResponse.json<{ id: string }>().id;

  const routines: Array<{ id: string; version: number }> = [];
  for (const [index, title] of [
    "Protect the anchor",
    "Review project notes",
    "Plan tomorrow",
    "Practice a language",
    "Clear the inbox",
  ].entries()) {
    const routineResponse: {
      readonly statusCode: number;
      readonly body: string;
      json(): unknown;
    } = await app.inject({
      method: "POST",
      url: `/v1/workspaces/${workspaceId}/routines`,
      payload: {
        title,
        tags: {
          priority: ["critical", "high", "high", "medium", "low"][index],
        },
        duration: { expectedMinutes: 30 },
        cadence: { period: "week", targetCompletions: 3 },
      },
    });
    assert.equal(routineResponse.statusCode, 201, routineResponse.body);
    routines.push(routineResponse.json() as { id: string; version: number });
  }

  const generatedResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${workspaceId}/plans`,
    payload: { ...planningRequest, date: "2026-07-15", seed: "alternatives-source" },
  });
  assert.equal(generatedResponse.statusCode, 200, generatedResponse.body);
  const generated = generatedResponse.json<{
    id: string;
    items: Array<{ id: string; routineId: string | null; locked: boolean }>;
  }>();
  assert.equal(generated.items.length, 2);

  const lockedResponse = await app.inject({
    method: "PATCH",
    url: `/v1/workspaces/${workspaceId}/plans/2026-07-15/items/${generated.items[0]!.id}/lock`,
    headers: { "idempotency-key": "alternatives-lock-anchor" },
    payload: { expectedPlanId: generated.id, expectedHeadVersion: 1, locked: true },
  });
  assert.equal(lockedResponse.statusCode, 200, lockedResponse.body);
  assert.equal(lockedResponse.json<{ headVersion: number }>().headVersion, 2);

  const previewRequest = { ...planningRequest, seed: "alternatives-preview" };
  const previewResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${workspaceId}/plans/2026-07-15/alternative-previews`,
    payload: {
      expectedPlanId: generated.id,
      expectedHeadVersion: 2,
      request: previewRequest,
    },
  });
  assert.equal(previewResponse.statusCode, 200, previewResponse.body);
  assert.equal(previewResponse.headers["cache-control"], "no-store");
  const preview = previewResponse.json<{
    sourcePlanId: string;
    sourceHeadVersion: number;
    alternatives: Array<{
      candidateKey: string;
      items: Array<{ routineId: string | null; title: string }>;
    }>;
  }>();
  assert.equal(preview.sourcePlanId, generated.id);
  assert.equal(preview.sourceHeadVersion, 2);
  assert.ok(preview.alternatives.length >= 1 && preview.alternatives.length <= 3);
  assert.equal(
    new Set(preview.alternatives.map((alternative) => alternative.candidateKey)).size,
    preview.alternatives.length,
  );
  const chosen = preview.alternatives[0]!;

  const selectionRequest = {
    method: "POST" as const,
    url: `/v1/workspaces/${workspaceId}/plans/2026-07-15/alternative-selections`,
    headers: { "idempotency-key": "alternatives-select" },
    payload: {
      expectedPlanId: generated.id,
      expectedHeadVersion: 2,
      candidateKey: chosen.candidateKey,
      request: previewRequest,
    },
  };
  const selectedResponse = await app.inject(selectionRequest);
  assert.equal(selectedResponse.statusCode, 200, selectedResponse.body);
  const selected = selectedResponse.json<{
    id: string;
    headVersion: number;
    requestRevision: number;
    items: Array<{ routineId: string | null; locked: boolean }>;
  }>();
  assert.equal(selected.headVersion, 3);
  assert.equal(selected.requestRevision, 2);
  assert.equal(
    selected.items.find((item) => item.locked)?.routineId,
    generated.items[0]!.routineId,
  );
  assert.deepEqual(
    selected.items.map((item) => item.routineId).sort(),
    chosen.items.map((item) => item.routineId).sort(),
  );

  const replayResponse = await app.inject(selectionRequest);
  assert.equal(replayResponse.statusCode, 200, replayResponse.body);
  assert.deepEqual(replayResponse.json(), selectedResponse.json());
  const mutationRows = await connection.sql<
    {
      kind: string;
      resultPlanId: string;
      resultHeadVersion: number;
    }[]
  >`
    select kind::text as kind, result_plan_id as "resultPlanId",
      result_head_version as "resultHeadVersion"
    from plan_mutations
    where workspace_id = ${workspaceId}
      and idempotency_key = 'alternatives-select'
  `;
  assert.deepEqual(Array.from(mutationRows), [
    { kind: "alternative_select", resultPlanId: selected.id, resultHeadVersion: 3 },
  ]);

  const currentPreviewResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${workspaceId}/plans/2026-07-15/alternative-previews`,
    payload: {
      expectedPlanId: selected.id,
      expectedHeadVersion: 3,
      request: { ...planningRequest, seed: "alternatives-stale" },
    },
  });
  assert.equal(currentPreviewResponse.statusCode, 200, currentPreviewResponse.body);
  const staleCandidate = currentPreviewResponse.json<{
    alternatives: Array<{
      candidateKey: string;
      items: Array<{ routineId: string | null }>;
    }>;
  }>().alternatives[0];
  assert.ok(staleCandidate);

  const staleRoutineId = staleCandidate.items.find(
    (item) => item.routineId !== null && item.routineId !== generated.items[0]!.routineId,
  )?.routineId;
  assert.ok(staleRoutineId);
  const editedRoutine = routines.find((routine) => routine.id === staleRoutineId);
  assert.ok(editedRoutine);
  const editResponse = await app.inject({
    method: "PATCH",
    url: `/v1/workspaces/${workspaceId}/routines/${editedRoutine.id}`,
    payload: { expectedVersion: editedRoutine.version, status: "paused" },
  });
  assert.equal(editResponse.statusCode, 200, editResponse.body);
  const staleSelectionResponse = await app.inject({
    method: "POST",
    url: `/v1/workspaces/${workspaceId}/plans/2026-07-15/alternative-selections`,
    headers: { "idempotency-key": "alternatives-stale-selection" },
    payload: {
      expectedPlanId: selected.id,
      expectedHeadVersion: 3,
      candidateKey: staleCandidate.candidateKey,
      request: { ...planningRequest, seed: "alternatives-stale" },
    },
  });
  assert.equal(staleSelectionResponse.statusCode, 409, staleSelectionResponse.body);
  assert.equal(
    staleSelectionResponse.json<{ error: { code: string } }>().error.code,
    "planning.alternative_stale",
  );
  const revisionCount = await connection.sql<{ count: number }[]>`
    select count(*)::int as count from daily_plans
    where workspace_id = ${workspaceId} and local_date = '2026-07-15'
  `;
  assert.equal(revisionCount[0]?.count, 2);

  process.stdout.write(
    "daily-plan alternatives verification passed preview purity, locked selection, exact replay, and stale-key rejection\n",
  );
} finally {
  try {
    await app?.close();
  } finally {
    try {
      if (workspaceId !== null) {
        await connection.sql.begin(async (sql) => {
          await sql`select set_config('schedule.allow_activity_event_mutation', 'on', true)`;
          await sql`select set_config('schedule.allow_audit_event_mutation', 'on', true)`;
          await sql`select set_config('schedule.allow_plan_interaction_event_mutation', 'on', true)`;
          await sql`select set_config('schedule.allow_plan_mutation_change', 'on', true)`;
          await sql`delete from workspaces where id = ${workspaceId}`;
        });
      }
    } finally {
      await connection.close();
    }
  }
}
