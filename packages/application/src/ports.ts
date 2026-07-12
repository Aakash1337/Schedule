import type {
  ActivityEvent,
  DailyPlan,
  LocalDate,
  Routine,
  RoutineStatus,
  PlanItemId,
  ScheduleBlock,
  ScheduleBlockId,
  WorkItem,
  WorkItemId,
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

export interface WorkItemRepository {
  findById(workspaceId: WorkspaceId, id: WorkItemId): Promise<WorkItem | null>;
  insert(item: WorkItem): Promise<void>;
  save(item: WorkItem, expectedVersion: number): Promise<void>;
}

export interface ScheduleBlockRepository {
  findById(workspaceId: WorkspaceId, id: ScheduleBlockId): Promise<ScheduleBlock | null>;
  insert(block: ScheduleBlock): Promise<void>;
}

export interface WorkspaceRepository {
  findById(id: WorkspaceId): Promise<Workspace | null>;
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
}

export interface TransactionContext {
  readonly workspaces: WorkspaceRepository;
  readonly workItems: WorkItemRepository;
  readonly scheduleBlocks: ScheduleBlockRepository;
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
