import { describe, expect, it } from "vitest";

import type { DomainError } from "./errors.js";
import { isValidLocalDate, localDate } from "./calendar.js";

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
