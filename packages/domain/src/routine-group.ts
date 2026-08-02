import { invariant } from "./errors.js";
import type { RoutineGroupId, RoutineId, WorkspaceId } from "./ids.js";

export const ROUTINE_GROUP_NAME_MAX_LENGTH = 80;
export const ROUTINE_GROUP_DESCRIPTION_MAX_LENGTH = 500;

export interface RoutineGroup {
  readonly id: RoutineGroupId;
  readonly workspaceId: WorkspaceId;
  readonly name: string;
  readonly description: string | null;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface RoutineGroupMembership {
  readonly workspaceId: WorkspaceId;
  readonly groupId: RoutineGroupId;
  readonly routineId: RoutineId;
  readonly createdAt: Date;
}

function canonicalGroupName(value: string): string {
  const name = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  invariant(
    name.length > 0 && name.length <= ROUTINE_GROUP_NAME_MAX_LENGTH,
    "routine_group.name_invalid",
    `Group names must contain 1–${ROUTINE_GROUP_NAME_MAX_LENGTH} characters.`,
  );
  invariant(
    !/[\p{Cc}\p{Cf}]/u.test(name),
    "routine_group.name_invalid",
    "Group names cannot contain control characters.",
  );
  invariant(
    name.toLocaleLowerCase("en-US").length <= ROUTINE_GROUP_NAME_MAX_LENGTH,
    "routine_group.name_invalid",
    `Group names must remain within ${ROUTINE_GROUP_NAME_MAX_LENGTH} characters after normalization.`,
  );
  return name;
}

function canonicalDescription(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const description = value.trim();
  if (description.length === 0) return null;
  invariant(
    description.length <= ROUTINE_GROUP_DESCRIPTION_MAX_LENGTH,
    "routine_group.description_invalid",
    `Group descriptions cannot exceed ${ROUTINE_GROUP_DESCRIPTION_MAX_LENGTH} characters.`,
  );
  return description;
}

/** Stable key used for case-insensitive uniqueness without losing the user's display casing. */
export function routineGroupNameKey(value: string): string {
  return canonicalGroupName(value).toLocaleLowerCase("en-US");
}

export interface CreateRoutineGroupInput {
  readonly id: RoutineGroupId;
  readonly workspaceId: WorkspaceId;
  readonly name: string;
  readonly description?: string | null;
  readonly now: Date;
}

export function createRoutineGroup(input: CreateRoutineGroupInput): RoutineGroup {
  invariant(
    Number.isFinite(input.now.getTime()),
    "routine_group.timestamp_invalid",
    "A valid creation time is required.",
  );
  return {
    id: input.id,
    workspaceId: input.workspaceId,
    name: canonicalGroupName(input.name),
    description: canonicalDescription(input.description),
    version: 1,
    createdAt: new Date(input.now),
    updatedAt: new Date(input.now),
  };
}

export interface UpdateRoutineGroupInput {
  readonly name?: string;
  readonly description?: string | null;
  readonly now: Date;
}

export function updateRoutineGroup(
  group: RoutineGroup,
  input: UpdateRoutineGroupInput,
): RoutineGroup {
  invariant(
    Number.isFinite(input.now.getTime()),
    "routine_group.timestamp_invalid",
    "A valid update time is required.",
  );
  const name = input.name === undefined ? group.name : canonicalGroupName(input.name);
  const description =
    input.description === undefined ? group.description : canonicalDescription(input.description);
  if (name === group.name && description === group.description) return group;
  invariant(
    group.version < 2_147_483_647,
    "routine_group.version_exhausted",
    "The group version cannot be advanced further.",
  );
  return {
    ...group,
    name,
    description,
    version: group.version + 1,
    updatedAt: new Date(input.now),
  };
}
