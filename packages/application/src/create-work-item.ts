import {
  createWorkItem,
  type WorkItem,
  type WorkItemPriority,
  type WorkspaceId,
} from "@schedule/domain";

import type { Clock, UnitOfWork } from "./ports.js";

export interface CreateWorkItemCommand {
  readonly workspaceId: WorkspaceId;
  readonly title: string;
  readonly description?: string | null;
  readonly priority?: WorkItemPriority;
}

export class CreateWorkItem {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(command: CreateWorkItemCommand): Promise<WorkItem> {
    const item = createWorkItem({ ...command, now: this.clock.now() });
    return this.unitOfWork.run(async ({ workItems }) => {
      await workItems.insert(item);
      return item;
    });
  }
}
