import { describe, expect, it } from "vitest";

import {
  addDays,
  formatMinutes,
  localDateKey,
  localDateTimeToIso,
  splitTags,
  startOfWeek,
} from "./date";

describe("local date helpers", () => {
  it("keeps calendar operations in local time", () => {
    const sunday = new Date(2026, 6, 12, 15, 30);
    expect(localDateKey(sunday)).toBe("2026-07-12");
    expect(localDateKey(startOfWeek(sunday))).toBe("2026-07-06");
    expect(localDateKey(addDays(sunday, 3))).toBe("2026-07-15");
  });

  it("converts a local form value into a valid instant", () => {
    const instant = new Date(localDateTimeToIso("2026-07-12", "09:45"));
    expect(instant.getFullYear()).toBe(2026);
    expect(instant.getMonth()).toBe(6);
    expect(instant.getDate()).toBe(12);
    expect(instant.getHours()).toBe(9);
    expect(instant.getMinutes()).toBe(45);
  });

  it("rejects local values that the Date constructor would normalize", () => {
    expect(() => localDateTimeToIso("2026-02-30", "09:45")).toThrow(
      "does not exist in the browser time zone",
    );
  });

  it("rejects a repeated local minute during a daylight-saving fallback", () => {
    const priorTimeZone = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      expect(() => localDateTimeToIso("2026-11-01", "01:30")).toThrow(
        "ambiguous in the browser time zone",
      );
    } finally {
      process.env.TZ = priorTimeZone;
    }
  });

  it("formats duration and normalizes comma-separated tags", () => {
    expect(formatMinutes(145)).toBe("2h 25m");
    expect(splitTags("home, computer, home,  errands ")).toEqual(["home", "computer", "errands"]);
  });
});
