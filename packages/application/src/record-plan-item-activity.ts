import {
  DomainError,
  isPlanItemActivityActionType,
  type ActivityMetadataValue,
  type DailyPlanId,
  type LocalDate,
  type PlanItemActivityActionType,
  type PlanItemId,
  type WorkspaceId,
} from "@schedule/domain";

import type { Clock, PlanItemActivityResult, UnitOfWork } from "./ports.js";

export interface RecordPlanItemActivityCommand {
  readonly workspaceId: WorkspaceId;
  readonly date: LocalDate;
  readonly expectedPlanId: DailyPlanId;
  readonly itemId: PlanItemId;
  readonly expectedHeadVersion: number;
  readonly type: PlanItemActivityActionType;
  readonly occurredAt: Date;
  readonly timeZone: string;
  readonly durationMinutes?: number | null;
  readonly reason?: string | null;
  readonly metadata?: Readonly<Record<string, ActivityMetadataValue>>;
  readonly idempotencyKey: string;
}

export class RecordPlanItemActivity {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  execute(command: RecordPlanItemActivityCommand): Promise<PlanItemActivityResult> {
    if (!Number.isInteger(command.expectedHeadVersion) || command.expectedHeadVersion < 1) {
      throw new DomainError(
        "planning.head_version_invalid",
        "Expected plan head version must be a positive integer.",
      );
    }
    if (!isPlanItemActivityActionType(command.type)) {
      throw new DomainError(
        "planning.item_activity_type_invalid",
        "A supported plan item activity type is required.",
      );
    }
    const durationMinutes = command.durationMinutes ?? null;
    if (command.type !== "completed" && durationMinutes !== null) {
      throw new DomainError(
        "planning.item_activity_duration_invalid",
        "Only a completed plan item can record an actual duration.",
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
      dailyPlans.recordItemActivity({
        ...command,
        durationMinutes,
        reason: command.reason ?? null,
        metadata: command.metadata ?? {},
        idempotencyKey,
        now,
      }),
    );
  }
}
