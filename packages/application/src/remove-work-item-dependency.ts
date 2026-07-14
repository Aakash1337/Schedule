import { DomainError, type WorkItemId, type WorkspaceId } from "@schedule/domain";

import type { Clock, UnitOfWork } from "./ports.js";

export interface RemoveWorkItemDependencyCommand {
  readonly workspaceId: WorkspaceId;
  readonly prerequisiteWorkItemId: WorkItemId;
  readonly dependentWorkItemId: WorkItemId;
}

function assertDistinctItems(command: RemoveWorkItemDependencyCommand): void {
  if (command.prerequisiteWorkItemId.toLowerCase() === command.dependentWorkItemId.toLowerCase()) {
    throw new DomainError(
      "work_item_dependency.self_reference_invalid",
      "A work item cannot depend on itself.",
    );
  }
}

export class RemoveWorkItemDependency {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(command: RemoveWorkItemDependencyCommand): Promise<void> {
    assertDistinctItems(command);
    return this.unitOfWork.run(
      async ({ workspaces, workItems, workItemDependencies, auditEvents }) => {
        await workItemDependencies.lockWorkspace(command.workspaceId);
        if ((await workspaces.findById(command.workspaceId)) === null) {
          throw new DomainError("workspace.not_found", "The workspace does not exist.");
        }

        const [prerequisite, dependent] = await Promise.all([
          workItems.findById(command.workspaceId, command.prerequisiteWorkItemId),
          workItems.findById(command.workspaceId, command.dependentWorkItemId),
        ]);
        if (prerequisite === null || dependent === null) {
          throw new DomainError(
            "work_item.not_found",
            prerequisite === null
              ? "The prerequisite work item does not exist."
              : "The dependent work item does not exist.",
          );
        }

        const existing = await workItemDependencies.find(
          command.workspaceId,
          command.prerequisiteWorkItemId,
          command.dependentWorkItemId,
        );
        if (existing === null) return;
        const deleted = await workItemDependencies.delete(
          command.workspaceId,
          command.prerequisiteWorkItemId,
          command.dependentWorkItemId,
        );
        if (!deleted) return;

        await auditEvents.append({
          workspaceId: command.workspaceId,
          action: "work_item_dependency.removed",
          entityType: "work_item_dependency",
          entityId: command.dependentWorkItemId,
          data: {
            prerequisiteWorkItemId: command.prerequisiteWorkItemId,
            dependentWorkItemId: command.dependentWorkItemId,
            createdAt: existing.createdAt.toISOString(),
          },
          occurredAt: this.clock.now(),
        });
      },
      { isolationLevel: "read_committed" },
    );
  }
}
