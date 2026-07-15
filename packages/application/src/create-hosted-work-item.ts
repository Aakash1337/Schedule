import type { WorkItem } from "@schedule/domain";

import { CreateWorkItem, type CreateWorkItemCommand } from "./create-work-item.js";
import {
  TransactionallyAuthorizedHostedUnitOfWork,
  type HostedMutationUnitOfWork,
} from "./hosted-mutation-authorization.js";
import type { HostedWorkspaceAuthorization } from "./hosted-identity.js";
import type { Clock } from "./ports.js";

export type CreateHostedWorkItemCommand = Omit<CreateWorkItemCommand, "workspaceId">;

/** Creates one work item using only the workspace identity supplied by the hosted boundary. */
export class CreateHostedWorkItem {
  constructor(
    private readonly unitOfWork: HostedMutationUnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(
    authorization: HostedWorkspaceAuthorization,
    command: CreateHostedWorkItemCommand,
  ): Promise<WorkItem> {
    const authorizedUnitOfWork = new TransactionallyAuthorizedHostedUnitOfWork(
      this.unitOfWork,
      authorization,
    );
    return new CreateWorkItem(authorizedUnitOfWork, this.clock).execute({
      ...command,
      workspaceId: authorization.workspaceId,
    });
  }
}
