import type { ClaimedReminder, ReminderTransport, ReminderTransportResult } from "./contracts.js";

const DEDUPE_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const MAXIMUM_RETRY_AFTER_SECONDS = 60;
const MAXIMUM_TITLE_CODE_POINTS = 240;
const GENERIC_MESSAGE = "Schedule reminder";

export type HermesDeliveryReconciliationResult =
  | { readonly outcome: "accepted" }
  | { readonly outcome: "not_found" }
  | { readonly outcome: "ambiguous" };

export type HermesDeliverySubmissionResult =
  | { readonly outcome: "accepted" }
  | {
      readonly outcome: "retryable_failure";
      readonly retryAfterSeconds: number;
    }
  | { readonly outcome: "permanent_failure" }
  | { readonly outcome: "ambiguous" };

export interface HermesDeliverySubmission {
  /** Stable Schedule identity. A client must use this for send idempotency and reconciliation. */
  readonly dedupeKey: string;
  /** Bounded display text; no Schedule credential, claim token, or internal delivery ID is exposed. */
  readonly message: string;
}

/**
 * Adapter-side port for an operator-owned Hermes installation. A `not_found` reconciliation must
 * be conclusive enough that sending with the same dedupe key cannot duplicate an accepted message.
 */
export interface HermesDeliveryClient {
  reconcile(dedupeKey: string, signal: AbortSignal): Promise<HermesDeliveryReconciliationResult>;
  send(
    submission: HermesDeliverySubmission,
    signal: AbortSignal,
  ): Promise<HermesDeliverySubmissionResult>;
}

/** Fixed public error: provider payloads, destinations, message bodies, and raw errors stay hidden. */
export class HermesDeliveryAmbiguousError extends Error {
  constructor() {
    super("Hermes delivery outcome is ambiguous.");
    this.name = "HermesDeliveryAmbiguousError";
  }
}

function ambiguous(): never {
  throw new HermesDeliveryAmbiguousError();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function reconciliationOutcome(value: unknown): "accepted" | "not_found" {
  if (!isObject(value) || typeof value.outcome !== "string") return ambiguous();
  if (value.outcome === "accepted" || value.outcome === "not_found") return value.outcome;
  return ambiguous();
}

function submissionOutcome(value: unknown): ReminderTransportResult {
  if (!isObject(value) || typeof value.outcome !== "string") return ambiguous();
  if (value.outcome === "accepted") return { outcome: "delivered" };
  if (value.outcome !== "retryable_failure" && value.outcome !== "permanent_failure") {
    return ambiguous();
  }
  if (value.outcome === "permanent_failure") {
    return { outcome: "permanent_failure", failureCode: "hermes.permanent_failure" };
  }
  if (
    !Number.isSafeInteger(value.retryAfterSeconds) ||
    (value.retryAfterSeconds as number) < 0 ||
    (value.retryAfterSeconds as number) > MAXIMUM_RETRY_AFTER_SECONDS
  ) {
    return ambiguous();
  }
  return {
    outcome: "retryable_failure",
    failureCode: "hermes.retryable_failure",
    retryAfterSeconds: value.retryAfterSeconds as number,
  };
}

function isDisplayControl(character: string): boolean {
  const point = character.codePointAt(0) ?? 0;
  return (
    point <= 0x1f ||
    (point >= 0x7f && point <= 0x9f) ||
    point === 0x61c ||
    point === 0x200e ||
    point === 0x200f ||
    (point >= 0x2028 && point <= 0x202e) ||
    (point >= 0x2066 && point <= 0x2069)
  );
}

function reminderMessage(command: ClaimedReminder): string {
  if (command.title === null) return GENERIC_MESSAGE;
  const title = Array.from(command.title)
    .slice(0, MAXIMUM_TITLE_CODE_POINTS)
    .map((character) => (isDisplayControl(character) ? " " : character))
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
  return title === "" ? GENERIC_MESSAGE : `${GENERIC_MESSAGE}: ${title}`;
}

async function redactedClientCall<Result>(operation: () => Promise<Result>): Promise<Result> {
  try {
    return await operation();
  } catch {
    return ambiguous();
  }
}

/**
 * Dormant ReminderTransport implementation. Importing this module performs no I/O; a caller must
 * explicitly construct it with a Hermes client and separately enable the existing supervisor.
 */
export class HermesWhatsAppTransport implements ReminderTransport {
  constructor(private readonly client: HermesDeliveryClient) {}

  async deliver(command: ClaimedReminder, signal: AbortSignal): Promise<ReminderTransportResult> {
    if (signal.aborted || !DEDUPE_KEY.test(command.dedupeKey)) return ambiguous();
    const reconciliation = await redactedClientCall(() =>
      this.client.reconcile(command.dedupeKey, signal),
    );
    const reconciled = reconciliationOutcome(reconciliation);
    if (reconciled === "accepted") return { outcome: "delivered" };
    if (signal.aborted) return ambiguous();

    const submission = Object.freeze({
      dedupeKey: command.dedupeKey,
      message: reminderMessage(command),
    });
    const result = await redactedClientCall(() => this.client.send(submission, signal));
    return submissionOutcome(result);
  }
}
