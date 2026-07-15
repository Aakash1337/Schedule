import { describe, expect, it } from "vitest";

import type { WorkItem } from "../types";
import {
  ACTIVE_WORK_STATUSES,
  filterWorkItems,
  statusesForWorkFilter,
  type WorkDiscoveryFilters,
} from "./work-filters";

const baseItem: WorkItem = {
  id: "item-1",
  workspaceId: "workspace-1",
  parentWorkItemId: null,
  title: "Prepare quarterly report",
  description: "Collect finance notes",
  status: "backlog",
  priority: "none",
  dueOn: null,
  planningDurationMinutes: null,
  version: 1,
  createdAt: "2026-07-15T12:00:00.000Z",
  updatedAt: "2026-07-15T12:00:00.000Z",
};

const defaults: WorkDiscoveryFilters = {
  query: "",
  status: "active",
  dueDate: "all",
  today: "2026-07-15",
};

function visible(item: WorkItem, filters: Partial<WorkDiscoveryFilters>): boolean {
  return filterWorkItems([item], { ...defaults, ...filters }).length === 1;
}

describe("work discovery filters", () => {
  it("matches every normalized search term across title and description", () => {
    expect(visible(baseItem, { query: "  QUARTERLY   finance " })).toBe(true);
    expect(visible(baseItem, { query: "quarterly missing" })).toBe(false);
    expect(
      visible({ ...baseItem, title: "Ｆｉｌｅ report", description: null }, { query: "file" }),
    ).toBe(true);
  });

  it("defaults to active work while keeping every terminal status explicitly reachable", () => {
    for (const status of ACTIVE_WORK_STATUSES) {
      expect(visible({ ...baseItem, status }, {})).toBe(true);
    }
    expect(visible({ ...baseItem, status: "done" }, {})).toBe(false);
    expect(visible({ ...baseItem, status: "cancelled" }, {})).toBe(false);
    expect(visible({ ...baseItem, status: "done" }, { status: "done" })).toBe(true);
    expect(visible({ ...baseItem, status: "cancelled" }, { status: "all" })).toBe(true);
    expect(statusesForWorkFilter("active")).toEqual(ACTIVE_WORK_STATUSES);
    expect(statusesForWorkFilter("all")).toEqual([...ACTIVE_WORK_STATUSES, "done", "cancelled"]);
  });

  it.each([
    [null, "none", true],
    [null, "overdue", false],
    ["2026-07-14", "overdue", true],
    ["2026-07-15", "today", true],
    ["2026-07-16", "next_seven_days", true],
    ["2026-07-22", "next_seven_days", true],
    ["2026-07-23", "next_seven_days", false],
    ["2026-07-23", "later", true],
  ] as const)("classifies due date %s in %s", (dueOn, dueDate, expected) => {
    expect(visible({ ...baseItem, dueOn }, { dueDate })).toBe(expected);
  });

  it("combines query, status, and due-date dimensions with AND semantics", () => {
    const items = [
      { ...baseItem, id: "matching", dueOn: "2026-07-15" },
      { ...baseItem, id: "wrong-query", title: "Call dentist", dueOn: "2026-07-15" },
      { ...baseItem, id: "wrong-status", status: "done" as const, dueOn: "2026-07-15" },
      { ...baseItem, id: "wrong-date", dueOn: null },
    ];

    expect(
      filterWorkItems(items, {
        query: "quarterly finance",
        status: "active",
        dueDate: "today",
        today: "2026-07-15",
      }).map((item) => item.id),
    ).toEqual(["matching"]);
  });
});
