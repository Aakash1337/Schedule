import { describe, expect, it } from "vitest";

import { DomainError } from "./errors.js";
import { workItemId, workspaceId } from "./ids.js";
import {
  createScheduleBlock,
  maximumScheduleBlockVersion,
  updateScheduleBlock,
  type ScheduleBlock,
} from "./schedule-block.js";

describe("schedule block updates", () => {
  const originalNow = new Date("2026-07-12T12:00:00.000Z");
  const updateNow = new Date("2026-07-13T12:00:00.000Z");

  function createBlock(overrides: Partial<ScheduleBlock> = {}): ScheduleBlock {
    return {
      ...createScheduleBlock({
        workspaceId: workspaceId("workspace-schedule-block-update"),
        workItemId: workItemId("work-item-original"),
        title: "Original block",
        startsAt: new Date("2026-07-14T14:00:00.000Z"),
        endsAt: new Date("2026-07-14T15:00:00.000Z"),
        timeZone: "America/La_Paz",
        now: originalNow,
      }),
      ...overrides,
    };
  }

  it("applies all editable fields as one versioned update", () => {
    const original = createBlock();
    const nextWorkItemId = workItemId("work-item-next");
    const updated = updateScheduleBlock(original, {
      workItemId: nextWorkItemId,
      title: "  Revised block  ",
      startsAt: new Date("2026-07-14T16:00:00.000Z"),
      endsAt: new Date("2026-07-14T17:30:00.000Z"),
      timeZone: "America/New_York",
      now: updateNow,
    });

    expect(updated).toMatchObject({
      workItemId: nextWorkItemId,
      title: "Revised block",
      timeZone: "America/New_York",
      version: 2,
    });
    expect(updated.startsAt.toISOString()).toBe("2026-07-14T16:00:00.000Z");
    expect(updated.endsAt.toISOString()).toBe("2026-07-14T17:30:00.000Z");
    expect(updated.updatedAt).toEqual(updateNow);
    expect(updated.updatedAt).not.toBe(updateNow);
    expect(updated.createdAt).toBe(original.createdAt);
  });

  it("supports clearing an associated work item and a nullable title", () => {
    const updated = updateScheduleBlock(createBlock(), {
      workItemId: null,
      title: "   ",
      now: updateNow,
    });

    expect(updated.workItemId).toBeNull();
    expect(updated.title).toBeNull();
    expect(updated.version).toBe(2);
  });

  it("leaves omitted fields unchanged", () => {
    const original = createBlock();
    const updated = updateScheduleBlock(original, {
      endsAt: new Date("2026-07-14T15:30:00.000Z"),
      now: updateNow,
    });

    expect(updated.workItemId).toBe(original.workItemId);
    expect(updated.title).toBe(original.title);
    expect(updated.startsAt).toEqual(original.startsAt);
    expect(updated.timeZone).toBe(original.timeZone);
    expect(updated.endsAt.toISOString()).toBe("2026-07-14T15:30:00.000Z");
  });

  it("returns the original object for a semantic no-op", () => {
    const original = createBlock();
    const noOp = updateScheduleBlock(original, {
      workItemId: original.workItemId,
      title: `  ${original.title ?? ""}  `,
      startsAt: new Date(original.startsAt),
      endsAt: new Date(original.endsAt),
      timeZone: original.timeZone,
      now: updateNow,
    });

    expect(noOp).toBe(original);
  });

  it("changes the time zone without shifting either instant", () => {
    const original = createBlock();
    const updated = updateScheduleBlock(original, {
      timeZone: "Pacific/Kiritimati",
      now: updateNow,
    });

    expect(updated.timeZone).toBe("Pacific/Kiritimati");
    expect(updated.startsAt.getTime()).toBe(original.startsAt.getTime());
    expect(updated.endsAt.getTime()).toBe(original.endsAt.getTime());
    expect(updated.startsAt).not.toBe(original.startsAt);
    expect(updated.endsAt).not.toBe(original.endsAt);
  });

  it.each([
    ["start", { startsAt: new Date("invalid") }, "schedule.start_invalid"],
    ["end", { endsAt: new Date("invalid") }, "schedule.end_invalid"],
    [
      "inverted range",
      { startsAt: new Date("2026-07-14T16:00:00.000Z") },
      "schedule.range_invalid",
    ],
    ["time zone", { timeZone: "Mars/Olympus_Mons" }, "schedule.time_zone_invalid"],
  ] as const)("rejects an invalid merged %s", (_label, change, code) => {
    expect(() =>
      updateScheduleBlock(createBlock(), {
        ...change,
        now: updateNow,
      }),
    ).toThrowError(expect.objectContaining({ code }));
  });

  it("rejects an invalid required update timestamp, including for a no-op", () => {
    expect(() =>
      updateScheduleBlock(createBlock(), {
        now: new Date("invalid"),
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "schedule.timestamp_invalid",
      }),
    );
  });

  it("rejects a real update after the PostgreSQL integer version is exhausted", () => {
    const exhausted = createBlock({ version: maximumScheduleBlockVersion });

    expect(() =>
      updateScheduleBlock(exhausted, {
        title: "A real change",
        now: updateNow,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "schedule.version_exhausted",
      }),
    );
  });

  it("allows a no-op after the PostgreSQL integer version is exhausted", () => {
    const exhausted = createBlock({ version: maximumScheduleBlockVersion });

    expect(
      updateScheduleBlock(exhausted, {
        title: " Original block ",
        now: updateNow,
      }),
    ).toBe(exhausted);
  });

  it("reports domain errors for invalid updates", () => {
    expect(() =>
      updateScheduleBlock(createBlock(), {
        endsAt: new Date("2026-07-14T14:00:00.000Z"),
        now: updateNow,
      }),
    ).toThrowError(DomainError);
  });
});
