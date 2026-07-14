import { invariant } from "./errors.js";
import type { WorkItemId, WorkspaceId } from "./ids.js";
import type { WorkItemStatus } from "./work-item.js";

/** A tenant-scoped directed prerequisite edge between two work items. */
export interface WorkItemDependency {
  readonly workspaceId: WorkspaceId;
  readonly prerequisiteWorkItemId: WorkItemId;
  readonly dependentWorkItemId: WorkItemId;
  readonly createdAt: Date;
}

/** Dependency state projected for one immutable planner input. */
export interface PlanningWorkItemDependency extends WorkItemDependency {
  readonly prerequisiteStatus: WorkItemStatus;
}

export interface CreateWorkItemDependencyInput {
  readonly workspaceId: WorkspaceId;
  readonly prerequisiteWorkItemId: WorkItemId;
  readonly dependentWorkItemId: WorkItemId;
  readonly createdAt: Date;
}

const postgresUuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function samePersistedWorkItemIdentity(left: WorkItemId, right: WorkItemId): boolean {
  if (left === right) return true;
  return (
    postgresUuidPattern.test(left) &&
    postgresUuidPattern.test(right) &&
    left.toLowerCase() === right.toLowerCase()
  );
}

export function createWorkItemDependency(input: CreateWorkItemDependencyInput): WorkItemDependency {
  invariant(
    !samePersistedWorkItemIdentity(input.prerequisiteWorkItemId, input.dependentWorkItemId),
    "work_item_dependency.self_reference_invalid",
    "A work item cannot depend on itself.",
  );
  invariant(
    input.createdAt instanceof Date && Number.isFinite(input.createdAt.getTime()),
    "work_item_dependency.timestamp_invalid",
    "A valid work item dependency timestamp is required.",
  );
  return {
    workspaceId: input.workspaceId,
    prerequisiteWorkItemId: input.prerequisiteWorkItemId,
    dependentWorkItemId: input.dependentWorkItemId,
    createdAt: new Date(input.createdAt),
  };
}
