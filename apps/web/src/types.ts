export type AppSection = "today" | "work" | "routines" | "calendar";

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
  readonly title: string;
  readonly description: string | null;
  readonly status: WorkItemStatus;
  readonly priority: WorkItemPriority;
  /** Local calendar date in YYYY-MM-DD form, when the work has a deadline. */
  readonly dueOn: string | null;
  /** A null duration keeps this one-time item out of automatic daily plans. */
  readonly planningDurationMinutes: number | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
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
}

export interface PlanRequestSnapshot extends PlanSettings {
  readonly workspaceId: string;
  readonly date: string;
  readonly requestRevision: number;
  readonly minimumMinutes: number;
  readonly maximumMinutes: number;
  readonly minimumTaskCount: number;
  readonly maximumTaskCount: number;
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
