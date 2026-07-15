export interface WorkerRuntimeOptions {
  readonly run: () => Promise<void>;
  readonly close: () => Promise<void>;
  readonly terminate?: (exitCode: number) => void;
}

export type WorkerService = (signal: AbortSignal) => Promise<void>;

const noServiceFailure = Symbol("no worker service failure");

function logAuxiliaryFailure(): void {
  console.error(
    JSON.stringify({
      level: "error",
      failureClass: "worker_auxiliary_service_error",
      message: "optional worker diagnostics stopped; primary processing continues",
    }),
  );
}

/** Runs optional diagnostics without granting them authority to stop primary processing. */
export async function runNonCriticalWorkerService(
  service: WorkerService,
  signal: AbortSignal,
): Promise<void> {
  try {
    await service(signal);
  } catch {
    // Failure details stay inside the optional service boundary.
  }
  if (!signal.aborted) logAuxiliaryFailure();
}

/**
 * Runs long-lived worker services as one lifecycle. A failure aborts every sibling, but the
 * database-owning runtime does not regain control until all in-flight services have settled.
 */
export async function runWorkerServices(
  services: readonly WorkerService[],
  controller: AbortController,
): Promise<void> {
  if (services.length === 0) throw new RangeError("At least one worker service is required.");

  let firstFailure: unknown | typeof noServiceFailure = noServiceFailure;
  await Promise.all(
    services.map(async (service) => {
      try {
        await service(controller.signal);
        if (!controller.signal.aborted) {
          throw new Error("worker service stopped unexpectedly");
        }
      } catch (error) {
        if (firstFailure === noServiceFailure) firstFailure = error;
        if (!controller.signal.aborted) controller.abort("worker service failed");
      }
    }),
  );

  if (firstFailure !== noServiceFailure) throw firstFailure;
}

function logFatal(failureClass: "worker_runtime_error" | "worker_shutdown_error"): void {
  console.error(
    JSON.stringify({
      level: "error",
      failureClass,
      message:
        failureClass === "worker_runtime_error"
          ? "worker stopped unexpectedly"
          : "worker database shutdown failed",
    }),
  );
}

export async function runWorkerRuntime(options: WorkerRuntimeOptions): Promise<void> {
  let failed = false;
  try {
    await options.run();
  } catch {
    failed = true;
    logFatal("worker_runtime_error");
  }

  try {
    await options.close();
  } catch {
    failed = true;
    logFatal("worker_shutdown_error");
  }

  if (failed) (options.terminate ?? process.exit)(1);
}
