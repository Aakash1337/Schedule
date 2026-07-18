import { DomainError } from "@schedule/domain";

import type { HostedWorkspaceAuthorization } from "./hosted-identity.js";
import type { TransactionContext, UnitOfWork, UnitOfWorkOptions } from "./ports.js";

export const hostedMutationAuthorizationDecisions = [
  "authorized",
  "authentication_failed",
  "workspace_not_found",
] as const;

export type HostedMutationAuthorizationDecision =
  (typeof hostedMutationAuthorizationDecisions)[number];

/** Read-only transaction authority; identity administration stays outside the product context. */
export interface HostedMutationAuthorizationRepository {
  reauthorizeForUpdate(
    authorization: HostedWorkspaceAuthorization,
  ): Promise<HostedMutationAuthorizationDecision>;
}

export interface HostedMutationTransactionContext extends TransactionContext {
  readonly hostedMutationAuthorization: HostedMutationAuthorizationRepository;
}

export interface HostedMutationUnitOfWork {
  run<Result>(
    operation: (context: HostedMutationTransactionContext) => Promise<Result>,
    options?: UnitOfWorkOptions,
  ): Promise<Result>;
}

function transactionAuthorizationFailure(decision: HostedMutationAuthorizationDecision): never {
  if (decision === "authentication_failed") {
    throw new DomainError("hosted.authentication_failed", "Authentication failed.");
  }
  if (decision === "workspace_not_found") {
    throw new DomainError("workspace.not_found", "The requested workspace does not exist.");
  }
  throw new Error("Hosted mutation authorization returned an invalid decision.");
}

/**
 * Adapts the hosted transaction boundary to an ordinary product unit of work. Reauthorization and
 * the supplied product operation execute inside one transaction; this class never nests a second
 * unit of work.
 */
export class TransactionallyAuthorizedHostedUnitOfWork implements UnitOfWork {
  private readonly authorization: HostedWorkspaceAuthorization;

  constructor(
    private readonly unitOfWork: HostedMutationUnitOfWork,
    authorization: HostedWorkspaceAuthorization,
  ) {
    this.authorization = Object.freeze({ ...authorization });
  }

  run<Result>(
    operation: (context: TransactionContext) => Promise<Result>,
    options?: UnitOfWorkOptions,
  ): Promise<Result> {
    return this.unitOfWork.run(async (context) => {
      const decision = await context.hostedMutationAuthorization.reauthorizeForUpdate(
        this.authorization,
      );
      if (decision !== "authorized") transactionAuthorizationFailure(decision);
      return operation(context);
    }, options);
  }
}
