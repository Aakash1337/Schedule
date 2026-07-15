import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { describe, expect, it, vi } from "vitest";

import type { HermesReminderRunResult } from "./delivery-runner.js";
import { runHermesReminderRuntime } from "./runtime.js";
import { ScheduleDeliveryGatewayError } from "./schedule-client.js";
import { HermesReminderSupervisor } from "./supervisor.js";

describe("Hermes reminder runtime", () => {
  it("runs polling and loopback health in one graceful shutdown domain", async () => {
    const shutdown = new AbortController();
    const runner = {
      runOnce: vi.fn(async (): Promise<HermesReminderRunResult> => ({ status: "idle" })),
    };
    const supervisor = new HermesReminderSupervisor(runner, {
      enabled: () => true,
      pollIntervalMilliseconds: 100,
    });
    let reportListening!: (address: AddressInfo) => void;
    const listening = new Promise<AddressInfo>((resolve) => {
      reportListening = resolve;
    });
    const runtime = runHermesReminderRuntime(
      { supervisor, healthPort: 0, onHealthListening: reportListening },
      shutdown.signal,
    );
    const address = await listening;
    const baseUrl = `http://${address.address}:${String(address.port)}`;
    await vi.waitFor(() => expect(supervisor.health().ready).toBe(true));
    expect((await fetch(`${baseUrl}/health/live`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/health/ready`)).status).toBe(200);

    shutdown.abort("test complete");
    await runtime;
    expect(supervisor.health().state).toBe("stopped");
    await expect(fetch(`${baseUrl}/health/live`)).rejects.toThrow();
  });

  it("closes health when the supervisor enters a sanitized fatal state", async () => {
    const runner = {
      runOnce: vi.fn(async () =>
        Promise.reject(new ScheduleDeliveryGatewayError("authentication_failed", false)),
      ),
    };
    const supervisor = new HermesReminderSupervisor(runner, { enabled: () => true });
    const failure = await runHermesReminderRuntime(
      { supervisor, healthPort: 0 },
      new AbortController().signal,
    ).catch((reason: unknown) => reason);

    expect(failure).toMatchObject({
      name: "HermesReminderSupervisorError",
      code: "fatal_dependency",
      failureClass: "schedule_authentication",
    });
    expect(supervisor.health()).toMatchObject({ state: "fatal", ready: false });
  });

  it("stops polling and sanitizes a health listener startup failure", async () => {
    const privateDetail = "private health bootstrap token";
    const runner = {
      runOnce: vi.fn(async (): Promise<HermesReminderRunResult> => ({ status: "idle" })),
    };
    const supervisor = new HermesReminderSupervisor(runner);
    const failure = await runHermesReminderRuntime(
      {
        supervisor,
        healthPort: 0,
        onHealthListening: () => {
          throw new Error(privateDetail);
        },
      },
      new AbortController().signal,
    ).catch((reason: unknown) => reason);

    expect(failure).toEqual(new Error("Hermes reminder health listener failed."));
    expect(String(failure)).not.toContain(privateDetail);
    expect(supervisor.health()).toMatchObject({ state: "starting", ready: false });
    expect(runner.runOnce).not.toHaveBeenCalled();
  });

  it("does not poll until health is listening and rejects a port collision", async () => {
    const occupied = createServer();
    await new Promise<void>((resolve, reject) => {
      occupied.once("error", reject);
      occupied.listen(0, "127.0.0.1", resolve);
    });
    const address = occupied.address();
    if (address === null || typeof address === "string") throw new Error("Expected TCP address.");
    const runner = {
      runOnce: vi.fn(async (): Promise<HermesReminderRunResult> => ({ status: "idle" })),
    };
    const supervisor = new HermesReminderSupervisor(runner, { enabled: () => true });

    try {
      await expect(
        runHermesReminderRuntime(
          { supervisor, healthPort: address.port },
          new AbortController().signal,
        ),
      ).rejects.toThrow("Hermes reminder health listener failed.");
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
    expect(runner.runOnce).not.toHaveBeenCalled();
    expect(supervisor.health()).toMatchObject({ state: "starting", ready: false });
  });
});
