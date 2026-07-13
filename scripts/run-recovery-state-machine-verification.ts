import path from "node:path";
import { fileURLToPath } from "node:url";

import { disposableRecoveryVerificationSentinel } from "./restore-database.js";

export const recoveryVerificationSentinelVariable = "SCHEDULE_RECOVERY_STATE_MACHINE_SENTINEL";

export function prepareRecoveryVerificationEnvironment(env: NodeJS.ProcessEnv): void {
  if (env.NODE_ENV !== undefined && env.NODE_ENV !== "test") {
    throw new Error(
      `Refusing recovery verification with conflicting NODE_ENV=${JSON.stringify(env.NODE_ENV)}.`,
    );
  }
  const configuredSentinel = env[recoveryVerificationSentinelVariable];
  if (
    configuredSentinel !== undefined &&
    configuredSentinel !== disposableRecoveryVerificationSentinel
  ) {
    throw new Error("Refusing recovery verification with a conflicting recovery sentinel.");
  }

  env.NODE_ENV = "test";
  env[recoveryVerificationSentinelVariable] = disposableRecoveryVerificationSentinel;
}

/* v8 ignore start -- the subprocess-style entry point is covered by the integration verifier. */
if (
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  prepareRecoveryVerificationEnvironment(process.env);
  await import("./verify-recovery-state-machine.js");
}
/* v8 ignore stop */
