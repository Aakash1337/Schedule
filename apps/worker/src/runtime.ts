export interface WorkerRuntimeOptions {
  readonly run: () => Promise<void>;
  readonly close: () => Promise<void>;
  readonly terminate?: (exitCode: number) => void;
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
