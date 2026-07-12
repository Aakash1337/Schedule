import { describe, expect, it } from "vitest";

import type { DomainError } from "./errors.js";
import {
  addLocalDays,
  daysBetweenLocalDates,
  instantToLocalDate,
  isIanaTimeZone,
  isValidLocalDate,
  localDate,
  localDateEpochDay,
  weekdayOf,
} from "./calendar.js";

describe("localDate", () => {
  it.each(["2024-02-29", "2000-02-29", "2026-07-15", "9999-12-31"])(
    "accepts the real Gregorian date %s",
    (value) => {
      expect(isValidLocalDate(value)).toBe(true);
      expect(localDate(value)).toBe(value);
    },
  );

  it.each([
    "0000-01-01",
    "1900-02-29",
    "2023-02-29",
    "2026-02-30",
    "2026-04-31",
    "2026-13-01",
    "2026-00-01",
    "2026-01-00",
    "2026-7-15",
    "not-a-date",
  ])("rejects the impossible or malformed date %s", (value) => {
    expect(isValidLocalDate(value)).toBe(false);
    expect(() => localDate(value)).toThrowError(
      expect.objectContaining<Partial<DomainError>>({ code: "calendar.local_date_invalid" }),
    );
  });
});

describe("instantToLocalDate", () => {
  it("uses the requested IANA zone when it crosses the UTC date boundary", () => {
    const instant = new Date("2024-01-01T00:30:00.000Z");

    expect(instantToLocalDate(instant, "UTC")).toBe("2024-01-01");
    expect(instantToLocalDate(instant, "America/New_York")).toBe("2023-12-31");
    expect(instantToLocalDate(instant, "Pacific/Kiritimati")).toBe("2024-01-01");
  });

  it("honors the named zone on the calendar day containing a daylight-saving transition", () => {
    const beforeLocalMidnight = new Date("2024-03-10T04:30:00.000Z");
    expect(instantToLocalDate(beforeLocalMidnight, "UTC")).toBe("2024-03-10");
    expect(instantToLocalDate(beforeLocalMidnight, "America/New_York")).toBe("2024-03-09");
    expect(instantToLocalDate(new Date("2024-03-10T07:30:00.000Z"), "America/New_York")).toBe(
      "2024-03-10",
    );
  });

  it("rejects an invalid instant and IANA time zone with their exact error codes", () => {
    expect(isIanaTimeZone("Mars/Olympus_Mons")).toBe(false);
    expect(() => instantToLocalDate(new Date("invalid"), "UTC")).toThrowError(
      expect.objectContaining<Partial<DomainError>>({ code: "calendar.instant_invalid" }),
    );
    expect(() =>
      instantToLocalDate(new Date("2024-01-01T00:00:00.000Z"), "Mars/Olympus_Mons"),
    ).toThrowError(
      expect.objectContaining<Partial<DomainError>>({ code: "calendar.time_zone_invalid" }),
    );
  });
});

describe("local date arithmetic", () => {
  it("adds and subtracts whole days across leap, month, and year boundaries", () => {
    expect(addLocalDays(localDate("2024-02-28"), 1)).toBe("2024-02-29");
    expect(addLocalDays(localDate("2024-02-29"), 1)).toBe("2024-03-01");
    expect(addLocalDays(localDate("2023-02-28"), 1)).toBe("2023-03-01");
    expect(addLocalDays(localDate("2024-01-01"), -1)).toBe("2023-12-31");
  });

  it("maps dates to stable epoch days and preserves exact date distances", () => {
    const epoch = localDate("1970-01-01");
    const later = localDate("2024-02-29");

    expect(localDateEpochDay(epoch)).toBe(0);
    expect(addLocalDays(epoch, localDateEpochDay(later))).toBe(later);
    expect(daysBetweenLocalDates(epoch, later)).toBe(localDateEpochDay(later));
    expect(daysBetweenLocalDates(later, epoch)).toBe(-localDateEpochDay(later));
  });

  it("calculates Gregorian weekdays with Sunday as zero", () => {
    expect(weekdayOf(localDate("1970-01-01"))).toBe(4);
    expect(weekdayOf(localDate("2024-02-29"))).toBe(4);
    expect(weekdayOf(localDate("2024-03-03"))).toBe(0);
  });
});
