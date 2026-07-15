import assert from "node:assert/strict";

import {
  CreateRoutine,
  CreateWorkItem,
  CreateWorkspace,
  DismissDailyPlanFitInsight,
  DismissRoutineDurationInsight,
  GenerateDailyPlan,
  GetDailyPlanFitInsight,
  GetDailyPlan,
  GetRoutineSelectionPreferenceState,
  GetRoutineDurationInsight,
  ListDailyPlanFitUsageOutcomes,
  ListRoutines,
  MutateDailyPlan,
  RecordActivityEvent,
  RecordPlanItemActivity,
  RecordRoutineSelectionPreferenceFeedback,
  ResetDailyPlanFitInsightDismissal,
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
  workspaceId,
  type DailyPlanId,
  type PlanItemId,
  type WorkspaceId,
} from "../packages/domain/src/index.js";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://schedule:schedule@127.0.0.1:5432/schedule";
const connection = createDatabase(databaseUrl, 5);
const clock = { now: () => new Date("2026-07-15T07:00:00.000Z") };
let workspace: WorkspaceId | null = null;
let fitWorkspace: WorkspaceId | null = null;

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
  const workspaces = [workspace, fitWorkspace].filter(
    (candidate): candidate is WorkspaceId => candidate !== null,
  );
  if (workspaces.length === 0) return;
  await connection.sql.begin(async (sql) => {
    await sql`select set_config('schedule.allow_activity_event_mutation', 'on', true)`;
    await sql`select set_config('schedule.allow_audit_event_mutation', 'on', true)`;
    await sql`select set_config('schedule.allow_plan_mutation_change', 'on', true)`;
    await sql`select set_config('schedule.allow_plan_interaction_event_mutation', 'on', true)`;
    await sql`select set_config('schedule.allow_routine_duration_insight_feedback_event_change', 'on', true)`;
    await sql`select set_config('schedule.allow_daily_plan_fit_insight_feedback_event_change', 'on', true)`;
    await sql`select set_config('schedule.allow_routine_selection_preference_feedback_event_change', 'on', true)`;
    for (const targetWorkspace of workspaces) {
      await sql`delete from workspaces where id = ${targetWorkspace}`;
    }
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

  const preferenceReader = new GetRoutineSelectionPreferenceState(unitOfWork, clock);
  const preferenceRecorder = new RecordRoutineSelectionPreferenceFeedback(unitOfWork, clock);
  assert.deepEqual(
    await preferenceReader.execute({
      workspaceId: workspace,
      routineId: routine.id,
      timeZone: "UTC",
    }),
    {
      routineId: routine.id,
      feedbackVersion: 0,
      activeEventCount: 0,
      score: 0,
      reason: null,
      updatedAt: null,
    },
  );
  const preferenceCommand = {
    workspaceId: workspace,
    routineId: routine.id,
    expectedFeedbackVersion: 0,
    kind: "more_often" as const,
    timeZone: "UTC",
    sourcePlanId: firstPlan.id,
    sourcePlanItemId: firstPlan.items[0]!.id,
    idempotencyKey: "database-verification-selection-preference",
  };
  const acceptedPreferenceState = await preferenceRecorder.execute(preferenceCommand);
  assert.equal(acceptedPreferenceState.feedbackVersion, 1);
  assert.deepEqual(
    await preferenceRecorder.execute(preferenceCommand),
    acceptedPreferenceState,
    "an exact replay must return the causally accepted projection",
  );
  assert.deepEqual(
    await preferenceReader.execute({
      workspaceId: workspace,
      routineId: routine.id,
      timeZone: "UTC",
    }),
    {
      routineId: routine.id,
      feedbackVersion: 1,
      activeEventCount: 1,
      score: 100,
      reason: "You asked to see this routine more often (+100).",
      updatedAt: clock.now(),
    },
  );
  await assert.rejects(
    preferenceRecorder.execute({
      ...preferenceCommand,
      expectedFeedbackVersion: 1,
      sourcePlanId: "00000000-0000-4000-8000-000000000777" as DailyPlanId,
      sourcePlanItemId: null,
      idempotencyKey: "database-verification-selection-preference-missing-source",
    }),
    (error: unknown) => {
      assert.equal(
        typeof error === "object" && error !== null && "code" in error
          ? (error as { code: unknown }).code
          : undefined,
        "planning.selection_preference_source_not_found",
      );
      return true;
    },
  );
  await assert.rejects(
    preferenceRecorder.execute({
      ...preferenceCommand,
      idempotencyKey: "database-verification-selection-preference-stale",
    }),
    (error: unknown) => {
      assert.equal(
        typeof error === "object" && error !== null && "code" in error
          ? (error as { code: unknown }).code
          : undefined,
        "planning.selection_preference_version_conflict",
      );
      return true;
    },
  );
  const currentPlanAfterPreference = await new GetDailyPlan(unitOfWork).execute({
    workspaceId: workspace,
    date: request.date,
    requestRevision: request.requestRevision,
  });
  assert.equal(currentPlanAfterPreference?.id, firstPlan.id);
  assert.equal(currentPlanAfterPreference?.inputHash, firstPlan.inputHash);
  assert.deepEqual(
    currentPlanAfterPreference?.items.map((item) => ({
      id: item.id,
      activityState: item.activityState,
      locked: item.locked,
    })),
    firstPlan.items.map((item) => ({
      id: item.id,
      activityState: item.activityState,
      locked: item.locked,
    })),
    "selection preference feedback must not mutate the current plan",
  );
  await assert.rejects(
    (async () => {
      const [event] = await connection.sql<{ id: string }[]>`
        select id::text
        from routine_selection_preference_feedback_events
        where workspace_id = ${workspace}
          and routine_id = ${routine.id}
          and feedback_version = 1
      `;
      assert.notEqual(event, undefined);
      await connection.sql`
        update routine_selection_preference_feedback_events
        set kind = 'less_often'
        where id = ${event!.id}
      `;
    })(),
    assertDatabaseErrorCode("55000"),
  );

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
  assert.equal(
    unifiedPlan.items.find((item) => item.routineId === routine.id)?.scoreComponents
      .selectionPreferenceFeedback,
    100,
    "future plans must consume explicit routine selection preference feedback",
  );
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

  // EVIDENCE: daily-plan-fit-insight-postgres
  // Three fully resolved current heads derive one deterministic joint time/task suggestion.
  fitWorkspace = (
    await new CreateWorkspace(unitOfWork, clock).execute({
      name: "Daily Plan Fit verification",
    })
  ).id;
  const fitRoutines = [];
  for (const title of ["Fit routine A", "Fit routine B", "Fit routine C", "Fit routine D"]) {
    fitRoutines.push(
      await new CreateRoutine(unitOfWork, clock).execute({
        workspaceId: fitWorkspace,
        title,
        tags: createStructuredTags({
          priority: "high",
          energy: "normal",
          contexts: ["computer"],
          categories: ["plan-fit-verification"],
        }),
        duration: createDurationRange({ expectedMinutes: 45 }),
        cadence: createCadencePolicy({
          period: "day",
          targetCompletions: 1,
          maximumCompletions: 1,
        }),
      }),
    );
  }
  assert.equal(fitRoutines.length, 4);

  const fitGenerator = new GenerateDailyPlan(unitOfWork, clock);
  const fitActivity = new RecordPlanItemActivity(unitOfWork, clock);
  let latestFitPlanId: DailyPlanId | null = null;
  let latestFitCompletedItemId: PlanItemId | null = null;
  let latestFitHeadVersion = 0;
  for (const [dateIndex, dateText] of ["2026-07-11", "2026-07-12", "2026-07-13"].entries()) {
    const date = localDate(dateText);
    const fitPlan = await fitGenerator.execute({
      request: createDailyPlanningRequest({
        workspaceId: fitWorkspace,
        date,
        timeZone: "UTC",
        availableWindows: [
          {
            startsAt: new Date(`${dateText}T08:00:00.000Z`),
            endsAt: new Date(`${dateText}T12:30:00.000Z`),
          },
        ],
        targetMinutes: 180,
        targetTaskCount: 4,
        availableContexts: ["computer"],
        seed: `daily-plan-fit-verification-${dateText}`,
        requestRevision: 1,
      }),
    });
    assert.equal(fitPlan.items.length, 4, "Plan Fit evidence needs four planned items per day");
    let headVersion = 1;
    for (const [itemIndex, item] of fitPlan.items.entries()) {
      const type = itemIndex < 2 ? "completed" : "skipped";
      const result = await fitActivity.execute({
        workspaceId: fitWorkspace,
        date,
        expectedPlanId: fitPlan.id,
        itemId: item.id,
        expectedHeadVersion: headVersion,
        type,
        occurredAt: new Date(`${dateText}T${String(13 + itemIndex).padStart(2, "0")}:00:00.000Z`),
        timeZone: "UTC",
        ...(type === "completed" ? { durationMinutes: 45 } : {}),
        idempotencyKey: `daily-plan-fit-${dateIndex}-${itemIndex}-${type}`,
      });
      headVersion = result.headVersion;
    }
    if (dateText === "2026-07-13") {
      latestFitPlanId = fitPlan.id;
      latestFitCompletedItemId = fitPlan.items[0]!.id;
      latestFitHeadVersion = headVersion;
    }
  }

  const fitForDate = localDate("2026-07-14");
  const getPlanFitInsight = new GetDailyPlanFitInsight(unitOfWork, clock);
  const dismissPlanFitInsight = new DismissDailyPlanFitInsight(unitOfWork, clock);
  const resetPlanFitInsight = new ResetDailyPlanFitInsightDismissal(unitOfWork, clock);
  const initialFitInsight = await getPlanFitInsight.execute({
    workspaceId: fitWorkspace,
    forDate: fitForDate,
  });
  assert.deepEqual(
    {
      status: initialFitInsight.status,
      disposition: initialFitInsight.disposition,
      sampleCount: initialFitInsight.sampleCount,
      typicalPlannedMinutes: initialFitInsight.typicalPlannedMinutes,
      typicalCompletedMinutes: initialFitInsight.typicalCompletedMinutes,
      typicalPlannedTaskCount: initialFitInsight.typicalPlannedTaskCount,
      typicalCompletedTaskCount: initialFitInsight.typicalCompletedTaskCount,
      suggestedTargetMinutes: initialFitInsight.suggestedTargetMinutes,
      suggestedTargetTaskCount: initialFitInsight.suggestedTargetTaskCount,
    },
    {
      status: "suggested",
      disposition: "available",
      sampleCount: 3,
      typicalPlannedMinutes: 180,
      typicalCompletedMinutes: 90,
      typicalPlannedTaskCount: 4,
      typicalCompletedTaskCount: 2,
      suggestedTargetMinutes: 90,
      suggestedTargetTaskCount: 2,
    },
  );
  assert.ok(initialFitInsight.insightKey);

  const fitHeadsBeforeFeedback = await connection.sql<
    { local_date: string; current_plan_id: string; version: number }[]
  >`
    select local_date::text, current_plan_id::text, version
    from daily_plan_heads
    where workspace_id = ${fitWorkspace}
    order by local_date, id
  `;
  const firstFitDismissal = await dismissPlanFitInsight.execute({
    workspaceId: fitWorkspace,
    forDate: fitForDate,
    insightKey: initialFitInsight.insightKey,
    idempotencyKey: "daily-plan-fit-dismiss",
  });
  const replayedFitDismissal = await dismissPlanFitInsight.execute({
    workspaceId: fitWorkspace,
    forDate: fitForDate,
    insightKey: initialFitInsight.insightKey,
    idempotencyKey: "daily-plan-fit-dismiss",
  });
  assert.equal(replayedFitDismissal.id, firstFitDismissal.id);
  assert.equal(
    (await getPlanFitInsight.execute({ workspaceId: fitWorkspace, forDate: fitForDate }))
      .disposition,
    "dismissed",
  );
  await assert.rejects(
    resetPlanFitInsight.execute({
      workspaceId: fitWorkspace,
      forDate: fitForDate,
      insightKey: initialFitInsight.insightKey,
      idempotencyKey: "daily-plan-fit-dismiss",
    }),
    (error: unknown) => {
      assert.equal(
        typeof error === "object" && error !== null && "code" in error
          ? (error as { code: unknown }).code
          : undefined,
        "daily_plan_fit_insight.idempotency_conflict",
      );
      return true;
    },
  );
  const firstFitReset = await resetPlanFitInsight.execute({
    workspaceId: fitWorkspace,
    forDate: fitForDate,
    insightKey: initialFitInsight.insightKey,
    idempotencyKey: "daily-plan-fit-reset",
  });
  const replayedFitReset = await resetPlanFitInsight.execute({
    workspaceId: fitWorkspace,
    forDate: fitForDate,
    insightKey: initialFitInsight.insightKey,
    idempotencyKey: "daily-plan-fit-reset",
  });
  assert.equal(replayedFitReset.id, firstFitReset.id);
  assert.equal(
    (await getPlanFitInsight.execute({ workspaceId: fitWorkspace, forDate: fitForDate }))
      .disposition,
    "available",
  );

  // UUID spelling cannot split the workspace feedback lock. An uppercase direct application call
  // must queue behind the canonical lowercase key held by this transaction.
  const waitingBeforeFitCaseCheck = await waitingAdvisoryLockCount();
  let markFitCaseBlockerReady!: () => void;
  let releaseFitCaseBlocker!: () => void;
  const fitCaseBlockerReady = new Promise<void>((resolve) => {
    markFitCaseBlockerReady = resolve;
  });
  const fitCaseBlockerRelease = new Promise<void>((resolve) => {
    releaseFitCaseBlocker = resolve;
  });
  const fitFeedbackLockKey = `${fitWorkspace.toLowerCase()}:daily-plan-fit-feedback`;
  const fitCaseBlocker = connection.sql.begin(async (sql) => {
    await sql`select pg_advisory_xact_lock(hashtextextended(${fitFeedbackLockKey}, 0))`;
    markFitCaseBlockerReady();
    await fitCaseBlockerRelease;
  });
  await fitCaseBlockerReady;

  let mixedCaseFitDismissal: ReturnType<DismissDailyPlanFitInsight["execute"]> | null = null;
  let mixedCaseQueueReady = false;
  try {
    mixedCaseFitDismissal = dismissPlanFitInsight.execute({
      workspaceId: workspaceId(fitWorkspace.toUpperCase()),
      forDate: fitForDate,
      insightKey: initialFitInsight.insightKey,
      idempotencyKey: "daily-plan-fit-mixed-case-dismiss",
    });
    await waitForAdvisoryLockCount(waitingBeforeFitCaseCheck + 1);
    mixedCaseQueueReady = true;
  } finally {
    releaseFitCaseBlocker();
    await fitCaseBlocker;
    if (!mixedCaseQueueReady && mixedCaseFitDismissal !== null) {
      await Promise.allSettled([mixedCaseFitDismissal]);
    }
  }
  assert.equal((await mixedCaseFitDismissal!).kind, "dismissed");
  assert.equal(
    (
      await resetPlanFitInsight.execute({
        workspaceId: fitWorkspace,
        forDate: fitForDate,
        insightKey: initialFitInsight.insightKey,
        idempotencyKey: "daily-plan-fit-mixed-case-reset",
      })
    ).kind,
    "reset",
  );

  await dismissPlanFitInsight.execute({
    workspaceId: fitWorkspace,
    forDate: fitForDate,
    insightKey: initialFitInsight.insightKey,
    idempotencyKey: "daily-plan-fit-dismiss-before-new-evidence",
  });
  const fitHeadsAfterFeedback = await connection.sql<
    { local_date: string; current_plan_id: string; version: number }[]
  >`
    select local_date::text, current_plan_id::text, version
    from daily_plan_heads
    where workspace_id = ${fitWorkspace}
    order by local_date, id
  `;
  assert.deepEqual(fitHeadsAfterFeedback, fitHeadsBeforeFeedback);

  const fitFeedbackRows = await connection.sql<
    { insight_key: string; kind: string; idempotency_key: string }[]
  >`
    select insight_key, kind::text, idempotency_key
    from daily_plan_fit_insight_feedback_events
    where workspace_id = ${fitWorkspace}
    order by ingested_sequence, id
  `;
  assert.ok(
    fitFeedbackRows.every((row) => row.insight_key === initialFitInsight.insightKey),
    "every Plan Fit feedback event must retain the exact reviewed evidence key",
  );
  assert.deepEqual(
    fitFeedbackRows.map(({ kind, idempotency_key }) => ({ kind, idempotency_key })),
    [
      {
        kind: "dismissed",
        idempotency_key: "daily-plan-fit-dismiss",
      },
      {
        kind: "reset",
        idempotency_key: "daily-plan-fit-reset",
      },
      {
        kind: "dismissed",
        idempotency_key: "daily-plan-fit-mixed-case-dismiss",
      },
      {
        kind: "reset",
        idempotency_key: "daily-plan-fit-mixed-case-reset",
      },
      {
        kind: "dismissed",
        idempotency_key: "daily-plan-fit-dismiss-before-new-evidence",
      },
    ],
  );
  await assert.rejects(
    connection.sql`
      update daily_plan_fit_insight_feedback_events
      set kind = kind
      where workspace_id = ${fitWorkspace}
    `,
    assertDatabaseErrorCode("55000"),
  );
  await assert.rejects(
    connection.sql`
      delete from daily_plan_fit_insight_feedback_events
      where workspace_id = ${fitWorkspace}
    `,
    assertDatabaseErrorCode("55000"),
  );

  assert.ok(latestFitPlanId);
  assert.ok(latestFitCompletedItemId);
  const reopenedFitItem = await fitActivity.execute({
    workspaceId: fitWorkspace,
    date: localDate("2026-07-13"),
    expectedPlanId: latestFitPlanId,
    itemId: latestFitCompletedItemId,
    expectedHeadVersion: latestFitHeadVersion,
    type: "completion_reversed",
    occurredAt: new Date("2026-07-14T01:00:00.000Z"),
    timeZone: "UTC",
    idempotencyKey: "daily-plan-fit-reverse-completion",
  });
  await fitActivity.execute({
    workspaceId: fitWorkspace,
    date: localDate("2026-07-13"),
    expectedPlanId: latestFitPlanId,
    itemId: latestFitCompletedItemId,
    expectedHeadVersion: reopenedFitItem.headVersion,
    type: "skipped",
    occurredAt: new Date("2026-07-14T01:01:00.000Z"),
    timeZone: "UTC",
    idempotencyKey: "daily-plan-fit-skip-reopened-item",
  });
  const changedFitInsight = await getPlanFitInsight.execute({
    workspaceId: fitWorkspace,
    forDate: fitForDate,
  });
  assert.equal(changedFitInsight.status, "suggested");
  assert.equal(changedFitInsight.disposition, "available");
  assert.notEqual(changedFitInsight.insightKey, initialFitInsight.insightKey);
  assert.ok(changedFitInsight.insightKey);

  const fitUsageRequestBase = {
    workspaceId: fitWorkspace,
    date: fitForDate,
    timeZone: "UTC",
    availableWindows: [
      {
        startsAt: new Date("2026-07-14T08:00:00.000Z"),
        endsAt: new Date("2026-07-14T12:30:00.000Z"),
      },
    ],
    targetMinutes: 105,
    targetTaskCount: 3,
    availableContexts: ["computer"],
    seed: "daily-plan-fit-explicit-use",
    requestRevision: 1,
  } as const;
  await assert.rejects(
    fitGenerator.execute({
      request: createDailyPlanningRequest({
        ...fitUsageRequestBase,
        planFitInsightKey: initialFitInsight.insightKey,
      }),
    }),
    (error: unknown) => {
      assert.equal(
        typeof error === "object" && error !== null && "code" in error
          ? (error as { code: unknown }).code
          : undefined,
        "daily_plan_fit_insight.evidence_conflict",
      );
      return true;
    },
  );
  assert.equal(
    await new GetDailyPlan(unitOfWork).execute({
      workspaceId: fitWorkspace,
      date: fitForDate,
      requestRevision: 1,
    }),
    null,
    "stale Plan Fit evidence must not create a plan revision",
  );

  const listFitUsageOutcomes = new ListDailyPlanFitUsageOutcomes(unitOfWork);
  assert.deepEqual(
    await listFitUsageOutcomes.execute({ workspaceId: fitWorkspace, limit: 5 }),
    [],
    "reading or prefilling a Plan Fit suggestion must not record usage",
  );
  const fitUsageRequest = createDailyPlanningRequest({
    ...fitUsageRequestBase,
    planFitInsightKey: changedFitInsight.insightKey,
  });

  // A selected generation begins before a concurrent real dismissal commits, with both queued
  // behind the same workspace feedback lock. The dismissal enters the queue first. Its physical SSI
  // guard write must force the serializable generation to retry, observe the winning dismissal, and
  // fail without creating either the revision or its use receipt.
  const waitingBeforeFitGenerationConflict = await waitingAdvisoryLockCount();
  let markFitGenerationBlockerReady!: () => void;
  let releaseFitGenerationBlocker!: () => void;
  const fitGenerationBlockerReady = new Promise<void>((resolve) => {
    markFitGenerationBlockerReady = resolve;
  });
  const fitGenerationBlockerRelease = new Promise<void>((resolve) => {
    releaseFitGenerationBlocker = resolve;
  });
  const fitGenerationBlocker = connection.sql.begin(async (sql) => {
    await sql`select pg_advisory_xact_lock(hashtextextended(${fitFeedbackLockKey}, 0))`;
    markFitGenerationBlockerReady();
    await fitGenerationBlockerRelease;
  });
  await fitGenerationBlockerReady;

  let queuedFitDismissal: ReturnType<DismissDailyPlanFitInsight["execute"]> | null = null;
  let queuedFitGeneration: ReturnType<GenerateDailyPlan["execute"]> | null = null;
  let fitGenerationQueued = false;
  try {
    queuedFitDismissal = dismissPlanFitInsight.execute({
      workspaceId: fitWorkspace,
      forDate: fitForDate,
      insightKey: changedFitInsight.insightKey,
      idempotencyKey: "daily-plan-fit-concurrent-dismissal",
    });
    void queuedFitDismissal.catch(() => undefined);
    await waitForAdvisoryLockCount(waitingBeforeFitGenerationConflict + 1);
    queuedFitGeneration = fitGenerator.execute({ request: fitUsageRequest });
    void queuedFitGeneration.catch(() => undefined);
    await waitForAdvisoryLockCount(waitingBeforeFitGenerationConflict + 2);
    fitGenerationQueued = true;
  } finally {
    releaseFitGenerationBlocker();
    await fitGenerationBlocker;
    if (!fitGenerationQueued) {
      const pendingOperations: Promise<unknown>[] = [];
      if (queuedFitDismissal !== null) pendingOperations.push(queuedFitDismissal);
      if (queuedFitGeneration !== null) pendingOperations.push(queuedFitGeneration);
      await Promise.allSettled(pendingOperations);
    }
  }
  assert.equal((await queuedFitDismissal!).kind, "dismissed");
  await assert.rejects(queuedFitGeneration!, (error: unknown) => {
    assert.equal(
      typeof error === "object" && error !== null && "code" in error
        ? (error as { code: unknown }).code
        : undefined,
      "daily_plan_fit_insight.evidence_conflict",
    );
    return true;
  });
  assert.equal(
    await new GetDailyPlan(unitOfWork).execute({
      workspaceId: fitWorkspace,
      date: fitForDate,
      requestRevision: 1,
    }),
    null,
    "a queued Plan Fit dismissal must win before selected generation without a write",
  );
  assert.equal(
    (
      await resetPlanFitInsight.execute({
        workspaceId: fitWorkspace,
        forDate: fitForDate,
        insightKey: changedFitInsight.insightKey,
        idempotencyKey: "daily-plan-fit-reset-after-concurrent-dismissal",
      })
    ).kind,
    "reset",
  );

  const fitUsagePlan = await fitGenerator.execute({ request: fitUsageRequest });
  const replayedFitUsagePlan = await fitGenerator.execute({ request: fitUsageRequest });
  assert.equal(replayedFitUsagePlan.id, fitUsagePlan.id);
  assert.ok(fitUsagePlan.items.length > 0);
  assert.equal(
    (
      await connection.sql<{ insight_key: string | null }[]>`
      select input_snapshot #>> '{request,planFitInsightKey}' as insight_key
      from daily_plans
      where workspace_id = ${fitWorkspace}
        and id = ${fitUsagePlan.id}
    `
    )[0]?.insight_key,
    changedFitInsight.insightKey,
  );

  const usedRows = await connection.sql<
    {
      insight_key: string;
      plan_id: string;
      suggested_target_minutes: number;
      suggested_target_task_count: number;
      applied_target_minutes: number;
      applied_target_task_count: number;
    }[]
  >`
    select
      insight_key,
      plan_id::text,
      suggested_target_minutes,
      suggested_target_task_count,
      applied_target_minutes,
      applied_target_task_count
    from daily_plan_fit_insight_feedback_events
    where workspace_id = ${fitWorkspace}
      and kind::text = 'used'
    order by ingested_sequence, id
  `;
  assert.deepEqual(
    [...usedRows],
    [
      {
        insight_key: changedFitInsight.insightKey,
        plan_id: fitUsagePlan.id,
        suggested_target_minutes: changedFitInsight.suggestedTargetMinutes,
        suggested_target_task_count: changedFitInsight.suggestedTargetTaskCount,
        applied_target_minutes: 105,
        applied_target_task_count: 3,
      },
    ],
  );

  const headsBeforeUsageRead = await connection.sql<
    { local_date: string; current_plan_id: string; version: number }[]
  >`
    select local_date::text, current_plan_id::text, version
    from daily_plan_heads
    where workspace_id = ${fitWorkspace}
    order by local_date, id
  `;
  const [pendingFitOutcome] = await listFitUsageOutcomes.execute({
    workspaceId: fitWorkspace,
    limit: 5,
  });
  assert.ok(pendingFitOutcome);
  assert.equal(pendingFitOutcome.status, "pending");
  assert.equal(pendingFitOutcome.sourcePlanId, fitUsagePlan.id);
  assert.equal(pendingFitOutcome.currentPlanId, fitUsagePlan.id);
  assert.equal(pendingFitOutcome.revisedSinceUsage, false);
  assert.equal(pendingFitOutcome.appliedTargetMinutes, 105);
  assert.equal(pendingFitOutcome.appliedTargetTaskCount, 3);
  assert.equal(pendingFitOutcome.completedMinutes, null);
  assert.equal(pendingFitOutcome.completedTaskCount, null);
  assert.deepEqual(
    await connection.sql<{ local_date: string; current_plan_id: string; version: number }[]>`
      select local_date::text, current_plan_id::text, version
      from daily_plan_heads
      where workspace_id = ${fitWorkspace}
      order by local_date, id
    `,
    headsBeforeUsageRead,
    "outcome history reads must not mutate planner heads",
  );
  assert.deepEqual(
    await listFitUsageOutcomes.execute({ workspaceId: workspace, limit: 5 }),
    [],
    "Plan Fit usage history must remain tenant-scoped",
  );

  let fitUsageHeadVersion = 1;
  for (const [itemIndex, item] of fitUsagePlan.items.entries()) {
    const type = itemIndex === 0 ? "completed" : "skipped";
    const result = await fitActivity.execute({
      workspaceId: fitWorkspace,
      date: fitForDate,
      expectedPlanId: fitUsagePlan.id,
      itemId: item.id,
      expectedHeadVersion: fitUsageHeadVersion,
      type,
      occurredAt: new Date(`2026-07-14T${String(13 + itemIndex).padStart(2, "0")}:30:00.000Z`),
      timeZone: "UTC",
      ...(type === "completed" ? { durationMinutes: item.scheduledMinutes } : {}),
      idempotencyKey: `daily-plan-fit-used-${itemIndex}-${type}`,
    });
    fitUsageHeadVersion = result.headVersion;
  }
  const [resolvedFitOutcome] = await listFitUsageOutcomes.execute({
    workspaceId: fitWorkspace,
    limit: 5,
  });
  assert.ok(resolvedFitOutcome);
  assert.equal(resolvedFitOutcome.status, "resolved");
  assert.equal(resolvedFitOutcome.completedMinutes, fitUsagePlan.items[0]!.scheduledMinutes);
  assert.equal(resolvedFitOutcome.completedTaskCount, 1);

  const revisedFitPlan = await new MutateDailyPlan(unitOfWork, clock).regenerate({
    workspaceId: fitWorkspace,
    expectedPlanId: fitUsagePlan.id,
    expectedHeadVersion: fitUsageHeadVersion,
    request: createDailyPlanningRequest({
      ...fitUsageRequestBase,
      targetMinutes: 45,
      targetTaskCount: 1,
      seed: "daily-plan-fit-revised-after-use",
    }),
    idempotencyKey: "daily-plan-fit-revise-after-use",
  });
  const [revisedFitOutcome] = await listFitUsageOutcomes.execute({
    workspaceId: fitWorkspace,
    limit: 5,
  });
  assert.ok(revisedFitOutcome);
  assert.equal(revisedFitOutcome.sourcePlanId, fitUsagePlan.id);
  assert.equal(revisedFitOutcome.currentPlanId, revisedFitPlan.plan.id);
  assert.equal(revisedFitOutcome.currentPlanRevision, 2);
  assert.equal(revisedFitOutcome.revisedSinceUsage, true);
  assert.equal(
    (
      await connection.sql<{ count: number }[]>`
      select count(*)::int as count
      from daily_plan_fit_insight_feedback_events
      where workspace_id = ${fitWorkspace}
        and kind::text = 'used'
    `
    )[0]?.count,
    1,
    "retries, outcome reads, activity, and revision must not duplicate the immutable use event",
  );
  await assert.rejects(
    connection.sql`
      update daily_plan_fit_insight_feedback_events
      set applied_target_minutes = applied_target_minutes
      where workspace_id = ${fitWorkspace}
        and kind::text = 'used'
    `,
    assertDatabaseErrorCode("55000"),
  );
  await assert.rejects(
    connection.sql`
      delete from daily_plan_fit_insight_feedback_events
      where workspace_id = ${fitWorkspace}
        and kind::text = 'used'
    `,
    assertDatabaseErrorCode("55000"),
  );
  process.stdout.write("daily-plan-fit-insight verification passed\n");

  process.stdout.write("planner database verification passed\n");
} finally {
  await removeVerificationWorkspace();
  await connection.close();
}
