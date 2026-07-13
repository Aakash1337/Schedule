import { invariant } from "./errors.js";
import {
  routineDurationInsightFeedbackId,
  type RoutineDurationInsightFeedbackId,
  type RoutineId,
  type WorkspaceId,
} from "./ids.js";
import { maximumRoutineVersion } from "./routine.js";
import type { RoutineDurationInsight } from "./routine-duration-insight.js";

export const routineDurationInsightFeedbackKinds = ["dismissed", "reset"] as const;
export type RoutineDurationInsightFeedbackKind =
  (typeof routineDurationInsightFeedbackKinds)[number];

export const routineDurationInsightKeyPattern = /^[0-9a-f]{64}$/;

/** An immutable user decision about one content-addressed duration insight. */
export interface RoutineDurationInsightFeedback {
  readonly id: RoutineDurationInsightFeedbackId;
  readonly ingestedSequence: number;
  readonly workspaceId: WorkspaceId;
  readonly routineId: RoutineId;
  readonly insightKey: string;
  readonly kind: RoutineDurationInsightFeedbackKind;
  readonly routineVersion: number;
  readonly observedMedianMinutes: number;
  readonly suggestedExpectedMinutes: number | null;
  readonly idempotencyKey: string;
  readonly recordedAt: Date;
}

export interface CreateRoutineDurationInsightFeedbackInput {
  readonly id?: RoutineDurationInsightFeedbackId;
  /** Zero is accepted before persistence allocates the final sequence. */
  readonly ingestedSequence: number;
  readonly workspaceId: WorkspaceId;
  readonly routineId: RoutineId;
  readonly insightKey: string;
  readonly kind: RoutineDurationInsightFeedbackKind;
  readonly routineVersion: number;
  readonly observedMedianMinutes: number;
  readonly suggestedExpectedMinutes: number | null;
  readonly idempotencyKey: string;
  readonly recordedAt: Date;
}

export function createRoutineDurationInsightFeedback(
  input: CreateRoutineDurationInsightFeedbackInput,
): RoutineDurationInsightFeedback {
  invariant(
    routineDurationInsightFeedbackKinds.some((kind) => kind === input.kind),
    "routine_duration_insight.feedback_kind_invalid",
    "A supported duration insight feedback kind is required.",
  );
  invariant(
    Number.isSafeInteger(input.ingestedSequence) && input.ingestedSequence >= 0,
    "routine_duration_insight.feedback_sequence_invalid",
    "A non-negative duration insight feedback ingestion sequence is required.",
  );
  invariant(
    routineDurationInsightKeyPattern.test(input.insightKey),
    "routine_duration_insight.feedback_key_invalid",
    "A lowercase SHA-256 duration insight key is required.",
  );
  invariant(
    Number.isSafeInteger(input.routineVersion) &&
      input.routineVersion >= 1 &&
      input.routineVersion <= maximumRoutineVersion,
    "routine_duration_insight.feedback_version_invalid",
    "A valid positive routine version snapshot is required.",
  );
  invariant(
    Number.isSafeInteger(input.observedMedianMinutes) && input.observedMedianMinutes > 0,
    "routine_duration_insight.feedback_observed_minutes_invalid",
    "Observed median minutes must be a positive whole number.",
  );
  invariant(
    input.suggestedExpectedMinutes === null ||
      (Number.isSafeInteger(input.suggestedExpectedMinutes) && input.suggestedExpectedMinutes > 0),
    "routine_duration_insight.feedback_suggested_minutes_invalid",
    "Suggested expected minutes must be null or a positive whole number.",
  );
  const idempotencyKey = input.idempotencyKey.trim();
  invariant(
    idempotencyKey.length >= 1 && idempotencyKey.length <= 160,
    "routine_duration_insight.feedback_idempotency_key_invalid",
    "A duration insight feedback idempotency key must contain 1–160 characters.",
  );
  invariant(
    input.recordedAt instanceof Date && Number.isFinite(input.recordedAt.getTime()),
    "routine_duration_insight.feedback_recorded_at_invalid",
    "A valid duration insight feedback recording timestamp is required.",
  );

  return {
    id: input.id ?? routineDurationInsightFeedbackId(),
    ingestedSequence: input.ingestedSequence,
    workspaceId: input.workspaceId,
    routineId: input.routineId,
    insightKey: input.insightKey,
    kind: input.kind,
    routineVersion: input.routineVersion,
    observedMedianMinutes: input.observedMedianMinutes,
    suggestedExpectedMinutes: input.suggestedExpectedMinutes,
    idempotencyKey,
    recordedAt: new Date(input.recordedAt),
  };
}

function isLaterFeedback(
  candidate: RoutineDurationInsightFeedback,
  current: RoutineDurationInsightFeedback | null,
): boolean {
  return (
    current === null ||
    candidate.ingestedSequence > current.ingestedSequence ||
    (candidate.ingestedSequence === current.ingestedSequence && candidate.id > current.id)
  );
}

/** Selects the canonical head for one tenant, routine, and content-addressed insight. */
export function latestRoutineDurationInsightFeedback(
  feedback: readonly RoutineDurationInsightFeedback[],
  workspaceId: WorkspaceId,
  routineId: RoutineId,
  insightKey: string,
): RoutineDurationInsightFeedback | null {
  let latest: RoutineDurationInsightFeedback | null = null;
  for (const candidate of feedback) {
    if (
      candidate.workspaceId === workspaceId &&
      candidate.routineId === routineId &&
      candidate.insightKey === insightKey &&
      isLaterFeedback(candidate, latest)
    ) {
      latest = candidate;
    }
  }
  return latest;
}

/** Applies the latest exact-key decision without mutating the calculated insight. */
export function resolveRoutineDurationInsightFeedback(
  insight: RoutineDurationInsight,
  workspaceId: WorkspaceId,
  feedback: readonly RoutineDurationInsightFeedback[],
): RoutineDurationInsight {
  if (insight.insightKey === null) return insight;
  const latest = latestRoutineDurationInsightFeedback(
    feedback,
    workspaceId,
    insight.routineId,
    insight.insightKey,
  );
  if (latest === null || latest.kind === "reset") {
    if (insight.disposition === "available" && insight.dismissedAt === null) return insight;
    return { ...insight, disposition: "available", dismissedAt: null };
  }
  return {
    ...insight,
    disposition: "dismissed",
    dismissedAt: new Date(latest.recordedAt),
  };
}
