import { and, asc, count, desc, eq, lt, lte, sql } from "drizzle-orm";

import type {
  ActivityHistoryCursor,
  ActivityHistoryPage,
  ActivityEventRepository,
  DailyPlanRepository,
  RoutineRepository,
  ScheduleBlockRepository,
  TransactionContext,
  UnitOfWork,
  WorkItemRepository,
  WorkspaceRepository,
} from "@schedule/application";
import {
  DomainError,
  activityEventId,
  createCadencePolicy,
  createDurationRange,
  createRoutine,
  createStructuredTags,
  dailyPlanId,
  localDate,
  routineId,
  scheduleBlockId,
  workItemId,
  workspaceId,
  type ActivityEvent,
  type DailyPlan,
  type JsonValue,
  type PlanExclusion,
  type PlanItem,
  type PlanWarning,
  type Routine,
  type RoutineStatus,
  type ScheduleBlock,
  type ScheduleBlockId,
  type WorkItem,
  type WorkItemId,
  type WorkspaceId,
  type Workspace,
} from "@schedule/domain";

import type { DatabaseConnection } from "./database.js";
import {
  activityEvents,
  dailyPlanItems,
  dailyPlans,
  routines,
  scheduleBlocks,
  workItems,
  workspaces,
} from "./schema.js";

type TransactionCallback = Parameters<DatabaseConnection["db"]["transaction"]>[0];
type DatabaseTransaction = Parameters<TransactionCallback>[0];
type DatabaseExecutor = DatabaseConnection["db"] | DatabaseTransaction;

type WorkItemRow = typeof workItems.$inferSelect;
type WorkspaceRow = typeof workspaces.$inferSelect;
type ScheduleBlockRow = typeof scheduleBlocks.$inferSelect;
type RoutineRow = typeof routines.$inferSelect;
type ActivityEventRow = typeof activityEvents.$inferSelect;
type DailyPlanRow = typeof dailyPlans.$inferSelect;
type DailyPlanItemRow = typeof dailyPlanItems.$inferSelect;

function databaseErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function databaseErrorConstraint(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("constraint_name" in error)) {
    return undefined;
  }
  return typeof error.constraint_name === "string" ? error.constraint_name : undefined;
}

function mapWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: workspaceId(row.id),
    name: row.name,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

function mapWorkItem(row: WorkItemRow): WorkItem {
  return {
    id: workItemId(row.id),
    workspaceId: workspaceId(row.workspaceId),
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    version: row.version,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

function mapScheduleBlock(row: ScheduleBlockRow): ScheduleBlock {
  return {
    id: scheduleBlockId(row.id),
    workspaceId: workspaceId(row.workspaceId),
    workItemId: row.workItemId === null ? null : workItemId(row.workItemId),
    title: row.title,
    startsAt: new Date(row.startsAt),
    endsAt: new Date(row.endsAt),
    timeZone: row.timeZone,
    version: row.version,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

function mapRoutine(row: RoutineRow): Routine {
  const created = createRoutine({
    id: routineId(row.id),
    workspaceId: workspaceId(row.workspaceId),
    title: row.title,
    description: row.description,
    status: row.status,
    tags: createStructuredTags({
      priority: row.priority,
      effort: row.effort,
      energy: row.energy,
      preference: row.preference,
      contexts: row.contexts,
      categories: row.categories,
      freeForm: row.freeFormTags,
    }),
    duration: createDurationRange({
      minimumMinutes: row.minimumDurationMinutes,
      expectedMinutes: row.expectedDurationMinutes,
      maximumMinutes: row.maximumDurationMinutes,
      splittable: row.splittable,
      minimumSessionMinutes: row.minimumSessionMinutes,
      overheadMinutes: row.overheadMinutes,
    }),
    cadence: createCadencePolicy({
      period: row.cadencePeriod,
      rollingIntervalDays: row.rollingIntervalDays,
      targetCompletions: row.targetCompletions,
      minimumCompletions: row.minimumCompletions,
      maximumCompletions: row.maximumCompletions,
      minimumSpacingDays: row.minimumSpacingDays,
      preferredWeekdays: row.preferredWeekdays as Routine["cadence"]["preferredWeekdays"],
      excludedWeekdays: row.excludedWeekdays as Routine["cadence"]["excludedWeekdays"],
      discourageConsecutiveDays: row.discourageConsecutiveDays,
      prohibitConsecutiveDays: row.prohibitConsecutiveDays,
      weekStartsOn: row.weekStartsOn as Routine["cadence"]["weekStartsOn"],
      startsOn: row.startsOn,
      pausedUntil: row.pausedUntil,
      endsOn: row.endsOn,
    }),
    now: row.createdAt,
  });
  return {
    ...created,
    version: row.version,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

function mapActivityEvent(row: ActivityEventRow): ActivityEvent {
  return {
    id: activityEventId(row.id),
    workspaceId: workspaceId(row.workspaceId),
    routineId: routineId(row.routineId),
    planId: row.planId === null ? null : dailyPlanId(row.planId),
    type: row.type,
    occurredAt: new Date(row.occurredAt),
    localDate: localDate(row.localDate),
    timeZone: row.timeZone,
    durationMinutes: row.durationMinutes,
    reason: row.reason,
    referenceEventId: row.referenceEventId === null ? null : activityEventId(row.referenceEventId),
    idempotencyKey: row.idempotencyKey,
    metadata: row.metadata,
    recordedAt: new Date(row.recordedAt),
  };
}

function canonicalMetadata(value: ActivityEvent["metadata"]): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(value).sort(([left], [right]) => left.localeCompare(right, "en")),
    ),
  );
}

function resolveIdempotentActivity(
  existing: ActivityEvent,
  requested: ActivityEvent,
): ActivityEvent {
  const sameEvent =
    existing.routineId === requested.routineId &&
    existing.planId === requested.planId &&
    existing.type === requested.type &&
    existing.occurredAt.getTime() === requested.occurredAt.getTime() &&
    existing.localDate === requested.localDate &&
    existing.timeZone === requested.timeZone &&
    existing.durationMinutes === requested.durationMinutes &&
    existing.reason === requested.reason &&
    existing.referenceEventId === requested.referenceEventId &&
    canonicalMetadata(existing.metadata) === canonicalMetadata(requested.metadata);
  if (!sameEvent) {
    throw new DomainError(
      "activity.idempotency_conflict",
      "This activity idempotency key already belongs to a different event.",
    );
  }
  return existing;
}

function mapPlanItem(row: DailyPlanItemRow): PlanItem {
  return {
    routineId: routineId(row.routineId),
    title: row.titleSnapshot,
    position: row.position,
    windowIndex: row.windowIndex,
    scheduledMinutes: row.scheduledMinutes,
    partialSession: row.partialSession,
    score: row.score,
    scoreComponents: row.scoreComponents,
    reasons: row.reasons,
  };
}

function mapDailyPlan(row: DailyPlanRow, itemRows: readonly DailyPlanItemRow[]): DailyPlan {
  return {
    id: dailyPlanId(row.id),
    workspaceId: workspaceId(row.workspaceId),
    date: localDate(row.localDate),
    timeZone: row.timeZone,
    items: itemRows.map(mapPlanItem),
    totalMinutes: row.totalMinutes,
    fitness: row.fitness,
    algorithmVersion: row.algorithmVersion,
    configVersion: row.configVersion,
    prngVersion: row.prngVersion,
    seed: row.seed,
    requestRevision: row.requestRevision,
    inputHash: row.inputHash,
    inputSnapshot: row.inputSnapshot as JsonValue,
    exclusions: row.exclusions.map((exclusion): PlanExclusion => ({
      routineId: routineId(exclusion.routineId),
      title: exclusion.title,
      codes: exclusion.codes as PlanExclusion["codes"],
    })),
    warnings: row.warnings as PlanWarning[],
    generatedAt: new Date(row.generatedAt),
  };
}

class PostgresWorkItemRepository implements WorkItemRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async findById(workspace: WorkspaceId, id: WorkItemId): Promise<WorkItem | null> {
    const [row] = await this.database
      .select()
      .from(workItems)
      .where(and(eq(workItems.workspaceId, workspace), eq(workItems.id, id)))
      .limit(1);
    return row === undefined ? null : mapWorkItem(row);
  }

  async insert(item: WorkItem): Promise<void> {
    await this.database.insert(workItems).values({
      id: item.id,
      workspaceId: item.workspaceId,
      title: item.title,
      description: item.description,
      status: item.status,
      priority: item.priority,
      version: item.version,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    });
  }

  async save(item: WorkItem, expectedVersion: number): Promise<void> {
    const updated = await this.database
      .update(workItems)
      .set({
        title: item.title,
        description: item.description,
        status: item.status,
        priority: item.priority,
        version: item.version,
        updatedAt: item.updatedAt,
      })
      .where(
        and(
          eq(workItems.workspaceId, item.workspaceId),
          eq(workItems.id, item.id),
          eq(workItems.version, expectedVersion),
        ),
      )
      .returning({ id: workItems.id });
    if (updated.length === 0) {
      throw new DomainError(
        "work_item.version_conflict",
        "The work item changed before this update could be saved.",
      );
    }
  }
}

class PostgresScheduleBlockRepository implements ScheduleBlockRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async findById(workspace: WorkspaceId, id: ScheduleBlockId): Promise<ScheduleBlock | null> {
    const [row] = await this.database
      .select()
      .from(scheduleBlocks)
      .where(and(eq(scheduleBlocks.workspaceId, workspace), eq(scheduleBlocks.id, id)))
      .limit(1);
    return row === undefined ? null : mapScheduleBlock(row);
  }

  async insert(block: ScheduleBlock): Promise<void> {
    await this.database.insert(scheduleBlocks).values({
      id: block.id,
      workspaceId: block.workspaceId,
      workItemId: block.workItemId,
      title: block.title,
      startsAt: block.startsAt,
      endsAt: block.endsAt,
      timeZone: block.timeZone,
      version: block.version,
      createdAt: block.createdAt,
      updatedAt: block.updatedAt,
    });
  }
}

class PostgresWorkspaceRepository implements WorkspaceRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async findById(id: WorkspaceId): Promise<Workspace | null> {
    const [row] = await this.database
      .select()
      .from(workspaces)
      .where(eq(workspaces.id, id))
      .limit(1);
    return row === undefined ? null : mapWorkspace(row);
  }

  async insert(workspace: Workspace): Promise<void> {
    const [total] = await this.database.select({ value: count() }).from(workspaces);
    if ((total?.value ?? 0) >= 20) {
      throw new DomainError(
        "workspace.installation_limit_reached",
        "Local mode supports at most 20 workspaces.",
      );
    }
    await this.database.insert(workspaces).values({
      id: workspace.id,
      name: workspace.name,
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
    });
  }
}

class PostgresRoutineRepository implements RoutineRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async findById(workspace: WorkspaceId, id: Routine["id"]): Promise<Routine | null> {
    const [row] = await this.database
      .select()
      .from(routines)
      .where(and(eq(routines.workspaceId, workspace), eq(routines.id, id)))
      .limit(1);
    return row === undefined ? null : mapRoutine(row);
  }

  async list(
    workspace: WorkspaceId,
    status: RoutineStatus | undefined,
    limit: number,
    offset: number,
  ): Promise<readonly Routine[]> {
    const rows = await this.database
      .select()
      .from(routines)
      .where(
        status === undefined
          ? eq(routines.workspaceId, workspace)
          : and(eq(routines.workspaceId, workspace), eq(routines.status, status)),
      )
      .orderBy(asc(routines.createdAt), asc(routines.id))
      .limit(limit)
      .offset(offset);
    return rows.map(mapRoutine);
  }

  async listPlanningCandidates(workspace: WorkspaceId): Promise<readonly Routine[]> {
    const rows = await this.database
      .select()
      .from(routines)
      .where(eq(routines.workspaceId, workspace))
      .orderBy(asc(routines.id))
      .limit(501);
    return rows.map(mapRoutine);
  }

  async insert(routine: Routine): Promise<void> {
    const [total] = await this.database
      .select({ value: count() })
      .from(routines)
      .where(eq(routines.workspaceId, routine.workspaceId));
    if ((total?.value ?? 0) >= 500) {
      throw new DomainError(
        "routine.workspace_limit_reached",
        "A workspace cannot contain more than 500 routines in local mode.",
      );
    }
    await this.database.insert(routines).values({
      id: routine.id,
      workspaceId: routine.workspaceId,
      title: routine.title,
      description: routine.description,
      status: routine.status,
      priority: routine.tags.priority,
      effort: routine.tags.effort,
      energy: routine.tags.energy,
      preference: routine.tags.preference,
      contexts: [...routine.tags.contexts],
      categories: [...routine.tags.categories],
      freeFormTags: [...routine.tags.freeForm],
      minimumDurationMinutes: routine.duration.minimumMinutes,
      expectedDurationMinutes: routine.duration.expectedMinutes,
      maximumDurationMinutes: routine.duration.maximumMinutes,
      splittable: routine.duration.splittable,
      minimumSessionMinutes: routine.duration.minimumSessionMinutes,
      overheadMinutes: routine.duration.overheadMinutes,
      cadencePeriod: routine.cadence.period,
      rollingIntervalDays: routine.cadence.rollingIntervalDays,
      targetCompletions: routine.cadence.targetCompletions,
      minimumCompletions: routine.cadence.minimumCompletions,
      maximumCompletions: routine.cadence.maximumCompletions,
      minimumSpacingDays: routine.cadence.minimumSpacingDays,
      preferredWeekdays: [...routine.cadence.preferredWeekdays],
      excludedWeekdays: [...routine.cadence.excludedWeekdays],
      discourageConsecutiveDays: routine.cadence.discourageConsecutiveDays,
      prohibitConsecutiveDays: routine.cadence.prohibitConsecutiveDays,
      weekStartsOn: routine.cadence.weekStartsOn,
      startsOn: routine.cadence.startsOn,
      pausedUntil: routine.cadence.pausedUntil,
      endsOn: routine.cadence.endsOn,
      version: routine.version,
      createdAt: routine.createdAt,
      updatedAt: routine.updatedAt,
    });
  }

  async save(routine: Routine, expectedVersion: number): Promise<void> {
    const updated = await this.database
      .update(routines)
      .set({
        title: routine.title,
        description: routine.description,
        status: routine.status,
        priority: routine.tags.priority,
        effort: routine.tags.effort,
        energy: routine.tags.energy,
        preference: routine.tags.preference,
        contexts: [...routine.tags.contexts],
        categories: [...routine.tags.categories],
        freeFormTags: [...routine.tags.freeForm],
        minimumDurationMinutes: routine.duration.minimumMinutes,
        expectedDurationMinutes: routine.duration.expectedMinutes,
        maximumDurationMinutes: routine.duration.maximumMinutes,
        splittable: routine.duration.splittable,
        minimumSessionMinutes: routine.duration.minimumSessionMinutes,
        overheadMinutes: routine.duration.overheadMinutes,
        cadencePeriod: routine.cadence.period,
        rollingIntervalDays: routine.cadence.rollingIntervalDays,
        targetCompletions: routine.cadence.targetCompletions,
        minimumCompletions: routine.cadence.minimumCompletions,
        maximumCompletions: routine.cadence.maximumCompletions,
        minimumSpacingDays: routine.cadence.minimumSpacingDays,
        preferredWeekdays: [...routine.cadence.preferredWeekdays],
        excludedWeekdays: [...routine.cadence.excludedWeekdays],
        discourageConsecutiveDays: routine.cadence.discourageConsecutiveDays,
        prohibitConsecutiveDays: routine.cadence.prohibitConsecutiveDays,
        weekStartsOn: routine.cadence.weekStartsOn,
        startsOn: routine.cadence.startsOn,
        pausedUntil: routine.cadence.pausedUntil,
        endsOn: routine.cadence.endsOn,
        version: routine.version,
        updatedAt: routine.updatedAt,
      })
      .where(
        and(
          eq(routines.workspaceId, routine.workspaceId),
          eq(routines.id, routine.id),
          eq(routines.version, expectedVersion),
        ),
      )
      .returning({ id: routines.id });
    if (updated.length === 0) {
      throw new DomainError(
        "routine.version_conflict",
        "The routine changed before this update could be saved.",
      );
    }
  }
}

class PostgresActivityEventRepository implements ActivityEventRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async findById(workspace: WorkspaceId, id: ActivityEvent["id"]): Promise<ActivityEvent | null> {
    const [row] = await this.database
      .select()
      .from(activityEvents)
      .where(and(eq(activityEvents.workspaceId, workspace), eq(activityEvents.id, id)))
      .limit(1);
    return row === undefined ? null : mapActivityEvent(row);
  }

  async listForPlanning(
    workspace: WorkspaceId,
    throughDate: ReturnType<typeof localDate>,
  ): Promise<readonly ActivityEvent[]> {
    const rows = await this.database
      .select()
      .from(activityEvents)
      .where(
        and(eq(activityEvents.workspaceId, workspace), lte(activityEvents.localDate, throughDate)),
      )
      .orderBy(
        desc(activityEvents.localDate),
        desc(activityEvents.occurredAt),
        desc(activityEvents.recordedAt),
        desc(activityEvents.id),
      )
      .limit(5_001);
    if (rows.length > 5_000) {
      throw new DomainError(
        "planning.activity_history_limit_exceeded",
        "Planning history exceeds the local-mode limit of 5,000 events.",
      );
    }
    return rows.reverse().map(mapActivityEvent);
  }

  async listHistory(
    workspace: WorkspaceId,
    routine: Routine["id"],
    limit: number,
    cursor?: ActivityHistoryCursor,
  ): Promise<ActivityHistoryPage> {
    let watermark = cursor?.watermark;
    if (watermark === undefined) {
      const [latest] = await this.database
        .select({ sequence: activityEvents.ingestedSequence })
        .from(activityEvents)
        .where(
          and(eq(activityEvents.workspaceId, workspace), eq(activityEvents.routineId, routine)),
        )
        .orderBy(desc(activityEvents.ingestedSequence))
        .limit(1);
      if (latest === undefined) return { items: [], nextCursor: null };
      watermark = latest.sequence;
    }

    const rows = await this.database
      .select()
      .from(activityEvents)
      .where(
        and(
          eq(activityEvents.workspaceId, workspace),
          eq(activityEvents.routineId, routine),
          lte(activityEvents.ingestedSequence, watermark),
          cursor === undefined ? undefined : lt(activityEvents.ingestedSequence, cursor.before),
        ),
      )
      .orderBy(desc(activityEvents.ingestedSequence))
      .limit(limit + 1);
    const pageRows = rows.slice(0, limit);
    const last = pageRows.at(-1);
    return {
      items: pageRows.map(mapActivityEvent),
      nextCursor:
        rows.length > limit && last !== undefined
          ? { watermark, before: last.ingestedSequence }
          : null,
    };
  }

  async append(event: ActivityEvent): Promise<ActivityEvent> {
    const [existingBeforeInsert] = await this.database
      .select()
      .from(activityEvents)
      .where(
        and(
          eq(activityEvents.workspaceId, event.workspaceId),
          eq(activityEvents.idempotencyKey, event.idempotencyKey),
        ),
      )
      .limit(1);
    if (existingBeforeInsert !== undefined) {
      return resolveIdempotentActivity(mapActivityEvent(existingBeforeInsert), event);
    }
    const [total] = await this.database
      .select({ value: count() })
      .from(activityEvents)
      .where(eq(activityEvents.workspaceId, event.workspaceId));
    if ((total?.value ?? 0) >= 5_000) {
      throw new DomainError(
        "activity.workspace_limit_reached",
        "A workspace cannot contain more than 5,000 activity events in local mode.",
      );
    }
    await this.database.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${event.workspaceId}:${event.routineId}`}, 0))`,
    );
    let inserted: ActivityEventRow | undefined;
    try {
      [inserted] = await this.database
        .insert(activityEvents)
        .values({
          id: event.id,
          workspaceId: event.workspaceId,
          routineId: event.routineId,
          planId: event.planId,
          type: event.type,
          occurredAt: event.occurredAt,
          localDate: event.localDate,
          timeZone: event.timeZone,
          durationMinutes: event.durationMinutes,
          reason: event.reason,
          referenceEventId: event.referenceEventId,
          idempotencyKey: event.idempotencyKey,
          metadata: { ...event.metadata },
          recordedAt: event.recordedAt,
        })
        .onConflictDoNothing({
          target: [activityEvents.workspaceId, activityEvents.idempotencyKey],
        })
        .returning();
    } catch (error) {
      if (databaseErrorConstraint(error) === "activity_events_single_reversal_idx") {
        throw new DomainError(
          "activity.completion_already_reversed",
          "This completion has already been reversed.",
        );
      }
      if (event.referenceEventId !== null && databaseErrorCode(error) === "23503") {
        throw new DomainError(
          "activity.reference_not_found",
          "The referenced activity event does not exist.",
        );
      }
      if (event.referenceEventId !== null && databaseErrorCode(error) === "23514") {
        throw new DomainError(
          "activity.reference_invalid",
          "The referenced event is not a completion for this routine.",
        );
      }
      throw error;
    }
    if (inserted !== undefined) return mapActivityEvent(inserted);

    const [existingRow] = await this.database
      .select()
      .from(activityEvents)
      .where(
        and(
          eq(activityEvents.workspaceId, event.workspaceId),
          eq(activityEvents.idempotencyKey, event.idempotencyKey),
        ),
      )
      .limit(1);
    if (existingRow === undefined) {
      throw new DomainError(
        "activity.idempotency_write_conflict",
        "The activity event could not be inserted or loaded.",
      );
    }
    return resolveIdempotentActivity(mapActivityEvent(existingRow), event);
  }
}

class PostgresDailyPlanRepository implements DailyPlanRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async findById(workspace: WorkspaceId, id: DailyPlan["id"]): Promise<DailyPlan | null> {
    const [plan] = await this.database
      .select()
      .from(dailyPlans)
      .where(and(eq(dailyPlans.workspaceId, workspace), eq(dailyPlans.id, id)))
      .limit(1);
    if (plan === undefined) return null;
    const items = await this.database
      .select()
      .from(dailyPlanItems)
      .where(and(eq(dailyPlanItems.workspaceId, workspace), eq(dailyPlanItems.planId, plan.id)))
      .orderBy(asc(dailyPlanItems.position));
    return mapDailyPlan(plan, items);
  }

  async findByRevision(
    workspace: WorkspaceId,
    date: ReturnType<typeof localDate>,
    requestRevision: number,
  ): Promise<DailyPlan | null> {
    const [plan] = await this.database
      .select()
      .from(dailyPlans)
      .where(
        and(
          eq(dailyPlans.workspaceId, workspace),
          eq(dailyPlans.localDate, date),
          eq(dailyPlans.requestRevision, requestRevision),
        ),
      )
      .limit(1);
    if (plan === undefined) return null;
    const items = await this.database
      .select()
      .from(dailyPlanItems)
      .where(and(eq(dailyPlanItems.workspaceId, workspace), eq(dailyPlanItems.planId, plan.id)))
      .orderBy(asc(dailyPlanItems.position));
    return mapDailyPlan(plan, items);
  }

  async insertForRevision(plan: DailyPlan): Promise<DailyPlan> {
    const existingBeforeInsert = await this.findByRevision(
      plan.workspaceId,
      plan.date,
      plan.requestRevision,
    );
    if (existingBeforeInsert !== null) return existingBeforeInsert;
    const [workspacePlanCount] = await this.database
      .select({ value: count() })
      .from(dailyPlans)
      .where(eq(dailyPlans.workspaceId, plan.workspaceId));
    if ((workspacePlanCount?.value ?? 0) >= 2_000) {
      throw new DomainError(
        "planning.workspace_plan_limit_reached",
        "A workspace cannot contain more than 2,000 daily plan revisions in local mode.",
      );
    }
    const [datePlanCount] = await this.database
      .select({ value: count() })
      .from(dailyPlans)
      .where(
        and(eq(dailyPlans.workspaceId, plan.workspaceId), eq(dailyPlans.localDate, plan.date)),
      );
    if ((datePlanCount?.value ?? 0) >= 50) {
      throw new DomainError(
        "planning.date_revision_limit_reached",
        "A local date cannot contain more than 50 plan revisions.",
      );
    }
    const [inserted] = await this.database
      .insert(dailyPlans)
      .values({
        id: plan.id,
        workspaceId: plan.workspaceId,
        localDate: plan.date,
        timeZone: plan.timeZone,
        requestRevision: plan.requestRevision,
        algorithmVersion: plan.algorithmVersion,
        configVersion: plan.configVersion,
        prngVersion: plan.prngVersion,
        seed: plan.seed,
        inputHash: plan.inputHash,
        inputSnapshot: plan.inputSnapshot as Record<string, unknown>,
        totalMinutes: plan.totalMinutes,
        fitness: plan.fitness,
        warnings: [...plan.warnings],
        exclusions: plan.exclusions.map((exclusion) => ({
          routineId: exclusion.routineId,
          title: exclusion.title,
          codes: [...exclusion.codes],
        })),
        generatedAt: plan.generatedAt,
      })
      .onConflictDoNothing({
        target: [dailyPlans.workspaceId, dailyPlans.localDate, dailyPlans.requestRevision],
      })
      .returning({ id: dailyPlans.id });

    if (inserted !== undefined) {
      if (plan.items.length > 0) {
        await this.database.insert(dailyPlanItems).values(
          plan.items.map((item) => ({
            workspaceId: plan.workspaceId,
            planId: plan.id,
            routineId: item.routineId,
            titleSnapshot: item.title,
            position: item.position,
            windowIndex: item.windowIndex,
            scheduledMinutes: item.scheduledMinutes,
            partialSession: item.partialSession,
            score: item.score,
            scoreComponents: { ...item.scoreComponents },
            reasons: [...item.reasons],
          })),
        );
      }
      return plan;
    }

    const [existing] = await this.database
      .select()
      .from(dailyPlans)
      .where(
        and(
          eq(dailyPlans.workspaceId, plan.workspaceId),
          eq(dailyPlans.localDate, plan.date),
          eq(dailyPlans.requestRevision, plan.requestRevision),
        ),
      )
      .limit(1);
    if (existing === undefined) {
      throw new DomainError(
        "planning.revision_write_conflict",
        "The daily plan revision could not be inserted or loaded.",
      );
    }
    const items = await this.database
      .select()
      .from(dailyPlanItems)
      .where(
        and(
          eq(dailyPlanItems.workspaceId, plan.workspaceId),
          eq(dailyPlanItems.planId, existing.id),
        ),
      )
      .orderBy(asc(dailyPlanItems.position));
    return mapDailyPlan(existing, items);
  }
}

function createTransactionContext(database: DatabaseExecutor): TransactionContext {
  return {
    workspaces: new PostgresWorkspaceRepository(database),
    workItems: new PostgresWorkItemRepository(database),
    scheduleBlocks: new PostgresScheduleBlockRepository(database),
    routines: new PostgresRoutineRepository(database),
    activityEvents: new PostgresActivityEventRepository(database),
    dailyPlans: new PostgresDailyPlanRepository(database),
  };
}

export class PostgresUnitOfWork implements UnitOfWork {
  constructor(private readonly connection: DatabaseConnection) {}

  async run<Result>(operation: (context: TransactionContext) => Promise<Result>): Promise<Result> {
    let retry = 0;
    while (true) {
      try {
        return await this.connection.db.transaction(
          async (transaction) => operation(createTransactionContext(transaction)),
          { isolationLevel: "serializable" },
        );
      } catch (error) {
        if (databaseErrorCode(error) !== "40001" || retry >= 2) throw error;
        retry += 1;
      }
    }
  }
}
