import { DomainError, type WorkItemId, type WorkspaceId } from "@schedule/domain";

import type { WorkItemRepository } from "./ports.js";

function canonicalId(id: WorkItemId): string {
  return id.toLowerCase();
}

/** Validates one proposed parent while the caller holds the workspace graph lock. */
export async function assertValidWorkItemParent(
  workItems: WorkItemRepository,
  workspaceId: WorkspaceId,
  workItemId: WorkItemId,
  proposedParentWorkItemId: WorkItemId,
): Promise<void> {
  const targetId = canonicalId(workItemId);
  const visited = new Set<string>();
  let cursor: WorkItemId | null = proposedParentWorkItemId;
  let directParent = true;

  while (cursor !== null) {
    const cursorId = canonicalId(cursor);
    if (cursorId === targetId) {
      throw new DomainError(
        directParent
          ? "work_item_hierarchy.self_reference_invalid"
          : "work_item_hierarchy.cycle_conflict",
        directParent
          ? "A work item cannot be its own parent."
          : "This parent would create a cycle in the work-item hierarchy.",
      );
    }
    if (visited.has(cursorId)) {
      throw new DomainError(
        "work_item_hierarchy.cycle_conflict",
        "This parent would create a cycle in the work-item hierarchy.",
      );
    }
    visited.add(cursorId);
    const item = await workItems.findById(workspaceId, cursor);
    if (item === null) {
      throw new DomainError("work_item.not_found", "The parent work item does not exist.");
    }
    cursor = item.parentWorkItemId;
    directParent = false;
  }
}
