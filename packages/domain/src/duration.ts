import { invariant } from "./errors.js";

export interface DurationRange {
  readonly minimumMinutes: number;
  readonly expectedMinutes: number;
  readonly maximumMinutes: number;
  readonly splittable: boolean;
  readonly minimumSessionMinutes: number | null;
  readonly overheadMinutes: number;
}

export interface CreateDurationRangeInput {
  readonly expectedMinutes: number;
  readonly minimumMinutes?: number;
  readonly maximumMinutes?: number;
  readonly splittable?: boolean;
  readonly minimumSessionMinutes?: number | null;
  readonly overheadMinutes?: number;
}

function positiveInteger(value: number, code: string, message: string): void {
  invariant(Number.isInteger(value) && value > 0, code, message);
}

export function createDurationRange(input: CreateDurationRangeInput): DurationRange {
  const minimumMinutes = input.minimumMinutes ?? input.expectedMinutes;
  const maximumMinutes = input.maximumMinutes ?? input.expectedMinutes;
  const splittable = input.splittable ?? false;
  const overheadMinutes = input.overheadMinutes ?? 0;

  positiveInteger(
    minimumMinutes,
    "duration.minimum_invalid",
    "Minimum duration must be a positive whole number of minutes.",
  );
  positiveInteger(
    input.expectedMinutes,
    "duration.expected_invalid",
    "Expected duration must be a positive whole number of minutes.",
  );
  positiveInteger(
    maximumMinutes,
    "duration.maximum_invalid",
    "Maximum duration must be a positive whole number of minutes.",
  );
  invariant(
    minimumMinutes <= input.expectedMinutes && input.expectedMinutes <= maximumMinutes,
    "duration.range_invalid",
    "Duration must satisfy minimum <= expected <= maximum.",
  );
  invariant(
    Number.isInteger(overheadMinutes) && overheadMinutes >= 0,
    "duration.overhead_invalid",
    "Duration overhead must be a non-negative whole number of minutes.",
  );

  let minimumSessionMinutes: number | null = null;
  if (splittable) {
    minimumSessionMinutes = input.minimumSessionMinutes ?? minimumMinutes;
    positiveInteger(
      minimumSessionMinutes,
      "duration.minimum_session_invalid",
      "A splittable task requires a positive minimum session duration.",
    );
    invariant(
      minimumSessionMinutes <= minimumMinutes,
      "duration.minimum_session_too_long",
      "Minimum session duration cannot exceed minimum task duration.",
    );
  } else {
    invariant(
      input.minimumSessionMinutes === undefined || input.minimumSessionMinutes === null,
      "duration.minimum_session_not_applicable",
      "A non-splittable task cannot define a minimum session duration.",
    );
  }

  return {
    minimumMinutes,
    expectedMinutes: input.expectedMinutes,
    maximumMinutes,
    splittable,
    minimumSessionMinutes,
    overheadMinutes,
  };
}
