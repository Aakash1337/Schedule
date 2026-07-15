import type { AddressInfo } from "node:net";

import {
  runHermesReminderHealthServer,
  type RunHermesReminderHealthServerOptions,
} from "./health-server.js";
import type { HermesReminderSupervisor } from "./supervisor.js";

export interface RunHermesReminderRuntimeOptions {
  readonly supervisor: HermesReminderSupervisor;
  readonly healthPort: number;
  readonly healthHost?: RunHermesReminderHealthServerOptions["host"];
  readonly onHealthListening?: (address: AddressInfo) => void;
}

/** Keeps polling and health supervision in one shutdown domain. */
export async function runHermesReminderRuntime(
  options: RunHermesReminderRuntimeOptions,
  signal: AbortSignal,
): Promise<void> {
  const runtimeController = new AbortController();
  const forwardAbort = (): void => runtimeController.abort(signal.reason);
  signal.addEventListener("abort", forwardAbort, { once: true });
  if (signal.aborted) forwardAbort();

  let reportListening!: () => void;
  const listening = new Promise<void>((resolve) => {
    reportListening = resolve;
  });
  let healthListening = false;
  const health = runHermesReminderHealthServer(
    {
      provider: options.supervisor,
      port: options.healthPort,
      ...(options.healthHost === undefined ? {} : { host: options.healthHost }),
      onListening: (address) => {
        options.onHealthListening?.(address);
        healthListening = true;
        reportListening();
      },
    },
    runtimeController.signal,
  );
  let supervisor: Promise<void> | undefined;
  let cleanupFailed = false;
  let cleanupFailure: unknown;

  try {
    await Promise.race([listening, health]);
    if (!healthListening || runtimeController.signal.aborted) {
      await health;
    } else {
      supervisor = options.supervisor.run(runtimeController.signal);
      await Promise.race([supervisor, health]);
    }
  } finally {
    runtimeController.abort("Hermes reminder runtime stopping");
    const settlements = await Promise.allSettled(
      supervisor === undefined ? [health] : [supervisor, health],
    );
    signal.removeEventListener("abort", forwardAbort);
    const rejected = settlements.find(
      (settlement): settlement is PromiseRejectedResult => settlement.status === "rejected",
    );
    if (rejected !== undefined) {
      cleanupFailed = true;
      cleanupFailure = rejected.reason;
    }
  }
  if (cleanupFailed) throw cleanupFailure;
}
