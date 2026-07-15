import { describe, expect, it } from "vitest";

import {
  parseContainerExitCode,
  parseMigrationCount,
  parsePublishedApiPort,
  parseRuntimeSecurityProbe,
  runtimeSmokeProjectName,
  runtimeSecurityProbeArguments,
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

  it("builds isolated run and exec security probes", () => {
    const compose = ["compose", "--project-name", "schedule-runtime-smoke-test"];
    const migrationProbe = runtimeSecurityProbeArguments(compose, "migrate");
    const apiProbe = runtimeSecurityProbeArguments(compose, "api");

    expect(migrationProbe.slice(0, -1)).toEqual([
      ...compose,
      "run",
      "--rm",
      "--no-deps",
      "migrate",
      "node",
      "-e",
    ]);
    expect(apiProbe.slice(0, -1)).toEqual([...compose, "exec", "--no-TTY", "api", "node", "-e"]);
    expect(migrationProbe.at(-1)).toContain("/proc/self/status");
    expect(apiProbe.at(-1)).toContain("/proc/self/mountinfo");
    expect(apiProbe.at(-1)).toContain("CapBnd");
  });

  it("accepts only a complete bounded runtime security probe", () => {
    const valid = {
      uid: 10_001,
      gid: 10_001,
      rootFilesystemReadOnly: true,
      noNewPrivileges: true,
      capabilityMasks: {
        ambient: "0000000000000000",
        bounding: "0000000000000000",
        effective: "0000000000000000",
        inheritable: "0000000000000000",
        permitted: "0000000000000000",
      },
    };

    expect(parseRuntimeSecurityProbe(JSON.stringify(valid))).toEqual(valid);
    expect(() => parseRuntimeSecurityProbe("not-json")).toThrow("invalid runtime security probe");
    expect(() =>
      parseRuntimeSecurityProbe(
        JSON.stringify({
          ...valid,
          capabilityMasks: { ...valid.capabilityMasks, bounding: "0" },
        }),
      ),
    ).toThrow("invalid runtime security probe");
    expect(() => parseRuntimeSecurityProbe(JSON.stringify({ ...valid, extra: true }))).toThrow(
      "invalid runtime security probe",
    );
  });
});
