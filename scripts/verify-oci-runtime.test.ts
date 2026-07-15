import { describe, expect, it } from "vitest";

import {
  parseContainerExitCode,
  parseMigrationCount,
  parsePublishedApiPort,
  runtimeSmokeProjectName,
} from "./verify-oci-runtime.js";

describe("OCI runtime smoke guards", () => {
  it("creates a unique bounded Compose project name", () => {
    expect(runtimeSmokeProjectName({}, 42, 1_000)).toBe("schedule-runtime-smoke-42-rs");
  });

  it("accepts only an explicitly scoped project override", () => {
    expect(
      runtimeSmokeProjectName({ OCI_RUNTIME_SMOKE_PROJECT: "schedule-runtime-smoke-ci_123" }),
    ).toBe("schedule-runtime-smoke-ci_123");
    expect(() => runtimeSmokeProjectName({ OCI_RUNTIME_SMOKE_PROJECT: "schedule" })).toThrow(
      "must start",
    );
    expect(() =>
      runtimeSmokeProjectName({ OCI_RUNTIME_SMOKE_PROJECT: "schedule-runtime-smoke-UPPER" }),
    ).toThrow("must start");
  });

  it("parses only loopback API port mappings", () => {
    expect(parsePublishedApiPort("127.0.0.1:49152\n")).toBe(49_152);
    expect(() => parsePublishedApiPort("0.0.0.0:49152")).toThrow("invalid API loopback");
    expect(() => parsePublishedApiPort("127.0.0.1:70000")).toThrow("invalid API loopback");
  });

  it("parses bounded canonical container exit codes", () => {
    expect(parseContainerExitCode("0\n")).toBe(0);
    expect(parseContainerExitCode("255")).toBe(255);
    expect(() => parseContainerExitCode("01")).toThrow("invalid container exit");
    expect(() => parseContainerExitCode("256")).toThrow("invalid container exit");
  });

  it("parses canonical migration ledger counts", () => {
    expect(parseMigrationCount("32\n")).toBe(32);
    expect(() => parseMigrationCount("0032")).toThrow("invalid migration count");
    expect(() => parseMigrationCount("many")).toThrow("invalid migration count");
  });
});
