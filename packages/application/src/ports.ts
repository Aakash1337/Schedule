import type {
  ActivityEvent,
  ActivityMetadataValue,
  DailyPlan,
  LocalDate,
  Routine,
  RoutineStatus,
  PlanItemId,
  PlanItemActivityState,
  PlanItemActivityActionType,
  PlanMutationKind,
  ScheduleBlock,
  ScheduleBlockId,
  WorkItem,
  WorkItemId,
  WorkItemPriority,
  WorkItemStatus,
  Workspace,
  WorkspaceId,
} from "@schedule/domain";

export interface CurrentDailyPlan {
  readonly plan: DailyPlan;
  readonly headVersion: number;
}

export interface SetPlanItemLockInput {
  readonly workspaceId: WorkspaceId;
  readonly date: LocalDate;
  readonly expectedPlanId: DailyPlan["id"];
  readonly itemId: PlanItemId;
  readonly expectedHeadVersion: number;
  readonly locked: boolean;
  readonly idempotencyKey: string;
  readonly now: Date;
}

export interface PlanItemLockResult {
  readonly planId: DailyPlan["id"];
  readonly itemId: PlanItemId;
  readonly locked: boolean;
  readonly headVersion: number;
}

export interface RecordPlanItemActivityInput {
  readonly workspaceId: WorkspaceId;
  readonly date: LocalDate;
  readonly expectedPlanId: DailyPlan["id"];
  readonly itemId: PlanItemId;
  readonly expectedHeadVersion: number;
  readonly type: PlanItemActivityActionType;
  readonly occurredAt: Date;
  readonly timeZone: string;
  readonly durationMinutes: number | null;
  readonly reason: string | null;
  readonly metadata: Readonly<Record<string, ActivityMetadataValue>>;
  readonly idempotencyKey: string;
  readonly now: Date;
}

export interface PlanItemActivityResult {
  readonly planId: DailyPlan["id"];
  readonly itemId: PlanItemId;
  readonly activityState: PlanItemActivityState;
  readonly activityEvent: ActivityEvent;
  readonly headVersion: number;
}

export interface PlanMutationRecord {
  readonly workspaceId: WorkspaceId;
  readonly date: LocalDate;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
  readonly kind: PlanMutationKind;
  readonly sourcePlanId: DailyPlan["id"];
  readonly resultPlanId: DailyPlan["id"];
  readonly resultHeadVersion: number;
  readonly createdAt: Date;
}

export interface WorkItemRepository {
  findById(workspaceId: WorkspaceId, id: WorkItemId): Promise<WorkItem | null>;
  list(
    workspaceId: WorkspaceId,
    status: WorkItemStatus | undefined,
    priority: WorkItemPriority | undefined,
    limit: number,
    offset: number,
  ): Promise<readonly WorkItem[]>;
  /** Returns only work items that may be considered by the daily planner. */
  listPlanningCandidates(workspaceId: WorkspaceId): Promise<readonly WorkItem[]>;
  insert(item: WorkItem): Promise<void>;
  save(item: WorkItem, expectedVersion: number): Promise<void>;
}

export interface ScheduleBlockRepository {
  findById(workspaceId: WorkspaceId, id: ScheduleBlockId): Promise<ScheduleBlock | null>;
  listOverlapping(
    workspaceId: WorkspaceId,
    from: Date,
    to: Date,
    limit: number,
    offset: number,
  ): Promise<readonly ScheduleBlock[]>;
  insert(block: ScheduleBlock): Promise<void>;
  save(block: ScheduleBlock, expectedVersion: number): Promise<void>;
  delete(block: ScheduleBlock, expectedVersion: number): Promise<void>;
}

export interface AuditEventRecord {
  readonly workspaceId: WorkspaceId;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly occurredAt: Date;
}

export interface AuditEventRepository {
  append(event: AuditEventRecord): Promise<void>;
}

export interface WorkspaceRepository {
  findById(id: WorkspaceId): Promise<Workspace | null>;
  list(limit: number, offset: number): Promise<readonly Workspace[]>;
  insert(workspace: Workspace): Promise<void>;
}

export interface RoutineRepository {
  findById(workspaceId: WorkspaceId, id: Routine["id"]): Promise<Routine | null>;
  list(
    workspaceId: WorkspaceId,
    status: RoutineStatus | undefined,
    limit: number,
    offset: number,
  ): Promise<readonly Routine[]>;
  listPlanningCandidates(workspaceId: WorkspaceId, date: LocalDate): Promise<readonly Routine[]>;
  insert(routine: Routine): Promise<void>;
  save(routine: Routine, expectedVersion: number): Promise<void>;
}

export interface ActivityHistoryCursor {
  readonly watermark: number;
  readonly before: number;
}

export interface ActivityHistoryPage {
  readonly items: readonly ActivityEvent[];
  readonly nextCursor: ActivityHistoryCursor | null;
}

export interface ActivityEventRepository {
  findById(workspaceId: WorkspaceId, id: ActivityEvent["id"]): Promise<ActivityEvent | null>;
  listForPlanning(
    workspaceId: WorkspaceId,
    throughDate: LocalDate,
  ): Promise<readonly ActivityEvent[]>;
  append(event: ActivityEvent): Promise<ActivityEvent>;
  listHistory(
    workspaceId: WorkspaceId,
    routineId: Routine["id"],
    limit: number,
    cursor?: ActivityHistoryCursor,
  ): Promise<ActivityHistoryPage>;
}

export interface DailyPlanRepository {
  findById(workspaceId: WorkspaceId, id: DailyPlan["id"]): Promise<DailyPlan | null>;
  findByRevision(
    workspaceId: WorkspaceId,
    date: LocalDate,
    requestRevision: number,
  ): Promise<DailyPlan | null>;
  /** Atomically inserts the revision or returns the plan already stored for that revision. */
  insertForRevision(plan: DailyPlan): Promise<DailyPlan>;
  findCurrent(workspaceId: WorkspaceId, date: LocalDate): Promise<CurrentDailyPlan | null>;
  setItemLock(input: SetPlanItemLockInput): Promise<PlanItemLockResult>;
  recordItemActivity(input: RecordPlanItemActivityInput): Promise<PlanItemActivityResult>;
  lockDay(workspaceId: WorkspaceId, date: LocalDate): Promise<void>;
  findMutation(
    workspaceId: WorkspaceId,
    date: LocalDate,
    idempotencyKey: string,
  ): Promise<PlanMutationRecord | null>;
  insertMutation(record: PlanMutationRecord): Promise<void>;
}

export interface TransactionContext {
  readonly workspaces: WorkspaceRepository;
  readonly workItems: WorkItemRepository;
  readonly scheduleBlocks: ScheduleBlockRepository;
  readonly auditEvents: AuditEventRepository;
  readonly routines: RoutineRepository;
  readonly activityEvents: ActivityEventRepository;
  readonly dailyPlans: DailyPlanRepository;
}

export interface UnitOfWork {
  run<Result>(operation: (context: TransactionContext) => Promise<Result>): Promise<Result>;
}

export interface Clock {
  now(): Date;
}
