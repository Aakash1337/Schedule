export type AppSection = "today" | "work" | "routines" | "calendar" | "reminders";

export interface Workspace {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type WorkItemStatus =
  "backlog" | "planned" | "in_progress" | "blocked" | "done" | "cancelled";
export type WorkItemPriority = "none" | "low" | "medium" | "high" | "urgent";

export interface WorkItem {
  readonly id: string;
  readonly workspaceId: string;
  /** Null marks a root item; otherwise this is a direct subtask of the referenced work item. */
  readonly parentWorkItemId: string | null;
  readonly title: string;
  readonly description: string | null;
  readonly status: WorkItemStatus;
  readonly priority: WorkItemPriority;
  /** Local calendar date in YYYY-MM-DD form, when the work has a deadline. */
  readonly dueOn: string | null;
  /** A null duration keeps this one-time item out of automatic daily plans. Parents are containers. */
  readonly planningDurationMinutes: number | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NaturalLanguageWorkItemCommand {
  readonly type: "work_item.create";
  readonly title: string;
}

export type NaturalLanguageProposalStatus = "pending" | "confirmed" | "cancelled";

export interface NaturalLanguageProposalUserSelection {
  readonly priority: WorkItemPriority;
  readonly dueOn: string | null;
  readonly planningDurationMinutes: number | null;
}

export interface NaturalLanguageProposal {
  readonly id: string;
  readonly requestId: string;
  readonly commandHash: string;
  readonly commandDisplay: string;
  readonly command: NaturalLanguageWorkItemCommand;
  readonly userSelection: NaturalLanguageProposalUserSelection;
  readonly provider: string;
  readonly model: string | null;
  readonly status: NaturalLanguageProposalStatus;
  readonly expiresAt: string;
  readonly version: number;
}

export interface NaturalLanguageProposalResult {
  readonly version: "schedule.natural-language/v1";
  readonly requestId: string;
  readonly status: "proposal" | "no_proposal" | "unavailable";
  readonly reason: string | null;
  readonly summary: string | null;
  readonly warnings: readonly string[];
  readonly proposal: NaturalLanguageProposal | null;
  readonly provenance: {
    readonly provider: "disabled" | "ollama" | "unknown";
    readonly model: string | null;
    readonly requestedAt: string;
    readonly completedAt: string;
    readonly latencyMs: number;
  };
}

export interface NaturalLanguageConfirmationResult {
  readonly proposalId: string;
  readonly commandHash: string;
  readonly replayed: boolean;
  readonly workItem: WorkItem;
}

/** A directed edge: the dependent waits for the prerequisite to be done. */
export interface WorkItemDependency {
  readonly workspaceId: string;
  readonly prerequisiteWorkItemId: string;
  readonly dependentWorkItemId: string;
  readonly createdAt: string;
}

export interface ScheduleBlock {
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

export type RoutineStatus = "active" | "paused" | "archived";
export type RoutinePriority = "low" | "medium" | "high" | "critical";
export type EffortLevel = "quick" | "short" | "medium" | "deep";
export type EnergyLevel = "low" | "normal" | "high";
export type PreferenceLevel = "enjoyable" | "neutral" | "unpleasant";
export type CadencePeriod = "day" | "week" | "month" | "rolling_days";

export interface StructuredTags {
  readonly priority: RoutinePriority;
  readonly effort: EffortLevel;
  readonly energy: EnergyLevel;
  readonly preference: PreferenceLevel;
  readonly contexts: readonly string[];
  readonly categories: readonly string[];
  readonly freeForm: readonly string[];
}

export interface DurationRange {
  readonly minimumMinutes: number;
  readonly expectedMinutes: number;
  readonly maximumMinutes: number;
  readonly splittable: boolean;
  readonly minimumSessionMinutes: number | null;
  readonly overheadMinutes: number;
}

export interface CadencePolicy {
  readonly period: CadencePeriod;
  readonly rollingIntervalDays: number | null;
  readonly targetCompletions: number;
  readonly minimumCompletions: number | null;
  readonly maximumCompletions: number | null;
  readonly minimumSpacingDays: number;
  readonly preferredWeekdays: readonly number[];
  readonly excludedWeekdays: readonly number[];
  readonly discourageConsecutiveDays: boolean;
  readonly prohibitConsecutiveDays: boolean;
  readonly weekStartsOn: number;
  readonly startsOn: string | null;
  readonly pausedUntil: string | null;
  readonly endsOn: string | null;
}

export interface Routine {
  readonly id: string;
  readonly workspaceId: string;
  readonly title: string;
  readonly description: string | null;
  readonly tags: StructuredTags;
  readonly duration: DurationRange;
  readonly cadence: CadencePolicy;
  readonly status: RoutineStatus;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type RoutineSelectionPreferenceKind = "more_often" | "less_often" | "reset";

/** Explicit, reversible influence on this routine's selection in future plans. */
export interface RoutineSelectionPreferenceState {
  readonly routineId: string;
  readonly feedbackVersion: number;
  readonly activeEventCount: number;
  readonly score: number;
  readonly reason: string | null;
  readonly updatedAt: string | null;
}

export type RoutineDurationInsightStatus =
  "insufficient_history" | "aligned" | "suggested" | "review_range";
export type RoutineDurationInsightDisposition = "available" | "dismissed";
export type RoutineDurationInsightFeedbackKind = "dismissed" | "reset";

/** A read-only duration recommendation. Applying it requires explicit atomic approval. */
export interface RoutineDurationInsight {
  readonly routineId: string;
  readonly routineVersion: number;
  /** Stable evidence fingerprint. Present only when the insight can be acted on. */
  readonly insightKey: string | null;
  readonly disposition: RoutineDurationInsightDisposition;
  readonly dismissedAt: string | null;
  readonly status: RoutineDurationInsightStatus;
  readonly sampleCount: number;
  readonly minimumSamples: number;
  readonly lookbackDays: number;
  readonly evaluatedAt: string;
  readonly windowStartedAt: string;
  readonly currentExpectedMinutes: number;
  readonly minimumMinutes: number;
  readonly maximumMinutes: number;
  readonly observedMedianMinutes: number | null;
  readonly materialThresholdMinutes: number;
  readonly suggestedExpectedMinutes: number | null;
}

/** Immutable audit event created when an actionable duration insight is hidden or restored. */
export interface RoutineDurationInsightFeedback {
  readonly id: string;
  readonly ingestedSequence: number;
  readonly workspaceId: string;
  readonly routineId: string;
  readonly insightKey: string;
  readonly kind: RoutineDurationInsightFeedbackKind;
  readonly routineVersion: number;
  readonly observedMedianMinutes: number;
  readonly suggestedExpectedMinutes: number | null;
  readonly idempotencyKey: string;
  readonly recordedAt: string;
}

export type PlanItemActivityState =
  "pending" | "started" | "completed" | "skipped" | "deferred" | "dismissed";

export interface PlanItem {
  readonly id: string;
  readonly sourceType: "routine" | "work_item";
  readonly routineId: string | null;
  readonly workItemId: string | null;
  readonly title: string;
  readonly position: number;
  readonly windowIndex: number;
  readonly scheduledMinutes: number;
  readonly partialSession: boolean;
  readonly score: number;
  readonly scoreComponents: Readonly<Record<string, number>>;
  readonly reasons: readonly string[];
  readonly locked: boolean;
  readonly activityState: PlanItemActivityState;
  readonly lastActivityEventId: string | null;
  readonly activityUpdatedAt: string | null;
}

export interface PlanExclusion {
  readonly sourceType: "routine" | "work_item";
  readonly routineId: string | null;
  readonly workItemId: string | null;
  readonly title: string;
  readonly codes: readonly string[];
}

export type PlanningFitPreference = "time" | "task_count" | "balanced";

export type RoutinePlanningFeedbackSuppressionKind = "not_today" | "not_this_week";

export interface PlanSettings {
  readonly timeZone: string;
  readonly availableWindows: readonly { readonly startsAt: string; readonly endsAt: string }[];
  readonly targetMinutes: number;
  readonly minimumMinutes?: number;
  readonly maximumMinutes?: number;
  readonly targetTaskCount: number;
  readonly minimumTaskCount?: number;
  readonly maximumTaskCount?: number;
  readonly fitPreference: PlanningFitPreference;
  readonly energy: EnergyLevel | null;
  readonly availableContexts: readonly string[];
  readonly seed: string;
}

export interface GeneratePlanInput extends PlanSettings {
  readonly date: string;
  readonly requestRevision: number;
  readonly planFitInsightKey?: string;
}

export interface PlanRequestSnapshot extends PlanSettings {
  readonly workspaceId: string;
  readonly date: string;
  readonly requestRevision: number;
  readonly minimumMinutes: number;
  readonly maximumMinutes: number;
  readonly minimumTaskCount: number;
  readonly maximumTaskCount: number;
  readonly planFitInsightKey?: string;
}

export interface DailyPlan {
  readonly id: string;
  readonly workspaceId: string;
  readonly date: string;
  readonly timeZone: string;
  readonly items: readonly PlanItem[];
  readonly totalMinutes: number;
  readonly fitness: number;
  readonly algorithmVersion: string;
  readonly configVersion: string;
  readonly prngVersion: string;
  readonly seed: string;
  readonly requestRevision: number;
  readonly inputHash: string;
  readonly exclusions: readonly PlanExclusion[];
  readonly warnings: readonly string[];
  readonly generatedAt: string;
  readonly request: PlanRequestSnapshot | null;
}

export interface CurrentDailyPlan extends DailyPlan {
  readonly headVersion: number;
}

export interface DailyPlanAlternativeItem {
  readonly sourceType: "routine" | "work_item";
  readonly routineId: string | null;
  readonly workItemId: string | null;
  readonly title: string;
  readonly windowIndex: number;
  readonly scheduledMinutes: number;
  readonly partialSession: boolean;
  readonly score: number;
  readonly reasons: readonly string[];
}

export interface DailyPlanAlternative {
  readonly candidateKey: string;
  readonly items: readonly DailyPlanAlternativeItem[];
  readonly totalMinutes: number;
  readonly taskCount: number;
  readonly fitness: number;
  readonly warnings: readonly string[];
  readonly deltaMinutes: number;
  readonly deltaTaskCount: number;
  readonly addedSourceKeys: readonly string[];
  readonly removedSourceKeys: readonly string[];
}

export interface DailyPlanAlternativesResult {
  readonly sourcePlanId: string;
  readonly sourceHeadVersion: number;
  readonly alternatives: readonly DailyPlanAlternative[];
}

export type DailyPlanFitInsightStatus = "insufficient_history" | "aligned" | "suggested";
export type DailyPlanFitInsightDisposition = "available" | "dismissed";
export type DailyPlanFitInsightFeedbackKind = "dismissed" | "reset" | "used";

/** Deterministic, read-only target guidance derived from fully resolved past plans. */
export interface DailyPlanFitInsight {
  readonly status: DailyPlanFitInsightStatus;
  readonly insightKey: string | null;
  readonly disposition: DailyPlanFitInsightDisposition;
  readonly dismissedAt: string | null;
  readonly forDate: string;
  readonly windowStartedOn: string;
  readonly windowEndedOn: string;
  readonly lookbackDays: number;
  readonly sampleCount: number;
  readonly minimumSamples: number;
  readonly maximumSamples: number;
  readonly evaluatedAt: string;
  readonly typicalPlannedMinutes: number | null;
  readonly typicalCompletedMinutes: number | null;
  readonly materialThresholdMinutes: number | null;
  readonly typicalPlannedTaskCount: number | null;
  readonly typicalCompletedTaskCount: number | null;
  readonly materialThresholdTaskCount: number | null;
  readonly suggestedTargetMinutes: number | null;
  readonly suggestedTargetTaskCount: number | null;
}

/** Immutable user feedback about one exact Daily Plan Fit evidence snapshot. */
export interface DailyPlanFitInsightFeedback {
  readonly id: string;
  readonly ingestedSequence: number;
  readonly workspaceId: string;
  readonly forDate: string;
  readonly insightKey: string;
  readonly kind: DailyPlanFitInsightFeedbackKind;
  readonly planId: string | null;
  readonly sampleCount: number;
  readonly typicalPlannedMinutes: number;
  readonly typicalCompletedMinutes: number;
  readonly typicalPlannedTaskCount: number;
  readonly typicalCompletedTaskCount: number;
  readonly suggestedTargetMinutes: number;
  readonly suggestedTargetTaskCount: number;
  readonly appliedTargetMinutes: number | null;
  readonly appliedTargetTaskCount: number | null;
  readonly idempotencyKey: string;
  readonly recordedAt: string;
}

export type DailyPlanFitUsageOutcomeStatus = "pending" | "resolved" | "not_evaluable";

/** Read-only evidence about what happened after an explicitly generated Plan Fit choice. */
export interface DailyPlanFitUsageOutcome {
  readonly usageId: string;
  readonly workspaceId: string;
  readonly forDate: string;
  readonly insightKey: string;
  readonly recordedAt: string;
  readonly sourcePlanId: string;
  readonly currentPlanId: string | null;
  readonly currentPlanRevision: number | null;
  readonly currentHeadVersion: number | null;
  readonly revisedSinceUsage: boolean;
  readonly status: DailyPlanFitUsageOutcomeStatus;
  readonly suggestedTargetMinutes: number;
  readonly suggestedTargetTaskCount: number;
  readonly appliedTargetMinutes: number;
  readonly appliedTargetTaskCount: number;
  readonly usedExactSuggestion: boolean;
  readonly plannedMinutes: number | null;
  readonly plannedTaskCount: number | null;
  readonly completedMinutes: number | null;
  readonly completedTaskCount: number | null;
}

export interface DailyPlanFitUsageOutcomePage {
  readonly items: readonly DailyPlanFitUsageOutcome[];
}

/** Workspace-scoped descriptive totals. Revised outcomes never contribute to rates. */
export interface DailyPlanFitEffectiveness {
  readonly usesConsidered: number;
  readonly resolvedUseCount: number;
  readonly pendingUseCount: number;
  readonly notEvaluableUseCount: number;
  readonly revisedUseCount: number;
  readonly eligibleResolvedUseCount: number;
  readonly exactSuggestionUseCount: number;
  readonly editedSuggestionUseCount: number;
  readonly appliedTargetMinutes: number;
  readonly scheduledMinutes: number;
  readonly completedMinutes: number;
  readonly appliedTargetTaskCount: number;
  readonly scheduledTaskCount: number;
  readonly completedTaskCount: number;
  readonly scheduledMinutesRateBasisPoints: number | null;
  readonly scheduledTasksRateBasisPoints: number | null;
  readonly completionMinutesRateBasisPoints: number | null;
  readonly completionTasksRateBasisPoints: number | null;
}

export type SchedulingAdviceUnavailableReason =
  | "disabled"
  | "busy"
  | "timeout"
  | "unreachable"
  | "provider_rejected"
  | "response_too_large"
  | "malformed_response"
  | "invalid_advice";

export type SchedulingAdviceSuggestionKind =
  "focus" | "sequence" | "consider_backlog" | "plan_observation";

export interface SchedulingAdviceRequest {
  readonly version: "schedule.advisor/v1";
  readonly requestId: string;
  readonly date: string;
  readonly focus: "both";
  readonly expectedPlanId: string;
  readonly expectedHeadVersion: number;
}

export interface SchedulingAdviceSuggestion {
  readonly id: string;
  readonly kind: SchedulingAdviceSuggestionKind;
  readonly targetType: "plan_item" | "work_item" | null;
  readonly targetId: string | null;
  readonly title: string;
  readonly rationale: string;
  readonly confidence: "low" | "medium";
}

/** Read-only model output. This result never represents a scheduling command. */
export interface SchedulingAdviceResult {
  readonly version: "schedule.advisor/v1";
  readonly requestId: string;
  readonly status: "available" | "unavailable";
  readonly reason: SchedulingAdviceUnavailableReason | null;
  readonly snapshot: {
    readonly date: string;
    readonly planId: string;
    readonly headVersion: number;
  };
  readonly provenance: {
    readonly provider: "disabled" | "ollama" | "unknown";
    readonly model: string | null;
    readonly requestedAt: string;
    readonly completedAt: string;
    readonly latencyMs: number;
  };
  readonly summary: string | null;
  readonly suggestions: readonly SchedulingAdviceSuggestion[];
  readonly input: {
    readonly planItemCount: number;
    readonly backlogCount: number;
    readonly truncated: {
      readonly planItems: boolean;
      readonly backlog: boolean;
    };
  };
}

export type QuietHoursPolicy = "skip" | "next_allowed";
export type NotificationRuleKind =
  "daily_digest" | "daily_follow_up" | "plan_window_open" | "schedule_block_lead" | "work_item_due";
export type NotificationKind = NotificationRuleKind | "one_off";
export type NotificationTargetType =
  "workspace" | "daily_plan" | "schedule_block" | "work_item" | "one_off";

export interface NotificationProfile {
  readonly workspaceId: string;
  readonly enabled: boolean;
  readonly timeZone: string;
  readonly quietHoursStartMinute: number | null;
  readonly quietHoursEndMinute: number | null;
  readonly quietHoursPolicy: QuietHoursPolicy;
  readonly catchUpWindowMinutes: number;
  readonly dailyIntentLimit: number;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NotificationRule {
  readonly id: string;
  readonly workspaceId: string;
  readonly kind: NotificationRuleKind;
  readonly enabled: boolean;
  readonly localMinute: number | null;
  readonly leadMinutes: number | null;
  readonly cooldownMinutes: number;
  readonly priority: number;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface OneOffReminder {
  readonly id: string;
  readonly workspaceId: string;
  readonly title: string;
  readonly scheduledFor: string;
  readonly cancelledAt: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NotificationIntent {
  readonly id: string;
  readonly workspaceId: string;
  readonly ruleId: string | null;
  readonly oneOffReminderId: string | null;
  readonly kind: NotificationKind;
  readonly occurrenceKey: string;
  readonly targetType: NotificationTargetType;
  readonly targetId: string | null;
  readonly titleSnapshot: string | null;
  readonly scheduledFor: string;
  readonly localDate: string;
  readonly priority: number;
  readonly policySnapshot: Readonly<Record<string, string | number | boolean | null>>;
  readonly localTimeResolution: "exact" | "gap_later" | "overlap_earlier";
  readonly adjustedForQuietHours: boolean;
  readonly caughtUp: boolean;
  readonly createdAt: string;
}

export type NotificationSuppressionReason =
  | "profile_disabled"
  | "quiet_hours"
  | "outside_catch_up"
  | "outside_window"
  | "cooldown"
  | "daily_limit";

export interface NotificationMaterializationResult {
  readonly created: readonly NotificationIntent[];
  readonly existing: readonly NotificationIntent[];
  readonly suppressed: readonly {
    readonly occurrenceKey: string;
    readonly reason: NotificationSuppressionReason;
  }[];
}

export type NotificationDeliveryStatus =
  "pending" | "processing" | "delivered" | "dead_letter" | "invalidated";

export interface NotificationDeliveryHistoryItem {
  readonly deliveryId: string;
  readonly intentId: string;
  readonly kind: NotificationKind;
  readonly targetType: NotificationTargetType;
  readonly title: string | null;
  readonly scheduledFor: string;
  readonly localDate: string;
  readonly priority: number;
  readonly status: NotificationDeliveryStatus;
  readonly attempts: number;
  readonly availableAt: string;
  readonly completedAt: string | null;
  readonly lastFailureCode: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly page: { readonly limit: number; readonly offset: number };
}

export interface ActivityEvent {
  readonly id: string;
  readonly routineId: string;
  readonly type: string;
  readonly occurredAt: string;
  readonly localDate: string;
  readonly durationMinutes: number | null;
  readonly reason: string | null;
}

export interface ActivityPage {
  readonly items: readonly ActivityEvent[];
  readonly page: { readonly limit: number; readonly nextCursor: string | null };
}

export interface ApiErrorBody {
  readonly error: { readonly code: string; readonly message: string };
  readonly requestId?: string;
}

export interface WorkspaceViewProps {
  readonly workspace: Workspace;
  readonly onNavigate: (section: AppSection) => void;
}
