import {
  DomainError,
  updateWorkItem,
  type WorkItem,
  type WorkItemId,
  type WorkItemPriority,
  type WorkItemStatus,
  type WorkspaceId,
} from "@schedule/domain";

import type { Clock, UnitOfWork } from "./ports.js";

export interface UpdateWorkItemCommand {
  readonly workspaceId: WorkspaceId;
  readonly workItemId: WorkItemId;
  readonly expectedVersion: number;
  readonly title?: string;
  readonly description?: string | null;
  readonly status?: WorkItemStatus;
  readonly priority?: WorkItemPriority;
}

export class UpdateWorkItem {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(command: UpdateWorkItemCommand): Promise<WorkItem> {
    if (!Number.isInteger(command.expectedVersion) || command.expectedVersion < 1) {
      throw new DomainError(
        "work_item.expected_version_invalid",
        "Expected work item version must be a positive integer.",
      );
    }
    return this.unitOfWork.run(async ({ workItems, workspaces }) => {
      if ((await workspaces.findById(command.workspaceId)) === null) {
        throw new DomainError("workspace.not_found", "The workspace does not exist.");
      }
      const current = await workItems.findById(command.workspaceId, command.workItemId);
      if (current === null) {
        throw new DomainError("work_item.not_found", "The work item does not exist.");
      }
      if (current.version !== command.expectedVersion) {
        throw new DomainError(
          "work_item.version_conflict",
          "The work item changed before this update could be applied.",
        );
      }
      const updated = updateWorkItem(current, {
        ...(command.title === undefined ? {} : { title: command.title }),
        ...(command.description === undefined ? {} : { description: command.description }),
        ...(command.status === undefined ? {} : { status: command.status }),
        ...(command.priority === undefined ? {} : { priority: command.priority }),
        now: this.clock.now(),
      });
      if (updated !== current) await workItems.save(updated, command.expectedVersion);
      return updated;
    });
  }
}
