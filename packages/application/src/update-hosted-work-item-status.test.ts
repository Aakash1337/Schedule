import {
  browserSessionId,
  createWorkItem,
  createWorkspace,
  userId,
  workItemId,
  workspaceId,
} from "@schedule/domain";
import { describe, expect, it, vi } from "vitest";

import type {
  HostedMutationTransactionContext,
  HostedMutationUnitOfWork,
} from "./hosted-mutation-authorization.js";
import {
  UpdateHostedWorkItemStatus,
  type UpdateHostedWorkItemStatusCommand,
} from "./update-hosted-work-item-status.js";

describe("update hosted work-item status", () => {
  it("derives authority from the request context and writes in the same transaction", async () => {
    const events: string[] = [];
    const authorizedWorkspaceId = workspaceId("00000000-0000-4000-8000-000000000301");
    const authorization = {
      userId: userId("00000000-0000-4000-8000-000000000101"),
      sessionId: browserSessionId("00000000-0000-4000-8000-000000000201"),
      workspaceId: authorizedWorkspaceId,
    };
    const now = new Date("2026-07-16T09:00:00.000Z");
    const workspace = createWorkspace({ id: authorizedWorkspaceId, name: "Hosted", now });
    const current = createWorkItem({
      id: workItemId("00000000-0000-4000-8000-000000000401"),
      workspaceId: authorizedWorkspaceId,
      title: "Hosted task",
      now,
    });
    let stored = current;
    const save = vi.fn(async (next: typeof current) => {
      events.push("save");
      stored = next;
    });
    const deleteIntentsForTarget = vi.fn(async () => events.push("intent_delete"));
    const context = {
      hostedMutationAuthorization: {
        reauthorizeForUpdate: vi.fn(async () => {
          events.push("authorization");
          return "authorized" as const;
        }),
      },
      notifications: {
        lockWorkspace: vi.fn(async () => events.push("notification_lock")),
        deleteIntentsForTarget,
      },
      workspaces: {
        findById: vi.fn(async () => {
          events.push("workspace");
          return workspace;
        }),
      },
      workItems: {
        findById: vi.fn(async () => {
          events.push("item_read");
          return stored;
        }),
        save,
      },
    } as unknown as HostedMutationTransactionContext;
    const run = vi.fn(
      async <Result>(
        operation: (transaction: HostedMutationTransactionContext) => Promise<Result>,
      ) => operation(context),
    );
    const command = {
      workspaceId: workspaceId("00000000-0000-4000-8000-000000000399"),
      workItemId: current.id,
      expectedVersion: current.version,
      status: "done",
    } as unknown as UpdateHostedWorkItemStatusCommand;

    const service = new UpdateHostedWorkItemStatus({ run } as HostedMutationUnitOfWork, {
      now: () => new Date(now.getTime() + 1_000),
    });
    const updated = await service.execute(authorization, command);

    expect(events).toEqual([
      "authorization",
      "notification_lock",
      "workspace",
      "item_read",
      "save",
      "intent_delete",
    ]);
    expect(updated).toMatchObject({
      workspaceId: authorizedWorkspaceId,
      id: current.id,
      status: "done",
      version: current.version + 1,
    });
    expect(save).toHaveBeenCalledWith(updated, current.version);
    expect(deleteIntentsForTarget).toHaveBeenCalledWith(
      authorizedWorkspaceId,
      "work_item",
      current.id,
    );
    events.length = 0;

    await expect(
      service.execute(authorization, {
        workItemId: updated.id,
        expectedVersion: updated.version,
        status: "in_progress",
      }),
    ).rejects.toMatchObject({ code: "work_item.status_conflict" });
    expect(events).toEqual(["authorization", "notification_lock", "workspace", "item_read"]);
    expect(save).toHaveBeenCalledOnce();
  });
});
