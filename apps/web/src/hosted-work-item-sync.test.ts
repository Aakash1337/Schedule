import { describe, expect, it, vi } from "vitest";

import { HostedApiError, type HostedWorkItemSnapshot } from "./hosted-api";
import {
  reconcileHostedWorkItems,
  type HostedWorkItemSyncApi,
  type HostedWorkItemSyncState,
} from "./hosted-work-item-sync";

const workspace = "workspace-a";

function item(id: string, createdAt: string, title = id): HostedWorkItemSnapshot {
  return {
    id,
    parentWorkItemId: null,
    title,
    description: null,
    status: "backlog",
    priority: "none",
    planningDurationMinutes: null,
    dueOn: null,
    version: 1,
    createdAt,
    updatedAt: createdAt,
  };
}

function fixture() {
  const bootstrapWorkItemSync = vi.fn<HostedWorkItemSyncApi["bootstrapWorkItemSync"]>();
  const listWorkItemSyncChanges = vi.fn<HostedWorkItemSyncApi["listWorkItemSyncChanges"]>();
  return {
    api: { bootstrapWorkItemSync, listWorkItemSyncChanges },
    bootstrapWorkItemSync,
    listWorkItemSyncChanges,
  };
}

const gone = () => new HostedApiError(410, "hosted_sync.cursor_expired", "Restart sync.");

describe("hosted work-item sync reconciliation", () => {
  it("atomically assembles every bootstrap page and sorts by creation time then id", async () => {
    const { api, bootstrapWorkItemSync, listWorkItemSyncChanges } = fixture();
    let finishBootstrap!: (page: Awaited<ReturnType<typeof api.bootstrapWorkItemSync>>) => void;
    let finishCatchUp!: (page: Awaited<ReturnType<typeof api.listWorkItemSyncChanges>>) => void;
    bootstrapWorkItemSync
      .mockResolvedValueOnce({
        protocolVersion: 1,
        items: [item("b", "2026-07-18T10:00:00.000Z")],
        checkpoint: "checkpoint-1",
        nextCursor: "bootstrap-2",
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishBootstrap = resolve;
          }),
      );
    listWorkItemSyncChanges.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishCatchUp = resolve;
        }),
    );

    let settled = false;
    const reconciliation = reconcileHostedWorkItems(api, workspace, null).then((state) => {
      settled = true;
      return state;
    });
    await vi.waitFor(() => expect(bootstrapWorkItemSync).toHaveBeenCalledTimes(2));
    expect(settled).toBe(false);
    finishBootstrap({
      protocolVersion: 1,
      items: [item("c", "2026-07-18T10:00:00.000Z"), item("a", "2026-07-18T09:00:00.000Z")],
      checkpoint: "checkpoint-1",
      nextCursor: null,
    });
    await vi.waitFor(() => expect(listWorkItemSyncChanges).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    finishCatchUp({
      protocolVersion: 1,
      changes: [
        { type: "delete", workItemId: "b" },
        { type: "upsert", item: item("d", "2026-07-18T08:00:00.000Z") },
      ],
      checkpoint: "checkpoint-2",
      nextCursor: null,
    });

    const result = await reconciliation;
    expect(result).toEqual({
      workspaceId: workspace,
      checkpoint: "checkpoint-2",
      items: [
        item("d", "2026-07-18T08:00:00.000Z"),
        item("a", "2026-07-18T09:00:00.000Z"),
        item("c", "2026-07-18T10:00:00.000Z"),
      ],
    });
    expect(bootstrapWorkItemSync).toHaveBeenNthCalledWith(1, workspace, undefined);
    expect(bootstrapWorkItemSync).toHaveBeenNthCalledWith(2, workspace, "bootstrap-2");
    expect(listWorkItemSyncChanges).toHaveBeenCalledWith(workspace, "checkpoint-1");
  });

  it("applies paged deltas in order without mutating the previous snapshot", async () => {
    const { api, listWorkItemSyncChanges } = fixture();
    const original = Object.freeze(item("a", "2026-07-18T10:00:00.000Z", "Original"));
    const removed = Object.freeze(item("b", "2026-07-18T11:00:00.000Z"));
    const previous: HostedWorkItemSyncState = Object.freeze({
      workspaceId: workspace,
      checkpoint: "checkpoint-old",
      items: Object.freeze([original, removed]),
    });
    listWorkItemSyncChanges
      .mockResolvedValueOnce({
        protocolVersion: 1,
        changes: [
          { type: "upsert", item: { ...original, title: "Updated", version: 2 } },
          { type: "delete", workItemId: removed.id },
        ],
        checkpoint: "checkpoint-new",
        nextCursor: "delta-2",
      })
      .mockResolvedValueOnce({
        protocolVersion: 1,
        changes: [
          { type: "upsert", item: item("c", "2026-07-18T09:00:00.000Z") },
          { type: "upsert", item: { ...original, title: "Newest", version: 3 } },
        ],
        checkpoint: "checkpoint-new",
        nextCursor: null,
      });

    const result = await reconcileHostedWorkItems(api, workspace, previous);

    expect(result.items.map(({ id, title }) => [id, title])).toEqual([
      ["c", "c"],
      ["a", "Newest"],
    ]);
    expect(result.checkpoint).toBe("checkpoint-new");
    expect(previous.items).toEqual([original, removed]);
    expect(result.items[1]).not.toBe(original);
    expect(listWorkItemSyncChanges).toHaveBeenNthCalledWith(1, workspace, "checkpoint-old");
    expect(listWorkItemSyncChanges).toHaveBeenNthCalledWith(2, workspace, "delta-2");
  });

  it("bootstraps instead of applying another workspace's previous state", async () => {
    const { api, bootstrapWorkItemSync, listWorkItemSyncChanges } = fixture();
    bootstrapWorkItemSync.mockResolvedValue({
      protocolVersion: 1,
      items: [item("new", "2026-07-18T09:00:00.000Z")],
      checkpoint: "fresh",
      nextCursor: null,
    });
    listWorkItemSyncChanges.mockResolvedValue({
      protocolVersion: 1,
      changes: [],
      checkpoint: "fresh",
      nextCursor: null,
    });

    const result = await reconcileHostedWorkItems(api, workspace, {
      workspaceId: "workspace-b",
      checkpoint: "foreign",
      items: [item("foreign", "2026-07-18T08:00:00.000Z")],
    });

    expect(result.items.map(({ id }) => id)).toEqual(["new"]);
    expect(listWorkItemSyncChanges).toHaveBeenCalledWith(workspace, "fresh");
    expect(bootstrapWorkItemSync).toHaveBeenCalledOnce();
  });

  it("falls back from one expired delta to exactly one fresh bootstrap", async () => {
    const { api, bootstrapWorkItemSync, listWorkItemSyncChanges } = fixture();
    listWorkItemSyncChanges.mockRejectedValueOnce(gone()).mockResolvedValueOnce({
      protocolVersion: 1,
      changes: [],
      checkpoint: "fresh-checkpoint",
      nextCursor: null,
    });
    bootstrapWorkItemSync.mockResolvedValueOnce({
      protocolVersion: 1,
      items: [item("fresh", "2026-07-18T09:00:00.000Z")],
      checkpoint: "fresh-checkpoint",
      nextCursor: null,
    });

    const result = await reconcileHostedWorkItems(api, workspace, {
      workspaceId: workspace,
      checkpoint: "expired",
      items: [item("stale", "2026-07-18T08:00:00.000Z")],
    });

    expect(result.items.map(({ id }) => id)).toEqual(["fresh"]);
    expect(listWorkItemSyncChanges.mock.calls).toEqual([
      [workspace, "expired"],
      [workspace, "fresh-checkpoint"],
    ]);
    expect(bootstrapWorkItemSync).toHaveBeenCalledOnce();
    expect(bootstrapWorkItemSync).toHaveBeenCalledWith(workspace, undefined);
  });

  it("does not restart an expired catch-up entered from delta recovery", async () => {
    const { api, bootstrapWorkItemSync, listWorkItemSyncChanges } = fixture();
    listWorkItemSyncChanges.mockRejectedValueOnce(gone()).mockRejectedValueOnce(gone());
    bootstrapWorkItemSync.mockResolvedValueOnce({
      protocolVersion: 1,
      items: [],
      checkpoint: "fresh",
      nextCursor: null,
    });

    await expect(
      reconcileHostedWorkItems(api, workspace, {
        workspaceId: workspace,
        checkpoint: "expired",
        items: [],
      }),
    ).rejects.toMatchObject({ status: 410 });
    expect(bootstrapWorkItemSync).toHaveBeenCalledOnce();
    expect(listWorkItemSyncChanges.mock.calls).toEqual([
      [workspace, "expired"],
      [workspace, "fresh"],
    ]);
  });

  it("restarts an initial bootstrap when its catch-up cursor expires", async () => {
    const { api, bootstrapWorkItemSync, listWorkItemSyncChanges } = fixture();
    bootstrapWorkItemSync
      .mockResolvedValueOnce({
        protocolVersion: 1,
        items: [item("discarded", "2026-07-18T08:00:00.000Z")],
        checkpoint: "old",
        nextCursor: null,
      })
      .mockResolvedValueOnce({
        protocolVersion: 1,
        items: [item("kept", "2026-07-18T09:00:00.000Z")],
        checkpoint: "new",
        nextCursor: null,
      });
    listWorkItemSyncChanges.mockRejectedValueOnce(gone()).mockResolvedValueOnce({
      protocolVersion: 1,
      changes: [],
      checkpoint: "new",
      nextCursor: null,
    });

    const result = await reconcileHostedWorkItems(api, workspace, null);

    expect(result.items.map(({ id }) => id)).toEqual(["kept"]);
    expect(bootstrapWorkItemSync.mock.calls).toEqual([
      [workspace, undefined],
      [workspace, undefined],
    ]);
    expect(listWorkItemSyncChanges.mock.calls).toEqual([
      [workspace, "old"],
      [workspace, "new"],
    ]);
  });

  it("discards an expired bootstrap continuation and restarts fresh once", async () => {
    const { api, bootstrapWorkItemSync, listWorkItemSyncChanges } = fixture();
    bootstrapWorkItemSync
      .mockResolvedValueOnce({
        protocolVersion: 1,
        items: [item("discarded", "2026-07-18T08:00:00.000Z")],
        checkpoint: "old",
        nextCursor: "old-next",
      })
      .mockRejectedValueOnce(gone())
      .mockResolvedValueOnce({
        protocolVersion: 1,
        items: [item("kept", "2026-07-18T09:00:00.000Z")],
        checkpoint: "new",
        nextCursor: "new-next",
      })
      .mockResolvedValueOnce({
        protocolVersion: 1,
        items: [],
        checkpoint: "new",
        nextCursor: null,
      });
    listWorkItemSyncChanges.mockResolvedValueOnce({
      protocolVersion: 1,
      changes: [],
      checkpoint: "new",
      nextCursor: null,
    });

    const result = await reconcileHostedWorkItems(api, workspace, null);

    expect(result.items.map(({ id }) => id)).toEqual(["kept"]);
    expect(bootstrapWorkItemSync.mock.calls).toEqual([
      [workspace, undefined],
      [workspace, "old-next"],
      [workspace, undefined],
      [workspace, "new-next"],
    ]);
  });

  it("surfaces a second bootstrap continuation expiration without another restart", async () => {
    const { api, bootstrapWorkItemSync } = fixture();
    bootstrapWorkItemSync
      .mockResolvedValueOnce({
        protocolVersion: 1,
        items: [],
        checkpoint: "first",
        nextCursor: "first-next",
      })
      .mockRejectedValueOnce(gone())
      .mockResolvedValueOnce({
        protocolVersion: 1,
        items: [],
        checkpoint: "second",
        nextCursor: "second-next",
      })
      .mockRejectedValueOnce(gone());

    await expect(reconcileHostedWorkItems(api, workspace, null)).rejects.toMatchObject({
      status: 410,
    });
    expect(bootstrapWorkItemSync).toHaveBeenCalledTimes(4);
  });

  it("rejects repeated bootstrap and delta cursors instead of looping", async () => {
    const bootstrapFixture = fixture();
    bootstrapFixture.bootstrapWorkItemSync
      .mockResolvedValueOnce({
        protocolVersion: 1,
        items: [],
        checkpoint: "checkpoint",
        nextCursor: "repeat",
      })
      .mockResolvedValueOnce({
        protocolVersion: 1,
        items: [],
        checkpoint: "checkpoint",
        nextCursor: "repeat",
      });
    await expect(reconcileHostedWorkItems(bootstrapFixture.api, workspace, null)).rejects.toThrow(
      "cursor cycle",
    );

    const deltaFixture = fixture();
    deltaFixture.listWorkItemSyncChanges.mockResolvedValue({
      protocolVersion: 1,
      changes: [],
      checkpoint: "checkpoint-new",
      nextCursor: "checkpoint-old",
    });
    await expect(
      reconcileHostedWorkItems(deltaFixture.api, workspace, {
        workspaceId: workspace,
        checkpoint: "checkpoint-old",
        items: [],
      }),
    ).rejects.toThrow("cursor cycle");
  });
});
