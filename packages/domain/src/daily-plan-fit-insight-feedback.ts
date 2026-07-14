import { isValidLocalDate, type LocalDate } from "./calendar.js";
import { invariant } from "./errors.js";
import {
  dailyPlanFitInsightFeedbackId,
  type DailyPlanFitInsightFeedbackId,
  type WorkspaceId,
} from "./ids.js";
import type { DailyPlanFitInsight } from "./daily-plan-fit-insight.js";

export const dailyPlanFitInsightFeedbackKinds = ["dismissed", "reset"] as const;
export type DailyPlanFitInsightFeedbackKind = (typeof dailyPlanFitInsightFeedbackKinds)[number];
export const dailyPlanFitInsightKeyPattern = /^[0-9a-f]{64}$/;

export interface DailyPlanFitInsightFeedback {
  readonly id: DailyPlanFitInsightFeedbackId;
  readonly ingestedSequence: number;
  readonly workspaceId: WorkspaceId;
  readonly forDate: LocalDate;
  readonly insightKey: string;
  readonly kind: DailyPlanFitInsightFeedbackKind;
  readonly sampleCount: number;
  readonly typicalPlannedMinutes: number;
  readonly typicalCompletedMinutes: number;
  readonly typicalPlannedTaskCount: number;
  readonly typicalCompletedTaskCount: number;
  readonly suggestedTargetMinutes: number;
  readonly suggestedTargetTaskCount: number;
  readonly idempotencyKey: string;
  readonly recordedAt: Date;
}

export interface CreateDailyPlanFitInsightFeedbackInput extends Omit<
  DailyPlanFitInsightFeedback,
  "id" | "recordedAt" | "idempotencyKey"
> {
  readonly id?: DailyPlanFitInsightFeedbackId;
  readonly idempotencyKey: string;
  readonly recordedAt: Date;
}

function wholeNumber(value: number, minimum: number, code: string, message: string): void {
  invariant(Number.isSafeInteger(value) && value >= minimum, code, message);
}

export function createDailyPlanFitInsightFeedback(
  input: CreateDailyPlanFitInsightFeedbackInput,
): DailyPlanFitInsightFeedback {
  invariant(
    dailyPlanFitInsightFeedbackKinds.some((kind) => kind === input.kind),
    "daily_plan_fit_insight.feedback_kind_invalid",
    "A supported Plan Fit feedback kind is required.",
  );
  wholeNumber(
    input.ingestedSequence,
    0,
    "daily_plan_fit_insight.feedback_sequence_invalid",
    "A non-negative Plan Fit feedback ingestion sequence is required.",
  );
  invariant(
    isValidLocalDate(input.forDate),
    "daily_plan_fit_insight.feedback_date_invalid",
    "A valid Plan Fit feedback date is required.",
  );
  invariant(
    dailyPlanFitInsightKeyPattern.test(input.insightKey),
    "daily_plan_fit_insight.feedback_key_invalid",
    "A lowercase SHA-256 Plan Fit insight key is required.",
  );
  wholeNumber(
    input.sampleCount,
    1,
    "daily_plan_fit_insight.feedback_sample_count_invalid",
    "A positive Plan Fit feedback sample count is required.",
  );
  wholeNumber(
    input.typicalPlannedMinutes,
    1,
    "daily_plan_fit_insight.feedback_planned_minutes_invalid",
    "Typical planned minutes must be positive.",
  );
  wholeNumber(
    input.typicalCompletedMinutes,
    0,
    "daily_plan_fit_insight.feedback_completed_minutes_invalid",
    "Typical completed minutes must be non-negative.",
  );
  wholeNumber(
    input.typicalPlannedTaskCount,
    1,
    "daily_plan_fit_insight.feedback_planned_tasks_invalid",
    "Typical planned task count must be positive.",
  );
  wholeNumber(
    input.typicalCompletedTaskCount,
    0,
    "daily_plan_fit_insight.feedback_completed_tasks_invalid",
    "Typical completed task count must be non-negative.",
  );
  wholeNumber(
    input.suggestedTargetMinutes,
    1,
    "daily_plan_fit_insight.feedback_suggested_minutes_invalid",
    "Suggested target minutes must be positive.",
  );
  wholeNumber(
    input.suggestedTargetTaskCount,
    1,
    "daily_plan_fit_insight.feedback_suggested_tasks_invalid",
    "Suggested target task count must be positive.",
  );
  const idempotencyKey = input.idempotencyKey.trim();
  invariant(
    idempotencyKey.length >= 1 && idempotencyKey.length <= 160,
    "daily_plan_fit_insight.feedback_idempotency_key_invalid",
    "A Plan Fit feedback idempotency key must contain 1–160 characters.",
  );
  invariant(
    input.recordedAt instanceof Date && Number.isFinite(input.recordedAt.getTime()),
    "daily_plan_fit_insight.feedback_recorded_at_invalid",
    "A valid Plan Fit feedback recording timestamp is required.",
  );
  return {
    ...input,
    id: input.id ?? dailyPlanFitInsightFeedbackId(),
    idempotencyKey,
    recordedAt: new Date(input.recordedAt),
  };
}

function isLater(
  candidate: DailyPlanFitInsightFeedback,
  current: DailyPlanFitInsightFeedback | null,
): boolean {
  return (
    current === null ||
    candidate.ingestedSequence > current.ingestedSequence ||
    (candidate.ingestedSequence === current.ingestedSequence && candidate.id > current.id)
  );
}

export function latestDailyPlanFitInsightFeedback(
  feedback: readonly DailyPlanFitInsightFeedback[],
  workspaceId: WorkspaceId,
  insightKey: string,
): DailyPlanFitInsightFeedback | null {
  let latest: DailyPlanFitInsightFeedback | null = null;
  for (const candidate of feedback) {
    if (
      candidate.workspaceId === workspaceId &&
      candidate.insightKey === insightKey &&
      isLater(candidate, latest)
    ) {
      latest = candidate;
    }
  }
  return latest;
}

export function resolveDailyPlanFitInsightFeedback(
  insight: DailyPlanFitInsight,
  workspaceId: WorkspaceId,
  feedback: readonly DailyPlanFitInsightFeedback[],
): DailyPlanFitInsight {
  const copy = (overrides: Partial<DailyPlanFitInsight> = {}): DailyPlanFitInsight => ({
    ...insight,
    evaluatedAt: new Date(insight.evaluatedAt),
    dismissedAt: insight.dismissedAt === null ? null : new Date(insight.dismissedAt),
    ...overrides,
  });
  if (insight.insightKey === null) return copy();
  const latest = latestDailyPlanFitInsightFeedback(feedback, workspaceId, insight.insightKey);
  if (latest === null || latest.kind === "reset") {
    return copy({ disposition: "available", dismissedAt: null });
  }
  return copy({
    disposition: "dismissed",
    dismissedAt: new Date(latest.recordedAt),
  });
}
