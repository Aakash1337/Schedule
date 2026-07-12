import {
  DomainError,
  recordActivityEvent,
  type ActivityEvent,
  type ActivityEventId,
  type ActivityEventType,
  type ActivityMetadataValue,
  type DailyPlanId,
  type RoutineId,
  type WorkspaceId,
} from "@schedule/domain";

import type { Clock, UnitOfWork } from "./ports.js";

export interface RecordActivityEventCommand {
  readonly workspaceId: WorkspaceId;
  readonly routineId: RoutineId;
  readonly planId?: DailyPlanId | null;
  readonly type: ActivityEventType;
  readonly occurredAt: Date;
  readonly timeZone: string;
  readonly durationMinutes?: number | null;
  readonly reason?: string | null;
  readonly referenceEventId?: ActivityEventId | null;
  readonly idempotencyKey: string;
  readonly metadata?: Readonly<Record<string, ActivityMetadataValue>>;
}

export class RecordActivityEvent {
  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly clock: Clock,
  ) {}

  async execute(command: RecordActivityEventCommand): Promise<ActivityEvent> {
    const event = recordActivityEvent({ ...command, recordedAt: this.clock.now() });
    return this.unitOfWork.run(async ({ activityEvents, dailyPlans, routines }) => {
      if ((await routines.findById(command.workspaceId, command.routineId)) === null) {
        throw new DomainError("routine.not_found", "The routine does not exist.");
      }
      if (
        command.planId !== undefined &&
        command.planId !== null &&
        (await dailyPlans.findById(command.workspaceId, command.planId)) === null
      ) {
        throw new DomainError("plan.not_found", "The daily plan does not exist.");
      }
      if (command.referenceEventId !== undefined && command.referenceEventId !== null) {
        const referenced = await activityEvents.findById(
          command.workspaceId,
          command.referenceEventId,
        );
        if (referenced === null) {
          throw new DomainError(
            "activity.reference_not_found",
            "The referenced activity event does not exist.",
          );
        }
        if (referenced.routineId !== command.routineId || referenced.type !== "completed") {
          throw new DomainError(
            "activity.reference_invalid",
            "A correction or reversal must reference a completion for the same routine.",
          );
        }
        if (command.type === "completion_reversed" && referenced.planItemId !== null) {
          throw new DomainError(
            "planning.item_activity_reversal_requires_item_flow",
            "Reverse a plan item completion through its current Today item endpoint.",
          );
        }
      }
      return activityEvents.append(event);
    });
  }
}
