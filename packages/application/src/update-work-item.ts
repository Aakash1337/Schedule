import {
  DomainError,
  sameWorkItemIdentity,
  updateWorkItem,
  type WorkItem,
  type LocalDate,
  type WorkItemId,
  type WorkItemPriority,
  type WorkItemStatus,
  type WorkspaceId,
} from "@schedule/domain";

import type { Clock, UnitOfWork } from "./ports.js";
import { assertValidWorkItemParent } from "./work-item-hierarchy.js";

export interface UpdateWorkItemCommand {
  readonly workspaceId: WorkspaceId;
  readonly workItemId: WorkItemId;
  readonly expectedVersion: number;
  readonly expectedStatus?: WorkItemStatus;
  readonly parentWorkItemId?: WorkItemId | null;
  readonly title?: string;
  readonly description?: string | null;
  readonly status?: WorkItemStatus;
  readonly priority?: WorkItemPriority;
  readonly planningDurationMinutes?: number | null;
  readonly dueOn?: LocalDate | null;
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
    return this.unitOfWork.run(
      async ({ auditEvents, notifications, workItemDependencies, workItems, workspaces }) => {
        if (command.parentWorkItemId !== undefined) {
          await workItemDependencies.lockWorkspace(command.workspaceId);
        }
        await notifications.lockWorkspace(command.workspaceId);
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
        if (command.expectedStatus !== undefined && current.status !== command.expectedStatus) {
          throw new DomainError(
            "work_item.status_conflict",
            "The work item status changed before this update could be applied.",
          );
        }
        if (
          command.parentWorkItemId !== undefined &&
          command.parentWorkItemId !== null &&
          !sameWorkItemIdentity(command.parentWorkItemId, current.parentWorkItemId)
        ) {
          await assertValidWorkItemParent(
            workItems,
            command.workspaceId,
            command.workItemId,
            command.parentWorkItemId,
          );
        }
        const updated = updateWorkItem(current, {
          ...(command.parentWorkItemId === undefined
            ? {}
            : { parentWorkItemId: command.parentWorkItemId }),
          ...(command.title === undefined ? {} : { title: command.title }),
          ...(command.description === undefined ? {} : { description: command.description }),
          ...(command.status === undefined ? {} : { status: command.status }),
          ...(command.priority === undefined ? {} : { priority: command.priority }),
          ...(command.planningDurationMinutes === undefined
            ? {}
            : { planningDurationMinutes: command.planningDurationMinutes }),
          ...(command.dueOn === undefined ? {} : { dueOn: command.dueOn }),
          now: this.clock.now(),
        });
        if (updated !== current) {
          await workItems.save(updated, command.expectedVersion);
          await notifications.deleteIntentsForTarget(command.workspaceId, "work_item", updated.id);
          if (!sameWorkItemIdentity(updated.parentWorkItemId, current.parentWorkItemId)) {
            await auditEvents.append({
              workspaceId: command.workspaceId,
              action:
                updated.parentWorkItemId === null
                  ? "work_item_hierarchy.parent_removed"
                  : "work_item_hierarchy.parent_changed",
              entityType: "work_item",
              entityId: updated.id,
              data: {
                previousParentWorkItemId: current.parentWorkItemId,
                parentWorkItemId: updated.parentWorkItemId,
              },
              occurredAt: updated.updatedAt,
            });
          }
        }
        return updated;
      },
      command.parentWorkItemId === undefined ? undefined : { isolationLevel: "read_committed" },
    );
  }
}
