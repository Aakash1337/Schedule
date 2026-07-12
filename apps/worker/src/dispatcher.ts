import type { ClaimedOutboxEvent } from "@schedule/database";

export type OutboxHandler = (event: ClaimedOutboxEvent) => Promise<void>;

export interface DispatchResult {
  readonly handled: boolean;
}

export class OutboxDispatcher {
  constructor(private readonly handlers: ReadonlyMap<string, OutboxHandler> = new Map()) {}

  async dispatch(event: ClaimedOutboxEvent): Promise<DispatchResult> {
    const handler = this.handlers.get(event.topic);
    if (!handler) return { handled: false };
    await handler(event);
    return { handled: true };
  }
}
