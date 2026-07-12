import {
  DomainError,
  type ScheduleBlock,
  type ScheduleBlockId,
  type WorkspaceId,
} from "@schedule/domain";

import type { UnitOfWork } from "./ports.js";

export interface GetScheduleBlockQuery {
  readonly workspaceId: WorkspaceId;
  readonly scheduleBlockId: ScheduleBlockId;
}

export class GetScheduleBlock {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  execute(query: GetScheduleBlockQuery): Promise<ScheduleBlock> {
    return this.unitOfWork.run(async ({ scheduleBlocks, workspaces }) => {
      if ((await workspaces.findById(query.workspaceId)) === null) {
        throw new DomainError("workspace.not_found", "The workspace does not exist.");
      }
      const block = await scheduleBlocks.findById(query.workspaceId, query.scheduleBlockId);
      if (block === null) {
        throw new DomainError("schedule_block.not_found", "The schedule block does not exist.");
      }
      return block;
    });
  }
}
