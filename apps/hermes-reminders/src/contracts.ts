export const HERMES_REMINDER_ADAPTER_VERSION = "schedule.hermes-reminder/v1" as const;

export interface ClaimedReminder {
  readonly deliveryId: string;
  readonly intentId: string;
  readonly dedupeKey: string;
  readonly kind:
    | "daily_digest"
    | "daily_follow_up"
    | "plan_window_open"
    | "schedule_block_lead"
    | "work_item_due"
    | "one_off";
  readonly targetType: "workspace" | "daily_plan" | "schedule_block" | "work_item" | "one_off";
  readonly title: string | null;
  readonly scheduledFor: string;
  readonly localDate: string;
  readonly priority: number;
  readonly attempt: number;
  readonly claimToken: string;
  readonly leaseExpiresAt: string;
}

export type ReminderTransportResult =
  | { readonly outcome: "delivered" }
  | {
      readonly outcome: "retryable_failure";
      readonly failureCode: string;
      readonly retryAfterSeconds: number;
    }
  | { readonly outcome: "permanent_failure"; readonly failureCode: string };

/**
 * A deployable transport must make repeated calls with the same dedupeKey idempotent, either via
 * provider-native idempotency or conclusive reconciliation. It must never blindly resend an
 * ambiguous submission.
 */
export interface ReminderTransport {
  deliver(command: ClaimedReminder, signal: AbortSignal): Promise<ReminderTransportResult>;
}

export type DedupeReservation =
  | { readonly state: "acquired"; readonly reservationToken: string }
  | { readonly state: "busy" }
  | { readonly state: "delivered" }
  | { readonly state: "payload_conflict" };

/** Shared durable state is mandatory when more than one adapter process can run. */
export interface DeliveryDedupeStore {
  reserve(input: {
    readonly dedupeKey: string;
    readonly commandHash: string;
    readonly claimToken: string;
    readonly reservationExpiresAt: Date;
    /** Store-authoritative time that must remain before transport may begin. */
    readonly minimumRemainingMilliseconds: number;
  }): Promise<DedupeReservation>;
  markDelivered(input: {
    readonly dedupeKey: string;
    readonly reservationToken: string;
  }): Promise<void>;
  release(input: { readonly dedupeKey: string; readonly reservationToken: string }): Promise<void>;
}

export type ScheduleDeliveryReceipt = ReminderTransportResult & {
  readonly deliveryId: string;
  readonly claimToken: string;
};

export interface ScheduleDeliveryGateway {
  /** Hard upper bound for one claim or receipt request, used when budgeting a fenced lease. */
  readonly maximumRequestDurationMilliseconds: number;
  claim(idempotencyKey: string): Promise<ClaimedReminder | null>;
  recordReceipt(
    idempotencyKey: string,
    receipt: ScheduleDeliveryReceipt,
  ): Promise<{
    readonly deliveryId: string;
    readonly status: "delivered" | "retry_scheduled" | "dead_lettered" | "invalidated";
  }>;
}
