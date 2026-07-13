import type { ClaimedOutboxEvent } from "@schedule/database";

/**
 * Outbox delivery is at least once. Handlers must make their externally
 * visible side effects idempotent for the event id and stop promptly when
 * the signal is aborted during graceful shutdown.
 */
export type OutboxHandler = (event: ClaimedOutboxEvent, signal: AbortSignal) => Promise<void>;

/**
 * A deliberately small, safe contract for a handler to control outbox retry
 * semantics.  Do not put transport responses, URLs, bodies, or raw errors in
 * `code`: it is stored and logged by the worker.
 */
export class OutboxHandlerFailure extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly retryDelayMs: number | undefined;

  constructor(options: {
    readonly code: string;
    readonly retryable: boolean;
    readonly retryDelayMs?: number;
  }) {
    super("outbox handler failed");
    this.name = "OutboxHandlerFailure";
    this.code = /^[a-z0-9_.-]{1,64}$/.test(options.code) ? options.code : "handler_failure";
    this.retryable = options.retryable;
    this.retryDelayMs =
      options.retryDelayMs !== undefined &&
      Number.isSafeInteger(options.retryDelayMs) &&
      options.retryDelayMs >= 0
        ? options.retryDelayMs
        : undefined;
  }
}

export interface DispatchResult {
  readonly handled: boolean;
}

export class OutboxDispatcher {
  constructor(private readonly handlers: ReadonlyMap<string, OutboxHandler> = new Map()) {}

  async dispatch(event: ClaimedOutboxEvent, signal: AbortSignal): Promise<DispatchResult> {
    const handler = this.handlers.get(event.topic);
    if (!handler) return { handled: false };
    await handler(event, signal);
    return { handled: true };
  }
}
