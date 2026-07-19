import { PassThrough } from "node:stream";
import { once } from "node:events";

import { describe, expect, it } from "vitest";

import {
  clearDesktopWorkerEnvironment,
  desktopWorkerConfigEnvironment,
  desktopWorkerReadyLine,
  resolveDesktopWorkerRuntimeProfile,
  watchDesktopWorkerShutdown,
} from "./desktop-worker-runtime.js";

describe("desktop worker runtime", () => {
  it("keeps the dynamic observability override local to the explicit desktop profile", () => {
    const environment = { SCHEDULE_DESKTOP_WORKER: "1", WORKER_OBSERVABILITY_PORT: "0" };
    const profile = resolveDesktopWorkerRuntimeProfile(environment);
    expect(desktopWorkerConfigEnvironment(environment, profile)).toMatchObject({
      WORKER_OBSERVABILITY_MODE: "loopback",
      WORKER_OBSERVABILITY_PORT: undefined,
    });
    clearDesktopWorkerEnvironment(environment);
    expect(environment).toEqual({ WORKER_OBSERVABILITY_PORT: "0" });
  });

  it("rejects accidental desktop-profile activation values", () => {
    expect(() => resolveDesktopWorkerRuntimeProfile({ SCHEDULE_DESKTOP_WORKER: "true" })).toThrow(
      "must be exactly 1",
    );
  });

  it("emits only the versioned dynamic-port readiness record", () => {
    expect(desktopWorkerReadyLine({ address: "127.0.0.1", family: "IPv4", port: 49_321 })).toBe(
      'SCHEDULE_DESKTOP_WORKER_READY_V1 {"port":49321}\n',
    );
    expect(() => desktopWorkerReadyLine({ address: "127.0.0.1", family: "IPv4", port: 0 })).toThrow(
      "valid TCP readiness address",
    );
  });

  it("accepts exactly one bounded shutdown command and treats EOF as shutdown", async () => {
    const commandInput = new PassThrough();
    const commandController = new AbortController();
    watchDesktopWorkerShutdown(commandInput, commandController);
    commandInput.end("shutdown\nignored");
    expect(commandController.signal.aborted).toBe(true);

    const eofInput = new PassThrough();
    const eofController = new AbortController();
    watchDesktopWorkerShutdown(eofInput, eofController);
    eofInput.end();
    await once(eofInput, "end");
    expect(eofController.signal.aborted).toBe(true);
  });

  it("ignores malformed or oversized lines without disabling later shutdown", () => {
    for (const input of ["stop\n", `${"x".repeat(65)}\n`]) {
      const stream = new PassThrough();
      const controller = new AbortController();
      watchDesktopWorkerShutdown(stream, controller);
      stream.write(input);
      expect(controller.signal.aborted).toBe(false);
      stream.write("shutdown\n");
      expect(controller.signal.aborted).toBe(true);
    }
  });
});
