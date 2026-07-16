import type { WorkItem, WorkItemId } from "@schedule/domain";

import {
  TransactionallyAuthorizedHostedUnitOfWork,
  type HostedMutationUnitOfWork,
} from "./hosted-mutation-authorization.js";
import type { HostedWorkspaceAuthorization } from "./hosted-identity.js";
import type { Clock } from "./ports.js";
import { UpdateWorkItem } from "./update-work-item.js";

export interface UpdateHostedWorkItemStatusCommand {
  readonly workItemId: WorkItemId;
  readonly expectedVersion: number;
  readonly status: "in_progress" | "done";
}

/** Updates only workflow status using the workspace identity supplied by the hosted boundary. */
export class UpdateHostedWorkItemStatus {
  constructor(
    private readonly unitOfWork: HostedMutationUnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(
    authorization: HostedWorkspaceAuthorization,
    command: UpdateHostedWorkItemStatusCommand,
  ): Promise<WorkItem> {
    return new UpdateWorkItem(
      new TransactionallyAuthorizedHostedUnitOfWork(this.unitOfWork, authorization),
      this.clock,
    ).execute({ ...command, workspaceId: authorization.workspaceId, expectedStatus: "backlog" });
  }
}
