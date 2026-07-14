import { createHash, randomUUID } from "node:crypto";

import { DomainError } from "@schedule/domain";

import { revalidateIntegrationCredential } from "./integration-gateway.js";
import type {
  ClaimedNotificationDelivery,
  IntegrationPrincipal,
  IntegrationUnitOfWork,
  NotificationDeliveryCommandData,
  NotificationDeliveryReceiptOutcome,
  NotificationDeliveryReceiptResult,
  NotificationDeliveryRequestRecord,
} from "./ports.js";

export const DEFAULT_NOTIFICATION_DELIVERY_LEASE_MILLISECONDS = 5 * 60_000;
export const DEFAULT_NOTIFICATION_DELIVERY_MAX_ATTEMPTS = 5;

export interface ClaimNotificationDeliveryCommand {
  readonly principal: IntegrationPrincipal;
  readonly idempotencyKey: string;
}

export interface ClaimNotificationDeliveryResult {
  readonly command: NotificationDeliveryCommandData | null;
}

export interface RecordNotificationDeliveryReceiptCommand {
  readonly principal: IntegrationPrincipal;
  readonly idempotencyKey: string;
  readonly deliveryId: string;
  readonly claimToken: string;
  readonly outcome: NotificationDeliveryReceiptOutcome;
  readonly failureCode?: string | null;
  readonly retryAfterSeconds?: number | null;
}

function normalizeIdempotencyKey(value: unknown): string {
  if (typeof value !== "string") {
    throw new DomainError("integration.idempotency_key_invalid", "Idempotency-Key must be text.");
  }
  const normalized = value.trim();
  if (normalized.length < 1 || normalized.length > 160) {
    throw new DomainError(
      "integration.idempotency_key_invalid",
      "Idempotency-Key must contain between 1 and 160 characters.",
    );
  }
  return normalized;
}

function normalizeUuid(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  ) {
    throw new DomainError(`notification_delivery.${field}_invalid`, `${field} must be a UUID.`);
  }
  return value.toLowerCase();
}

function normalizeFailureCode(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]{0,79}$/.test(value)) {
    throw new DomainError(
      "notification_delivery.failure_code_invalid",
      "failureCode must be a lowercase machine code of at most 80 characters.",
    );
  }
  return value;
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new DomainError(
      "notification_delivery.configuration_invalid",
      `${name} must be a positive integer.`,
    );
  }
}

function requestHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const CLAIM_REQUEST_HASH = requestHash("schedule.notification-delivery.claim/v1");

function receiptRequestHash(input: {
  readonly deliveryId: string;
  readonly claimToken: string;
  readonly outcome: NotificationDeliveryReceiptOutcome;
  readonly failureCode: string | null;
  readonly retryAfterSeconds: number | null;
}): string {
  return requestHash(
    JSON.stringify([
      "schedule.notification-delivery.receipt/v1",
      input.deliveryId,
      input.claimToken,
      input.outcome,
      input.failureCode,
      input.retryAfterSeconds,
    ]),
  );
}

function commandData(command: ClaimedNotificationDelivery): NotificationDeliveryCommandData {
  return {
    deliveryId: command.deliveryId,
    intentId: command.intentId,
    dedupeKey: command.deliveryId,
    kind: command.kind,
    targetType: command.targetType,
    title: command.title,
    scheduledFor: command.scheduledFor.toISOString(),
    localDate: command.localDate,
    priority: command.priority,
    attempt: command.attempt,
    claimToken: command.claimToken,
    leaseExpiresAt: command.leaseExpiresAt.toISOString(),
  };
}

function replayedClaim(
  request: NotificationDeliveryRequestRecord,
): ClaimNotificationDeliveryResult {
  if (
    request.state !== "succeeded" ||
    request.completedAt === null ||
    request.result?.operation !== "claim"
  ) {
    throw new DomainError(
      "notification_delivery.request_corrupt",
      "The stored delivery claim receipt is not replayable.",
    );
  }
  return { command: request.result.command };
}

function replayedReceipt(
  request: NotificationDeliveryRequestRecord,
): NotificationDeliveryReceiptResult {
  if (
    request.state !== "succeeded" ||
    request.completedAt === null ||
    request.result?.operation !== "receipt"
  ) {
    throw new DomainError(
      "notification_delivery.request_corrupt",
      "The stored delivery outcome receipt is not replayable.",
    );
  }
  return request.result.receipt;
}

export class ClaimNotificationDelivery {
  constructor(
    private readonly unitOfWork: IntegrationUnitOfWork,
    private readonly leaseDurationMilliseconds = DEFAULT_NOTIFICATION_DELIVERY_LEASE_MILLISECONDS,
    private readonly maxAttempts = DEFAULT_NOTIFICATION_DELIVERY_MAX_ATTEMPTS,
  ) {
    assertPositiveInteger("leaseDurationMilliseconds", leaseDurationMilliseconds);
    assertPositiveInteger("maxAttempts", maxAttempts);
  }

  execute(input: ClaimNotificationDeliveryCommand): Promise<ClaimNotificationDeliveryResult> {
    const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);

    return this.unitOfWork.run(
      async (context) => {
        const beforeLock = await revalidateIntegrationCredential(
          context.credentials,
          input.principal,
          "schedule:delivery",
          await context.notificationDeliveries.currentTime(),
        );
        await context.notifications.lockWorkspace(beforeLock.workspaceId);
        const now = await context.notificationDeliveries.currentTime();
        const credential = await revalidateIntegrationCredential(
          context.credentials,
          input.principal,
          "schedule:delivery",
          now,
          { lockForUpdate: true },
        );
        if (credential.workspaceId !== beforeLock.workspaceId) {
          throw new DomainError(
            "integration.authentication_failed",
            "The integration credential could not be authenticated.",
          );
        }
        const reservation = await context.notificationDeliveryRequests.reserve({
          id: randomUUID(),
          credentialId: credential.id,
          workspaceId: credential.workspaceId,
          idempotencyKey,
          operation: "claim",
          requestHash: CLAIM_REQUEST_HASH,
          createdAt: now,
        });
        if (reservation.kind === "replay") return replayedClaim(reservation.request);

        const claimed = await context.notificationDeliveries.claimNext({
          workspaceId: credential.workspaceId,
          credentialId: credential.id,
          leaseDurationMilliseconds: this.leaseDurationMilliseconds,
          maxAttempts: this.maxAttempts,
        });
        const command = claimed === null ? null : commandData(claimed);
        if (command !== null) {
          await context.auditEvents.append({
            workspaceId: credential.workspaceId,
            action: "notification_delivery.claimed",
            entityType: "notification_delivery",
            entityId: command.deliveryId,
            data: {
              credentialId: credential.id,
              attempt: command.attempt,
              leaseExpiresAt: command.leaseExpiresAt,
            },
            occurredAt: now,
          });
        }
        const result = { operation: "claim" as const, command };
        await context.notificationDeliveryRequests.succeed(reservation.request.id, result, now);
        return { command };
      },
      { isolationLevel: "read_committed" },
    );
  }
}

export class RecordNotificationDeliveryReceipt {
  constructor(
    private readonly unitOfWork: IntegrationUnitOfWork,
    private readonly maxAttempts = DEFAULT_NOTIFICATION_DELIVERY_MAX_ATTEMPTS,
  ) {
    assertPositiveInteger("maxAttempts", maxAttempts);
  }

  execute(
    input: RecordNotificationDeliveryReceiptCommand,
  ): Promise<NotificationDeliveryReceiptResult> {
    const idempotencyKey = normalizeIdempotencyKey(input.idempotencyKey);
    const deliveryId = normalizeUuid(input.deliveryId, "delivery_id");
    const claimToken = normalizeUuid(input.claimToken, "claim_token");
    if (
      input.outcome !== "delivered" &&
      input.outcome !== "retryable_failure" &&
      input.outcome !== "permanent_failure"
    ) {
      throw new DomainError(
        "notification_delivery.outcome_invalid",
        "A supported delivery outcome is required.",
      );
    }

    const isFailure = input.outcome !== "delivered";
    const failureCode = isFailure ? normalizeFailureCode(input.failureCode) : null;
    if (!isFailure && input.failureCode !== undefined && input.failureCode !== null) {
      throw new DomainError(
        "notification_delivery.failure_code_invalid",
        "failureCode is only valid for failed delivery outcomes.",
      );
    }
    const retryAfterSeconds = input.retryAfterSeconds ?? null;
    if (
      input.outcome === "retryable_failure"
        ? !Number.isSafeInteger(retryAfterSeconds) ||
          retryAfterSeconds === null ||
          retryAfterSeconds < 0 ||
          retryAfterSeconds > 60
        : retryAfterSeconds !== null
    ) {
      throw new DomainError(
        "notification_delivery.retry_after_invalid",
        "retryAfterSeconds must be an integer from 0 to 60 only for retryable failures.",
      );
    }
    const hash = receiptRequestHash({
      deliveryId,
      claimToken,
      outcome: input.outcome,
      failureCode,
      retryAfterSeconds,
    });

    return this.unitOfWork.run(
      async (context) => {
        const beforeLock = await revalidateIntegrationCredential(
          context.credentials,
          input.principal,
          "schedule:delivery",
          await context.notificationDeliveries.currentTime(),
        );
        await context.notifications.lockWorkspace(beforeLock.workspaceId);
        const now = await context.notificationDeliveries.currentTime();
        const credential = await revalidateIntegrationCredential(
          context.credentials,
          input.principal,
          "schedule:delivery",
          now,
          { lockForUpdate: true },
        );
        if (credential.workspaceId !== beforeLock.workspaceId) {
          throw new DomainError(
            "integration.authentication_failed",
            "The integration credential could not be authenticated.",
          );
        }
        const reservation = await context.notificationDeliveryRequests.reserve({
          id: randomUUID(),
          credentialId: credential.id,
          workspaceId: credential.workspaceId,
          idempotencyKey,
          operation: "receipt",
          requestHash: hash,
          createdAt: now,
        });
        if (reservation.kind === "replay") return replayedReceipt(reservation.request);

        const receipt = await context.notificationDeliveries.settle({
          workspaceId: credential.workspaceId,
          credentialId: credential.id,
          deliveryId,
          claimToken,
          outcome: input.outcome,
          failureCode,
          retryAfterSeconds,
          maxAttempts: this.maxAttempts,
        });
        await context.auditEvents.append({
          workspaceId: credential.workspaceId,
          action: "notification_delivery.receipt_recorded",
          entityType: "notification_delivery",
          entityId: deliveryId,
          data: {
            credentialId: credential.id,
            outcome: input.outcome,
            status: receipt.status,
            failureCode,
            retryAfterSeconds,
          },
          occurredAt: now,
        });
        const result = { operation: "receipt" as const, receipt };
        await context.notificationDeliveryRequests.succeed(reservation.request.id, result, now);
        return receipt;
      },
      { isolationLevel: "read_committed" },
    );
  }
}
