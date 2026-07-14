import {
  DomainError,
  createWorkItemDependency,
  type WorkItemDependency,
  type WorkItemId,
  type WorkspaceId,
} from "@schedule/domain";

import type { Clock, UnitOfWork } from "./ports.js";

export interface AddWorkItemDependencyCommand {
  readonly workspaceId: WorkspaceId;
  readonly prerequisiteWorkItemId: WorkItemId;
  readonly dependentWorkItemId: WorkItemId;
}

export interface AddWorkItemDependencyResult {
  readonly dependency: WorkItemDependency;
  readonly created: boolean;
}

function assertDistinctItems(command: AddWorkItemDependencyCommand): void {
  if (command.prerequisiteWorkItemId.toLowerCase() === command.dependentWorkItemId.toLowerCase()) {
    throw new DomainError(
      "work_item_dependency.self_reference_invalid",
      "A work item cannot depend on itself.",
    );
  }
}

export class AddWorkItemDependency {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(command: AddWorkItemDependencyCommand): Promise<AddWorkItemDependencyResult> {
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
        if (existing !== null) return { dependency: existing, created: false };

        if (
          await workItemDependencies.wouldCreateCycle(
            command.workspaceId,
            command.prerequisiteWorkItemId,
            command.dependentWorkItemId,
          )
        ) {
          throw new DomainError(
            "work_item_dependency.cycle_conflict",
            "This dependency would create a cycle in the work-item graph.",
          );
        }

        const dependency = createWorkItemDependency({
          workspaceId: command.workspaceId,
          prerequisiteWorkItemId: command.prerequisiteWorkItemId,
          dependentWorkItemId: command.dependentWorkItemId,
          createdAt: this.clock.now(),
        });
        await workItemDependencies.insert(dependency);
        await auditEvents.append({
          workspaceId: command.workspaceId,
          action: "work_item_dependency.added",
          entityType: "work_item_dependency",
          entityId: command.dependentWorkItemId,
          data: {
            prerequisiteWorkItemId: command.prerequisiteWorkItemId,
            dependentWorkItemId: command.dependentWorkItemId,
            createdAt: dependency.createdAt.toISOString(),
          },
          occurredAt: dependency.createdAt,
        });
        return { dependency, created: true };
      },
      { isolationLevel: "read_committed" },
    );
  }
}
