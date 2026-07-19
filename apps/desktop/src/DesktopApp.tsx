import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import { App } from "../../web/src/App.js";
import {
  initialStartupState,
  isBusyStartupPhase,
  reduceStartupState,
  type StartupAction,
  type StartupPhase,
  type StartupState,
} from "./startup-state.js";

export interface RuntimeStatus {
  readonly phase: "foundation" | StartupPhase;
  readonly message: string;
}

export type RuntimeRetryResult = "accepted" | "busy" | "unavailable";

const runtimeStatusPollMs = 250;
const runtimeStatusTimeoutMs = 5_000;

export function runtimeStatusAction(status: RuntimeStatus): StartupAction {
  switch (status.phase) {
    case "ready":
    case "preparing_database":
    case "migrating":
    case "starting_services":
      return { type: "phase_changed", phase: status.phase, message: status.message };
    case "incompatible_data":
      return {
        type: "incompatible",
        message: status.message,
        detail: "desktop.data_incompatible",
      };
    case "recoverable_failure":
      return {
        type: "failed",
        message: status.message,
        detail: "desktop.runtime_unavailable",
      };
    case "fatal_failure":
      return {
        type: "fatal",
        message: status.message,
        detail: "desktop.runtime_initialization_failed",
      };
    case "foundation":
      return {
        type: "failed",
        message: status.message,
        detail: "desktop.runtime_not_installed",
      };
  }
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("desktop runtime command timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export async function loadRuntimeStatus(
  inspect: () => Promise<RuntimeStatus> = () => invoke<RuntimeStatus>("runtime_status"),
  timeoutMs = runtimeStatusTimeoutMs,
): Promise<StartupAction> {
  try {
    const status = await withTimeout(inspect(), timeoutMs);
    return runtimeStatusAction(status);
  } catch {
    return {
      type: "failed",
      message: "Schedule could not inspect its local runtime",
      detail: "desktop.runtime_unavailable",
    };
  }
}

export async function requestRuntimeRetry(
  retry: () => Promise<RuntimeRetryResult> = () => invoke<RuntimeRetryResult>("runtime_retry"),
  timeoutMs = runtimeStatusTimeoutMs,
): Promise<RuntimeRetryResult | undefined> {
  try {
    return await withTimeout(retry(), timeoutMs);
  } catch {
    return undefined;
  }
}

function StartupGate({
  state,
  onRetry,
}: {
  readonly state: StartupState;
  readonly onRetry: () => void;
}) {
  const busy = isBusyStartupPhase(state.phase);
  const blocking =
    state.phase === "recoverable_failure" ||
    state.phase === "incompatible_data" ||
    state.phase === "fatal_failure";

  return (
    <section className="startup-shell" aria-labelledby="startup-title">
      <div
        className={`startup-mark startup-mark--${blocking ? "error" : "loading"}`}
        data-state={blocking ? "error" : "loading"}
        aria-hidden="true"
      >
        <span>{blocking ? "!" : "…"}</span>
      </div>
      <p className="startup-kicker">Local-first planning</p>
      <h1 id="startup-title">Schedule</h1>
      <div className="startup-status" aria-busy={busy} role={blocking ? "alert" : "status"}>
        <p className="startup-message">{state.message}</p>
        {state.detail === null ? null : <code>{state.detail}</code>}
      </div>
      {state.phase === "recoverable_failure" ? (
        <button className="startup-action" type="button" onClick={onRetry}>
          Retry startup
        </button>
      ) : null}
    </section>
  );
}

export function DesktopApp() {
  const [state, setState] = useState<StartupState>(initialStartupState);
  const inspectedOnMount = useRef(false);
  const mounted = useRef(false);
  const pollTimer = useRef<number | null>(null);
  const inspectionEpoch = useRef(0);
  const inspectionInFlight = useRef(false);
  const retryInFlight = useRef(false);

  const inspectRuntime = useCallback(async function inspectRuntime() {
    if (inspectionInFlight.current) return;
    inspectionInFlight.current = true;
    const epoch = ++inspectionEpoch.current;
    try {
      const action = await loadRuntimeStatus();
      if (epoch !== inspectionEpoch.current || !mounted.current) return;
      setState((current) => reduceStartupState(current, action));

      if (action.type === "phase_changed" && isBusyStartupPhase(action.phase)) {
        pollTimer.current = window.setTimeout(() => void inspectRuntime(), runtimeStatusPollMs);
      }
    } finally {
      inspectionInFlight.current = false;
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    if (!inspectedOnMount.current) {
      inspectedOnMount.current = true;
      void inspectRuntime();
    }

    return () => {
      mounted.current = false;
      if (pollTimer.current !== null) window.clearTimeout(pollTimer.current);
    };
  }, [inspectRuntime]);

  const retry = useCallback(() => {
    if (retryInFlight.current || inspectionInFlight.current) return;
    retryInFlight.current = true;
    if (pollTimer.current !== null) window.clearTimeout(pollTimer.current);
    void requestRuntimeRetry()
      .then((result) => {
        if (!mounted.current) return;
        if (result === "accepted" || result === "busy") {
          setState((current) => reduceStartupState(current, { type: "retry" }));
        }
        void inspectRuntime();
      })
      .finally(() => {
        retryInFlight.current = false;
      });
  }, [inspectRuntime]);

  return state.phase === "ready" ? <App /> : <StartupGate state={state} onRetry={retry} />;
}
