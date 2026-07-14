import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type {
  AddWorkItemDependencyCommand,
  AddWorkItemDependencyResult,
  ApproveRoutineDurationInsightCommand,
  ApplyRoutinePlanningFeedbackCommand,
  ActivityHistoryCursor,
  ActivityHistoryPage,
  CreateRoutineCommand,
  CreateScheduleBlockCommand,
  CreateWorkItemCommand,
  CreateWorkspaceCommand,
  CurrentDailyPlan,
  ConfigureNotificationProfileCommand,
  CreateNotificationRuleCommand,
  CreateOneOffReminderCommand,
  DismissDailyPlanFitInsightCommand,
  DismissRoutineDurationInsightCommand,
  GenerateDailyPlanCommand,
  GetSchedulingAdviceCommand,
  GetCurrentDailyPlanQuery,
  GetDailyPlanQuery,
  GetDailyPlanFitInsightQuery,
  GetRoutineQuery,
  GetRoutineDurationInsightQuery,
  GetScheduleBlockQuery,
  GetWorkItemQuery,
  GetWorkspaceQuery,
  ListRoutineActivityQuery,
  ListRoutinesQuery,
  ListNotificationIntentsQuery,
  ListNotificationDeliveriesQuery,
  NotificationDeliveryHistoryItem,
  ListOneOffRemindersQuery,
  MaterializeNotificationIntentsCommand,
  MaterializeNotificationIntentsResult,
  ListScheduleBlocksQuery,
  ListWorkItemDependenciesQuery,
  ListWorkItemChildrenQuery,
  ListWorkItemsQuery,
  ListWorkspacesQuery,
  PlanItemLockResult,
  PlanItemActivityResult,
  RecordActivityEventCommand,
  RecordPlanItemActivityCommand,
  RegenerateDailyPlanCommand,
  ReplacePlanItemCommand,
  RemoveWorkItemDependencyCommand,
  ResetDailyPlanFitInsightDismissalCommand,
  ResetRoutineDurationInsightDismissalCommand,
  ResetRoutinePlanningFeedbackCommand,
  SetPlanItemLockCommand,
  UpdateRoutineCommand,
  UpdateNotificationRuleCommand,
  UpdateOneOffReminderCommand,
  CancelOneOffReminderCommand,
  CancelNaturalLanguageProposalCommand,
  ConfirmNaturalLanguageProposalCommand,
  ConfirmNaturalLanguageProposalResult,
  GenerateNaturalLanguageProposalCommand,
  GenerateNaturalLanguageProposalResult,
  PreparedNaturalLanguageProposal,
  UpdateNaturalLanguageProposalCommand,
  UpdateScheduleBlockCommand,
  UpdateWorkItemCommand,
  DeleteScheduleBlockCommand,
  ScheduleBlockPage,
  SchedulingAdviceResult,
  WorkItemPage,
  WorkItemChildrenPage,
  WorkItemDependencyPage,
  WorkspacePage,
} from "@schedule/application";
import {
  activityEventId,
  createCadencePolicy,
  createDailyPlanningRequest,
  createDurationRange,
  createStructuredTags,
  dailyPlanId,
  dailyPlanFitInsightKeyPattern,
  isValidLocalDate,
  localDate,
  notificationRuleId,
  oneOffReminderId,
  planItemId,
  routineId,
  routineDurationInsightKeyPattern,
  scheduleBlockId,
  workItemId,
  workspaceId,
  type ActivityEvent,
  type DailyPlan,
  type DailyPlanFitInsight,
  type DailyPlanFitInsightFeedback,
  type JsonValue,
  type NotificationIntent,
  type NotificationProfile,
  type NotificationRule,
  type OneOffReminder,
  type Routine,
  type RoutineDurationInsight,
  type RoutineDurationInsightFeedback,
  type ScheduleBlock,
  type WorkItem,
  type Workspace,
  type WorkspaceId,
  type Weekday,
} from "@schedule/domain";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import {
  parseRequest,
  RequestThrottledError,
  RequestValidationError,
  ResourceNotFoundError,
} from "./http-errors.js";

export interface ProductServices {
  addWorkItemDependency(
    command: AddWorkItemDependencyCommand,
  ): Promise<AddWorkItemDependencyResult>;
  approveRoutineDurationInsight(command: ApproveRoutineDurationInsightCommand): Promise<Routine>;
  dismissDailyPlanFitInsight(
    command: DismissDailyPlanFitInsightCommand,
  ): Promise<DailyPlanFitInsightFeedback>;
  dismissRoutineDurationInsight(
    command: DismissRoutineDurationInsightCommand,
  ): Promise<RoutineDurationInsightFeedback>;
  createWorkspace(command: CreateWorkspaceCommand): Promise<Workspace>;
  getWorkspace(query: GetWorkspaceQuery): Promise<Workspace>;
  listWorkspaces(query: ListWorkspacesQuery): Promise<WorkspacePage>;
  createRoutine(command: CreateRoutineCommand): Promise<Routine>;
  createWorkItem(command: CreateWorkItemCommand): Promise<WorkItem>;
  getWorkItem(query: GetWorkItemQuery): Promise<WorkItem>;
  listWorkItems(query: ListWorkItemsQuery): Promise<WorkItemPage>;
  listWorkItemChildren(query: ListWorkItemChildrenQuery): Promise<WorkItemChildrenPage>;
  listWorkItemDependencies(query: ListWorkItemDependenciesQuery): Promise<WorkItemDependencyPage>;
  removeWorkItemDependency(command: RemoveWorkItemDependencyCommand): Promise<void>;
  updateWorkItem(command: UpdateWorkItemCommand): Promise<WorkItem>;
  createScheduleBlock(command: CreateScheduleBlockCommand): Promise<ScheduleBlock>;
  getScheduleBlock(query: GetScheduleBlockQuery): Promise<ScheduleBlock>;
  listScheduleBlocks(query: ListScheduleBlocksQuery): Promise<ScheduleBlockPage>;
  updateScheduleBlock(command: UpdateScheduleBlockCommand): Promise<ScheduleBlock>;
  deleteScheduleBlock(command: DeleteScheduleBlockCommand): Promise<void>;
  getRoutine(query: GetRoutineQuery): Promise<Routine>;
  getRoutineDurationInsight(query: GetRoutineDurationInsightQuery): Promise<RoutineDurationInsight>;
  getDailyPlanFitInsight(query: GetDailyPlanFitInsightQuery): Promise<DailyPlanFitInsight>;
  resetDailyPlanFitInsightDismissal(
    command: ResetDailyPlanFitInsightDismissalCommand,
  ): Promise<DailyPlanFitInsightFeedback>;
  resetRoutineDurationInsightDismissal(
    command: ResetRoutineDurationInsightDismissalCommand,
  ): Promise<RoutineDurationInsightFeedback>;
  updateRoutine(command: UpdateRoutineCommand): Promise<Routine>;
  listRoutines(query: ListRoutinesQuery): Promise<readonly Routine[]>;
  listRoutineActivity(query: ListRoutineActivityQuery): Promise<ActivityHistoryPage>;
  recordActivityEvent(command: RecordActivityEventCommand): Promise<ActivityEvent>;
  recordPlanItemActivity(command: RecordPlanItemActivityCommand): Promise<PlanItemActivityResult>;
  generateDailyPlan(command: GenerateDailyPlanCommand): Promise<DailyPlan>;
  getCurrentDailyPlan(query: GetCurrentDailyPlanQuery): Promise<CurrentDailyPlan>;
  setPlanItemLock(command: SetPlanItemLockCommand): Promise<PlanItemLockResult>;
  regenerateDailyPlan(command: RegenerateDailyPlanCommand): Promise<CurrentDailyPlan>;
  replacePlanItem(command: ReplacePlanItemCommand): Promise<CurrentDailyPlan>;
  applyRoutineFeedback(command: ApplyRoutinePlanningFeedbackCommand): Promise<CurrentDailyPlan>;
  resetRoutineFeedback(command: ResetRoutinePlanningFeedbackCommand): Promise<CurrentDailyPlan>;
  getDailyPlan(query: GetDailyPlanQuery): Promise<DailyPlan | null>;
  getSchedulingAdvice(
    command: GetSchedulingAdviceCommand,
    signal?: AbortSignal,
  ): Promise<SchedulingAdviceResult>;
  generateNaturalLanguageProposal(
    command: GenerateNaturalLanguageProposalCommand,
    signal?: AbortSignal,
  ): Promise<GenerateNaturalLanguageProposalResult>;
  updateNaturalLanguageProposal(
    command: UpdateNaturalLanguageProposalCommand,
  ): Promise<PreparedNaturalLanguageProposal>;
  cancelNaturalLanguageProposal(
    command: CancelNaturalLanguageProposalCommand,
  ): Promise<PreparedNaturalLanguageProposal>;
  confirmNaturalLanguageProposal(
    command: ConfirmNaturalLanguageProposalCommand,
  ): Promise<ConfirmNaturalLanguageProposalResult>;
  configureNotificationProfile(
    command: ConfigureNotificationProfileCommand,
  ): Promise<NotificationProfile>;
  getNotificationProfile(workspaceId: WorkspaceId): Promise<NotificationProfile>;
  createNotificationRule(command: CreateNotificationRuleCommand): Promise<NotificationRule>;
  updateNotificationRule(command: UpdateNotificationRuleCommand): Promise<NotificationRule>;
  listNotificationRules(workspaceId: WorkspaceId): Promise<readonly NotificationRule[]>;
  createOneOffReminder(command: CreateOneOffReminderCommand): Promise<OneOffReminder>;
  updateOneOffReminder(command: UpdateOneOffReminderCommand): Promise<OneOffReminder>;
  cancelOneOffReminder(command: CancelOneOffReminderCommand): Promise<OneOffReminder>;
  listOneOffReminders(query: ListOneOffRemindersQuery): Promise<readonly OneOffReminder[]>;
  listNotificationIntents(
    query: ListNotificationIntentsQuery,
  ): Promise<readonly NotificationIntent[]>;
  listNotificationDeliveries(
    query: ListNotificationDeliveriesQuery,
  ): Promise<readonly NotificationDeliveryHistoryItem[]>;
  materializeNotificationIntents(
    command: MaterializeNotificationIntentsCommand,
  ): Promise<MaterializeNotificationIntentsResult>;
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "name" in error && error.name === "AbortError"
  );
}

export interface ProductApiLimits {
  readonly requestsPerMinute: number;
  readonly maxConcurrentPlans: number;
}

const DEFAULT_PRODUCT_API_LIMITS: ProductApiLimits = {
  requestsPerMinute: 240,
  maxConcurrentPlans: 2,
};

export const SCHEDULING_ADVICE_ROUTE = "/v1/workspaces/:workspaceId/advisor/advice";
export const NATURAL_LANGUAGE_PROPOSAL_ROUTE =
  "/v1/workspaces/:workspaceId/natural-language/proposals";
export const NATURAL_LANGUAGE_PROPOSAL_ITEM_ROUTE =
  "/v1/workspaces/:workspaceId/natural-language/proposals/:proposalId";
export const NATURAL_LANGUAGE_PROPOSAL_CANCELLATION_ROUTE =
  "/v1/workspaces/:workspaceId/natural-language/proposals/:proposalId/cancellations";
export const NATURAL_LANGUAGE_PROPOSAL_CONFIRMATION_ROUTE =
  "/v1/workspaces/:workspaceId/natural-language/proposals/:proposalId/confirmations";

function installRateLimit(app: FastifyInstance, requestsPerMinute: number): void {
  const buckets = new Map<string, { startedAt: number; count: number }>();
  let requestCount = 0;
  app.addHook("onRequest", async (request, reply) => {
    const now = Date.now();
    const current = buckets.get(request.ip);
    const bucket =
      current === undefined || now - current.startedAt >= 60_000
        ? { startedAt: now, count: 0 }
        : current;
    bucket.count += 1;
    buckets.set(request.ip, bucket);
    if (bucket.count > requestsPerMinute) {
      const retryAfterSeconds = Math.max(1, Math.ceil((60_000 - (now - bucket.startedAt)) / 1_000));
      reply.header("retry-after", String(retryAfterSeconds));
      throw new RequestThrottledError();
    }

    requestCount += 1;
    if (requestCount % 256 === 0) {
      for (const [address, candidate] of buckets) {
        if (now - candidate.startedAt >= 60_000) buckets.delete(address);
      }
    }
  });
}

const uuid = z
  .string()
  .uuid()
  .transform((value) => value.toLowerCase());
const localDateText = z
  .string()
  .refine(isValidLocalDate, "Expected a valid Gregorian date in YYYY-MM-DD format.");
const instant = z.string().datetime({ offset: true });
const workspaceParams = z.strictObject({ workspaceId: uuid });
const naturalLanguageProposalParams = z.strictObject({ workspaceId: uuid, proposalId: uuid });
const routineParams = z.strictObject({ workspaceId: uuid, routineId: uuid });
const workItemParams = z.strictObject({ workspaceId: uuid, workItemId: uuid });
const workItemDependencyParams = z.strictObject({
  workspaceId: uuid,
  workItemId: uuid,
  prerequisiteWorkItemId: uuid,
});
const scheduleBlockParams = z.strictObject({ workspaceId: uuid, scheduleBlockId: uuid });
const notificationRuleParams = z.strictObject({ workspaceId: uuid, notificationRuleId: uuid });
const oneOffReminderParams = z.strictObject({ workspaceId: uuid, oneOffReminderId: uuid });
const planParams = z.strictObject({ workspaceId: uuid, date: localDateText });
const planItemParams = z.strictObject({ workspaceId: uuid, date: localDateText, itemId: uuid });
const planRoutineParams = z.strictObject({
  workspaceId: uuid,
  date: localDateText,
  routineId: uuid,
});

const workspaceBody = z.strictObject({ name: z.string().trim().min(1).max(160) });
const workspaceQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(20).default(20),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
const workItemStatus = z.enum([
  "backlog",
  "planned",
  "in_progress",
  "blocked",
  "done",
  "cancelled",
]);
const workItemPriority = z.enum(["none", "low", "medium", "high", "urgent"]);
const workItemBody = z.strictObject({
  parentWorkItemId: uuid.nullable().default(null),
  title: z.string().trim().min(1).max(240),
  description: z.string().max(4_000).nullable().default(null),
  status: workItemStatus.default("backlog"),
  priority: workItemPriority.default("none"),
  dueOn: localDateText.nullable().default(null),
  planningDurationMinutes: z.number().int().positive().max(43_200).nullable().default(null),
});
const subtaskBody = workItemBody.omit({ parentWorkItemId: true });
const workItemQuery = z.strictObject({
  status: workItemStatus.optional(),
  priority: workItemPriority.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
const workItemDependencyQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
const workItemDependencyBody = z.strictObject({ prerequisiteWorkItemId: uuid });
const updateWorkItemBody = z
  .strictObject({
    expectedVersion: z.number().int().positive().max(2_147_483_647),
    parentWorkItemId: uuid.nullable().optional(),
    title: z.string().trim().min(1).max(240).optional(),
    description: z.string().max(4_000).nullable().optional(),
    status: workItemStatus.optional(),
    priority: workItemPriority.optional(),
    dueOn: localDateText.nullable().optional(),
    planningDurationMinutes: z.number().int().positive().max(43_200).nullable().optional(),
  })
  .refine(
    (body) =>
      body.parentWorkItemId !== undefined ||
      body.title !== undefined ||
      body.description !== undefined ||
      body.status !== undefined ||
      body.priority !== undefined ||
      body.dueOn !== undefined ||
      body.planningDurationMinutes !== undefined,
    { message: "At least one work item change is required." },
  );
const scheduleBlockBody = z.strictObject({
  workItemId: uuid.nullable().default(null),
  title: z.string().max(240).nullable().default(null),
  startsAt: instant,
  endsAt: instant,
  timeZone: z.string().trim().min(1).max(80),
});
const scheduleBlockQuery = z.strictObject({
  from: instant,
  to: instant,
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
const updateScheduleBlockBody = z
  .strictObject({
    expectedVersion: z.number().int().positive().max(2_147_483_647),
    workItemId: uuid.nullable().optional(),
    title: z.string().max(240).nullable().optional(),
    startsAt: instant.optional(),
    endsAt: instant.optional(),
    timeZone: z.string().trim().min(1).max(80).optional(),
  })
  .refine(
    (body) =>
      body.workItemId !== undefined ||
      body.title !== undefined ||
      body.startsAt !== undefined ||
      body.endsAt !== undefined ||
      body.timeZone !== undefined,
    { message: "At least one schedule block change is required." },
  );
const deleteScheduleBlockBody = z.strictObject({
  expectedVersion: z.number().int().positive().max(2_147_483_647),
});
const notificationProfileBody = z
  .strictObject({
    expectedVersion: z.number().int().positive().max(2_147_483_647).nullable(),
    enabled: z.boolean().optional(),
    timeZone: z.string().trim().min(1).max(80),
    quietHoursStartMinute: z.number().int().min(0).max(1_439).nullable().optional(),
    quietHoursEndMinute: z.number().int().min(0).max(1_439).nullable().optional(),
    quietHoursPolicy: z.enum(["skip", "next_allowed"]).optional(),
    catchUpWindowMinutes: z.number().int().min(0).max(10_080).optional(),
    dailyIntentLimit: z.number().int().min(1).max(100).optional(),
  })
  .refine(
    (body) => {
      const start = body.quietHoursStartMinute;
      const end = body.quietHoursEndMinute;
      return (
        (start === undefined && end === undefined) ||
        (start === null && end === null) ||
        (typeof start === "number" && typeof end === "number")
      );
    },
    { message: "Quiet-hours start and end must be supplied together." },
  );
const notificationRuleKind = z.enum([
  "daily_digest",
  "daily_follow_up",
  "plan_window_open",
  "schedule_block_lead",
  "work_item_due",
]);
const notificationRuleBody = z.strictObject({
  kind: notificationRuleKind,
  enabled: z.boolean().default(true),
  localMinute: z.number().int().min(0).max(1_439).nullable().default(null),
  leadMinutes: z.number().int().min(0).max(10_080).nullable().default(null),
  cooldownMinutes: z.number().int().min(0).max(10_080).default(0),
  priority: z.number().int().min(0).max(100).default(50),
});
const updateNotificationRuleBody = z
  .strictObject({
    expectedVersion: z.number().int().positive().max(2_147_483_647),
    enabled: z.boolean().optional(),
    localMinute: z.number().int().min(0).max(1_439).nullable().optional(),
    leadMinutes: z.number().int().min(0).max(10_080).nullable().optional(),
    cooldownMinutes: z.number().int().min(0).max(10_080).optional(),
    priority: z.number().int().min(0).max(100).optional(),
  })
  .refine(
    (body) =>
      body.enabled !== undefined ||
      body.localMinute !== undefined ||
      body.leadMinutes !== undefined ||
      body.cooldownMinutes !== undefined ||
      body.priority !== undefined,
    { message: "At least one notification rule change is required." },
  );
const oneOffReminderBody = z.strictObject({
  title: z.string().trim().min(1).max(240),
  scheduledFor: instant,
});
const updateOneOffReminderBody = z
  .strictObject({
    expectedVersion: z.number().int().positive().max(2_147_483_647),
    title: z.string().trim().min(1).max(240).optional(),
    scheduledFor: instant.optional(),
  })
  .refine((body) => body.title !== undefined || body.scheduledFor !== undefined, {
    message: "At least one one-off reminder change is required.",
  });
const cancelOneOffReminderBody = z.strictObject({
  expectedVersion: z.number().int().positive().max(2_147_483_647),
});
const notificationRangeQuery = z.strictObject({
  from: instant,
  to: instant,
});
const notificationIntentQuery = notificationRangeQuery.extend({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
const notificationDeliveryQuery = notificationRangeQuery.extend({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});
const notificationMaterializationBody = z.strictObject({
  from: instant,
  through: instant,
});
const tagsBody = z
  .strictObject({
    priority: z.enum(["low", "medium", "high", "critical"]).default("medium"),
    effort: z.enum(["quick", "short", "medium", "deep"]).default("medium"),
    energy: z.enum(["low", "normal", "high"]).default("normal"),
    preference: z.enum(["enjoyable", "neutral", "unpleasant"]).default("neutral"),
    contexts: z.array(z.string().min(1).max(64)).max(32).default([]),
    categories: z.array(z.string().min(1).max(64)).max(32).default([]),
    freeForm: z.array(z.string().min(1).max(64)).max(32).default([]),
  })
  .default({
    priority: "medium",
    effort: "medium",
    energy: "normal",
    preference: "neutral",
    contexts: [],
    categories: [],
    freeForm: [],
  });
const durationBody = z.strictObject({
  expectedMinutes: z.number().int().positive().max(43_200),
  minimumMinutes: z.number().int().positive().max(43_200).optional(),
  maximumMinutes: z.number().int().positive().max(43_200).optional(),
  splittable: z.boolean().default(false),
  minimumSessionMinutes: z.number().int().positive().max(43_200).nullable().default(null),
  overheadMinutes: z.number().int().nonnegative().max(1_440).default(0),
});
const cadenceBody = z.strictObject({
  period: z.enum(["day", "week", "month", "rolling_days"]),
  rollingIntervalDays: z.number().int().positive().max(3_650).nullable().default(null),
  targetCompletions: z.number().int().positive().max(10_000).default(1),
  minimumCompletions: z.number().int().positive().max(10_000).nullable().default(null),
  maximumCompletions: z.number().int().positive().max(10_000).nullable().default(null),
  minimumSpacingDays: z.number().int().nonnegative().max(3_650).default(0),
  preferredWeekdays: z.array(z.number().int().min(0).max(6)).max(7).default([]),
  excludedWeekdays: z.array(z.number().int().min(0).max(6)).max(7).default([]),
  discourageConsecutiveDays: z.boolean().default(false),
  prohibitConsecutiveDays: z.boolean().default(false),
  weekStartsOn: z.number().int().min(0).max(6).default(1),
  startsOn: localDateText.nullable().default(null),
  pausedUntil: localDateText.nullable().default(null),
  endsOn: localDateText.nullable().default(null),
});
const routineBody = z.strictObject({
  title: z.string().trim().min(1).max(240),
  description: z.string().max(4_000).nullable().default(null),
  status: z.enum(["active", "paused", "archived"]).default("active"),
  tags: tagsBody,
  duration: durationBody,
  cadence: cadenceBody,
});
const routineQuery = z.strictObject({
  status: z.enum(["active", "paused", "archived"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

const replacementTagsBody = z.strictObject({
  priority: z.enum(["low", "medium", "high", "critical"]),
  effort: z.enum(["quick", "short", "medium", "deep"]),
  energy: z.enum(["low", "normal", "high"]),
  preference: z.enum(["enjoyable", "neutral", "unpleasant"]),
  contexts: z.array(z.string().min(1).max(64)).max(32),
  categories: z.array(z.string().min(1).max(64)).max(32),
  freeForm: z.array(z.string().min(1).max(64)).max(32),
});
const replacementDurationBody = z.strictObject({
  expectedMinutes: z.number().int().positive().max(43_200),
  minimumMinutes: z.number().int().positive().max(43_200),
  maximumMinutes: z.number().int().positive().max(43_200),
  splittable: z.boolean(),
  minimumSessionMinutes: z.number().int().positive().max(43_200).nullable(),
  overheadMinutes: z.number().int().nonnegative().max(1_440),
});
const replacementCadenceBody = z.strictObject({
  period: z.enum(["day", "week", "month", "rolling_days"]),
  rollingIntervalDays: z.number().int().positive().max(3_650).nullable(),
  targetCompletions: z.number().int().positive().max(10_000),
  minimumCompletions: z.number().int().positive().max(10_000).nullable(),
  maximumCompletions: z.number().int().positive().max(10_000).nullable(),
  minimumSpacingDays: z.number().int().nonnegative().max(3_650),
  preferredWeekdays: z.array(z.number().int().min(0).max(6)).max(7),
  excludedWeekdays: z.array(z.number().int().min(0).max(6)).max(7),
  discourageConsecutiveDays: z.boolean(),
  prohibitConsecutiveDays: z.boolean(),
  weekStartsOn: z.number().int().min(0).max(6),
  startsOn: localDateText.nullable(),
  pausedUntil: localDateText.nullable(),
  endsOn: localDateText.nullable(),
});
const updateRoutineBody = z
  .strictObject({
    expectedVersion: z.number().int().positive().max(2_147_483_647),
    title: z.string().trim().min(1).max(240).optional(),
    description: z.string().max(4_000).nullable().optional(),
    status: z.enum(["active", "paused", "archived"]).optional(),
    tags: replacementTagsBody.optional(),
    duration: replacementDurationBody.optional(),
    cadence: replacementCadenceBody.optional(),
  })
  .refine(
    (body) =>
      body.title !== undefined ||
      body.description !== undefined ||
      body.status !== undefined ||
      body.tags !== undefined ||
      body.duration !== undefined ||
      body.cadence !== undefined,
    { message: "At least one routine change is required." },
  );
const approveRoutineDurationInsightBody = z.strictObject({
  expectedVersion: z.number().int().positive().max(2_147_483_647),
  duration: replacementDurationBody,
});
const routineDurationInsightFeedbackBody = z.strictObject({
  expectedVersion: z.number().int().positive().max(2_147_483_647),
  insightKey: z.string().regex(routineDurationInsightKeyPattern),
});
const dailyPlanFitInsightQuery = z.strictObject({ forDate: localDateText });
const dailyPlanFitInsightFeedbackBody = z.strictObject({
  forDate: localDateText,
  insightKey: z.string().regex(dailyPlanFitInsightKeyPattern),
});
const activityHistoryQuery = z.strictObject({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z
    .string()
    .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
    .max(1_024)
    .optional(),
});
const activityHistoryCursor = z.strictObject({
  v: z.literal(1),
  workspaceId: uuid,
  routineId: uuid,
  watermark: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  before: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

const metadataValue = z.union([z.string().max(256), z.number().finite(), z.boolean(), z.null()]);
const activityBody = z.strictObject({
  type: z.enum([
    "suggested",
    "accepted",
    "started",
    "completed",
    "skipped",
    "deferred",
    "dismissed",
    "duration_corrected",
    "completion_reversed",
  ]),
  occurredAt: instant,
  timeZone: z.string().trim().min(1).max(80),
  planId: uuid.nullable().default(null),
  durationMinutes: z.number().int().positive().max(43_200).nullable().default(null),
  reason: z.string().max(500).nullable().default(null),
  referenceEventId: uuid.nullable().default(null),
  metadata: z
    .record(z.string().min(1).max(64), metadataValue)
    .refine((value) => Object.keys(value).length <= 8, {
      message: "Metadata cannot contain more than 8 fields.",
    })
    .default({}),
});

const planBody = z.strictObject({
  date: localDateText,
  timeZone: z.string().trim().min(1).max(80),
  availableWindows: z
    .array(z.strictObject({ startsAt: instant, endsAt: instant }))
    .max(64)
    .default([]),
  targetMinutes: z.number().int().positive().max(43_200),
  minimumMinutes: z.number().int().nonnegative().max(43_200).optional(),
  maximumMinutes: z.number().int().positive().max(43_200).optional(),
  targetTaskCount: z.number().int().positive().max(512),
  minimumTaskCount: z.number().int().nonnegative().max(512).optional(),
  maximumTaskCount: z.number().int().positive().max(512).optional(),
  fitPreference: z.enum(["time", "task_count", "balanced"]).default("balanced"),
  energy: z.enum(["low", "normal", "high"]).nullable().default(null),
  availableContexts: z.array(z.string().min(1).max(64)).max(32).default([]),
  seed: z.string().trim().min(1).max(240),
  requestRevision: z.number().int().positive().max(1_000_000).default(1),
});
const planQuery = z.strictObject({ revision: z.coerce.number().int().positive().max(1_000_000) });
const planItemLockBody = z.strictObject({
  expectedPlanId: uuid,
  expectedHeadVersion: z.number().int().positive().max(2_147_483_647),
  locked: z.boolean(),
});
const planItemActivityBody = z.strictObject({
  expectedPlanId: uuid,
  expectedHeadVersion: z.number().int().positive().max(2_147_483_647),
  type: z.enum(["started", "completed", "skipped", "deferred", "dismissed", "completion_reversed"]),
  occurredAt: instant,
  timeZone: z.string().trim().min(1).max(80),
  durationMinutes: z.number().int().positive().max(43_200).nullable().default(null),
  reason: z.string().max(500).nullable().default(null),
  metadata: z
    .record(z.string().min(1).max(64), metadataValue)
    .refine((value) => Object.keys(value).length <= 8, {
      message: "Metadata cannot contain more than 8 fields.",
    })
    .default({}),
});
const planMutationRequestBody = planBody.omit({ date: true, requestRevision: true });
const schedulingAdviceBody = z.strictObject({
  version: z.literal("schedule.advisor/v1"),
  requestId: uuid,
  date: localDateText,
  focus: z.literal("both"),
  expectedPlanId: uuid,
  expectedHeadVersion: z.number().int().positive().max(2_147_483_647),
});
const naturalLanguageProposalBody = z.strictObject({
  version: z.literal("schedule.natural-language/v1"),
  requestId: uuid,
  prompt: z.string().min(1).max(2_000),
});
const updateNaturalLanguageProposalBody = z.strictObject({
  expectedVersion: z.number().int().positive().max(2_147_483_647),
  title: z.string().min(1).max(240),
});
const naturalLanguageProposalVersionBody = z.strictObject({
  expectedVersion: z.number().int().positive().max(2_147_483_647),
});
const planMutationBody = z.strictObject({
  expectedPlanId: uuid,
  expectedHeadVersion: z.number().int().positive().max(2_147_483_647),
  request: planMutationRequestBody,
});
const routineFeedbackBody = planMutationBody.extend({
  kind: z.enum(["not_today", "not_this_week"]),
});
const idempotencyKey = z.string().trim().min(1).max(160);

function publicPlan(
  plan: DailyPlan,
): Omit<DailyPlan, "inputSnapshot"> & { readonly request: JsonValue | null } {
  const { inputSnapshot, ...result } = plan;
  const request =
    typeof inputSnapshot === "object" &&
    inputSnapshot !== null &&
    !Array.isArray(inputSnapshot) &&
    "request" in inputSnapshot
      ? inputSnapshot.request
      : null;
  return { ...result, request };
}

function publicActivityEvent(event: ActivityEvent): Omit<ActivityEvent, "idempotencyKey"> {
  const { idempotencyKey, ...result } = event;
  void idempotencyKey;
  return result;
}

function encodeActivityCursor(
  cursor: ActivityHistoryCursor | null,
  scope: { workspaceId: string; routineId: string },
  signingKey: Buffer,
): string | null {
  if (cursor === null) return null;
  const payload = Buffer.from(JSON.stringify({ v: 1, ...scope, ...cursor }), "utf8").toString(
    "base64url",
  );
  const signature = createHmac("sha256", signingKey).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function decodeActivityCursor(
  value: string,
  scope: { workspaceId: string; routineId: string },
  signingKey: Buffer,
): ActivityHistoryCursor {
  try {
    const [payload, signature, extra] = value.split(".");
    if (payload === undefined || signature === undefined || extra !== undefined) {
      throw new Error("Malformed cursor.");
    }
    const suppliedSignature = Buffer.from(signature, "base64url");
    const expectedSignature = createHmac("sha256", signingKey).update(payload).digest();
    if (
      suppliedSignature.toString("base64url") !== signature ||
      suppliedSignature.length !== expectedSignature.length ||
      !timingSafeEqual(suppliedSignature, expectedSignature)
    ) {
      throw new Error("Cursor signature mismatch.");
    }
    const decoded = Buffer.from(payload, "base64url");
    if (decoded.toString("base64url") !== payload) throw new Error("Non-canonical cursor.");
    const parsed = activityHistoryCursor.parse(JSON.parse(decoded.toString("utf8")));
    if (
      parsed.workspaceId !== scope.workspaceId ||
      parsed.routineId !== scope.routineId ||
      parsed.before > parsed.watermark
    ) {
      throw new Error("Cursor is outside its scope or watermark.");
    }
    return { watermark: parsed.watermark, before: parsed.before };
  } catch {
    throw new RequestValidationError([{ path: "cursor", message: "Invalid activity cursor." }]);
  }
}

function mutationPlanningRequest(
  workspace: string,
  date: string,
  body: z.infer<typeof planMutationRequestBody>,
) {
  return createDailyPlanningRequest({
    workspaceId: workspaceId(workspace),
    date,
    timeZone: body.timeZone,
    availableWindows: body.availableWindows.map((window) => ({
      startsAt: new Date(window.startsAt),
      endsAt: new Date(window.endsAt),
    })),
    targetMinutes: body.targetMinutes,
    ...(body.minimumMinutes === undefined ? {} : { minimumMinutes: body.minimumMinutes }),
    ...(body.maximumMinutes === undefined ? {} : { maximumMinutes: body.maximumMinutes }),
    targetTaskCount: body.targetTaskCount,
    ...(body.minimumTaskCount === undefined ? {} : { minimumTaskCount: body.minimumTaskCount }),
    ...(body.maximumTaskCount === undefined ? {} : { maximumTaskCount: body.maximumTaskCount }),
    fitPreference: body.fitPreference,
    energy: body.energy,
    availableContexts: body.availableContexts,
    seed: body.seed,
    requestRevision: 1,
  });
}

export async function registerProductRoutes(
  app: FastifyInstance,
  services: ProductServices,
  limits: ProductApiLimits = DEFAULT_PRODUCT_API_LIMITS,
): Promise<void> {
  app.addHook("onRequest", async (request, reply) => {
    if (
      request.routeOptions.url === SCHEDULING_ADVICE_ROUTE ||
      request.routeOptions.url === NATURAL_LANGUAGE_PROPOSAL_ROUTE ||
      request.routeOptions.url === NATURAL_LANGUAGE_PROPOSAL_ITEM_ROUTE ||
      request.routeOptions.url === NATURAL_LANGUAGE_PROPOSAL_CANCELLATION_ROUTE ||
      request.routeOptions.url === NATURAL_LANGUAGE_PROPOSAL_CONFIRMATION_ROUTE
    ) {
      reply.header("cache-control", "no-store");
    }
  });
  installRateLimit(app, limits.requestsPerMinute);
  const cursorSigningKey = randomBytes(32);
  let concurrentPlans = 0;
  const runPlanningOperation = async <Result>(
    operation: () => Promise<Result>,
  ): Promise<Result> => {
    if (concurrentPlans >= limits.maxConcurrentPlans) {
      throw new RequestThrottledError("planning.concurrency_limit_reached");
    }
    concurrentPlans += 1;
    try {
      return await operation();
    } finally {
      concurrentPlans -= 1;
    }
  };
  app.post("/v1/workspaces", async (request, reply) => {
    const body = parseRequest(workspaceBody, request.body);
    const created = await services.createWorkspace(body);
    return reply.code(201).send(created);
  });

  app.get("/v1/workspaces", async (request) => {
    const query = parseRequest(workspaceQuery, request.query);
    const page = await services.listWorkspaces({ limit: query.limit, offset: query.offset });
    return { items: page.items, page: { limit: page.limit, offset: page.offset } };
  });

  app.get("/v1/workspaces/:workspaceId", async (request) => {
    const params = parseRequest(workspaceParams, request.params);
    return services.getWorkspace({ workspaceId: workspaceId(params.workspaceId) });
  });

  app.post(SCHEDULING_ADVICE_ROUTE, async (request, reply) => {
    const params = parseRequest(workspaceParams, request.params);
    const body = parseRequest(schedulingAdviceBody, request.body);
    const cancellation = new AbortController();
    const abort = () => cancellation.abort();
    const abortOnPrematureResponseClose = () => {
      if (!reply.raw.writableEnded) abort();
    };
    request.raw.once("aborted", abort);
    reply.raw.once("close", abortOnPrematureResponseClose);
    if (request.raw.aborted || reply.raw.destroyed) abort();
    try {
      return await services.getSchedulingAdvice(
        {
          version: body.version,
          requestId: body.requestId,
          workspaceId: workspaceId(params.workspaceId),
          date: localDate(body.date),
          focus: body.focus,
          expectedPlanId: dailyPlanId(body.expectedPlanId),
          expectedHeadVersion: body.expectedHeadVersion,
        },
        cancellation.signal,
      );
    } finally {
      request.raw.off("aborted", abort);
      reply.raw.off("close", abortOnPrematureResponseClose);
    }
  });

  app.post(NATURAL_LANGUAGE_PROPOSAL_ROUTE, async (request, reply) => {
    const params = parseRequest(workspaceParams, request.params);
    const body = parseRequest(naturalLanguageProposalBody, request.body);
    const cancellation = new AbortController();
    const abort = () => cancellation.abort();
    const abortOnPrematureResponseClose = () => {
      if (!reply.raw.writableEnded) abort();
    };
    request.raw.once("aborted", abort);
    reply.raw.once("close", abortOnPrematureResponseClose);
    if (request.raw.aborted || reply.raw.destroyed) abort();
    try {
      return await services.generateNaturalLanguageProposal(
        {
          version: body.version,
          requestId: body.requestId,
          workspaceId: workspaceId(params.workspaceId),
          prompt: body.prompt,
        },
        cancellation.signal,
      );
    } catch (error) {
      if (cancellation.signal.aborted && isAbortError(error)) return reply;
      throw error;
    } finally {
      request.raw.off("aborted", abort);
      reply.raw.off("close", abortOnPrematureResponseClose);
    }
  });

  app.patch(NATURAL_LANGUAGE_PROPOSAL_ITEM_ROUTE, async (request) => {
    const params = parseRequest(naturalLanguageProposalParams, request.params);
    const body = parseRequest(updateNaturalLanguageProposalBody, request.body);
    return services.updateNaturalLanguageProposal({
      workspaceId: workspaceId(params.workspaceId),
      proposalId: params.proposalId,
      expectedVersion: body.expectedVersion,
      title: body.title,
    });
  });

  app.post(NATURAL_LANGUAGE_PROPOSAL_CANCELLATION_ROUTE, async (request) => {
    const params = parseRequest(naturalLanguageProposalParams, request.params);
    const body = parseRequest(naturalLanguageProposalVersionBody, request.body);
    return services.cancelNaturalLanguageProposal({
      workspaceId: workspaceId(params.workspaceId),
      proposalId: params.proposalId,
      expectedVersion: body.expectedVersion,
    });
  });

  app.post(NATURAL_LANGUAGE_PROPOSAL_CONFIRMATION_ROUTE, async (request, reply) => {
    const params = parseRequest(naturalLanguageProposalParams, request.params);
    const body = parseRequest(naturalLanguageProposalVersionBody, request.body);
    const key = parseRequest(idempotencyKey, request.headers["idempotency-key"]);
    const result = await services.confirmNaturalLanguageProposal({
      workspaceId: workspaceId(params.workspaceId),
      proposalId: params.proposalId,
      expectedVersion: body.expectedVersion,
      idempotencyKey: key,
    });
    return reply.code(result.replayed ? 200 : 201).send(result);
  });

  app.post("/v1/workspaces/:workspaceId/work-items", async (request, reply) => {
    const params = parseRequest(workspaceParams, request.params);
    const body = parseRequest(workItemBody, request.body);
    const created = await services.createWorkItem({
      workspaceId: workspaceId(params.workspaceId),
      parentWorkItemId: body.parentWorkItemId === null ? null : workItemId(body.parentWorkItemId),
      title: body.title,
      description: body.description,
      status: body.status,
      priority: body.priority,
      dueOn: body.dueOn === null ? null : localDate(body.dueOn),
      planningDurationMinutes: body.planningDurationMinutes,
    });
    return reply.code(201).send(created);
  });

  app.get("/v1/workspaces/:workspaceId/work-items", async (request) => {
    const params = parseRequest(workspaceParams, request.params);
    const query = parseRequest(workItemQuery, request.query);
    const page = await services.listWorkItems({
      workspaceId: workspaceId(params.workspaceId),
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.priority === undefined ? {} : { priority: query.priority }),
      limit: query.limit,
      offset: query.offset,
    });
    return { items: page.items, page: { limit: page.limit, offset: page.offset } };
  });

  app.post(
    "/v1/workspaces/:workspaceId/work-items/:workItemId/subtasks",
    async (request, reply) => {
      const params = parseRequest(workItemParams, request.params);
      const body = parseRequest(subtaskBody, request.body);
      const created = await services.createWorkItem({
        workspaceId: workspaceId(params.workspaceId),
        parentWorkItemId: workItemId(params.workItemId),
        title: body.title,
        description: body.description,
        status: body.status,
        priority: body.priority,
        dueOn: body.dueOn === null ? null : localDate(body.dueOn),
        planningDurationMinutes: body.planningDurationMinutes,
      });
      return reply.code(201).send(created);
    },
  );

  app.get("/v1/workspaces/:workspaceId/work-items/:workItemId/subtasks", async (request) => {
    const params = parseRequest(workItemParams, request.params);
    const query = parseRequest(workItemDependencyQuery, request.query);
    const page = await services.listWorkItemChildren({
      workspaceId: workspaceId(params.workspaceId),
      parentWorkItemId: workItemId(params.workItemId),
      limit: query.limit,
      offset: query.offset,
    });
    return { items: page.items, page: { limit: page.limit, offset: page.offset } };
  });

  app.get("/v1/workspaces/:workspaceId/work-item-dependencies", async (request) => {
    const params = parseRequest(workspaceParams, request.params);
    const query = parseRequest(workItemDependencyQuery, request.query);
    const page = await services.listWorkItemDependencies({
      workspaceId: workspaceId(params.workspaceId),
      limit: query.limit,
      offset: query.offset,
    });
    return { items: page.items, page: { limit: page.limit, offset: page.offset } };
  });

  app.post(
    "/v1/workspaces/:workspaceId/work-items/:workItemId/prerequisites",
    async (request, reply) => {
      const params = parseRequest(workItemParams, request.params);
      const body = parseRequest(workItemDependencyBody, request.body);
      const result = await services.addWorkItemDependency({
        workspaceId: workspaceId(params.workspaceId),
        prerequisiteWorkItemId: workItemId(body.prerequisiteWorkItemId),
        dependentWorkItemId: workItemId(params.workItemId),
      });
      return reply.code(result.created ? 201 : 200).send(result.dependency);
    },
  );

  app.delete(
    "/v1/workspaces/:workspaceId/work-items/:workItemId/prerequisites/:prerequisiteWorkItemId",
    async (request, reply) => {
      const params = parseRequest(workItemDependencyParams, request.params);
      await services.removeWorkItemDependency({
        workspaceId: workspaceId(params.workspaceId),
        prerequisiteWorkItemId: workItemId(params.prerequisiteWorkItemId),
        dependentWorkItemId: workItemId(params.workItemId),
      });
      return reply.code(204).send();
    },
  );

  app.get("/v1/workspaces/:workspaceId/work-items/:workItemId", async (request) => {
    const params = parseRequest(workItemParams, request.params);
    return services.getWorkItem({
      workspaceId: workspaceId(params.workspaceId),
      workItemId: workItemId(params.workItemId),
    });
  });

  app.patch("/v1/workspaces/:workspaceId/work-items/:workItemId", async (request) => {
    const params = parseRequest(workItemParams, request.params);
    const body = parseRequest(updateWorkItemBody, request.body);
    return services.updateWorkItem({
      workspaceId: workspaceId(params.workspaceId),
      workItemId: workItemId(params.workItemId),
      expectedVersion: body.expectedVersion,
      ...(body.parentWorkItemId === undefined
        ? {}
        : {
            parentWorkItemId:
              body.parentWorkItemId === null ? null : workItemId(body.parentWorkItemId),
          }),
      ...(body.title === undefined ? {} : { title: body.title }),
      ...(body.description === undefined ? {} : { description: body.description }),
      ...(body.status === undefined ? {} : { status: body.status }),
      ...(body.priority === undefined ? {} : { priority: body.priority }),
      ...(body.dueOn === undefined
        ? {}
        : { dueOn: body.dueOn === null ? null : localDate(body.dueOn) }),
      ...(body.planningDurationMinutes === undefined
        ? {}
        : { planningDurationMinutes: body.planningDurationMinutes }),
    });
  });

  app.post("/v1/workspaces/:workspaceId/schedule-blocks", async (request, reply) => {
    const params = parseRequest(workspaceParams, request.params);
    const body = parseRequest(scheduleBlockBody, request.body);
    const created = await services.createScheduleBlock({
      workspaceId: workspaceId(params.workspaceId),
      workItemId: body.workItemId === null ? null : workItemId(body.workItemId),
      title: body.title,
      startsAt: new Date(body.startsAt),
      endsAt: new Date(body.endsAt),
      timeZone: body.timeZone,
    });
    return reply.code(201).send(created);
  });

  app.get("/v1/workspaces/:workspaceId/schedule-blocks", async (request) => {
    const params = parseRequest(workspaceParams, request.params);
    const query = parseRequest(scheduleBlockQuery, request.query);
    const page = await services.listScheduleBlocks({
      workspaceId: workspaceId(params.workspaceId),
      from: new Date(query.from),
      to: new Date(query.to),
      limit: query.limit,
      offset: query.offset,
    });
    return { items: page.items, page: { limit: page.limit, offset: page.offset } };
  });

  app.get("/v1/workspaces/:workspaceId/schedule-blocks/:scheduleBlockId", async (request) => {
    const params = parseRequest(scheduleBlockParams, request.params);
    return services.getScheduleBlock({
      workspaceId: workspaceId(params.workspaceId),
      scheduleBlockId: scheduleBlockId(params.scheduleBlockId),
    });
  });

  app.patch("/v1/workspaces/:workspaceId/schedule-blocks/:scheduleBlockId", async (request) => {
    const params = parseRequest(scheduleBlockParams, request.params);
    const body = parseRequest(updateScheduleBlockBody, request.body);
    return services.updateScheduleBlock({
      workspaceId: workspaceId(params.workspaceId),
      scheduleBlockId: scheduleBlockId(params.scheduleBlockId),
      expectedVersion: body.expectedVersion,
      ...(body.workItemId === undefined
        ? {}
        : { workItemId: body.workItemId === null ? null : workItemId(body.workItemId) }),
      ...(body.title === undefined ? {} : { title: body.title }),
      ...(body.startsAt === undefined ? {} : { startsAt: new Date(body.startsAt) }),
      ...(body.endsAt === undefined ? {} : { endsAt: new Date(body.endsAt) }),
      ...(body.timeZone === undefined ? {} : { timeZone: body.timeZone }),
    });
  });

  app.delete(
    "/v1/workspaces/:workspaceId/schedule-blocks/:scheduleBlockId",
    async (request, reply) => {
      const params = parseRequest(scheduleBlockParams, request.params);
      const body = parseRequest(deleteScheduleBlockBody, request.body);
      await services.deleteScheduleBlock({
        workspaceId: workspaceId(params.workspaceId),
        scheduleBlockId: scheduleBlockId(params.scheduleBlockId),
        expectedVersion: body.expectedVersion,
      });
      return reply.code(204).send();
    },
  );

  app.put("/v1/workspaces/:workspaceId/notification-profile", async (request) => {
    const params = parseRequest(workspaceParams, request.params);
    const body = parseRequest(notificationProfileBody, request.body);
    return services.configureNotificationProfile({
      workspaceId: workspaceId(params.workspaceId),
      expectedVersion: body.expectedVersion,
      timeZone: body.timeZone,
      ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
      ...(body.quietHoursStartMinute === undefined
        ? {}
        : { quietHoursStartMinute: body.quietHoursStartMinute }),
      ...(body.quietHoursEndMinute === undefined
        ? {}
        : { quietHoursEndMinute: body.quietHoursEndMinute }),
      ...(body.quietHoursPolicy === undefined ? {} : { quietHoursPolicy: body.quietHoursPolicy }),
      ...(body.catchUpWindowMinutes === undefined
        ? {}
        : { catchUpWindowMinutes: body.catchUpWindowMinutes }),
      ...(body.dailyIntentLimit === undefined ? {} : { dailyIntentLimit: body.dailyIntentLimit }),
    });
  });

  app.get("/v1/workspaces/:workspaceId/notification-profile", async (request) => {
    const params = parseRequest(workspaceParams, request.params);
    return services.getNotificationProfile(workspaceId(params.workspaceId));
  });

  app.post("/v1/workspaces/:workspaceId/notification-rules", async (request, reply) => {
    const params = parseRequest(workspaceParams, request.params);
    const body = parseRequest(notificationRuleBody, request.body);
    const created = await services.createNotificationRule({
      workspaceId: workspaceId(params.workspaceId),
      kind: body.kind,
      enabled: body.enabled,
      localMinute: body.localMinute,
      leadMinutes: body.leadMinutes,
      cooldownMinutes: body.cooldownMinutes,
      priority: body.priority,
    });
    return reply.code(201).send(created);
  });

  app.get("/v1/workspaces/:workspaceId/notification-rules", async (request) => {
    const params = parseRequest(workspaceParams, request.params);
    const items = await services.listNotificationRules(workspaceId(params.workspaceId));
    return { items };
  });

  app.patch(
    "/v1/workspaces/:workspaceId/notification-rules/:notificationRuleId",
    async (request) => {
      const params = parseRequest(notificationRuleParams, request.params);
      const body = parseRequest(updateNotificationRuleBody, request.body);
      return services.updateNotificationRule({
        workspaceId: workspaceId(params.workspaceId),
        ruleId: notificationRuleId(params.notificationRuleId),
        expectedVersion: body.expectedVersion,
        ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
        ...(body.localMinute === undefined ? {} : { localMinute: body.localMinute }),
        ...(body.leadMinutes === undefined ? {} : { leadMinutes: body.leadMinutes }),
        ...(body.cooldownMinutes === undefined ? {} : { cooldownMinutes: body.cooldownMinutes }),
        ...(body.priority === undefined ? {} : { priority: body.priority }),
      });
    },
  );

  app.post("/v1/workspaces/:workspaceId/one-off-reminders", async (request, reply) => {
    const params = parseRequest(workspaceParams, request.params);
    const body = parseRequest(oneOffReminderBody, request.body);
    const created = await services.createOneOffReminder({
      workspaceId: workspaceId(params.workspaceId),
      title: body.title,
      scheduledFor: new Date(body.scheduledFor),
    });
    return reply.code(201).send(created);
  });

  app.get("/v1/workspaces/:workspaceId/one-off-reminders", async (request) => {
    const params = parseRequest(workspaceParams, request.params);
    const query = parseRequest(notificationRangeQuery, request.query);
    const items = await services.listOneOffReminders({
      workspaceId: workspaceId(params.workspaceId),
      fromInclusive: new Date(query.from),
      throughExclusive: new Date(query.to),
    });
    return { items };
  });

  app.patch("/v1/workspaces/:workspaceId/one-off-reminders/:oneOffReminderId", async (request) => {
    const params = parseRequest(oneOffReminderParams, request.params);
    const body = parseRequest(updateOneOffReminderBody, request.body);
    return services.updateOneOffReminder({
      workspaceId: workspaceId(params.workspaceId),
      reminderId: oneOffReminderId(params.oneOffReminderId),
      expectedVersion: body.expectedVersion,
      ...(body.title === undefined ? {} : { title: body.title }),
      ...(body.scheduledFor === undefined ? {} : { scheduledFor: new Date(body.scheduledFor) }),
    });
  });

  app.post(
    "/v1/workspaces/:workspaceId/one-off-reminders/:oneOffReminderId/cancellations",
    async (request) => {
      const params = parseRequest(oneOffReminderParams, request.params);
      const body = parseRequest(cancelOneOffReminderBody, request.body);
      return services.cancelOneOffReminder({
        workspaceId: workspaceId(params.workspaceId),
        reminderId: oneOffReminderId(params.oneOffReminderId),
        expectedVersion: body.expectedVersion,
      });
    },
  );

  app.get("/v1/workspaces/:workspaceId/notification-intents", async (request) => {
    const params = parseRequest(workspaceParams, request.params);
    const query = parseRequest(notificationIntentQuery, request.query);
    const items = await services.listNotificationIntents({
      workspaceId: workspaceId(params.workspaceId),
      fromInclusive: new Date(query.from),
      throughExclusive: new Date(query.to),
      limit: query.limit,
      offset: query.offset,
    });
    return { items, page: { limit: query.limit, offset: query.offset } };
  });

  app.get("/v1/workspaces/:workspaceId/notification-deliveries", async (request) => {
    const params = parseRequest(workspaceParams, request.params);
    const query = parseRequest(notificationDeliveryQuery, request.query);
    const items = await services.listNotificationDeliveries({
      workspaceId: workspaceId(params.workspaceId),
      fromInclusive: new Date(query.from),
      throughExclusive: new Date(query.to),
      limit: query.limit,
      offset: query.offset,
    });
    return { items, page: { limit: query.limit, offset: query.offset } };
  });

  app.post("/v1/workspaces/:workspaceId/notification-intents/materializations", async (request) => {
    const params = parseRequest(workspaceParams, request.params);
    const body = parseRequest(notificationMaterializationBody, request.body);
    return services.materializeNotificationIntents({
      workspaceId: workspaceId(params.workspaceId),
      fromInclusive: new Date(body.from),
      throughExclusive: new Date(body.through),
    });
  });

  app.post("/v1/workspaces/:workspaceId/routines", async (request, reply) => {
    const params = parseRequest(workspaceParams, request.params);
    const body = parseRequest(routineBody, request.body);
    const created = await services.createRoutine({
      workspaceId: workspaceId(params.workspaceId),
      title: body.title,
      description: body.description,
      status: body.status,
      tags: createStructuredTags(body.tags),
      duration: createDurationRange({
        expectedMinutes: body.duration.expectedMinutes,
        minimumMinutes: body.duration.minimumMinutes ?? body.duration.expectedMinutes,
        maximumMinutes: body.duration.maximumMinutes ?? body.duration.expectedMinutes,
        splittable: body.duration.splittable,
        minimumSessionMinutes: body.duration.minimumSessionMinutes,
        overheadMinutes: body.duration.overheadMinutes,
      }),
      cadence: createCadencePolicy({
        ...body.cadence,
        preferredWeekdays: body.cadence.preferredWeekdays as Weekday[],
        excludedWeekdays: body.cadence.excludedWeekdays as Weekday[],
        weekStartsOn: body.cadence.weekStartsOn as Weekday,
      }),
    });
    return reply.code(201).send(created);
  });

  app.get("/v1/workspaces/:workspaceId/routines", async (request) => {
    const params = parseRequest(workspaceParams, request.params);
    const query = parseRequest(routineQuery, request.query);
    const items = await services.listRoutines({
      workspaceId: workspaceId(params.workspaceId),
      ...(query.status === undefined ? {} : { status: query.status }),
      limit: query.limit,
      offset: query.offset,
    });
    return { items, page: { limit: query.limit, offset: query.offset } };
  });

  app.get("/v1/workspaces/:workspaceId/routines/:routineId", async (request) => {
    const params = parseRequest(routineParams, request.params);
    return services.getRoutine({
      workspaceId: workspaceId(params.workspaceId),
      routineId: routineId(params.routineId),
    });
  });

  app.get("/v1/workspaces/:workspaceId/routines/:routineId/duration-insight", async (request) => {
    const params = parseRequest(routineParams, request.params);
    return services.getRoutineDurationInsight({
      workspaceId: workspaceId(params.workspaceId),
      routineId: routineId(params.routineId),
    });
  });

  app.post(
    "/v1/workspaces/:workspaceId/routines/:routineId/duration-insight/approve",
    async (request) => {
      const params = parseRequest(routineParams, request.params);
      const body = parseRequest(approveRoutineDurationInsightBody, request.body);
      return services.approveRoutineDurationInsight({
        workspaceId: workspaceId(params.workspaceId),
        routineId: routineId(params.routineId),
        expectedVersion: body.expectedVersion,
        duration: createDurationRange(body.duration),
      });
    },
  );

  app.post(
    "/v1/workspaces/:workspaceId/routines/:routineId/duration-insight/dismissals",
    async (request) => {
      const params = parseRequest(routineParams, request.params);
      const body = parseRequest(routineDurationInsightFeedbackBody, request.body);
      const key = parseRequest(idempotencyKey, request.headers["idempotency-key"]);
      return services.dismissRoutineDurationInsight({
        workspaceId: workspaceId(params.workspaceId),
        routineId: routineId(params.routineId),
        expectedVersion: body.expectedVersion,
        insightKey: body.insightKey,
        idempotencyKey: key,
      });
    },
  );

  app.post(
    "/v1/workspaces/:workspaceId/routines/:routineId/duration-insight/dismissal-resets",
    async (request) => {
      const params = parseRequest(routineParams, request.params);
      const body = parseRequest(routineDurationInsightFeedbackBody, request.body);
      const key = parseRequest(idempotencyKey, request.headers["idempotency-key"]);
      return services.resetRoutineDurationInsightDismissal({
        workspaceId: workspaceId(params.workspaceId),
        routineId: routineId(params.routineId),
        expectedVersion: body.expectedVersion,
        insightKey: body.insightKey,
        idempotencyKey: key,
      });
    },
  );

  app.patch("/v1/workspaces/:workspaceId/routines/:routineId", async (request) => {
    const params = parseRequest(routineParams, request.params);
    const body = parseRequest(updateRoutineBody, request.body);
    return services.updateRoutine({
      workspaceId: workspaceId(params.workspaceId),
      routineId: routineId(params.routineId),
      expectedVersion: body.expectedVersion,
      ...(body.title === undefined ? {} : { title: body.title }),
      ...(body.description === undefined ? {} : { description: body.description }),
      ...(body.status === undefined ? {} : { status: body.status }),
      ...(body.tags === undefined ? {} : { tags: createStructuredTags(body.tags) }),
      ...(body.duration === undefined ? {} : { duration: createDurationRange(body.duration) }),
      ...(body.cadence === undefined
        ? {}
        : {
            cadence: createCadencePolicy({
              ...body.cadence,
              preferredWeekdays: body.cadence.preferredWeekdays as Weekday[],
              excludedWeekdays: body.cadence.excludedWeekdays as Weekday[],
              weekStartsOn: body.cadence.weekStartsOn as Weekday,
            }),
          }),
    });
  });

  app.get("/v1/workspaces/:workspaceId/routines/:routineId/activity-events", async (request) => {
    const params = parseRequest(routineParams, request.params);
    const query = parseRequest(activityHistoryQuery, request.query);
    const scope = { workspaceId: params.workspaceId, routineId: params.routineId };
    const page = await services.listRoutineActivity({
      workspaceId: workspaceId(params.workspaceId),
      routineId: routineId(params.routineId),
      limit: query.limit,
      ...(query.cursor === undefined
        ? {}
        : { cursor: decodeActivityCursor(query.cursor, scope, cursorSigningKey) }),
    });
    return {
      items: page.items.map(publicActivityEvent),
      page: {
        limit: query.limit,
        nextCursor: encodeActivityCursor(page.nextCursor, scope, cursorSigningKey),
      },
    };
  });

  app.post("/v1/workspaces/:workspaceId/routines/:routineId/activity-events", async (request) => {
    const params = parseRequest(routineParams, request.params);
    const body = parseRequest(activityBody, request.body);
    const key = parseRequest(idempotencyKey, request.headers["idempotency-key"]);
    return publicActivityEvent(
      await services.recordActivityEvent({
        workspaceId: workspaceId(params.workspaceId),
        routineId: routineId(params.routineId),
        planId: body.planId === null ? null : dailyPlanId(body.planId),
        type: body.type,
        occurredAt: new Date(body.occurredAt),
        timeZone: body.timeZone,
        durationMinutes: body.durationMinutes,
        reason: body.reason,
        referenceEventId:
          body.referenceEventId === null ? null : activityEventId(body.referenceEventId),
        idempotencyKey: key,
        metadata: body.metadata,
      }),
    );
  });

  app.get("/v1/workspaces/:workspaceId/daily-plan-fit-insight", async (request) => {
    const params = parseRequest(workspaceParams, request.params);
    const query = parseRequest(dailyPlanFitInsightQuery, request.query);
    return services.getDailyPlanFitInsight({
      workspaceId: workspaceId(params.workspaceId),
      forDate: localDate(query.forDate),
    });
  });

  app.post("/v1/workspaces/:workspaceId/daily-plan-fit-insight/dismissals", async (request) => {
    const params = parseRequest(workspaceParams, request.params);
    const body = parseRequest(dailyPlanFitInsightFeedbackBody, request.body);
    const key = parseRequest(idempotencyKey, request.headers["idempotency-key"]);
    return services.dismissDailyPlanFitInsight({
      workspaceId: workspaceId(params.workspaceId),
      forDate: localDate(body.forDate),
      insightKey: body.insightKey,
      idempotencyKey: key,
    });
  });

  app.post(
    "/v1/workspaces/:workspaceId/daily-plan-fit-insight/dismissal-resets",
    async (request) => {
      const params = parseRequest(workspaceParams, request.params);
      const body = parseRequest(dailyPlanFitInsightFeedbackBody, request.body);
      const key = parseRequest(idempotencyKey, request.headers["idempotency-key"]);
      return services.resetDailyPlanFitInsightDismissal({
        workspaceId: workspaceId(params.workspaceId),
        forDate: localDate(body.forDate),
        insightKey: body.insightKey,
        idempotencyKey: key,
      });
    },
  );

  app.post("/v1/workspaces/:workspaceId/plans", async (request) => {
    const params = parseRequest(workspaceParams, request.params);
    const body = parseRequest(planBody, request.body);
    return runPlanningOperation(async () => {
      const parsedWorkspaceId = workspaceId(params.workspaceId);
      const parsedDate = localDate(body.date);
      const planningRequest = createDailyPlanningRequest({
        workspaceId: parsedWorkspaceId,
        date: parsedDate,
        timeZone: body.timeZone,
        availableWindows: body.availableWindows.map((window) => ({
          startsAt: new Date(window.startsAt),
          endsAt: new Date(window.endsAt),
        })),
        targetMinutes: body.targetMinutes,
        ...(body.minimumMinutes === undefined ? {} : { minimumMinutes: body.minimumMinutes }),
        ...(body.maximumMinutes === undefined ? {} : { maximumMinutes: body.maximumMinutes }),
        targetTaskCount: body.targetTaskCount,
        ...(body.minimumTaskCount === undefined ? {} : { minimumTaskCount: body.minimumTaskCount }),
        ...(body.maximumTaskCount === undefined ? {} : { maximumTaskCount: body.maximumTaskCount }),
        fitPreference: body.fitPreference,
        energy: body.energy,
        availableContexts: body.availableContexts,
        seed: body.seed,
        requestRevision: body.requestRevision,
      });
      return publicPlan(await services.generateDailyPlan({ request: planningRequest }));
    });
  });

  app.get("/v1/workspaces/:workspaceId/plans/:date", async (request) => {
    const params = parseRequest(planParams, request.params);
    const query = parseRequest(planQuery, request.query);
    const plan = await services.getDailyPlan({
      workspaceId: workspaceId(params.workspaceId),
      date: localDate(params.date),
      requestRevision: query.revision,
    });
    if (plan === null) throw new ResourceNotFoundError("plan");
    return publicPlan(plan);
  });

  app.get("/v1/workspaces/:workspaceId/plans/:date/current", async (request) => {
    const params = parseRequest(planParams, request.params);
    const current = await services.getCurrentDailyPlan({
      workspaceId: workspaceId(params.workspaceId),
      date: localDate(params.date),
    });
    return { ...publicPlan(current.plan), headVersion: current.headVersion };
  });

  app.patch("/v1/workspaces/:workspaceId/plans/:date/items/:itemId/lock", async (request) => {
    const params = parseRequest(planItemParams, request.params);
    const body = parseRequest(planItemLockBody, request.body);
    const key = parseRequest(idempotencyKey, request.headers["idempotency-key"]);
    return services.setPlanItemLock({
      workspaceId: workspaceId(params.workspaceId),
      date: localDate(params.date),
      expectedPlanId: dailyPlanId(body.expectedPlanId),
      itemId: planItemId(params.itemId),
      expectedHeadVersion: body.expectedHeadVersion,
      locked: body.locked,
      idempotencyKey: key,
    });
  });

  app.post(
    "/v1/workspaces/:workspaceId/plans/:date/items/:itemId/activity-events",
    async (request) => {
      const params = parseRequest(planItemParams, request.params);
      const body = parseRequest(planItemActivityBody, request.body);
      const key = parseRequest(idempotencyKey, request.headers["idempotency-key"]);
      const result = await services.recordPlanItemActivity({
        workspaceId: workspaceId(params.workspaceId),
        date: localDate(params.date),
        expectedPlanId: dailyPlanId(body.expectedPlanId),
        itemId: planItemId(params.itemId),
        expectedHeadVersion: body.expectedHeadVersion,
        type: body.type,
        occurredAt: new Date(body.occurredAt),
        timeZone: body.timeZone,
        durationMinutes: body.durationMinutes,
        reason: body.reason,
        metadata: body.metadata,
        idempotencyKey: key,
      });
      return { ...result, activityEvent: publicActivityEvent(result.activityEvent) };
    },
  );

  app.post("/v1/workspaces/:workspaceId/plans/:date/regenerations", async (request) => {
    const params = parseRequest(planParams, request.params);
    const body = parseRequest(planMutationBody, request.body);
    const key = parseRequest(idempotencyKey, request.headers["idempotency-key"]);
    return runPlanningOperation(async () => {
      const result = await services.regenerateDailyPlan({
        workspaceId: workspaceId(params.workspaceId),
        expectedPlanId: dailyPlanId(body.expectedPlanId),
        expectedHeadVersion: body.expectedHeadVersion,
        request: mutationPlanningRequest(params.workspaceId, params.date, body.request),
        idempotencyKey: key,
      });
      return { ...publicPlan(result.plan), headVersion: result.headVersion };
    });
  });

  app.post("/v1/workspaces/:workspaceId/plans/:date/items/:itemId/replacement", async (request) => {
    const params = parseRequest(planItemParams, request.params);
    const body = parseRequest(planMutationBody, request.body);
    const key = parseRequest(idempotencyKey, request.headers["idempotency-key"]);
    return runPlanningOperation(async () => {
      const result = await services.replacePlanItem({
        workspaceId: workspaceId(params.workspaceId),
        expectedPlanId: dailyPlanId(body.expectedPlanId),
        expectedHeadVersion: body.expectedHeadVersion,
        targetItemId: planItemId(params.itemId),
        request: mutationPlanningRequest(params.workspaceId, params.date, body.request),
        idempotencyKey: key,
      });
      return { ...publicPlan(result.plan), headVersion: result.headVersion };
    });
  });

  app.post(
    "/v1/workspaces/:workspaceId/plans/:date/items/:itemId/routine-feedback",
    async (request) => {
      const params = parseRequest(planItemParams, request.params);
      const body = parseRequest(routineFeedbackBody, request.body);
      const key = parseRequest(idempotencyKey, request.headers["idempotency-key"]);
      return runPlanningOperation(async () => {
        const result = await services.applyRoutineFeedback({
          workspaceId: workspaceId(params.workspaceId),
          expectedPlanId: dailyPlanId(body.expectedPlanId),
          expectedHeadVersion: body.expectedHeadVersion,
          targetItemId: planItemId(params.itemId),
          kind: body.kind,
          request: mutationPlanningRequest(params.workspaceId, params.date, body.request),
          idempotencyKey: key,
        });
        return { ...publicPlan(result.plan), headVersion: result.headVersion };
      });
    },
  );

  app.post(
    "/v1/workspaces/:workspaceId/plans/:date/routines/:routineId/routine-feedback-resets",
    async (request) => {
      const params = parseRequest(planRoutineParams, request.params);
      const body = parseRequest(planMutationBody, request.body);
      const key = parseRequest(idempotencyKey, request.headers["idempotency-key"]);
      return runPlanningOperation(async () => {
        const result = await services.resetRoutineFeedback({
          workspaceId: workspaceId(params.workspaceId),
          expectedPlanId: dailyPlanId(body.expectedPlanId),
          expectedHeadVersion: body.expectedHeadVersion,
          routineId: routineId(params.routineId),
          request: mutationPlanningRequest(params.workspaceId, params.date, body.request),
          idempotencyKey: key,
        });
        return { ...publicPlan(result.plan), headVersion: result.headVersion };
      });
    },
  );
}
