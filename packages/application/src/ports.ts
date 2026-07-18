import type {
  ActivityEvent,
  ActivityMetadataValue,
  DailyPlan,
  DailyPlanFitEvidencePlan,
  DailyPlanFitInsightFeedback,
  LocalDate,
  NotificationIntent,
  NotificationKind,
  NotificationProfile,
  NotificationRule,
  NotificationRuleId,
  NotificationTargetType,
  OneOffReminder,
  OneOffReminderId,
  Routine,
  RoutineDurationInsightFeedback,
  RoutineId,
  RoutinePlanningFeedback,
  RoutineSelectionPreferenceFeedback,
  RoutineStatus,
  PlanItemId,
  PlanItemActivityState,
  PlanItemActivityActionType,
  PlanMutationKind,
  ScheduleBlock,
  ScheduleBlockId,
  WorkItem,
  WorkItemDependency,
  WorkItemId,
  PlanningWorkItemDependency,
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

/** Repository-only metadata used to keep idempotent replays free of new side effects. */
export interface RecordedPlanItemActivityResult extends PlanItemActivityResult {
  readonly replayed: boolean;
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
    /** When supplied, returns direct children of this parent only. */
    parentWorkItemId?: WorkItemId,
  ): Promise<readonly WorkItem[]>;
  /** Returns only work items that may be considered by the daily planner. */
  listPlanningCandidates(workspaceId: WorkspaceId): Promise<readonly WorkItem[]>;
  insert(item: WorkItem): Promise<void>;
  save(item: WorkItem, expectedVersion: number): Promise<void>;
}

/** One transactionally consistent planner candidate/dependency projection. */
export interface PlanningWorkItemGraph {
  readonly workItems: readonly WorkItem[];
  readonly dependencies: readonly PlanningWorkItemDependency[];
}

export interface WorkItemDependencyRepository {
  /** Serializes workspace-wide work-item graph mutations and their validation reads. */
  lockWorkspace(workspaceId: WorkspaceId): Promise<void>;
  find(
    workspaceId: WorkspaceId,
    prerequisiteWorkItemId: WorkItemId,
    dependentWorkItemId: WorkItemId,
  ): Promise<WorkItemDependency | null>;
  list(
    workspaceId: WorkspaceId,
    limit: number,
    offset: number,
  ): Promise<readonly WorkItemDependency[]>;
  /** Returns a bounded planner projection including each prerequisite's current status. */
  listForPlanning(
    workspaceId: WorkspaceId,
    limit: number,
  ): Promise<readonly PlanningWorkItemDependency[]>;
  /** Loads candidate work items and their relevant dependency rows from one database snapshot. */
  loadPlanningGraph(
    workspaceId: WorkspaceId,
    workItemLimit: number,
    dependencyLimit: number,
  ): Promise<PlanningWorkItemGraph>;
  wouldCreateCycle(
    workspaceId: WorkspaceId,
    prerequisiteWorkItemId: WorkItemId,
    dependentWorkItemId: WorkItemId,
  ): Promise<boolean>;
  insert(dependency: WorkItemDependency): Promise<void>;
  delete(
    workspaceId: WorkspaceId,
    prerequisiteWorkItemId: WorkItemId,
    dependentWorkItemId: WorkItemId,
  ): Promise<boolean>;
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
  /** Serializes routine activity with policy updates and duration-insight approval or feedback. */
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

export interface NotificationRepository {
  /** Serializes policy evaluation and intent insertion for one workspace. */
  lockWorkspace(workspaceId: WorkspaceId): Promise<void>;
  findProfile(workspaceId: WorkspaceId): Promise<NotificationProfile | null>;
  insertProfile(profile: NotificationProfile): Promise<void>;
  saveProfile(profile: NotificationProfile, expectedVersion: number): Promise<void>;
  findRule(workspaceId: WorkspaceId, id: NotificationRuleId): Promise<NotificationRule | null>;
  listRules(workspaceId: WorkspaceId, limit: number): Promise<readonly NotificationRule[]>;
  insertRule(rule: NotificationRule): Promise<void>;
  saveRule(rule: NotificationRule, expectedVersion: number): Promise<void>;
  findOneOffReminder(
    workspaceId: WorkspaceId,
    id: OneOffReminderId,
  ): Promise<OneOffReminder | null>;
  listOneOffReminders(
    workspaceId: WorkspaceId,
    fromInclusive: Date,
    throughExclusive: Date,
    limit: number,
  ): Promise<readonly OneOffReminder[]>;
  insertOneOffReminder(reminder: OneOffReminder): Promise<void>;
  saveOneOffReminder(reminder: OneOffReminder, expectedVersion: number): Promise<void>;
  listDueWorkItems(
    workspaceId: WorkspaceId,
    fromInclusive: LocalDate,
    throughInclusive: LocalDate,
    limit: number,
  ): Promise<readonly WorkItem[]>;
  listIntents(
    workspaceId: WorkspaceId,
    fromInclusive: Date,
    throughExclusive: Date,
    limit: number,
    offset: number,
  ): Promise<readonly NotificationIntent[]>;
  /** Lists the safe, provider-neutral delivery projection for product history screens. */
  listDeliveryHistory(
    workspaceId: WorkspaceId,
    fromInclusive: Date,
    throughExclusive: Date,
    limit: number,
    offset: number,
  ): Promise<readonly NotificationDeliveryHistoryItem[]>;
  /** Inserts the immutable intent, or returns the existing natural-key winner. */
  insertIntent(intent: NotificationIntent): Promise<NotificationIntent>;
  /** Invalidates all not-yet-delivered intents after a workspace policy change. */
  deleteIntentsForWorkspace(workspaceId: WorkspaceId): Promise<number>;
  /** Invalidates not-yet-delivered intents after one rule changes. */
  deleteIntentsForRule(workspaceId: WorkspaceId, ruleId: NotificationRuleId): Promise<number>;
  /** Invalidates not-yet-delivered intents after one explicit reminder changes. */
  deleteIntentsForOneOff(workspaceId: WorkspaceId, reminderId: OneOffReminderId): Promise<number>;
  /** Invalidates not-yet-delivered intents after a target resource changes. */
  deleteIntentsForTarget(
    workspaceId: WorkspaceId,
    targetType: Extract<NotificationTargetType, "daily_plan" | "schedule_block" | "work_item">,
    targetId: string,
    kind?: NotificationKind,
  ): Promise<number>;
  /** Invalidates all not-yet-delivered intents for one target class. */
  deleteIntentsForTargetType(
    workspaceId: WorkspaceId,
    targetType: Extract<NotificationTargetType, "daily_plan" | "schedule_block" | "work_item">,
  ): Promise<number>;
}

/**
 * Product-safe delivery history. Claim fencing, leases, credentials, provider payloads, and
 * recipients deliberately do not cross this boundary.
 */
export interface NotificationDeliveryHistoryItem {
  readonly deliveryId: string;
  readonly intentId: string;
  readonly kind: NotificationKind;
  readonly targetType: NotificationTargetType;
  readonly title: string | null;
  readonly scheduledFor: Date;
  readonly localDate: LocalDate;
  readonly priority: number;
  readonly status: NotificationDeliveryStatus;
  readonly attempts: number;
  readonly availableAt: Date;
  readonly completedAt: Date | null;
  readonly lastFailureCode: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Immutable user dispositions for one exact, evidence-derived duration insight. */
export interface RoutineDurationInsightFeedbackRepository {
  /** Returns the latest disposition for this exact insight key. */
  findLatestForKey(
    workspaceId: WorkspaceId,
    routineId: RoutineId,
    insightKey: string,
  ): Promise<RoutineDurationInsightFeedback | null>;
  /** Looks up a workspace-scoped command receipt for exact idempotent replay. */
  findByIdempotencyKey(
    workspaceId: WorkspaceId,
    idempotencyKey: string,
  ): Promise<RoutineDurationInsightFeedback | null>;
  /** Appends an immutable disposition and returns its allocated ingestion sequence. */
  append(feedback: RoutineDurationInsightFeedback): Promise<RoutineDurationInsightFeedback>;
}

/** Immutable exact-key feedback for workspace-level Daily Plan Fit guidance. */
export interface DailyPlanFitInsightFeedbackRepository {
  /** Serializes dismiss/reset/use and forces serializable waiters to refresh a stale snapshot. */
  lockWorkspace(workspaceId: WorkspaceId): Promise<void>;
  findLatestForKey(
    workspaceId: WorkspaceId,
    insightKey: string,
  ): Promise<DailyPlanFitInsightFeedback | null>;
  findByIdempotencyKey(
    workspaceId: WorkspaceId,
    idempotencyKey: string,
  ): Promise<DailyPlanFitInsightFeedback | null>;
  /** Returns recent explicit uses in reverse ingestion order. */
  listUsed(
    workspaceId: WorkspaceId,
    limit: number,
  ): Promise<readonly DailyPlanFitInsightFeedback[]>;
  append(feedback: DailyPlanFitInsightFeedback): Promise<DailyPlanFitInsightFeedback>;
}

/**
 * Append-only routine ranking preferences. The routine-local version is a
 * separate fence so preference commands never mutate routine policy or a
 * current daily plan.
 */
export interface RoutineSelectionPreferenceFeedbackReceipt {
  readonly feedback: RoutineSelectionPreferenceFeedback;
  readonly feedbackVersion: number;
}

export interface RoutineSelectionPreferenceFeedbackState {
  readonly feedbackVersion: number;
  readonly updatedAt: Date | null;
}

export interface RoutineSelectionPreferenceFeedbackRepository {
  /** Serializes one workspace-scoped idempotency identity across routine streams. */
  lockIdempotencyKey(workspaceId: WorkspaceId, idempotencyKey: string): Promise<void>;
  findCurrentState(
    workspaceId: WorkspaceId,
    routineId: RoutineId,
  ): Promise<RoutineSelectionPreferenceFeedbackState | null>;
  findByIdempotencyKey(
    workspaceId: WorkspaceId,
    idempotencyKey: string,
  ): Promise<RoutineSelectionPreferenceFeedbackReceipt | null>;
  /** Takes the routine-local preference lock and returns its current version. */
  lockAndGetCurrentVersion(workspaceId: WorkspaceId, routineId: RoutineId): Promise<number>;
  /** Loads the bounded canonical event input for the provided planner candidates. */
  listForPlanning(
    workspaceId: WorkspaceId,
    routineIds: readonly RoutineId[],
    throughDate: LocalDate,
  ): Promise<readonly RoutineSelectionPreferenceFeedback[]>;
  /** Reconstructs the bounded stream exactly as it stood at an accepted mutation version. */
  listForPlanningThroughVersion(
    workspaceId: WorkspaceId,
    routineId: RoutineId,
    throughDate: LocalDate,
    throughFeedbackVersion: number,
  ): Promise<readonly RoutineSelectionPreferenceFeedback[]>;
  /** Appends exactly one event and advances the routine-local version atomically. */
  appendAndAdvance(
    feedback: RoutineSelectionPreferenceFeedback,
    expectedFeedbackVersion: number,
  ): Promise<RoutineSelectionPreferenceFeedbackReceipt>;
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
  /** Loads current plans for a bounded set of dates without a query per date. */
  findCurrentForDates(
    workspaceId: WorkspaceId,
    dates: readonly LocalDate[],
  ): Promise<ReadonlyMap<LocalDate, CurrentDailyPlan>>;
  /** Returns at most `candidateLimit` current-head projections in the prior local-date window. */
  listFitEvidence(
    workspaceId: WorkspaceId,
    forDate: LocalDate,
    lookbackDays: number,
    candidateLimit: number,
  ): Promise<readonly DailyPlanFitEvidencePlan[]>;
  setItemLock(input: SetPlanItemLockInput): Promise<PlanItemLockResult>;
  recordItemActivity(input: RecordPlanItemActivityInput): Promise<RecordedPlanItemActivityResult>;
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
  readonly workItemDependencies: WorkItemDependencyRepository;
  readonly scheduleBlocks: ScheduleBlockRepository;
  readonly auditEvents: AuditEventRepository;
  readonly routines: RoutineRepository;
  readonly activityEvents: ActivityEventRepository;
  readonly routineDurationInsightFeedback: RoutineDurationInsightFeedbackRepository;
  readonly dailyPlanFitInsightFeedback: DailyPlanFitInsightFeedbackRepository;
  readonly routineSelectionPreferenceFeedback: RoutineSelectionPreferenceFeedbackRepository;
  readonly dailyPlans: DailyPlanRepository;
  readonly notifications: NotificationRepository;
}

export interface UnitOfWorkOptions {
  /**
   * Serializable remains the default. Read committed is reserved for operations that wait on an
   * advisory lock and must observe commits made by the preceding lock holder afterward.
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

export const integrationCredentialScopes = [
  "schedule:read",
  "schedule:write",
  "schedule:delivery",
] as const;
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
  /** Locks the credential row until the surrounding transaction completes. */
  findByIdForUpdate(id: string): Promise<IntegrationCredential | null>;
  list(workspaceId: WorkspaceId): Promise<readonly IntegrationCredential[]>;
  insert(credential: IntegrationCredential): Promise<void>;
  save(credential: IntegrationCredential, expectedVersion: number): Promise<void>;
}

export type IntegrationCommand =
  | {
      readonly type: "work_item.create";
      readonly title: string;
      /** Undefined or null creates a top-level item. */
      readonly parentWorkItemId?: string | null;
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
      /** Undefined preserves the parent; null makes the item top-level. */
      readonly parentWorkItemId?: string | null;
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
      readonly type: "one_off_reminder.create";
      readonly title: string;
      readonly scheduledFor: string;
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
      readonly type: "one_off_reminder.created";
      readonly oneOffReminder: IntegrationOneOffReminderDto;
    }
  | {
      readonly type: "plan_item.activity_recorded";
      readonly planItemActivity: IntegrationPlanItemActivityDto;
    };

export interface IntegrationWorkItemDto {
  readonly id: string;
  readonly workspaceId: string;
  /** Omitted only when replaying a receipt written before hierarchy support. */
  readonly parentWorkItemId?: string | null;
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

export interface IntegrationOneOffReminderDto {
  readonly id: string;
  readonly workspaceId: string;
  readonly title: string;
  readonly scheduledFor: string;
  readonly cancelledAt: null;
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
  /** Version 2 adds hierarchy fields and is required for one-off reminder receipts. */
  readonly receiptVersion?: 1 | 2;
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

export type NotificationDeliveryStatus =
  "pending" | "processing" | "delivered" | "dead_letter" | "invalidated";

export type NotificationDeliveryAttemptOutcome =
  "delivered" | "retryable_failure" | "permanent_failure" | "lease_expired";

export interface ClaimedNotificationDelivery {
  readonly deliveryId: string;
  readonly intentId: string;
  readonly kind: NotificationKind;
  readonly targetType: NotificationTargetType;
  readonly title: string | null;
  readonly scheduledFor: Date;
  readonly localDate: LocalDate;
  readonly priority: number;
  readonly attempt: number;
  readonly claimToken: string;
  readonly leaseExpiresAt: Date;
}

/** JSON-safe command returned to and durably replayed for one adapter claim. */
export interface NotificationDeliveryCommandData {
  readonly deliveryId: string;
  readonly intentId: string;
  readonly dedupeKey: string;
  readonly kind: NotificationKind;
  readonly targetType: NotificationTargetType;
  readonly title: string | null;
  readonly scheduledFor: string;
  readonly localDate: string;
  readonly priority: number;
  readonly attempt: number;
  readonly claimToken: string;
  readonly leaseExpiresAt: string;
}

export interface ClaimNotificationDeliveryInput {
  readonly workspaceId: WorkspaceId;
  readonly credentialId: string;
  readonly leaseDurationMilliseconds: number;
  readonly maxAttempts: number;
}

export type NotificationDeliveryReceiptOutcome = Exclude<
  NotificationDeliveryAttemptOutcome,
  "lease_expired"
>;

export interface SettleNotificationDeliveryInput {
  readonly workspaceId: WorkspaceId;
  readonly credentialId: string;
  readonly deliveryId: string;
  readonly claimToken: string;
  readonly outcome: NotificationDeliveryReceiptOutcome;
  readonly failureCode: string | null;
  readonly retryAfterSeconds: number | null;
  readonly maxAttempts: number;
}

export interface NotificationDeliveryReceiptResult {
  readonly deliveryId: string;
  readonly status: "delivered" | "retry_scheduled" | "dead_lettered" | "invalidated";
}

export interface NotificationDeliveryRepository {
  /** PostgreSQL is the authoritative clock for cross-process lease coordination. */
  currentTime(): Promise<Date>;
  /** Claims one due command under a workspace notification lock. */
  claimNext(input: ClaimNotificationDeliveryInput): Promise<ClaimedNotificationDelivery | null>;
  /** Applies one fenced, provider-neutral outcome or rejects a stale claim token. */
  settle(input: SettleNotificationDeliveryInput): Promise<NotificationDeliveryReceiptResult>;
}

export type NotificationDeliveryRequestOperation = "claim" | "receipt";
export type NotificationDeliveryRequestResult =
  | {
      readonly operation: "claim";
      readonly command: NotificationDeliveryCommandData | null;
    }
  | {
      readonly operation: "receipt";
      readonly receipt: NotificationDeliveryReceiptResult;
    };

export interface NotificationDeliveryRequestRecord {
  readonly id: string;
  readonly credentialId: string;
  readonly workspaceId: WorkspaceId;
  readonly idempotencyKey: string;
  readonly operation: NotificationDeliveryRequestOperation;
  readonly requestHash: string;
  readonly state: "processing" | "succeeded";
  readonly result: NotificationDeliveryRequestResult | null;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
}

export interface NotificationDeliveryRequestReservationInput {
  readonly id: string;
  readonly credentialId: string;
  readonly workspaceId: WorkspaceId;
  readonly idempotencyKey: string;
  readonly operation: NotificationDeliveryRequestOperation;
  readonly requestHash: string;
  readonly createdAt: Date;
}

export interface NotificationDeliveryRequestRepository {
  reserve(input: NotificationDeliveryRequestReservationInput): Promise<{
    readonly kind: "reserved" | "replay";
    readonly request: NotificationDeliveryRequestRecord;
  }>;
  succeed(
    id: string,
    result: NotificationDeliveryRequestResult,
    completedAt: Date,
  ): Promise<NotificationDeliveryRequestRecord>;
}

/**
 * The integration transaction is intentionally separate so adding gateway persistence never
 * widens every existing application test mock. All fields share one atomic transaction.
 */
export interface IntegrationTransactionContext {
  readonly credentials: IntegrationCredentialRepository;
  readonly confirmations: IntegrationConfirmationRepository;
  readonly requests: IntegrationRequestRepository;
  readonly notificationDeliveries: NotificationDeliveryRepository;
  readonly notificationDeliveryRequests: NotificationDeliveryRequestRepository;
  readonly workspaces: WorkspaceRepository;
  readonly workItems: WorkItemRepository;
  readonly workItemDependencies: WorkItemDependencyRepository;
  readonly scheduleBlocks: ScheduleBlockRepository;
  readonly auditEvents: AuditEventRepository;
  readonly dailyPlans: DailyPlanRepository;
  readonly notifications: NotificationRepository;
}

export interface IntegrationUnitOfWork {
  run<Result>(
    operation: (context: IntegrationTransactionContext) => Promise<Result>,
    options?: UnitOfWorkOptions,
  ): Promise<Result>;
}
