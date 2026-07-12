import { describe, expect, it, vi } from "vitest";

import type { ClaimedOutboxEvent } from "@schedule/database";

import { OutboxDispatcher } from "./dispatcher.js";

const event: ClaimedOutboxEvent = {
  id: "00000000-0000-0000-0000-000000000001",
  workspaceId: null,
  topic: "test.created",
  payload: { value: 1 },
  attempts: 1,
  lockedAt: "2026-07-12 12:00:00+00",
};

describe("outbox dispatcher", () => {
  it("dispatches registered handlers", async () => {
    const handler = vi.fn(async () => undefined);
    const dispatcher = new OutboxDispatcher(new Map([[event.topic, handler]]));
    const signal = new AbortController().signal;
    await expect(dispatcher.dispatch(event, signal)).resolves.toEqual({ handled: true });
    expect(handler).toHaveBeenCalledWith(event, signal);
  });

  it("reports unknown topics without failing the worker", async () => {
    const dispatcher = new OutboxDispatcher();
    await expect(dispatcher.dispatch(event, new AbortController().signal)).resolves.toEqual({
      handled: false,
    });
  });
});
