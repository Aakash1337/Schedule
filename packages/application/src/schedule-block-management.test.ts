import { describe, expect, it } from "vitest";

import {
  createScheduleBlock,
  createWorkItem,
  createWorkspace,
  scheduleBlockId,
  workspaceId,
  type ScheduleBlock,
} from "@schedule/domain";

import { CreateScheduleBlock } from "./create-schedule-block.js";
import { DeleteScheduleBlock } from "./delete-schedule-block.js";
import { GetScheduleBlock } from "./get-schedule-block.js";
import { ListScheduleBlocks } from "./list-schedule-blocks.js";
import type { AuditEventRecord, TransactionContext, UnitOfWork } from "./ports.js";
import { UpdateScheduleBlock } from "./update-schedule-block.js";

describe("schedule block management", () => {
  const workspace = createWorkspace({
    id: workspaceId("schedule-management-workspace"),
    name: "Test",
    now: new Date("2026-07-01T00:00:00.000Z"),
  });
  const otherWorkspace = createWorkspace({
    id: workspaceId("other-schedule-management-workspace"),
    name: "Other",
    now: new Date("2026-07-01T00:00:00.000Z"),
  });
  const workItem = createWorkItem({ workspaceId: workspace.id, title: "Ship MVP" });
  const now = new Date("2026-07-15T09:00:00.000Z");

  function harness() {
    const blocks: ScheduleBlock[] = [];
    const audits: AuditEventRecord[] = [];
    let saves = 0;
    const invalidatedTargets: string[] = [];
    const context = {
      workspaces: {
        findById: async (id) =>
          id === workspace.id ? workspace : id === otherWorkspace.id ? otherWorkspace : null,
        list: async () => [workspace, otherWorkspace],
        insert: async () => undefined,
      },
      workItems: {
        findById: async (requestedWorkspace, id) =>
          requestedWorkspace === workItem.workspaceId && id === workItem.id ? workItem : null,
      } as TransactionContext["workItems"],
      scheduleBlocks: {
        findById: async (_workspace, id) => blocks.find((block) => block.id === id) ?? null,
        listOverlapping: async (_workspace, from, to, limit, offset) =>
          blocks
            .filter((block) => block.startsAt < to && block.endsAt > from)
            .sort((left, right) => left.startsAt.getTime() - right.startsAt.getTime())
            .slice(offset, offset + limit),
        insert: async (block: ScheduleBlock) => {
          blocks.push(block);
        },
        save: async (block: ScheduleBlock, expectedVersion: number) => {
          const index = blocks.findIndex(
            (candidate) => candidate.id === block.id && candidate.version === expectedVersion,
          );
          if (index < 0) throw new Error("version conflict");
          blocks[index] = block;
          saves += 1;
        },
        delete: async (block: ScheduleBlock, expectedVersion: number) => {
          const index = blocks.findIndex(
            (candidate) => candidate.id === block.id && candidate.version === expectedVersion,
          );
          if (index < 0) throw new Error("version conflict");
          blocks.splice(index, 1);
        },
      },
      notifications: {
        lockWorkspace: async () => undefined,
        deleteIntentsForTarget: async (_workspace, targetType, targetId) => {
          invalidatedTargets.push(`${targetType}:${targetId}`);
          return 0;
        },
      } as TransactionContext["notifications"],
      auditEvents: { append: async (event: AuditEventRecord) => void audits.push(event) },
      routines: {} as TransactionContext["routines"],
      workItemDependencies: {
        loadPlanningGraph: async () => ({ workItems: [], dependencies: [] }),
      } as TransactionContext["workItemDependencies"],
      activityEvents: {} as TransactionContext["activityEvents"],
      dailyPlans: {} as TransactionContext["dailyPlans"],
    } satisfies TransactionContext;
    const unitOfWork: UnitOfWork = { run: async (operation) => operation(context) };
    const clock = { now: () => new Date(now) };
    return {
      create: new CreateScheduleBlock(unitOfWork, clock),
      get: new GetScheduleBlock(unitOfWork),
      list: new ListScheduleBlocks(unitOfWork),
      update: new UpdateScheduleBlock(unitOfWork, clock),
      delete: new DeleteScheduleBlock(unitOfWork, clock),
      blocks,
      audits,
      saves: () => saves,
      invalidatedTargets,
    };
  }

  it("creates a linked block and lists half-open overlaps", async () => {
    const test = harness();
    const block = await test.create.execute({
      workspaceId: workspace.id,
      workItemId: workItem.id,
      startsAt: new Date("2026-07-15T10:00:00.000Z"),
      endsAt: new Date("2026-07-15T11:00:00.000Z"),
      timeZone: "UTC",
    });

    const overlapping = await test.list.execute({
      workspaceId: workspace.id,
      from: new Date("2026-07-15T10:30:00.000Z"),
      to: new Date("2026-07-15T11:30:00.000Z"),
    });
    const touching = await test.list.execute({
      workspaceId: workspace.id,
      from: new Date("2026-07-15T11:00:00.000Z"),
      to: new Date("2026-07-15T12:00:00.000Z"),
    });
    expect(overlapping.items).toEqual([block]);
    expect(touching.items).toEqual([]);
    await expect(
      test.get.execute({ workspaceId: workspace.id, scheduleBlockId: block.id }),
    ).resolves.toBe(block);
  });

  it("rejects a work item owned by another workspace", async () => {
    const test = harness();

    await expect(
      test.create.execute({
        workspaceId: otherWorkspace.id,
        workItemId: workItem.id,
        startsAt: new Date("2026-07-15T10:00:00.000Z"),
        endsAt: new Date("2026-07-15T11:00:00.000Z"),
        timeZone: "UTC",
      }),
    ).rejects.toMatchObject({ code: "work_item.not_found" });
  });

  it("updates once, preserves instants across time-zone edits, and skips no-op saves", async () => {
    const test = harness();
    const block = createScheduleBlock({
      id: scheduleBlockId("update-block"),
      workspaceId: workspace.id,
      startsAt: new Date("2026-07-15T10:00:00.000Z"),
      endsAt: new Date("2026-07-15T11:00:00.000Z"),
      timeZone: "UTC",
      now,
    });
    test.blocks.push(block);
    const updated = await test.update.execute({
      workspaceId: workspace.id,
      scheduleBlockId: block.id,
      expectedVersion: 1,
      timeZone: "America/La_Paz",
    });
    const noOp = await test.update.execute({
      workspaceId: workspace.id,
      scheduleBlockId: block.id,
      expectedVersion: 2,
      timeZone: "America/La_Paz",
    });
    expect(updated.startsAt).toEqual(block.startsAt);
    expect(updated.endsAt).toEqual(block.endsAt);
    expect(updated.version).toBe(2);
    expect(noOp).toBe(updated);
    expect(test.saves()).toBe(1);
    expect(test.invalidatedTargets).toEqual([`schedule_block:${block.id}`]);
  });

  it("deletes with an audit snapshot in the same unit of work", async () => {
    const test = harness();
    const block = await test.create.execute({
      workspaceId: workspace.id,
      title: "Focus",
      startsAt: new Date("2026-07-15T10:00:00.000Z"),
      endsAt: new Date("2026-07-15T11:00:00.000Z"),
      timeZone: "UTC",
    });
    await test.delete.execute({
      workspaceId: workspace.id,
      scheduleBlockId: block.id,
      expectedVersion: 1,
    });
    expect(test.blocks).toEqual([]);
    expect(test.invalidatedTargets).toEqual([`schedule_block:${block.id}`]);
    expect(test.audits).toHaveLength(1);
    expect(test.audits[0]).toMatchObject({
      action: "schedule_block.deleted",
      entityType: "schedule_block",
      entityId: block.id,
      data: { title: "Focus", version: 1 },
    });
  });
});
