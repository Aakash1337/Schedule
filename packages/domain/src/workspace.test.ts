import { describe, expect, it } from "vitest";

import { workspaceId } from "./ids.js";
import { createWorkspace, type CreateWorkspaceInput } from "./workspace.js";

describe("workspace domain model", () => {
  it("normalizes names and copies supplied IDs and timestamps", () => {
    const id = workspaceId("workspace-domain-test");
    const now = new Date("2026-07-13T12:34:56.000Z");
    const workspace = createWorkspace({ id, name: "  Personal schedule  ", now });

    expect(workspace).toMatchObject({ id, name: "Personal schedule" });
    expect(workspace.createdAt).toEqual(now);
    expect(workspace.updatedAt).toEqual(now);
    expect(workspace.createdAt).not.toBe(now);
    expect(workspace.updatedAt).not.toBe(now);
  });

  it("generates an ID when one is not supplied", () => {
    const workspace = createWorkspace({ name: "Generated workspace" });
    expect(workspace.id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it.each([
    ["blank", { name: "   " }, "workspace.name_required"],
    ["too long", { name: "x".repeat(161) }, "workspace.name_too_long"],
    ["invalid timestamp", { name: "Valid", now: new Date("invalid") }, "workspace.timestamp_invalid"],
  ] as const)("rejects a %s workspace input", (_label, invalid, code) => {
    expect(() =>
      createWorkspace({
        ...invalid,
      } as CreateWorkspaceInput),
    ).toThrowError(expect.objectContaining({ code }));
  });
});
