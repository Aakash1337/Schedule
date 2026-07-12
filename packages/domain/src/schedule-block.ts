import { invariant } from "./errors.js";
import { scheduleBlockId, type ScheduleBlockId, type WorkItemId, type WorkspaceId } from "./ids.js";
import { isIanaTimeZone } from "./calendar.js";

export interface ScheduleBlock {
  readonly id: ScheduleBlockId;
  readonly workspaceId: WorkspaceId;
  readonly workItemId: WorkItemId | null;
  readonly title: string | null;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly timeZone: string;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateScheduleBlockInput {
  readonly id?: ScheduleBlockId;
  readonly workspaceId: WorkspaceId;
  readonly workItemId?: WorkItemId | null;
  readonly title?: string | null;
  readonly startsAt: Date;
  readonly endsAt: Date;
  readonly timeZone: string;
  readonly now?: Date;
}

export function createScheduleBlock(input: CreateScheduleBlockInput): ScheduleBlock {
  invariant(
    Number.isFinite(input.startsAt.getTime()),
    "schedule.start_invalid",
    "A valid start instant is required.",
  );
  invariant(
    Number.isFinite(input.endsAt.getTime()),
    "schedule.end_invalid",
    "A valid end instant is required.",
  );
  invariant(
    input.endsAt > input.startsAt,
    "schedule.range_invalid",
    "A schedule block must end after it starts.",
  );
  invariant(
    isIanaTimeZone(input.timeZone),
    "schedule.time_zone_invalid",
    "A valid IANA time zone is required.",
  );
  const now = input.now ?? new Date();

  return {
    id: input.id ?? scheduleBlockId(),
    workspaceId: input.workspaceId,
    workItemId: input.workItemId ?? null,
    title: input.title?.trim() || null,
    startsAt: new Date(input.startsAt),
    endsAt: new Date(input.endsAt),
    timeZone: input.timeZone,
    version: 1,
    createdAt: new Date(now),
    updatedAt: new Date(now),
  };
}
