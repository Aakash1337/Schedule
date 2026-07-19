import { afterEach, describe, expect, it, vi } from "vitest";

import { loadRuntimeStatus, requestRuntimeRetry, runtimeStatusAction } from "./DesktopApp.js";

describe("desktop runtime gate", () => {
  afterEach(() => vi.useRealTimers());

  it("allows the shared application to mount only after a ready runtime", () => {
    expect(runtimeStatusAction({ phase: "ready", message: "Local API is ready" })).toEqual({
      type: "phase_changed",
      phase: "ready",
      message: "Local API is ready",
    });
  });

  it("keeps reported startup work and incompatible data in the native gate", () => {
    expect(runtimeStatusAction({ phase: "migrating", message: "Applying updates" })).toEqual({
      type: "phase_changed",
      phase: "migrating",
      message: "Applying updates",
    });
    expect(runtimeStatusAction({ phase: "incompatible_data", message: "Update Schedule" })).toEqual(
      {
        type: "incompatible",
        message: "Update Schedule",
        detail: "desktop.data_incompatible",
      },
    );
  });

  it("keeps an unavailable runtime behind a recoverable retry gate", async () => {
    await expect(
      loadRuntimeStatus(async () => Promise.reject(new Error("offline"))),
    ).resolves.toEqual({
      type: "failed",
      message: "Schedule could not inspect its local runtime",
      detail: "desktop.runtime_unavailable",
    });
  });

  it("turns a hung native inspection into a recoverable failure", async () => {
    vi.useFakeTimers();
    const action = loadRuntimeStatus(() => new Promise(() => undefined), 50);

    await vi.advanceTimersByTimeAsync(50);

    await expect(action).resolves.toEqual({
      type: "failed",
      message: "Schedule could not inspect its local runtime",
      detail: "desktop.runtime_unavailable",
    });
  });

  it("bounds a failed native retry without exposing its error", async () => {
    await expect(
      requestRuntimeRetry(async () => Promise.reject(new Error("offline"))),
    ).resolves.toBe(undefined);
  });
});
