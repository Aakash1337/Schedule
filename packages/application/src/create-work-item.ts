import {
  DomainError,
  createWorkItem,
  type WorkItem,
  type LocalDate,
  type WorkItemPriority,
  type WorkItemId,
  type WorkItemStatus,
  type WorkspaceId,
} from "@schedule/domain";

import type { Clock, UnitOfWork } from "./ports.js";
import { assertValidWorkItemParent } from "./work-item-hierarchy.js";

export interface CreateWorkItemCommand {
  readonly workspaceId: WorkspaceId;
  readonly parentWorkItemId?: WorkItemId | null;
  readonly title: string;
  readonly description?: string | null;
  readonly priority?: WorkItemPriority;
  readonly status?: WorkItemStatus;
  readonly planningDurationMinutes?: number | null;
  readonly dueOn?: LocalDate | null;
}

export class CreateWorkItem {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(command: CreateWorkItemCommand): Promise<WorkItem> {
    const item = createWorkItem({ ...command, now: this.clock.now() });
    return this.unitOfWork.run(
      async ({ auditEvents, workItemDependencies, workItems, workspaces }) => {
        if (item.parentWorkItemId !== null) {
          await workItemDependencies.lockWorkspace(command.workspaceId);
        }
        if ((await workspaces.findById(command.workspaceId)) === null) {
          throw new DomainError("workspace.not_found", "The workspace does not exist.");
        }
        if (item.parentWorkItemId !== null) {
          await assertValidWorkItemParent(
            workItems,
            command.workspaceId,
            item.id,
            item.parentWorkItemId,
          );
        }
        await workItems.insert(item);
        if (item.parentWorkItemId !== null) {
          await auditEvents.append({
            workspaceId: command.workspaceId,
            action: "work_item_hierarchy.parent_assigned",
            entityType: "work_item",
            entityId: item.id,
            data: { parentWorkItemId: item.parentWorkItemId },
            occurredAt: item.createdAt,
          });
        }
        return item;
      },
      item.parentWorkItemId === null ? undefined : { isolationLevel: "read_committed" },
    );
  }
}
