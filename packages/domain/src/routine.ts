import { invariant } from "./errors.js";
import { routineId, type RoutineId, type WorkspaceId } from "./ids.js";
import type { CadencePolicy } from "./cadence-policy.js";
import type { DurationRange } from "./duration.js";
import type { StructuredTags } from "./structured-tags.js";

export const routineStatuses = ["active", "paused", "archived"] as const;
export type RoutineStatus = (typeof routineStatuses)[number];
export const maximumRoutineVersion = 2_147_483_647;

export interface Routine {
  readonly id: RoutineId;
  readonly workspaceId: WorkspaceId;
  readonly title: string;
  readonly description: string | null;
  readonly tags: StructuredTags;
  readonly duration: DurationRange;
  readonly cadence: CadencePolicy;
  readonly status: RoutineStatus;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateRoutineInput {
  readonly id?: RoutineId;
  readonly workspaceId: WorkspaceId;
  readonly title: string;
  readonly description?: string | null;
  readonly tags: StructuredTags;
  readonly duration: DurationRange;
  readonly cadence: CadencePolicy;
  readonly status?: RoutineStatus;
  readonly now?: Date;
}

export interface UpdateRoutineInput {
  readonly title?: string;
  readonly description?: string | null;
  readonly tags?: StructuredTags;
  readonly duration?: DurationRange;
  readonly cadence?: CadencePolicy;
  readonly status?: RoutineStatus;
  readonly now?: Date;
}

function editableSnapshot(routine: Routine): string {
  return JSON.stringify({
    title: routine.title,
    description: routine.description,
    tags: routine.tags,
    duration: routine.duration,
    cadence: routine.cadence,
    status: routine.status,
  });
}

export function createRoutine(input: CreateRoutineInput): Routine {
  const title = input.title.trim();
  invariant(title.length > 0, "routine.title_required", "A routine title is required.");
  invariant(
    title.length <= 240,
    "routine.title_too_long",
    "A routine title cannot exceed 240 characters.",
  );
  const status = input.status ?? "active";
  invariant(
    routineStatuses.some((candidate) => candidate === status),
    "routine.status_invalid",
    "A valid routine status is required.",
  );
  const now = input.now ?? new Date();
  invariant(
    Number.isFinite(now.getTime()),
    "routine.timestamp_invalid",
    "A valid timestamp is required.",
  );

  return {
    id: input.id ?? routineId(),
    workspaceId: input.workspaceId,
    title,
    description: input.description?.trim() || null,
    tags: input.tags,
    duration: input.duration,
    cadence: input.cadence,
    status,
    version: 1,
    createdAt: new Date(now),
    updatedAt: new Date(now),
  };
}

export function changeRoutineStatus(
  routine: Routine,
  status: RoutineStatus,
  now: Date = new Date(),
): Routine {
  return updateRoutine(routine, { status, now });
}

export function updateRoutine(routine: Routine, input: UpdateRoutineInput): Routine {
  const now = input.now ?? new Date();
  invariant(
    Number.isFinite(now.getTime()),
    "routine.timestamp_invalid",
    "A valid timestamp is required.",
  );
  const title = input.title === undefined ? routine.title : input.title.trim();
  invariant(title.length > 0, "routine.title_required", "A routine title is required.");
  invariant(
    title.length <= 240,
    "routine.title_too_long",
    "A routine title cannot exceed 240 characters.",
  );
  const status = input.status ?? routine.status;
  invariant(
    routineStatuses.some((candidate) => candidate === status),
    "routine.status_invalid",
    "A valid routine status is required.",
  );
  const candidate: Routine = {
    ...routine,
    title,
    description:
      input.description === undefined ? routine.description : input.description?.trim() || null,
    tags: input.tags ?? routine.tags,
    duration: input.duration ?? routine.duration,
    cadence: input.cadence ?? routine.cadence,
    status,
  };
  if (editableSnapshot(candidate) === editableSnapshot(routine)) return routine;
  invariant(
    routine.version < maximumRoutineVersion,
    "routine.version_exhausted",
    "The routine has reached its maximum supported version.",
  );
  return {
    ...candidate,
    version: routine.version + 1,
    updatedAt: new Date(now),
  };
}
