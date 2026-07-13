import assert from "node:assert/strict";

import {
  CreateRoutine,
  CreateWorkItem,
  CreateWorkspace,
  GenerateDailyPlan,
  GetDailyPlan,
  ListRoutines,
  RecordActivityEvent,
} from "../packages/application/src/index.js";
import { createDatabase, PostgresUnitOfWork } from "../packages/database/src/index.js";
import {
  createCadencePolicy,
  createDailyPlanningRequest,
  createDurationRange,
  createStructuredTags,
  type WorkspaceId,
} from "../packages/domain/src/index.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://schedule:schedule@127.0.0.1:5432/schedule";
const connection = createDatabase(databaseUrl, 2);
const clock = { now: () => new Date("2026-07-15T07:00:00.000Z") };
let workspace: WorkspaceId | null = null;

async function removeVerificationWorkspace(): Promise<void> {
  if (workspace === null) return;
  await connection.sql.begin(async (sql) => {
    await sql`select set_config('schedule.allow_activity_event_mutation', 'on', true)`;
    await sql`select set_config('schedule.allow_audit_event_mutation', 'on', true)`;
    await sql`delete from workspaces where id = ${workspace}`;
  });
}

try {
  const unitOfWork = new PostgresUnitOfWork(connection);
  workspace = (
    await new CreateWorkspace(unitOfWork, clock).execute({
      name: "Planner database verification",
    })
  ).id;
  const routine = await new CreateRoutine(unitOfWork, clock).execute({
    workspaceId: workspace,
    title: "Database-backed routine",
    tags: createStructuredTags({
      priority: "high",
      energy: "normal",
      contexts: ["computer"],
      categories: ["verification"],
    }),
    duration: createDurationRange({ expectedMinutes: 30 }),
    cadence: createCadencePolicy({
      period: "week",
      targetCompletions: 3,
      maximumCompletions: 4,
    }),
  });
  const request = createDailyPlanningRequest({
    workspaceId: workspace,
    date: "2026-07-15",
    timeZone: "UTC",
    availableWindows: [
      {
        startsAt: new Date("2026-07-15T08:00:00.000Z"),
        endsAt: new Date("2026-07-15T09:00:00.000Z"),
      },
    ],
    targetMinutes: 30,
    targetTaskCount: 1,
    availableContexts: ["computer"],
    seed: "database-verification",
    requestRevision: 1,
  });
  const generator = new GenerateDailyPlan(unitOfWork, clock);
  const firstPlan = await generator.execute({ request });
  const retriedPlan = await generator.execute({ request });
  const listedRoutines = await new ListRoutines(unitOfWork).execute({ workspaceId: workspace });
  const retrievedPlan = await new GetDailyPlan(unitOfWork).execute({
    workspaceId: workspace,
    date: request.date,
    requestRevision: request.requestRevision,
  });

  assert.equal(firstPlan.id, retriedPlan.id, "plan revision retry must return the stored plan");
  assert.equal(retrievedPlan?.id, firstPlan.id, "exact plan revision must be retrievable");
  assert.deepEqual(
    listedRoutines.map((item) => item.id),
    [routine.id],
  );
  assert.equal(firstPlan.items[0]?.routineId, routine.id);

  const recorder = new RecordActivityEvent(unitOfWork, clock);
  const completion = await recorder.execute({
    workspaceId: workspace,
    routineId: routine.id,
    type: "completed",
    occurredAt: new Date("2026-07-15T10:00:00.000Z"),
    timeZone: "UTC",
    durationMinutes: 32,
    idempotencyKey: "database-verification-completion",
  });
  const retriedCompletion = await recorder.execute({
    workspaceId: workspace,
    routineId: routine.id,
    type: "completed",
    occurredAt: new Date("2026-07-15T10:00:00.000Z"),
    timeZone: "UTC",
    durationMinutes: 32,
    idempotencyKey: "database-verification-completion",
  });
  assert.equal(
    completion.id,
    retriedCompletion.id,
    "activity retry must return the original event",
  );

  // EVIDENCE: unified-planner-work-item-opt-in-db
  // A duration opts normal work into the same bounded planner pool as routines.
  const plannableWorkItem = await new CreateWorkItem(unitOfWork, clock).execute({
    workspaceId: workspace,
    title: "Database-backed plannable work",
    status: "planned",
    priority: "urgent",
    planningDurationMinutes: 15,
  });
  const terminalWorkItem = await new CreateWorkItem(unitOfWork, clock).execute({
    workspaceId: workspace,
    title: "Database-backed completed work",
    status: "done",
    priority: "urgent",
    planningDurationMinutes: 15,
  });
  const unifiedRequest = createDailyPlanningRequest({
    workspaceId: workspace,
    date: "2026-07-16",
    timeZone: "UTC",
    availableWindows: [
      {
        startsAt: new Date("2026-07-16T08:00:00.000Z"),
        endsAt: new Date("2026-07-16T09:00:00.000Z"),
      },
    ],
    targetMinutes: 45,
    targetTaskCount: 2,
    availableContexts: ["computer"],
    seed: "unified-planner-database-verification",
    requestRevision: 1,
  });
  const unifiedPlan = await generator.execute({ request: unifiedRequest });
  assert.equal(unifiedPlan.items.length, 2, "combined task-count budget must be honored");
  assert.equal(
    unifiedPlan.items.reduce((total, item) => total + item.scheduledMinutes, 0),
    45,
    "combined time budget must be honored",
  );
  const plannedWork = unifiedPlan.items.find((item) => item.workItemId === plannableWorkItem.id);
  assert.notEqual(plannedWork, undefined, "an opted-in work item must be selectable for Today");
  assert.equal(plannedWork!.sourceType, "work_item");
  assert.equal(plannedWork!.routineId, null);
  assert.equal(plannedWork!.workItemId, plannableWorkItem.id);
  assert.equal(
    unifiedPlan.items.some((item) => item.workItemId === terminalWorkItem.id),
    false,
    "terminal work must never become a daily-plan candidate",
  );
  const [persistedUnifiedPlanItem] = await connection.sql<
    { source_type: string; routine_id: string | null; work_item_id: string | null }[]
  >`
    select source_type, routine_id::text, work_item_id::text
    from daily_plan_items
    where workspace_id = ${workspace}
      and plan_id = ${unifiedPlan.id}
      and work_item_id = ${plannableWorkItem.id}
  `;
  assert.deepEqual(persistedUnifiedPlanItem, {
    source_type: "work_item",
    routine_id: null,
    work_item_id: plannableWorkItem.id,
  });

  const [counts] = await connection.sql<
    { routine_count: number; plan_count: number; item_count: number; event_count: number }[]
  >`
    select
      (select count(*)::int from routines where workspace_id = ${workspace}) as routine_count,
      (select count(*)::int from daily_plans where workspace_id = ${workspace}) as plan_count,
      (select count(*)::int from daily_plan_items where workspace_id = ${workspace}) as item_count,
      (select count(*)::int from activity_events where workspace_id = ${workspace}) as event_count
  `;
  assert.deepEqual(counts, {
    routine_count: 1,
    plan_count: 2,
    item_count: 3,
    event_count: 1,
  });

  process.stdout.write("planner database verification passed\n");
} finally {
  await removeVerificationWorkspace();
  await connection.close();
}
