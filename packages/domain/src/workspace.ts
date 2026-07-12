import { invariant } from "./errors.js";
import { workspaceId, type WorkspaceId } from "./ids.js";

export interface Workspace {
  readonly id: WorkspaceId;
  readonly name: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateWorkspaceInput {
  readonly id?: WorkspaceId;
  readonly name: string;
  readonly now?: Date;
}

export function createWorkspace(input: CreateWorkspaceInput): Workspace {
  const name = input.name.trim();
  invariant(name.length > 0, "workspace.name_required", "A workspace name is required.");
  invariant(
    name.length <= 160,
    "workspace.name_too_long",
    "A workspace name cannot exceed 160 characters.",
  );
  const now = input.now ?? new Date();
  invariant(
    Number.isFinite(now.getTime()),
    "workspace.timestamp_invalid",
    "A valid workspace timestamp is required.",
  );
  return {
    id: input.id ?? workspaceId(),
    name,
    createdAt: new Date(now),
    updatedAt: new Date(now),
  };
}
