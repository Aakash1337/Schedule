import {
  browserSessionId,
  createWorkItem,
  createWorkspace,
  userId,
  workItemId,
  workspaceId,
} from "@schedule/domain";
import { describe, expect, it, vi } from "vitest";

import {
  CreateHostedWorkItem,
  type CreateHostedWorkItemCommand,
} from "./create-hosted-work-item.js";
import type {
  HostedMutationTransactionContext,
  HostedMutationUnitOfWork,
} from "./hosted-mutation-authorization.js";

describe("create hosted work item", () => {
  it("derives authority from the request context and writes in the same transaction", async () => {
    const events: string[] = [];
    const authorizedWorkspaceId = workspaceId("00000000-0000-4000-8000-000000000301");
    const otherWorkspaceId = workspaceId("00000000-0000-4000-8000-000000000399");
    const authorization = {
      userId: userId("00000000-0000-4000-8000-000000000101"),
      sessionId: browserSessionId("00000000-0000-4000-8000-000000000201"),
      workspaceId: authorizedWorkspaceId,
    };
    const now = new Date("2026-07-15T09:00:00.000Z");
    const workspace = createWorkspace({
      id: authorizedWorkspaceId,
      name: "Hosted workspace",
      now,
    });
    const parent = createWorkItem({
      id: workItemId("00000000-0000-4000-8000-000000000401"),
      workspaceId: authorizedWorkspaceId,
      title: "Parent",
      now,
    });
    const insert = vi.fn(async () => events.push("insert"));
    const context = {
      hostedMutationAuthorization: {
        reauthorizeForUpdate: vi.fn(async () => {
          events.push("authorization");
          return "authorized" as const;
        }),
      },
      workspaces: {
        findById: vi.fn(async () => {
          events.push("workspace");
          return workspace;
        }),
      },
      workItemDependencies: {
        lockWorkspace: vi.fn(async () => events.push("graph_lock")),
      },
      workItems: {
        findById: vi.fn(async () => {
          events.push("parent_read");
          return parent;
        }),
        insert,
      },
      auditEvents: {
        append: vi.fn(async () => events.push("audit")),
      },
    } as unknown as HostedMutationTransactionContext;
    const options: unknown[] = [];
    const run = vi.fn(
      async <Result>(
        operation: (transaction: HostedMutationTransactionContext) => Promise<Result>,
        transactionOptions?: unknown,
      ) => {
        options.push(transactionOptions);
        return operation(context);
      },
    );
    const unitOfWork = { run } as HostedMutationUnitOfWork;
    const command = {
      workspaceId: otherWorkspaceId,
      parentWorkItemId: parent.id,
      title: "Hosted child",
      priority: "high",
    } as unknown as CreateHostedWorkItemCommand;

    const created = await new CreateHostedWorkItem(unitOfWork, {
      now: () => new Date(now),
    }).execute(authorization, command);

    expect(run).toHaveBeenCalledOnce();
    expect(options).toEqual([{ isolationLevel: "read_committed" }]);
    expect(events).toEqual([
      "authorization",
      "graph_lock",
      "workspace",
      "parent_read",
      "insert",
      "audit",
    ]);
    expect(created.workspaceId).toBe(authorizedWorkspaceId);
    expect(created.parentWorkItemId).toBe(parent.id);
    expect(insert).toHaveBeenCalledWith(created);
  });
});
