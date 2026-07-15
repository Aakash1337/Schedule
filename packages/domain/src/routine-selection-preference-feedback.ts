import { addLocalDays, isIanaTimeZone, localDate, type LocalDate } from "./calendar.js";
import { invariant } from "./errors.js";
import {
  routineSelectionPreferenceFeedbackId,
  type DailyPlanId,
  type PlanItemId,
  type RoutineId,
  type RoutineSelectionPreferenceFeedbackId,
  type WorkspaceId,
} from "./ids.js";

export const routineSelectionPreferenceFeedbackKinds = [
  "more_often",
  "less_often",
  "reset",
] as const;
export type RoutineSelectionPreferenceFeedbackKind =
  (typeof routineSelectionPreferenceFeedbackKinds)[number];

export const ROUTINE_SELECTION_PREFERENCE_EVENT_LIMIT = 8;
export const ROUTINE_SELECTION_PREFERENCE_LOOKBACK_DAYS = 90;
/** Finite append-only history per routine; roughly 19 years at one instruction per week. */
export const ROUTINE_SELECTION_PREFERENCE_MAX_RECORDED_EVENTS = 1_000;
export const ROUTINE_SELECTION_PREFERENCE_EVENT_SCORE = 100;
export const ROUTINE_SELECTION_PREFERENCE_MINIMUM_SCORE = -400;
export const ROUTINE_SELECTION_PREFERENCE_MAXIMUM_SCORE = 400;

/**
 * An immutable, user-authored selection preference. This is intentionally only
 * a routine ranking signal: it never changes cadence, duration, or eligibility.
 */
export interface RoutineSelectionPreferenceFeedback {
  readonly id: RoutineSelectionPreferenceFeedbackId;
  readonly ingestedSequence: number;
  readonly workspaceId: WorkspaceId;
  readonly routineId: RoutineId;
  readonly kind: RoutineSelectionPreferenceFeedbackKind;
  readonly effectiveOn: LocalDate;
  readonly timeZone: string;
  readonly sourcePlanId: DailyPlanId | null;
  readonly sourcePlanItemId: PlanItemId | null;
  readonly idempotencyKey: string;
  readonly recordedAt: Date;
}

export interface CreateRoutineSelectionPreferenceFeedbackInput {
  readonly id?: RoutineSelectionPreferenceFeedbackId;
  /** Zero is accepted before the persistence layer allocates the final sequence. */
  readonly ingestedSequence: number;
  readonly workspaceId: WorkspaceId;
  readonly routineId: RoutineId;
  readonly kind: RoutineSelectionPreferenceFeedbackKind;
  readonly effectiveOn: string;
  readonly timeZone: string;
  readonly sourcePlanId: DailyPlanId | null;
  readonly sourcePlanItemId: PlanItemId | null;
  readonly idempotencyKey: string;
  readonly recordedAt: Date;
}

export function createRoutineSelectionPreferenceFeedback(
  input: CreateRoutineSelectionPreferenceFeedbackInput,
): RoutineSelectionPreferenceFeedback {
  invariant(
    routineSelectionPreferenceFeedbackKinds.some((kind) => kind === input.kind),
    "planning.selection_preference_feedback_kind_invalid",
    "A supported routine selection preference feedback kind is required.",
  );
  invariant(
    Number.isSafeInteger(input.ingestedSequence) && input.ingestedSequence >= 0,
    "planning.selection_preference_feedback_sequence_invalid",
    "A non-negative feedback ingestion sequence is required.",
  );
  invariant(
    isIanaTimeZone(input.timeZone),
    "planning.selection_preference_feedback_time_zone_invalid",
    "A valid IANA feedback time zone is required.",
  );
  const idempotencyKey = input.idempotencyKey.trim();
  invariant(
    idempotencyKey.length >= 1 && idempotencyKey.length <= 160,
    "planning.selection_preference_feedback_idempotency_key_invalid",
    "A feedback idempotency key must contain 1–160 characters.",
  );
  invariant(
    input.recordedAt instanceof Date && Number.isFinite(input.recordedAt.getTime()),
    "planning.selection_preference_feedback_recorded_at_invalid",
    "A valid feedback recording timestamp is required.",
  );
  invariant(
    input.sourcePlanItemId === null || input.sourcePlanId !== null,
    "planning.selection_preference_feedback_source_plan_invalid",
    "Selection preference feedback with a source item must identify its source plan.",
  );
  invariant(
    input.kind !== "reset" || input.sourcePlanItemId === null,
    "planning.selection_preference_feedback_source_item_invalid",
    "A selection preference reset cannot identify a source plan item.",
  );
  return {
    id: input.id ?? routineSelectionPreferenceFeedbackId(),
    ingestedSequence: input.ingestedSequence,
    workspaceId: input.workspaceId,
    routineId: input.routineId,
    kind: input.kind,
    effectiveOn: localDate(input.effectiveOn),
    timeZone: input.timeZone,
    sourcePlanId: input.sourcePlanId,
    sourcePlanItemId: input.sourcePlanItemId,
    idempotencyKey,
    recordedAt: new Date(input.recordedAt),
  };
}

function compareFeedback(
  left: RoutineSelectionPreferenceFeedback,
  right: RoutineSelectionPreferenceFeedback,
): number {
  return left.ingestedSequence - right.ingestedSequence || left.id.localeCompare(right.id, "en");
}

/**
 * Returns the canonical directional events for every routine. It considers the
 * inclusive 90 local-day window ending on `asOf`, drops future events, resets
 * each routine at its latest reset, and bounds the remaining history to eight.
 */
export function canonicalRoutineSelectionPreferenceFeedback(
  feedback: readonly RoutineSelectionPreferenceFeedback[],
  workspaceId: WorkspaceId,
  asOf: LocalDate,
): readonly RoutineSelectionPreferenceFeedback[] {
  const earliest = addLocalDays(asOf, -(ROUTINE_SELECTION_PREFERENCE_LOOKBACK_DAYS - 1));
  const perRoutine = new Map<RoutineId, RoutineSelectionPreferenceFeedback[]>();
  for (const event of feedback) {
    if (
      event.workspaceId !== workspaceId ||
      event.effectiveOn < earliest ||
      event.effectiveOn > asOf
    ) {
      continue;
    }
    const events = perRoutine.get(event.routineId) ?? [];
    events.push(event);
    perRoutine.set(event.routineId, events);
  }
  return [...perRoutine.entries()]
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .flatMap(([, events]) => {
      const ordered = [...events].sort(compareFeedback);
      let resetIndex = -1;
      for (const [index, event] of ordered.entries()) {
        if (event.kind === "reset") resetIndex = index;
      }
      return ordered
        .slice(resetIndex + 1)
        .filter((event) => event.kind !== "reset")
        .slice(-ROUTINE_SELECTION_PREFERENCE_EVENT_LIMIT);
    });
}

export function routineSelectionPreferenceScore(
  feedback: readonly RoutineSelectionPreferenceFeedback[],
  workspaceId: WorkspaceId,
  routineId: RoutineId,
  asOf: LocalDate,
): number {
  const score = canonicalRoutineSelectionPreferenceFeedback(feedback, workspaceId, asOf)
    .filter((event) => event.routineId === routineId)
    .reduce(
      (total, event) =>
        total +
        (event.kind === "more_often"
          ? ROUTINE_SELECTION_PREFERENCE_EVENT_SCORE
          : -ROUTINE_SELECTION_PREFERENCE_EVENT_SCORE),
      0,
    );
  return Math.max(
    ROUTINE_SELECTION_PREFERENCE_MINIMUM_SCORE,
    Math.min(ROUTINE_SELECTION_PREFERENCE_MAXIMUM_SCORE, score),
  );
}

export function routineSelectionPreferenceReason(score: number): string | null {
  if (score > 0) {
    return `You asked to see this routine more often (+${score}).`;
  }
  if (score < 0) return `You asked to see this routine less often (${score}).`;
  return null;
}
