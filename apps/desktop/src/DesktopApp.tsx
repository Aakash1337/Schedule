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
    case "foundation":
      return {
        type: "failed",
        message: status.message,
        detail: "desktop.runtime_not_installed",
      };
  }
}

export async function loadRuntimeStatus(
  inspect: () => Promise<RuntimeStatus> = () => invoke<RuntimeStatus>("runtime_status"),
  timeoutMs = runtimeStatusTimeoutMs,
): Promise<StartupAction> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const status = await Promise.race([
      inspect(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("runtime_status timed out")), timeoutMs);
      }),
    ]);
    return runtimeStatusAction(status);
  } catch {
    return {
      type: "failed",
      message: "Schedule could not inspect its local runtime",
      detail: "desktop.runtime_unavailable",
    };
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
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
  const blocking = state.phase === "recoverable_failure" || state.phase === "incompatible_data";

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
    if (inspectionInFlight.current) return;
    if (pollTimer.current !== null) window.clearTimeout(pollTimer.current);
    setState((current) => reduceStartupState(current, { type: "retry" }));
    void inspectRuntime();
  }, [inspectRuntime]);

  return state.phase === "ready" ? <App /> : <StartupGate state={state} onRetry={retry} />;
}
