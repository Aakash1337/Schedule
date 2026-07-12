import { createWorkspace, type Workspace } from "@schedule/domain";

import type { Clock, UnitOfWork } from "./ports.js";

export interface CreateWorkspaceCommand {
  readonly name: string;
}

export class CreateWorkspace {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(command: CreateWorkspaceCommand): Promise<Workspace> {
    const workspace = createWorkspace({ name: command.name, now: this.clock.now() });
    return this.unitOfWork.run(async ({ workspaces }) => {
      await workspaces.insert(workspace);
      return workspace;
    });
  }
}
