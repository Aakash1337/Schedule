import {
  addLocalDays,
  isIanaTimeZone,
  localDate,
  weekdayOf,
  type LocalDate,
  type Weekday,
} from "./calendar.js";
import { invariant } from "./errors.js";
import {
  routinePlanningFeedbackId,
  type DailyPlanId,
  type PlanItemId,
  type RoutineId,
  type RoutinePlanningFeedbackId,
  type WorkspaceId,
} from "./ids.js";

export const routinePlanningFeedbackKinds = ["not_today", "not_this_week", "reset"] as const;
export type RoutinePlanningFeedbackKind = (typeof routinePlanningFeedbackKinds)[number];

export const routinePlanningFeedbackSuppressionKinds = ["not_today", "not_this_week"] as const;
export type RoutinePlanningFeedbackSuppressionKind =
  (typeof routinePlanningFeedbackSuppressionKinds)[number];

/**
 * An immutable, user-authored planning instruction. A reset is itself an event so
 * clearing feedback never rewrites history or silently changes routine cadence.
 */
export interface RoutinePlanningFeedback {
  readonly id: RoutinePlanningFeedbackId;
  readonly ingestedSequence: number;
  readonly workspaceId: WorkspaceId;
  readonly routineId: RoutineId;
  readonly kind: RoutinePlanningFeedbackKind;
  readonly effectiveOn: LocalDate;
  readonly effectiveThrough: LocalDate | null;
  readonly timeZone: string;
  readonly sourcePlanId: DailyPlanId;
  readonly sourcePlanItemId: PlanItemId | null;
  readonly idempotencyKey: string;
  readonly recordedAt: Date;
}

export interface CreateRoutinePlanningFeedbackInput {
  readonly id?: RoutinePlanningFeedbackId;
  /** Zero is accepted before the persistence layer allocates the final sequence. */
  readonly ingestedSequence: number;
  readonly workspaceId: WorkspaceId;
  readonly routineId: RoutineId;
  readonly kind: RoutinePlanningFeedbackKind;
  readonly effectiveOn: string;
  readonly weekStartsOn: Weekday;
  readonly timeZone: string;
  readonly sourcePlanId: DailyPlanId;
  readonly sourcePlanItemId: PlanItemId | null;
  readonly idempotencyKey: string;
  readonly recordedAt: Date;
}

function endOfWeek(effectiveOn: LocalDate, weekStartsOn: Weekday): LocalDate {
  const elapsedDays = (weekdayOf(effectiveOn) - weekStartsOn + 7) % 7;
  return addLocalDays(effectiveOn, 6 - elapsedDays);
}

export function createRoutinePlanningFeedback(
  input: CreateRoutinePlanningFeedbackInput,
): RoutinePlanningFeedback {
  invariant(
    routinePlanningFeedbackKinds.some((kind) => kind === input.kind),
    "planning.feedback_kind_invalid",
    "A supported temporary planning feedback kind is required.",
  );
  invariant(
    Number.isSafeInteger(input.ingestedSequence) && input.ingestedSequence >= 0,
    "planning.feedback_sequence_invalid",
    "A non-negative feedback ingestion sequence is required.",
  );
  invariant(
    Number.isInteger(input.weekStartsOn) && input.weekStartsOn >= 0 && input.weekStartsOn <= 6,
    "planning.feedback_week_start_invalid",
    "Feedback week start must be a weekday from 0 through 6.",
  );
  invariant(
    isIanaTimeZone(input.timeZone),
    "planning.feedback_time_zone_invalid",
    "A valid IANA feedback time zone is required.",
  );
  const idempotencyKey = input.idempotencyKey.trim();
  invariant(
    idempotencyKey.length >= 1 && idempotencyKey.length <= 160,
    "planning.feedback_idempotency_key_invalid",
    "A feedback idempotency key must contain 1–160 characters.",
  );
  invariant(
    input.recordedAt instanceof Date && Number.isFinite(input.recordedAt.getTime()),
    "planning.feedback_recorded_at_invalid",
    "A valid feedback recording timestamp is required.",
  );
  const suppression = input.kind !== "reset";
  invariant(
    suppression ? input.sourcePlanItemId !== null : input.sourcePlanItemId === null,
    "planning.feedback_source_item_invalid",
    suppression
      ? "Temporary routine suppression must identify its source plan item."
      : "A feedback reset cannot identify a source plan item.",
  );

  const effectiveOn = localDate(input.effectiveOn);
  return {
    id: input.id ?? routinePlanningFeedbackId(),
    ingestedSequence: input.ingestedSequence,
    workspaceId: input.workspaceId,
    routineId: input.routineId,
    kind: input.kind,
    effectiveOn,
    effectiveThrough:
      input.kind === "reset"
        ? null
        : input.kind === "not_this_week"
          ? endOfWeek(effectiveOn, input.weekStartsOn)
          : effectiveOn,
    timeZone: input.timeZone,
    sourcePlanId: input.sourcePlanId,
    sourcePlanItemId: input.sourcePlanItemId,
    idempotencyKey,
    recordedAt: new Date(input.recordedAt),
  };
}

function isLaterFeedback(
  candidate: RoutinePlanningFeedback,
  current: RoutinePlanningFeedback | undefined,
): boolean {
  return (
    current === undefined ||
    candidate.ingestedSequence > current.ingestedSequence ||
    (candidate.ingestedSequence === current.ingestedSequence && candidate.id > current.id)
  );
}

/**
 * Returns one latest event per routine, ordered by routine id for stable input
 * snapshots. Future-effective events and events from another tenant are ignored.
 */
export function canonicalRoutinePlanningFeedback(
  feedback: readonly RoutinePlanningFeedback[],
  workspaceId: WorkspaceId,
  asOf: LocalDate,
): readonly RoutinePlanningFeedback[] {
  const latest = new Map<RoutineId, RoutinePlanningFeedback>();
  for (const candidate of feedback) {
    if (candidate.workspaceId !== workspaceId || candidate.effectiveOn > asOf) continue;
    const current = latest.get(candidate.routineId);
    if (isLaterFeedback(candidate, current)) latest.set(candidate.routineId, candidate);
  }
  return [...latest.values()].sort((left, right) => left.routineId.localeCompare(right.routineId));
}

/**
 * Resolves the active hard suppression without discarding the latest reset or
 * expired event from the planner's audit snapshot.
 */
export function activeRoutinePlanningFeedback(
  feedback: readonly RoutinePlanningFeedback[],
  workspaceId: WorkspaceId,
  routineId: RoutineId,
  asOf: LocalDate,
): RoutinePlanningFeedback | null {
  const latest = canonicalRoutinePlanningFeedback(feedback, workspaceId, asOf).find(
    (candidate) => candidate.routineId === routineId,
  );
  if (
    latest === undefined ||
    latest.kind === "reset" ||
    latest.effectiveThrough === null ||
    latest.effectiveThrough < asOf
  ) {
    return null;
  }
  return latest;
}
