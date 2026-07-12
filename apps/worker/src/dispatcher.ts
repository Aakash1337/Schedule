import type { ClaimedOutboxEvent } from "@schedule/database";

/**
 * Outbox delivery is at least once. Handlers must make their externally
 * visible side effects idempotent for the event id and stop promptly when
 * the signal is aborted during graceful shutdown.
 */
export type OutboxHandler = (event: ClaimedOutboxEvent, signal: AbortSignal) => Promise<void>;

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
