import assert from "node:assert/strict";

import {
  CreateRoutine,
  CreateWorkItem,
  CreateWorkspace,
  DismissRoutineDurationInsight,
  GenerateDailyPlan,
  GetDailyPlan,
  GetRoutineDurationInsight,
  ListRoutines,
  RecordActivityEvent,
  ResetRoutineDurationInsightDismissal,
  UpdateRoutine,
  UpdateWorkItem,
} from "../packages/application/src/index.js";
import { createDatabase, PostgresUnitOfWork } from "../packages/database/src/index.js";
import {
  createCadencePolicy,
  createDailyPlanningRequest,
  createDurationRange,
  localDate,
  createStructuredTags,
  type WorkspaceId,
} from "../packages/domain/src/index.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://schedule:schedule@127.0.0.1:5432/schedule";
const connection = createDatabase(databaseUrl, 5);
const clock = { now: () => new Date("2026-07-15T07:00:00.000Z") };
let workspace: WorkspaceId | null = null;

async function waitingAdvisoryLockCount(): Promise<number> {
  const [row] = await connection.sql<{ waiting: number }[]>`
    select count(*)::int as waiting
    from pg_locks
    where locktype = 'advisory'
      and not granted
  `;
  return row?.waiting ?? 0;
}

async function waitForAdvisoryLockCount(minimum: number): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if ((await waitingAdvisoryLockCount()) >= minimum) return;
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });
  }
  throw new Error(`Timed out waiting for ${minimum} blocked advisory locks.`);
}

function assertDatabaseErrorCode(expected: string): (error: unknown) => boolean {
  return (error) => {
    assert.equal(
      typeof error === "object" && error !== null && "code" in error
        ? (error as { code: unknown }).code
        : undefined,
      expected,
    );
    return true;
  };
}

async function removeVerificationWorkspace(): Promise<void> {
  if (workspace === null) return;
  await connection.sql.begin(async (sql) => {
    await sql`select set_config('schedule.allow_activity_event_mutation', 'on', true)`;
    await sql`select set_config('schedule.allow_audit_event_mutation', 'on', true)`;
    await sql`select set_config('schedule.allow_routine_duration_insight_feedback_event_change', 'on', true)`;
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
  // EVIDENCE: work-item-deadline-postgres-round-trip
  // Dates are stored as calendar values, retained by the repository, and may be explicitly cleared.
  const deadlineRoundTripWorkItem = await new CreateWorkItem(unitOfWork, clock).execute({
    workspaceId: workspace,
    title: "Database-backed deadline round trip",
    status: "backlog",
    priority: "low",
    dueOn: localDate("2026-07-16"),
  });
  const [persistedDeadline] = await connection.sql<{ due_on: string | null }[]>`
    select due_on::text as due_on
    from work_items
    where workspace_id = ${workspace}
      and id = ${deadlineRoundTripWorkItem.id}
  `;
  assert.equal(persistedDeadline?.due_on, "2026-07-16");
  const updatedDeadlineWorkItem = await new UpdateWorkItem(unitOfWork, clock).execute({
    workspaceId: workspace,
    workItemId: deadlineRoundTripWorkItem.id,
    expectedVersion: deadlineRoundTripWorkItem.version,
    dueOn: localDate("2026-07-17"),
  });
  assert.equal(updatedDeadlineWorkItem.dueOn, "2026-07-17");
  const clearedDeadlineWorkItem = await new UpdateWorkItem(unitOfWork, clock).execute({
    workspaceId: workspace,
    workItemId: deadlineRoundTripWorkItem.id,
    expectedVersion: updatedDeadlineWorkItem.version,
    dueOn: null,
  });
  assert.equal(clearedDeadlineWorkItem.dueOn, null);
  const [persistedClearedDeadline] = await connection.sql<{ due_on: string | null }[]>`
    select due_on::text as due_on
    from work_items
    where workspace_id = ${workspace}
      and id = ${deadlineRoundTripWorkItem.id}
  `;
  assert.equal(persistedClearedDeadline?.due_on, null);

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

  // EVIDENCE: work-item-deadline-planner-db
  // Equal-priority work is ordered by due-date pressure, which is persisted with the plan explanation.
  const dueTodayWorkItem = await new CreateWorkItem(unitOfWork, clock).execute({
    workspaceId: workspace,
    title: "Database-backed due-today work",
    status: "planned",
    priority: "medium",
    planningDurationMinutes: 15,
    dueOn: localDate("2026-07-17"),
  });
  const noDeadlineWorkItem = await new CreateWorkItem(unitOfWork, clock).execute({
    workspaceId: workspace,
    title: "Database-backed no-deadline work",
    status: "planned",
    priority: "medium",
    planningDurationMinutes: 15,
  });
  const deadlinePlanningRequest = createDailyPlanningRequest({
    workspaceId: workspace,
    date: "2026-07-17",
    timeZone: "UTC",
    availableWindows: [
      {
        startsAt: new Date("2026-07-17T08:00:00.000Z"),
        endsAt: new Date("2026-07-17T10:00:00.000Z"),
      },
    ],
    targetMinutes: 75,
    targetTaskCount: 4,
    availableContexts: ["computer"],
    seed: "deadline-planner-database-verification",
    requestRevision: 1,
  });
  const deadlinePlan = await generator.execute({ request: deadlinePlanningRequest });
  const dueTodayPlanItem = deadlinePlan.items.find(
    (item) => item.workItemId === dueTodayWorkItem.id,
  );
  const noDeadlinePlanItem = deadlinePlan.items.find(
    (item) => item.workItemId === noDeadlineWorkItem.id,
  );
  assert.notEqual(dueTodayPlanItem, undefined, "due-today work must be planned");
  assert.notEqual(noDeadlinePlanItem, undefined, "no-deadline work must be planned");
  assert.equal(dueTodayPlanItem!.scoreComponents.deadlinePressure, 3_000);
  assert.equal(dueTodayPlanItem!.reasons.includes("Due today (+3000 deadline pressure)."), true);
  assert.ok(
    dueTodayPlanItem!.score > noDeadlinePlanItem!.score,
    "due-today work must have a higher planner rank than otherwise equal-priority work without a deadline",
  );

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
    plan_count: 3,
    item_count: 7,
    event_count: 1,
  });

  // EVIDENCE: routine-duration-insight-feedback-postgres
  // Exact-key feedback persists across reads and is replay-safe without mutating the routine or
  // Today. A changed evidence fingerprint becomes available even while the old key stays dismissed.
  const durationFeedbackRoutine = await new CreateRoutine(unitOfWork, clock).execute({
    workspaceId: workspace,
    title: "Database-backed duration feedback",
    tags: createStructuredTags({ priority: "medium" }),
    duration: createDurationRange({
      minimumMinutes: 20,
      expectedMinutes: 30,
      maximumMinutes: 90,
    }),
    cadence: createCadencePolicy({ period: "week", targetCompletions: 1 }),
  });
  for (const [index, durationMinutes] of [40, 45, 50, 55].entries()) {
    await recorder.execute({
      workspaceId: workspace,
      routineId: durationFeedbackRoutine.id,
      type: "completed",
      occurredAt: new Date(`2026-07-${String(11 + index).padStart(2, "0")}T06:00:00.000Z`),
      timeZone: "UTC",
      durationMinutes,
      idempotencyKey: `database-duration-feedback-sample-${index}`,
    });
  }
  const getDurationInsight = new GetRoutineDurationInsight(unitOfWork, clock);
  const dismissDurationInsight = new DismissRoutineDurationInsight(unitOfWork, clock);
  const resetDurationInsight = new ResetRoutineDurationInsightDismissal(unitOfWork, clock);
  const initialDurationInsight = await getDurationInsight.execute({
    workspaceId: workspace,
    routineId: durationFeedbackRoutine.id,
  });
  assert.equal(initialDurationInsight.status, "suggested");
  assert.equal(initialDurationInsight.observedMedianMinutes, 48);
  assert.equal(initialDurationInsight.suggestedExpectedMinutes, 48);
  assert.match(initialDurationInsight.insightKey ?? "", /^[0-9a-f]{64}$/);
  assert.equal(initialDurationInsight.disposition, "available");
  const initialDurationInsightKey = initialDurationInsight.insightKey!;
  const [routineBeforeDurationFeedback] = await connection.sql<
    {
      version: number;
      minimum_duration_minutes: number;
      expected_duration_minutes: number;
      maximum_duration_minutes: number;
      updated_at: string;
    }[]
  >`
    select
      version,
      minimum_duration_minutes,
      expected_duration_minutes,
      maximum_duration_minutes,
      updated_at::text
    from routines
    where workspace_id = ${workspace}
      and id = ${durationFeedbackRoutine.id}
  `;
  const planHeadsBeforeDurationFeedback = await connection.sql<
    { local_date: string; current_plan_id: string; version: number }[]
  >`
    select local_date::text, current_plan_id::text, version
    from daily_plan_heads
    where workspace_id = ${workspace}
    order by local_date, id
  `;
  const dismissalCommand = {
    workspaceId: workspace,
    routineId: durationFeedbackRoutine.id,
    expectedVersion: durationFeedbackRoutine.version,
    insightKey: initialDurationInsightKey,
    idempotencyKey: "database-duration-feedback-dismiss",
  };
  const durationDismissal = await dismissDurationInsight.execute(dismissalCommand);
  const replayedDurationDismissal = await dismissDurationInsight.execute(dismissalCommand);
  assert.deepEqual(replayedDurationDismissal, durationDismissal);
  await assert.rejects(
    dismissDurationInsight.execute({ ...dismissalCommand, expectedVersion: 2 }),
    (error: unknown) => {
      assert.equal(
        typeof error === "object" && error !== null && "code" in error
          ? (error as { code: unknown }).code
          : undefined,
        "routine_duration_insight.idempotency_conflict",
      );
      return true;
    },
  );
  for (let read = 0; read < 2; read += 1) {
    const dismissedInsight = await new GetRoutineDurationInsight(unitOfWork, clock).execute({
      workspaceId: workspace,
      routineId: durationFeedbackRoutine.id,
    });
    assert.equal(dismissedInsight.insightKey, initialDurationInsightKey);
    assert.equal(dismissedInsight.disposition, "dismissed");
    assert.deepEqual(dismissedInsight.dismissedAt, durationDismissal.recordedAt);
  }

  const resetCommand = {
    ...dismissalCommand,
    idempotencyKey: "database-duration-feedback-reset",
  };
  const durationReset = await resetDurationInsight.execute(resetCommand);
  const replayedDurationReset = await resetDurationInsight.execute(resetCommand);
  assert.deepEqual(replayedDurationReset, durationReset);
  const resetInsight = await getDurationInsight.execute({
    workspaceId: workspace,
    routineId: durationFeedbackRoutine.id,
  });
  assert.equal(resetInsight.disposition, "available");
  assert.equal(resetInsight.dismissedAt, null);

  await dismissDurationInsight.execute({
    ...dismissalCommand,
    idempotencyKey: "database-duration-feedback-dismiss-before-new-evidence",
  });
  await recorder.execute({
    workspaceId: workspace,
    routineId: durationFeedbackRoutine.id,
    type: "completed",
    occurredAt: new Date("2026-07-15T06:30:00.000Z"),
    timeZone: "UTC",
    durationMinutes: 60,
    idempotencyKey: "database-duration-feedback-meaningful-sample",
  });
  const resurfacedInsight = await getDurationInsight.execute({
    workspaceId: workspace,
    routineId: durationFeedbackRoutine.id,
  });
  assert.equal(resurfacedInsight.status, "suggested");
  assert.equal(resurfacedInsight.observedMedianMinutes, 50);
  assert.equal(resurfacedInsight.suggestedExpectedMinutes, 50);
  assert.notEqual(resurfacedInsight.insightKey, initialDurationInsightKey);
  assert.equal(resurfacedInsight.disposition, "available");
  assert.equal(resurfacedInsight.dismissedAt, null);

  const feedbackRows = await connection.sql<
    {
      insight_key: string;
      kind: string;
      routine_version: number;
      observed_median_minutes: number;
      suggested_expected_minutes: number | null;
      idempotency_key: string;
    }[]
  >`
    select
      insight_key,
      kind::text,
      routine_version,
      observed_median_minutes,
      suggested_expected_minutes,
      idempotency_key
    from routine_duration_insight_feedback_events
    where workspace_id = ${workspace}
      and routine_id = ${durationFeedbackRoutine.id}
    order by ingested_sequence, id
  `;
  assert.deepEqual(
    feedbackRows.map((row) => ({
      ...row,
      insight_key: row.insight_key === initialDurationInsightKey ? "initial-key" : row.insight_key,
    })),
    [
      {
        insight_key: "initial-key",
        kind: "dismissed",
        routine_version: 1,
        observed_median_minutes: 48,
        suggested_expected_minutes: 48,
        idempotency_key: "database-duration-feedback-dismiss",
      },
      {
        insight_key: "initial-key",
        kind: "reset",
        routine_version: 1,
        observed_median_minutes: 48,
        suggested_expected_minutes: 48,
        idempotency_key: "database-duration-feedback-reset",
      },
      {
        insight_key: "initial-key",
        kind: "dismissed",
        routine_version: 1,
        observed_median_minutes: 48,
        suggested_expected_minutes: 48,
        idempotency_key: "database-duration-feedback-dismiss-before-new-evidence",
      },
    ],
  );
  await assert.rejects(
    connection.sql`
      update routine_duration_insight_feedback_events
      set kind = kind
      where workspace_id = ${workspace}
        and routine_id = ${durationFeedbackRoutine.id}
    `,
    assertDatabaseErrorCode("55000"),
  );
  await assert.rejects(
    connection.sql`
      delete from routine_duration_insight_feedback_events
      where workspace_id = ${workspace}
        and routine_id = ${durationFeedbackRoutine.id}
    `,
    assertDatabaseErrorCode("55000"),
  );
  const [feedbackCountAfterRejectedMutation] = await connection.sql<{ count: number }[]>`
    select count(*)::int as count
    from routine_duration_insight_feedback_events
    where workspace_id = ${workspace}
      and routine_id = ${durationFeedbackRoutine.id}
  `;
  assert.equal(feedbackCountAfterRejectedMutation?.count, 3);
  const [routineAfterDurationFeedback] = await connection.sql<
    {
      version: number;
      minimum_duration_minutes: number;
      expected_duration_minutes: number;
      maximum_duration_minutes: number;
      updated_at: string;
    }[]
  >`
    select
      version,
      minimum_duration_minutes,
      expected_duration_minutes,
      maximum_duration_minutes,
      updated_at::text
    from routines
    where workspace_id = ${workspace}
      and id = ${durationFeedbackRoutine.id}
  `;
  assert.deepEqual(routineAfterDurationFeedback, routineBeforeDurationFeedback);
  const planHeadsAfterDurationFeedback = await connection.sql<
    { local_date: string; current_plan_id: string; version: number }[]
  >`
    select local_date::text, current_plan_id::text, version
    from daily_plan_heads
    where workspace_id = ${workspace}
    order by local_date, id
  `;
  assert.deepEqual(planHeadsAfterDurationFeedback, planHeadsBeforeDurationFeedback);

  // A normal routine edit and duration feedback share the same advisory lock. Queue the update
  // first behind an externally held lock, then queue feedback with the now-stale version. Once
  // released, the update must commit first and the feedback command must reject without appending.
  const waitingBeforeConcurrencyCheck = await waitingAdvisoryLockCount();
  let markBlockerReady!: () => void;
  let releaseBlocker!: () => void;
  const blockerReady = new Promise<void>((resolve) => {
    markBlockerReady = resolve;
  });
  const blockerRelease = new Promise<void>((resolve) => {
    releaseBlocker = resolve;
  });
  const durationRoutineLockKey = `${workspace}:routine:${durationFeedbackRoutine.id}`;
  const blocker = connection.sql.begin(async (sql) => {
    await sql`select pg_advisory_xact_lock(hashtextextended(${durationRoutineLockKey}, 0))`;
    markBlockerReady();
    await blockerRelease;
  });
  await blockerReady;

  let concurrentUpdate: ReturnType<UpdateRoutine["execute"]> | null = null;
  let staleConcurrentDismissal: ReturnType<DismissRoutineDurationInsight["execute"]> | null = null;
  let concurrencyQueueReady = false;
  try {
    concurrentUpdate = new UpdateRoutine(unitOfWork, clock).execute({
      workspaceId: workspace,
      routineId: durationFeedbackRoutine.id,
      expectedVersion: durationFeedbackRoutine.version,
      title: "Database-backed duration feedback, revised",
    });
    await waitForAdvisoryLockCount(waitingBeforeConcurrencyCheck + 1);
    staleConcurrentDismissal = dismissDurationInsight.execute({
      workspaceId: workspace,
      routineId: durationFeedbackRoutine.id,
      expectedVersion: durationFeedbackRoutine.version,
      insightKey: resurfacedInsight.insightKey!,
      idempotencyKey: "database-duration-feedback-stale-concurrent-dismiss",
    });
    void staleConcurrentDismissal.catch(() => undefined);
    await waitForAdvisoryLockCount(waitingBeforeConcurrencyCheck + 2);
    concurrencyQueueReady = true;
  } finally {
    releaseBlocker();
    await blocker;
    if (!concurrencyQueueReady) {
      const pendingOperations: Promise<unknown>[] = [];
      if (concurrentUpdate !== null) pendingOperations.push(concurrentUpdate);
      if (staleConcurrentDismissal !== null) pendingOperations.push(staleConcurrentDismissal);
      await Promise.allSettled(pendingOperations);
    }
  }

  const concurrentlyUpdatedRoutine = await concurrentUpdate!;
  assert.equal(concurrentlyUpdatedRoutine.version, durationFeedbackRoutine.version + 1);
  await assert.rejects(staleConcurrentDismissal!, (error: unknown) => {
    assert.equal(
      typeof error === "object" && error !== null && "code" in error
        ? (error as { code: unknown }).code
        : undefined,
      "routine.version_conflict",
    );
    return true;
  });
  const [feedbackCountAfterConcurrentConflict] = await connection.sql<{ count: number }[]>`
    select count(*)::int as count
    from routine_duration_insight_feedback_events
    where workspace_id = ${workspace}
      and routine_id = ${durationFeedbackRoutine.id}
  `;
  assert.equal(feedbackCountAfterConcurrentConflict?.count, 3);

  process.stdout.write("planner database verification passed\n");
} finally {
  await removeVerificationWorkspace();
  await connection.close();
}
