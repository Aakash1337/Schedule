import { createHash, randomUUID } from "node:crypto";

import {
  type ClaimedReminder,
  type DeliveryDedupeStore,
  type ReminderTransport,
  type ReminderTransportResult,
  type ScheduleDeliveryGateway,
} from "./contracts.js";

const FAILURE_CODE = /^[a-z0-9][a-z0-9._-]{0,79}$/u;

export type HermesReminderRunResult =
  | { readonly status: "idle" }
  | {
      readonly status: "busy" | "ambiguous" | "lease_exhausted";
      readonly deliveryId: string;
    }
  | {
      readonly status: "settled";
      readonly deliveryId: string;
      readonly outcome: ReminderTransportResult["outcome"];
      readonly scheduleStatus: "delivered" | "retry_scheduled" | "dead_lettered" | "invalidated";
      readonly deduplicated: boolean;
    };

export interface HermesReminderRunnerOptions {
  readonly minimumLeaseBudgetMilliseconds?: number;
  readonly transportTimeoutMilliseconds?: number;
  readonly now?: () => Date;
  readonly idempotencyId?: () => string;
}

function boundedTransportResult(result: unknown): ReminderTransportResult | null {
  if (typeof result !== "object" || result === null || !("outcome" in result)) return null;
  if (result.outcome === "delivered") return { outcome: "delivered" };
  if (
    (result.outcome !== "retryable_failure" && result.outcome !== "permanent_failure") ||
    !("failureCode" in result) ||
    typeof result.failureCode !== "string" ||
    !FAILURE_CODE.test(result.failureCode)
  ) {
    return null;
  }
  if (result.outcome === "permanent_failure") {
    return { outcome: "permanent_failure", failureCode: result.failureCode };
  }
  if (
    !("retryAfterSeconds" in result) ||
    !Number.isSafeInteger(result.retryAfterSeconds) ||
    (result.retryAfterSeconds as number) < 0 ||
    (result.retryAfterSeconds as number) > 60
  ) {
    return null;
  }
  return {
    outcome: "retryable_failure",
    failureCode: result.failureCode,
    retryAfterSeconds: result.retryAfterSeconds as number,
  };
}

function commandHash(command: ClaimedReminder): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "schedule.hermes-reminder.command/v1",
        command.deliveryId,
        command.intentId,
        command.dedupeKey,
        command.kind,
        command.targetType,
        command.title,
        command.scheduledFor,
        command.localDate,
        command.priority,
      ]),
      "utf8",
    )
    .digest("hex");
}

function receiptKey(claimToken: string): string {
  return `hermes-receipt:${claimToken}`;
}

export class HermesReminderRunner {
  private readonly minimumLeaseBudgetMilliseconds: number;
  private readonly transportTimeoutMilliseconds: number;
  private readonly now: () => Date;
  private readonly idempotencyId: () => string;

  constructor(
    private readonly gateway: ScheduleDeliveryGateway,
    private readonly dedupeStore: DeliveryDedupeStore,
    private readonly transport: ReminderTransport,
    options: HermesReminderRunnerOptions = {},
  ) {
    this.minimumLeaseBudgetMilliseconds = options.minimumLeaseBudgetMilliseconds ?? 5_000;
    this.transportTimeoutMilliseconds = options.transportTimeoutMilliseconds ?? 30_000;
    this.now = options.now ?? (() => new Date());
    this.idempotencyId = options.idempotencyId ?? randomUUID;
    if (
      !Number.isSafeInteger(this.minimumLeaseBudgetMilliseconds) ||
      this.minimumLeaseBudgetMilliseconds < 1_000
    ) {
      throw new TypeError("minimumLeaseBudgetMilliseconds must be an integer of at least 1000.");
    }
    if (
      !Number.isSafeInteger(this.transportTimeoutMilliseconds) ||
      this.transportTimeoutMilliseconds < 1_000 ||
      this.transportTimeoutMilliseconds > 120_000
    ) {
      throw new TypeError("transportTimeoutMilliseconds must be an integer from 1000 to 120000.");
    }
  }

  private async settle(
    command: ClaimedReminder,
    result: ReminderTransportResult,
    deduplicated: boolean,
  ): Promise<HermesReminderRunResult> {
    const receiptBudget =
      this.gateway.maximumRequestDurationMilliseconds + this.minimumLeaseBudgetMilliseconds;
    if (new Date(command.leaseExpiresAt).getTime() - this.now().getTime() < receiptBudget) {
      return { status: "lease_exhausted", deliveryId: command.deliveryId };
    }
    const bounded = boundedTransportResult(result);
    if (bounded === null) return { status: "ambiguous", deliveryId: command.deliveryId };
    const receipt = await this.gateway.recordReceipt(receiptKey(command.claimToken), {
      deliveryId: command.deliveryId,
      claimToken: command.claimToken,
      ...bounded,
    });
    return {
      status: "settled",
      deliveryId: command.deliveryId,
      outcome: bounded.outcome,
      scheduleStatus: receipt.status,
      deduplicated,
    };
  }

  async runOnce(): Promise<HermesReminderRunResult> {
    const command = await this.gateway.claim(`hermes-claim:${this.idempotencyId()}`);
    if (command === null) return { status: "idle" };

    const now = this.now();
    const leaseExpiresAt = new Date(command.leaseExpiresAt);
    const receiptBudget =
      this.gateway.maximumRequestDurationMilliseconds + this.minimumLeaseBudgetMilliseconds;
    if (
      !Number.isFinite(leaseExpiresAt.getTime()) ||
      leaseExpiresAt.getTime() - now.getTime() < receiptBudget + this.transportTimeoutMilliseconds
    ) {
      return this.settle(
        command,
        {
          outcome: "retryable_failure",
          failureCode: "lease_budget_insufficient",
          retryAfterSeconds: 0,
        },
        false,
      );
    }

    const reservation = await this.dedupeStore.reserve({
      dedupeKey: command.dedupeKey,
      commandHash: commandHash(command),
      claimToken: command.claimToken,
      reservationExpiresAt: leaseExpiresAt,
      minimumRemainingMilliseconds: receiptBudget + this.transportTimeoutMilliseconds,
    });
    if (reservation.state === "delivered") {
      return this.settle(command, { outcome: "delivered" }, true);
    }
    if (reservation.state === "payload_conflict") {
      return this.settle(
        command,
        { outcome: "permanent_failure", failureCode: "dedupe_payload_conflict" },
        false,
      );
    }
    if (reservation.state === "busy") {
      // Another adapter owns the side effect. Do not consume a Schedule attempt while its outcome
      // is unknown; let the fenced claim expire unless that owner records the receipt.
      return { status: "busy", deliveryId: command.deliveryId };
    }

    if (
      leaseExpiresAt.getTime() - this.now().getTime() <
      receiptBudget + this.transportTimeoutMilliseconds
    ) {
      await this.dedupeStore.release({
        dedupeKey: command.dedupeKey,
        reservationToken: reservation.reservationToken,
      });
      return this.settle(
        command,
        {
          outcome: "retryable_failure",
          failureCode: "lease_budget_insufficient",
          retryAfterSeconds: 0,
        },
        false,
      );
    }

    const controller = new AbortController();
    const timedOut = Symbol("transport timed out");
    let timeout: ReturnType<typeof setTimeout>;
    const timeoutResult = new Promise<typeof timedOut>((resolve) => {
      timeout = setTimeout(() => {
        controller.abort();
        resolve(timedOut);
      }, this.transportTimeoutMilliseconds);
    });
    let result: ReminderTransportResult;
    try {
      const transportResult = await Promise.race([
        this.transport.deliver(command, controller.signal),
        timeoutResult,
      ]);
      if (transportResult === timedOut) {
        return { status: "ambiguous", deliveryId: command.deliveryId };
      }
      result = transportResult;
    } catch {
      // Preserve the reservation. The provider result is ambiguous, so the next reservation owner
      // may call only a transport that reconciles or idempotently reuses the same dedupe key.
      // Do not report a failure receipt: doing so could burn bounded Schedule attempts before the
      // reservation expires and the provider result can be reconciled.
      return { status: "ambiguous", deliveryId: command.deliveryId };
    } finally {
      clearTimeout(timeout!);
    }

    const bounded = boundedTransportResult(result);
    if (bounded === null) {
      // A malformed runtime result cannot prove whether the provider performed the side effect.
      // Preserve the reservation and reconcile it just like a thrown or timed-out submission.
      return { status: "ambiguous", deliveryId: command.deliveryId };
    }
    if (bounded.outcome === "delivered") {
      await this.dedupeStore.markDelivered({
        dedupeKey: command.dedupeKey,
        reservationToken: reservation.reservationToken,
      });
    } else {
      await this.dedupeStore.release({
        dedupeKey: command.dedupeKey,
        reservationToken: reservation.reservationToken,
      });
    }
    return this.settle(command, bounded, false);
  }
}
