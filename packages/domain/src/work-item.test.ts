import { describe, expect, it } from "vitest";

import { DomainError } from "./errors.js";
import { workItemId, workspaceId } from "./ids.js";
import {
  changeWorkItemStatus,
  createWorkItem,
  maximumWorkItemVersion,
  updateWorkItem,
  workItemPriorities,
  workItemStatuses,
  type CreateWorkItemInput,
  type UpdateWorkItemInput,
  type WorkItem,
} from "./work-item.js";

describe("work item domain model", () => {
  const workspace = workspaceId("workspace-work-item-tests");
  const createdAt = new Date("2026-07-01T10:00:00.000Z");

  function create(overrides: Partial<CreateWorkItemInput> = {}): WorkItem {
    return createWorkItem({
      id: workItemId("work-item-test"),
      workspaceId: workspace,
      title: "Ship scheduling MVP",
      now: createdAt,
      ...overrides,
    });
  }

  it("creates a normalized work item with safe defaults", () => {
    const now = new Date("2026-07-01T10:00:00.000Z");
    const item = create({
      title: "  Ship scheduling MVP  ",
      description: "   ",
      now,
    });

    expect(item).toMatchObject({
      title: "Ship scheduling MVP",
      description: null,
      status: "backlog",
      priority: "none",
      version: 1,
    });
    expect(item.createdAt).toEqual(now);
    expect(item.updatedAt).toEqual(now);
    expect(item.createdAt).not.toBe(now);
    expect(item.updatedAt).not.toBe(now);
  });

  it("accepts every declared status and priority", () => {
    for (const status of workItemStatuses) {
      for (const priority of workItemPriorities) {
        expect(create({ status, priority })).toMatchObject({ status, priority });
      }
    }
  });

  it.each([
    ["status", { status: "waiting" }],
    ["priority", { priority: "critical" }],
  ] as const)("rejects an invalid runtime %s when creating", (_label, invalidValues) => {
    expect(() =>
      createWorkItem({
        workspaceId: workspace,
        title: "Invalid item",
        now: createdAt,
        ...invalidValues,
      } as CreateWorkItemInput),
    ).toThrowError(
      expect.objectContaining({
        code: "status" in invalidValues ? "work_item.status_invalid" : "work_item.priority_invalid",
      }),
    );
  });

  it("normalizes all editable text and increments the version exactly once", () => {
    const original = create({
      description: "Initial scope",
      status: "planned",
      priority: "medium",
    });
    const now = new Date("2026-07-02T11:30:00.000Z");
    const updated = updateWorkItem(original, {
      title: "  Finish scheduling MVP  ",
      description: "  Include Today and Kanban  ",
      status: "in_progress",
      priority: "urgent",
      now,
    });

    expect(updated).toMatchObject({
      id: original.id,
      workspaceId: original.workspaceId,
      title: "Finish scheduling MVP",
      description: "Include Today and Kanban",
      status: "in_progress",
      priority: "urgent",
      version: 2,
      createdAt: original.createdAt,
    });
    expect(updated.updatedAt).toEqual(now);
    expect(updated.updatedAt).not.toBe(now);
    expect(original.version).toBe(1);
    expect(original.title).toBe("Ship scheduling MVP");
  });

  it("supports isolated partial edits without changing omitted values", () => {
    const original = create({
      description: "Keep this description",
      status: "blocked",
      priority: "high",
    });
    const updated = updateWorkItem(original, {
      description: "   ",
      now: new Date("2026-07-03T00:00:00.000Z"),
    });

    expect(updated).toMatchObject({
      title: original.title,
      description: null,
      status: "blocked",
      priority: "high",
      version: 2,
    });
  });

  it("returns the original object for a semantic no-op", () => {
    const original = create({
      title: "Normalized title",
      description: "Normalized description",
      status: "planned",
      priority: "low",
    });
    const noOp = updateWorkItem(original, {
      title: "  Normalized title  ",
      description: " Normalized description ",
      status: "planned",
      priority: "low",
      now: new Date("2026-07-10T00:00:00.000Z"),
    });

    expect(noOp).toBe(original);
    expect(noOp.updatedAt).toEqual(createdAt);
  });

  it("validates the required update timestamp even for a no-op", () => {
    const original = create();

    expect(() =>
      updateWorkItem(original, {
        title: original.title,
        now: new Date("not-a-date"),
      }),
    ).toThrowError(expect.objectContaining({ code: "work_item.timestamp_invalid" }));
  });

  it.each([
    ["status", { status: "waiting" }],
    ["priority", { priority: "critical" }],
  ] as const)("rejects an invalid runtime %s when updating", (_label, invalidValues) => {
    const original = create();

    expect(() =>
      updateWorkItem({ ...original }, {
        now: new Date("2026-07-02T00:00:00.000Z"),
        ...invalidValues,
      } as UpdateWorkItemInput),
    ).toThrowError(
      expect.objectContaining({
        code: "status" in invalidValues ? "work_item.status_invalid" : "work_item.priority_invalid",
      }),
    );
  });

  it("rejects blank, oversized, and non-text titles", () => {
    const original = create();
    const now = new Date("2026-07-02T00:00:00.000Z");

    expect(() => updateWorkItem(original, { title: "   ", now })).toThrowError(
      expect.objectContaining({ code: "work_item.title_required" }),
    );
    expect(() => updateWorkItem(original, { title: "x".repeat(241), now })).toThrowError(
      expect.objectContaining({ code: "work_item.title_too_long" }),
    );
    expect(() =>
      updateWorkItem(original, { title: 42, now } as unknown as UpdateWorkItemInput),
    ).toThrowError(expect.objectContaining({ code: "work_item.title_invalid" }));
  });

  it("delegates status changes through the same update semantics", () => {
    const original = create({ status: "backlog" });
    const now = new Date("2026-07-04T00:00:00.000Z");
    const updated = changeWorkItemStatus(original, "done", now);
    const noOp = changeWorkItemStatus(updated, "done", new Date("2026-07-05T00:00:00.000Z"));

    expect(updated).toMatchObject({ status: "done", version: 2 });
    expect(updated.updatedAt).toEqual(now);
    expect(noOp).toBe(updated);
  });

  it("allows no-ops at the maximum database version but rejects real changes", () => {
    const original = { ...create(), version: maximumWorkItemVersion };
    const now = new Date("2026-07-02T00:00:00.000Z");

    expect(updateWorkItem(original, { title: ` ${original.title} `, now })).toBe(original);
    expect(() => updateWorkItem(original, { status: "done", now })).toThrowError(
      expect.objectContaining({ code: "work_item.version_exhausted" }),
    );
  });

  it("rejects work item state outside the supported database version range", () => {
    const invalid = { ...create(), version: maximumWorkItemVersion + 1 };

    expect(() =>
      updateWorkItem(invalid, { now: new Date("2026-07-02T00:00:00.000Z") }),
    ).toThrowError(expect.objectContaining({ code: "work_item.version_invalid" }));
  });

  it("exposes domain errors for invalid creation timestamps and descriptions", () => {
    expect(() => create({ now: new Date("invalid") })).toThrowError(DomainError);
    expect(() =>
      createWorkItem({
        workspaceId: workspace,
        title: "Invalid description",
        description: 123,
        now: createdAt,
      } as unknown as CreateWorkItemInput),
    ).toThrowError(expect.objectContaining({ code: "work_item.description_invalid" }));
  });
});
