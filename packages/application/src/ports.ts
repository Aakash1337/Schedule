import type {
  ActivityEvent,
  ActivityMetadataValue,
  DailyPlan,
  LocalDate,
  Routine,
  RoutineId,
  RoutinePlanningFeedback,
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
  /** Serializes routine activity writes with a duration-insight approval transaction. */
  lockRoutineActivity(workspaceId: WorkspaceId, routineId: Routine["id"]): Promise<void>;
  listForPlanning(
    workspaceId: WorkspaceId,
    throughDate: LocalDate,
  ): Promise<readonly ActivityEvent[]>;
  /**
   * Returns bounded, append-only evidence for calibrating one routine's duration.
   * The implementation must include qualifying completions in the requested window and
   * any non-future correction or reversal that references one of those completions.
   */
  listDurationEvidence(
    workspaceId: WorkspaceId,
    routineId: Routine["id"],
    fromInclusive: Date,
    throughInclusive: Date,
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
  /** Returns the latest feedback event for each routine as of the requested local date. */
  listRoutineFeedbackForPlanning(
    workspaceId: WorkspaceId,
    throughDate: LocalDate,
  ): Promise<readonly RoutinePlanningFeedback[]>;
  /** Serializes routine-global feedback changes across plans for different dates. */
  lockRoutineFeedback(workspaceId: WorkspaceId, routineId: RoutineId): Promise<void>;
  /** Returns the newest persisted feedback event regardless of its effective date. */
  findLatestRoutineFeedback(
    workspaceId: WorkspaceId,
    routineId: RoutineId,
  ): Promise<RoutinePlanningFeedback | null>;
  /** Appends immutable routine feedback and returns its allocated ingestion sequence. */
  appendRoutineFeedback(feedback: RoutinePlanningFeedback): Promise<RoutinePlanningFeedback>;
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

export interface UnitOfWorkOptions {
  /**
   * Serializable remains the default. Read committed is reserved for operations that first
   * acquire an advisory lock and must observe commits made by an earlier lock holder.
   */
  readonly isolationLevel?: "serializable" | "read_committed";
}

export interface UnitOfWork {
  run<Result>(
    operation: (context: TransactionContext) => Promise<Result>,
    options?: UnitOfWorkOptions,
  ): Promise<Result>;
}

export interface Clock {
  now(): Date;
}

export const integrationCredentialScopes = ["schedule:read", "schedule:write"] as const;
export type IntegrationCredentialScope = (typeof integrationCredentialScopes)[number];

export interface IntegrationCredential {
  readonly id: string;
  readonly workspaceId: WorkspaceId;
  readonly name: string;
  /** A one-way adapter-owned digest. Plaintext bearer secrets must never be persisted. */
  readonly secretHash: string;
  readonly scopes: readonly IntegrationCredentialScope[];
  readonly active: boolean;
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface IntegrationPrincipal {
  readonly credentialId: string;
  readonly workspaceId: WorkspaceId;
  readonly scopes: readonly IntegrationCredentialScope[];
}

export interface SecretVerifier {
  /** Implementations must compare candidate-derived and stored digests in constant time. */
  verify(secret: string, secretHash: string): Promise<boolean>;
}

export interface IntegrationCredentialRepository {
  findById(id: string): Promise<IntegrationCredential | null>;
  list(workspaceId: WorkspaceId): Promise<readonly IntegrationCredential[]>;
  insert(credential: IntegrationCredential): Promise<void>;
  save(credential: IntegrationCredential, expectedVersion: number): Promise<void>;
}

export type IntegrationCommand =
  | {
      readonly type: "work_item.create";
      readonly title: string;
      readonly description?: string | null;
      readonly status?: WorkItemStatus;
      readonly priority?: WorkItemPriority;
      readonly planningDurationMinutes?: number | null;
      /** Undefined uses no due date; null explicitly clears it. */
      readonly dueOn?: string | null;
    }
  | {
      readonly type: "work_item.update";
      readonly workItemId: string;
      readonly expectedVersion: number;
      readonly title?: string;
      readonly description?: string | null;
      readonly status?: WorkItemStatus;
      readonly priority?: WorkItemPriority;
      readonly planningDurationMinutes?: number | null;
      /** Undefined preserves the due date; null explicitly clears it. */
      readonly dueOn?: string | null;
    }
  | {
      readonly type: "schedule_block.create";
      readonly workItemId?: string | null;
      readonly title?: string | null;
      readonly startsAt: string;
      readonly endsAt: string;
      readonly timeZone: string;
    }
  | {
      readonly type: "schedule_block.update";
      readonly scheduleBlockId: string;
      readonly expectedVersion: number;
      readonly workItemId?: string | null;
      readonly title?: string | null;
      readonly startsAt?: string;
      readonly endsAt?: string;
      readonly timeZone?: string;
    }
  | {
      readonly type: "plan_item.activity";
      readonly date: string;
      readonly expectedPlanId: string;
      readonly itemId: string;
      readonly expectedHeadVersion: number;
      readonly activityType: PlanItemActivityActionType;
      readonly occurredAt: string;
      readonly timeZone: string;
      readonly durationMinutes?: number | null;
      readonly reason?: string | null;
      readonly metadata?: Readonly<Record<string, ActivityMetadataValue>>;
    };

export interface PreparedIntegrationCommand {
  readonly confirmationId: string;
  readonly requestId: string;
  readonly commandHash: string;
  /** The exact validated command persisted for this confirmation. */
  readonly command: IntegrationCommand;
  /** Canonical sorted-key JSON; unsafe controls are visibly escaped and these exact bytes are hashed. */
  readonly commandDisplay: string;
  readonly summary: string;
  readonly expiresAt: string;
}

export interface IntegrationConfirmationRecord {
  readonly id: string;
  readonly credentialId: string;
  readonly workspaceId: WorkspaceId;
  readonly requestId: string;
  readonly commandHash: string;
  readonly command: IntegrationCommand;
  readonly summary: string;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
  readonly createdAt: Date;
}

export interface IntegrationConfirmationRepository {
  findByRequestId(
    credentialId: string,
    requestId: string,
  ): Promise<IntegrationConfirmationRecord | null>;
  findByIdForUpdate(
    credentialId: string,
    confirmationId: string,
  ): Promise<IntegrationConfirmationRecord | null>;
  insertOrFind(record: IntegrationConfirmationRecord): Promise<{
    readonly kind: "inserted" | "existing";
    readonly confirmation: IntegrationConfirmationRecord;
  }>;
  /** Atomically succeeds only while the confirmation is unconsumed and unexpired. */
  consume(credentialId: string, confirmationId: string, consumedAt: Date): Promise<boolean>;
}

export type IntegrationCommandOutcome =
  | {
      readonly type: "work_item.created" | "work_item.updated";
      readonly workItem: IntegrationWorkItemDto;
    }
  | {
      readonly type: "schedule_block.created" | "schedule_block.updated";
      readonly scheduleBlock: IntegrationScheduleBlockDto;
    }
  | {
      readonly type: "plan_item.activity_recorded";
      readonly planItemActivity: IntegrationPlanItemActivityDto;
    };

export interface IntegrationWorkItemDto {
  readonly id: string;
  readonly workspaceId: string;
  readonly title: string;
  readonly description: string | null;
  readonly status: WorkItemStatus;
  readonly priority: WorkItemPriority;
  readonly planningDurationMinutes: number | null;
  /** Omitted only when replaying an unversioned receipt created before work-item deadlines. */
  readonly dueOn?: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface IntegrationScheduleBlockDto {
  readonly id: string;
  readonly workspaceId: string;
  readonly workItemId: string | null;
  readonly title: string | null;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly timeZone: string;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface IntegrationActivityEventDto {
  readonly id: string;
  readonly workspaceId: string;
  readonly sourceType: "routine" | "work_item";
  readonly routineId: string | null;
  readonly workItemId: string | null;
  readonly planId: string | null;
  readonly planItemId: string | null;
  readonly type: string;
  readonly occurredAt: string;
  readonly localDate: string;
  readonly timeZone: string;
  readonly durationMinutes: number | null;
  readonly reason: string | null;
  readonly referenceEventId: string | null;
  readonly metadata: Readonly<Record<string, ActivityMetadataValue>>;
  readonly recordedAt: string;
}

export interface IntegrationPlanItemActivityDto {
  readonly planId: string;
  readonly itemId: string;
  readonly activityState: PlanItemActivityState;
  readonly activityEvent: IntegrationActivityEventDto;
  readonly headVersion: number;
}

export interface ConfirmedIntegrationCommandResult {
  /** Present on all newly written receipts; omitted only by legacy durable replays. */
  readonly receiptVersion?: 1;
  readonly confirmationId: string;
  readonly operation: IntegrationCommand["type"];
  readonly commandHash: string;
  readonly outcome: IntegrationCommandOutcome;
}

export interface IntegrationRequestRecord {
  readonly id: string;
  readonly credentialId: string;
  readonly workspaceId: WorkspaceId;
  readonly idempotencyKey: string;
  readonly confirmationId: string;
  readonly operation: IntegrationCommand["type"];
  readonly commandHash: string;
  readonly state: "processing" | "succeeded";
  readonly result: ConfirmedIntegrationCommandResult | null;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
}

export interface IntegrationRequestReservationInput {
  readonly id: string;
  readonly credentialId: string;
  readonly workspaceId: WorkspaceId;
  readonly idempotencyKey: string;
  readonly confirmationId: string;
  readonly operation: IntegrationCommand["type"];
  readonly commandHash: string;
  readonly createdAt: Date;
}

export interface IntegrationRequestRepository {
  /**
   * Reserves an idempotency key, or returns the completed matching request. A different
   * confirmation/hash for the same key must raise `integration.receipt_conflict`.
   */
  reserve(input: IntegrationRequestReservationInput): Promise<{
    readonly kind: "reserved" | "replay";
    readonly request: IntegrationRequestRecord;
  }>;
  succeed(
    id: string,
    result: ConfirmedIntegrationCommandResult,
    completedAt: Date,
  ): Promise<IntegrationRequestRecord>;
}

/**
 * The integration transaction is intentionally separate so adding gateway persistence never
 * widens every existing application test mock. All fields share one atomic transaction.
 */
export interface IntegrationTransactionContext {
  readonly credentials: IntegrationCredentialRepository;
  readonly confirmations: IntegrationConfirmationRepository;
  readonly requests: IntegrationRequestRepository;
  readonly workspaces: WorkspaceRepository;
  readonly workItems: WorkItemRepository;
  readonly scheduleBlocks: ScheduleBlockRepository;
  readonly auditEvents: AuditEventRepository;
  readonly dailyPlans: DailyPlanRepository;
}

export interface IntegrationUnitOfWork {
  run<Result>(
    operation: (context: IntegrationTransactionContext) => Promise<Result>,
  ): Promise<Result>;
}
