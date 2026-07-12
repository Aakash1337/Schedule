import { invariant } from "./errors.js";
import { scheduleBlockId, type ScheduleBlockId, type WorkItemId, type WorkspaceId } from "./ids.js";
import { isIanaTimeZone } from "./calendar.js";

export const maximumScheduleBlockVersion = 2_147_483_647;

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

export interface UpdateScheduleBlockInput {
  readonly workItemId?: WorkItemId | null;
  readonly title?: string | null;
  readonly startsAt?: Date;
  readonly endsAt?: Date;
  readonly timeZone?: string;
  readonly now: Date;
}

function normalizeScheduleBlockTitle(value: unknown): string | null {
  invariant(
    value === null || typeof value === "string",
    "schedule.title_invalid",
    "A schedule block title must be text or null.",
  );
  const title = value?.trim() || null;
  invariant(
    title === null || title.length <= 240,
    "schedule.title_too_long",
    "A schedule block title cannot exceed 240 characters.",
  );
  return title;
}

function validateScheduleBlockRange(startsAt: Date, endsAt: Date, timeZone: string): void {
  invariant(
    startsAt instanceof Date && Number.isFinite(startsAt.getTime()),
    "schedule.start_invalid",
    "A valid start instant is required.",
  );
  invariant(
    endsAt instanceof Date && Number.isFinite(endsAt.getTime()),
    "schedule.end_invalid",
    "A valid end instant is required.",
  );
  invariant(
    endsAt > startsAt,
    "schedule.range_invalid",
    "A schedule block must end after it starts.",
  );
  invariant(
    typeof timeZone === "string" && isIanaTimeZone(timeZone),
    "schedule.time_zone_invalid",
    "A valid IANA time zone is required.",
  );
}

export function createScheduleBlock(input: CreateScheduleBlockInput): ScheduleBlock {
  validateScheduleBlockRange(input.startsAt, input.endsAt, input.timeZone);
  const now = input.now ?? new Date();
  invariant(
    now instanceof Date && Number.isFinite(now.getTime()),
    "schedule.timestamp_invalid",
    "A valid creation timestamp is required.",
  );

  return {
    id: input.id ?? scheduleBlockId(),
    workspaceId: input.workspaceId,
    workItemId: input.workItemId ?? null,
    title: normalizeScheduleBlockTitle(input.title ?? null),
    startsAt: new Date(input.startsAt),
    endsAt: new Date(input.endsAt),
    timeZone: input.timeZone,
    version: 1,
    createdAt: new Date(now),
    updatedAt: new Date(now),
  };
}

export function updateScheduleBlock(
  existing: ScheduleBlock,
  input: UpdateScheduleBlockInput,
): ScheduleBlock {
  invariant(
    Number.isInteger(existing.version) &&
      existing.version >= 1 &&
      existing.version <= maximumScheduleBlockVersion,
    "schedule.version_invalid",
    "The schedule block has an invalid version.",
  );
  invariant(
    input.now instanceof Date && Number.isFinite(input.now.getTime()),
    "schedule.timestamp_invalid",
    "A valid update timestamp is required.",
  );

  const workItemId = input.workItemId === undefined ? existing.workItemId : input.workItemId;
  const title =
    input.title === undefined ? existing.title : normalizeScheduleBlockTitle(input.title);
  const startsAt = input.startsAt ?? existing.startsAt;
  const endsAt = input.endsAt ?? existing.endsAt;
  const timeZone = input.timeZone ?? existing.timeZone;

  validateScheduleBlockRange(startsAt, endsAt, timeZone);

  const unchanged =
    workItemId === existing.workItemId &&
    title === existing.title &&
    startsAt.getTime() === existing.startsAt.getTime() &&
    endsAt.getTime() === existing.endsAt.getTime() &&
    timeZone === existing.timeZone;
  if (unchanged) return existing;

  invariant(
    existing.version < maximumScheduleBlockVersion,
    "schedule.version_exhausted",
    "The schedule block has reached its maximum supported version.",
  );

  return {
    ...existing,
    workItemId,
    title,
    startsAt: new Date(startsAt),
    endsAt: new Date(endsAt),
    timeZone,
    version: existing.version + 1,
    updatedAt: new Date(input.now),
  };
}
