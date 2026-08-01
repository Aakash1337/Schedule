import { describe, expect, it } from "vitest";

import {
  DomainError,
  createCadencePolicy,
  createDurationRange,
  createRoutine,
  createStructuredTags,
  createWorkspace,
  routineGroupNameKey,
  routineId,
  workspaceId,
  type RoutineGroup,
  type RoutineGroupMembership,
} from "@schedule/domain";

import {
  CreateRoutineGroup,
  DeleteRoutineGroup,
  ListRoutineGroupMemberships,
  ListRoutineGroups,
  ReplaceRoutineGroupMemberships,
  UpdateRoutineGroup,
} from "./routine-group-management.js";
import type { TransactionContext, UnitOfWork } from "./ports.js";

describe("routine group management", () => {
  function harness() {
    const workspace = createWorkspace({
      id: workspaceId("group-workspace"),
      name: "Personal",
      now: new Date("2026-07-27T10:00:00.000Z"),
    });
    const routine = createRoutine({
      id: routineId("spanish"),
      workspaceId: workspace.id,
      title: "Practice Spanish",
      tags: createStructuredTags(),
      duration: createDurationRange({ expectedMinutes: 30 }),
      cadence: createCadencePolicy({ period: "week" }),
      now: new Date("2026-07-27T10:00:00.000Z"),
    });
    let groups: RoutineGroup[] = [];
    let memberships: RoutineGroupMembership[] = [];
    const context = {
      workspaces: { findById: async () => workspace },
      routines: {
        findById: async (_workspaceId: string, id: string) => (id === routine.id ? routine : null),
      },
      routineGroups: {
        findById: async (_workspaceId: string, id: string) =>
          groups.find((group) => group.id === id) ?? null,
        list: async () => groups,
        listMemberships: async () => memberships,
        insert: async (group: RoutineGroup) => {
          if (
            groups.some(
              (existing) => routineGroupNameKey(existing.name) === routineGroupNameKey(group.name),
            )
          ) {
            throw new DomainError("routine_group.name_conflict", "Duplicate group.");
          }
          groups.push(group);
        },
        save: async (group: RoutineGroup, expectedVersion: number) => {
          const index = groups.findIndex(
            (existing) => existing.id === group.id && existing.version === expectedVersion,
          );
          if (index < 0) throw new DomainError("routine_group.version_conflict", "Stale group.");
          groups[index] = group;
        },
        delete: async (group: RoutineGroup) => {
          groups = groups.filter((candidate) => candidate.id !== group.id);
          memberships = memberships.filter((membership) => membership.groupId !== group.id);
        },
        replaceRoutineMemberships: async (
          targetWorkspaceId: typeof workspace.id,
          targetRoutineId: typeof routine.id,
          expectedGroupIds: readonly RoutineGroup["id"][],
          groupIds: readonly RoutineGroup["id"][],
          createdAt: Date,
        ) => {
          const currentGroupIds = memberships
            .filter((membership) => membership.routineId === targetRoutineId)
            .map((membership) => membership.groupId)
            .sort();
          const expected = [...expectedGroupIds].sort();
          if (
            currentGroupIds.length !== expected.length ||
            currentGroupIds.some((groupId, index) => groupId !== expected[index])
          ) {
            throw new DomainError(
              "routine_group.membership_conflict",
              "The routine's groups changed.",
            );
          }
          memberships = [
            ...memberships.filter((membership) => membership.routineId !== targetRoutineId),
            ...groupIds.map((groupId) => ({
              workspaceId: targetWorkspaceId,
              groupId,
              routineId: targetRoutineId,
              createdAt,
            })),
          ];
        },
      },
    } as unknown as TransactionContext;
    const unitOfWork: UnitOfWork = {
      run: async (operation) => operation(context),
    };
    let tick = 0;
    const clock = {
      now: () => new Date(Date.UTC(2026, 6, 27, 11, tick++)),
    };
    return {
      workspace,
      routine,
      groups: () => groups,
      memberships: () => memberships,
      create: new CreateRoutineGroup(unitOfWork, clock),
      list: new ListRoutineGroups(unitOfWork),
      update: new UpdateRoutineGroup(unitOfWork, clock),
      delete: new DeleteRoutineGroup(unitOfWork),
      replaceMemberships: new ReplaceRoutineGroupMemberships(unitOfWork, clock),
      listMemberships: new ListRoutineGroupMemberships(unitOfWork),
    };
  }

  it("supports versioned group CRUD and relationship-only deletion", async () => {
    const test = harness();
    const languages = await test.create.execute({
      workspaceId: test.workspace.id,
      name: "  Languages ",
    });
    const projects = await test.create.execute({
      workspaceId: test.workspace.id,
      name: "Projects",
    });
    await test.replaceMemberships.execute({
      workspaceId: test.workspace.id,
      routineId: test.routine.id,
      expectedGroupIds: [],
      groupIds: [languages.id, projects.id],
    });

    const renamed = await test.update.execute({
      workspaceId: test.workspace.id,
      groupId: languages.id,
      expectedVersion: languages.version,
      name: "Language learning",
    });
    await test.delete.execute({
      workspaceId: test.workspace.id,
      groupId: projects.id,
      expectedVersion: projects.version,
    });

    expect(renamed).toMatchObject({ name: "Language learning", version: 2 });
    expect(await test.list.execute({ workspaceId: test.workspace.id })).toEqual([renamed]);
    expect(await test.listMemberships.execute({ workspaceId: test.workspace.id })).toMatchObject([
      { groupId: renamed.id, routineId: test.routine.id },
    ]);
    expect(test.routine.title).toBe("Practice Spanish");
  });

  it("uses conflict-safe replacement semantics and validates batch selections", async () => {
    const test = harness();
    const group = await test.create.execute({
      workspaceId: test.workspace.id,
      name: "Languages",
    });
    await test.replaceMemberships.execute({
      workspaceId: test.workspace.id,
      routineId: test.routine.id,
      expectedGroupIds: [],
      groupIds: [group.id],
    });
    await test.replaceMemberships.execute({
      workspaceId: test.workspace.id,
      routineId: test.routine.id,
      expectedGroupIds: [group.id],
      groupIds: [group.id],
    });
    expect(test.memberships()).toHaveLength(1);
    await expect(
      test.replaceMemberships.execute({
        workspaceId: test.workspace.id,
        routineId: test.routine.id,
        expectedGroupIds: [group.id],
        groupIds: [group.id, group.id],
      }),
    ).rejects.toMatchObject({ code: "routine_group.membership_selection_invalid" });
    await expect(
      test.replaceMemberships.execute({
        workspaceId: test.workspace.id,
        routineId: test.routine.id,
        expectedGroupIds: [],
        groupIds: [],
      }),
    ).rejects.toMatchObject({ code: "routine_group.membership_conflict" });
    expect(test.memberships()).toHaveLength(1);
  });
});
