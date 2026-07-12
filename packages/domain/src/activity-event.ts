import { invariant } from "./errors.js";
import {
  activityEventId,
  type ActivityEventId,
  type DailyPlanId,
  type RoutineId,
  type WorkspaceId,
} from "./ids.js";
import { instantToLocalDate, isIanaTimeZone, type LocalDate } from "./calendar.js";

export const activityEventTypes = [
  "suggested",
  "accepted",
  "started",
  "completed",
  "skipped",
  "deferred",
  "dismissed",
  "duration_corrected",
  "completion_reversed",
] as const;
export type ActivityEventType = (typeof activityEventTypes)[number];
export type ActivityMetadataValue = string | number | boolean | null;

export interface ActivityEvent {
  readonly id: ActivityEventId;
  readonly workspaceId: WorkspaceId;
  readonly routineId: RoutineId;
  readonly planId: DailyPlanId | null;
  readonly type: ActivityEventType;
  readonly occurredAt: Date;
  readonly localDate: LocalDate;
  readonly timeZone: string;
  readonly durationMinutes: number | null;
  readonly reason: string | null;
  readonly referenceEventId: ActivityEventId | null;
  readonly idempotencyKey: string;
  readonly metadata: Readonly<Record<string, ActivityMetadataValue>>;
  readonly recordedAt: Date;
}

export interface RecordActivityEventInput {
  readonly id?: ActivityEventId;
  readonly workspaceId: WorkspaceId;
  readonly routineId: RoutineId;
  readonly planId?: DailyPlanId | null;
  readonly type: ActivityEventType;
  readonly occurredAt: Date;
  readonly timeZone: string;
  readonly durationMinutes?: number | null;
  readonly reason?: string | null;
  readonly referenceEventId?: ActivityEventId | null;
  readonly idempotencyKey?: string;
  readonly metadata?: Readonly<Record<string, ActivityMetadataValue>>;
  readonly recordedAt?: Date;
}

export function recordActivityEvent(input: RecordActivityEventInput): ActivityEvent {
  invariant(
    activityEventTypes.some((type) => type === input.type),
    "activity.type_invalid",
    "A supported activity event type is required.",
  );
  invariant(
    Number.isFinite(input.occurredAt.getTime()),
    "activity.occurred_at_invalid",
    "A valid activity occurrence timestamp is required.",
  );
  invariant(
    isIanaTimeZone(input.timeZone),
    "activity.time_zone_invalid",
    "A valid IANA time zone is required.",
  );
  const recordedAt = input.recordedAt ?? new Date();
  invariant(
    Number.isFinite(recordedAt.getTime()),
    "activity.recorded_at_invalid",
    "A valid activity recording timestamp is required.",
  );
  const durationMinutes = input.durationMinutes ?? null;
  invariant(
    durationMinutes === null || (Number.isInteger(durationMinutes) && durationMinutes > 0),
    "activity.duration_invalid",
    "Activity duration must be a positive whole number of minutes.",
  );
  const referenceEventId = input.referenceEventId ?? null;
  if (input.type === "duration_corrected") {
    invariant(
      durationMinutes !== null && referenceEventId !== null,
      "activity.correction_reference_required",
      "A duration correction requires a duration and referenced event.",
    );
  }
  if (input.type === "completion_reversed") {
    invariant(
      referenceEventId !== null,
      "activity.reversal_reference_required",
      "A completion reversal requires a referenced event.",
    );
    invariant(
      durationMinutes === null,
      "activity.reversal_duration_invalid",
      "A completion reversal cannot record a duration.",
    );
  }
  if (!["duration_corrected", "completion_reversed"].includes(input.type)) {
    invariant(
      referenceEventId === null,
      "activity.reference_not_applicable",
      "Only a duration correction or completion reversal may reference another event.",
    );
  }

  const id = input.id ?? activityEventId();
  const idempotencyKey = (input.idempotencyKey ?? id).trim();
  invariant(
    idempotencyKey.length > 0 && idempotencyKey.length <= 160,
    "activity.idempotency_key_invalid",
    "An idempotency key must contain between 1 and 160 characters.",
  );
  const reason = input.reason?.trim() || null;
  invariant(
    reason === null || reason.length <= 500,
    "activity.reason_too_long",
    "An activity reason cannot exceed 500 characters.",
  );
  const metadata = { ...(input.metadata ?? {}) };
  const metadataEntries = Object.entries(metadata);
  invariant(
    metadataEntries.length <= 8,
    "activity.metadata_limit_exceeded",
    "Activity metadata cannot contain more than 8 fields.",
  );
  invariant(
    metadataEntries.every(
      ([key, value]) =>
        key.trim().length > 0 &&
        key.length <= 64 &&
        (typeof value !== "string" || value.length <= 256) &&
        (typeof value !== "number" || Number.isFinite(value)),
    ),
    "activity.metadata_invalid",
    "Activity metadata keys and values must be bounded JSON scalars.",
  );

  return {
    id,
    workspaceId: input.workspaceId,
    routineId: input.routineId,
    planId: input.planId ?? null,
    type: input.type,
    occurredAt: new Date(input.occurredAt),
    localDate: instantToLocalDate(input.occurredAt, input.timeZone),
    timeZone: input.timeZone,
    durationMinutes,
    reason,
    referenceEventId,
    idempotencyKey,
    metadata,
    recordedAt: new Date(recordedAt),
  };
}
