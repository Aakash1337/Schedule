import { invariant } from "./errors.js";

declare const localDateBrand: unique symbol;

export type LocalDate = string & { readonly [localDateBrand]: "LocalDate" };
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

const LOCAL_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MILLISECONDS = 86_400_000;

export function localDate(value: string): LocalDate {
  invariant(
    LOCAL_DATE_PATTERN.test(value),
    "calendar.local_date_invalid",
    "A local date must use YYYY-MM-DD format.",
  );
  const parsed = new Date(`${value}T00:00:00.000Z`);
  invariant(
    Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value,
    "calendar.local_date_invalid",
    "A valid local calendar date is required.",
  );
  return value as LocalDate;
}

export function isIanaTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

export function instantToLocalDate(instant: Date, timeZone: string): LocalDate {
  invariant(
    Number.isFinite(instant.getTime()),
    "calendar.instant_invalid",
    "A valid instant is required.",
  );
  invariant(
    isIanaTimeZone(timeZone),
    "calendar.time_zone_invalid",
    "A valid IANA time zone is required.",
  );

  const parts = new Intl.DateTimeFormat("en-US", {
    calendar: "gregory",
    day: "2-digit",
    month: "2-digit",
    numberingSystem: "latn",
    timeZone,
    year: "numeric",
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";

  return localDate(`${part("year")}-${part("month")}-${part("day")}`);
}

export function localDateEpochDay(value: LocalDate): number {
  return Math.floor(new Date(`${value}T00:00:00.000Z`).getTime() / DAY_MILLISECONDS);
}

export function daysBetweenLocalDates(earlier: LocalDate, later: LocalDate): number {
  return localDateEpochDay(later) - localDateEpochDay(earlier);
}

export function addLocalDays(value: LocalDate, days: number): LocalDate {
  invariant(
    Number.isInteger(days),
    "calendar.day_offset_invalid",
    "A whole-day offset is required.",
  );
  return localDate(
    new Date((localDateEpochDay(value) + days) * DAY_MILLISECONDS).toISOString().slice(0, 10),
  );
}

export function weekdayOf(value: LocalDate): Weekday {
  return new Date(`${value}T00:00:00.000Z`).getUTCDay() as Weekday;
}
