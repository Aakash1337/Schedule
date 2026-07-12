import {
  DomainError,
  type ScheduleBlock,
  type ScheduleBlockId,
  type WorkspaceId,
} from "@schedule/domain";

import type { Clock, UnitOfWork } from "./ports.js";

export interface DeleteScheduleBlockCommand {
  readonly workspaceId: WorkspaceId;
  readonly scheduleBlockId: ScheduleBlockId;
  readonly expectedVersion: number;
}

function auditSnapshot(block: ScheduleBlock): Readonly<Record<string, unknown>> {
  return {
    workItemId: block.workItemId,
    title: block.title,
    startsAt: block.startsAt.toISOString(),
    endsAt: block.endsAt.toISOString(),
    timeZone: block.timeZone,
    version: block.version,
    createdAt: block.createdAt.toISOString(),
    updatedAt: block.updatedAt.toISOString(),
  };
}

export class DeleteScheduleBlock {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(command: DeleteScheduleBlockCommand): Promise<void> {
    if (!Number.isInteger(command.expectedVersion) || command.expectedVersion < 1) {
      throw new DomainError(
        "schedule.expected_version_invalid",
        "Expected schedule block version must be a positive integer.",
      );
    }
    return this.unitOfWork.run(async ({ auditEvents, scheduleBlocks, workspaces }) => {
      if ((await workspaces.findById(command.workspaceId)) === null) {
        throw new DomainError("workspace.not_found", "The workspace does not exist.");
      }
      const block = await scheduleBlocks.findById(command.workspaceId, command.scheduleBlockId);
      if (block === null) {
        throw new DomainError("schedule_block.not_found", "The schedule block does not exist.");
      }
      if (block.version !== command.expectedVersion) {
        throw new DomainError(
          "schedule_block.version_conflict",
          "The schedule block changed before this deletion could be applied.",
        );
      }
      const occurredAt = this.clock.now();
      await scheduleBlocks.delete(block, command.expectedVersion);
      await auditEvents.append({
        workspaceId: command.workspaceId,
        action: "schedule_block.deleted",
        entityType: "schedule_block",
        entityId: block.id,
        data: auditSnapshot(block),
        occurredAt,
      });
    });
  }
}
