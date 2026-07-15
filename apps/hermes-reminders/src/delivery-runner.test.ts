import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type ClaimedReminder,
  type DedupeReservation,
  type DeliveryDedupeStore,
  type ReminderTransportResult,
  type ScheduleDeliveryGateway,
  type ScheduleDeliveryReceipt,
} from "./contracts.js";
import { HermesReminderRunner } from "./delivery-runner.js";

const command: ClaimedReminder = {
  deliveryId: "00000000-0000-4000-8000-000000000001",
  intentId: "00000000-0000-4000-8000-000000000001",
  dedupeKey: "00000000-0000-4000-8000-000000000001",
  kind: "one_off",
  targetType: "one_off",
  title: "Call the dentist",
  scheduledFor: "2026-07-15T01:00:00.000Z",
  localDate: "2026-07-14",
  priority: 50,
  attempt: 1,
  claimToken: "00000000-0000-4000-8000-000000000002",
  leaseExpiresAt: "2026-07-15T00:10:00.000Z",
};

function harness(reservation: DedupeReservation = { state: "acquired", reservationToken: "r1" }) {
  let now = new Date("2026-07-15T00:00:00.000Z");
  const events: string[] = [];
  let claimed: ClaimedReminder | null = command;
  const receipts: ScheduleDeliveryReceipt[] = [];
  const gateway: ScheduleDeliveryGateway = {
    maximumRequestDurationMilliseconds: 10_000,
    claim: vi.fn(async () => claimed),
    recordReceipt: vi.fn(async (_key, receipt) => {
      events.push("receipt");
      receipts.push(receipt);
      return {
        deliveryId: receipt.deliveryId,
        status:
          receipt.outcome === "delivered"
            ? ("delivered" as const)
            : receipt.outcome === "retryable_failure"
              ? ("retry_scheduled" as const)
              : ("dead_lettered" as const),
      };
    }),
  };
  const store: DeliveryDedupeStore = {
    reserve: vi.fn(async () => reservation),
    markDelivered: vi.fn(async () => {
      events.push("dedupe_delivered");
    }),
    release: vi.fn(async () => {
      events.push("dedupe_released");
    }),
  };
  let transportResult: ReminderTransportResult = { outcome: "delivered" };
  let transportError: Error | null = null;
  const transport = {
    deliver: vi.fn(async () => {
      events.push("transport");
      if (transportError !== null) throw transportError;
      return transportResult;
    }),
  };
  const runner = new HermesReminderRunner(gateway, store, transport, {
    now: () => new Date(now),
    idempotencyId: () => "00000000-0000-4000-8000-000000000003",
    minimumLeaseBudgetMilliseconds: 5_000,
    transportTimeoutMilliseconds: 30_000,
  });
  return {
    runner,
    gateway,
    store,
    transport,
    receipts,
    events,
    setClaim: (value: ClaimedReminder | null) => {
      claimed = value;
    },
    setTransportResult: (value: ReminderTransportResult) => {
      transportResult = value;
    },
    setTransportError: (value: Error) => {
      transportError = value;
    },
    setNow: (value: Date) => {
      now = new Date(value);
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Hermes reminder delivery runner", () => {
  it("claims, sends idempotently, persists dedupe success, then acknowledges Schedule", async () => {
    const test = harness();
    const result = await test.runner.runOnce();

    expect(result).toEqual({
      status: "settled",
      deliveryId: command.deliveryId,
      outcome: "delivered",
      scheduleStatus: "delivered",
      deduplicated: false,
    });
    expect(test.gateway.claim).toHaveBeenCalledWith(
      "hermes-claim:00000000-0000-4000-8000-000000000003",
    );
    expect(test.transport.deliver).toHaveBeenCalledWith(command, expect.any(AbortSignal));
    expect(test.events).toEqual(["transport", "dedupe_delivered", "receipt"]);
    expect(test.receipts).toEqual([
      {
        deliveryId: command.deliveryId,
        claimToken: command.claimToken,
        outcome: "delivered",
      },
    ]);
  });

  it("does nothing when Schedule has no due reminder", async () => {
    const test = harness();
    test.setClaim(null);
    await expect(test.runner.runOnce()).resolves.toEqual({ status: "idle" });
    expect(test.store.reserve).not.toHaveBeenCalled();
    expect(test.transport.deliver).not.toHaveBeenCalled();
  });

  it("acknowledges a previously delivered dedupe key without sending again", async () => {
    const test = harness({ state: "delivered" });
    await expect(test.runner.runOnce()).resolves.toMatchObject({
      outcome: "delivered",
      deduplicated: true,
    });
    expect(test.transport.deliver).not.toHaveBeenCalled();
  });

  it("leaves a busy side effect fenced without consuming a Schedule attempt", async () => {
    const test = harness({ state: "busy" });
    await expect(test.runner.runOnce()).resolves.toEqual({
      status: "busy",
      deliveryId: command.deliveryId,
    });
    expect(test.transport.deliver).not.toHaveBeenCalled();
    expect(test.gateway.recordReceipt).not.toHaveBeenCalled();
  });

  it("dead-letters a dedupe payload conflict without calling transport", async () => {
    const test = harness({ state: "payload_conflict" });
    await test.runner.runOnce();
    expect(test.transport.deliver).not.toHaveBeenCalled();
    expect(test.receipts[0]).toMatchObject({
      outcome: "permanent_failure",
      failureCode: "dedupe_payload_conflict",
    });
  });

  it("does not start transport without enough lease budget", async () => {
    const test = harness();
    test.setClaim({ ...command, leaseExpiresAt: "2026-07-15T00:00:34.999Z" });
    await test.runner.runOnce();
    expect(test.store.reserve).not.toHaveBeenCalled();
    expect(test.transport.deliver).not.toHaveBeenCalled();
    expect(test.receipts[0]).toMatchObject({
      outcome: "retryable_failure",
      failureCode: "lease_budget_insufficient",
    });
  });

  it("rechecks lease budget after a slow dedupe reservation", async () => {
    const test = harness();
    vi.mocked(test.store.reserve).mockImplementationOnce(async () => {
      test.setNow(new Date("2026-07-15T00:09:59.999Z"));
      return { state: "acquired", reservationToken: "slow-reservation" };
    });
    await expect(test.runner.runOnce()).resolves.toEqual({
      status: "lease_exhausted",
      deliveryId: command.deliveryId,
    });
    expect(test.store.release).toHaveBeenCalledWith({
      dedupeKey: command.dedupeKey,
      reservationToken: "slow-reservation",
    });
    expect(test.transport.deliver).not.toHaveBeenCalled();
    expect(test.gateway.recordReceipt).not.toHaveBeenCalled();
  });

  it("bounds a transport that ignores cancellation and preserves its ambiguous reservation", async () => {
    vi.useFakeTimers();
    const test = harness();
    vi.mocked(test.transport.deliver).mockImplementationOnce(
      async () => new Promise<ReminderTransportResult>(() => undefined),
    );
    const pending = test.runner.runOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(pending).resolves.toEqual({
      status: "ambiguous",
      deliveryId: command.deliveryId,
    });
    expect(test.store.release).not.toHaveBeenCalled();
    expect(test.gateway.recordReceipt).not.toHaveBeenCalled();
  });

  it("releases known failures before recording their bounded receipt", async () => {
    const test = harness();
    test.setTransportResult({
      outcome: "retryable_failure",
      failureCode: "provider_unavailable",
      retryAfterSeconds: 10,
    });
    await test.runner.runOnce();
    expect(test.events).toEqual(["transport", "dedupe_released", "receipt"]);
    expect(test.receipts[0]).toMatchObject({
      outcome: "retryable_failure",
      failureCode: "provider_unavailable",
      retryAfterSeconds: 10,
    });
  });

  it("preserves an ambiguous reservation without consuming attempts or leaking the exception", async () => {
    const test = harness();
    test.setTransportError(new Error("private WhatsApp response with phone number"));
    await expect(test.runner.runOnce()).resolves.toEqual({
      status: "ambiguous",
      deliveryId: command.deliveryId,
    });
    expect(test.store.release).not.toHaveBeenCalled();
    expect(test.store.markDelivered).not.toHaveBeenCalled();
    expect(test.gateway.recordReceipt).not.toHaveBeenCalled();
  });

  it("preserves a malformed transport result as ambiguous", async () => {
    const test = harness();
    test.setTransportResult({
      outcome: "retryable_failure",
      failureCode: "Private provider failure!",
      retryAfterSeconds: 999,
    });
    await expect(test.runner.runOnce()).resolves.toEqual({
      status: "ambiguous",
      deliveryId: command.deliveryId,
    });
    expect(test.store.release).not.toHaveBeenCalled();
    expect(test.gateway.recordReceipt).not.toHaveBeenCalled();
  });

  it("includes the gateway request bound in its lease budget", async () => {
    const test = harness();
    test.setClaim({ ...command, leaseExpiresAt: "2026-07-15T00:00:44.999Z" });
    await test.runner.runOnce();
    expect(test.store.reserve).not.toHaveBeenCalled();
    expect(test.transport.deliver).not.toHaveBeenCalled();
  });

  it("replays delivered dedupe state after a lost Schedule receipt without another send", async () => {
    const first = harness();
    vi.mocked(first.gateway.recordReceipt).mockRejectedValueOnce(new Error("response lost"));
    await expect(first.runner.runOnce()).rejects.toThrow("response lost");
    expect(first.store.markDelivered).toHaveBeenCalledTimes(1);

    const recovered = harness({ state: "delivered" });
    recovered.setClaim({
      ...command,
      attempt: 2,
      claimToken: "00000000-0000-4000-8000-000000000004",
    });
    await expect(recovered.runner.runOnce()).resolves.toMatchObject({
      outcome: "delivered",
      deduplicated: true,
    });
    expect(recovered.transport.deliver).not.toHaveBeenCalled();
  });
});
