import { describe, expect, it } from "vitest";

import { disposableRecoveryVerificationSentinel } from "./restore-database.js";
import {
  prepareRecoveryVerificationEnvironment,
  recoveryVerificationSentinelVariable,
} from "./run-recovery-state-machine-verification.js";

describe("recovery state-machine verification launcher", () => {
  it("establishes both guards in an unconfigured environment", () => {
    const env: NodeJS.ProcessEnv = {};

    prepareRecoveryVerificationEnvironment(env);

    expect(env.NODE_ENV).toBe("test");
    expect(env[recoveryVerificationSentinelVariable]).toBe(disposableRecoveryVerificationSentinel);
  });

  it("preserves matching guards", () => {
    const env: NodeJS.ProcessEnv = {
      NODE_ENV: "test",
      [recoveryVerificationSentinelVariable]: disposableRecoveryVerificationSentinel,
    };

    expect(() => prepareRecoveryVerificationEnvironment(env)).not.toThrow();
  });

  it("refuses conflicting environment and sentinel values", () => {
    expect(() => prepareRecoveryVerificationEnvironment({ NODE_ENV: "production" })).toThrow(
      /conflicting NODE_ENV/,
    );
    expect(() =>
      prepareRecoveryVerificationEnvironment({
        [recoveryVerificationSentinelVariable]: "wrong",
      }),
    ).toThrow(/conflicting recovery sentinel/);
  });
});
