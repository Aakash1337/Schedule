import { DomainError, type ScheduleBlock, type WorkspaceId } from "@schedule/domain";

import type { UnitOfWork } from "./ports.js";

export interface ListScheduleBlocksQuery {
  readonly workspaceId: WorkspaceId;
  readonly from: Date;
  readonly to: Date;
  readonly limit?: number;
  readonly offset?: number;
}

export interface ScheduleBlockPage {
  readonly items: readonly ScheduleBlock[];
  readonly limit: number;
  readonly offset: number;
}

const MAXIMUM_RANGE_MILLISECONDS = 93 * 24 * 60 * 60 * 1_000;

export class ListScheduleBlocks {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  execute(query: ListScheduleBlocksQuery): Promise<ScheduleBlockPage> {
    if (
      !(query.from instanceof Date) ||
      !(query.to instanceof Date) ||
      !Number.isFinite(query.from.getTime()) ||
      !Number.isFinite(query.to.getTime())
    ) {
      throw new DomainError("schedule.range_invalid", "A valid schedule range is required.");
    }
    const rangeMilliseconds = query.to.getTime() - query.from.getTime();
    if (rangeMilliseconds <= 0 || rangeMilliseconds > MAXIMUM_RANGE_MILLISECONDS) {
      throw new DomainError(
        "schedule.range_invalid",
        "The schedule range must be positive and no longer than 93 days.",
      );
    }
    const limit = query.limit ?? 100;
    const offset = query.offset ?? 0;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new DomainError(
        "schedule.limit_invalid",
        "Schedule block limit must be from 1 to 200.",
      );
    }
    if (!Number.isInteger(offset) || offset < 0 || offset > 1_000_000) {
      throw new DomainError(
        "schedule.offset_invalid",
        "Schedule block offset must be from 0 to 1,000,000.",
      );
    }
    return this.unitOfWork.run(async ({ scheduleBlocks, workspaces }) => {
      if ((await workspaces.findById(query.workspaceId)) === null) {
        throw new DomainError("workspace.not_found", "The workspace does not exist.");
      }
      const items = await scheduleBlocks.listOverlapping(
        query.workspaceId,
        query.from,
        query.to,
        limit,
        offset,
      );
      return { items, limit, offset };
    });
  }
}
