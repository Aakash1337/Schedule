import { createHash } from "node:crypto";

import { invariant } from "./errors.js";
import {
  addLocalDays,
  daysBetweenLocalDates,
  isIanaTimeZone,
  localDate,
  weekdayOf,
  type LocalDate,
} from "./calendar.js";
import {
  dailyPlanId,
  planItemId,
  type DailyPlanId,
  type PlanItemId,
  type RoutineId,
  type WorkItemId,
  type WorkspaceId,
} from "./ids.js";
import { energyLevels, type EnergyLevel } from "./structured-tags.js";
import type { ActivityEvent } from "./activity-event.js";
import type { PlanItemActivityState } from "./plan-item-activity.js";
import type { CadencePolicy } from "./cadence-policy.js";
import type { Routine } from "./routine.js";
import {
  activeRoutinePlanningFeedback,
  canonicalRoutinePlanningFeedback,
  type RoutinePlanningFeedback,
} from "./routine-planning-feedback.js";
import {
  canonicalRoutineSelectionPreferenceFeedback,
  routineSelectionPreferenceReason,
  routineSelectionPreferenceScore,
  type RoutineSelectionPreferenceFeedback,
} from "./routine-selection-preference-feedback.js";
import { workItemStatuses, type WorkItem } from "./work-item.js";
import {
  createWorkItemDependency,
  type PlanningWorkItemDependency,
} from "./work-item-dependency.js";

export const PLANNER_ALGORITHM_VERSION = "deterministic-planner-v6";
export const PLANNER_CONFIG_VERSION = "default-weights-v4";
export const PLANNER_PRNG_VERSION = "mulberry32-v1";
const MAXIMUM_PLANNER_SCORE_COMPONENT = 1_000_000;

export const planningFitPreferences = ["time", "task_count", "balanced"] as const;
export type PlanningFitPreference = (typeof planningFitPreferences)[number];

export interface TimeWindow {
  readonly startsAt: Date;
  readonly endsAt: Date;
}

export interface DailyPlanningRequest {
  readonly workspaceId: WorkspaceId;
  readonly date: LocalDate;
  readonly timeZone: string;
  readonly availableWindows: readonly TimeWindow[];
  readonly targetMinutes: number;
  readonly minimumMinutes: number;
  readonly maximumMinutes: number;
  readonly targetTaskCount: number;
  readonly minimumTaskCount: number;
  readonly maximumTaskCount: number;
  readonly fitPreference: PlanningFitPreference;
  readonly energy: EnergyLevel | null;
  readonly availableContexts: readonly string[];
  readonly seed: string;
  readonly requestRevision: number;
  /** Exact Plan Fit evidence selected by the user before this initial generation. */
  readonly planFitInsightKey?: string;
}

export interface CreateDailyPlanningRequestInput {
  readonly workspaceId: WorkspaceId;
  readonly date: string;
  readonly timeZone: string;
  readonly availableWindows: readonly TimeWindow[];
  readonly targetMinutes: number;
  readonly minimumMinutes?: number;
  readonly maximumMinutes?: number;
  readonly targetTaskCount: number;
  readonly minimumTaskCount?: number;
  readonly maximumTaskCount?: number;
  readonly fitPreference?: PlanningFitPreference;
  readonly energy?: EnergyLevel | null;
  readonly availableContexts?: readonly string[];
  readonly seed: string;
  readonly requestRevision?: number;
  readonly planFitInsightKey?: string | null;
}

export interface PlannerScoreWeights {
  readonly priority: Readonly<Record<"low" | "medium" | "high" | "critical", number>>;
  readonly cadenceDeficit: number;
  readonly targetMetPenalty: number;
  readonly minimumDeficit: number;
  readonly minimumNearBoundary: number;
  readonly neglectPerDay: number;
  readonly neglectMaximum: number;
  readonly neverCompleted: number;
  readonly preferredWeekday: number;
  readonly energyMatch: number;
  readonly energyMismatch: number;
  readonly contextMatch: number;
  readonly enjoyable: number;
  readonly unpleasant: number;
  readonly recentCompletion: number;
  readonly consecutiveDay: number;
  readonly skipFatigue: number;
  readonly workItemDeadlineDueToday: number;
  readonly workItemDeadlineFuturePerDay: number;
  readonly workItemDeadlineOverdueBase: number;
  readonly workItemDeadlineOverduePerDay: number;
  readonly workItemDeadlineOverdueMaximum: number;
}

export interface PlannerConfig {
  readonly algorithmVersion: string;
  readonly configVersion: string;
  readonly prngVersion: string;
  readonly maxCandidates: number;
  readonly searchIterations: number;
  readonly workItemDeadlineHorizonDays: number;
  readonly selectionWeightFloor: number;
  readonly selectionWeightOffset: number;
  readonly score: PlannerScoreWeights;
}

export const DEFAULT_PLANNER_CONFIG: PlannerConfig = {
  algorithmVersion: PLANNER_ALGORITHM_VERSION,
  configVersion: PLANNER_CONFIG_VERSION,
  prngVersion: PLANNER_PRNG_VERSION,
  maxCandidates: 128,
  searchIterations: 32,
  workItemDeadlineHorizonDays: 14,
  selectionWeightFloor: 100,
  selectionWeightOffset: 250,
  score: {
    priority: { low: 1_000, medium: 2_000, high: 3_500, critical: 5_000 },
    cadenceDeficit: 1_200,
    targetMetPenalty: -3_500,
    minimumDeficit: 1_500,
    minimumNearBoundary: 750,
    neglectPerDay: 80,
    neglectMaximum: 2_400,
    neverCompleted: 1_200,
    preferredWeekday: 600,
    energyMatch: 300,
    energyMismatch: -400,
    contextMatch: 250,
    enjoyable: 100,
    unpleasant: -100,
    recentCompletion: -250,
    consecutiveDay: -1_200,
    skipFatigue: -200,
    workItemDeadlineDueToday: 3_000,
    workItemDeadlineFuturePerDay: 200,
    workItemDeadlineOverdueBase: 3_500,
    workItemDeadlineOverduePerDay: 250,
    workItemDeadlineOverdueMaximum: 5_000,
  },
};

export type EligibilityCode =
  | "workspace_mismatch"
  | "routine_inactive"
  | "not_started"
  | "ended"
  | "temporarily_paused"
  | "feedback_not_today"
  | "feedback_not_this_week"
  | "excluded_weekday"
  | "context_unavailable"
  | "maximum_reached"
  | "minimum_spacing"
  | "consecutive_day_prohibited"
  | "duration_does_not_fit"
  | "work_item_not_plannable"
  | "work_item_status_ineligible"
  | "work_item_dependency_unsatisfied";

export const planSourceTypes = ["routine", "work_item"] as const;
export type PlanSourceType = (typeof planSourceTypes)[number];

export interface PlanSource {
  readonly sourceType: PlanSourceType;
  readonly routineId: RoutineId | null;
  readonly workItemId: WorkItemId | null;
}

export interface RoutineEvaluation {
  readonly routineId: RoutineId;
  readonly eligible: boolean;
  readonly exclusionCodes: readonly EligibilityCode[];
  readonly periodCompletions: number;
  readonly targetReached: boolean;
  readonly lastCompletedOn: LocalDate | null;
  readonly minimumScheduledMinutes: number;
  readonly desiredScheduledMinutes: number;
  readonly score: number;
  readonly scoreComponents: Readonly<Record<string, number>>;
  readonly reasons: readonly string[];
}

export interface WorkItemEvaluation {
  readonly workItemId: WorkItemId;
  readonly eligible: boolean;
  readonly exclusionCodes: readonly EligibilityCode[];
  readonly minimumScheduledMinutes: number;
  readonly desiredScheduledMinutes: number;
  readonly score: number;
  readonly scoreComponents: Readonly<Record<string, number>>;
  readonly reasons: readonly string[];
}

export interface PlanItem extends PlanSource {
  readonly id: PlanItemId;
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
  readonly lastActivityEventId: ActivityEvent["id"] | null;
  readonly activityUpdatedAt: Date | null;
}

export interface PlanExclusion extends PlanSource {
  readonly title: string;
  readonly codes: readonly EligibilityCode[];
}

export type PlanWarning =
  | "candidate_limit_applied"
  | "no_eligible_routines"
  | "no_feasible_combination"
  | "minimum_minutes_unmet"
  | "minimum_task_count_unmet"
  | "target_minutes_unmet"
  | "target_task_count_unmet";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

export interface DailyPlan {
  readonly id: DailyPlanId;
  readonly workspaceId: WorkspaceId;
  readonly date: LocalDate;
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
  readonly inputSnapshot: JsonValue;
  readonly exclusions: readonly PlanExclusion[];
  readonly warnings: readonly PlanWarning[];
  readonly generatedAt: Date;
}

export interface DailyPlanAlternativeItem extends PlanSource {
  readonly title: string;
  readonly windowIndex: number;
  readonly scheduledMinutes: number;
  readonly partialSession: boolean;
  readonly score: number;
  readonly reasons: readonly string[];
}

export interface DailyPlanAlternativePlacementChange extends PlanSource {
  readonly fromWindowIndex: number;
  readonly toWindowIndex: number;
  readonly fromScheduledMinutes: number;
  readonly toScheduledMinutes: number;
  readonly fromPartialSession: boolean;
  readonly toPartialSession: boolean;
}

export interface DailyPlanAlternative {
  readonly candidateKey: string;
  readonly items: readonly DailyPlanAlternativeItem[];
  readonly totalMinutes: number;
  readonly taskCount: number;
  readonly fitness: number;
  readonly warnings: readonly PlanWarning[];
  readonly deltaMinutes: number;
  readonly deltaTaskCount: number;
  readonly addedSourceKeys: readonly string[];
  readonly removedSourceKeys: readonly string[];
  readonly changedPlacements: readonly DailyPlanAlternativePlacementChange[];
}

export interface DailyPlanAlternativesPreview {
  readonly primary: DailyPlan;
  readonly alternatives: readonly DailyPlanAlternative[];
}

export interface GenerateDailyPlanInput {
  readonly id?: DailyPlanId;
  readonly request: DailyPlanningRequest;
  readonly routines: readonly Routine[];
  readonly workItems?: readonly WorkItem[];
  readonly workItemDependencies?: readonly PlanningWorkItemDependency[];
  readonly events: readonly ActivityEvent[];
  readonly routineFeedback?: readonly RoutinePlanningFeedback[];
  /** Explicit user ranking signals. These never affect cadence or eligibility. */
  readonly routineSelectionPreferenceFeedback?: readonly RoutineSelectionPreferenceFeedback[];
  readonly config?: PlannerConfig;
  readonly generatedAt?: Date;
}

interface Candidate {
  readonly source: PlanSource;
  readonly routine: Routine | null;
  readonly workItem: WorkItem | null;
  readonly evaluation: RoutineEvaluation | WorkItemEvaluation;
  readonly selectionWeight: number;
}

export function planSourceKey(source: PlanSource): string {
  invariant(
    (source.sourceType === "routine" && source.routineId !== null && source.workItemId === null) ||
      (source.sourceType === "work_item" &&
        source.workItemId !== null &&
        source.routineId === null),
    "planning.source_invalid",
    "A plan source must identify exactly one routine or work item.",
  );
  return `${source.sourceType}:${source.sourceType === "routine" ? source.routineId : source.workItemId}`;
}

interface MutablePlacement {
  readonly candidate: Candidate;
  readonly windowIndex: number;
  readonly scheduledMinutes: number;
  readonly partialSession: boolean;
}

interface CandidatePlan {
  readonly placements: readonly MutablePlacement[];
  readonly totalMinutes: number;
  readonly fitness: number;
  readonly key: string;
}

const MAXIMUM_DAILY_PLAN_ALTERNATIVES = 3;
const DAILY_PLAN_ALTERNATIVE_KEY_VERSION = "daily-plan-alternative-v1";

function wholeNumber(value: number, code: string, message: string, minimum: number): void {
  invariant(Number.isInteger(value) && value >= minimum, code, message);
}

function normalizeContexts(values: readonly string[] | undefined): readonly string[] {
  const contexts = (values ?? [])
    .map((value) => value.trim().toLocaleLowerCase("en-US"))
    .filter((value) => value.length > 0);
  invariant(
    contexts.every((value) => value.length <= 64),
    "planning.context_invalid",
    "Planning contexts cannot exceed 64 characters.",
  );
  return [...new Set(contexts)].sort((left, right) => left.localeCompare(right, "en"));
}

function windowMinutes(window: TimeWindow): number {
  return Math.floor((window.endsAt.getTime() - window.startsAt.getTime()) / 60_000);
}

export function createDailyPlanningRequest(
  input: CreateDailyPlanningRequestInput,
): DailyPlanningRequest {
  invariant(
    isIanaTimeZone(input.timeZone),
    "planning.time_zone_invalid",
    "A valid IANA planning time zone is required.",
  );
  const date = localDate(input.date);
  const windows = input.availableWindows
    .map((window) => ({ startsAt: new Date(window.startsAt), endsAt: new Date(window.endsAt) }))
    .sort((left, right) => left.startsAt.getTime() - right.startsAt.getTime());
  for (const [index, window] of windows.entries()) {
    invariant(
      Number.isFinite(window.startsAt.getTime()) && Number.isFinite(window.endsAt.getTime()),
      "planning.window_invalid",
      "Planning windows require valid start and end instants.",
    );
    invariant(
      windowMinutes(window) > 0,
      "planning.window_empty",
      "A planning window must contain at least one full minute.",
    );
    const previous = windows[index - 1];
    invariant(
      previous === undefined || previous.endsAt <= window.startsAt,
      "planning.windows_overlap",
      "Planning windows cannot overlap.",
    );
  }

  wholeNumber(
    input.targetMinutes,
    "planning.target_minutes_invalid",
    "Target minutes must be a positive whole number.",
    1,
  );
  wholeNumber(
    input.targetTaskCount,
    "planning.target_count_invalid",
    "Target task count must be a positive whole number.",
    1,
  );
  const availableMinutes = windows.reduce((total, window) => total + windowMinutes(window), 0);
  const minimumMinutes = input.minimumMinutes ?? 0;
  const maximumMinutes = input.maximumMinutes ?? Math.max(input.targetMinutes, availableMinutes);
  const minimumTaskCount = input.minimumTaskCount ?? 0;
  const maximumTaskCount = input.maximumTaskCount ?? input.targetTaskCount;
  wholeNumber(
    minimumMinutes,
    "planning.minimum_minutes_invalid",
    "Minimum minutes must be a non-negative whole number.",
    0,
  );
  wholeNumber(
    maximumMinutes,
    "planning.maximum_minutes_invalid",
    "Maximum minutes must be a positive whole number.",
    1,
  );
  wholeNumber(
    minimumTaskCount,
    "planning.minimum_count_invalid",
    "Minimum task count must be a non-negative whole number.",
    0,
  );
  wholeNumber(
    maximumTaskCount,
    "planning.maximum_count_invalid",
    "Maximum task count must be a positive whole number.",
    1,
  );
  invariant(
    minimumMinutes <= input.targetMinutes && input.targetMinutes <= maximumMinutes,
    "planning.minute_bounds_invalid",
    "Minute bounds must satisfy minimum <= target <= maximum.",
  );
  invariant(
    minimumTaskCount <= input.targetTaskCount && input.targetTaskCount <= maximumTaskCount,
    "planning.count_bounds_invalid",
    "Task-count bounds must satisfy minimum <= target <= maximum.",
  );
  const fitPreference = input.fitPreference ?? "balanced";
  invariant(
    planningFitPreferences.some((preference) => preference === fitPreference),
    "planning.fit_preference_invalid",
    "A supported planning fit preference is required.",
  );
  const energy = input.energy ?? null;
  invariant(
    energy === null || energyLevels.some((level) => level === energy),
    "planning.energy_invalid",
    "A supported planning energy level is required.",
  );
  const seed = input.seed.trim();
  invariant(
    seed.length > 0 && seed.length <= 240,
    "planning.seed_invalid",
    "A planning seed must contain between 1 and 240 characters.",
  );
  const requestRevision = input.requestRevision ?? 1;
  wholeNumber(
    requestRevision,
    "planning.revision_invalid",
    "Planning revision must be a positive whole number.",
    1,
  );
  const planFitInsightKey = input.planFitInsightKey?.trim() ?? null;
  invariant(
    planFitInsightKey === null || /^[0-9a-f]{64}$/.test(planFitInsightKey),
    "planning.plan_fit_insight_key_invalid",
    "A canonical Daily Plan Fit insight key is required when Plan Fit guidance is selected.",
  );

  return {
    workspaceId: input.workspaceId,
    date,
    timeZone: input.timeZone,
    availableWindows: windows,
    targetMinutes: input.targetMinutes,
    minimumMinutes,
    maximumMinutes,
    targetTaskCount: input.targetTaskCount,
    minimumTaskCount,
    maximumTaskCount,
    fitPreference,
    energy,
    availableContexts: normalizeContexts(input.availableContexts),
    seed,
    requestRevision,
    ...(planFitInsightKey === null ? {} : { planFitInsightKey }),
  };
}

function canonicalEvents(
  events: readonly ActivityEvent[],
  request: DailyPlanningRequest,
): ActivityEvent[] {
  return events
    .filter((event) => event.workspaceId === request.workspaceId && event.localDate <= request.date)
    .slice()
    .sort(
      (left, right) =>
        left.occurredAt.getTime() - right.occurredAt.getTime() ||
        left.recordedAt.getTime() - right.recordedAt.getTime() ||
        left.id.localeCompare(right.id, "en"),
    );
}

function activeCompletions(events: readonly ActivityEvent[], routine: Routine): ActivityEvent[] {
  const routineEvents = events.filter((event) => event.routineId === routine.id);
  const reversedIds = new Set(
    routineEvents
      .filter((event) => event.type === "completion_reversed" && event.referenceEventId !== null)
      .map((event) => event.referenceEventId),
  );
  return routineEvents.filter((event) => event.type === "completed" && !reversedIds.has(event.id));
}

function weekStart(date: LocalDate, policy: CadencePolicy): LocalDate {
  const distance = (weekdayOf(date) - policy.weekStartsOn + 7) % 7;
  return addLocalDays(date, -distance);
}

function isInCurrentPeriod(
  date: LocalDate,
  requestDate: LocalDate,
  policy: CadencePolicy,
): boolean {
  if (date > requestDate) return false;
  switch (policy.period) {
    case "day":
      return date === requestDate;
    case "week": {
      const start = weekStart(requestDate, policy);
      return date >= start && date <= addLocalDays(start, 6);
    }
    case "month":
      return date.slice(0, 7) === requestDate.slice(0, 7);
    case "rolling_days": {
      const interval = policy.rollingIntervalDays ?? 1;
      const difference = daysBetweenLocalDates(date, requestDate);
      return difference >= 0 && difference < interval;
    }
  }
}

function daysRemainingInPeriod(date: LocalDate, policy: CadencePolicy): number | null {
  switch (policy.period) {
    case "day":
      return 0;
    case "week":
      return daysBetweenLocalDates(date, addLocalDays(weekStart(date, policy), 6));
    case "month": {
      const [yearText, monthText] = date.split("-");
      const year = Number(yearText);
      const month = Number(monthText);
      const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
      return lastDay - Number(date.slice(8, 10));
    }
    case "rolling_days":
      return null;
  }
}

function completionStreak(completions: readonly ActivityEvent[], requestDate: LocalDate): number {
  const dates = [...new Set(completions.map((event) => event.localDate))].sort((a, b) =>
    b.localeCompare(a, "en"),
  );
  const latest = dates[0];
  if (latest === undefined) return 0;
  const latestDistance = daysBetweenLocalDates(latest, requestDate);
  if (latestDistance < 0 || latestDistance > 1) return 0;
  let streak = 1;
  for (let index = 1; index < dates.length; index += 1) {
    const previous = dates[index - 1];
    const current = dates[index];
    if (
      previous === undefined ||
      current === undefined ||
      daysBetweenLocalDates(current, previous) !== 1
    ) {
      break;
    }
    streak += 1;
  }
  return streak;
}

function formatPeriod(period: CadencePolicy["period"]): string {
  return period === "rolling_days" ? "rolling period" : period;
}

export function evaluateRoutineForPlan(
  routine: Routine,
  allEvents: readonly ActivityEvent[],
  request: DailyPlanningRequest,
  config: PlannerConfig = DEFAULT_PLANNER_CONFIG,
  routineFeedback: readonly RoutinePlanningFeedback[] = [],
  selectionPreferenceFeedback: readonly RoutineSelectionPreferenceFeedback[] = [],
): RoutineEvaluation {
  const events = canonicalEvents(allEvents, request);
  const completions = activeCompletions(events, routine);
  const periodCompletions = completions.filter((event) =>
    isInCurrentPeriod(event.localDate, request.date, routine.cadence),
  ).length;
  const lastCompletedOn = completions.reduce<LocalDate | null>(
    (latest, event) => (latest === null || event.localDate > latest ? event.localDate : latest),
    null,
  );
  const targetReached = periodCompletions >= routine.cadence.targetCompletions;
  const minimumScheduledMinutes =
    (routine.duration.splittable
      ? (routine.duration.minimumSessionMinutes ?? routine.duration.minimumMinutes)
      : routine.duration.expectedMinutes) + routine.duration.overheadMinutes;
  const desiredScheduledMinutes =
    routine.duration.expectedMinutes + routine.duration.overheadMinutes;
  const weekday = weekdayOf(request.date);
  const maximumWindowMinutes = request.availableWindows.reduce(
    (maximum, window) => Math.max(maximum, windowMinutes(window)),
    0,
  );
  const exclusions: EligibilityCode[] = [];
  const activeFeedback = activeRoutinePlanningFeedback(
    routineFeedback,
    request.workspaceId,
    routine.id,
    request.date,
  );

  if (routine.workspaceId !== request.workspaceId) exclusions.push("workspace_mismatch");
  if (routine.status !== "active") exclusions.push("routine_inactive");
  if (activeFeedback?.kind === "not_today") exclusions.push("feedback_not_today");
  if (activeFeedback?.kind === "not_this_week") exclusions.push("feedback_not_this_week");
  if (routine.cadence.startsOn !== null && request.date < routine.cadence.startsOn) {
    exclusions.push("not_started");
  }
  if (routine.cadence.endsOn !== null && request.date > routine.cadence.endsOn) {
    exclusions.push("ended");
  }
  if (routine.cadence.pausedUntil !== null && request.date <= routine.cadence.pausedUntil) {
    exclusions.push("temporarily_paused");
  }
  if (routine.cadence.excludedWeekdays.includes(weekday)) exclusions.push("excluded_weekday");
  if (
    routine.tags.contexts.length > 0 &&
    !routine.tags.contexts.some((context) => request.availableContexts.includes(context))
  ) {
    exclusions.push("context_unavailable");
  }
  if (
    routine.cadence.maximumCompletions !== null &&
    periodCompletions >= routine.cadence.maximumCompletions
  ) {
    exclusions.push("maximum_reached");
  }
  if (lastCompletedOn !== null) {
    const distance = daysBetweenLocalDates(lastCompletedOn, request.date);
    if (
      routine.cadence.minimumSpacingDays > 0 &&
      distance >= 0 &&
      distance <= routine.cadence.minimumSpacingDays
    ) {
      exclusions.push("minimum_spacing");
    }
    if (routine.cadence.prohibitConsecutiveDays && distance === 1) {
      exclusions.push("consecutive_day_prohibited");
    }
  }
  if (
    minimumScheduledMinutes > maximumWindowMinutes ||
    minimumScheduledMinutes > request.maximumMinutes
  ) {
    exclusions.push("duration_does_not_fit");
  }

  const scoreComponents: Record<string, number> = {};
  scoreComponents.priority = config.score.priority[routine.tags.priority];
  const cadenceDeficit = Math.max(0, routine.cadence.targetCompletions - periodCompletions);
  scoreComponents.cadenceDeficit = cadenceDeficit * config.score.cadenceDeficit;
  scoreComponents.targetReached = targetReached ? config.score.targetMetPenalty : 0;
  const minimumDeficit = Math.max(0, (routine.cadence.minimumCompletions ?? 0) - periodCompletions);
  scoreComponents.minimumDeficit = minimumDeficit * config.score.minimumDeficit;
  const remainingDays = daysRemainingInPeriod(request.date, routine.cadence);
  scoreComponents.minimumNearBoundary =
    minimumDeficit > 0 && remainingDays !== null && remainingDays <= 2
      ? config.score.minimumNearBoundary * (3 - remainingDays)
      : 0;
  if (lastCompletedOn === null) {
    scoreComponents.neglect = config.score.neverCompleted;
  } else {
    const daysSince = Math.max(0, daysBetweenLocalDates(lastCompletedOn, request.date));
    scoreComponents.neglect = Math.min(
      config.score.neglectMaximum,
      daysSince * config.score.neglectPerDay,
    );
  }
  scoreComponents.preferredWeekday = routine.cadence.preferredWeekdays.includes(weekday)
    ? config.score.preferredWeekday
    : 0;
  scoreComponents.energy =
    request.energy === null
      ? 0
      : request.energy === routine.tags.energy
        ? config.score.energyMatch
        : config.score.energyMismatch;
  scoreComponents.context =
    routine.tags.contexts.length > 0 &&
    routine.tags.contexts.some((context) => request.availableContexts.includes(context))
      ? config.score.contextMatch
      : 0;
  scoreComponents.preference =
    routine.tags.preference === "enjoyable"
      ? config.score.enjoyable
      : routine.tags.preference === "unpleasant"
        ? config.score.unpleasant
        : 0;
  const recentCompletions = completions.filter((event) => {
    const distance = daysBetweenLocalDates(event.localDate, request.date);
    return distance >= 0 && distance < 7;
  }).length;
  scoreComponents.recentFrequency = Math.min(recentCompletions, 4) * config.score.recentCompletion;
  const streak = completionStreak(completions, request.date);
  scoreComponents.consecutiveDays =
    routine.cadence.discourageConsecutiveDays && streak > 0
      ? streak * config.score.consecutiveDay
      : 0;
  const recentSkips = events.filter((event) => {
    if (event.routineId !== routine.id || !["skipped", "dismissed"].includes(event.type)) {
      return false;
    }
    const distance = daysBetweenLocalDates(event.localDate, request.date);
    return distance >= 0 && distance < 7;
  }).length;
  scoreComponents.skipFatigue = Math.min(recentSkips, 4) * config.score.skipFatigue;
  const selectionPreferenceScore = routineSelectionPreferenceScore(
    selectionPreferenceFeedback,
    request.workspaceId,
    routine.id,
    request.date,
  );
  if (selectionPreferenceFeedback.some((feedback) => feedback.routineId === routine.id)) {
    scoreComponents.selectionPreferenceFeedback = selectionPreferenceScore;
  }
  const score = Object.values(scoreComponents).reduce((total, component) => total + component, 0);

  const reasons = [
    `${routine.tags.priority[0]?.toUpperCase() ?? ""}${routine.tags.priority.slice(1)} priority.`,
    `${periodCompletions} of ${routine.cadence.targetCompletions} target completions in the current ${formatPeriod(routine.cadence.period)}.`,
  ];
  if (lastCompletedOn === null) {
    reasons.push("No completion has been recorded yet.");
  } else {
    reasons.push(
      `Last completed ${daysBetweenLocalDates(lastCompletedOn, request.date)} local day(s) ago.`,
    );
  }
  if (scoreComponents.preferredWeekday > 0) reasons.push("Today is a preferred weekday.");
  if (targetReached)
    reasons.push("The cadence target is already satisfied, so its weight is reduced.");
  if (minimumDeficit > 0)
    reasons.push(`The cadence minimum still needs ${minimumDeficit} completion(s).`);
  if (activeFeedback?.kind === "not_today") {
    reasons.push("You asked not to see this routine again today.");
  }
  if (activeFeedback?.kind === "not_this_week") {
    reasons.push("You asked not to see this routine again this week.");
  }
  const selectionPreferenceReason = routineSelectionPreferenceReason(selectionPreferenceScore);
  if (selectionPreferenceFeedback.length > 0 && selectionPreferenceReason !== null) {
    reasons.push(selectionPreferenceReason);
  }

  return {
    routineId: routine.id,
    eligible: exclusions.length === 0,
    exclusionCodes: [...new Set(exclusions)],
    periodCompletions,
    targetReached,
    lastCompletedOn,
    minimumScheduledMinutes,
    desiredScheduledMinutes,
    score,
    scoreComponents,
    reasons,
  };
}

const workItemPriorityScore: Readonly<Record<WorkItem["priority"], number>> = {
  none: 0,
  low: 1_000,
  medium: 2_000,
  high: 3_500,
  urgent: 5_000,
};

/** Work is deliberately history-free: it is a one-time candidate, not a cadence. */
export function evaluateWorkItemForPlan(
  workItem: WorkItem,
  request: DailyPlanningRequest,
  config: PlannerConfig = DEFAULT_PLANNER_CONFIG,
  dependencies: readonly PlanningWorkItemDependency[] = [],
): WorkItemEvaluation {
  const exclusions: EligibilityCode[] = [];
  const duration = workItem.planningDurationMinutes;
  if (workItem.workspaceId !== request.workspaceId) exclusions.push("workspace_mismatch");
  if (duration === null) exclusions.push("work_item_not_plannable");
  if (!["backlog", "planned", "in_progress"].includes(workItem.status)) {
    exclusions.push("work_item_status_ineligible");
  }
  const unsatisfiedPrerequisites = dependencies.filter(
    (dependency) =>
      dependency.dependentWorkItemId === workItem.id && dependency.prerequisiteStatus !== "done",
  );
  if (unsatisfiedPrerequisites.length > 0) {
    exclusions.push("work_item_dependency_unsatisfied");
  }
  if (
    duration !== null &&
    (duration > request.maximumMinutes ||
      duration > Math.max(...request.availableWindows.map(windowMinutes)))
  ) {
    exclusions.push("duration_does_not_fit");
  }
  const priorityScore = workItemPriorityScore[workItem.priority];
  const deadlinePressure = workItemDeadlinePressure(workItem.dueOn, request.date, config);
  const score = priorityScore + deadlinePressure;
  const scoreComponents: Record<string, number> = { priority: priorityScore };
  const reasons = [
    `${workItem.priority[0]?.toUpperCase() ?? ""}${workItem.priority.slice(1)} priority work item.`,
  ];
  if (workItem.dueOn !== null) {
    scoreComponents.deadlinePressure = deadlinePressure;
    reasons.push(
      workItemDeadlineReason(
        workItem.dueOn,
        request.date,
        deadlinePressure,
        config.workItemDeadlineHorizonDays,
      ),
    );
  }
  if (unsatisfiedPrerequisites.length > 0) {
    reasons.push(
      `Blocked by ${unsatisfiedPrerequisites.length} unfinished work item prerequisite(s).`,
    );
  }
  reasons.push("One-time work items do not use cadence or activity-history scoring.");
  return {
    workItemId: workItem.id,
    eligible: exclusions.length === 0,
    exclusionCodes: [...new Set(exclusions)],
    minimumScheduledMinutes: duration ?? 0,
    desiredScheduledMinutes: duration ?? 0,
    score,
    scoreComponents,
    reasons,
  };
}

function workItemDeadlinePressure(
  dueOn: LocalDate | null,
  date: LocalDate,
  config: PlannerConfig,
): number {
  if (dueOn === null) return 0;
  const daysUntilDue = daysBetweenLocalDates(date, dueOn);
  if (daysUntilDue === 0) return config.score.workItemDeadlineDueToday;
  if (daysUntilDue > 0) {
    return daysUntilDue <= config.workItemDeadlineHorizonDays
      ? (config.workItemDeadlineHorizonDays - daysUntilDue + 1) *
          config.score.workItemDeadlineFuturePerDay
      : 0;
  }
  return Math.min(
    config.score.workItemDeadlineOverdueMaximum,
    config.score.workItemDeadlineOverdueBase +
      -daysUntilDue * config.score.workItemDeadlineOverduePerDay,
  );
}

function workItemDeadlineReason(
  dueOn: LocalDate,
  date: LocalDate,
  deadlinePressure: number,
  deadlineHorizonDays: number,
): string {
  const daysUntilDue = daysBetweenLocalDates(date, dueOn);
  if (daysUntilDue === 0) return `Due today (+${deadlinePressure} deadline pressure).`;
  if (daysUntilDue < 0) {
    return `${-daysUntilDue} day(s) overdue (+${deadlinePressure} deadline pressure).`;
  }
  if (daysUntilDue > deadlineHorizonDays) {
    return `Due in ${daysUntilDue} day(s), outside the deadline horizon.`;
  }
  return `Due in ${daysUntilDue} day(s) (+${deadlinePressure} deadline pressure).`;
}

class Mulberry32 {
  private state: number;

  constructor(seed: string) {
    let hash = 2_166_136_261;
    for (let index = 0; index < seed.length; index += 1) {
      hash ^= seed.charCodeAt(index);
      hash = Math.imul(hash, 16_777_619);
    }
    this.state = hash >>> 0;
  }

  nextUint32(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let value = this.state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return (value ^ (value >>> 14)) >>> 0;
  }

  nextInt(maximumExclusive: number): number {
    invariant(
      Number.isInteger(maximumExclusive) &&
        maximumExclusive > 0 &&
        maximumExclusive <= 0x1_0000_0000,
      "planning.random_range_invalid",
      "Random integer range is invalid.",
    );
    const range = 0x1_0000_0000;
    const limit = Math.floor(range / maximumExclusive) * maximumExclusive;
    let value = this.nextUint32();
    while (value >= limit) value = this.nextUint32();
    return value % maximumExclusive;
  }
}

function weightedOrder(candidates: readonly Candidate[], random: Mulberry32): Candidate[] {
  const remaining = [...candidates];
  const result: Candidate[] = [];
  while (remaining.length > 0) {
    const totalWeight = remaining.reduce(
      (total, candidate) => total + candidate.selectionWeight,
      0,
    );
    let ticket = random.nextInt(totalWeight);
    let chosenIndex = 0;
    for (const [index, candidate] of remaining.entries()) {
      if (ticket < candidate.selectionWeight) {
        chosenIndex = index;
        break;
      }
      ticket -= candidate.selectionWeight;
    }
    const [chosen] = remaining.splice(chosenIndex, 1);
    if (chosen !== undefined) result.push(chosen);
  }
  return result;
}

function placeCandidate(
  candidate: Candidate,
  remainingWindows: number[],
  remainingBudget: number,
): { windowIndex: number; scheduledMinutes: number; partialSession: boolean } | null {
  const { evaluation, routine } = candidate;
  if (remainingBudget < evaluation.minimumScheduledMinutes) return null;

  if (routine === null || !routine.duration.splittable) {
    const viable = remainingWindows
      .map((minutes, index) => ({ index, minutes }))
      .filter(({ minutes }) => minutes >= evaluation.desiredScheduledMinutes)
      .sort((left, right) => left.minutes - right.minutes || left.index - right.index)[0];
    if (viable === undefined || evaluation.desiredScheduledMinutes > remainingBudget) return null;
    return {
      windowIndex: viable.index,
      scheduledMinutes: evaluation.desiredScheduledMinutes,
      partialSession: false,
    };
  }

  const viable = remainingWindows
    .map((minutes, index) => ({
      index,
      scheduledMinutes: Math.min(minutes, remainingBudget, evaluation.desiredScheduledMinutes),
    }))
    .filter(({ scheduledMinutes }) => scheduledMinutes >= evaluation.minimumScheduledMinutes)
    .sort(
      (left, right) => right.scheduledMinutes - left.scheduledMinutes || left.index - right.index,
    )[0];
  if (viable === undefined) return null;
  return {
    windowIndex: viable.index,
    scheduledMinutes: viable.scheduledMinutes,
    partialSession: viable.scheduledMinutes < evaluation.desiredScheduledMinutes,
  };
}

function fitWeights(preference: PlanningFitPreference): { time: number; count: number } {
  switch (preference) {
    case "time":
      return { time: 30, count: 300 };
    case "task_count":
      return { time: 8, count: 1_000 };
    case "balanced":
      return { time: 20, count: 600 };
  }
}

function planFitness(
  placements: readonly MutablePlacement[],
  totalMinutes: number,
  request: DailyPlanningRequest,
): number {
  const weights = fitWeights(request.fitPreference);
  const candidateScore = placements.reduce(
    (total, placement) => total + placement.candidate.evaluation.score,
    0,
  );
  const categoryCount = new Set(
    placements.flatMap((placement) => placement.candidate.routine?.tags.categories ?? []),
  ).size;
  const minimumMinuteShortfall = Math.max(0, request.minimumMinutes - totalMinutes);
  const minimumCountShortfall = Math.max(0, request.minimumTaskCount - placements.length);
  return (
    candidateScore +
    categoryCount * 150 -
    Math.abs(totalMinutes - request.targetMinutes) * weights.time -
    Math.abs(placements.length - request.targetTaskCount) * weights.count -
    minimumMinuteShortfall * 50 -
    minimumCountShortfall * 1_500
  );
}

function buildCandidatePlan(
  order: readonly Candidate[],
  request: DailyPlanningRequest,
): CandidatePlan {
  const remainingWindows = request.availableWindows.map(windowMinutes);
  const placements: MutablePlacement[] = [];
  let totalMinutes = 0;

  for (const candidate of order) {
    if (placements.length >= request.maximumTaskCount) break;
    if (placements.length >= request.targetTaskCount && totalMinutes >= request.targetMinutes) {
      break;
    }
    const placement = placeCandidate(
      candidate,
      remainingWindows,
      request.maximumMinutes - totalMinutes,
    );
    if (placement === null) continue;
    remainingWindows[placement.windowIndex] =
      (remainingWindows[placement.windowIndex] ?? 0) - placement.scheduledMinutes;
    totalMinutes += placement.scheduledMinutes;
    placements.push({ candidate, ...placement });
  }

  const key = placements.map((placement) => planSourceKey(placement.candidate.source)).join("|");
  return {
    placements,
    totalMinutes,
    fitness: planFitness(placements, totalMinutes, request),
    key,
  };
}

function chooseCandidatePlan(plans: readonly CandidatePlan[], random: Mulberry32): CandidatePlan {
  const sorted = [...plans].sort(
    (left, right) => right.fitness - left.fitness || left.key.localeCompare(right.key, "en"),
  );
  const finalists = sorted.slice(0, 8);
  const minimumFitness = Math.min(...finalists.map((plan) => plan.fitness));
  const weights = finalists.map((plan) => Math.min(10_000, plan.fitness - minimumFitness + 100));
  const totalWeight = weights.reduce((total, weight) => total + weight, 0);
  let ticket = random.nextInt(totalWeight);
  for (const [index, plan] of finalists.entries()) {
    const weight = weights[index] ?? 0;
    if (ticket < weight) return plan;
    ticket -= weight;
  }
  return finalists[0] as CandidatePlan;
}

function candidateWarnings(
  baseWarnings: readonly PlanWarning[],
  candidate: CandidatePlan,
  eligibleCount: number,
  request: DailyPlanningRequest,
): readonly PlanWarning[] {
  const warnings = [...baseWarnings];
  if (eligibleCount > 0 && candidate.placements.length === 0) {
    warnings.push("no_feasible_combination");
  }
  if (candidate.totalMinutes < request.minimumMinutes) warnings.push("minimum_minutes_unmet");
  if (candidate.placements.length < request.minimumTaskCount) {
    warnings.push("minimum_task_count_unmet");
  }
  if (candidate.totalMinutes < request.targetMinutes) warnings.push("target_minutes_unmet");
  if (candidate.placements.length < request.targetTaskCount) {
    warnings.push("target_task_count_unmet");
  }
  return [...new Set(warnings)];
}

function candidatePlacementSignature(candidate: CandidatePlan): string {
  return candidate.placements
    .map(
      (placement) =>
        `${planSourceKey(placement.candidate.source)}@${String(placement.windowIndex)}:${String(placement.scheduledMinutes)}:${placement.partialSession ? "1" : "0"}`,
    )
    .join("|");
}

function candidateAlternativeKey(inputHash: string, candidate: CandidatePlan): string {
  return createHash("sha256")
    .update(
      `${DAILY_PLAN_ALTERNATIVE_KEY_VERSION}\0${inputHash}\0${candidatePlacementSignature(candidate)}`,
    )
    .digest("hex");
}

function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    invariant(
      Number.isFinite(value),
      "planning.snapshot_number_invalid",
      "Snapshots require finite numbers.",
    );
    return value;
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(toJsonValue);
  invariant(
    typeof value === "object" && value !== null,
    "planning.snapshot_value_invalid",
    "Planner input contains a value that cannot be snapshotted.",
  );
  const result: Record<string, JsonValue> = {};
  for (const key of Object.keys(value).sort((left, right) => left.localeCompare(right, "en"))) {
    const child = (value as Record<string, unknown>)[key];
    if (child !== undefined) result[key] = toJsonValue(child);
  }
  return result;
}

/**
 * Validates one self-contained dependency projection and returns a stable copy.
 * Prerequisites may be absent from the candidate list because their joined status
 * is carried by the projection; every dependent must be a same-tenant candidate.
 */
export function canonicalPlanningWorkItemDependencies(
  dependencies: readonly PlanningWorkItemDependency[],
  workspaceId: WorkspaceId,
  workItems: readonly WorkItem[],
): readonly PlanningWorkItemDependency[] {
  const workItemsById = new Map(workItems.map((workItem) => [workItem.id, workItem]));
  const seenPrerequisitesByDependent = new Map<WorkItemId, Set<WorkItemId>>();
  const canonical: PlanningWorkItemDependency[] = [];

  for (const candidate of dependencies as readonly unknown[]) {
    invariant(
      typeof candidate === "object" && candidate !== null && !Array.isArray(candidate),
      "planning.work_item_dependency_invalid",
      "Planner work item dependencies must be structured records.",
    );
    const dependency = candidate as Record<string, unknown>;
    invariant(
      typeof dependency.workspaceId === "string" &&
        typeof dependency.prerequisiteWorkItemId === "string" &&
        dependency.prerequisiteWorkItemId.trim().length > 0 &&
        typeof dependency.dependentWorkItemId === "string" &&
        dependency.dependentWorkItemId.trim().length > 0,
      "planning.work_item_dependency_invalid",
      "Planner work item dependencies require tenant, prerequisite, and dependent identifiers.",
    );
    invariant(
      dependency.workspaceId === workspaceId,
      "planning.work_item_dependency_workspace_mismatch",
      "A planner work item dependency must belong to the requested workspace.",
    );
    invariant(
      workItemStatuses.some((status) => status === dependency.prerequisiteStatus),
      "planning.work_item_dependency_status_invalid",
      "A planner work item dependency requires a valid prerequisite status.",
    );

    const edge = createWorkItemDependency({
      workspaceId: dependency.workspaceId as WorkspaceId,
      prerequisiteWorkItemId: dependency.prerequisiteWorkItemId as WorkItemId,
      dependentWorkItemId: dependency.dependentWorkItemId as WorkItemId,
      createdAt: dependency.createdAt as Date,
    });
    const dependent = workItemsById.get(edge.dependentWorkItemId);
    invariant(
      dependent !== undefined && dependent.workspaceId === workspaceId,
      "planning.work_item_dependency_reference_invalid",
      "A planner dependency must reference a same-tenant dependent work item candidate.",
    );
    const prerequisite = workItemsById.get(edge.prerequisiteWorkItemId);
    invariant(
      prerequisite === undefined || prerequisite.workspaceId === workspaceId,
      "planning.work_item_dependency_reference_invalid",
      "A planner dependency cannot reference a cross-tenant prerequisite candidate.",
    );
    invariant(
      prerequisite === undefined || prerequisite.status === dependency.prerequisiteStatus,
      "planning.work_item_dependency_status_conflict",
      "A prerequisite candidate and its dependency projection must have the same status.",
    );

    const seenPrerequisites =
      seenPrerequisitesByDependent.get(edge.dependentWorkItemId) ?? new Set<WorkItemId>();
    invariant(
      !seenPrerequisites.has(edge.prerequisiteWorkItemId),
      "planning.duplicate_work_item_dependency",
      "A work item dependency appears more than once in the planner input.",
    );
    seenPrerequisites.add(edge.prerequisiteWorkItemId);
    seenPrerequisitesByDependent.set(edge.dependentWorkItemId, seenPrerequisites);
    canonical.push({
      ...edge,
      prerequisiteStatus: dependency.prerequisiteStatus as WorkItem["status"],
    });
  }

  return canonical.sort(
    (left, right) =>
      left.dependentWorkItemId.localeCompare(right.dependentWorkItemId, "en") ||
      left.prerequisiteWorkItemId.localeCompare(right.prerequisiteWorkItemId, "en"),
  );
}

function createInputSnapshot(
  request: DailyPlanningRequest,
  routines: readonly Routine[],
  workItems: readonly WorkItem[],
  workItemDependencies: readonly PlanningWorkItemDependency[],
  events: readonly ActivityEvent[],
  routineFeedback: readonly RoutinePlanningFeedback[],
  routineSelectionPreferenceFeedback: readonly RoutineSelectionPreferenceFeedback[],
  config: PlannerConfig,
): JsonValue {
  const canonicalRoutines = [...routines].sort((left, right) =>
    left.id.localeCompare(right.id, "en"),
  );
  const canonicalWorkItems = [...workItems].sort((left, right) =>
    left.id.localeCompare(right.id, "en"),
  );
  const canonicalActivity = canonicalEvents(events, request);
  return toJsonValue({
    config,
    events: canonicalActivity,
    request,
    routineFeedback,
    ...(routineSelectionPreferenceFeedback.length === 0
      ? {}
      : { routineSelectionPreferenceFeedback }),
    routines: canonicalRoutines,
    workItemDependencies,
    workItems: canonicalWorkItems,
  });
}

export function derivePlanItemId(
  plan: DailyPlanId,
  source: PlanSource | RoutineId,
  position: number,
): PlanItemId {
  const sourceKey = typeof source === "string" ? `routine:${source}` : planSourceKey(source);
  const hex = createHash("sha256").update(`${plan}:${sourceKey}:${position}`).digest("hex");
  return planItemId(
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`,
  );
}

function planDailyAlternatives(
  input: GenerateDailyPlanInput,
  selectedAlternativeKey?: string,
): DailyPlanAlternativesPreview {
  const id = input.id ?? dailyPlanId();
  const config = input.config ?? DEFAULT_PLANNER_CONFIG;
  invariant(
    config.algorithmVersion === PLANNER_ALGORITHM_VERSION,
    "planning.algorithm_version_unsupported",
    `Only ${PLANNER_ALGORITHM_VERSION} is supported by this implementation.`,
  );
  invariant(
    config.prngVersion === PLANNER_PRNG_VERSION,
    "planning.prng_version_unsupported",
    `Only ${PLANNER_PRNG_VERSION} is supported by this implementation.`,
  );
  wholeNumber(
    config.maxCandidates,
    "planning.candidate_limit_invalid",
    "Planner candidate limit must be positive.",
    1,
  );
  wholeNumber(
    config.searchIterations,
    "planning.search_iterations_invalid",
    "Planner search iterations must be positive.",
    1,
  );
  invariant(
    Number.isSafeInteger(config.workItemDeadlineHorizonDays) &&
      config.workItemDeadlineHorizonDays >= 0,
    "planning.work_item_deadline_horizon_invalid",
    "Work-item deadline horizon must be a non-negative safe whole number of days.",
  );
  invariant(
    config.configVersion.trim().length > 0 && config.configVersion.length <= 120,
    "planning.config_version_invalid",
    "Planner configuration version must contain between 1 and 120 characters.",
  );
  wholeNumber(
    config.selectionWeightFloor,
    "planning.selection_floor_invalid",
    "Planner selection-weight floor must be a positive whole number.",
    1,
  );
  wholeNumber(
    config.selectionWeightOffset,
    "planning.selection_offset_invalid",
    "Planner selection-weight offset must be a non-negative whole number.",
    0,
  );
  const scoreValues = [
    ...Object.values(config.score.priority),
    ...Object.entries(config.score)
      .filter(([key]) => key !== "priority")
      .map(([, value]) => value as number),
  ];
  invariant(
    scoreValues.every(
      (value) => Number.isSafeInteger(value) && Math.abs(value) <= MAXIMUM_PLANNER_SCORE_COMPONENT,
    ),
    "planning.score_weight_invalid",
    "Planner score weights must be safe whole numbers between -1,000,000 and 1,000,000.",
  );
  const deadlineScoreValues = [
    config.score.workItemDeadlineDueToday,
    config.score.workItemDeadlineFuturePerDay,
    config.score.workItemDeadlineOverdueBase,
    config.score.workItemDeadlineOverduePerDay,
    config.score.workItemDeadlineOverdueMaximum,
  ];
  invariant(
    deadlineScoreValues.every((value) => Number.isSafeInteger(value) && value >= 0),
    "planning.work_item_deadline_score_invalid",
    "Work-item deadline score weights must be non-negative safe whole numbers.",
  );
  const maximumFutureDeadlinePressure =
    config.workItemDeadlineHorizonDays * config.score.workItemDeadlineFuturePerDay;
  invariant(
    Number.isSafeInteger(maximumFutureDeadlinePressure) &&
      maximumFutureDeadlinePressure <= MAXIMUM_PLANNER_SCORE_COMPONENT,
    "planning.work_item_deadline_future_range_invalid",
    "Maximum future work-item deadline pressure must be a safe whole number no greater than 1,000,000.",
  );
  invariant(
    config.score.workItemDeadlineOverdueMaximum >= config.score.workItemDeadlineOverdueBase,
    "planning.work_item_deadline_overdue_bounds_invalid",
    "Work-item overdue maximum must be greater than or equal to the overdue base.",
  );
  const routineIds = new Set<RoutineId>();
  for (const routine of input.routines) {
    invariant(
      !routineIds.has(routine.id),
      "planning.duplicate_routine",
      `Routine ${routine.id} appears more than once in the planner input.`,
    );
    routineIds.add(routine.id);
  }
  const workItemIds = new Set<WorkItemId>();
  for (const workItem of input.workItems ?? []) {
    invariant(
      !workItemIds.has(workItem.id),
      "planning.duplicate_work_item",
      `Work item ${workItem.id} appears more than once in the planner input.`,
    );
    workItemIds.add(workItem.id);
  }
  const eventIds = new Set<string>();
  for (const event of input.events) {
    invariant(
      !eventIds.has(event.id),
      "planning.duplicate_activity_event",
      `Activity event ${event.id} appears more than once in the planner input.`,
    );
    eventIds.add(event.id);
  }
  const feedbackIds = new Set<string>();
  for (const feedback of input.routineFeedback ?? []) {
    invariant(
      !feedbackIds.has(feedback.id),
      "planning.duplicate_routine_feedback",
      `Routine planning feedback ${feedback.id} appears more than once in the planner input.`,
    );
    feedbackIds.add(feedback.id);
  }
  const selectionPreferenceFeedbackIds = new Set<string>();
  for (const feedback of input.routineSelectionPreferenceFeedback ?? []) {
    invariant(
      !selectionPreferenceFeedbackIds.has(feedback.id),
      "planning.duplicate_routine_selection_preference_feedback",
      `Routine selection preference feedback ${feedback.id} appears more than once in the planner input.`,
    );
    selectionPreferenceFeedbackIds.add(feedback.id);
  }
  const generatedAt = input.generatedAt ?? new Date();
  invariant(
    Number.isFinite(generatedAt.getTime()),
    "planning.generated_at_invalid",
    "A valid plan generation timestamp is required.",
  );

  const canonicalFeedback = canonicalRoutinePlanningFeedback(
    input.routineFeedback ?? [],
    input.request.workspaceId,
    input.request.date,
  );
  const canonicalSelectionPreferenceFeedback = canonicalRoutineSelectionPreferenceFeedback(
    input.routineSelectionPreferenceFeedback ?? [],
    input.request.workspaceId,
    input.request.date,
  );
  const canonicalWorkItemDependencies = canonicalPlanningWorkItemDependencies(
    input.workItemDependencies ?? [],
    input.request.workspaceId,
    input.workItems ?? [],
  );
  const dependenciesByDependent = new Map<WorkItemId, PlanningWorkItemDependency[]>();
  for (const dependency of canonicalWorkItemDependencies) {
    const current = dependenciesByDependent.get(dependency.dependentWorkItemId) ?? [];
    current.push(dependency);
    dependenciesByDependent.set(dependency.dependentWorkItemId, current);
  }
  const routineEvaluations = input.routines
    .slice()
    .sort((left, right) => left.id.localeCompare(right.id, "en"))
    .map((routine) => ({
      routine,
      workItem: null,
      source: { sourceType: "routine" as const, routineId: routine.id, workItemId: null },
      evaluation: evaluateRoutineForPlan(
        routine,
        input.events,
        input.request,
        config,
        canonicalFeedback,
        canonicalSelectionPreferenceFeedback,
      ),
    }));
  const workItemEvaluations = (input.workItems ?? [])
    .slice()
    .sort((left, right) => left.id.localeCompare(right.id, "en"))
    .map((workItem) => ({
      routine: null,
      workItem,
      source: { sourceType: "work_item" as const, routineId: null, workItemId: workItem.id },
      evaluation: evaluateWorkItemForPlan(
        workItem,
        input.request,
        config,
        dependenciesByDependent.get(workItem.id) ?? [],
      ),
    }));
  const evaluations = [...routineEvaluations, ...workItemEvaluations];
  const exclusions = evaluations
    .filter(({ evaluation }) => !evaluation.eligible)
    .map(({ routine, workItem, source, evaluation }) => ({
      ...source,
      title: routine?.title ?? workItem!.title,
      codes: evaluation.exclusionCodes,
    }));
  let eligible = evaluations.filter(({ evaluation }) => evaluation.eligible);
  const warnings: PlanWarning[] = [];
  if (eligible.length > config.maxCandidates) {
    warnings.push("candidate_limit_applied");
    eligible = eligible
      .sort(
        (left, right) =>
          right.evaluation.score - left.evaluation.score ||
          planSourceKey(left.source).localeCompare(planSourceKey(right.source), "en"),
      )
      .slice(0, config.maxCandidates);
  }
  if (eligible.length === 0) warnings.push("no_eligible_routines");

  const minimumScore = Math.min(0, ...eligible.map(({ evaluation }) => evaluation.score));
  const candidates: Candidate[] = eligible.map(({ routine, workItem, source, evaluation }) => ({
    routine,
    workItem,
    source,
    evaluation,
    selectionWeight: Math.min(
      1_000_000,
      Math.max(
        config.selectionWeightFloor,
        evaluation.score - minimumScore + config.selectionWeightOffset,
      ),
    ),
  }));
  const random = new Mulberry32(
    `${config.algorithmVersion}|${config.configVersion}|${input.request.seed}|${input.request.requestRevision}`,
  );
  const candidatePlans = new Map<string, CandidatePlan>();
  const scoreOrder = [...candidates].sort(
    (left, right) =>
      right.evaluation.score - left.evaluation.score ||
      planSourceKey(left.source).localeCompare(planSourceKey(right.source), "en"),
  );
  const deterministicPlan = buildCandidatePlan(scoreOrder, input.request);
  candidatePlans.set(deterministicPlan.key, deterministicPlan);
  for (let iteration = 0; iteration < config.searchIterations; iteration += 1) {
    const candidatePlan = buildCandidatePlan(weightedOrder(candidates, random), input.request);
    const current = candidatePlans.get(candidatePlan.key);
    if (current === undefined || candidatePlan.fitness > current.fitness) {
      candidatePlans.set(candidatePlan.key, candidatePlan);
    }
  }
  const chosen = chooseCandidatePlan([...candidatePlans.values()], random);

  const inputSnapshot = createInputSnapshot(
    input.request,
    input.routines,
    input.workItems ?? [],
    canonicalWorkItemDependencies,
    input.events,
    canonicalFeedback,
    canonicalSelectionPreferenceFeedback,
    config,
  );
  const baseInputHash = createHash("sha256").update(JSON.stringify(inputSnapshot)).digest("hex");
  const alternativeCandidates = [...candidatePlans.values()]
    .filter((candidate) => candidate.placements.length > 0 && candidate.key !== chosen.key)
    .map((candidate) => ({
      candidate,
      candidateKey: candidateAlternativeKey(baseInputHash, candidate),
    }))
    .sort(
      (left, right) =>
        right.candidate.fitness - left.candidate.fitness ||
        left.candidateKey.localeCompare(right.candidateKey, "en"),
    )
    .slice(0, MAXIMUM_DAILY_PLAN_ALTERNATIVES);
  const selected =
    selectedAlternativeKey === undefined
      ? null
      : (alternativeCandidates.find(
          (candidate) => candidate.candidateKey === selectedAlternativeKey,
        ) ?? null);
  invariant(
    selectedAlternativeKey === undefined || selected !== null,
    "planning.alternative_stale",
    "The selected daily-plan alternative is no longer available.",
  );

  const materialize = (candidate: CandidatePlan, candidateKey: string | null): DailyPlan => {
    const effectiveSnapshot =
      candidateKey === null
        ? inputSnapshot
        : toJsonValue({ plannerInput: inputSnapshot, selectedAlternativeKey: candidateKey });
    const effectiveInputHash = createHash("sha256")
      .update(JSON.stringify(effectiveSnapshot))
      .digest("hex");
    const items = candidate.placements.map((placement, position): PlanItem => ({
      id: derivePlanItemId(id, placement.candidate.source, position),
      ...placement.candidate.source,
      title: placement.candidate.routine?.title ?? placement.candidate.workItem!.title,
      position,
      windowIndex: placement.windowIndex,
      scheduledMinutes: placement.scheduledMinutes,
      partialSession: placement.partialSession,
      score: placement.candidate.evaluation.score,
      scoreComponents: placement.candidate.evaluation.scoreComponents,
      reasons: placement.candidate.evaluation.reasons,
      locked: false,
      activityState: "pending",
      lastActivityEventId: null,
      activityUpdatedAt: null,
    }));
    return {
      id,
      workspaceId: input.request.workspaceId,
      date: input.request.date,
      timeZone: input.request.timeZone,
      items,
      totalMinutes: candidate.totalMinutes,
      fitness: candidate.fitness,
      algorithmVersion: config.algorithmVersion,
      configVersion: config.configVersion,
      prngVersion: config.prngVersion,
      seed: input.request.seed,
      requestRevision: input.request.requestRevision,
      inputHash: effectiveInputHash,
      inputSnapshot: effectiveSnapshot,
      exclusions,
      warnings: candidateWarnings(warnings, candidate, eligible.length, input.request),
      generatedAt: new Date(generatedAt),
    };
  };

  const chosenSources = new Map(
    chosen.placements.map((placement) => [planSourceKey(placement.candidate.source), placement]),
  );
  const alternatives = alternativeCandidates.map(
    ({ candidate, candidateKey }): DailyPlanAlternative => {
      const alternativeSources = new Map(
        candidate.placements.map((placement) => [
          planSourceKey(placement.candidate.source),
          placement,
        ]),
      );
      const addedSourceKeys = [...alternativeSources.keys()]
        .filter((key) => !chosenSources.has(key))
        .sort((left, right) => left.localeCompare(right, "en"));
      const removedSourceKeys = [...chosenSources.keys()]
        .filter((key) => !alternativeSources.has(key))
        .sort((left, right) => left.localeCompare(right, "en"));
      const changedPlacements = [...alternativeSources.entries()]
        .flatMap(([key, placement]): DailyPlanAlternativePlacementChange[] => {
          const primaryPlacement = chosenSources.get(key);
          if (
            primaryPlacement === undefined ||
            (primaryPlacement.windowIndex === placement.windowIndex &&
              primaryPlacement.scheduledMinutes === placement.scheduledMinutes &&
              primaryPlacement.partialSession === placement.partialSession)
          ) {
            return [];
          }
          return [
            {
              ...placement.candidate.source,
              fromWindowIndex: primaryPlacement.windowIndex,
              toWindowIndex: placement.windowIndex,
              fromScheduledMinutes: primaryPlacement.scheduledMinutes,
              toScheduledMinutes: placement.scheduledMinutes,
              fromPartialSession: primaryPlacement.partialSession,
              toPartialSession: placement.partialSession,
            },
          ];
        })
        .sort((left, right) => planSourceKey(left).localeCompare(planSourceKey(right), "en"));
      return {
        candidateKey,
        items: candidate.placements.map((placement) => ({
          ...placement.candidate.source,
          title: placement.candidate.routine?.title ?? placement.candidate.workItem!.title,
          windowIndex: placement.windowIndex,
          scheduledMinutes: placement.scheduledMinutes,
          partialSession: placement.partialSession,
          score: placement.candidate.evaluation.score,
          reasons: placement.candidate.evaluation.reasons,
        })),
        totalMinutes: candidate.totalMinutes,
        taskCount: candidate.placements.length,
        fitness: candidate.fitness,
        warnings: candidateWarnings(warnings, candidate, eligible.length, input.request),
        deltaMinutes: candidate.totalMinutes - chosen.totalMinutes,
        deltaTaskCount: candidate.placements.length - chosen.placements.length,
        addedSourceKeys,
        removedSourceKeys,
        changedPlacements,
      };
    },
  );

  return {
    primary: materialize(
      selected?.candidate ?? chosen,
      selected === null ? null : selected.candidateKey,
    ),
    alternatives,
  };
}

export function generateDailyPlan(input: GenerateDailyPlanInput): DailyPlan {
  return planDailyAlternatives(input).primary;
}

export function previewDailyPlanAlternatives(
  input: GenerateDailyPlanInput,
): DailyPlanAlternativesPreview {
  return planDailyAlternatives(input);
}

export function selectDailyPlanAlternative(
  input: GenerateDailyPlanInput,
  candidateKey: string,
): DailyPlan {
  return planDailyAlternatives(input, candidateKey).primary;
}
