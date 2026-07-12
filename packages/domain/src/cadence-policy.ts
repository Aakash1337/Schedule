import { invariant } from "./errors.js";
import { localDate, type LocalDate, type Weekday } from "./calendar.js";

export const cadencePeriods = ["day", "week", "month", "rolling_days"] as const;
export type CadencePeriod = (typeof cadencePeriods)[number];

export interface CadencePolicy {
  readonly period: CadencePeriod;
  readonly rollingIntervalDays: number | null;
  readonly targetCompletions: number;
  readonly minimumCompletions: number | null;
  readonly maximumCompletions: number | null;
  readonly minimumSpacingDays: number;
  readonly preferredWeekdays: readonly Weekday[];
  readonly excludedWeekdays: readonly Weekday[];
  readonly discourageConsecutiveDays: boolean;
  readonly prohibitConsecutiveDays: boolean;
  readonly weekStartsOn: Weekday;
  readonly startsOn: LocalDate | null;
  readonly pausedUntil: LocalDate | null;
  readonly endsOn: LocalDate | null;
}

export interface CreateCadencePolicyInput {
  readonly period: CadencePeriod;
  readonly rollingIntervalDays?: number | null;
  readonly targetCompletions?: number;
  readonly minimumCompletions?: number | null;
  readonly maximumCompletions?: number | null;
  readonly minimumSpacingDays?: number;
  readonly preferredWeekdays?: readonly Weekday[];
  readonly excludedWeekdays?: readonly Weekday[];
  readonly discourageConsecutiveDays?: boolean;
  readonly prohibitConsecutiveDays?: boolean;
  readonly weekStartsOn?: Weekday;
  readonly startsOn?: string | null;
  readonly pausedUntil?: string | null;
  readonly endsOn?: string | null;
}

function validateCount(value: number, code: string, label: string): void {
  invariant(
    Number.isInteger(value) && value > 0 && value <= 10_000,
    code,
    `${label} must be a positive integer no greater than 10,000.`,
  );
}

function normalizeWeekdays(values: readonly Weekday[] | undefined): readonly Weekday[] {
  const normalized = [...new Set(values ?? [])].sort((left, right) => left - right);
  invariant(
    normalized.every((value) => Number.isInteger(value) && value >= 0 && value <= 6),
    "cadence.weekday_invalid",
    "Weekdays must be integers from 0 (Sunday) through 6 (Saturday).",
  );
  return normalized;
}

export function createCadencePolicy(input: CreateCadencePolicyInput): CadencePolicy {
  invariant(
    cadencePeriods.some((period) => period === input.period),
    "cadence.period_invalid",
    "A supported cadence period is required.",
  );
  const targetCompletions = input.targetCompletions ?? 1;
  const minimumCompletions = input.minimumCompletions ?? null;
  const maximumCompletions = input.maximumCompletions ?? null;
  const minimumSpacingDays = input.minimumSpacingDays ?? 0;
  const prohibitConsecutiveDays = input.prohibitConsecutiveDays ?? false;
  const discourageConsecutiveDays = input.discourageConsecutiveDays ?? prohibitConsecutiveDays;
  const weekStartsOn = input.weekStartsOn ?? 1;

  validateCount(targetCompletions, "cadence.target_invalid", "Cadence target");
  if (minimumCompletions !== null) {
    validateCount(minimumCompletions, "cadence.minimum_invalid", "Cadence minimum");
    invariant(
      minimumCompletions <= targetCompletions,
      "cadence.minimum_exceeds_target",
      "Cadence minimum cannot exceed its target.",
    );
  }
  if (maximumCompletions !== null) {
    validateCount(maximumCompletions, "cadence.maximum_invalid", "Cadence maximum");
    invariant(
      targetCompletions <= maximumCompletions,
      "cadence.target_exceeds_maximum",
      "Cadence target cannot exceed its maximum.",
    );
  }
  invariant(
    Number.isInteger(minimumSpacingDays) && minimumSpacingDays >= 0,
    "cadence.spacing_invalid",
    "Minimum spacing must be a non-negative whole number of days.",
  );
  invariant(
    Number.isInteger(weekStartsOn) && weekStartsOn >= 0 && weekStartsOn <= 6,
    "cadence.week_start_invalid",
    "Week start must be a weekday from 0 through 6.",
  );
  invariant(
    !prohibitConsecutiveDays || discourageConsecutiveDays,
    "cadence.consecutive_policy_conflict",
    "Prohibiting consecutive days also requires them to be discouraged.",
  );

  const rollingIntervalDays = input.rollingIntervalDays ?? null;
  if (input.period === "rolling_days") {
    invariant(
      rollingIntervalDays !== null &&
        Number.isInteger(rollingIntervalDays) &&
        rollingIntervalDays > 0,
      "cadence.rolling_interval_required",
      "A rolling cadence requires a positive interval in days.",
    );
  } else {
    invariant(
      rollingIntervalDays === null,
      "cadence.rolling_interval_not_applicable",
      "Only a rolling cadence may define a rolling interval.",
    );
  }

  const preferredWeekdays = normalizeWeekdays(input.preferredWeekdays);
  const excludedWeekdays = normalizeWeekdays(input.excludedWeekdays);
  invariant(
    !preferredWeekdays.some((day) => excludedWeekdays.includes(day)),
    "cadence.weekday_overlap",
    "A weekday cannot be both preferred and excluded.",
  );

  const startsOn =
    input.startsOn === undefined || input.startsOn === null ? null : localDate(input.startsOn);
  const pausedUntil =
    input.pausedUntil === undefined || input.pausedUntil === null
      ? null
      : localDate(input.pausedUntil);
  const endsOn =
    input.endsOn === undefined || input.endsOn === null ? null : localDate(input.endsOn);
  invariant(
    startsOn === null || endsOn === null || startsOn <= endsOn,
    "cadence.date_range_invalid",
    "Cadence end date cannot be before its start date.",
  );

  return {
    period: input.period,
    rollingIntervalDays,
    targetCompletions,
    minimumCompletions,
    maximumCompletions,
    minimumSpacingDays,
    preferredWeekdays,
    excludedWeekdays,
    discourageConsecutiveDays,
    prohibitConsecutiveDays,
    weekStartsOn,
    startsOn,
    pausedUntil,
    endsOn,
  };
}
