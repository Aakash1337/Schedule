import { describe, expect, it } from "vitest";

import {
  DomainError,
  createScheduleBlock,
  createWorkItem,
  workItemId,
  workspaceId,
} from "./index.js";

describe("work and scheduling boundaries", () => {
  const workspace = workspaceId("workspace-test");

  it("creates an unscheduled work item", () => {
    const item = createWorkItem({ workspaceId: workspace, title: "Draft the launch plan" });
    expect(item.title).toBe("Draft the launch plan");
    expect(item.status).toBe("backlog");
  });

  it("creates a standalone schedule block", () => {
    const block = createScheduleBlock({
      workspaceId: workspace,
      title: "Team check-in",
      startsAt: new Date("2026-07-13T14:00:00Z"),
      endsAt: new Date("2026-07-13T14:30:00Z"),
      timeZone: "America/La_Paz",
    });
    expect(block.workItemId).toBeNull();
  });

  it("allows multiple independent blocks for one work item", () => {
    const itemId = workItemId("work-item-test");
    const first = createScheduleBlock({
      workspaceId: workspace,
      workItemId: itemId,
      startsAt: new Date("2026-07-13T14:00:00Z"),
      endsAt: new Date("2026-07-13T15:00:00Z"),
      timeZone: "America/La_Paz",
    });
    const second = createScheduleBlock({
      workspaceId: workspace,
      workItemId: itemId,
      startsAt: new Date("2026-07-14T14:00:00Z"),
      endsAt: new Date("2026-07-14T15:00:00Z"),
      timeZone: "America/La_Paz",
    });
    expect(first.workItemId).toBe(itemId);
    expect(second.workItemId).toBe(itemId);
    expect(first.id).not.toBe(second.id);
  });

  it("rejects an inverted time range", () => {
    expect(() =>
      createScheduleBlock({
        workspaceId: workspace,
        startsAt: new Date("2026-07-13T15:00:00Z"),
        endsAt: new Date("2026-07-13T14:00:00Z"),
        timeZone: "UTC",
      }),
    ).toThrowError(DomainError);
  });

  it("rejects an invalid time zone", () => {
    expect(() =>
      createScheduleBlock({
        workspaceId: workspace,
        startsAt: new Date("2026-07-13T14:00:00Z"),
        endsAt: new Date("2026-07-13T15:00:00Z"),
        timeZone: "Mars/Olympus_Mons",
      }),
    ).toThrowError(DomainError);
  });
});
