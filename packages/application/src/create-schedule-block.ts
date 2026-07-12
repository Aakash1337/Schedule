import {
  createScheduleBlock,
  type ScheduleBlock,
  type WorkItemId,
  type WorkspaceId,
} from "@schedule/domain";

import type { Clock, UnitOfWork } from "./ports.js";

export interface CreateScheduleBlockCommand {
  readonly workspaceId: WorkspaceId;
  readonly workItemId?: WorkItemId | null;
  readonly title?: string | null;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly timeZone: string;
}

export class CreateScheduleBlock {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(command: CreateScheduleBlockCommand): Promise<ScheduleBlock> {
    const block = createScheduleBlock({ ...command, now: this.clock.now() });
    return this.unitOfWork.run(async ({ scheduleBlocks }) => {
      await scheduleBlocks.insert(block);
      return block;
    });
  }
}
