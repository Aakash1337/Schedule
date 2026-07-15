import { browserSessionId, userId, workspaceId } from "@schedule/domain";
import { describe, expect, it, vi } from "vitest";

import {
  TransactionallyAuthorizedHostedUnitOfWork,
  type HostedMutationAuthorizationDecision,
  type HostedMutationTransactionContext,
  type HostedMutationUnitOfWork,
} from "./hosted-mutation-authorization.js";
import type { HostedWorkspaceAuthorization } from "./hosted-identity.js";

const AUTHORIZATION: HostedWorkspaceAuthorization = {
  userId: userId("00000000-0000-4000-8000-000000000101"),
  sessionId: browserSessionId("00000000-0000-4000-8000-000000000201"),
  workspaceId: workspaceId("00000000-0000-4000-8000-000000000301"),
};

function harness(decision: HostedMutationAuthorizationDecision) {
  const reauthorizeForUpdate = vi.fn(async () => decision);
  const context = {
    hostedMutationAuthorization: { reauthorizeForUpdate },
  } as unknown as HostedMutationTransactionContext;
  const run = vi.fn(
    async <Result>(operation: (transaction: HostedMutationTransactionContext) => Promise<Result>) =>
      operation(context),
  );
  const unitOfWork = { run } as HostedMutationUnitOfWork;
  return { context, reauthorizeForUpdate, run, unitOfWork };
}

describe("transactionally authorized hosted unit of work", () => {
  it("reauthorizes before one product operation and forwards transaction options", async () => {
    const test = harness("authorized");
    const authorization = { ...AUTHORIZATION };
    const unitOfWork = new TransactionallyAuthorizedHostedUnitOfWork(
      test.unitOfWork,
      authorization,
    );
    const operation = vi.fn(async () => "committed");
    (authorization as { workspaceId: string }).workspaceId = "00000000-0000-4000-8000-000000000399";

    await expect(unitOfWork.run(operation, { isolationLevel: "read_committed" })).resolves.toBe(
      "committed",
    );

    expect(test.run).toHaveBeenCalledTimes(1);
    expect(test.run).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "read_committed",
    });
    expect(test.reauthorizeForUpdate).toHaveBeenCalledWith(AUTHORIZATION);
    expect(Object.isFrozen(test.reauthorizeForUpdate.mock.calls[0]?.[0])).toBe(true);
    expect(operation).toHaveBeenCalledOnce();
    expect(operation).toHaveBeenCalledWith(test.context);
    expect(test.reauthorizeForUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      operation.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it.each([
    ["authentication_failed", "hosted.authentication_failed"],
    ["workspace_not_found", "workspace.not_found"],
  ] as const)("fails closed on %s before product work", async (decision, code) => {
    const test = harness(decision);
    const operation = vi.fn(async () => "must not run");
    const unitOfWork = new TransactionallyAuthorizedHostedUnitOfWork(
      test.unitOfWork,
      AUTHORIZATION,
    );

    await expect(unitOfWork.run(operation)).rejects.toMatchObject({ code });
    expect(operation).not.toHaveBeenCalled();
  });

  it("propagates repository failures without starting product work", async () => {
    const failure = new Error("database unavailable");
    const context = {
      hostedMutationAuthorization: {
        reauthorizeForUpdate: vi.fn().mockRejectedValue(failure),
      },
    } as unknown as HostedMutationTransactionContext;
    const unitOfWork: HostedMutationUnitOfWork = {
      run: async (operation) => operation(context),
    };
    const operation = vi.fn(async () => "must not run");

    await expect(
      new TransactionallyAuthorizedHostedUnitOfWork(unitOfWork, AUTHORIZATION).run(operation),
    ).rejects.toBe(failure);
    expect(operation).not.toHaveBeenCalled();
  });
});
