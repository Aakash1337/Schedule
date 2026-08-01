import { describe, expect, it } from "vitest";

import {
  createRoutineGroup,
  routineGroupId,
  routineGroupNameKey,
  updateRoutineGroup,
  workspaceId,
} from "./index.js";

describe("routine groups", () => {
  const createdAt = new Date("2026-07-27T12:00:00.000Z");

  it("canonicalizes display names and produces a case-insensitive uniqueness key", () => {
    const group = createRoutineGroup({
      id: routineGroupId("languages"),
      workspaceId: workspaceId("workspace"),
      name: "  Learning   Languages  ",
      description: "  Skills in progress  ",
      now: createdAt,
    });

    expect(group).toMatchObject({
      name: "Learning Languages",
      description: "Skills in progress",
      version: 1,
    });
    expect(routineGroupNameKey("LEARNING languages")).toBe("learning languages");
  });

  it("treats blank descriptions as absent and advances versions only for real changes", () => {
    const group = createRoutineGroup({
      id: routineGroupId("projects"),
      workspaceId: workspaceId("workspace"),
      name: "Projects",
      description: " ",
      now: createdAt,
    });
    const unchanged = updateRoutineGroup(group, {
      name: "Projects",
      now: new Date("2026-07-27T13:00:00.000Z"),
    });
    const changed = updateRoutineGroup(group, {
      description: "Active builds",
      now: new Date("2026-07-27T13:00:00.000Z"),
    });

    expect(group.description).toBeNull();
    expect(unchanged).toBe(group);
    expect(changed).toMatchObject({ description: "Active builds", version: 2 });
  });

  it("rejects empty, oversized, and control-character names", () => {
    const base = {
      id: routineGroupId("invalid"),
      workspaceId: workspaceId("workspace"),
      now: createdAt,
    };
    expect(() => createRoutineGroup({ ...base, name: " " })).toThrowError(
      expect.objectContaining({ code: "routine_group.name_invalid" }),
    );
    expect(() => createRoutineGroup({ ...base, name: "x".repeat(81) })).toThrowError(
      expect.objectContaining({ code: "routine_group.name_invalid" }),
    );
    expect(() => createRoutineGroup({ ...base, name: "Projects\u0000" })).toThrowError(
      expect.objectContaining({ code: "routine_group.name_invalid" }),
    );
  });
});
