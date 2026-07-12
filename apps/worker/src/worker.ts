import type { WorkerConfig } from "@schedule/config";
import {
  DEFAULT_OUTBOX_LEASE_DURATION_MS,
  claimNextOutboxEvent,
  completeOutboxEvent,
  failOutboxEvent,
  releaseOutboxEvent,
  renewOutboxEventLease,
  type ClaimedOutboxEvent,
  type DatabaseConnection,
  type DeadLetteredOutboxEvent,
} from "@schedule/database";

import type { OutboxDispatcher } from "./dispatcher.js";

export interface OutboxWorkerOptions {
  readonly leaseDurationMs?: number;
  readonly heartbeatIntervalMs?: number;
  readonly shutdownGracePeriodMs?: number;
}

export const DEFAULT_OUTBOX_HEARTBEAT_INTERVAL_MS = Math.floor(
  DEFAULT_OUTBOX_LEASE_DURATION_MS / 3,
);
export const DEFAULT_OUTBOX_SHUTDOWN_GRACE_PERIOD_MS = 30_000;

const HANDLER_FAILURE_DETAIL = "Outbox handler execution failed";
const UNHANDLED_TOPIC_FAILURE_DETAIL = "No outbox handler is registered for this topic";

const sleep = (milliseconds: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });

const logStaleClaim = (event: ClaimedOutboxEvent, operation: string): void => {
  console.error(
    JSON.stringify({
      level: "error",
      eventId: event.id,
      topic: event.topic,
      attempts: event.attempts,
      operation,
      message: "outbox claim was superseded before the worker could persist its result",
    }),
  );
};

const logDeadLetter = (
  event: Pick<DeadLetteredOutboxEvent, "id" | "topic" | "attempts">,
  failureClass: "handler_error" | "unhandled_topic" | "expired_claim_recovery",
): void => {
  console.error(
    JSON.stringify({
      level: "error",
      eventId: event.id,
      topic: event.topic,
      attempts: event.attempts,
      failureClass,
      message: "outbox event dead-lettered",
    }),
  );
};

const logRetry = (event: ClaimedOutboxEvent, failureClass: "handler_error"): void => {
  console.warn(
    JSON.stringify({
      level: "warn",
      eventId: event.id,
      topic: event.topic,
      attempts: event.attempts,
      failureClass,
      message: "outbox delivery failed; retry scheduled",
    }),
  );
};

const recordFailure = async (
  database: DatabaseConnection,
  event: ClaimedOutboxEvent,
  error: string,
  maxAttempts: number,
  source: "handler_error" | "unhandled_topic",
): Promise<void> => {
  if (source === "unhandled_topic") {
    console.warn(
      JSON.stringify({
        level: "warn",
        eventId: event.id,
        topic: event.topic,
        attempts: event.attempts,
        message: "unhandled outbox topic",
      }),
    );
  }

  const result = await failOutboxEvent(database, event, error, maxAttempts);
  if (result === "stale") {
    logStaleClaim(event, "fail");
  } else if (result === "dead_lettered") {
    logDeadLetter(event, source);
  } else if (source === "handler_error") {
    logRetry(event, source);
  }
};

const processClaimedEvent = async (
  config: WorkerConfig,
  database: DatabaseConnection,
  dispatcher: OutboxDispatcher,
  initialEvent: ClaimedOutboxEvent,
  heartbeatIntervalMs: number,
  shutdownSignal: AbortSignal,
  shutdownGracePeriodMs: number,
): Promise<void> => {
  let currentEvent = initialEvent;
  const handlerController = new AbortController();
  const heartbeatController = new AbortController();
  const heartbeat = (async (): Promise<void> => {
    while (!heartbeatController.signal.aborted) {
      await sleep(heartbeatIntervalMs, heartbeatController.signal);
      if (heartbeatController.signal.aborted) return;

      try {
        const renewal = await renewOutboxEventLease(database, currentEvent);
        if (renewal.status === "stale") {
          logStaleClaim(currentEvent, "renew");
          return;
        }
        currentEvent = renewal.event;
      } catch {
        console.error(
          JSON.stringify({
            level: "error",
            eventId: currentEvent.id,
            topic: currentEvent.topic,
            attempts: currentEvent.attempts,
            operation: "renew",
            failureClass: "lease_renewal_error",
            message: "outbox lease renewal failed; delivery remains at-least-once",
          }),
        );
      }
    }
  })();

  const dispatch = dispatcher.dispatch(initialEvent, handlerController.signal).then(
    (result) => ({ kind: "handled" as const, handled: result.handled }),
    () => ({ kind: "failed" as const }),
  );
  let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
  let resolveShutdownDeadline: (() => void) | undefined;
  const shutdownDeadline = new Promise<{ readonly kind: "shutdown_deadline" }>((resolve) => {
    resolveShutdownDeadline = () => resolve({ kind: "shutdown_deadline" });
  });
  const beginShutdownGracePeriod = (): void => {
    if (shutdownTimer !== undefined) return;
    handlerController.abort(shutdownSignal.reason);
    shutdownTimer = setTimeout(() => resolveShutdownDeadline?.(), shutdownGracePeriodMs);
  };
  shutdownSignal.addEventListener("abort", beginShutdownGracePeriod, { once: true });
  if (shutdownSignal.aborted) beginShutdownGracePeriod();

  const outcome = await Promise.race([dispatch, shutdownDeadline]);
  shutdownSignal.removeEventListener("abort", beginShutdownGracePeriod);
  if (shutdownTimer !== undefined) clearTimeout(shutdownTimer);

  if (outcome.kind === "shutdown_deadline") {
    heartbeatController.abort("shutdown deadline reached");
    void heartbeat.catch(() => undefined);
    console.warn(
      JSON.stringify({
        level: "warn",
        eventId: currentEvent.id,
        topic: currentEvent.topic,
        attempts: currentEvent.attempts,
        failureClass: "shutdown_deadline_exceeded",
        message: "outbox handler exceeded shutdown grace period; claim left for lease recovery",
      }),
    );
    return;
  }

  heartbeatController.abort("handler settled");
  await heartbeat;

  if (outcome.kind === "failed") {
    await recordFailure(
      database,
      currentEvent,
      HANDLER_FAILURE_DETAIL,
      config.OUTBOX_MAX_ATTEMPTS,
      "handler_error",
    );
    return;
  }

  if (!outcome.handled) {
    await recordFailure(
      database,
      currentEvent,
      UNHANDLED_TOPIC_FAILURE_DETAIL,
      config.OUTBOX_MAX_ATTEMPTS,
      "unhandled_topic",
    );
    return;
  }

  const result = await completeOutboxEvent(database, currentEvent);
  if (result === "stale") logStaleClaim(currentEvent, "complete");
};

const resolveTiming = (
  options: OutboxWorkerOptions,
): {
  readonly leaseDurationMs: number;
  readonly heartbeatIntervalMs: number;
  readonly shutdownGracePeriodMs: number;
} => {
  const leaseDurationMs = options.leaseDurationMs ?? DEFAULT_OUTBOX_LEASE_DURATION_MS;
  const heartbeatIntervalMs =
    options.heartbeatIntervalMs ??
    (options.leaseDurationMs === undefined
      ? DEFAULT_OUTBOX_HEARTBEAT_INTERVAL_MS
      : Math.max(1, Math.floor(leaseDurationMs / 3)));
  const shutdownGracePeriodMs =
    options.shutdownGracePeriodMs ?? DEFAULT_OUTBOX_SHUTDOWN_GRACE_PERIOD_MS;

  if (!Number.isSafeInteger(leaseDurationMs) || leaseDurationMs < 2) {
    throw new RangeError("leaseDurationMs must be an integer of at least 2 milliseconds");
  }
  if (
    !Number.isSafeInteger(heartbeatIntervalMs) ||
    heartbeatIntervalMs <= 0 ||
    heartbeatIntervalMs > Math.floor(leaseDurationMs / 2)
  ) {
    throw new RangeError(
      "heartbeatIntervalMs must be a positive integer no greater than half the lease",
    );
  }
  if (!Number.isSafeInteger(shutdownGracePeriodMs) || shutdownGracePeriodMs <= 0) {
    throw new RangeError("shutdownGracePeriodMs must be a positive integer");
  }

  return { leaseDurationMs, heartbeatIntervalMs, shutdownGracePeriodMs };
};

export async function runOutboxWorker(
  config: WorkerConfig,
  database: DatabaseConnection,
  dispatcher: OutboxDispatcher,
  signal: AbortSignal,
  options: OutboxWorkerOptions = {},
): Promise<void> {
  const { leaseDurationMs, heartbeatIntervalMs, shutdownGracePeriodMs } = resolveTiming(options);

  while (!signal.aborted) {
    let madeProgress = false;
    let dispatchedThisCycle = 0;

    while (!signal.aborted && dispatchedThisCycle < config.OUTBOX_BATCH_SIZE) {
      const result = await claimNextOutboxEvent(database, {
        leaseDurationMs,
        maxAttempts: config.OUTBOX_MAX_ATTEMPTS,
        deadLetterRecoveryLimit: config.OUTBOX_BATCH_SIZE,
      });

      for (const deadLettered of result.deadLettered) {
        madeProgress = true;
        logDeadLetter(deadLettered, "expired_claim_recovery");
      }

      if (!result.event) break;

      if (signal.aborted) {
        const release = await releaseOutboxEvent(database, result.event);
        if (release === "stale") logStaleClaim(result.event, "release");
        return;
      }

      madeProgress = true;
      dispatchedThisCycle += 1;
      await processClaimedEvent(
        config,
        database,
        dispatcher,
        result.event,
        heartbeatIntervalMs,
        signal,
        shutdownGracePeriodMs,
      );
    }

    if (!madeProgress) await sleep(config.OUTBOX_POLL_INTERVAL_MS, signal);
  }
}
