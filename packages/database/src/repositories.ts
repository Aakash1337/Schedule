import { createHash, randomUUID } from "node:crypto";

import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  getTableColumns,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  notExists,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type {
  ActivityHistoryCursor,
  ActivityHistoryPage,
  ActivityEventRepository,
  AuditEventRecord,
  AuditEventRepository,
  ClaimedNotificationDelivery,
  ClaimNotificationDeliveryInput,
  CurrentDailyPlan,
  DailyPlanFitInsightFeedbackRepository,
  DailyPlanRepository,
  ConfirmedIntegrationCommandResult,
  IntegrationCommand,
  IntegrationConfirmationRecord,
  IntegrationConfirmationRepository,
  IntegrationCredential,
  IntegrationCredentialRepository,
  IntegrationCredentialScope,
  IntegrationRequestRecord,
  IntegrationRequestRepository,
  IntegrationRequestReservationInput,
  IntegrationTransactionContext,
  IntegrationUnitOfWork,
  HostedMutationAuthorizationDecision,
  HostedMutationAuthorizationRepository,
  HostedMutationTransactionContext,
  HostedMutationUnitOfWork,
  HostedWorkspaceAuthorization,
  NaturalLanguageProposalModelSuggestions,
  NaturalLanguageProposalRecord,
  NaturalLanguageProposalRepository,
  NaturalLanguageProposalTransactionContext,
  NaturalLanguageProposalUnitOfWork,
  NotificationRepository,
  NotificationDeliveryRepository,
  NotificationDeliveryHistoryItem,
  NotificationDeliveryRedriveResult,
  NotificationDeliveryReceiptResult,
  NotificationDeliveryStatus,
  NotificationDeliveryRequestRecord,
  NotificationDeliveryRequestRepository,
  NotificationDeliveryRequestReservationInput,
  NotificationDeliveryRequestResult,
  SettleNotificationDeliveryInput,
  PlanItemLockResult,
  RecordedPlanItemActivityResult,
  PlanMutationRecord,
  PlanningWorkItemGraph,
  RecordPlanItemActivityInput,
  RoutineDurationInsightFeedbackRepository,
  RoutineSelectionPreferenceFeedbackRepository,
  RoutineRepository,
  ScheduleBlockRepository,
  SetPlanItemLockInput,
  TransactionContext,
  UnitOfWork,
  UnitOfWorkOptions,
  WorkItemDependencyRepository,
  WorkItemRepository,
  WorkspaceRepository,
} from "@schedule/application";
import {
  maximumDailyPlanFitUsageOutcomes,
  naturalLanguageProposalCommandDisplay,
  normalizeNaturalLanguageProposalCommand,
} from "@schedule/application";
import {
  DomainError,
  activityEventId,
  addLocalDays,
  createCadencePolicy,
  createDurationRange,
  createRoutine,
  createStructuredTags,
  createWorkItemDependency,
  dailyPlanId,
  dailyPlanFitInsightMaximumItemsPerPlan,
  dailyPlanFitInsightFeedbackId,
  localDate,
  notificationIntentId,
  notificationRuleId,
  oneOffReminderId,
  planItemId,
  planItemActivityStates,
  isPlanItemActivityActionType,
  recordActivityEvent,
  reversePlanItemCompletion,
  routineId,
  routineDurationInsightFeedbackId,
  routinePlanningFeedbackId,
  routineSelectionPreferenceFeedbackId,
  ROUTINE_SELECTION_PREFERENCE_EVENT_LIMIT,
  ROUTINE_SELECTION_PREFERENCE_LOOKBACK_DAYS,
  scheduleBlockId,
  transitionPlanItemActivity,
  workItemId,
  workItemPriorities,
  workItemStatuses,
  workspaceId,
  type ActivityEvent,
  type DailyPlan,
  type DailyPlanFitEvidencePlan,
  type DailyPlanFitInsightFeedback,
  type JsonValue,
  type LocalDate,
  type LocalTimeResolution,
  type NotificationIntent,
  type NotificationKind,
  type NotificationPolicySnapshot,
  type NotificationProfile,
  type NotificationRule,
  type NotificationRuleKind,
  type NotificationTargetType,
  type OneOffReminder,
  type QuietHoursPolicy,
  type PlanExclusion,
  type PlanItem,
  type PlanWarning,
  type PlanningWorkItemDependency,
  type Routine,
  type RoutineId,
  type RoutineDurationInsightFeedback,
  type RoutinePlanningFeedback,
  type RoutineSelectionPreferenceFeedback,
  type RoutineStatus,
  type ScheduleBlock,
  type ScheduleBlockId,
  type WorkItem,
  type WorkItemDependency,
  type WorkItemId,
  type WorkItemPriority,
  type WorkItemStatus,
  type WorkspaceId,
  type Workspace,
} from "@schedule/domain";

import type { DatabaseConnection } from "./database.js";
import { databaseErrorCode, databaseErrorConstraint } from "./database-errors.js";
import {
  activityEvents,
  auditEvents,
  browserSessions,
  dailyPlanFitInsightFeedbackEvents,
  dailyPlanHeads,
  dailyPlanItemStates,
  dailyPlanItems,
  dailyPlans,
  integrationConfirmations,
  integrationCredentials,
  integrationRequests,
  hostedUsers,
  notificationDeliveryAttempts,
  notificationDeliveryCommands,
  notificationDeliveryRequests,
  notificationIntents,
  notificationProfiles,
  notificationRules,
  naturalLanguageProposals,
  oneOffReminders,
  planInteractionEvents,
  planMutations,
  routineDurationInsightFeedbackEvents,
  routinePlanningFeedbackEvents,
  routineSelectionPreferenceFeedbackEvents,
  routines,
  scheduleBlocks,
  workItemDependencies,
  workItems,
  workspaces,
  workspaceMemberships,
} from "./schema.js";

type TransactionCallback = Parameters<DatabaseConnection["db"]["transaction"]>[0];
type DatabaseTransaction = Parameters<TransactionCallback>[0];
type DatabaseExecutor = DatabaseConnection["db"] | DatabaseTransaction;

type WorkItemRow = typeof workItems.$inferSelect;
type WorkItemDependencyRow = typeof workItemDependencies.$inferSelect;
type WorkspaceRow = typeof workspaces.$inferSelect;
type ScheduleBlockRow = typeof scheduleBlocks.$inferSelect;
type RoutineRow = typeof routines.$inferSelect;
type ActivityEventRow = typeof activityEvents.$inferSelect;
type RoutineDurationInsightFeedbackEventRow =
  typeof routineDurationInsightFeedbackEvents.$inferSelect;
type DailyPlanFitInsightFeedbackEventRow = typeof dailyPlanFitInsightFeedbackEvents.$inferSelect;
type RoutinePlanningFeedbackEventRow = typeof routinePlanningFeedbackEvents.$inferSelect;
type RoutineSelectionPreferenceFeedbackEventRow =
  typeof routineSelectionPreferenceFeedbackEvents.$inferSelect;
type DailyPlanRow = typeof dailyPlans.$inferSelect;
type DailyPlanItemRow = typeof dailyPlanItems.$inferSelect;
type DailyPlanItemStateRow = typeof dailyPlanItemStates.$inferSelect;
type IntegrationCredentialRow = typeof integrationCredentials.$inferSelect;
type IntegrationConfirmationRow = typeof integrationConfirmations.$inferSelect;
type IntegrationRequestRow = typeof integrationRequests.$inferSelect;
type NaturalLanguageProposalRow = typeof naturalLanguageProposals.$inferSelect;
type NotificationDeliveryRequestRow = typeof notificationDeliveryRequests.$inferSelect;
type NotificationProfileRow = typeof notificationProfiles.$inferSelect;
type NotificationRuleRow = typeof notificationRules.$inferSelect;
type OneOffReminderRow = typeof oneOffReminders.$inferSelect;
type NotificationIntentRow = typeof notificationIntents.$inferSelect;
type NotificationDeliveryCommandRow = typeof notificationDeliveryCommands.$inferSelect;

interface PlanningGraphDatabaseRow {
  readonly rowGroup: number;
  readonly rowPosition: number;
  readonly rowKind: string;
  readonly payload: unknown;
}

interface DailyPlanFitEvidenceDatabaseRow {
  readonly planId: string;
  readonly localDate: string;
  readonly targetMinutes: unknown;
  readonly targetTaskCount: unknown;
  readonly itemId: string | null;
  readonly scheduledMinutes: number | null;
  readonly activityState: string | null;
  readonly lastActivityEventId: string | null;
}

const dependentWorkItems = alias(workItems, "dependent_work_items");

function mapWorkspace(row: WorkspaceRow): Workspace {
  return {
    id: workspaceId(row.id),
    name: row.name,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

function mapNotificationProfile(row: NotificationProfileRow): NotificationProfile {
  return {
    workspaceId: workspaceId(row.workspaceId),
    enabled: row.enabled,
    timeZone: row.timeZone,
    quietHoursStartMinute: row.quietHoursStartMinute,
    quietHoursEndMinute: row.quietHoursEndMinute,
    quietHoursPolicy: row.quietHoursPolicy as QuietHoursPolicy,
    catchUpWindowMinutes: row.catchUpWindowMinutes,
    dailyIntentLimit: row.dailyIntentLimit,
    version: row.version,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

function mapNotificationRule(row: NotificationRuleRow): NotificationRule {
  return {
    id: notificationRuleId(row.id),
    workspaceId: workspaceId(row.workspaceId),
    kind: row.kind as NotificationRuleKind,
    enabled: row.enabled,
    localMinute: row.localMinute,
    leadMinutes: row.leadMinutes,
    cooldownMinutes: row.cooldownMinutes,
    priority: row.priority,
    version: row.version,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

function mapOneOffReminder(row: OneOffReminderRow): OneOffReminder {
  return {
    id: oneOffReminderId(row.id),
    workspaceId: workspaceId(row.workspaceId),
    title: row.title,
    scheduledFor: new Date(row.scheduledFor),
    cancelledAt: row.cancelledAt === null ? null : new Date(row.cancelledAt),
    version: row.version,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

function mapNotificationIntent(row: NotificationIntentRow): NotificationIntent {
  const targetId =
    row.targetType === "daily_plan"
      ? row.dailyPlanId
      : row.targetType === "schedule_block"
        ? row.scheduleBlockId
        : row.targetType === "work_item"
          ? row.workItemId
          : null;
  return {
    id: notificationIntentId(row.id),
    workspaceId: workspaceId(row.workspaceId),
    ruleId: row.ruleId === null ? null : notificationRuleId(row.ruleId),
    oneOffReminderId: row.oneOffReminderId === null ? null : oneOffReminderId(row.oneOffReminderId),
    kind: row.kind as NotificationKind,
    occurrenceKey: row.occurrenceKey,
    targetType: row.targetType as NotificationTargetType,
    targetId,
    titleSnapshot: row.titleSnapshot,
    scheduledFor: new Date(row.scheduledFor),
    localDate: localDate(row.localDate),
    priority: row.priority,
    policySnapshot: row.policySnapshot as NotificationPolicySnapshot,
    localTimeResolution: row.localTimeResolution as LocalTimeResolution,
    adjustedForQuietHours: row.adjustedForQuietHours,
    caughtUp: row.caughtUp,
    createdAt: new Date(row.createdAt),
  };
}

function mapNotificationDeliveryHistory(
  row: NotificationDeliveryCommandRow,
): NotificationDeliveryHistoryItem {
  return {
    deliveryId: row.id,
    intentId: row.intentId,
    kind: row.kind as NotificationKind,
    targetType: row.targetType as NotificationTargetType,
    title: row.titleSnapshot,
    scheduledFor: new Date(row.scheduledFor),
    localDate: localDate(row.localDate),
    priority: row.priority,
    status: row.status,
    attempts: row.attempts,
    availableAt: new Date(row.availableAt),
    completedAt: row.completedAt === null ? null : new Date(row.completedAt),
    lastFailureCode: row.lastFailureCode,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

function mapIntegrationCredential(row: IntegrationCredentialRow): IntegrationCredential {
  return {
    id: row.id,
    workspaceId: workspaceId(row.workspaceId),
    name: row.name,
    secretHash: row.secretDigest,
    scopes: row.scopes as IntegrationCredentialScope[],
    active: row.active,
    expiresAt: row.expiresAt === null ? null : new Date(row.expiresAt),
    revokedAt: row.revokedAt === null ? null : new Date(row.revokedAt),
    version: row.version,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

function mapIntegrationConfirmation(
  row: IntegrationConfirmationRow,
): IntegrationConfirmationRecord {
  const command = row.command;
  if (
    command === null ||
    typeof command !== "object" ||
    Array.isArray(command) ||
    typeof command.type !== "string" ||
    command.type !== row.commandKind
  ) {
    throw new DomainError(
      "integration.confirmation_corrupt",
      "The stored integration confirmation command is inconsistent.",
    );
  }
  return {
    id: row.id,
    credentialId: row.credentialId,
    workspaceId: workspaceId(row.workspaceId),
    requestId: row.requestId,
    commandHash: row.commandHash,
    command: command as unknown as IntegrationCommand,
    summary: row.summary,
    expiresAt: new Date(row.expiresAt),
    consumedAt: row.consumedAt === null ? null : new Date(row.consumedAt),
    createdAt: new Date(row.createdAt),
  };
}

function mapIntegrationRequest(row: IntegrationRequestRow): IntegrationRequestRecord {
  const result = row.result;
  if (
    result !== null &&
    (typeof result.confirmationId !== "string" ||
      result.confirmationId !== row.confirmationId ||
      typeof result.operation !== "string" ||
      result.operation !== row.operation ||
      typeof result.commandHash !== "string" ||
      result.commandHash !== row.commandHash)
  ) {
    throw new DomainError(
      "integration.receipt_corrupt",
      "The stored integration result is inconsistent with its request receipt.",
    );
  }
  return {
    id: row.id,
    credentialId: row.credentialId,
    workspaceId: workspaceId(row.workspaceId),
    idempotencyKey: row.idempotencyKey,
    confirmationId: row.confirmationId,
    operation: row.operation as IntegrationCommand["type"],
    commandHash: row.commandHash,
    state: row.status,
    result: result as unknown as ConfirmedIntegrationCommandResult | null,
    createdAt: new Date(row.createdAt),
    completedAt: row.completedAt === null ? null : new Date(row.completedAt),
  };
}

function mapNaturalLanguageProposal(
  row: NaturalLanguageProposalRow,
): NaturalLanguageProposalRecord {
  let typedCommand;
  try {
    typedCommand = normalizeNaturalLanguageProposalCommand(
      row.command,
      workspaceId(row.workspaceId),
      new Date(row.createdAt),
    );
  } catch {
    throw new DomainError(
      "natural_language.confirmation_corrupt",
      "The stored natural-language proposal command is invalid.",
    );
  }
  const canonicalCommand = naturalLanguageProposalCommandDisplay(typedCommand);
  const commandHash = createHash("sha256").update(canonicalCommand, "utf8").digest("hex");
  if (canonicalCommand !== row.commandDisplay || commandHash !== row.commandHash) {
    throw new DomainError(
      "natural_language.confirmation_corrupt",
      "The stored natural-language proposal command does not match its digest.",
    );
  }
  if (
    !workItemPriorities.some((priority) => priority === row.reviewPriority) ||
    (row.reviewPlanningDurationMinutes !== null &&
      (!Number.isInteger(row.reviewPlanningDurationMinutes) ||
        row.reviewPlanningDurationMinutes < 1 ||
        row.reviewPlanningDurationMinutes > 43_200))
  ) {
    throw new DomainError(
      "natural_language.confirmation_corrupt",
      "The stored natural-language proposal review fields are invalid.",
    );
  }
  let reviewDueOn: LocalDate | null;
  try {
    reviewDueOn = row.reviewDueOn === null ? null : localDate(row.reviewDueOn);
  } catch {
    throw new DomainError(
      "natural_language.confirmation_corrupt",
      "The stored natural-language proposal review fields are invalid.",
    );
  }
  const userSelection =
    typedCommand.type === "routine.create"
      ? null
      : {
          priority: row.reviewPriority,
          dueOn: reviewDueOn,
          planningDurationMinutes: row.reviewPlanningDurationMinutes,
        };
  if (
    typedCommand.type === "routine.create" &&
    (row.reviewPriority !== "none" ||
      row.reviewDueOn !== null ||
      row.reviewPlanningDurationMinutes !== null)
  ) {
    throw new DomainError(
      "natural_language.confirmation_corrupt",
      "The stored natural-language routine proposal review fields are invalid.",
    );
  }
  const reviewDisplay =
    userSelection === null
      ? "null"
      : `{"dueOn":${JSON.stringify(userSelection.dueOn)},"planningDurationMinutes":${JSON.stringify(userSelection.planningDurationMinutes)},"priority":${JSON.stringify(userSelection.priority)}}`;
  const reviewHash = createHash("sha256").update(reviewDisplay, "utf8").digest("hex");
  if (reviewHash !== row.reviewHash) {
    throw new DomainError(
      "natural_language.confirmation_corrupt",
      "The stored natural-language proposal review fields do not match their digest.",
    );
  }
  const modelSuggestions = mapNaturalLanguageProposalModelSuggestions(row.modelSuggestions);
  const modelSuggestionsDisplay =
    modelSuggestions === null
      ? "null"
      : `{"dueOn":${JSON.stringify(modelSuggestions.dueOn)},"planningDurationMinutes":${JSON.stringify(modelSuggestions.planningDurationMinutes)},"priority":${JSON.stringify(modelSuggestions.priority)}}`;
  const modelSuggestionsHash = createHash("sha256")
    .update(modelSuggestionsDisplay, "utf8")
    .digest("hex");
  if (modelSuggestionsHash !== row.modelSuggestionsHash) {
    throw new DomainError(
      "natural_language.confirmation_corrupt",
      "The stored natural-language proposal model suggestions do not match their digest.",
    );
  }
  const resultWorkItemId = row.resultWorkItemId === null ? null : workItemId(row.resultWorkItemId);
  const resultScheduleBlockId =
    row.resultScheduleBlockId === null ? null : scheduleBlockId(row.resultScheduleBlockId);
  const resultRoutineId = row.resultRoutineId === null ? null : routineId(row.resultRoutineId);
  const allResultsNull =
    resultWorkItemId === null && resultScheduleBlockId === null && resultRoutineId === null;
  const confirmedResultMatchesCommand =
    (typedCommand.type === "work_item.create" &&
      resultWorkItemId !== null &&
      resultScheduleBlockId === null &&
      resultRoutineId === null) ||
    (typedCommand.type === "schedule_block.create" &&
      resultWorkItemId === null &&
      resultScheduleBlockId !== null &&
      resultRoutineId === null) ||
    ((typedCommand.type as string) === "routine.create" &&
      resultWorkItemId === null &&
      resultScheduleBlockId === null &&
      resultRoutineId !== null);
  if (!(
    (row.status === "pending" &&
      row.confirmationKeyHash === null &&
      allResultsNull &&
      row.confirmedAt === null &&
      row.cancelledAt === null) ||
    (row.status === "confirmed" &&
      row.confirmationKeyHash !== null &&
      confirmedResultMatchesCommand &&
      row.confirmedAt !== null &&
      row.cancelledAt === null) ||
    (row.status === "cancelled" &&
      row.confirmationKeyHash === null &&
      allResultsNull &&
      row.confirmedAt === null &&
      row.cancelledAt !== null)
  )) {
    throw new DomainError(
      "natural_language.confirmation_corrupt",
      "The stored natural-language proposal result does not match its command lifecycle.",
    );
  }
  return {
    id: row.id,
    workspaceId: workspaceId(row.workspaceId),
    requestId: row.requestId,
    promptHash: row.promptHash,
    commandHash: row.commandHash,
    reviewHash: row.reviewHash,
    modelSuggestionsHash: row.modelSuggestionsHash,
    commandDisplay: row.commandDisplay,
    command: typedCommand,
    modelSuggestions,
    userSelection,
    provider: row.provider,
    model: row.model,
    status: row.status,
    expiresAt: new Date(row.expiresAt),
    confirmationKeyHash: row.confirmationKeyHash,
    resultWorkItemId,
    resultScheduleBlockId,
    resultRoutineId,
    confirmedAt: row.confirmedAt === null ? null : new Date(row.confirmedAt),
    cancelledAt: row.cancelledAt === null ? null : new Date(row.cancelledAt),
    version: row.version,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

function mapNaturalLanguageProposalModelSuggestions(
  value: unknown,
): NaturalLanguageProposalModelSuggestions | null {
  if (value === null) return null;
  if (
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join("\0") !== "dueOn\0planningDurationMinutes\0priority"
  ) {
    throw new DomainError(
      "natural_language.confirmation_corrupt",
      "The stored natural-language proposal model suggestions are invalid.",
    );
  }
  const suggestions = value as Readonly<Record<string, unknown>>;
  if (
    !(
      suggestions.priority === null ||
      suggestions.priority === "low" ||
      suggestions.priority === "medium" ||
      suggestions.priority === "high" ||
      suggestions.priority === "urgent"
    ) ||
    !(
      suggestions.planningDurationMinutes === null ||
      (typeof suggestions.planningDurationMinutes === "number" &&
        Number.isInteger(suggestions.planningDurationMinutes) &&
        suggestions.planningDurationMinutes >= 1 &&
        suggestions.planningDurationMinutes <= 43_200)
    ) ||
    !(suggestions.dueOn === null || typeof suggestions.dueOn === "string")
  ) {
    throw new DomainError(
      "natural_language.confirmation_corrupt",
      "The stored natural-language proposal model suggestions are invalid.",
    );
  }
  let dueOn: LocalDate | null;
  try {
    dueOn = suggestions.dueOn === null ? null : localDate(suggestions.dueOn as string);
  } catch {
    throw new DomainError(
      "natural_language.confirmation_corrupt",
      "The stored natural-language proposal model suggestions are invalid.",
    );
  }
  if (
    suggestions.priority === null &&
    dueOn === null &&
    suggestions.planningDurationMinutes === null
  ) {
    throw new DomainError(
      "natural_language.confirmation_corrupt",
      "The stored natural-language proposal model suggestions must contain a value.",
    );
  }
  return {
    priority: suggestions.priority as NaturalLanguageProposalModelSuggestions["priority"],
    dueOn,
    planningDurationMinutes:
      suggestions.planningDurationMinutes as NaturalLanguageProposalModelSuggestions["planningDurationMinutes"],
  };
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const notificationKinds = new Set<NotificationKind>([
  "daily_digest",
  "daily_follow_up",
  "plan_window_open",
  "schedule_block_lead",
  "work_item_due",
  "one_off",
]);
const notificationTargetTypes = new Set<NotificationTargetType>([
  "workspace",
  "daily_plan",
  "schedule_block",
  "work_item",
  "one_off",
]);

function corruptNotificationDeliveryRequest(): never {
  throw new DomainError(
    "notification_delivery.request_corrupt",
    "The stored notification delivery request result is invalid.",
  );
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function mapNotificationDeliveryRequest(
  row: NotificationDeliveryRequestRow,
): NotificationDeliveryRequestRecord {
  const raw = row.result as Readonly<Record<string, unknown>> | null;
  let result: NotificationDeliveryRequestResult | null = null;
  if (raw !== null) {
    if (raw.operation !== row.operation) return corruptNotificationDeliveryRequest();
    if (row.operation === "claim") {
      if (!hasExactKeys(raw, ["operation", "command"])) {
        return corruptNotificationDeliveryRequest();
      }
      const command = raw.command;
      if (command !== null) {
        if (command === undefined || typeof command !== "object" || Array.isArray(command)) {
          return corruptNotificationDeliveryRequest();
        }
        const value = command as Readonly<Record<string, unknown>>;
        if (
          !hasExactKeys(value, [
            "deliveryId",
            "intentId",
            "dedupeKey",
            "kind",
            "targetType",
            "title",
            "scheduledFor",
            "localDate",
            "priority",
            "attempt",
            "claimToken",
            "leaseExpiresAt",
          ])
        ) {
          return corruptNotificationDeliveryRequest();
        }
        const scheduledFor =
          typeof value.scheduledFor === "string" ? new Date(value.scheduledFor) : null;
        const leaseExpiresAt =
          typeof value.leaseExpiresAt === "string" ? new Date(value.leaseExpiresAt) : null;
        if (
          typeof value.deliveryId !== "string" ||
          !uuidPattern.test(value.deliveryId) ||
          value.intentId !== value.deliveryId ||
          value.dedupeKey !== value.deliveryId ||
          typeof value.kind !== "string" ||
          !notificationKinds.has(value.kind as NotificationKind) ||
          typeof value.targetType !== "string" ||
          !notificationTargetTypes.has(value.targetType as NotificationTargetType) ||
          (value.title !== null && (typeof value.title !== "string" || value.title.length > 240)) ||
          scheduledFor === null ||
          !Number.isFinite(scheduledFor.getTime()) ||
          typeof value.localDate !== "string" ||
          !/^\d{4}-\d{2}-\d{2}$/.test(value.localDate) ||
          !Number.isInteger(value.priority) ||
          (value.priority as number) < 0 ||
          (value.priority as number) > 100 ||
          !Number.isInteger(value.attempt) ||
          (value.attempt as number) < 1 ||
          typeof value.claimToken !== "string" ||
          !uuidPattern.test(value.claimToken) ||
          leaseExpiresAt === null ||
          !Number.isFinite(leaseExpiresAt.getTime())
        ) {
          return corruptNotificationDeliveryRequest();
        }
      }
      result = raw as unknown as NotificationDeliveryRequestResult;
    } else {
      if (!hasExactKeys(raw, ["operation", "receipt"])) {
        return corruptNotificationDeliveryRequest();
      }
      const receipt = raw.receipt;
      if (receipt === null || typeof receipt !== "object" || Array.isArray(receipt)) {
        return corruptNotificationDeliveryRequest();
      }
      const value = receipt as Readonly<Record<string, unknown>>;
      if (!hasExactKeys(value, ["deliveryId", "status"])) {
        return corruptNotificationDeliveryRequest();
      }
      if (
        typeof value.deliveryId !== "string" ||
        !uuidPattern.test(value.deliveryId) ||
        (value.status !== "delivered" &&
          value.status !== "retry_scheduled" &&
          value.status !== "dead_lettered" &&
          value.status !== "invalidated")
      ) {
        return corruptNotificationDeliveryRequest();
      }
      result = raw as unknown as NotificationDeliveryRequestResult;
    }
  }
  return {
    id: row.id,
    credentialId: row.credentialId,
    workspaceId: workspaceId(row.workspaceId),
    idempotencyKey: row.idempotencyKey,
    operation: row.operation,
    requestHash: row.requestHash,
    state: row.status,
    result,
    createdAt: new Date(row.createdAt),
    completedAt: row.completedAt === null ? null : new Date(row.completedAt),
  };
}

function mapWorkItem(row: WorkItemRow): WorkItem {
  return {
    id: workItemId(row.id),
    workspaceId: workspaceId(row.workspaceId),
    parentWorkItemId: row.parentWorkItemId === null ? null : workItemId(row.parentWorkItemId),
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    planningDurationMinutes: row.planningDurationMinutes,
    dueOn: row.dueOn === null ? null : localDate(row.dueOn),
    version: row.version,
    createdAt: new Date(row.createdAt),
    updatedAt: new Date(row.updatedAt),
  };
}

function mapWorkItemDependency(row: WorkItemDependencyRow): WorkItemDependency {
  return createWorkItemDependency({
    workspaceId: workspaceId(row.workspaceId),
    prerequisiteWorkItemId: workItemId(row.prerequisiteWorkItemId),
    dependentWorkItemId: workItemId(row.dependentWorkItemId),
    createdAt: new Date(row.createdAt),
  });
}

function planningGraphCorrupt(): never {
  throw new DomainError(
    "planning.work_item_graph_corrupt",
    "The stored work-item planning graph could not be decoded safely.",
  );
}

function recordValue(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return planningGraphCorrupt();
  }
  return value as Readonly<Record<string, unknown>>;
}

function validTimestamp(value: unknown): Date {
  if (typeof value !== "string") return planningGraphCorrupt();
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime())) return planningGraphCorrupt();
  return timestamp;
}

function mapPlanningGraphWorkItem(payload: unknown): WorkItem {
  const value = recordValue(payload);
  if (
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    typeof value.workspaceId !== "string" ||
    value.workspaceId.length === 0 ||
    !(value.parentWorkItemId === null || typeof value.parentWorkItemId === "string") ||
    typeof value.title !== "string" ||
    !(value.description === null || typeof value.description === "string") ||
    !workItemStatuses.some((status) => status === value.status) ||
    !workItemPriorities.some((priority) => priority === value.priority) ||
    !Number.isSafeInteger(value.planningDurationMinutes) ||
    (value.planningDurationMinutes as number) <= 0 ||
    !(value.dueOn === null || typeof value.dueOn === "string") ||
    !Number.isSafeInteger(value.version) ||
    (value.version as number) <= 0
  ) {
    return planningGraphCorrupt();
  }
  return {
    id: workItemId(value.id),
    workspaceId: workspaceId(value.workspaceId),
    parentWorkItemId:
      value.parentWorkItemId === null ? null : workItemId(value.parentWorkItemId as string),
    title: value.title,
    description: value.description,
    status: value.status as WorkItemStatus,
    priority: value.priority as WorkItemPriority,
    planningDurationMinutes: value.planningDurationMinutes as number,
    dueOn: value.dueOn === null ? null : localDate(value.dueOn),
    version: value.version as number,
    createdAt: validTimestamp(value.createdAt),
    updatedAt: validTimestamp(value.updatedAt),
  };
}

function mapPlanningGraphDependency(payload: unknown): PlanningWorkItemDependency {
  const value = recordValue(payload);
  if (
    typeof value.workspaceId !== "string" ||
    value.workspaceId.length === 0 ||
    typeof value.prerequisiteWorkItemId !== "string" ||
    value.prerequisiteWorkItemId.length === 0 ||
    typeof value.dependentWorkItemId !== "string" ||
    value.dependentWorkItemId.length === 0 ||
    !workItemStatuses.some((status) => status === value.prerequisiteStatus)
  ) {
    return planningGraphCorrupt();
  }
  return {
    ...createWorkItemDependency({
      workspaceId: workspaceId(value.workspaceId),
      prerequisiteWorkItemId: workItemId(value.prerequisiteWorkItemId),
      dependentWorkItemId: workItemId(value.dependentWorkItemId),
      createdAt: validTimestamp(value.createdAt),
    }),
    prerequisiteStatus: value.prerequisiteStatus as WorkItemStatus,
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
    sourceType: row.sourceType,
    routineId: row.routineId === null ? null : routineId(row.routineId),
    workItemId: row.workItemId === null ? null : workItemId(row.workItemId),
    planId: row.planId === null ? null : dailyPlanId(row.planId),
    planItemId: row.planItemId === null ? null : planItemId(row.planItemId),
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

function mapRoutinePlanningFeedback(row: RoutinePlanningFeedbackEventRow): RoutinePlanningFeedback {
  return {
    id: routinePlanningFeedbackId(row.id),
    ingestedSequence: row.ingestedSequence,
    workspaceId: workspaceId(row.workspaceId),
    routineId: routineId(row.routineId),
    kind: row.kind,
    effectiveOn: localDate(row.effectiveOn),
    effectiveThrough: row.effectiveThrough === null ? null : localDate(row.effectiveThrough),
    timeZone: row.timeZone,
    sourcePlanId: dailyPlanId(row.sourcePlanId),
    sourcePlanItemId: row.sourcePlanItemId === null ? null : planItemId(row.sourcePlanItemId),
    idempotencyKey: row.idempotencyKey,
    recordedAt: new Date(row.recordedAt),
  };
}

function mapRoutineSelectionPreferenceFeedback(
  row: RoutineSelectionPreferenceFeedbackEventRow,
): RoutineSelectionPreferenceFeedback {
  return {
    id: routineSelectionPreferenceFeedbackId(row.id),
    ingestedSequence: row.ingestedSequence,
    workspaceId: workspaceId(row.workspaceId),
    routineId: routineId(row.routineId),
    kind: row.kind,
    effectiveOn: localDate(row.effectiveOn),
    timeZone: row.timeZone,
    sourcePlanId: row.sourcePlanId === null ? null : dailyPlanId(row.sourcePlanId),
    sourcePlanItemId: row.sourcePlanItemId === null ? null : planItemId(row.sourcePlanItemId),
    idempotencyKey: row.idempotencyKey,
    recordedAt: new Date(row.recordedAt),
  };
}

function mapRoutineDurationInsightFeedback(
  row: RoutineDurationInsightFeedbackEventRow,
): RoutineDurationInsightFeedback {
  return {
    id: routineDurationInsightFeedbackId(row.id),
    ingestedSequence: row.ingestedSequence,
    workspaceId: workspaceId(row.workspaceId),
    routineId: routineId(row.routineId),
    insightKey: row.insightKey,
    kind: row.kind,
    routineVersion: row.routineVersion,
    observedMedianMinutes: row.observedMedianMinutes,
    suggestedExpectedMinutes: row.suggestedExpectedMinutes,
    idempotencyKey: row.idempotencyKey,
    recordedAt: new Date(row.recordedAt),
  };
}

function mapDailyPlanFitInsightFeedback(
  row: DailyPlanFitInsightFeedbackEventRow,
): DailyPlanFitInsightFeedback {
  return {
    id: dailyPlanFitInsightFeedbackId(row.id),
    ingestedSequence: row.ingestedSequence,
    workspaceId: workspaceId(row.workspaceId),
    forDate: localDate(row.forDate),
    insightKey: row.insightKey,
    kind: row.kind,
    planId: row.planId === null ? null : dailyPlanId(row.planId),
    sampleCount: row.sampleCount,
    typicalPlannedMinutes: row.typicalPlannedMinutes,
    typicalCompletedMinutes: row.typicalCompletedMinutes,
    typicalPlannedTaskCount: row.typicalPlannedTaskCount,
    typicalCompletedTaskCount: row.typicalCompletedTaskCount,
    suggestedTargetMinutes: row.suggestedTargetMinutes,
    suggestedTargetTaskCount: row.suggestedTargetTaskCount,
    appliedTargetMinutes: row.appliedTargetMinutes,
    appliedTargetTaskCount: row.appliedTargetTaskCount,
    idempotencyKey: row.idempotencyKey,
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
    existing.sourceType === requested.sourceType &&
    existing.routineId === requested.routineId &&
    existing.workItemId === requested.workItemId &&
    existing.planId === requested.planId &&
    existing.planItemId === requested.planItemId &&
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

function mapPlanItem(row: DailyPlanItemRow, state?: DailyPlanItemStateRow): PlanItem {
  return {
    id: planItemId(row.id),
    sourceType: row.sourceType,
    routineId: row.routineId === null ? null : routineId(row.routineId),
    workItemId: row.workItemId === null ? null : workItemId(row.workItemId),
    title: row.titleSnapshot,
    position: row.position,
    windowIndex: row.windowIndex,
    scheduledMinutes: row.scheduledMinutes,
    partialSession: row.partialSession,
    score: row.score,
    scoreComponents: row.scoreComponents,
    reasons: row.reasons,
    locked: state?.locked ?? false,
    activityState: state?.activityState ?? "pending",
    lastActivityEventId:
      state?.lastActivityEventId === null || state?.lastActivityEventId === undefined
        ? null
        : activityEventId(state.lastActivityEventId),
    activityUpdatedAt:
      state?.activityUpdatedAt === null || state?.activityUpdatedAt === undefined
        ? null
        : new Date(state.activityUpdatedAt),
  };
}

function mapDailyPlan(
  row: DailyPlanRow,
  itemRows: readonly DailyPlanItemRow[],
  stateRows: readonly DailyPlanItemStateRow[] = [],
): DailyPlan {
  const stateByItem = new Map(stateRows.map((state) => [state.itemId, state]));
  return {
    id: dailyPlanId(row.id),
    workspaceId: workspaceId(row.workspaceId),
    date: localDate(row.localDate),
    timeZone: row.timeZone,
    items: itemRows.map((item) => mapPlanItem(item, stateByItem.get(item.id))),
    totalMinutes: row.totalMinutes,
    fitness: row.fitness,
    algorithmVersion: row.algorithmVersion,
    configVersion: row.configVersion,
    prngVersion: row.prngVersion,
    seed: row.seed,
    requestRevision: row.requestRevision,
    inputHash: row.inputHash,
    inputSnapshot: row.inputSnapshot as JsonValue,
    exclusions: row.exclusions.map((exclusion): PlanExclusion => {
      // Rollout compatibility for plans persisted before sourceType was introduced.
      const legacy = exclusion as typeof exclusion & {
        sourceType?: "routine" | "work_item";
        workItemId?: string | null;
      };
      const sourceType = legacy.sourceType ?? "routine";
      return {
        sourceType,
        routineId: exclusion.routineId === null ? null : routineId(exclusion.routineId),
        workItemId:
          legacy.workItemId === null || legacy.workItemId === undefined
            ? null
            : workItemId(legacy.workItemId),
        title: exclusion.title,
        codes: exclusion.codes as PlanExclusion["codes"],
      };
    }),
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
      parentWorkItemId: item.parentWorkItemId,
      title: item.title,
      description: item.description,
      status: item.status,
      priority: item.priority,
      planningDurationMinutes: item.planningDurationMinutes,
      dueOn: item.dueOn,
      version: item.version,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    });
  }

  async list(
    workspace: WorkspaceId,
    status: WorkItemStatus | undefined,
    priority: WorkItemPriority | undefined,
    limit: number,
    offset: number,
    parentWorkItemId?: WorkItemId,
  ): Promise<readonly WorkItem[]> {
    const rows = await this.database
      .select()
      .from(workItems)
      .where(
        and(
          eq(workItems.workspaceId, workspace),
          status === undefined ? undefined : eq(workItems.status, status),
          priority === undefined ? undefined : eq(workItems.priority, priority),
          parentWorkItemId === undefined
            ? undefined
            : eq(workItems.parentWorkItemId, parentWorkItemId),
        ),
      )
      .orderBy(asc(workItems.createdAt), asc(workItems.id))
      .limit(limit)
      .offset(offset);
    return rows.map(mapWorkItem);
  }

  async listPlanningCandidates(workspace: WorkspaceId): Promise<readonly WorkItem[]> {
    const childWorkItems = alias(workItems, "planning_child_work_items");
    const rows = await this.database
      .select()
      .from(workItems)
      .where(
        and(
          eq(workItems.workspaceId, workspace),
          isNotNull(workItems.planningDurationMinutes),
          inArray(workItems.status, ["backlog", "planned", "in_progress"]),
          notExists(
            this.database
              .select({ id: childWorkItems.id })
              .from(childWorkItems)
              .where(
                and(
                  eq(childWorkItems.workspaceId, workItems.workspaceId),
                  eq(childWorkItems.parentWorkItemId, workItems.id),
                ),
              ),
          ),
        ),
      )
      .orderBy(asc(workItems.id))
      .limit(501);
    return rows.map(mapWorkItem);
  }

  async save(item: WorkItem, expectedVersion: number): Promise<void> {
    const updated = await this.database
      .update(workItems)
      .set({
        parentWorkItemId: item.parentWorkItemId,
        title: item.title,
        description: item.description,
        status: item.status,
        priority: item.priority,
        planningDurationMinutes: item.planningDurationMinutes,
        dueOn: item.dueOn,
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

export class PostgresWorkItemDependencyRepository implements WorkItemDependencyRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async lockWorkspace(workspace: WorkspaceId): Promise<void> {
    const canonicalWorkspace = workspace.toLowerCase();
    await this.database.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${canonicalWorkspace}:work-item-dependencies`}, 0))`,
    );
  }

  async find(
    workspace: WorkspaceId,
    prerequisite: WorkItemId,
    dependent: WorkItemId,
  ): Promise<WorkItemDependency | null> {
    const [row] = await this.database
      .select()
      .from(workItemDependencies)
      .where(
        and(
          eq(workItemDependencies.workspaceId, workspace),
          eq(workItemDependencies.prerequisiteWorkItemId, prerequisite),
          eq(workItemDependencies.dependentWorkItemId, dependent),
        ),
      )
      .limit(1);
    return row === undefined ? null : mapWorkItemDependency(row);
  }

  async list(
    workspace: WorkspaceId,
    limit: number,
    offset: number,
  ): Promise<readonly WorkItemDependency[]> {
    const rows = await this.database
      .select()
      .from(workItemDependencies)
      .where(eq(workItemDependencies.workspaceId, workspace))
      .orderBy(
        asc(workItemDependencies.createdAt),
        asc(workItemDependencies.prerequisiteWorkItemId),
        asc(workItemDependencies.dependentWorkItemId),
      )
      .limit(limit)
      .offset(offset);
    return rows.map(mapWorkItemDependency);
  }

  async listForPlanning(
    workspace: WorkspaceId,
    limit: number,
  ): Promise<readonly PlanningWorkItemDependency[]> {
    const rows = await this.database
      .select({
        workspaceId: workItemDependencies.workspaceId,
        prerequisiteWorkItemId: workItemDependencies.prerequisiteWorkItemId,
        dependentWorkItemId: workItemDependencies.dependentWorkItemId,
        createdAt: workItemDependencies.createdAt,
        prerequisiteStatus: workItems.status,
      })
      .from(workItemDependencies)
      .innerJoin(
        workItems,
        and(
          eq(workItems.workspaceId, workItemDependencies.workspaceId),
          eq(workItems.id, workItemDependencies.prerequisiteWorkItemId),
        ),
      )
      .innerJoin(
        dependentWorkItems,
        and(
          eq(dependentWorkItems.workspaceId, workItemDependencies.workspaceId),
          eq(dependentWorkItems.id, workItemDependencies.dependentWorkItemId),
        ),
      )
      .where(
        and(
          eq(workItemDependencies.workspaceId, workspace),
          isNotNull(dependentWorkItems.planningDurationMinutes),
          inArray(dependentWorkItems.status, ["backlog", "planned", "in_progress"]),
        ),
      )
      .orderBy(
        asc(workItemDependencies.createdAt),
        asc(workItemDependencies.prerequisiteWorkItemId),
        asc(workItemDependencies.dependentWorkItemId),
      )
      .limit(limit);
    return rows.map((row) => ({
      ...mapWorkItemDependency(row),
      prerequisiteStatus: row.prerequisiteStatus,
    }));
  }

  async loadPlanningGraph(
    workspace: WorkspaceId,
    workItemLimit: number,
    dependencyLimit: number,
  ): Promise<PlanningWorkItemGraph> {
    const rawRows = await this.database.execute(
      sql<PlanningGraphDatabaseRow>`
        with candidate_work_items as materialized (
          select
            ${workItems.id},
            ${workItems.workspaceId},
            ${workItems.parentWorkItemId},
            ${workItems.title},
            ${workItems.description},
            ${workItems.status},
            ${workItems.priority},
            ${workItems.planningDurationMinutes},
            ${workItems.dueOn},
            ${workItems.version},
            ${workItems.createdAt},
            ${workItems.updatedAt},
            row_number() over (order by ${workItems.id})::integer as row_position
          from ${workItems}
          where ${workItems.workspaceId} = ${workspace}
            and ${workItems.planningDurationMinutes} is not null
            and ${workItems.status} in ('backlog', 'planned', 'in_progress')
            and not exists (
              select 1
              from ${workItems} as planning_child_work_items
              where planning_child_work_items.workspace_id = ${workItems.workspaceId}
                and planning_child_work_items.parent_work_item_id = ${workItems.id}
            )
          order by ${workItems.id}
          limit ${workItemLimit}
        ),
        relevant_dependencies as materialized (
          select
            ${workItemDependencies.workspaceId},
            ${workItemDependencies.prerequisiteWorkItemId},
            ${workItemDependencies.dependentWorkItemId},
            ${workItemDependencies.createdAt},
            prerequisite_work_items.status as prerequisite_status,
            row_number() over (
              order by
                ${workItemDependencies.createdAt},
                ${workItemDependencies.prerequisiteWorkItemId},
                ${workItemDependencies.dependentWorkItemId}
            )::integer as row_position
          from ${workItemDependencies}
          inner join candidate_work_items
            on candidate_work_items.workspace_id = ${workItemDependencies.workspaceId}
            and candidate_work_items.id = ${workItemDependencies.dependentWorkItemId}
          inner join ${workItems} as prerequisite_work_items
            on prerequisite_work_items.workspace_id = ${workItemDependencies.workspaceId}
            and prerequisite_work_items.id = ${workItemDependencies.prerequisiteWorkItemId}
          where ${workItemDependencies.workspaceId} = ${workspace}
          order by
            ${workItemDependencies.createdAt},
            ${workItemDependencies.prerequisiteWorkItemId},
            ${workItemDependencies.dependentWorkItemId}
          limit ${dependencyLimit}
        )
        select
          0::integer as "rowGroup",
          candidate_work_items.row_position as "rowPosition",
          'work_item'::text as "rowKind",
          jsonb_build_object(
            'id', candidate_work_items.id,
            'workspaceId', candidate_work_items.workspace_id,
            'parentWorkItemId', candidate_work_items.parent_work_item_id,
            'title', candidate_work_items.title,
            'description', candidate_work_items.description,
            'status', candidate_work_items.status,
            'priority', candidate_work_items.priority,
            'planningDurationMinutes', candidate_work_items.planning_duration_minutes,
            'dueOn', candidate_work_items.due_on,
            'version', candidate_work_items.version,
            'createdAt', candidate_work_items.created_at,
            'updatedAt', candidate_work_items.updated_at
          ) as payload
        from candidate_work_items
        union all
        select
          1::integer as "rowGroup",
          relevant_dependencies.row_position as "rowPosition",
          'dependency'::text as "rowKind",
          jsonb_build_object(
            'workspaceId', relevant_dependencies.workspace_id,
            'prerequisiteWorkItemId', relevant_dependencies.prerequisite_work_item_id,
            'dependentWorkItemId', relevant_dependencies.dependent_work_item_id,
            'createdAt', relevant_dependencies.created_at,
            'prerequisiteStatus', relevant_dependencies.prerequisite_status
          ) as payload
        from relevant_dependencies
        order by "rowGroup", "rowPosition"
      `,
    );
    const rows = rawRows as unknown as readonly PlanningGraphDatabaseRow[];

    try {
      const graph: {
        workItems: WorkItem[];
        dependencies: PlanningWorkItemDependency[];
      } = { workItems: [], dependencies: [] };
      let lastWorkItemPosition = 0;
      let lastDependencyPosition = 0;
      let dependenciesStarted = false;
      for (const row of rows) {
        if (!Number.isSafeInteger(row.rowPosition) || row.rowPosition < 1) {
          return planningGraphCorrupt();
        }
        if (row.rowGroup === 0 && row.rowKind === "work_item" && !dependenciesStarted) {
          if (row.rowPosition !== lastWorkItemPosition + 1) return planningGraphCorrupt();
          graph.workItems.push(mapPlanningGraphWorkItem(row.payload));
          lastWorkItemPosition = row.rowPosition;
          continue;
        }
        if (row.rowGroup === 1 && row.rowKind === "dependency") {
          dependenciesStarted = true;
          if (row.rowPosition !== lastDependencyPosition + 1) return planningGraphCorrupt();
          graph.dependencies.push(mapPlanningGraphDependency(row.payload));
          lastDependencyPosition = row.rowPosition;
          continue;
        }
        return planningGraphCorrupt();
      }
      if (graph.workItems.length > workItemLimit || graph.dependencies.length > dependencyLimit) {
        return planningGraphCorrupt();
      }
      return graph;
    } catch (error) {
      if (error instanceof DomainError && error.code === "planning.work_item_graph_corrupt") {
        throw error;
      }
      return planningGraphCorrupt();
    }
  }

  async wouldCreateCycle(
    workspace: WorkspaceId,
    prerequisite: WorkItemId,
    dependent: WorkItemId,
  ): Promise<boolean> {
    if (prerequisite === dependent) return true;
    const rows = await this.database.execute(
      sql<{ wouldCreateCycle: boolean }>`
        with recursive reachable(work_item_id) as (
          select ${workItemDependencies.dependentWorkItemId}
          from ${workItemDependencies}
          where ${workItemDependencies.workspaceId} = ${workspace}
            and ${workItemDependencies.prerequisiteWorkItemId} = ${dependent}
          union
          select ${workItemDependencies.dependentWorkItemId}
          from ${workItemDependencies}
          inner join reachable
            on ${workItemDependencies.prerequisiteWorkItemId} = reachable.work_item_id
          where ${workItemDependencies.workspaceId} = ${workspace}
        )
        select exists (
          select 1
          from reachable
          where reachable.work_item_id = ${prerequisite}
        ) as "wouldCreateCycle"
      `,
    );
    return rows[0]?.wouldCreateCycle === true;
  }

  async insert(dependency: WorkItemDependency): Promise<void> {
    await this.database.insert(workItemDependencies).values({
      workspaceId: dependency.workspaceId,
      prerequisiteWorkItemId: dependency.prerequisiteWorkItemId,
      dependentWorkItemId: dependency.dependentWorkItemId,
      createdAt: dependency.createdAt,
    });
  }

  async delete(
    workspace: WorkspaceId,
    prerequisite: WorkItemId,
    dependent: WorkItemId,
  ): Promise<boolean> {
    const deleted = await this.database
      .delete(workItemDependencies)
      .where(
        and(
          eq(workItemDependencies.workspaceId, workspace),
          eq(workItemDependencies.prerequisiteWorkItemId, prerequisite),
          eq(workItemDependencies.dependentWorkItemId, dependent),
        ),
      )
      .returning({ prerequisiteWorkItemId: workItemDependencies.prerequisiteWorkItemId });
    return deleted.length === 1;
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

  async listOverlapping(
    workspace: WorkspaceId,
    from: Date,
    to: Date,
    limit: number,
    offset: number,
  ): Promise<readonly ScheduleBlock[]> {
    const rows = await this.database
      .select()
      .from(scheduleBlocks)
      .where(
        and(
          eq(scheduleBlocks.workspaceId, workspace),
          lt(scheduleBlocks.startsAt, to),
          gt(scheduleBlocks.endsAt, from),
        ),
      )
      .orderBy(asc(scheduleBlocks.startsAt), asc(scheduleBlocks.endsAt), asc(scheduleBlocks.id))
      .limit(limit)
      .offset(offset);
    return rows.map(mapScheduleBlock);
  }

  async save(block: ScheduleBlock, expectedVersion: number): Promise<void> {
    const updated = await this.database
      .update(scheduleBlocks)
      .set({
        workItemId: block.workItemId,
        title: block.title,
        startsAt: block.startsAt,
        endsAt: block.endsAt,
        timeZone: block.timeZone,
        version: block.version,
        updatedAt: block.updatedAt,
      })
      .where(
        and(
          eq(scheduleBlocks.workspaceId, block.workspaceId),
          eq(scheduleBlocks.id, block.id),
          eq(scheduleBlocks.version, expectedVersion),
        ),
      )
      .returning({ id: scheduleBlocks.id });
    if (updated.length === 0) {
      throw new DomainError(
        "schedule_block.version_conflict",
        "The schedule block changed before this update could be saved.",
      );
    }
  }

  async delete(block: ScheduleBlock, expectedVersion: number): Promise<void> {
    const deleted = await this.database
      .delete(scheduleBlocks)
      .where(
        and(
          eq(scheduleBlocks.workspaceId, block.workspaceId),
          eq(scheduleBlocks.id, block.id),
          eq(scheduleBlocks.version, expectedVersion),
        ),
      )
      .returning({ id: scheduleBlocks.id });
    if (deleted.length === 0) {
      throw new DomainError(
        "schedule_block.version_conflict",
        "The schedule block changed before this deletion could be saved.",
      );
    }
  }
}

export class PostgresNotificationRepository implements NotificationRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  private async invalidateDeliveryCommands(condition: SQL<unknown>): Promise<void> {
    const matchingIntentIds = this.database
      .select({ id: notificationIntents.id })
      .from(notificationIntents)
      .where(condition);
    await this.database
      .update(notificationDeliveryCommands)
      .set({
        status: "invalidated",
        redriveRequestedAt: null,
        completedAt: sql`greatest(clock_timestamp(), ${notificationDeliveryCommands.createdAt}, ${notificationDeliveryCommands.updatedAt})`,
        updatedAt: sql`greatest(clock_timestamp(), ${notificationDeliveryCommands.createdAt}, ${notificationDeliveryCommands.updatedAt})`,
      })
      .where(
        and(
          inArray(notificationDeliveryCommands.status, ["pending", "processing"]),
          inArray(notificationDeliveryCommands.intentId, matchingIntentIds),
        ),
      );
  }

  async lockWorkspace(workspace: WorkspaceId): Promise<void> {
    const canonicalWorkspace = workspace.toLowerCase();
    await this.database.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${canonicalWorkspace}:notifications`}, 0))`,
    );
  }

  async findProfile(workspace: WorkspaceId): Promise<NotificationProfile | null> {
    const [row] = await this.database
      .select()
      .from(notificationProfiles)
      .where(eq(notificationProfiles.workspaceId, workspace))
      .limit(1);
    return row === undefined ? null : mapNotificationProfile(row);
  }

  async insertProfile(profile: NotificationProfile): Promise<void> {
    await this.database.insert(notificationProfiles).values({
      workspaceId: profile.workspaceId,
      enabled: profile.enabled,
      timeZone: profile.timeZone,
      quietHoursStartMinute: profile.quietHoursStartMinute,
      quietHoursEndMinute: profile.quietHoursEndMinute,
      quietHoursPolicy: profile.quietHoursPolicy,
      catchUpWindowMinutes: profile.catchUpWindowMinutes,
      dailyIntentLimit: profile.dailyIntentLimit,
      version: profile.version,
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    });
  }

  async saveProfile(profile: NotificationProfile, expectedVersion: number): Promise<void> {
    const updated = await this.database
      .update(notificationProfiles)
      .set({
        enabled: profile.enabled,
        timeZone: profile.timeZone,
        quietHoursStartMinute: profile.quietHoursStartMinute,
        quietHoursEndMinute: profile.quietHoursEndMinute,
        quietHoursPolicy: profile.quietHoursPolicy,
        catchUpWindowMinutes: profile.catchUpWindowMinutes,
        dailyIntentLimit: profile.dailyIntentLimit,
        version: profile.version,
        updatedAt: profile.updatedAt,
      })
      .where(
        and(
          eq(notificationProfiles.workspaceId, profile.workspaceId),
          eq(notificationProfiles.version, expectedVersion),
        ),
      )
      .returning({ workspaceId: notificationProfiles.workspaceId });
    if (updated.length === 0) {
      throw new DomainError(
        "notification_profile.version_conflict",
        "The notification profile changed before this update could be saved.",
      );
    }
  }

  async findRule(
    workspace: WorkspaceId,
    id: NotificationRule["id"],
  ): Promise<NotificationRule | null> {
    const [row] = await this.database
      .select()
      .from(notificationRules)
      .where(and(eq(notificationRules.workspaceId, workspace), eq(notificationRules.id, id)))
      .limit(1);
    return row === undefined ? null : mapNotificationRule(row);
  }

  async listRules(workspace: WorkspaceId, limit: number): Promise<readonly NotificationRule[]> {
    const rows = await this.database
      .select()
      .from(notificationRules)
      .where(eq(notificationRules.workspaceId, workspace))
      .orderBy(
        asc(notificationRules.kind),
        asc(notificationRules.createdAt),
        asc(notificationRules.id),
      )
      .limit(limit);
    return rows.map(mapNotificationRule);
  }

  async insertRule(rule: NotificationRule): Promise<void> {
    await this.database.insert(notificationRules).values({
      id: rule.id,
      workspaceId: rule.workspaceId,
      kind: rule.kind,
      enabled: rule.enabled,
      localMinute: rule.localMinute,
      leadMinutes: rule.leadMinutes,
      cooldownMinutes: rule.cooldownMinutes,
      priority: rule.priority,
      version: rule.version,
      createdAt: rule.createdAt,
      updatedAt: rule.updatedAt,
    });
  }

  async saveRule(rule: NotificationRule, expectedVersion: number): Promise<void> {
    const updated = await this.database
      .update(notificationRules)
      .set({
        enabled: rule.enabled,
        localMinute: rule.localMinute,
        leadMinutes: rule.leadMinutes,
        cooldownMinutes: rule.cooldownMinutes,
        priority: rule.priority,
        version: rule.version,
        updatedAt: rule.updatedAt,
      })
      .where(
        and(
          eq(notificationRules.workspaceId, rule.workspaceId),
          eq(notificationRules.id, rule.id),
          eq(notificationRules.version, expectedVersion),
        ),
      )
      .returning({ id: notificationRules.id });
    if (updated.length === 0) {
      throw new DomainError(
        "notification_rule.version_conflict",
        "The notification rule changed before this update could be saved.",
      );
    }
  }

  async findOneOffReminder(
    workspace: WorkspaceId,
    id: OneOffReminder["id"],
  ): Promise<OneOffReminder | null> {
    const [row] = await this.database
      .select()
      .from(oneOffReminders)
      .where(and(eq(oneOffReminders.workspaceId, workspace), eq(oneOffReminders.id, id)))
      .limit(1);
    return row === undefined ? null : mapOneOffReminder(row);
  }

  async listOneOffReminders(
    workspace: WorkspaceId,
    fromInclusive: Date,
    throughExclusive: Date,
    limit: number,
  ): Promise<readonly OneOffReminder[]> {
    const rows = await this.database
      .select()
      .from(oneOffReminders)
      .where(
        and(
          eq(oneOffReminders.workspaceId, workspace),
          gte(oneOffReminders.scheduledFor, fromInclusive),
          lt(oneOffReminders.scheduledFor, throughExclusive),
        ),
      )
      .orderBy(asc(oneOffReminders.scheduledFor), asc(oneOffReminders.id))
      .limit(limit);
    return rows.map(mapOneOffReminder);
  }

  async insertOneOffReminder(reminder: OneOffReminder): Promise<void> {
    await this.database.insert(oneOffReminders).values({
      id: reminder.id,
      workspaceId: reminder.workspaceId,
      title: reminder.title,
      scheduledFor: reminder.scheduledFor,
      cancelledAt: reminder.cancelledAt,
      version: reminder.version,
      createdAt: reminder.createdAt,
      updatedAt: reminder.updatedAt,
    });
  }

  async saveOneOffReminder(reminder: OneOffReminder, expectedVersion: number): Promise<void> {
    const updated = await this.database
      .update(oneOffReminders)
      .set({
        title: reminder.title,
        scheduledFor: reminder.scheduledFor,
        cancelledAt: reminder.cancelledAt,
        version: reminder.version,
        updatedAt: reminder.updatedAt,
      })
      .where(
        and(
          eq(oneOffReminders.workspaceId, reminder.workspaceId),
          eq(oneOffReminders.id, reminder.id),
          eq(oneOffReminders.version, expectedVersion),
        ),
      )
      .returning({ id: oneOffReminders.id });
    if (updated.length === 0) {
      throw new DomainError(
        "one_off_reminder.version_conflict",
        "The one-off reminder changed before this update could be saved.",
      );
    }
  }

  async listDueWorkItems(
    workspace: WorkspaceId,
    fromInclusive: LocalDate,
    throughInclusive: LocalDate,
    limit: number,
  ): Promise<readonly WorkItem[]> {
    const rows = await this.database
      .select()
      .from(workItems)
      .where(
        and(
          eq(workItems.workspaceId, workspace),
          isNotNull(workItems.dueOn),
          gte(workItems.dueOn, fromInclusive),
          lte(workItems.dueOn, throughInclusive),
        ),
      )
      .orderBy(asc(workItems.dueOn), asc(workItems.id))
      .limit(limit);
    return rows.map(mapWorkItem);
  }

  async listIntents(
    workspace: WorkspaceId,
    fromInclusive: Date,
    throughExclusive: Date,
    limit: number,
    offset: number,
  ): Promise<readonly NotificationIntent[]> {
    const rows = await this.database
      .select()
      .from(notificationIntents)
      .where(
        and(
          eq(notificationIntents.workspaceId, workspace),
          gte(notificationIntents.scheduledFor, fromInclusive),
          lt(notificationIntents.scheduledFor, throughExclusive),
        ),
      )
      .orderBy(asc(notificationIntents.scheduledFor), asc(notificationIntents.id))
      .limit(limit)
      .offset(offset);
    return rows.map(mapNotificationIntent);
  }

  async listDeliveryHistory(
    workspace: WorkspaceId,
    fromInclusive: Date,
    throughExclusive: Date,
    limit: number,
    offset: number,
  ): Promise<readonly NotificationDeliveryHistoryItem[]> {
    const rows = await this.database
      .select()
      .from(notificationDeliveryCommands)
      .where(
        and(
          eq(notificationDeliveryCommands.workspaceId, workspace),
          gte(notificationDeliveryCommands.scheduledFor, fromInclusive),
          lt(notificationDeliveryCommands.scheduledFor, throughExclusive),
        ),
      )
      .orderBy(asc(notificationDeliveryCommands.scheduledFor), asc(notificationDeliveryCommands.id))
      .limit(limit)
      .offset(offset);
    return rows.map(mapNotificationDeliveryHistory);
  }

  async redriveDeadLetterDelivery(
    workspace: WorkspaceId,
    deliveryId: string,
  ): Promise<NotificationDeliveryRedriveResult> {
    const [command] = await this.database
      .select()
      .from(notificationDeliveryCommands)
      .where(
        and(
          eq(notificationDeliveryCommands.workspaceId, workspace),
          eq(notificationDeliveryCommands.id, deliveryId),
        ),
      )
      .limit(1)
      .for("update");
    if (command === undefined) return { kind: "not_found" };
    if (command.status !== "dead_letter") {
      return { kind: "state_conflict", status: command.status as NotificationDeliveryStatus };
    }

    const [redriven] = await this.database
      .update(notificationDeliveryCommands)
      .set({
        status: "pending",
        availableAt: sql`greatest(clock_timestamp(), ${notificationDeliveryCommands.createdAt}, ${notificationDeliveryCommands.updatedAt})`,
        completedAt: null,
        redriveRequestedAt: sql`greatest(clock_timestamp(), ${notificationDeliveryCommands.createdAt}, ${notificationDeliveryCommands.updatedAt})`,
        currentClaimToken: null,
        leaseExpiresAt: null,
        updatedAt: sql`greatest(clock_timestamp(), ${notificationDeliveryCommands.createdAt}, ${notificationDeliveryCommands.updatedAt})`,
      })
      .where(
        and(
          eq(notificationDeliveryCommands.workspaceId, workspace),
          eq(notificationDeliveryCommands.id, deliveryId),
          eq(notificationDeliveryCommands.status, "dead_letter"),
        ),
      )
      .returning();
    if (redriven === undefined) {
      return { kind: "state_conflict", status: "dead_letter" };
    }
    return { kind: "redriven", delivery: mapNotificationDeliveryHistory(redriven) };
  }

  async insertIntent(intent: NotificationIntent): Promise<NotificationIntent> {
    const [deliveredOccurrence] = await this.database
      .select({ intentId: notificationDeliveryCommands.intentId })
      .from(notificationDeliveryCommands)
      .where(
        and(
          eq(notificationDeliveryCommands.workspaceId, intent.workspaceId),
          eq(notificationDeliveryCommands.occurrenceKey, intent.occurrenceKey),
        ),
      )
      .limit(1);
    if (deliveredOccurrence !== undefined) {
      // A command that has crossed the delivery boundary is the durable natural-key
      // winner even if its mutable source intent was later invalidated and deleted.
      return { ...intent, id: notificationIntentId(deliveredOccurrence.intentId) };
    }

    const [inserted] = await this.database
      .insert(notificationIntents)
      .values({
        id: intent.id,
        workspaceId: intent.workspaceId,
        ruleId: intent.ruleId,
        ruleKind: intent.ruleId === null ? null : (intent.kind as NotificationRuleKind),
        oneOffReminderId: intent.oneOffReminderId,
        kind: intent.kind,
        occurrenceKey: intent.occurrenceKey,
        targetType: intent.targetType,
        dailyPlanId: intent.targetType === "daily_plan" ? intent.targetId : null,
        scheduleBlockId: intent.targetType === "schedule_block" ? intent.targetId : null,
        workItemId: intent.targetType === "work_item" ? intent.targetId : null,
        titleSnapshot: intent.titleSnapshot,
        scheduledFor: intent.scheduledFor,
        localDate: intent.localDate,
        priority: intent.priority,
        policySnapshot: { ...intent.policySnapshot },
        localTimeResolution: intent.localTimeResolution,
        adjustedForQuietHours: intent.adjustedForQuietHours,
        caughtUp: intent.caughtUp,
        createdAt: intent.createdAt,
      })
      .onConflictDoNothing({
        target: [notificationIntents.workspaceId, notificationIntents.occurrenceKey],
      })
      .returning();
    if (inserted !== undefined) return mapNotificationIntent(inserted);

    const [existing] = await this.database
      .select()
      .from(notificationIntents)
      .where(
        and(
          eq(notificationIntents.workspaceId, intent.workspaceId),
          eq(notificationIntents.occurrenceKey, intent.occurrenceKey),
        ),
      )
      .limit(1);
    if (existing === undefined) {
      throw new DomainError(
        "notification_intent.write_conflict",
        "The notification intent could not be inserted or recovered.",
      );
    }
    return mapNotificationIntent(existing);
  }

  async deleteIntentsForWorkspace(workspace: WorkspaceId): Promise<number> {
    const condition = eq(notificationIntents.workspaceId, workspace);
    await this.invalidateDeliveryCommands(condition);
    const deleted = await this.database
      .delete(notificationIntents)
      .where(condition)
      .returning({ id: notificationIntents.id });
    return deleted.length;
  }

  async deleteIntentsForRule(
    workspace: WorkspaceId,
    ruleId: NotificationRule["id"],
  ): Promise<number> {
    const condition = and(
      eq(notificationIntents.workspaceId, workspace),
      eq(notificationIntents.ruleId, ruleId),
    )!;
    await this.invalidateDeliveryCommands(condition);
    const deleted = await this.database
      .delete(notificationIntents)
      .where(condition)
      .returning({ id: notificationIntents.id });
    return deleted.length;
  }

  async deleteIntentsForOneOff(
    workspace: WorkspaceId,
    reminderId: OneOffReminder["id"],
  ): Promise<number> {
    const condition = and(
      eq(notificationIntents.workspaceId, workspace),
      eq(notificationIntents.oneOffReminderId, reminderId),
    )!;
    await this.invalidateDeliveryCommands(condition);
    const deleted = await this.database
      .delete(notificationIntents)
      .where(condition)
      .returning({ id: notificationIntents.id });
    return deleted.length;
  }

  async deleteIntentsForTarget(
    workspace: WorkspaceId,
    targetType: Extract<NotificationTargetType, "daily_plan" | "schedule_block" | "work_item">,
    targetId: string,
    kind?: NotificationIntent["kind"],
  ): Promise<number> {
    const targetCondition =
      targetType === "daily_plan"
        ? eq(notificationIntents.dailyPlanId, targetId)
        : targetType === "schedule_block"
          ? eq(notificationIntents.scheduleBlockId, targetId)
          : eq(notificationIntents.workItemId, targetId);
    const condition = and(
      eq(notificationIntents.workspaceId, workspace),
      eq(notificationIntents.targetType, targetType),
      targetCondition,
      ...(kind === undefined ? [] : [eq(notificationIntents.kind, kind)]),
    )!;
    await this.invalidateDeliveryCommands(condition);
    const deleted = await this.database
      .delete(notificationIntents)
      .where(condition)
      .returning({ id: notificationIntents.id });
    return deleted.length;
  }

  async deleteIntentsForTargetType(
    workspace: WorkspaceId,
    targetType: Extract<NotificationTargetType, "daily_plan" | "schedule_block" | "work_item">,
  ): Promise<number> {
    const condition = and(
      eq(notificationIntents.workspaceId, workspace),
      eq(notificationIntents.targetType, targetType),
    )!;
    await this.invalidateDeliveryCommands(condition);
    const deleted = await this.database
      .delete(notificationIntents)
      .where(condition)
      .returning({ id: notificationIntents.id });
    return deleted.length;
  }
}

const NOTIFICATION_DELIVERY_RECOVERY_LIMIT = 100;

class PostgresNotificationDeliveryRepository implements NotificationDeliveryRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async currentTime(): Promise<Date> {
    const rows = await this.database.execute(
      sql<{ value: unknown }>`select clock_timestamp() as value`,
    );
    const value = rows[0]?.value;
    const parsed = value instanceof Date || typeof value === "string" ? new Date(value) : null;
    if (parsed === null || !Number.isFinite(parsed.getTime())) {
      throw new DomainError(
        "notification_delivery.clock_invalid",
        "The database did not return a valid coordination timestamp.",
      );
    }
    return parsed;
  }

  async claimNext(
    input: ClaimNotificationDeliveryInput,
  ): Promise<ClaimedNotificationDelivery | null> {
    const coordinationNow = await this.currentTime();
    const expired = await this.database
      .select()
      .from(notificationDeliveryCommands)
      .where(
        and(
          eq(notificationDeliveryCommands.workspaceId, input.workspaceId),
          inArray(notificationDeliveryCommands.status, ["processing", "invalidated"]),
          lte(notificationDeliveryCommands.leaseExpiresAt, coordinationNow),
        ),
      )
      .orderBy(
        asc(notificationDeliveryCommands.leaseExpiresAt),
        asc(notificationDeliveryCommands.id),
      )
      .limit(NOTIFICATION_DELIVERY_RECOVERY_LIMIT)
      .for("update");

    for (const command of expired) {
      if (command.currentClaimToken === null) {
        throw new DomainError(
          "notification_delivery.command_corrupt",
          "A processing delivery command is missing its claim token.",
        );
      }
      await this.database
        .update(notificationDeliveryAttempts)
        .set({ outcome: "lease_expired", completedAt: coordinationNow })
        .where(
          and(
            eq(notificationDeliveryAttempts.workspaceId, input.workspaceId),
            eq(notificationDeliveryAttempts.deliveryId, command.id),
            eq(notificationDeliveryAttempts.id, command.currentClaimToken),
            isNull(notificationDeliveryAttempts.outcome),
          ),
        );
      if (command.status === "invalidated") {
        await this.database
          .update(notificationDeliveryCommands)
          .set({
            currentClaimToken: null,
            leaseExpiresAt: null,
            updatedAt: coordinationNow,
          })
          .where(
            and(
              eq(notificationDeliveryCommands.workspaceId, input.workspaceId),
              eq(notificationDeliveryCommands.id, command.id),
              eq(notificationDeliveryCommands.status, "invalidated"),
              eq(notificationDeliveryCommands.currentClaimToken, command.currentClaimToken),
            ),
          );
        continue;
      }
      const exhausted = command.attempts >= input.maxAttempts;
      await this.database
        .update(notificationDeliveryCommands)
        .set({
          status: exhausted ? "dead_letter" : "pending",
          availableAt: coordinationNow,
          currentClaimToken: null,
          leaseExpiresAt: null,
          completedAt: exhausted ? coordinationNow : null,
          lastFailureCode: "delivery.lease_expired",
          updatedAt: coordinationNow,
        })
        .where(
          and(
            eq(notificationDeliveryCommands.workspaceId, input.workspaceId),
            eq(notificationDeliveryCommands.id, command.id),
            eq(notificationDeliveryCommands.status, "processing"),
            eq(notificationDeliveryCommands.currentClaimToken, command.currentClaimToken),
          ),
        );
    }

    let [candidate] = await this.database
      .select()
      .from(notificationDeliveryCommands)
      .where(
        and(
          eq(notificationDeliveryCommands.workspaceId, input.workspaceId),
          eq(notificationDeliveryCommands.status, "pending"),
          lte(notificationDeliveryCommands.availableAt, coordinationNow),
          // Normal settlement and lease recovery dead-letter a command at the limit. Therefore a
          // pending command at or above the limit can only be the result of an explicit redrive.
          or(
            lt(notificationDeliveryCommands.attempts, input.maxAttempts),
            and(
              gte(notificationDeliveryCommands.attempts, input.maxAttempts),
              isNotNull(notificationDeliveryCommands.redriveRequestedAt),
            ),
          ),
        ),
      )
      .orderBy(
        desc(notificationDeliveryCommands.priority),
        asc(notificationDeliveryCommands.availableAt),
        asc(notificationDeliveryCommands.scheduledFor),
        asc(notificationDeliveryCommands.id),
      )
      .limit(1)
      .for("update");

    if (candidate === undefined) {
      const [intent] = await this.database
        .select()
        .from(notificationIntents)
        .where(
          and(
            eq(notificationIntents.workspaceId, input.workspaceId),
            lte(notificationIntents.scheduledFor, coordinationNow),
            notExists(
              this.database
                .select({ id: notificationDeliveryCommands.id })
                .from(notificationDeliveryCommands)
                .where(
                  and(
                    eq(notificationDeliveryCommands.workspaceId, notificationIntents.workspaceId),
                    eq(
                      notificationDeliveryCommands.occurrenceKey,
                      notificationIntents.occurrenceKey,
                    ),
                  ),
                ),
            ),
          ),
        )
        .orderBy(
          desc(notificationIntents.priority),
          asc(notificationIntents.scheduledFor),
          asc(notificationIntents.id),
        )
        .limit(1)
        .for("update");
      if (intent === undefined) return null;

      [candidate] = await this.database
        .insert(notificationDeliveryCommands)
        .values({
          id: intent.id,
          workspaceId: intent.workspaceId,
          intentId: intent.id,
          occurrenceKey: intent.occurrenceKey,
          kind: intent.kind,
          targetType: intent.targetType,
          titleSnapshot: intent.titleSnapshot,
          scheduledFor: intent.scheduledFor,
          localDate: intent.localDate,
          priority: intent.priority,
          status: "pending",
          attempts: 0,
          availableAt: coordinationNow,
          createdAt: coordinationNow,
          updatedAt: coordinationNow,
        })
        .returning();
      if (candidate === undefined) {
        throw new DomainError(
          "notification_delivery.command_write_conflict",
          "The delivery command could not be created.",
        );
      }
    }

    const claimNow = await this.currentTime();
    const claimToken = randomUUID();
    const attempt = candidate.attempts + 1;
    const leaseExpiresAt = new Date(claimNow.getTime() + input.leaseDurationMilliseconds);
    const [claimed] = await this.database
      .update(notificationDeliveryCommands)
      .set({
        status: "processing",
        attempts: attempt,
        currentClaimToken: claimToken,
        leaseExpiresAt,
        completedAt: null,
        redriveRequestedAt: null,
        lastFailureCode: null,
        updatedAt: claimNow,
      })
      .where(
        and(
          eq(notificationDeliveryCommands.workspaceId, input.workspaceId),
          eq(notificationDeliveryCommands.id, candidate.id),
          eq(notificationDeliveryCommands.status, "pending"),
          eq(notificationDeliveryCommands.attempts, candidate.attempts),
        ),
      )
      .returning();
    if (claimed === undefined) {
      throw new DomainError(
        "notification_delivery.claim_conflict",
        "The delivery command changed before it could be claimed.",
      );
    }
    await this.database.insert(notificationDeliveryAttempts).values({
      id: claimToken,
      workspaceId: input.workspaceId,
      deliveryId: claimed.id,
      credentialId: input.credentialId,
      attemptNumber: attempt,
      claimedAt: claimNow,
      leaseExpiresAt,
    });
    return {
      deliveryId: claimed.id,
      intentId: claimed.intentId,
      kind: claimed.kind as NotificationKind,
      targetType: claimed.targetType as NotificationTargetType,
      title: claimed.titleSnapshot,
      scheduledFor: new Date(claimed.scheduledFor),
      localDate: localDate(claimed.localDate),
      priority: claimed.priority,
      attempt,
      claimToken,
      leaseExpiresAt,
    };
  }

  async settle(input: SettleNotificationDeliveryInput): Promise<NotificationDeliveryReceiptResult> {
    const coordinationNow = await this.currentTime();
    const [command] = await this.database
      .select()
      .from(notificationDeliveryCommands)
      .where(
        and(
          eq(notificationDeliveryCommands.workspaceId, input.workspaceId),
          eq(notificationDeliveryCommands.id, input.deliveryId),
        ),
      )
      .limit(1)
      .for("update");
    if (command === undefined) {
      throw new DomainError(
        "notification_delivery.command_not_found",
        "The delivery command does not exist in this workspace.",
      );
    }
    if (
      (command.status !== "processing" && command.status !== "invalidated") ||
      command.currentClaimToken !== input.claimToken ||
      command.leaseExpiresAt === null ||
      command.leaseExpiresAt.getTime() <= coordinationNow.getTime()
    ) {
      throw new DomainError(
        "notification_delivery.claim_stale",
        "The delivery claim is stale or no longer owns this command.",
      );
    }

    const [attempt] = await this.database
      .select()
      .from(notificationDeliveryAttempts)
      .where(
        and(
          eq(notificationDeliveryAttempts.workspaceId, input.workspaceId),
          eq(notificationDeliveryAttempts.deliveryId, input.deliveryId),
          eq(notificationDeliveryAttempts.id, input.claimToken),
        ),
      )
      .limit(1)
      .for("update");
    if (
      attempt === undefined ||
      attempt.credentialId !== input.credentialId ||
      attempt.outcome !== null
    ) {
      throw new DomainError(
        "notification_delivery.claim_stale",
        "The delivery claim is stale or belongs to another adapter credential.",
      );
    }
    await this.database
      .update(notificationDeliveryAttempts)
      .set({
        outcome: input.outcome,
        failureCode: input.failureCode,
        retryAfterSeconds: input.retryAfterSeconds,
        completedAt: coordinationNow,
      })
      .where(eq(notificationDeliveryAttempts.id, input.claimToken));

    if (command.status === "invalidated") {
      await this.database
        .update(notificationDeliveryCommands)
        .set({
          currentClaimToken: null,
          leaseExpiresAt: null,
          lastFailureCode: input.failureCode,
          updatedAt: coordinationNow,
        })
        .where(
          and(
            eq(notificationDeliveryCommands.id, command.id),
            eq(notificationDeliveryCommands.status, "invalidated"),
            eq(notificationDeliveryCommands.currentClaimToken, input.claimToken),
          ),
        );
      return { deliveryId: command.id, status: "invalidated" };
    }

    if (input.outcome === "delivered") {
      await this.database
        .update(notificationDeliveryCommands)
        .set({
          status: "delivered",
          currentClaimToken: null,
          leaseExpiresAt: null,
          completedAt: coordinationNow,
          lastFailureCode: null,
          updatedAt: coordinationNow,
        })
        .where(eq(notificationDeliveryCommands.id, command.id));
      return { deliveryId: command.id, status: "delivered" };
    }

    const deadLetter =
      input.outcome === "permanent_failure" || command.attempts >= input.maxAttempts;
    if (deadLetter) {
      await this.database
        .update(notificationDeliveryCommands)
        .set({
          status: "dead_letter",
          currentClaimToken: null,
          leaseExpiresAt: null,
          completedAt: coordinationNow,
          lastFailureCode: input.failureCode,
          updatedAt: coordinationNow,
        })
        .where(eq(notificationDeliveryCommands.id, command.id));
      return { deliveryId: command.id, status: "dead_lettered" };
    }

    const retryAfterSeconds = input.retryAfterSeconds;
    if (retryAfterSeconds === null) {
      throw new DomainError(
        "notification_delivery.receipt_invalid",
        "A retryable outcome must include retryAfterSeconds.",
      );
    }
    await this.database
      .update(notificationDeliveryCommands)
      .set({
        status: "pending",
        availableAt: new Date(coordinationNow.getTime() + retryAfterSeconds * 1_000),
        currentClaimToken: null,
        leaseExpiresAt: null,
        completedAt: null,
        lastFailureCode: input.failureCode,
        updatedAt: coordinationNow,
      })
      .where(eq(notificationDeliveryCommands.id, command.id));
    return { deliveryId: command.id, status: "retry_scheduled" };
  }
}

class PostgresNotificationDeliveryRequestRepository implements NotificationDeliveryRequestRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async reserve(input: NotificationDeliveryRequestReservationInput): Promise<{
    readonly kind: "reserved" | "replay";
    readonly request: NotificationDeliveryRequestRecord;
  }> {
    const [row] = await this.database
      .insert(notificationDeliveryRequests)
      .values({
        id: input.id,
        workspaceId: input.workspaceId,
        credentialId: input.credentialId,
        idempotencyKey: input.idempotencyKey,
        operation: input.operation,
        requestHash: input.requestHash,
        status: "processing",
        createdAt: input.createdAt,
        updatedAt: input.createdAt,
      })
      .onConflictDoUpdate({
        target: [
          notificationDeliveryRequests.credentialId,
          notificationDeliveryRequests.idempotencyKey,
        ],
        set: { idempotencyKey: sql`${notificationDeliveryRequests.idempotencyKey}` },
      })
      .returning({
        ...getTableColumns(notificationDeliveryRequests),
        inserted: sql<boolean>`xmax = 0`.as("inserted"),
      });
    if (row === undefined) {
      throw new DomainError(
        "notification_delivery.request_write_conflict",
        "The notification delivery request could not be reserved.",
      );
    }
    if (
      row.workspaceId !== input.workspaceId ||
      row.operation !== input.operation ||
      row.requestHash !== input.requestHash
    ) {
      throw new DomainError(
        "notification_delivery.request_conflict",
        "This idempotency key already belongs to a different delivery request.",
      );
    }
    const request = mapNotificationDeliveryRequest(row);
    if (row.inserted) return { kind: "reserved", request };
    if (request.state === "processing") {
      throw new DomainError(
        "notification_delivery.request_in_progress",
        "This delivery request is already being processed.",
      );
    }
    if (request.result === null || request.completedAt === null) {
      throw new DomainError(
        "notification_delivery.request_corrupt",
        "The completed delivery request has no replayable result.",
      );
    }
    return { kind: "replay", request };
  }

  async succeed(
    id: string,
    result: NotificationDeliveryRequestResult,
    completedAt: Date,
  ): Promise<NotificationDeliveryRequestRecord> {
    const [current] = await this.database
      .select()
      .from(notificationDeliveryRequests)
      .where(eq(notificationDeliveryRequests.id, id))
      .limit(1)
      .for("update");
    if (current === undefined || current.status !== "processing") {
      throw new DomainError(
        "notification_delivery.request_not_found",
        "The delivery request reservation is missing or already complete.",
      );
    }
    if (result.operation !== current.operation) {
      throw new DomainError(
        "notification_delivery.request_conflict",
        "The delivery result does not match its request operation.",
      );
    }
    const [updated] = await this.database
      .update(notificationDeliveryRequests)
      .set({
        status: "succeeded",
        result: result as unknown as Record<string, unknown>,
        completedAt,
        updatedAt: completedAt,
      })
      .where(
        and(
          eq(notificationDeliveryRequests.id, id),
          eq(notificationDeliveryRequests.status, "processing"),
        ),
      )
      .returning();
    if (updated === undefined) {
      throw new DomainError(
        "notification_delivery.request_write_conflict",
        "The delivery request could not be completed.",
      );
    }
    return mapNotificationDeliveryRequest(updated);
  }
}

class PostgresAuditEventRepository implements AuditEventRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async append(event: AuditEventRecord): Promise<void> {
    await this.database.insert(auditEvents).values({
      workspaceId: event.workspaceId,
      action: event.action,
      entityType: event.entityType,
      entityId: event.entityId,
      data: { ...event.data },
      occurredAt: event.occurredAt,
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

  async list(limit: number, offset: number): Promise<readonly Workspace[]> {
    const rows = await this.database
      .select()
      .from(workspaces)
      .orderBy(asc(workspaces.createdAt), asc(workspaces.id))
      .limit(limit)
      .offset(offset);
    return rows.map(mapWorkspace);
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

export class PostgresActivityEventRepository implements ActivityEventRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async findById(workspace: WorkspaceId, id: ActivityEvent["id"]): Promise<ActivityEvent | null> {
    const [row] = await this.database
      .select()
      .from(activityEvents)
      .where(and(eq(activityEvents.workspaceId, workspace), eq(activityEvents.id, id)))
      .limit(1);
    return row === undefined ? null : mapActivityEvent(row);
  }

  async lockRoutineActivity(workspace: WorkspaceId, routine: Routine["id"]): Promise<void> {
    await this.database.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${workspace}:routine:${routine}`}, 0))`,
    );
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

  async listDurationEvidence(
    workspace: WorkspaceId,
    routine: Routine["id"],
    fromInclusive: Date,
    throughInclusive: Date,
  ): Promise<readonly ActivityEvent[]> {
    if (
      !(fromInclusive instanceof Date) ||
      !Number.isFinite(fromInclusive.getTime()) ||
      !(throughInclusive instanceof Date) ||
      !Number.isFinite(throughInclusive.getTime()) ||
      fromInclusive.getTime() > throughInclusive.getTime()
    ) {
      throw new DomainError(
        "activity.duration_evidence_window_invalid",
        "Duration evidence requires a valid inclusive time window.",
      );
    }

    const candidates = this.database.$with("duration_evidence_candidates").as(
      this.database
        .select({ id: activityEvents.id })
        .from(activityEvents)
        .where(
          and(
            eq(activityEvents.workspaceId, workspace),
            eq(activityEvents.sourceType, "routine"),
            eq(activityEvents.routineId, routine),
            eq(activityEvents.type, "completed"),
            isNotNull(activityEvents.durationMinutes),
            gte(activityEvents.occurredAt, fromInclusive),
            lte(activityEvents.occurredAt, throughInclusive),
            lte(activityEvents.recordedAt, throughInclusive),
          ),
        ),
    );
    const candidateIds = this.database.select({ id: candidates.id }).from(candidates);
    const rows = await this.database
      .with(candidates)
      .select()
      .from(activityEvents)
      .where(
        and(
          eq(activityEvents.workspaceId, workspace),
          eq(activityEvents.sourceType, "routine"),
          eq(activityEvents.routineId, routine),
          or(
            inArray(activityEvents.id, candidateIds),
            and(
              inArray(activityEvents.type, ["duration_corrected", "completion_reversed"]),
              inArray(activityEvents.referenceEventId, candidateIds),
              lte(activityEvents.recordedAt, throughInclusive),
              lte(activityEvents.occurredAt, throughInclusive),
            ),
          ),
        ),
      )
      .orderBy(asc(activityEvents.ingestedSequence))
      .limit(5_001);
    if (rows.length > 5_000) {
      throw new DomainError(
        "activity.duration_evidence_limit_exceeded",
        "Duration evidence exceeds the local-mode limit of 5,000 events.",
      );
    }
    return rows.map(mapActivityEvent);
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
      sql`select pg_advisory_xact_lock(hashtextextended(${`${event.workspaceId}:${event.sourceType}:${event.routineId ?? event.workItemId}`}, 0))`,
    );
    let inserted: ActivityEventRow | undefined;
    try {
      [inserted] = await this.database
        .insert(activityEvents)
        .values({
          id: event.id,
          workspaceId: event.workspaceId,
          sourceType: event.sourceType,
          routineId: event.routineId,
          workItemId: event.workItemId,
          planId: event.planId,
          planItemId: event.planItemId,
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
          "The referenced event is not a completion for this source.",
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

export class PostgresRoutineDurationInsightFeedbackRepository implements RoutineDurationInsightFeedbackRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async findLatestForKey(
    workspace: WorkspaceId,
    routine: Routine["id"],
    insightKey: string,
  ): Promise<RoutineDurationInsightFeedback | null> {
    const [row] = await this.database
      .select()
      .from(routineDurationInsightFeedbackEvents)
      .where(
        and(
          eq(routineDurationInsightFeedbackEvents.workspaceId, workspace),
          eq(routineDurationInsightFeedbackEvents.routineId, routine),
          eq(routineDurationInsightFeedbackEvents.insightKey, insightKey),
        ),
      )
      .orderBy(
        desc(routineDurationInsightFeedbackEvents.ingestedSequence),
        desc(routineDurationInsightFeedbackEvents.id),
      )
      .limit(1);
    return row === undefined ? null : mapRoutineDurationInsightFeedback(row);
  }

  async findByIdempotencyKey(
    workspace: WorkspaceId,
    idempotencyKey: string,
  ): Promise<RoutineDurationInsightFeedback | null> {
    const [row] = await this.database
      .select()
      .from(routineDurationInsightFeedbackEvents)
      .where(
        and(
          eq(routineDurationInsightFeedbackEvents.workspaceId, workspace),
          eq(routineDurationInsightFeedbackEvents.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    return row === undefined ? null : mapRoutineDurationInsightFeedback(row);
  }

  async append(feedback: RoutineDurationInsightFeedback): Promise<RoutineDurationInsightFeedback> {
    const [inserted] = await this.database
      .insert(routineDurationInsightFeedbackEvents)
      .values({
        id: feedback.id,
        workspaceId: feedback.workspaceId,
        routineId: feedback.routineId,
        insightKey: feedback.insightKey,
        kind: feedback.kind,
        routineVersion: feedback.routineVersion,
        observedMedianMinutes: feedback.observedMedianMinutes,
        suggestedExpectedMinutes: feedback.suggestedExpectedMinutes,
        idempotencyKey: feedback.idempotencyKey,
        recordedAt: feedback.recordedAt,
      })
      .onConflictDoNothing({
        target: [
          routineDurationInsightFeedbackEvents.workspaceId,
          routineDurationInsightFeedbackEvents.idempotencyKey,
        ],
      })
      .returning();
    if (inserted !== undefined) return mapRoutineDurationInsightFeedback(inserted);

    const existing = await this.findByIdempotencyKey(feedback.workspaceId, feedback.idempotencyKey);
    if (existing === null) {
      throw new DomainError(
        "routine_duration_insight.feedback_write_conflict",
        "The duration-insight feedback could not be appended or loaded.",
      );
    }
    const sameFeedback =
      existing.workspaceId === feedback.workspaceId &&
      existing.routineId === feedback.routineId &&
      existing.insightKey === feedback.insightKey &&
      existing.kind === feedback.kind &&
      existing.routineVersion === feedback.routineVersion &&
      existing.observedMedianMinutes === feedback.observedMedianMinutes &&
      existing.suggestedExpectedMinutes === feedback.suggestedExpectedMinutes;
    if (!sameFeedback) {
      throw new DomainError(
        "routine_duration_insight.idempotency_conflict",
        "This duration-insight feedback idempotency key already belongs to a different disposition.",
      );
    }
    return existing;
  }
}

export class PostgresDailyPlanFitInsightFeedbackRepository implements DailyPlanFitInsightFeedbackRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async lockWorkspace(workspace: WorkspaceId): Promise<void> {
    const canonicalWorkspace = workspace.toLowerCase();
    await this.database.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${canonicalWorkspace}:daily-plan-fit-feedback`}, 0))`,
    );
    // The advisory lock orders feedback operations but is invisible to PostgreSQL SSI. Touching a
    // real row makes a serializable waiter abort with 40001 when an earlier feedback transaction
    // committed after its snapshot, so the unit of work retries and observes the winning event.
    await this.database.execute(
      sql`update ${workspaces} set "name" = "name" where ${workspaces.id} = ${canonicalWorkspace}`,
    );
  }

  async findLatestForKey(
    workspace: WorkspaceId,
    insightKey: string,
  ): Promise<DailyPlanFitInsightFeedback | null> {
    const [row] = await this.database
      .select()
      .from(dailyPlanFitInsightFeedbackEvents)
      .where(
        and(
          eq(dailyPlanFitInsightFeedbackEvents.workspaceId, workspace),
          eq(dailyPlanFitInsightFeedbackEvents.insightKey, insightKey),
        ),
      )
      .orderBy(
        desc(dailyPlanFitInsightFeedbackEvents.ingestedSequence),
        desc(dailyPlanFitInsightFeedbackEvents.id),
      )
      .limit(1);
    return row === undefined ? null : mapDailyPlanFitInsightFeedback(row);
  }

  async listUsed(
    workspace: WorkspaceId,
    limit: number,
  ): Promise<readonly DailyPlanFitInsightFeedback[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximumDailyPlanFitUsageOutcomes) {
      throw new DomainError(
        "daily_plan_fit_insight.usage_limit_invalid",
        `Daily Plan Fit usage history must request between 1 and ${maximumDailyPlanFitUsageOutcomes} entries.`,
      );
    }
    const rows = await this.database
      .select()
      .from(dailyPlanFitInsightFeedbackEvents)
      .where(
        and(
          eq(dailyPlanFitInsightFeedbackEvents.workspaceId, workspace),
          eq(dailyPlanFitInsightFeedbackEvents.kind, "used"),
        ),
      )
      .orderBy(
        desc(dailyPlanFitInsightFeedbackEvents.ingestedSequence),
        desc(dailyPlanFitInsightFeedbackEvents.id),
      )
      .limit(limit);
    return rows.map(mapDailyPlanFitInsightFeedback);
  }

  async findByIdempotencyKey(
    workspace: WorkspaceId,
    idempotencyKey: string,
  ): Promise<DailyPlanFitInsightFeedback | null> {
    const [row] = await this.database
      .select()
      .from(dailyPlanFitInsightFeedbackEvents)
      .where(
        and(
          eq(dailyPlanFitInsightFeedbackEvents.workspaceId, workspace),
          eq(dailyPlanFitInsightFeedbackEvents.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    return row === undefined ? null : mapDailyPlanFitInsightFeedback(row);
  }

  async append(feedback: DailyPlanFitInsightFeedback): Promise<DailyPlanFitInsightFeedback> {
    const [inserted] = await this.database
      .insert(dailyPlanFitInsightFeedbackEvents)
      .values({
        id: feedback.id,
        workspaceId: feedback.workspaceId,
        forDate: feedback.forDate,
        insightKey: feedback.insightKey,
        kind: feedback.kind,
        planId: feedback.planId,
        sampleCount: feedback.sampleCount,
        typicalPlannedMinutes: feedback.typicalPlannedMinutes,
        typicalCompletedMinutes: feedback.typicalCompletedMinutes,
        typicalPlannedTaskCount: feedback.typicalPlannedTaskCount,
        typicalCompletedTaskCount: feedback.typicalCompletedTaskCount,
        suggestedTargetMinutes: feedback.suggestedTargetMinutes,
        suggestedTargetTaskCount: feedback.suggestedTargetTaskCount,
        appliedTargetMinutes: feedback.appliedTargetMinutes,
        appliedTargetTaskCount: feedback.appliedTargetTaskCount,
        idempotencyKey: feedback.idempotencyKey,
        recordedAt: feedback.recordedAt,
      })
      .onConflictDoNothing({
        target: [
          dailyPlanFitInsightFeedbackEvents.workspaceId,
          dailyPlanFitInsightFeedbackEvents.idempotencyKey,
        ],
      })
      .returning();
    if (inserted !== undefined) return mapDailyPlanFitInsightFeedback(inserted);

    const existing = await this.findByIdempotencyKey(feedback.workspaceId, feedback.idempotencyKey);
    if (existing === null) {
      throw new DomainError(
        "daily_plan_fit_insight.feedback_write_conflict",
        "Daily Plan Fit feedback could not be appended or loaded.",
      );
    }
    const sameFeedback =
      existing.workspaceId === feedback.workspaceId &&
      existing.forDate === feedback.forDate &&
      existing.insightKey === feedback.insightKey &&
      existing.kind === feedback.kind &&
      existing.planId === feedback.planId &&
      existing.sampleCount === feedback.sampleCount &&
      existing.typicalPlannedMinutes === feedback.typicalPlannedMinutes &&
      existing.typicalCompletedMinutes === feedback.typicalCompletedMinutes &&
      existing.typicalPlannedTaskCount === feedback.typicalPlannedTaskCount &&
      existing.typicalCompletedTaskCount === feedback.typicalCompletedTaskCount &&
      existing.suggestedTargetMinutes === feedback.suggestedTargetMinutes &&
      existing.suggestedTargetTaskCount === feedback.suggestedTargetTaskCount &&
      existing.appliedTargetMinutes === feedback.appliedTargetMinutes &&
      existing.appliedTargetTaskCount === feedback.appliedTargetTaskCount;
    if (!sameFeedback) {
      throw new DomainError(
        "daily_plan_fit_insight.idempotency_conflict",
        "This Daily Plan Fit idempotency key already belongs to different feedback.",
      );
    }
    return existing;
  }
}

const MAXIMUM_CURRENT_PLAN_BATCH_DATES = 366;

export class PostgresRoutineSelectionPreferenceFeedbackRepository implements RoutineSelectionPreferenceFeedbackRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async lockIdempotencyKey(workspace: WorkspaceId, idempotencyKey: string): Promise<void> {
    await this.database.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${workspace}:routine-selection-preference:${idempotencyKey}`}, 0))`,
    );
  }

  async findCurrentState(
    workspace: WorkspaceId,
    routine: RoutineId,
  ): Promise<{ readonly feedbackVersion: number; readonly updatedAt: Date | null } | null> {
    const [routineRow] = await this.database
      .select({ version: routines.selectionPreferenceVersion })
      .from(routines)
      .where(and(eq(routines.workspaceId, workspace), eq(routines.id, routine)))
      .limit(1);
    if (routineRow === undefined) return null;
    if (routineRow.version === 0) return { feedbackVersion: 0, updatedAt: null };
    const [event] = await this.database
      .select({ recordedAt: routineSelectionPreferenceFeedbackEvents.recordedAt })
      .from(routineSelectionPreferenceFeedbackEvents)
      .where(
        and(
          eq(routineSelectionPreferenceFeedbackEvents.workspaceId, workspace),
          eq(routineSelectionPreferenceFeedbackEvents.routineId, routine),
          eq(routineSelectionPreferenceFeedbackEvents.feedbackVersion, routineRow.version),
        ),
      )
      .limit(1);
    if (event === undefined) {
      throw new DomainError(
        "planning.selection_preference_state_invalid",
        "Routine selection preference state is missing its current event.",
      );
    }
    return { feedbackVersion: routineRow.version, updatedAt: new Date(event.recordedAt) };
  }

  async findByIdempotencyKey(
    workspace: WorkspaceId,
    idempotencyKey: string,
  ): Promise<{
    readonly feedback: RoutineSelectionPreferenceFeedback;
    readonly feedbackVersion: number;
  } | null> {
    const [row] = await this.database
      .select()
      .from(routineSelectionPreferenceFeedbackEvents)
      .where(
        and(
          eq(routineSelectionPreferenceFeedbackEvents.workspaceId, workspace),
          eq(routineSelectionPreferenceFeedbackEvents.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    return row === undefined
      ? null
      : {
          feedback: mapRoutineSelectionPreferenceFeedback(row),
          feedbackVersion: row.feedbackVersion,
        };
  }

  async lockAndGetCurrentVersion(workspace: WorkspaceId, routine: RoutineId): Promise<number> {
    const [row] = await this.database
      .select({ version: routines.selectionPreferenceVersion })
      .from(routines)
      .where(and(eq(routines.workspaceId, workspace), eq(routines.id, routine)))
      .limit(1)
      .for("update");
    if (row === undefined) {
      throw new DomainError("routine.not_found", "The routine does not exist.");
    }
    return row.version;
  }

  async listForPlanning(
    workspace: WorkspaceId,
    routineIds: readonly RoutineId[],
    throughDate: LocalDate,
  ): Promise<readonly RoutineSelectionPreferenceFeedback[]> {
    if (routineIds.length === 0) return [];
    const earliest = addLocalDays(throughDate, -(ROUTINE_SELECTION_PREFERENCE_LOOKBACK_DAYS - 1));
    // Rank before bounding so one heavily-used routine cannot consume a
    // workspace-wide LIMIT and hide another candidate's preference history.
    // Nine newest rows/routine preserves the latest reset plus the eight
    // directional rows that can affect the domain's canonical projection.
    const rankedFeedback = this.database
      .select({
        ...getTableColumns(routineSelectionPreferenceFeedbackEvents),
        preferenceRank: sql<number>`row_number() over (
          partition by ${routineSelectionPreferenceFeedbackEvents.routineId}
          order by
            ${routineSelectionPreferenceFeedbackEvents.ingestedSequence} desc,
            ${routineSelectionPreferenceFeedbackEvents.id} desc
        )::integer`.as("preference_rank"),
      })
      .from(routineSelectionPreferenceFeedbackEvents)
      .where(
        and(
          eq(routineSelectionPreferenceFeedbackEvents.workspaceId, workspace),
          inArray(routineSelectionPreferenceFeedbackEvents.routineId, [...routineIds]),
          gte(routineSelectionPreferenceFeedbackEvents.effectiveOn, earliest),
          lte(routineSelectionPreferenceFeedbackEvents.effectiveOn, throughDate),
        ),
      )
      .as("ranked_routine_selection_preference_feedback");
    const rows = await this.database
      .select()
      .from(rankedFeedback)
      .where(lte(rankedFeedback.preferenceRank, ROUTINE_SELECTION_PREFERENCE_EVENT_LIMIT + 1))
      .orderBy(
        asc(rankedFeedback.routineId),
        desc(rankedFeedback.ingestedSequence),
        desc(rankedFeedback.id),
      );

    return rows.map(mapRoutineSelectionPreferenceFeedback);
  }

  async listForPlanningThroughVersion(
    workspace: WorkspaceId,
    routine: RoutineId,
    throughDate: LocalDate,
    throughFeedbackVersion: number,
  ): Promise<readonly RoutineSelectionPreferenceFeedback[]> {
    const earliest = addLocalDays(throughDate, -(ROUTINE_SELECTION_PREFERENCE_LOOKBACK_DAYS - 1));
    const rows = await this.database
      .select()
      .from(routineSelectionPreferenceFeedbackEvents)
      .where(
        and(
          eq(routineSelectionPreferenceFeedbackEvents.workspaceId, workspace),
          eq(routineSelectionPreferenceFeedbackEvents.routineId, routine),
          lte(routineSelectionPreferenceFeedbackEvents.feedbackVersion, throughFeedbackVersion),
          gte(routineSelectionPreferenceFeedbackEvents.effectiveOn, earliest),
          lte(routineSelectionPreferenceFeedbackEvents.effectiveOn, throughDate),
        ),
      )
      .orderBy(
        desc(routineSelectionPreferenceFeedbackEvents.ingestedSequence),
        desc(routineSelectionPreferenceFeedbackEvents.id),
      )
      // The latest reset plus eight directional events completely determine the projection.
      .limit(ROUTINE_SELECTION_PREFERENCE_EVENT_LIMIT + 1);
    return rows.map(mapRoutineSelectionPreferenceFeedback);
  }

  async appendAndAdvance(
    feedback: RoutineSelectionPreferenceFeedback,
    expectedFeedbackVersion: number,
  ): Promise<{
    readonly feedback: RoutineSelectionPreferenceFeedback;
    readonly feedbackVersion: number;
  }> {
    const [advanced] = await this.database
      .update(routines)
      .set({ selectionPreferenceVersion: expectedFeedbackVersion + 1 })
      .where(
        and(
          eq(routines.workspaceId, feedback.workspaceId),
          eq(routines.id, feedback.routineId),
          eq(routines.selectionPreferenceVersion, expectedFeedbackVersion),
        ),
      )
      .returning({ version: routines.selectionPreferenceVersion });
    if (advanced === undefined) {
      throw new DomainError(
        "planning.selection_preference_version_conflict",
        "Routine selection preference feedback changed before this instruction was recorded.",
      );
    }
    const [inserted] = await this.database
      .insert(routineSelectionPreferenceFeedbackEvents)
      .values({
        id: feedback.id,
        workspaceId: feedback.workspaceId,
        routineId: feedback.routineId,
        feedbackVersion: advanced.version,
        kind: feedback.kind,
        effectiveOn: feedback.effectiveOn,
        timeZone: feedback.timeZone,
        sourcePlanId: feedback.sourcePlanId,
        sourcePlanItemId: feedback.sourcePlanItemId,
        idempotencyKey: feedback.idempotencyKey,
        recordedAt: feedback.recordedAt,
      })
      .returning();
    if (inserted === undefined) {
      throw new DomainError(
        "planning.selection_preference_write_conflict",
        "The selection preference event could not be appended.",
      );
    }
    return {
      feedback: mapRoutineSelectionPreferenceFeedback(inserted),
      feedbackVersion: advanced.version,
    };
  }
}

export class PostgresDailyPlanRepository implements DailyPlanRepository {
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
    const states = await this.database
      .select()
      .from(dailyPlanItemStates)
      .where(
        and(
          eq(dailyPlanItemStates.workspaceId, workspace),
          eq(dailyPlanItemStates.planId, plan.id),
        ),
      );
    return mapDailyPlan(plan, items, states);
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
    const states = await this.database
      .select()
      .from(dailyPlanItemStates)
      .where(
        and(
          eq(dailyPlanItemStates.workspaceId, workspace),
          eq(dailyPlanItemStates.planId, plan.id),
        ),
      );
    return mapDailyPlan(plan, items, states);
  }

  private async ensureHead(plan: DailyPlan): Promise<void> {
    const [head] = await this.database
      .select()
      .from(dailyPlanHeads)
      .where(
        and(
          eq(dailyPlanHeads.workspaceId, plan.workspaceId),
          eq(dailyPlanHeads.localDate, plan.date),
        ),
      )
      .limit(1);
    if (head === undefined) {
      await this.database.insert(dailyPlanHeads).values({
        workspaceId: plan.workspaceId,
        localDate: plan.date,
        currentPlanId: plan.id,
        version: 1,
        updatedAt: plan.generatedAt,
      });
      return;
    }
    const [current] = await this.database
      .select({ requestRevision: dailyPlans.requestRevision })
      .from(dailyPlans)
      .where(
        and(eq(dailyPlans.workspaceId, plan.workspaceId), eq(dailyPlans.id, head.currentPlanId)),
      )
      .limit(1);
    if (current !== undefined && current.requestRevision >= plan.requestRevision) return;
    await this.database
      .update(dailyPlanHeads)
      .set({
        currentPlanId: plan.id,
        version: head.version + 1,
        updatedAt: plan.generatedAt,
      })
      .where(
        and(
          eq(dailyPlanHeads.workspaceId, plan.workspaceId),
          eq(dailyPlanHeads.localDate, plan.date),
          eq(dailyPlanHeads.version, head.version),
        ),
      );
  }

  async insertForRevision(plan: DailyPlan): Promise<DailyPlan> {
    const existingBeforeInsert = await this.findByRevision(
      plan.workspaceId,
      plan.date,
      plan.requestRevision,
    );
    if (existingBeforeInsert !== null) {
      await this.ensureHead(existingBeforeInsert);
      return existingBeforeInsert;
    }
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
          sourceType: exclusion.sourceType,
          routineId: exclusion.routineId,
          workItemId: exclusion.workItemId,
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
            id: item.id,
            workspaceId: plan.workspaceId,
            planId: plan.id,
            sourceType: item.sourceType,
            routineId: item.routineId,
            workItemId: item.workItemId,
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
        await this.database.insert(dailyPlanItemStates).values(
          plan.items.map((item) => ({
            workspaceId: plan.workspaceId,
            planId: plan.id,
            itemId: item.id,
            locked: item.locked,
            activityState: item.activityState,
            lastActivityEventId: item.lastActivityEventId,
            activityUpdatedAt: item.activityUpdatedAt,
            version: 1,
            updatedAt: plan.generatedAt,
          })),
        );
      }
      await this.ensureHead(plan);
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
    const states = await this.database
      .select()
      .from(dailyPlanItemStates)
      .where(
        and(
          eq(dailyPlanItemStates.workspaceId, plan.workspaceId),
          eq(dailyPlanItemStates.planId, existing.id),
        ),
      );
    const result = mapDailyPlan(existing, items, states);
    await this.ensureHead(result);
    return result;
  }

  async findCurrent(workspace: WorkspaceId, date: LocalDate): Promise<CurrentDailyPlan | null> {
    const [head] = await this.database
      .select()
      .from(dailyPlanHeads)
      .where(and(eq(dailyPlanHeads.workspaceId, workspace), eq(dailyPlanHeads.localDate, date)))
      .limit(1);
    if (head === undefined) return null;
    const plan = await this.findById(workspace, dailyPlanId(head.currentPlanId));
    return plan === null ? null : { plan, headVersion: head.version };
  }

  async findCurrentForDates(
    workspace: WorkspaceId,
    dates: readonly LocalDate[],
  ): Promise<ReadonlyMap<LocalDate, CurrentDailyPlan>> {
    const uniqueDates = [...new Set(dates)];
    if (uniqueDates.length === 0) return new Map();
    if (uniqueDates.length > MAXIMUM_CURRENT_PLAN_BATCH_DATES) {
      throw new DomainError(
        "planning.current_plan_date_range_too_large",
        `A batched current-plan lookup cannot span more than ${MAXIMUM_CURRENT_PLAN_BATCH_DATES} distinct dates.`,
      );
    }

    const heads = await this.database
      .select()
      .from(dailyPlanHeads)
      .where(
        and(
          eq(dailyPlanHeads.workspaceId, workspace),
          inArray(dailyPlanHeads.localDate, uniqueDates),
        ),
      );
    if (heads.length === 0) return new Map();

    const planIds = [...new Set(heads.map((head) => head.currentPlanId))];
    const [plans, items, states] = await Promise.all([
      this.database
        .select()
        .from(dailyPlans)
        .where(and(eq(dailyPlans.workspaceId, workspace), inArray(dailyPlans.id, planIds))),
      this.database
        .select()
        .from(dailyPlanItems)
        .where(
          and(eq(dailyPlanItems.workspaceId, workspace), inArray(dailyPlanItems.planId, planIds)),
        )
        .orderBy(asc(dailyPlanItems.planId), asc(dailyPlanItems.position)),
      this.database
        .select()
        .from(dailyPlanItemStates)
        .where(
          and(
            eq(dailyPlanItemStates.workspaceId, workspace),
            inArray(dailyPlanItemStates.planId, planIds),
          ),
        ),
    ]);
    const planById = new Map(plans.map((plan) => [plan.id, plan]));
    const itemsByPlan = new Map<string, DailyPlanItemRow[]>();
    for (const item of items) {
      const planItems = itemsByPlan.get(item.planId) ?? [];
      planItems.push(item);
      itemsByPlan.set(item.planId, planItems);
    }
    const statesByPlan = new Map<string, DailyPlanItemStateRow[]>();
    for (const state of states) {
      const planStates = statesByPlan.get(state.planId) ?? [];
      planStates.push(state);
      statesByPlan.set(state.planId, planStates);
    }

    const currentByDate = new Map<LocalDate, CurrentDailyPlan>();
    for (const head of heads) {
      const plan = planById.get(head.currentPlanId);
      if (plan === undefined) continue;
      currentByDate.set(localDate(head.localDate), {
        plan: mapDailyPlan(plan, itemsByPlan.get(plan.id) ?? [], statesByPlan.get(plan.id) ?? []),
        headVersion: head.version,
      });
    }
    return currentByDate;
  }

  async listFitEvidence(
    workspace: WorkspaceId,
    forDate: LocalDate,
    lookbackDays: number,
    candidateLimit: number,
  ): Promise<readonly DailyPlanFitEvidencePlan[]> {
    if (!Number.isSafeInteger(lookbackDays) || lookbackDays < 1 || lookbackDays > 366) {
      throw new DomainError(
        "daily_plan_fit_insight.lookback_invalid",
        "Daily Plan Fit lookback must be between 1 and 366 days.",
      );
    }
    if (!Number.isSafeInteger(candidateLimit) || candidateLimit < 1 || candidateLimit > 366) {
      throw new DomainError(
        "daily_plan_fit_insight.candidate_limit_invalid",
        "Daily Plan Fit candidate limit must be between 1 and 366 plans.",
      );
    }
    const maximumRows = candidateLimit * dailyPlanFitInsightMaximumItemsPerPlan;
    const rowLimit = maximumRows + 1;

    const rows = (await this.database.execute(
      sql<DailyPlanFitEvidenceDatabaseRow>`
        with candidate_plans as materialized (
          select
            ${dailyPlans.id} as plan_id,
            ${dailyPlanHeads.localDate} as local_date,
            ${dailyPlans.inputSnapshot} #>> '{request,targetMinutes}' as target_minutes,
            ${dailyPlans.inputSnapshot} #>> '{request,targetTaskCount}' as target_task_count
          from ${dailyPlanHeads}
          inner join ${dailyPlans}
            on ${dailyPlans.workspaceId} = ${dailyPlanHeads.workspaceId}
           and ${dailyPlans.id} = ${dailyPlanHeads.currentPlanId}
          where ${dailyPlanHeads.workspaceId} = ${workspace}
            and ${dailyPlanHeads.localDate} >= (${forDate}::date - ${lookbackDays}::integer)
            and ${dailyPlanHeads.localDate} < ${forDate}::date
          order by ${dailyPlanHeads.localDate} desc, ${dailyPlans.id} desc
          limit ${candidateLimit}
        )
        select
          candidate_plans.plan_id as "planId",
          candidate_plans.local_date as "localDate",
          candidate_plans.target_minutes as "targetMinutes",
          candidate_plans.target_task_count as "targetTaskCount",
          ${dailyPlanItems.id} as "itemId",
          ${dailyPlanItems.scheduledMinutes} as "scheduledMinutes",
          ${dailyPlanItemStates.activityState} as "activityState",
          ${dailyPlanItemStates.lastActivityEventId} as "lastActivityEventId"
        from candidate_plans
        left join ${dailyPlanItems}
          on ${dailyPlanItems.workspaceId} = ${workspace}
         and ${dailyPlanItems.planId} = candidate_plans.plan_id
        left join ${dailyPlanItemStates}
          on ${dailyPlanItemStates.workspaceId} = ${dailyPlanItems.workspaceId}
         and ${dailyPlanItemStates.planId} = ${dailyPlanItems.planId}
         and ${dailyPlanItemStates.itemId} = ${dailyPlanItems.id}
        order by candidate_plans.local_date desc, candidate_plans.plan_id desc,
          ${dailyPlanItems.position} asc nulls last
        limit ${rowLimit}
      `,
    )) as unknown as readonly DailyPlanFitEvidenceDatabaseRow[];
    if (rows.length > maximumRows) {
      throw new DomainError(
        "daily_plan_fit_insight.item_pool_too_large",
        "Daily Plan Fit evidence exceeds the bounded item pool.",
      );
    }

    const positiveInteger = (value: unknown, maximum: number): number | null => {
      const text = typeof value === "number" ? String(value) : value;
      if (typeof text !== "string" || !/^[1-9][0-9]*$/.test(text)) return null;
      const parsed = Number(text);
      return Number.isSafeInteger(parsed) && parsed <= maximum ? parsed : null;
    };
    const byPlan = new Map<
      string,
      {
        readonly evidence: {
          workspaceId: WorkspaceId;
          planId: DailyPlan["id"];
          date: LocalDate;
          targetMinutes: number;
          targetTaskCount: number;
          items: DailyPlanFitEvidencePlan["items"][number][];
        };
        readonly itemIds: Set<string>;
        invalid: boolean;
      }
    >();
    const invalidPlanIds = new Set<string>();

    for (const row of rows) {
      const targetMinutes = positiveInteger(row.targetMinutes, 43_200);
      const targetTaskCount = positiveInteger(row.targetTaskCount, 512);
      if (targetMinutes === null || targetTaskCount === null) {
        invalidPlanIds.add(row.planId);
        byPlan.delete(row.planId);
        continue;
      }
      if (invalidPlanIds.has(row.planId)) continue;
      let grouped = byPlan.get(row.planId);
      if (grouped === undefined) {
        grouped = {
          evidence: {
            workspaceId: workspace,
            planId: dailyPlanId(row.planId),
            date: localDate(row.localDate),
            targetMinutes,
            targetTaskCount,
            items: [],
          },
          itemIds: new Set(),
          invalid: false,
        };
        byPlan.set(row.planId, grouped);
      }
      if (row.itemId === null) continue;
      if (
        row.scheduledMinutes === null ||
        !Number.isSafeInteger(row.scheduledMinutes) ||
        row.scheduledMinutes < 1 ||
        grouped.itemIds.has(row.itemId)
      ) {
        grouped.invalid = true;
        continue;
      }
      if (grouped.itemIds.size >= dailyPlanFitInsightMaximumItemsPerPlan) {
        throw new DomainError(
          "daily_plan_fit_insight.item_limit_exceeded",
          "A Plan Fit evidence plan exceeds the bounded item limit.",
        );
      }
      grouped.itemIds.add(row.itemId);
      const activityState = planItemActivityStates.some((state) => state === row.activityState)
        ? (row.activityState as DailyPlanFitEvidencePlan["items"][number]["activityState"])
        : "pending";
      grouped.evidence.items.push({
        id: planItemId(row.itemId),
        scheduledMinutes: row.scheduledMinutes,
        activityState,
        lastActivityEventId:
          row.lastActivityEventId === null ? null : activityEventId(row.lastActivityEventId),
      });
    }
    return [...byPlan.values()]
      .filter((grouped) => !grouped.invalid)
      .map((grouped) => grouped.evidence);
  }

  async setItemLock(input: SetPlanItemLockInput): Promise<PlanItemLockResult> {
    const payloadHash = createHash("sha256")
      .update(
        JSON.stringify({
          date: input.date,
          expectedPlanId: input.expectedPlanId,
          itemId: input.itemId,
          expectedHeadVersion: input.expectedHeadVersion,
          locked: input.locked,
        }),
      )
      .digest("hex");
    await this.database.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${input.workspaceId}:${input.date}`}, 0))`,
    );
    const [prior] = await this.database
      .select()
      .from(planInteractionEvents)
      .where(
        and(
          eq(planInteractionEvents.workspaceId, input.workspaceId),
          eq(planInteractionEvents.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);
    if (prior !== undefined) {
      if (prior.payloadHash !== payloadHash) {
        throw new DomainError(
          "planning.idempotency_conflict",
          "This plan interaction key already belongs to a different command.",
        );
      }
      return {
        planId: dailyPlanId(prior.planId),
        itemId: planItemId(prior.itemId),
        locked: prior.type === "locked",
        headVersion: prior.resultHeadVersion,
      };
    }
    const [head] = await this.database
      .select()
      .from(dailyPlanHeads)
      .where(
        and(
          eq(dailyPlanHeads.workspaceId, input.workspaceId),
          eq(dailyPlanHeads.localDate, input.date),
        ),
      )
      .limit(1);
    if (head === undefined) {
      throw new DomainError("planning.current_not_found", "No current plan exists for this date.");
    }
    if (head.currentPlanId !== input.expectedPlanId || head.version !== input.expectedHeadVersion) {
      throw new DomainError(
        "planning.head_conflict",
        "The current plan changed before this interaction could be applied.",
      );
    }
    const [item] = await this.database
      .select()
      .from(dailyPlanItems)
      .where(
        and(
          eq(dailyPlanItems.workspaceId, input.workspaceId),
          eq(dailyPlanItems.planId, input.expectedPlanId),
          eq(dailyPlanItems.id, input.itemId),
        ),
      )
      .limit(1);
    if (item === undefined) {
      throw new DomainError("planning.item_not_found", "The plan item does not exist.");
    }
    const [state] = await this.database
      .select()
      .from(dailyPlanItemStates)
      .where(
        and(
          eq(dailyPlanItemStates.workspaceId, input.workspaceId),
          eq(dailyPlanItemStates.planId, input.expectedPlanId),
          eq(dailyPlanItemStates.itemId, input.itemId),
        ),
      )
      .limit(1);
    const changed = (state?.locked ?? false) !== input.locked;
    const resultHeadVersion = changed ? head.version + 1 : head.version;
    if (state === undefined) {
      await this.database.insert(dailyPlanItemStates).values({
        workspaceId: input.workspaceId,
        planId: input.expectedPlanId,
        itemId: input.itemId,
        locked: input.locked,
        version: 1,
        updatedAt: input.now,
      });
    } else if (changed) {
      await this.database
        .update(dailyPlanItemStates)
        .set({ locked: input.locked, version: state.version + 1, updatedAt: input.now })
        .where(eq(dailyPlanItemStates.id, state.id));
    }
    if (changed) {
      const updated = await this.database
        .update(dailyPlanHeads)
        .set({ version: resultHeadVersion, updatedAt: input.now })
        .where(and(eq(dailyPlanHeads.id, head.id), eq(dailyPlanHeads.version, head.version)))
        .returning({ id: dailyPlanHeads.id });
      if (updated.length === 0) {
        throw new DomainError(
          "planning.write_conflict",
          "The plan interaction could not update the current head.",
        );
      }
    }
    await this.database.insert(planInteractionEvents).values({
      workspaceId: input.workspaceId,
      localDate: input.date,
      planId: input.expectedPlanId,
      itemId: input.itemId,
      type: input.locked ? "locked" : "unlocked",
      idempotencyKey: input.idempotencyKey,
      payloadHash,
      resultHeadVersion,
      recordedAt: input.now,
    });
    return {
      planId: input.expectedPlanId,
      itemId: input.itemId,
      locked: input.locked,
      headVersion: resultHeadVersion,
    };
  }

  async recordItemActivity(
    input: RecordPlanItemActivityInput,
  ): Promise<RecordedPlanItemActivityResult> {
    const normalizedReason = input.reason?.trim() || null;
    const payloadHash = createHash("sha256")
      .update(
        JSON.stringify({
          date: input.date,
          expectedPlanId: input.expectedPlanId,
          itemId: input.itemId,
          expectedHeadVersion: input.expectedHeadVersion,
          type: input.type,
          occurredAt: input.occurredAt.getTime(),
          timeZone: input.timeZone,
          durationMinutes: input.durationMinutes,
          reason: normalizedReason,
          metadata: canonicalMetadata(input.metadata),
        }),
      )
      .digest("hex");
    await this.lockDay(input.workspaceId, input.date);
    const [prior] = await this.database
      .select()
      .from(planInteractionEvents)
      .where(
        and(
          eq(planInteractionEvents.workspaceId, input.workspaceId),
          eq(planInteractionEvents.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);
    if (prior !== undefined) {
      if (prior.payloadHash !== payloadHash) {
        throw new DomainError(
          "planning.idempotency_conflict",
          "This plan interaction key already belongs to a different command.",
        );
      }
      if (prior.activityEventId === null || !isPlanItemActivityActionType(prior.type)) {
        throw new DomainError(
          "planning.activity_result_not_found",
          "The recorded plan item activity result is unavailable.",
        );
      }
      const [activity] = await this.database
        .select()
        .from(activityEvents)
        .where(
          and(
            eq(activityEvents.workspaceId, input.workspaceId),
            eq(activityEvents.id, prior.activityEventId),
          ),
        )
        .limit(1);
      if (activity === undefined) {
        throw new DomainError(
          "planning.activity_result_not_found",
          "The recorded plan item activity result is unavailable.",
        );
      }
      return {
        planId: dailyPlanId(prior.planId),
        itemId: planItemId(prior.itemId),
        activityState: prior.type === "completion_reversed" ? "pending" : prior.type,
        activityEvent: mapActivityEvent(activity),
        headVersion: prior.resultHeadVersion,
        replayed: true,
      };
    }
    const [head] = await this.database
      .select()
      .from(dailyPlanHeads)
      .where(
        and(
          eq(dailyPlanHeads.workspaceId, input.workspaceId),
          eq(dailyPlanHeads.localDate, input.date),
        ),
      )
      .limit(1);
    if (head === undefined) {
      throw new DomainError("planning.current_not_found", "No current plan exists for this date.");
    }
    if (head.currentPlanId !== input.expectedPlanId || head.version !== input.expectedHeadVersion) {
      throw new DomainError(
        "planning.head_conflict",
        "The current plan changed before this interaction could be applied.",
      );
    }
    const [item] = await this.database
      .select()
      .from(dailyPlanItems)
      .where(
        and(
          eq(dailyPlanItems.workspaceId, input.workspaceId),
          eq(dailyPlanItems.planId, input.expectedPlanId),
          eq(dailyPlanItems.id, input.itemId),
        ),
      )
      .limit(1);
    if (item === undefined) {
      throw new DomainError("planning.item_not_found", "The plan item does not exist.");
    }
    const [state] = await this.database
      .select()
      .from(dailyPlanItemStates)
      .where(
        and(
          eq(dailyPlanItemStates.workspaceId, input.workspaceId),
          eq(dailyPlanItemStates.planId, input.expectedPlanId),
          eq(dailyPlanItemStates.itemId, input.itemId),
        ),
      )
      .limit(1);
    const currentActivityState = state?.activityState ?? "pending";
    const activityState =
      input.type === "completion_reversed"
        ? reversePlanItemCompletion(currentActivityState)
        : transitionPlanItemActivity(currentActivityState, input.type);
    const referenceEventId =
      input.type === "completion_reversed" ? (state?.lastActivityEventId ?? null) : null;
    let sourceWorkItem: WorkItemRow | undefined;
    if (item.sourceType === "work_item") {
      if (item.workItemId === null) {
        throw new DomainError(
          "planning.item_source_invalid",
          "The plan item has no work item source.",
        );
      }
      [sourceWorkItem] = await this.database
        .select()
        .from(workItems)
        .where(and(eq(workItems.workspaceId, input.workspaceId), eq(workItems.id, item.workItemId)))
        .limit(1);
      if (sourceWorkItem === undefined) {
        throw new DomainError(
          "planning.item_source_not_found",
          "The source work item does not exist.",
        );
      }
    }

    let reversalSourceEvent: ActivityEventRow | undefined;
    if (input.type === "completion_reversed" && item.sourceType === "work_item") {
      if (referenceEventId === null || referenceEventId === undefined) {
        throw new DomainError(
          "activity.reference_not_found",
          "The completion being reversed is unavailable.",
        );
      }
      [reversalSourceEvent] = await this.database
        .select()
        .from(activityEvents)
        .where(
          and(
            eq(activityEvents.workspaceId, input.workspaceId),
            eq(activityEvents.id, referenceEventId),
          ),
        )
        .limit(1);
    }
    const sourceWorkStatus = sourceWorkItem?.status;
    const sourceWorkVersion = sourceWorkItem?.version;
    const isCompletion = input.type === "completed" && sourceWorkItem !== undefined;
    const canAutoCompleteWorkItem =
      sourceWorkStatus === "backlog" ||
      sourceWorkStatus === "planned" ||
      sourceWorkStatus === "in_progress";
    const completionCanOwnWorkItem =
      isCompletion && (canAutoCompleteWorkItem || sourceWorkStatus === "done");
    const completionChangedWorkItem = completionCanOwnWorkItem && canAutoCompleteWorkItem;
    const completionOwnershipVersion =
      sourceWorkVersion === undefined
        ? null
        : completionCanOwnWorkItem
          ? sourceWorkVersion + 1
          : sourceWorkVersion;
    const eventMetadata =
      sourceWorkItem === undefined
        ? input.metadata
        : {
            ...input.metadata,
            "system.work_item.completion_changed": completionChangedWorkItem,
            "system.work_item.completion_ownership_version": completionOwnershipVersion,
            // Retained so events written by the first unified-planning release remain reversible.
            "system.work_item.completion_version": completionOwnershipVersion,
            "system.work_item.previous_status": sourceWorkItem.status,
          };
    const activityEvent = await new PostgresActivityEventRepository(this.database).append(
      recordActivityEvent({
        workspaceId: input.workspaceId,
        sourceType: item.sourceType,
        routineId: item.routineId === null ? null : routineId(item.routineId),
        workItemId: item.workItemId === null ? null : workItemId(item.workItemId),
        planId: input.expectedPlanId,
        planItemId: input.itemId,
        type: input.type,
        occurredAt: input.occurredAt,
        timeZone: input.timeZone,
        durationMinutes: input.durationMinutes,
        reason: normalizedReason,
        referenceEventId:
          referenceEventId === null || referenceEventId === undefined
            ? null
            : activityEventId(referenceEventId),
        idempotencyKey: input.idempotencyKey,
        metadata: eventMetadata,
        recordedAt: input.now,
      }),
    );
    if (completionCanOwnWorkItem && sourceWorkItem !== undefined) {
      const updatedWorkItem = await this.database
        .update(workItems)
        .set({ status: "done", version: sourceWorkItem.version + 1, updatedAt: input.now })
        .where(
          and(
            eq(workItems.workspaceId, input.workspaceId),
            eq(workItems.id, sourceWorkItem.id),
            eq(workItems.status, sourceWorkItem.status),
            eq(workItems.version, sourceWorkItem.version),
          ),
        )
        .returning({ id: workItems.id });
      if (updatedWorkItem.length === 0) {
        throw new DomainError(
          "work_item.version_conflict",
          "The source work item changed before completion could be recorded.",
        );
      }
    }
    if (input.type === "completion_reversed" && sourceWorkItem !== undefined) {
      const metadata = reversalSourceEvent?.metadata ?? {};
      const previousStatus = metadata["system.work_item.previous_status"];
      const completionVersion =
        metadata["system.work_item.completion_ownership_version"] ??
        metadata["system.work_item.completion_version"];
      if (
        metadata["system.work_item.completion_changed"] === true &&
        typeof previousStatus === "string" &&
        typeof completionVersion === "number" &&
        Number.isInteger(completionVersion)
      ) {
        // A version/status guard means a later edit always wins over the reversal.
        await this.database
          .update(workItems)
          .set({
            status: previousStatus as WorkItemStatus,
            version: completionVersion + 1,
            updatedAt: input.now,
          })
          .where(
            and(
              eq(workItems.workspaceId, input.workspaceId),
              eq(workItems.id, sourceWorkItem.id),
              eq(workItems.status, "done"),
              eq(workItems.version, completionVersion),
            ),
          );
      }
    }
    if (state === undefined) {
      await this.database.insert(dailyPlanItemStates).values({
        workspaceId: input.workspaceId,
        planId: input.expectedPlanId,
        itemId: input.itemId,
        activityState,
        lastActivityEventId: activityEvent.id,
        activityUpdatedAt: input.now,
        version: 1,
        updatedAt: input.now,
      });
    } else {
      await this.database
        .update(dailyPlanItemStates)
        .set({
          activityState,
          lastActivityEventId: activityEvent.id,
          activityUpdatedAt: input.now,
          version: state.version + 1,
          updatedAt: input.now,
        })
        .where(eq(dailyPlanItemStates.id, state.id));
    }
    const resultHeadVersion = head.version + 1;
    const updated = await this.database
      .update(dailyPlanHeads)
      .set({ version: resultHeadVersion, updatedAt: input.now })
      .where(and(eq(dailyPlanHeads.id, head.id), eq(dailyPlanHeads.version, head.version)))
      .returning({ id: dailyPlanHeads.id });
    if (updated.length === 0) {
      throw new DomainError(
        "planning.write_conflict",
        "The plan interaction could not update the current head.",
      );
    }
    await this.database.insert(planInteractionEvents).values({
      workspaceId: input.workspaceId,
      localDate: input.date,
      planId: input.expectedPlanId,
      itemId: input.itemId,
      type: input.type,
      activityEventId: activityEvent.id,
      idempotencyKey: input.idempotencyKey,
      payloadHash,
      resultHeadVersion,
      recordedAt: input.now,
    });
    return {
      planId: input.expectedPlanId,
      itemId: input.itemId,
      activityState,
      activityEvent,
      headVersion: resultHeadVersion,
      replayed: false,
    };
  }

  async lockDay(workspace: WorkspaceId, date: LocalDate): Promise<void> {
    await this.database.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${workspace}:${date}`}, 0))`,
    );
  }

  async findMutation(
    workspace: WorkspaceId,
    date: LocalDate,
    idempotencyKey: string,
  ): Promise<PlanMutationRecord | null> {
    const [row] = await this.database
      .select()
      .from(planMutations)
      .where(
        and(
          eq(planMutations.workspaceId, workspace),
          eq(planMutations.localDate, date),
          eq(planMutations.idempotencyKey, idempotencyKey),
        ),
      )
      .limit(1);
    return row === undefined
      ? null
      : {
          workspaceId: workspaceId(row.workspaceId),
          date: localDate(row.localDate),
          idempotencyKey: row.idempotencyKey,
          payloadHash: row.payloadHash,
          kind: row.kind,
          sourcePlanId: dailyPlanId(row.sourcePlanId),
          resultPlanId: dailyPlanId(row.resultPlanId),
          resultHeadVersion: row.resultHeadVersion,
          createdAt: new Date(row.createdAt),
        };
  }

  async insertMutation(record: PlanMutationRecord): Promise<void> {
    await this.database.insert(planMutations).values({
      workspaceId: record.workspaceId,
      localDate: record.date,
      idempotencyKey: record.idempotencyKey,
      payloadHash: record.payloadHash,
      kind: record.kind,
      sourcePlanId: record.sourcePlanId,
      resultPlanId: record.resultPlanId,
      resultHeadVersion: record.resultHeadVersion,
      createdAt: record.createdAt,
    });
  }

  async listRoutineFeedbackForPlanning(
    workspace: WorkspaceId,
    throughDate: LocalDate,
  ): Promise<readonly RoutinePlanningFeedback[]> {
    const rows = await this.database
      .selectDistinctOn([
        routinePlanningFeedbackEvents.workspaceId,
        routinePlanningFeedbackEvents.routineId,
      ])
      .from(routinePlanningFeedbackEvents)
      .where(
        and(
          eq(routinePlanningFeedbackEvents.workspaceId, workspace),
          lte(routinePlanningFeedbackEvents.effectiveOn, throughDate),
        ),
      )
      .orderBy(
        routinePlanningFeedbackEvents.workspaceId,
        routinePlanningFeedbackEvents.routineId,
        desc(routinePlanningFeedbackEvents.ingestedSequence),
        desc(routinePlanningFeedbackEvents.id),
      )
      .limit(501);
    if (rows.length > 500) {
      throw new DomainError(
        "planning.feedback_candidate_limit_exceeded",
        "A workspace cannot contain feedback for more than 500 planning routines.",
      );
    }
    return rows.map(mapRoutinePlanningFeedback);
  }

  async lockRoutineFeedback(workspace: WorkspaceId, routine: Routine["id"]): Promise<void> {
    await this.database.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`${workspace}:planning-feedback:${routine}`}, 0))`,
    );
  }

  async findLatestRoutineFeedback(
    workspace: WorkspaceId,
    routine: Routine["id"],
  ): Promise<RoutinePlanningFeedback | null> {
    const [row] = await this.database
      .select()
      .from(routinePlanningFeedbackEvents)
      .where(
        and(
          eq(routinePlanningFeedbackEvents.workspaceId, workspace),
          eq(routinePlanningFeedbackEvents.routineId, routine),
        ),
      )
      .orderBy(
        desc(routinePlanningFeedbackEvents.ingestedSequence),
        desc(routinePlanningFeedbackEvents.id),
      )
      .limit(1);
    return row === undefined ? null : mapRoutinePlanningFeedback(row);
  }

  async appendRoutineFeedback(feedback: RoutinePlanningFeedback): Promise<RoutinePlanningFeedback> {
    const [inserted] = await this.database
      .insert(routinePlanningFeedbackEvents)
      .values({
        id: feedback.id,
        workspaceId: feedback.workspaceId,
        routineId: feedback.routineId,
        kind: feedback.kind,
        effectiveOn: feedback.effectiveOn,
        effectiveThrough: feedback.effectiveThrough,
        timeZone: feedback.timeZone,
        sourcePlanId: feedback.sourcePlanId,
        sourcePlanItemId: feedback.sourcePlanItemId,
        idempotencyKey: feedback.idempotencyKey,
        recordedAt: feedback.recordedAt,
      })
      .onConflictDoNothing({
        target: [
          routinePlanningFeedbackEvents.workspaceId,
          routinePlanningFeedbackEvents.effectiveOn,
          routinePlanningFeedbackEvents.idempotencyKey,
        ],
      })
      .returning();
    if (inserted !== undefined) return mapRoutinePlanningFeedback(inserted);

    const [existingRow] = await this.database
      .select()
      .from(routinePlanningFeedbackEvents)
      .where(
        and(
          eq(routinePlanningFeedbackEvents.workspaceId, feedback.workspaceId),
          eq(routinePlanningFeedbackEvents.effectiveOn, feedback.effectiveOn),
          eq(routinePlanningFeedbackEvents.idempotencyKey, feedback.idempotencyKey),
        ),
      )
      .limit(1);
    if (existingRow === undefined) {
      throw new DomainError(
        "planning.feedback_write_conflict",
        "The routine planning feedback could not be appended or loaded.",
      );
    }
    const existing = mapRoutinePlanningFeedback(existingRow);
    const sameFeedback =
      existing.workspaceId === feedback.workspaceId &&
      existing.routineId === feedback.routineId &&
      existing.kind === feedback.kind &&
      existing.effectiveOn === feedback.effectiveOn &&
      existing.effectiveThrough === feedback.effectiveThrough &&
      existing.timeZone === feedback.timeZone &&
      existing.sourcePlanId === feedback.sourcePlanId &&
      existing.sourcePlanItemId === feedback.sourcePlanItemId;
    if (!sameFeedback) {
      throw new DomainError(
        "planning.idempotency_conflict",
        "This feedback idempotency key already belongs to a different planning instruction.",
      );
    }
    return existing;
  }
}

export class PostgresIntegrationCredentialRepository implements IntegrationCredentialRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async findById(id: string): Promise<IntegrationCredential | null> {
    const [row] = await this.database
      .select()
      .from(integrationCredentials)
      .where(eq(integrationCredentials.id, id))
      .limit(1);
    return row === undefined ? null : mapIntegrationCredential(row);
  }

  async findByIdForUpdate(id: string): Promise<IntegrationCredential | null> {
    const [row] = await this.database
      .select()
      .from(integrationCredentials)
      .where(eq(integrationCredentials.id, id))
      .limit(1)
      .for("update");
    return row === undefined ? null : mapIntegrationCredential(row);
  }

  async list(workspace: WorkspaceId): Promise<readonly IntegrationCredential[]> {
    const rows = await this.database
      .select()
      .from(integrationCredentials)
      .where(eq(integrationCredentials.workspaceId, workspace))
      .orderBy(asc(integrationCredentials.createdAt), asc(integrationCredentials.id));
    return rows.map(mapIntegrationCredential);
  }

  async insert(credential: IntegrationCredential): Promise<void> {
    await this.database.insert(integrationCredentials).values({
      id: credential.id,
      workspaceId: credential.workspaceId,
      name: credential.name,
      secretDigest: credential.secretHash,
      scopes: [...credential.scopes],
      active: credential.active,
      expiresAt: credential.expiresAt,
      revokedAt: credential.revokedAt,
      version: credential.version,
      createdAt: credential.createdAt,
      updatedAt: credential.updatedAt,
    });
  }

  async save(credential: IntegrationCredential, expectedVersion: number): Promise<void> {
    const updated = await this.database
      .update(integrationCredentials)
      .set({
        name: credential.name,
        secretDigest: credential.secretHash,
        scopes: [...credential.scopes],
        active: credential.active,
        expiresAt: credential.expiresAt,
        revokedAt: credential.revokedAt,
        version: credential.version,
        updatedAt: credential.updatedAt,
      })
      .where(
        and(
          eq(integrationCredentials.id, credential.id),
          eq(integrationCredentials.workspaceId, credential.workspaceId),
          eq(integrationCredentials.version, expectedVersion),
        ),
      )
      .returning({ id: integrationCredentials.id });
    if (updated.length === 0) {
      throw new DomainError(
        "integration.credential_version_conflict",
        "The integration credential changed before this update could be saved.",
      );
    }
  }
}

export class PostgresIntegrationConfirmationRepository implements IntegrationConfirmationRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async findByRequestId(
    credentialId: string,
    requestId: string,
  ): Promise<IntegrationConfirmationRecord | null> {
    const [row] = await this.database
      .select()
      .from(integrationConfirmations)
      .where(
        and(
          eq(integrationConfirmations.credentialId, credentialId),
          eq(integrationConfirmations.requestId, requestId),
        ),
      )
      .limit(1);
    return row === undefined ? null : mapIntegrationConfirmation(row);
  }

  async findByIdForUpdate(
    credentialId: string,
    confirmationId: string,
  ): Promise<IntegrationConfirmationRecord | null> {
    const [row] = await this.database
      .select()
      .from(integrationConfirmations)
      .where(
        and(
          eq(integrationConfirmations.credentialId, credentialId),
          eq(integrationConfirmations.id, confirmationId),
        ),
      )
      .limit(1)
      .for("update");
    return row === undefined ? null : mapIntegrationConfirmation(row);
  }

  async insertOrFind(record: IntegrationConfirmationRecord): Promise<{
    readonly kind: "inserted" | "existing";
    readonly confirmation: IntegrationConfirmationRecord;
  }> {
    const [row] = await this.database
      .insert(integrationConfirmations)
      .values({
        id: record.id,
        workspaceId: record.workspaceId,
        credentialId: record.credentialId,
        requestId: record.requestId,
        commandHash: record.commandHash,
        commandKind: record.command.type,
        command: record.command as unknown as Record<string, unknown>,
        summary: record.summary,
        expiresAt: record.expiresAt,
        consumedAt: record.consumedAt,
        createdAt: record.createdAt,
        updatedAt: record.createdAt,
      })
      .onConflictDoUpdate({
        target: [integrationConfirmations.credentialId, integrationConfirmations.requestId],
        // A no-op update both locks and returns a concurrently inserted receipt.
        set: { requestId: sql`${integrationConfirmations.requestId}` },
      })
      .returning({
        ...getTableColumns(integrationConfirmations),
        inserted: sql<boolean>`xmax = 0`.as("inserted"),
      });
    if (row === undefined) {
      throw new DomainError(
        "integration.confirmation_write_conflict",
        "The confirmation could not be persisted.",
      );
    }
    return {
      kind: row.inserted ? "inserted" : "existing",
      confirmation: mapIntegrationConfirmation(row),
    };
  }

  async consume(credentialId: string, confirmationId: string, consumedAt: Date): Promise<boolean> {
    const consumed = await this.database
      .update(integrationConfirmations)
      .set({ consumedAt, updatedAt: consumedAt })
      .where(
        and(
          eq(integrationConfirmations.credentialId, credentialId),
          eq(integrationConfirmations.id, confirmationId),
          isNull(integrationConfirmations.consumedAt),
          gt(integrationConfirmations.expiresAt, consumedAt),
        ),
      )
      .returning({ id: integrationConfirmations.id });
    return consumed.length === 1;
  }
}

export class PostgresIntegrationRequestRepository implements IntegrationRequestRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async reserve(input: IntegrationRequestReservationInput): Promise<{
    readonly kind: "reserved" | "replay";
    readonly request: IntegrationRequestRecord;
  }> {
    const [row] = await this.database
      .insert(integrationRequests)
      .values({
        id: input.id,
        workspaceId: input.workspaceId,
        credentialId: input.credentialId,
        idempotencyKey: input.idempotencyKey,
        confirmationId: input.confirmationId,
        commandHash: input.commandHash,
        operation: input.operation,
        status: "processing",
        result: null,
        createdAt: input.createdAt,
        completedAt: null,
        updatedAt: input.createdAt,
      })
      .onConflictDoUpdate({
        target: [integrationRequests.credentialId, integrationRequests.idempotencyKey],
        // A no-op update serializes contenders while preserving the original receipt.
        set: { idempotencyKey: sql`${integrationRequests.idempotencyKey}` },
      })
      .returning({
        ...getTableColumns(integrationRequests),
        inserted: sql<boolean>`xmax = 0`.as("inserted"),
      });
    if (row === undefined) {
      throw new DomainError(
        "integration.receipt_write_conflict",
        "The integration request could not be reserved.",
      );
    }

    if (
      row.workspaceId !== input.workspaceId ||
      row.confirmationId !== input.confirmationId ||
      row.operation !== input.operation ||
      row.commandHash !== input.commandHash
    ) {
      throw new DomainError(
        "integration.receipt_conflict",
        "This idempotency key already belongs to a different integration command.",
      );
    }

    const request = mapIntegrationRequest(row);
    if (row.inserted) return { kind: "reserved", request };
    if (request.state === "processing") {
      throw new DomainError(
        "integration.receipt_in_progress",
        "This integration request is already being processed and cannot be executed again.",
      );
    }
    if (request.result === null || request.completedAt === null) {
      throw new DomainError(
        "integration.receipt_corrupt",
        "The completed integration request has no replayable result.",
      );
    }
    return { kind: "replay", request };
  }

  async succeed(
    id: string,
    result: ConfirmedIntegrationCommandResult,
    completedAt: Date,
  ): Promise<IntegrationRequestRecord> {
    const [current] = await this.database
      .select()
      .from(integrationRequests)
      .where(eq(integrationRequests.id, id))
      .limit(1)
      .for("update");
    if (current === undefined) {
      throw new DomainError(
        "integration.receipt_not_found",
        "The integration request reservation does not exist.",
      );
    }
    if (
      current.status !== "processing" ||
      result.confirmationId !== current.confirmationId ||
      result.operation !== current.operation ||
      result.commandHash !== current.commandHash
    ) {
      throw new DomainError(
        "integration.receipt_conflict",
        "The integration result does not match its request reservation.",
      );
    }
    const [updated] = await this.database
      .update(integrationRequests)
      .set({
        status: "succeeded",
        result: result as unknown as Record<string, unknown>,
        completedAt,
        updatedAt: completedAt,
      })
      .where(and(eq(integrationRequests.id, id), eq(integrationRequests.status, "processing")))
      .returning();
    if (updated === undefined) {
      throw new DomainError(
        "integration.receipt_write_conflict",
        "The integration request could not be completed.",
      );
    }
    return mapIntegrationRequest(updated);
  }
}

export class PostgresNaturalLanguageProposalRepository implements NaturalLanguageProposalRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async findByRequestId(
    targetWorkspaceId: WorkspaceId,
    requestId: string,
  ): Promise<NaturalLanguageProposalRecord | null> {
    const [row] = await this.database
      .select()
      .from(naturalLanguageProposals)
      .where(
        and(
          eq(naturalLanguageProposals.workspaceId, targetWorkspaceId),
          eq(naturalLanguageProposals.requestId, requestId),
        ),
      )
      .limit(1);
    return row === undefined ? null : mapNaturalLanguageProposal(row);
  }

  async findByIdForUpdate(
    targetWorkspaceId: WorkspaceId,
    proposalId: string,
  ): Promise<NaturalLanguageProposalRecord | null> {
    const [row] = await this.database
      .select()
      .from(naturalLanguageProposals)
      .where(
        and(
          eq(naturalLanguageProposals.workspaceId, targetWorkspaceId),
          eq(naturalLanguageProposals.id, proposalId),
        ),
      )
      .limit(1)
      .for("update");
    return row === undefined ? null : mapNaturalLanguageProposal(row);
  }

  async insertOrFind(record: NaturalLanguageProposalRecord): Promise<{
    readonly kind: "inserted" | "existing";
    readonly proposal: NaturalLanguageProposalRecord;
  }> {
    const [row] = await this.database
      .insert(naturalLanguageProposals)
      .values({
        id: record.id,
        workspaceId: record.workspaceId,
        requestId: record.requestId,
        promptHash: record.promptHash,
        commandHash: record.commandHash,
        reviewHash: record.reviewHash,
        modelSuggestionsHash: record.modelSuggestionsHash,
        commandDisplay: record.commandDisplay,
        command: record.command as unknown as Record<string, unknown>,
        modelSuggestions: record.modelSuggestions,
        reviewPriority: record.userSelection?.priority ?? "none",
        reviewDueOn: record.userSelection?.dueOn ?? null,
        reviewPlanningDurationMinutes: record.userSelection?.planningDurationMinutes ?? null,
        provider: record.provider,
        model: record.model,
        status: record.status,
        expiresAt: record.expiresAt,
        confirmationKeyHash: record.confirmationKeyHash,
        resultWorkItemId: record.resultWorkItemId,
        resultScheduleBlockId: record.resultScheduleBlockId,
        resultRoutineId: record.resultRoutineId,
        confirmedAt: record.confirmedAt,
        cancelledAt: record.cancelledAt,
        version: record.version,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
      })
      .onConflictDoUpdate({
        target: [naturalLanguageProposals.workspaceId, naturalLanguageProposals.requestId],
        // A no-op update serializes concurrent generation attempts and returns the winner.
        set: { requestId: sql`${naturalLanguageProposals.requestId}` },
      })
      .returning({
        ...getTableColumns(naturalLanguageProposals),
        inserted: sql<boolean>`xmax = 0`.as("inserted"),
      });
    if (row === undefined) {
      throw new DomainError(
        "natural_language.proposal_write_conflict",
        "The natural-language proposal could not be persisted.",
      );
    }
    return {
      kind: row.inserted ? "inserted" : "existing",
      proposal: mapNaturalLanguageProposal(row),
    };
  }

  async save(record: NaturalLanguageProposalRecord, expectedVersion: number): Promise<void> {
    const updated = await this.database
      .update(naturalLanguageProposals)
      .set({
        commandHash: record.commandHash,
        reviewHash: record.reviewHash,
        modelSuggestionsHash: record.modelSuggestionsHash,
        commandDisplay: record.commandDisplay,
        command: record.command as unknown as Record<string, unknown>,
        modelSuggestions: record.modelSuggestions,
        reviewPriority: record.userSelection?.priority ?? "none",
        reviewDueOn: record.userSelection?.dueOn ?? null,
        reviewPlanningDurationMinutes: record.userSelection?.planningDurationMinutes ?? null,
        provider: record.provider,
        model: record.model,
        status: record.status,
        expiresAt: record.expiresAt,
        confirmationKeyHash: record.confirmationKeyHash,
        resultWorkItemId: record.resultWorkItemId,
        resultScheduleBlockId: record.resultScheduleBlockId,
        resultRoutineId: record.resultRoutineId,
        confirmedAt: record.confirmedAt,
        cancelledAt: record.cancelledAt,
        version: record.version,
        updatedAt: record.updatedAt,
      })
      .where(
        and(
          eq(naturalLanguageProposals.id, record.id),
          eq(naturalLanguageProposals.workspaceId, record.workspaceId),
          eq(naturalLanguageProposals.version, expectedVersion),
        ),
      )
      .returning({ id: naturalLanguageProposals.id });
    if (updated.length === 0) {
      throw new DomainError(
        "natural_language.version_conflict",
        "The natural-language proposal changed before it could be saved.",
      );
    }
  }
}

class PostgresHostedMutationAuthorizationRepository implements HostedMutationAuthorizationRepository {
  constructor(private readonly database: DatabaseExecutor) {}

  async reauthorizeForUpdate(
    authorization: HostedWorkspaceAuthorization,
  ): Promise<HostedMutationAuthorizationDecision> {
    // This order matches identity administration (user before session), locks the workspace before
    // its cascading membership child, and leaves all product locks until after authorization.
    const [user] = await this.database
      .select({ status: hostedUsers.status })
      .from(hostedUsers)
      .where(eq(hostedUsers.id, authorization.userId))
      .limit(1)
      .for("update");
    const [session] = await this.database
      .select({
        userId: browserSessions.userId,
        idleExpiresAt: browserSessions.idleExpiresAt,
        absoluteExpiresAt: browserSessions.absoluteExpiresAt,
        revokedAt: browserSessions.revokedAt,
      })
      .from(browserSessions)
      .where(eq(browserSessions.id, authorization.sessionId))
      .limit(1)
      .for("update");
    const [workspace] = await this.database
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.id, authorization.workspaceId))
      .limit(1)
      .for("key share");
    const [membership] = await this.database
      .select({ status: workspaceMemberships.status })
      .from(workspaceMemberships)
      .where(
        and(
          eq(workspaceMemberships.userId, authorization.userId),
          eq(workspaceMemberships.workspaceId, authorization.workspaceId),
        ),
      )
      .limit(1)
      .for("update");
    const clockRows = await this.database.execute(
      sql<{ value: unknown }>`select clock_timestamp() as value`,
    );
    const clockValue = clockRows[0]?.value;
    const now =
      clockValue instanceof Date || typeof clockValue === "string" ? new Date(clockValue) : null;
    if (now === null || !Number.isFinite(now.getTime())) {
      throw new Error("Hosted mutation authorization received an invalid database timestamp.");
    }

    if (
      user?.status !== "active" ||
      session === undefined ||
      session.userId !== authorization.userId ||
      session.revokedAt !== null ||
      now.getTime() >= session.idleExpiresAt.getTime() ||
      now.getTime() >= session.absoluteExpiresAt.getTime()
    ) {
      return "authentication_failed";
    }
    if (workspace === undefined || membership?.status !== "active") {
      return "workspace_not_found";
    }
    return "authorized";
  }
}

function createTransactionContext(database: DatabaseExecutor): TransactionContext {
  return {
    workspaces: new PostgresWorkspaceRepository(database),
    workItems: new PostgresWorkItemRepository(database),
    workItemDependencies: new PostgresWorkItemDependencyRepository(database),
    scheduleBlocks: new PostgresScheduleBlockRepository(database),
    auditEvents: new PostgresAuditEventRepository(database),
    routines: new PostgresRoutineRepository(database),
    activityEvents: new PostgresActivityEventRepository(database),
    routineDurationInsightFeedback: new PostgresRoutineDurationInsightFeedbackRepository(database),
    dailyPlanFitInsightFeedback: new PostgresDailyPlanFitInsightFeedbackRepository(database),
    routineSelectionPreferenceFeedback: new PostgresRoutineSelectionPreferenceFeedbackRepository(
      database,
    ),
    dailyPlans: new PostgresDailyPlanRepository(database),
    notifications: new PostgresNotificationRepository(database),
  };
}

function createHostedMutationTransactionContext(
  database: DatabaseExecutor,
): HostedMutationTransactionContext {
  return {
    ...createTransactionContext(database),
    hostedMutationAuthorization: new PostgresHostedMutationAuthorizationRepository(database),
  };
}

function createIntegrationTransactionContext(
  database: DatabaseExecutor,
): IntegrationTransactionContext {
  return {
    credentials: new PostgresIntegrationCredentialRepository(database),
    confirmations: new PostgresIntegrationConfirmationRepository(database),
    requests: new PostgresIntegrationRequestRepository(database),
    notificationDeliveries: new PostgresNotificationDeliveryRepository(database),
    notificationDeliveryRequests: new PostgresNotificationDeliveryRequestRepository(database),
    workspaces: new PostgresWorkspaceRepository(database),
    workItems: new PostgresWorkItemRepository(database),
    workItemDependencies: new PostgresWorkItemDependencyRepository(database),
    scheduleBlocks: new PostgresScheduleBlockRepository(database),
    auditEvents: new PostgresAuditEventRepository(database),
    dailyPlans: new PostgresDailyPlanRepository(database),
    dailyPlanFitInsightFeedback: new PostgresDailyPlanFitInsightFeedbackRepository(database),
    notifications: new PostgresNotificationRepository(database),
  };
}

function createNaturalLanguageProposalTransactionContext(
  database: DatabaseExecutor,
): NaturalLanguageProposalTransactionContext {
  return {
    workspaces: new PostgresWorkspaceRepository(database),
    workItems: new PostgresWorkItemRepository(database),
    scheduleBlocks: new PostgresScheduleBlockRepository(database),
    routines: new PostgresRoutineRepository(database),
    auditEvents: new PostgresAuditEventRepository(database),
    proposals: new PostgresNaturalLanguageProposalRepository(database),
  };
}

const serializationRetryLimit = 7;

async function waitForSerializationRetry(retry: number): Promise<void> {
  const backoffMilliseconds = Math.min(100, 5 * 2 ** retry);
  const jitterMilliseconds = Math.floor(Math.random() * backoffMilliseconds);
  await new Promise<void>((resolve) => {
    setTimeout(resolve, backoffMilliseconds + jitterMilliseconds);
  });
}

export class PostgresUnitOfWork implements UnitOfWork {
  constructor(private readonly connection: DatabaseConnection) {}

  async run<Result>(
    operation: (context: TransactionContext) => Promise<Result>,
    options?: UnitOfWorkOptions,
  ): Promise<Result> {
    let retry = 0;
    while (true) {
      try {
        return await this.connection.db.transaction(
          async (transaction) => operation(createTransactionContext(transaction)),
          {
            isolationLevel:
              options?.isolationLevel === "read_committed" ? "read committed" : "serializable",
          },
        );
      } catch (error) {
        if (databaseErrorCode(error) !== "40001" || retry >= serializationRetryLimit) throw error;
        await waitForSerializationRetry(retry);
        retry += 1;
      }
    }
  }
}

/** Product repositories plus hosted reauthorization, all backed by one PostgreSQL transaction. */
export class PostgresHostedMutationUnitOfWork implements HostedMutationUnitOfWork {
  constructor(private readonly connection: DatabaseConnection) {}

  async run<Result>(
    operation: (context: HostedMutationTransactionContext) => Promise<Result>,
    options?: UnitOfWorkOptions,
  ): Promise<Result> {
    let retry = 0;
    while (true) {
      try {
        return await this.connection.db.transaction(
          async (transaction) => operation(createHostedMutationTransactionContext(transaction)),
          {
            isolationLevel:
              options?.isolationLevel === "read_committed" ? "read committed" : "serializable",
          },
        );
      } catch (error) {
        if (databaseErrorCode(error) !== "40001" || retry >= serializationRetryLimit) throw error;
        await waitForSerializationRetry(retry);
        retry += 1;
      }
    }
  }
}

export class PostgresIntegrationUnitOfWork implements IntegrationUnitOfWork {
  constructor(private readonly connection: DatabaseConnection) {}

  async run<Result>(
    operation: (context: IntegrationTransactionContext) => Promise<Result>,
    options?: UnitOfWorkOptions,
  ): Promise<Result> {
    let retry = 0;
    while (true) {
      try {
        return await this.connection.db.transaction(
          async (transaction) => operation(createIntegrationTransactionContext(transaction)),
          {
            isolationLevel:
              options?.isolationLevel === "read_committed" ? "read committed" : "serializable",
          },
        );
      } catch (error) {
        if (databaseErrorCode(error) !== "40001" || retry >= serializationRetryLimit) throw error;
        await waitForSerializationRetry(retry);
        retry += 1;
      }
    }
  }
}

export class PostgresNaturalLanguageProposalUnitOfWork implements NaturalLanguageProposalUnitOfWork {
  constructor(private readonly connection: DatabaseConnection) {}

  async run<Result>(
    operation: (context: NaturalLanguageProposalTransactionContext) => Promise<Result>,
    signal?: AbortSignal,
  ): Promise<Result> {
    let retry = 0;
    while (true) {
      try {
        signal?.throwIfAborted();
        return await this.connection.db.transaction(
          async (transaction) => {
            signal?.throwIfAborted();
            const result = await operation(
              createNaturalLanguageProposalTransactionContext(transaction),
            );
            signal?.throwIfAborted();
            return result;
          },
          { isolationLevel: "serializable" },
        );
      } catch (error) {
        if (databaseErrorCode(error) !== "40001" || retry >= serializationRetryLimit) throw error;
        await waitForSerializationRetry(retry);
        retry += 1;
      }
    }
  }
}
