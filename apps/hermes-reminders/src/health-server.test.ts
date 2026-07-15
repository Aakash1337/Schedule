import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  runHermesReminderHealthServer,
  type HermesReminderHealthProvider,
} from "./health-server.js";
import type { HermesReminderSupervisorHealth } from "./supervisor.js";

const stoppedHealth: HermesReminderSupervisorHealth = {
  live: true,
  ready: false,
  state: "stopped",
  consecutiveFailures: 0,
  lastCycleStatus: null,
  lastFailureClass: null,
  lastFailureAt: null,
  lastSuccessfulPollAt: null,
};

async function start(
  provider: HermesReminderHealthProvider,
  host: "127.0.0.1" | "::1" = "127.0.0.1",
) {
  const controller = new AbortController();
  let reportListening!: (address: AddressInfo) => void;
  const listening = new Promise<AddressInfo>((resolve) => {
    reportListening = resolve;
  });
  const stopped = runHermesReminderHealthServer(
    { provider, host, port: 0, onListening: reportListening },
    controller.signal,
  );
  const address = await Promise.race([
    listening,
    stopped.then(() => Promise.reject(new Error("Health server stopped before listening."))),
  ]);
  const literalHost = address.family === "IPv6" ? `[${address.address}]` : address.address;
  return { controller, stopped, baseUrl: `http://${literalHost}:${String(address.port)}` };
}

describe("Hermes reminder health server", () => {
  const running: Array<{ controller: AbortController; stopped: Promise<void> }> = [];

  afterEach(async () => {
    for (const server of running) server.controller.abort("test cleanup");
    await Promise.allSettled(running.map((server) => server.stopped));
    running.length = 0;
  });

  it("binds to loopback and serves fixed live, ready, method, and missing responses", async () => {
    let health = stoppedHealth;
    const provider = { health: vi.fn(() => health) };
    const server = await start(provider);
    running.push(server);

    const live = await fetch(`${server.baseUrl}/health/live`);
    expect(live.status).toBe(200);
    expect(await live.json()).toEqual({ status: "alive" });
    expect(live.headers.get("cache-control")).toBe("no-store");
    expect(live.headers.get("x-content-type-options")).toBe("nosniff");
    expect(live.headers.has("access-control-allow-origin")).toBe(false);

    const unavailable = await fetch(`${server.baseUrl}/health/ready`);
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ status: "not_ready" });
    health = { ...stoppedHealth, ready: true, state: "running" };
    const ready = await fetch(`${server.baseUrl}/health/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: "ready" });

    const method = await fetch(`${server.baseUrl}/health/live`, { method: "POST" });
    expect(method.status).toBe(405);
    expect(method.headers.get("allow")).toBe("GET");
    expect(await method.json()).toEqual({ status: "method_not_allowed" });
    const missing = await fetch(`${server.baseUrl}/private`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ status: "not_found" });
  });

  it("keeps liveness available and sanitizes a failing readiness provider", async () => {
    const privateDetail = "provider token and private phone";
    const server = await start({
      health: () => {
        throw new Error(privateDetail);
      },
    });
    running.push(server);

    expect((await fetch(`${server.baseUrl}/health/live`)).status).toBe(200);
    const ready = await fetch(`${server.baseUrl}/health/ready`);
    expect(ready.status).toBe(503);
    expect(await ready.text()).not.toContain(privateDetail);
  });

  it("does not listen after shutdown and rejects invalid ports", async () => {
    const controller = new AbortController();
    controller.abort("already stopped");
    const onListening = vi.fn();
    await runHermesReminderHealthServer(
      { provider: { health: () => stoppedHealth }, port: 0, onListening },
      controller.signal,
    );
    expect(onListening).not.toHaveBeenCalled();
    await expect(
      runHermesReminderHealthServer(
        { provider: { health: () => stoppedHealth }, port: 65_536 },
        new AbortController().signal,
      ),
    ).rejects.toThrow("between 0 and 65535");
  });

  it("stops cleanly when shutdown races listener startup", async () => {
    const controller = new AbortController();
    const onListening = vi.fn();
    const stopped = runHermesReminderHealthServer(
      { provider: { health: () => stoppedHealth }, port: 0, onListening },
      controller.signal,
    );
    controller.abort("startup cancelled");

    await expect(stopped).resolves.toBeUndefined();
    expect(onListening).not.toHaveBeenCalled();
  });

  it("fails safely on a port collision", async () => {
    const occupied = createServer();
    await new Promise<void>((resolve, reject) => {
      occupied.once("error", reject);
      occupied.listen(0, "127.0.0.1", resolve);
    });
    const address = occupied.address();
    if (address === null || typeof address === "string") throw new Error("Expected TCP address.");

    try {
      await expect(
        runHermesReminderHealthServer(
          { provider: { health: () => stoppedHealth }, port: address.port },
          new AbortController().signal,
        ),
      ).rejects.toThrow("Hermes reminder health listener failed.");
    } finally {
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
  });

  it("does not expose server lifecycle control and sanitizes listening callback failures", async () => {
    const privateDetail = "private callback token";
    const onListening = vi.fn(() => {
      throw new Error(privateDetail);
    });
    const failure = await runHermesReminderHealthServer(
      { provider: { health: () => stoppedHealth }, port: 0, onListening },
      new AbortController().signal,
    ).catch((reason: unknown) => reason);

    expect(failure).toEqual(new Error("Hermes reminder health listener failed."));
    expect(String(failure)).not.toContain(privateDetail);
    expect(onListening).toHaveBeenCalledTimes(1);
    expect(onListening.mock.calls[0]).toHaveLength(1);
  });
});
