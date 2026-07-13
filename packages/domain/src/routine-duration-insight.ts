import type { ActivityEvent } from "./activity-event.js";
import { invariant } from "./errors.js";
import type { Routine } from "./routine.js";

/** The trailing history window used for routine-duration calibration. */
export const routineDurationInsightLookbackDays = 90;
export const routineDurationInsightMinimumSamples = 3;

export const routineDurationInsightStatuses = [
  "insufficient_history",
  "aligned",
  "suggested",
  "review_range",
] as const;
export type RoutineDurationInsightStatus = (typeof routineDurationInsightStatuses)[number];

/**
 * A read-only explanation of whether a routine's expected duration matches its
 * recently completed sessions. This never changes the routine by itself.
 */
export interface RoutineDurationInsight {
  readonly routineId: Routine["id"];
  readonly routineVersion: number;
  readonly status: RoutineDurationInsightStatus;
  readonly sampleCount: number;
  readonly minimumSamples: number;
  readonly lookbackDays: number;
  readonly evaluatedAt: Date;
  readonly windowStartedAt: Date;
  readonly currentExpectedMinutes: number;
  readonly minimumMinutes: number;
  readonly maximumMinutes: number;
  readonly observedMedianMinutes: number | null;
  readonly materialThresholdMinutes: number;
  readonly suggestedExpectedMinutes: number | null;
}

function occursNoLaterThan(event: ActivityEvent, evaluatedAt: Date): boolean {
  return (
    event.occurredAt.getTime() <= evaluatedAt.getTime() &&
    event.recordedAt.getTime() <= evaluatedAt.getTime()
  );
}

function belongsToRoutine(event: ActivityEvent, routine: Routine): boolean {
  return (
    event.workspaceId === routine.workspaceId &&
    event.sourceType === "routine" &&
    event.routineId === routine.id
  );
}

function isLaterCorrection(candidate: ActivityEvent, current: ActivityEvent | undefined): boolean {
  if (current === undefined) return true;
  const candidateRecordedAt = candidate.recordedAt.getTime();
  const currentRecordedAt = current.recordedAt.getTime();
  return (
    candidateRecordedAt > currentRecordedAt ||
    (candidateRecordedAt === currentRecordedAt && candidate.id > current.id)
  );
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle]!;
  return Math.floor((sorted[middle - 1]! + sorted[middle]!) / 2 + 0.5);
}

/**
 * Derives an auditable duration insight from immutable routine activity.
 *
 * Only routine completion events inside the inclusive trailing 90-day window
 * are samples. Corrections and reversals may be supplied from outside that
 * window because they amend a qualifying completion.
 */
export function calculateRoutineDurationInsight(
  routine: Routine,
  activityEvents: readonly ActivityEvent[],
  evaluatedAt: Date,
): RoutineDurationInsight {
  invariant(
    evaluatedAt instanceof Date && Number.isFinite(evaluatedAt.getTime()),
    "routine_duration_insight.evaluated_at_invalid",
    "A valid insight evaluation timestamp is required.",
  );

  const evaluationTime = evaluatedAt.getTime();
  const windowStartedAt = new Date(
    evaluationTime - routineDurationInsightLookbackDays * 24 * 60 * 60 * 1_000,
  );
  const materialThresholdMinutes = Math.max(5, Math.ceil(routine.duration.expectedMinutes * 0.1));
  const base = {
    routineId: routine.id,
    routineVersion: routine.version,
    sampleCount: 0,
    minimumSamples: routineDurationInsightMinimumSamples,
    lookbackDays: routineDurationInsightLookbackDays,
    evaluatedAt: new Date(evaluatedAt),
    windowStartedAt,
    currentExpectedMinutes: routine.duration.expectedMinutes,
    minimumMinutes: routine.duration.minimumMinutes,
    maximumMinutes: routine.duration.maximumMinutes,
    materialThresholdMinutes,
  } as const;

  const qualifyingCompletions = activityEvents.filter(
    (event) =>
      belongsToRoutine(event, routine) &&
      event.type === "completed" &&
      event.durationMinutes !== null &&
      Number.isInteger(event.durationMinutes) &&
      event.durationMinutes > 0 &&
      occursNoLaterThan(event, evaluatedAt) &&
      event.occurredAt.getTime() >= windowStartedAt.getTime(),
  );
  const completionIds = new Set(qualifyingCompletions.map((event) => event.id));
  const corrections = new Map<ActivityEvent["id"], ActivityEvent>();
  const reversedCompletionIds = new Set<ActivityEvent["id"]>();

  for (const event of activityEvents) {
    if (!belongsToRoutine(event, routine) || !occursNoLaterThan(event, evaluatedAt)) continue;
    if (event.referenceEventId === null || !completionIds.has(event.referenceEventId)) continue;
    if (event.type === "completion_reversed") {
      reversedCompletionIds.add(event.referenceEventId);
      continue;
    }
    if (
      event.type === "duration_corrected" &&
      event.durationMinutes !== null &&
      Number.isInteger(event.durationMinutes) &&
      event.durationMinutes > 0
    ) {
      const current = corrections.get(event.referenceEventId);
      if (isLaterCorrection(event, current)) corrections.set(event.referenceEventId, event);
    }
  }

  const durations = qualifyingCompletions
    .filter((completion) => !reversedCompletionIds.has(completion.id))
    .map(
      (completion) =>
        corrections.get(completion.id)?.durationMinutes ?? completion.durationMinutes!,
    );
  const sampleCount = durations.length;
  if (sampleCount < routineDurationInsightMinimumSamples) {
    return {
      ...base,
      status: "insufficient_history",
      sampleCount,
      observedMedianMinutes: null,
      suggestedExpectedMinutes: null,
    };
  }

  const observedMedianMinutes = median(durations);
  if (
    observedMedianMinutes < routine.duration.minimumMinutes ||
    observedMedianMinutes > routine.duration.maximumMinutes
  ) {
    return {
      ...base,
      status: "review_range",
      sampleCount,
      observedMedianMinutes,
      suggestedExpectedMinutes: null,
    };
  }
  if (
    Math.abs(observedMedianMinutes - routine.duration.expectedMinutes) < materialThresholdMinutes
  ) {
    return {
      ...base,
      status: "aligned",
      sampleCount,
      observedMedianMinutes,
      suggestedExpectedMinutes: null,
    };
  }
  return {
    ...base,
    status: "suggested",
    sampleCount,
    observedMedianMinutes,
    suggestedExpectedMinutes: observedMedianMinutes,
  };
}
