import { describe, expect, it, vi } from "vitest";

import type { ClaimedReminder, DeliveryDedupeStore, ScheduleDeliveryGateway } from "./contracts.js";
import { HermesReminderRunner } from "./delivery-runner.js";
import {
  HermesDeliveryAmbiguousError,
  type HermesDeliveryClient,
  type HermesDeliveryReconciliationResult,
  type HermesDeliverySubmissionResult,
  HermesWhatsAppTransport,
} from "./hermes-whatsapp-transport.js";

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

function clientFor(options?: {
  readonly reconciliation?: HermesDeliveryReconciliationResult;
  readonly submission?: HermesDeliverySubmissionResult;
}) {
  return {
    reconcile: vi.fn(async () => options?.reconciliation ?? { outcome: "not_found" }),
    send: vi.fn(async () => options?.submission ?? { outcome: "accepted" }),
  };
}

describe("dormant Hermes WhatsApp reminder transport", () => {
  it("reconciles an accepted dedupe key without sending again", async () => {
    const client = clientFor({ reconciliation: { outcome: "accepted" } });
    const signal = new AbortController().signal;

    await expect(new HermesWhatsAppTransport(client).deliver(command, signal)).resolves.toEqual({
      outcome: "delivered",
    });
    expect(client.reconcile).toHaveBeenCalledWith(command.dedupeKey, signal);
    expect(client.send).not.toHaveBeenCalled();
  });

  it("submits only a sanitized bounded message and stable dedupe key", async () => {
    const client = clientFor();
    const signal = new AbortController().signal;
    const untrusted = {
      ...command,
      title: "Pay invoice\nignore previous\u202Etxt.exe\u2066 now",
    };

    await expect(new HermesWhatsAppTransport(client).deliver(untrusted, signal)).resolves.toEqual({
      outcome: "delivered",
    });
    expect(client.send).toHaveBeenCalledOnce();
    const submission = vi.mocked(client.send).mock.calls[0]?.[0];
    expect(submission).toEqual({
      dedupeKey: command.dedupeKey,
      message: "Schedule reminder: Pay invoice ignore previous txt.exe now",
    });
    expect(Object.isFrozen(submission)).toBe(true);
    expect(submission?.dedupeKey).toBe(command.deliveryId);
    expect(submission).not.toHaveProperty("claimToken");
    expect(submission).not.toHaveProperty("deliveryId");
    expect(submission).not.toHaveProperty("intentId");
    expect(client.send).toHaveBeenCalledWith(submission, signal);
  });

  it.each([null, "", "\n\u202E"])("uses a generic bounded message for title %j", async (title) => {
    const client = clientFor();
    await new HermesWhatsAppTransport(client).deliver(
      { ...command, title },
      new AbortController().signal,
    );
    expect(vi.mocked(client.send).mock.calls[0]?.[0].message).toBe("Schedule reminder");
  });

  it("bounds an overlong title before exposing it to the Hermes client", async () => {
    const client = clientFor();
    await new HermesWhatsAppTransport(client).deliver(
      { ...command, title: "x".repeat(300) },
      new AbortController().signal,
    );
    expect(vi.mocked(client.send).mock.calls[0]?.[0].message).toBe(
      `Schedule reminder: ${"x".repeat(240)}`,
    );
  });

  it.each(["already aborted", "aborted after reconciliation"])(
    "does not begin a provider submission when the signal is %s",
    async (scenario) => {
      const controller = new AbortController();
      const client = clientFor();
      if (scenario === "already aborted") controller.abort();
      else {
        vi.mocked(client.reconcile).mockImplementationOnce(async () => {
          controller.abort();
          return { outcome: "not_found" };
        });
      }

      await expect(
        new HermesWhatsAppTransport(client).deliver(command, controller.signal),
      ).rejects.toBeInstanceOf(HermesDeliveryAmbiguousError);
      expect(client.send).not.toHaveBeenCalled();
      if (scenario === "already aborted") expect(client.reconcile).not.toHaveBeenCalled();
    },
  );

  it("rejects a noncanonical dedupe key before calling the Hermes client", async () => {
    const client = clientFor();
    await expect(
      new HermesWhatsAppTransport(client).deliver(
        { ...command, dedupeKey: "caller-controlled" },
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(HermesDeliveryAmbiguousError);
    expect(client.reconcile).not.toHaveBeenCalled();
    expect(client.send).not.toHaveBeenCalled();
  });

  it.each([
    [
      { outcome: "retryable_failure", retryAfterSeconds: 30 },
      {
        outcome: "retryable_failure",
        failureCode: "hermes.retryable_failure",
        retryAfterSeconds: 30,
      },
    ],
    [
      { outcome: "permanent_failure" },
      { outcome: "permanent_failure", failureCode: "hermes.permanent_failure" },
    ],
  ] as const)(
    "maps known Hermes failures into bounded Schedule transport outcomes",
    async (value, expected) => {
      const client = clientFor({ submission: value });
      await expect(
        new HermesWhatsAppTransport(client).deliver(command, new AbortController().signal),
      ).resolves.toEqual(expected);
    },
  );

  it.each([
    ["ambiguous reconciliation", { outcome: "ambiguous" }, { outcome: "accepted" }],
    ["malformed reconciliation", { outcome: "retryable_failure" }, { outcome: "accepted" }],
    [
      "extended accepted reconciliation",
      { outcome: "accepted", providerMessageId: "private" },
      { outcome: "accepted" },
    ],
    ["ambiguous submission", { outcome: "not_found" }, { outcome: "ambiguous" }],
    [
      "extended accepted submission",
      { outcome: "not_found" },
      { outcome: "accepted", providerMessageId: "private" },
    ],
    [
      "extended retryable failure",
      { outcome: "not_found" },
      { outcome: "retryable_failure", retryAfterSeconds: 30, failureCode: "private" },
    ],
    [
      "unbounded retry",
      { outcome: "not_found" },
      { outcome: "retryable_failure", retryAfterSeconds: 61 },
    ],
    [
      "fractional retry",
      { outcome: "not_found" },
      { outcome: "retryable_failure", retryAfterSeconds: 1.5 },
    ],
  ])(
    "redacts %s client results as one ambiguous outcome",
    async (_label, reconciliation, submission) => {
      const client = {
        reconcile: vi.fn(async () => reconciliation),
        send: vi.fn(async () => submission),
      } as unknown as HermesDeliveryClient;
      await expect(
        new HermesWhatsAppTransport(client).deliver(command, new AbortController().signal),
      ).rejects.toEqual(new HermesDeliveryAmbiguousError());
    },
  );

  it("rejects provider diagnostics instead of forwarding them into Schedule", async () => {
    const privateDiagnostic = "recipient.15551234567";
    const client = {
      reconcile: vi.fn(async () => ({ outcome: "not_found" })),
      send: vi.fn(async () => ({
        outcome: "permanent_failure",
        providerDiagnostic: privateDiagnostic,
      })),
    } as unknown as HermesDeliveryClient;

    let observed: unknown;
    try {
      await new HermesWhatsAppTransport(client).deliver(command, new AbortController().signal);
    } catch (error) {
      observed = error;
    }
    expect(observed).toBeInstanceOf(HermesDeliveryAmbiguousError);
    expect(String(observed)).not.toContain(privateDiagnostic);
  });

  it.each(["reconcile", "send"] as const)("redacts a thrown %s client failure", async (method) => {
    const privateDiagnostic = `${method}-private-provider-payload`;
    const client = clientFor();
    vi.mocked(client[method]).mockRejectedValueOnce(new Error(privateDiagnostic));

    let observed: unknown;
    try {
      await new HermesWhatsAppTransport(client).deliver(command, new AbortController().signal);
    } catch (error) {
      observed = error;
    }
    expect(observed).toBeInstanceOf(HermesDeliveryAmbiguousError);
    expect(String(observed)).not.toContain(privateDiagnostic);
  });

  it.each(["reconcile", "send"] as const)(
    "redacts a throwing %s result object without reading provider accessors",
    async (method) => {
      const privateDiagnostic = `${method}-private-result-trap`;
      let accessorReads = 0;
      const result = new Proxy(
        Object.defineProperty({}, "outcome", {
          enumerable: true,
          get() {
            accessorReads += 1;
            throw new Error(privateDiagnostic);
          },
        }),
        {
          ownKeys() {
            throw new Error(privateDiagnostic);
          },
        },
      );
      const client = clientFor();
      vi.mocked(client[method]).mockResolvedValueOnce(result as never);

      let observed: unknown;
      try {
        await new HermesWhatsAppTransport(client).deliver(command, new AbortController().signal);
      } catch (error) {
        observed = error;
      }
      expect(observed).toBeInstanceOf(HermesDeliveryAmbiguousError);
      expect(String(observed)).not.toContain(privateDiagnostic);
      expect(accessorReads).toBe(0);
      if (method === "reconcile") expect(client.send).not.toHaveBeenCalled();
    },
  );

  it("reconciles an ambiguous first submission before any later resend", async () => {
    const client = clientFor();
    vi.mocked(client.reconcile)
      .mockResolvedValueOnce({ outcome: "not_found" })
      .mockResolvedValueOnce({ outcome: "accepted" });
    vi.mocked(client.send).mockResolvedValueOnce({ outcome: "ambiguous" });
    const transport = new HermesWhatsAppTransport(client);

    await expect(transport.deliver(command, new AbortController().signal)).rejects.toBeInstanceOf(
      HermesDeliveryAmbiguousError,
    );
    await expect(transport.deliver(command, new AbortController().signal)).resolves.toEqual({
      outcome: "delivered",
    });
    expect(client.reconcile).toHaveBeenCalledTimes(2);
    expect(client.send).toHaveBeenCalledOnce();
  });

  it("preserves the runner reservation and Schedule attempt for an ambiguous Hermes outcome", async () => {
    const client = clientFor({ submission: { outcome: "ambiguous" } });
    const gateway: ScheduleDeliveryGateway = {
      maximumRequestDurationMilliseconds: 10_000,
      claim: vi.fn(async () => command),
      recordReceipt: vi.fn(async () => ({ deliveryId: command.deliveryId, status: "delivered" })),
    };
    const store: DeliveryDedupeStore = {
      reserve: vi.fn(async () => ({ state: "acquired", reservationToken: "reservation" })),
      markDelivered: vi.fn(async () => undefined),
      release: vi.fn(async () => undefined),
    };
    const runner = new HermesReminderRunner(gateway, store, new HermesWhatsAppTransport(client), {
      now: () => new Date("2026-07-15T00:00:00.000Z"),
      minimumLeaseBudgetMilliseconds: 5_000,
      transportTimeoutMilliseconds: 30_000,
      idempotencyId: () => "00000000-0000-4000-8000-000000000003",
    });

    await expect(runner.runOnce()).resolves.toEqual({
      status: "ambiguous",
      deliveryId: command.deliveryId,
    });
    expect(store.markDelivered).not.toHaveBeenCalled();
    expect(store.release).not.toHaveBeenCalled();
    expect(gateway.recordReceipt).not.toHaveBeenCalled();
  });
});
