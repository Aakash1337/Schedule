import {
  DomainError,
  createRoutineGroup,
  routineGroupId,
  updateRoutineGroup,
  type RoutineGroup,
  type RoutineGroupId,
  type RoutineGroupMembership,
  type RoutineId,
  type WorkspaceId,
} from "@schedule/domain";

import type { Clock, UnitOfWork } from "./ports.js";

export interface CreateRoutineGroupCommand {
  readonly workspaceId: WorkspaceId;
  readonly name: string;
  readonly description?: string | null;
}

export interface ListRoutineGroupsQuery {
  readonly workspaceId: WorkspaceId;
  readonly limit?: number;
  readonly offset?: number;
}

export interface UpdateRoutineGroupCommand {
  readonly workspaceId: WorkspaceId;
  readonly groupId: RoutineGroupId;
  readonly expectedVersion: number;
  readonly name?: string;
  readonly description?: string | null;
}

export interface DeleteRoutineGroupCommand {
  readonly workspaceId: WorkspaceId;
  readonly groupId: RoutineGroupId;
  readonly expectedVersion: number;
}

export interface ListRoutineGroupMembershipsQuery {
  readonly workspaceId: WorkspaceId;
  readonly limit?: number;
  readonly offset?: number;
}

export interface ReplaceRoutineGroupMembershipsCommand {
  readonly workspaceId: WorkspaceId;
  readonly routineId: RoutineId;
  readonly expectedGroupIds: readonly RoutineGroupId[];
  readonly groupIds: readonly RoutineGroupId[];
}

function positiveVersion(value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new DomainError(
      "routine_group.expected_version_invalid",
      "Expected group version must be a positive integer.",
    );
  }
}

function page(
  limit: number | undefined,
  offset: number | undefined,
): {
  limit: number;
  offset: number;
} {
  const normalizedLimit = limit ?? 100;
  const normalizedOffset = offset ?? 0;
  if (!Number.isInteger(normalizedLimit) || normalizedLimit < 1 || normalizedLimit > 200) {
    throw new DomainError("routine_group.list_limit_invalid", "Group list limit must be 1–200.");
  }
  if (!Number.isInteger(normalizedOffset) || normalizedOffset < 0 || normalizedOffset > 1_000_000) {
    throw new DomainError(
      "routine_group.list_offset_invalid",
      "Group list offset must be between 0 and 1,000,000.",
    );
  }
  return { limit: normalizedLimit, offset: normalizedOffset };
}

function membershipSelection(groupIds: readonly RoutineGroupId[]): readonly RoutineGroupId[] {
  const uniqueIds = [...new Set(groupIds)];
  if (uniqueIds.length !== groupIds.length) {
    throw new DomainError(
      "routine_group.membership_selection_invalid",
      "Routine group identifiers must be unique.",
    );
  }
  if (uniqueIds.length > 100) {
    throw new DomainError(
      "routine_group.membership_selection_invalid",
      "Routine groups must contain at most 100 unique group identifiers.",
    );
  }
  return uniqueIds;
}

export class CreateRoutineGroup {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(command: CreateRoutineGroupCommand): Promise<RoutineGroup> {
    const group = createRoutineGroup({
      id: routineGroupId(),
      workspaceId: command.workspaceId,
      name: command.name,
      ...(command.description === undefined ? {} : { description: command.description }),
      now: this.clock.now(),
    });
    return this.unitOfWork.run(async ({ workspaces, routineGroups }) => {
      if ((await workspaces.findById(command.workspaceId)) === null) {
        throw new DomainError("workspace.not_found", "The workspace does not exist.");
      }
      await routineGroups.insert(group);
      return group;
    });
  }
}

export class ListRoutineGroups {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  execute(query: ListRoutineGroupsQuery): Promise<readonly RoutineGroup[]> {
    const pagination = page(query.limit, query.offset);
    return this.unitOfWork.run(async ({ workspaces, routineGroups }) => {
      if ((await workspaces.findById(query.workspaceId)) === null) {
        throw new DomainError("workspace.not_found", "The workspace does not exist.");
      }
      return routineGroups.list(query.workspaceId, pagination.limit, pagination.offset);
    });
  }
}

export class UpdateRoutineGroup {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(command: UpdateRoutineGroupCommand): Promise<RoutineGroup> {
    positiveVersion(command.expectedVersion);
    if (command.name === undefined && command.description === undefined) {
      throw new DomainError("routine_group.update_empty", "At least one group change is required.");
    }
    return this.unitOfWork.run(async ({ routineGroups }) => {
      const existing = await routineGroups.findById(command.workspaceId, command.groupId);
      if (existing === null) {
        throw new DomainError("routine_group.not_found", "The group does not exist.");
      }
      if (existing.version !== command.expectedVersion) {
        throw new DomainError(
          "routine_group.version_conflict",
          "The group changed before this update could be applied.",
        );
      }
      const updated = updateRoutineGroup(existing, {
        ...(command.name === undefined ? {} : { name: command.name }),
        ...(command.description === undefined ? {} : { description: command.description }),
        now: this.clock.now(),
      });
      if (updated === existing) return existing;
      await routineGroups.save(updated, command.expectedVersion);
      return updated;
    });
  }
}

export class DeleteRoutineGroup {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  execute(command: DeleteRoutineGroupCommand): Promise<void> {
    positiveVersion(command.expectedVersion);
    return this.unitOfWork.run(async ({ routineGroups }) => {
      const existing = await routineGroups.findById(command.workspaceId, command.groupId);
      if (existing === null) return;
      if (existing.version !== command.expectedVersion) {
        throw new DomainError(
          "routine_group.version_conflict",
          "The group changed before this delete could be applied.",
        );
      }
      await routineGroups.delete(existing, command.expectedVersion);
    });
  }
}

export class ListRoutineGroupMemberships {
  constructor(private readonly unitOfWork: UnitOfWork) {}

  execute(query: ListRoutineGroupMembershipsQuery): Promise<readonly RoutineGroupMembership[]> {
    const pagination = page(query.limit, query.offset);
    return this.unitOfWork.run(async ({ workspaces, routineGroups }) => {
      if ((await workspaces.findById(query.workspaceId)) === null) {
        throw new DomainError("workspace.not_found", "The workspace does not exist.");
      }
      return routineGroups.listMemberships(query.workspaceId, pagination.limit, pagination.offset);
    });
  }
}

export class ReplaceRoutineGroupMemberships {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(command: ReplaceRoutineGroupMembershipsCommand): Promise<void> {
    const expectedGroupIds = membershipSelection(command.expectedGroupIds);
    const groupIds = membershipSelection(command.groupIds);
    await this.unitOfWork.run(async ({ routines, routineGroups }) => {
      if ((await routines.findById(command.workspaceId, command.routineId)) === null) {
        throw new DomainError("routine.not_found", "The routine does not exist.");
      }
      const selectedGroups = await routineGroups.findByIds(command.workspaceId, groupIds);
      if (selectedGroups.length !== groupIds.length) {
        throw new DomainError("routine_group.not_found", "A selected group does not exist.");
      }
      await routineGroups.replaceRoutineMemberships(
        command.workspaceId,
        command.routineId,
        expectedGroupIds,
        groupIds,
        this.clock.now(),
      );
    });
  }
}
