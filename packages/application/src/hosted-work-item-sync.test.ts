import { createWorkItem, workItemId, workspaceId, type WorkItem } from "@schedule/domain";
import { describe, expect, it, vi } from "vitest";

import {
  BootstrapHostedWorkItems,
  HostedWorkItemSyncStoreError,
  ListHostedWorkItemChanges,
  isCanonicalHostedWorkItemSyncCursor,
  maximumHostedWorkItemSyncCursor,
  type HostedWorkItemSyncBootstrapPage,
  type HostedWorkItemSyncChangePage,
  type HostedWorkItemSyncStore,
} from "./hosted-work-item-sync.js";

const workspace = workspaceId("sync-workspace");
const otherWorkspace = workspaceId("other-workspace");

function item(id: string, overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    ...createWorkItem({
      id: workItemId(id),
      workspaceId: workspace,
      title: `Work ${id}`,
      description: "Full sync payload",
      priority: "medium",
      dueOn: "2026-07-20",
      planningDurationMinutes: 45,
      now: new Date("2026-07-18T12:00:00.000Z"),
    }),
    ...overrides,
  };
}

function store(
  bootstrapPage: HostedWorkItemSyncBootstrapPage = {
    items: [],
    checkpoint: "0",
    nextAfterId: null,
  },
  changePage: HostedWorkItemSyncChangePage = {
    changes: [],
    throughCursor: "0",
    nextAfterCursor: null,
  },
): HostedWorkItemSyncStore {
  return {
    bootstrap: vi.fn(async () => bootstrapPage),
    listChanges: vi.fn(async () => changePage),
  };
}

describe("hosted work-item sync application contract", () => {
  it("accepts only canonical unsigned PostgreSQL bigint cursors", () => {
    for (const cursor of ["0", "1", "99", maximumHostedWorkItemSyncCursor]) {
      expect(isCanonicalHostedWorkItemSyncCursor(cursor)).toBe(true);
    }
    for (const cursor of [
      "",
      "00",
      "01",
      "+1",
      "-1",
      " 1",
      "1 ",
      "1.0",
      "1e3",
      "9223372036854775808",
      "10000000000000000000",
      1,
      null,
    ]) {
      expect(isCanonicalHostedWorkItemSyncCursor(cursor)).toBe(false);
    }
  });

  it("normalizes and forwards a bounded checkpointed bootstrap page", async () => {
    const first = item("a", { updatedAt: new Date("2026-07-18T11:59:59.000Z") });
    const second = item("b");
    const activeStore = store({
      items: [first, second],
      checkpoint: maximumHostedWorkItemSyncCursor,
      nextAfterId: second.id,
    });

    await expect(
      new BootstrapHostedWorkItems(activeStore).execute({ workspaceId: workspace }),
    ).resolves.toMatchObject({
      items: [first, second],
      checkpoint: maximumHostedWorkItemSyncCursor,
      nextAfterId: second.id,
    });
    expect(activeStore.bootstrap).toHaveBeenCalledWith(workspace, { limit: 100 });

    await new BootstrapHostedWorkItems(activeStore).execute({
      workspaceId: workspace,
      checkpoint: maximumHostedWorkItemSyncCursor,
      afterId: workItemId("0"),
      limit: 2,
    });
    expect(activeStore.bootstrap).toHaveBeenLastCalledWith(workspace, {
      checkpoint: maximumHostedWorkItemSyncCursor,
      afterId: "0",
      limit: 2,
    });
  });

  it("rejects invalid bootstrap inputs before consulting the store", async () => {
    const activeStore = store();
    const service = new BootstrapHostedWorkItems(activeStore);
    const invalidQueries = [
      { workspaceId: workspace, checkpoint: "01" },
      { workspaceId: workspace, afterId: workItemId("a") },
      { workspaceId: workspace, checkpoint: "1", afterId: "" as WorkItem["id"] },
      { workspaceId: workspace, limit: 0 },
      { workspaceId: workspace, limit: 201 },
      { workspaceId: workspace, limit: 1.5 },
    ];

    for (const query of invalidQueries) {
      await expect(service.execute(query)).rejects.toMatchObject({
        name: "HostedWorkItemSyncStoreError",
        reason: "invalid",
      });
    }
    expect(activeStore.bootstrap).not.toHaveBeenCalled();
  });

  it("fails closed on malformed, leaking, or non-progressing bootstrap pages", async () => {
    const first = item("a");
    const malformedPages: readonly unknown[] = [
      { items: [], checkpoint: "01", nextAfterId: null },
      { items: [], checkpoint: "2", nextAfterId: null },
      {
        items: [item("leak", { workspaceId: otherWorkspace })],
        checkpoint: "1",
        nextAfterId: null,
      },
      { items: [item("b"), first], checkpoint: "1", nextAfterId: null },
      { items: [first], checkpoint: "1", nextAfterId: workItemId("missing") },
      { items: [{ ...first, title: " not canonical" }], checkpoint: "1", nextAfterId: null },
      { items: [first], checkpoint: "1", nextAfterId: null, internal: true },
      { items: [first, item("b")], checkpoint: "1", nextAfterId: null },
    ];

    for (const page of malformedPages) {
      const activeStore = store(page as HostedWorkItemSyncBootstrapPage);
      await expect(
        new BootstrapHostedWorkItems(activeStore).execute({
          workspaceId: workspace,
          checkpoint: "1",
          limit: page === malformedPages.at(-1) ? 1 : 100,
        }),
      ).rejects.toMatchObject({ reason: "corrupt" });
    }
  });

  it("returns full upserts and identity-minimal deletes within one frozen change window", async () => {
    const upserted = item("a");
    const page: HostedWorkItemSyncChangePage = {
      changes: [
        { type: "upsert", cursor: "11", item: upserted },
        { type: "delete", cursor: "12", workItemId: workItemId("b") },
      ],
      throughCursor: "20",
      nextAfterCursor: "12",
    };
    const activeStore = store(undefined, page);

    await expect(
      new ListHostedWorkItemChanges(activeStore).execute({
        workspaceId: workspace,
        afterCursor: "10",
        throughCursor: "20",
        limit: 2,
      }),
    ).resolves.toEqual(page);
    expect(activeStore.listChanges).toHaveBeenCalledWith(workspace, {
      afterCursor: "10",
      throughCursor: "20",
      limit: 2,
    });
  });

  it("defaults change-page size and validates its cursor window before store access", async () => {
    const activeStore = store(undefined, {
      changes: [],
      throughCursor: maximumHostedWorkItemSyncCursor,
      nextAfterCursor: null,
    });
    const service = new ListHostedWorkItemChanges(activeStore);

    await service.execute({ workspaceId: workspace, afterCursor: maximumHostedWorkItemSyncCursor });
    expect(activeStore.listChanges).toHaveBeenCalledWith(workspace, {
      afterCursor: maximumHostedWorkItemSyncCursor,
      limit: 100,
    });

    for (const query of [
      { workspaceId: workspace, afterCursor: "01" },
      { workspaceId: workspace, afterCursor: "2", throughCursor: "1" },
      { workspaceId: workspace, afterCursor: "0", throughCursor: "+1" },
      { workspaceId: workspace, afterCursor: "0", limit: 0 },
      { workspaceId: workspace, afterCursor: "0", limit: 201 },
    ]) {
      await expect(service.execute(query)).rejects.toMatchObject({ reason: "invalid" });
    }
    expect(activeStore.listChanges).toHaveBeenCalledTimes(1);
  });

  it("fails closed on malformed change envelopes, ordering, payloads, and continuations", async () => {
    const full = item("a");
    const malformedPages: readonly unknown[] = [
      { changes: [], throughCursor: "01", nextAfterCursor: null },
      { changes: [], throughCursor: "9", nextAfterCursor: null },
      { changes: [], throughCursor: "20", nextAfterCursor: "11" },
      {
        changes: [{ type: "delete", cursor: "11", workItemId: "a", deletedAt: new Date() }],
        throughCursor: "20",
        nextAfterCursor: null,
      },
      {
        changes: [{ type: "upsert", cursor: "11", item: { ...full, description: undefined } }],
        throughCursor: "20",
        nextAfterCursor: null,
      },
      {
        changes: [{ type: "upsert", cursor: "11", item: { ...full, workspaceId: otherWorkspace } }],
        throughCursor: "20",
        nextAfterCursor: null,
      },
      {
        changes: [
          { type: "delete", cursor: "12", workItemId: "a" },
          { type: "delete", cursor: "11", workItemId: "b" },
        ],
        throughCursor: "20",
        nextAfterCursor: null,
      },
      {
        changes: [{ type: "delete", cursor: "12", workItemId: "a" }],
        throughCursor: "20",
        nextAfterCursor: null,
      },
      {
        changes: [{ type: "delete", cursor: "11", workItemId: "a" }],
        throughCursor: "20",
        nextAfterCursor: null,
      },
      {
        changes: [{ type: "delete", cursor: "21", workItemId: "a" }],
        throughCursor: "20",
        nextAfterCursor: null,
      },
      {
        changes: [{ type: "delete", cursor: "11", workItemId: "a" }],
        throughCursor: "11",
        nextAfterCursor: "11",
      },
      {
        changes: [
          { type: "delete", cursor: "11", workItemId: "a" },
          { type: "delete", cursor: "12", workItemId: "b" },
        ],
        throughCursor: "20",
        nextAfterCursor: null,
      },
    ];

    for (const page of malformedPages) {
      const activeStore = store(undefined, page as HostedWorkItemSyncChangePage);
      await expect(
        new ListHostedWorkItemChanges(activeStore).execute({
          workspaceId: workspace,
          afterCursor: "10",
          throughCursor: "20",
          limit: page === malformedPages.at(-1) ? 1 : 100,
        }),
      ).rejects.toMatchObject({ reason: "corrupt" });
    }
  });

  it("preserves canonical store failures and contains unexpected adapter errors", async () => {
    for (const reason of ["invalid", "expired", "corrupt"] as const) {
      const failure = new HostedWorkItemSyncStoreError(reason);
      const activeStore = store();
      activeStore.bootstrap = vi.fn(async () => Promise.reject(failure));
      await expect(
        new BootstrapHostedWorkItems(activeStore).execute({ workspaceId: workspace }),
      ).rejects.toBe(failure);
    }

    const activeStore = store();
    activeStore.listChanges = vi.fn(async () =>
      Promise.reject(new Error("private database detail")),
    );
    await expect(
      new ListHostedWorkItemChanges(activeStore).execute({
        workspaceId: workspace,
        afterCursor: "0",
      }),
    ).rejects.toMatchObject({
      name: "HostedWorkItemSyncStoreError",
      reason: "corrupt",
      message: "The hosted work-item sync page could not be verified.",
    });
  });
});
