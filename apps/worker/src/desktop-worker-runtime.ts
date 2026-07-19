import type { AddressInfo } from "node:net";

const desktopWorkerEnvironmentKey = "SCHEDULE_DESKTOP_WORKER";
const desktopWorkerReadyPrefix = "SCHEDULE_DESKTOP_WORKER_READY_V1";
const maxShutdownCommandBytes = 64;
const desktopShutdownCommand = Buffer.from("shutdown");

export interface DesktopWorkerRuntimeProfile {
  readonly enabled: boolean;
}

export function resolveDesktopWorkerRuntimeProfile(
  environment: NodeJS.ProcessEnv,
): DesktopWorkerRuntimeProfile {
  const value = environment[desktopWorkerEnvironmentKey];
  if (value === undefined) return { enabled: false };
  if (value !== "1") {
    throw new Error("SCHEDULE_DESKTOP_WORKER must be exactly 1 when set.");
  }
  return { enabled: true };
}

/** Keeps the desktop-only dynamic listener override out of shared worker configuration. */
export function desktopWorkerConfigEnvironment(
  environment: NodeJS.ProcessEnv,
  profile: DesktopWorkerRuntimeProfile,
): NodeJS.ProcessEnv {
  if (!profile.enabled) return environment;
  return {
    ...environment,
    WORKER_OBSERVABILITY_MODE: "loopback",
    // The shared schema deliberately continues to reject port zero outside this profile.
    WORKER_OBSERVABILITY_PORT: undefined,
  };
}

export function clearDesktopWorkerEnvironment(environment: NodeJS.ProcessEnv): void {
  delete environment[desktopWorkerEnvironmentKey];
}

export function desktopWorkerReadyLine(address: AddressInfo | string | null): string {
  if (
    address === null ||
    typeof address === "string" ||
    !Number.isInteger(address.port) ||
    address.port < 1 ||
    address.port > 65_535
  ) {
    throw new Error("The desktop worker did not expose a valid TCP readiness address.");
  }
  return `${desktopWorkerReadyPrefix} ${JSON.stringify({ port: address.port })}\n`;
}

/**
 * Accepts one newline-framed, bounded supervisor command. EOF is a shutdown request: it prevents
 * a crashed supervisor from leaving a desktop worker orphaned. Invalid input is deliberately
 * discarded without logging it.
 */
export function watchDesktopWorkerShutdown(
  input: NodeJS.ReadableStream,
  controller: AbortController,
): void {
  let complete = false;
  let discardingLine = false;
  let line: number[] = [];
  const finish = (shutdown: boolean): void => {
    if (complete) return;
    complete = true;
    input.removeListener("data", onData);
    input.removeListener("end", onEnd);
    input.removeListener("error", onEnd);
    input.pause();
    if (shutdown && !controller.signal.aborted) controller.abort("desktop supervisor shutdown");
  };
  const onEnd = (): void => finish(true);
  const onData = (chunk: Buffer | string): void => {
    if (complete) return;
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    for (const byte of bytes) {
      if (byte === 0x0a) {
        if (!discardingLine) {
          if (line.at(-1) === 0x0d) line.pop();
          if (Buffer.from(line).equals(desktopShutdownCommand)) {
            finish(true);
            return;
          }
        }
        line = [];
        discardingLine = false;
        continue;
      }
      if (discardingLine) continue;
      if (line.length >= maxShutdownCommandBytes) {
        line = [];
        discardingLine = true;
        continue;
      }
      line.push(byte);
    }
  };

  input.on("data", onData);
  input.once("end", onEnd);
  input.once("error", onEnd);
  input.resume();
}
