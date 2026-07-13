import {
  DomainError,
  createWorkItem,
  type WorkItem,
  type LocalDate,
  type WorkItemPriority,
  type WorkItemStatus,
  type WorkspaceId,
} from "@schedule/domain";

import type { Clock, UnitOfWork } from "./ports.js";

export interface CreateWorkItemCommand {
  readonly workspaceId: WorkspaceId;
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
    return this.unitOfWork.run(async ({ workItems, workspaces }) => {
      if ((await workspaces.findById(command.workspaceId)) === null) {
        throw new DomainError("workspace.not_found", "The workspace does not exist.");
      }
      await workItems.insert(item);
      return item;
    });
  }
}
