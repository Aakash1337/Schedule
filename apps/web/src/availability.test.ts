import { describe, expect, it } from "vitest";

import {
  availabilitySnapshotKey,
  countIntersectingScheduleBlocks,
  deriveFreeAvailability,
  totalAvailabilityMinutes,
  type AvailabilityWindow,
} from "./availability";

const outer: AvailabilityWindow = {
  startsAt: "2026-07-13T09:00:00.000Z",
  endsAt: "2026-07-13T17:00:00.000Z",
};

function block(
  id: string,
  startsAt: string,
  endsAt: string,
  version = 1,
): {
  readonly id: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly version: number;
} {
  return { id, startsAt, endsAt, version };
}

describe("calendar-aware availability", () => {
  it("retains the full range when no schedule block intersects it", () => {
    expect(
      deriveFreeAvailability(outer, [
        block("before", "2026-07-13T07:00:00.000Z", "2026-07-13T09:00:00.000Z"),
        block("after", "2026-07-13T17:00:00.000Z", "2026-07-13T18:00:00.000Z"),
      ]),
    ).toEqual([outer]);
  });

  it("clips, sorts, and merges overlapping or adjacent occupied intervals", () => {
    expect(
      deriveFreeAvailability(outer, [
        block("late", "2026-07-13T15:30:00.000Z", "2026-07-13T18:00:00.000Z"),
        block("middle-b", "2026-07-13T11:30:00.000Z", "2026-07-13T13:00:00.000Z"),
        block("middle-a", "2026-07-13T10:00:00.000Z", "2026-07-13T12:00:00.000Z"),
        block("adjacent", "2026-07-13T13:00:00.000Z", "2026-07-13T13:30:00.000Z"),
        block("early", "2026-07-13T08:00:00.000Z", "2026-07-13T09:30:00.000Z"),
      ]),
    ).toEqual([
      {
        startsAt: "2026-07-13T09:30:00.000Z",
        endsAt: "2026-07-13T10:00:00.000Z",
      },
      {
        startsAt: "2026-07-13T13:30:00.000Z",
        endsAt: "2026-07-13T15:30:00.000Z",
      },
    ]);
  });

  it("returns no free range when calendar blocks cover the outer range", () => {
    const windows = deriveFreeAvailability(outer, [
      block("cover", "2026-07-13T08:00:00.000Z", "2026-07-13T18:00:00.000Z"),
    ]);
    expect(windows).toEqual([]);
    expect(totalAvailabilityMinutes(windows)).toBe(0);
  });

  it("measures the combined free duration after a split", () => {
    const windows = deriveFreeAvailability(outer, [
      block("lunch", "2026-07-13T11:00:00.000Z", "2026-07-13T12:00:00.000Z"),
    ]);
    expect(windows).toHaveLength(2);
    expect(totalAvailabilityMinutes(windows)).toBe(420);
    expect(
      countIntersectingScheduleBlocks(outer, [
        block("lunch", "2026-07-13T11:00:00.000Z", "2026-07-13T12:00:00.000Z"),
        block("after", "2026-07-13T18:00:00.000Z", "2026-07-13T19:00:00.000Z"),
      ]),
    ).toBe(1);
  });

  it("uses absolute instants without assuming a fixed local-day duration", () => {
    const longDay = {
      startsAt: "2026-11-01T04:00:00.000Z",
      endsAt: "2026-11-02T05:00:00.000Z",
    };
    expect(totalAvailabilityMinutes(deriveFreeAvailability(longDay, []))).toBe(1_500);
  });

  it("makes snapshots order-independent and sensitive to relevant revisions", () => {
    const first = block("first", "2026-07-13T11:00:00.000Z", "2026-07-13T12:00:00.000Z");
    const second = block("second", "2026-07-13T14:00:00.000Z", "2026-07-13T15:00:00.000Z");
    const outside = block("outside", "2026-07-13T18:00:00.000Z", "2026-07-13T19:00:00.000Z");

    const key = availabilitySnapshotKey(outer, [first, second, outside]);
    expect(availabilitySnapshotKey(outer, [outside, second, first])).toBe(key);
    expect(availabilitySnapshotKey(outer, [first, { ...second, version: 2 }, outside])).not.toBe(
      key,
    );
    expect(
      availabilitySnapshotKey(outer, [
        first,
        { ...second, startsAt: "2026-07-13T13:30:00.000Z" },
        outside,
      ]),
    ).not.toBe(key);
    expect(availabilitySnapshotKey(outer, [first, second, { ...outside, version: 2 }])).toBe(key);
  });

  it.each([
    [{ startsAt: "invalid", endsAt: outer.endsAt }, [], "valid instant"],
    [{ startsAt: outer.endsAt, endsAt: outer.startsAt }, [], "end after"],
    [
      outer,
      [block("invalid", "2026-07-13T11:00:00.000Z", "2026-07-13T10:00:00.000Z")],
      "must end after",
    ],
    [
      outer,
      [block("unversioned", "2026-07-13T11:00:00.000Z", "2026-07-13T12:00:00.000Z", 0)],
      "positive version",
    ],
  ] as const)("fails closed for malformed interval data", (window, blocks, message) => {
    expect(() => deriveFreeAvailability(window, blocks)).toThrow(message);
  });
});
