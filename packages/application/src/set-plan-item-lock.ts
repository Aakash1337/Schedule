import {
  DomainError,
  type DailyPlanId,
  type LocalDate,
  type PlanItemId,
  type WorkspaceId,
} from "@schedule/domain";

import type { Clock, PlanItemLockResult, UnitOfWork } from "./ports.js";

export interface SetPlanItemLockCommand {
  readonly workspaceId: WorkspaceId;
  readonly date: LocalDate;
  readonly expectedPlanId: DailyPlanId;
  readonly itemId: PlanItemId;
  readonly expectedHeadVersion: number;
  readonly locked: boolean;
  readonly idempotencyKey: string;
}

export class SetPlanItemLock {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(command: SetPlanItemLockCommand): Promise<PlanItemLockResult> {
    if (!Number.isInteger(command.expectedHeadVersion) || command.expectedHeadVersion < 1) {
      throw new DomainError(
        "planning.head_version_invalid",
        "Expected plan head version must be a positive integer.",
      );
    }
    const idempotencyKey = command.idempotencyKey.trim();
    if (idempotencyKey.length < 1 || idempotencyKey.length > 160) {
      throw new DomainError(
        "planning.idempotency_key_invalid",
        "A plan interaction idempotency key must contain 1–160 characters.",
      );
    }
    const now = this.clock.now();
    if (!Number.isFinite(now.getTime())) {
      throw new DomainError("planning.timestamp_invalid", "A valid interaction time is required.");
    }
    return this.unitOfWork.run(({ dailyPlans }) =>
      dailyPlans.setItemLock({ ...command, idempotencyKey, now }),
    );
  }
}
