import {
  DomainError,
  updateScheduleBlock,
  type ScheduleBlock,
  type ScheduleBlockId,
  type WorkItemId,
  type WorkspaceId,
} from "@schedule/domain";

import type { Clock, UnitOfWork } from "./ports.js";

export interface UpdateScheduleBlockCommand {
  readonly workspaceId: WorkspaceId;
  readonly scheduleBlockId: ScheduleBlockId;
  readonly expectedVersion: number;
  readonly workItemId?: WorkItemId | null;
  readonly title?: string | null;
  readonly startsAt?: Date;
  readonly endsAt?: Date;
  readonly timeZone?: string;
}

export class UpdateScheduleBlock {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(command: UpdateScheduleBlockCommand): Promise<ScheduleBlock> {
    if (!Number.isInteger(command.expectedVersion) || command.expectedVersion < 1) {
      throw new DomainError(
        "schedule.expected_version_invalid",
        "Expected schedule block version must be a positive integer.",
      );
    }
    return this.unitOfWork.run(async ({ notifications, scheduleBlocks, workItems, workspaces }) => {
      await notifications.lockWorkspace(command.workspaceId);
      if ((await workspaces.findById(command.workspaceId)) === null) {
        throw new DomainError("workspace.not_found", "The workspace does not exist.");
      }
      const current = await scheduleBlocks.findById(command.workspaceId, command.scheduleBlockId);
      if (current === null) {
        throw new DomainError("schedule_block.not_found", "The schedule block does not exist.");
      }
      if (current.version !== command.expectedVersion) {
        throw new DomainError(
          "schedule_block.version_conflict",
          "The schedule block changed before this update could be applied.",
        );
      }
      if (
        command.workItemId !== undefined &&
        command.workItemId !== null &&
        (await workItems.findById(command.workspaceId, command.workItemId)) === null
      ) {
        throw new DomainError("work_item.not_found", "The linked work item does not exist.");
      }
      const updated = updateScheduleBlock(current, {
        ...(command.workItemId === undefined ? {} : { workItemId: command.workItemId }),
        ...(command.title === undefined ? {} : { title: command.title }),
        ...(command.startsAt === undefined ? {} : { startsAt: command.startsAt }),
        ...(command.endsAt === undefined ? {} : { endsAt: command.endsAt }),
        ...(command.timeZone === undefined ? {} : { timeZone: command.timeZone }),
        now: this.clock.now(),
      });
      if (updated !== current) {
        await scheduleBlocks.save(updated, command.expectedVersion);
        await notifications.deleteIntentsForTarget(
          command.workspaceId,
          "schedule_block",
          updated.id,
        );
      }
      return updated;
    });
  }
}
