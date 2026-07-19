import { describe, expect, it } from "vitest";

import {
  initialStartupState,
  isBusyStartupPhase,
  reduceStartupState,
  type StartupPhase,
} from "./startup-state.js";

describe("desktop startup state", () => {
  it.each<readonly [StartupPhase, string]>([
    ["preparing_database", "Preparing local database"],
    ["migrating", "Applying database updates"],
    ["starting_services", "Starting local services"],
    ["ready", "Schedule is ready"],
  ])("projects the %s phase without inventing progress", (phase, message) => {
    const state = reduceStartupState(initialStartupState, {
      type: "phase_changed",
      phase: phase as Exclude<
        StartupPhase,
        "recoverable_failure" | "incompatible_data" | "fatal_failure"
      >,
      message,
    });

    expect(state).toEqual({ phase, message, detail: null, attempt: 1 });
    expect(state).not.toHaveProperty("progress");
  });

  it("retains bounded diagnostics and increments only a recoverable retry", () => {
    const failed = reduceStartupState(initialStartupState, {
      type: "failed",
      message: "Schedule could not start",
      detail: "desktop.runtime_unavailable",
    });

    expect(failed).toMatchObject({
      phase: "recoverable_failure",
      detail: "desktop.runtime_unavailable",
      attempt: 1,
    });
    expect(reduceStartupState(failed, { type: "retry" })).toEqual({
      phase: "starting_services",
      message: "Checking the local runtime again",
      detail: null,
      attempt: 2,
    });
  });

  it("keeps incompatible data blocking and non-retryable", () => {
    const incompatible = reduceStartupState(initialStartupState, {
      type: "incompatible",
      message: "This data needs a newer version of Schedule",
      detail: "desktop.data_incompatible",
    });

    expect(reduceStartupState(incompatible, { type: "retry" })).toBe(incompatible);
  });

  it.each([
    ["preparing_database", true],
    ["migrating", true],
    ["starting_services", true],
    ["ready", false],
    ["recoverable_failure", false],
    ["incompatible_data", false],
  ] as const)("reports busy semantics for %s", (phase, expected) => {
    expect(isBusyStartupPhase(phase)).toBe(expected);
  });
});
