import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import {
  App,
  type PortableExportResult,
  type PortableImportResult,
  type PortableImportSelectionResult,
} from "../../web/src/App.js";
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
  readonly generation: number;
  /** True only when the runtime has a verified automatic pre-update backup to restore. */
  readonly automaticBackupRecovery?: boolean;
}

export type RuntimeRetryResult =
  | { readonly result: "accepted" | "busy"; readonly generation: number }
  | { readonly result: "cancelled" | "unavailable" };

interface RuntimeInspection {
  readonly action: StartupAction;
  readonly generation: number | null;
  readonly automaticBackupRecovery?: boolean;
}

const runtimeStatusPollMs = 250;
const runtimeStatusTimeoutMs = 5_000;

export function requestPortableExport(): Promise<PortableExportResult> {
  return invoke<PortableExportResult>("portable_export");
}

export function requestAutomaticBackupRecovery(): Promise<RuntimeRetryResult> {
  return invoke<RuntimeRetryResult>("runtime_restore_automatic_backup");
}

export function requestPortableImportSelection(): Promise<PortableImportSelectionResult> {
  return invoke<PortableImportSelectionResult>("portable_import_select");
}

export function confirmPortableImport(token: string): Promise<PortableImportResult> {
  return invoke<PortableImportResult>("portable_import_confirm", { token });
}

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
        timeout = setTimeout(
          () => reject(new Error("desktop runtime command timed out")),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export async function loadRuntimeStatus(
  inspect: () => Promise<RuntimeStatus> = () => invoke<RuntimeStatus>("runtime_status"),
  timeoutMs = runtimeStatusTimeoutMs,
): Promise<RuntimeInspection> {
  try {
    const status = await withTimeout(inspect(), timeoutMs);
    const inspection: RuntimeInspection = {
      action: runtimeStatusAction(status),
      generation: status.generation,
    };
    return status.automaticBackupRecovery === true
      ? { ...inspection, automaticBackupRecovery: true }
      : inspection;
  } catch {
    return {
      action: {
        type: "failed",
        message: "Schedule could not inspect its local runtime",
        detail: "desktop.runtime_unavailable",
      },
      generation: null,
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
  automaticBackupRecoveryAvailable,
  automaticBackupRecoveryBusy,
  automaticBackupRecoveryError,
  onRestoreAutomaticBackup,
}: {
  readonly state: StartupState;
  readonly onRetry: () => void;
  readonly automaticBackupRecoveryAvailable: boolean;
  readonly automaticBackupRecoveryBusy: boolean;
  readonly automaticBackupRecoveryError: string | null;
  readonly onRestoreAutomaticBackup: () => void;
}) {
  const busy = isBusyStartupPhase(state.phase) || automaticBackupRecoveryBusy;
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
      {state.phase === "incompatible_data" && automaticBackupRecoveryAvailable ? (
        <button
          className="startup-action"
          type="button"
          onClick={onRestoreAutomaticBackup}
          disabled={automaticBackupRecoveryBusy}
        >
          Restore automatic backup
        </button>
      ) : null}
      {automaticBackupRecoveryBusy ? <p role="status">Restoring the automatic backup…</p> : null}
      {automaticBackupRecoveryError === null ? null : (
        <p className="startup-recovery-error" role="alert">
          {automaticBackupRecoveryError}
        </p>
      )}
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
  const retryGeneration = useRef<number | undefined>(undefined);
  const automaticBackupRecoveryInFlight = useRef(false);
  const automaticBackupRecoveryGeneration = useRef<number | undefined>(undefined);
  const [automaticBackupRecoveryAvailable, setAutomaticBackupRecoveryAvailable] = useState(false);
  const [automaticBackupRecoveryBusy, setAutomaticBackupRecoveryBusy] = useState(false);
  const [automaticBackupRecoveryError, setAutomaticBackupRecoveryError] = useState<string | null>(
    null,
  );

  const inspectRuntime = useCallback(async function inspectRuntime() {
    if (inspectionInFlight.current) return;
    inspectionInFlight.current = true;
    const epoch = ++inspectionEpoch.current;
    try {
      const inspection = await loadRuntimeStatus();
      if (epoch !== inspectionEpoch.current || !mounted.current) return;
      const retryBaseline = retryGeneration.current;
      const staleRetryFailure =
        retryBaseline !== undefined &&
        inspection.action.type === "failed" &&
        inspection.generation === retryBaseline;
      const recoveryBaseline = automaticBackupRecoveryGeneration.current;
      const staleAutomaticBackupRecovery =
        recoveryBaseline !== undefined &&
        inspection.action.type === "incompatible" &&
        inspection.automaticBackupRecovery === true &&
        inspection.generation === recoveryBaseline;
      if (!staleRetryFailure && !staleAutomaticBackupRecovery) {
        retryGeneration.current = undefined;
        automaticBackupRecoveryGeneration.current = undefined;
        setAutomaticBackupRecoveryBusy(false);
        setAutomaticBackupRecoveryAvailable(inspection.automaticBackupRecovery === true);
        if (
          inspection.action.type !== "incompatible" ||
          inspection.automaticBackupRecovery !== true
        ) {
          setAutomaticBackupRecoveryError(null);
        }
        setState((current) => reduceStartupState(current, inspection.action));
      }

      if (
        staleRetryFailure ||
        staleAutomaticBackupRecovery ||
        (inspection.action.type === "phase_changed" && isBusyStartupPhase(inspection.action.phase))
      ) {
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
        if (result?.result === "accepted" || result?.result === "busy") {
          retryGeneration.current = result.generation;
          setState((current) => reduceStartupState(current, { type: "retry" }));
        }
        void inspectRuntime();
      })
      .finally(() => {
        retryInFlight.current = false;
      });
  }, [inspectRuntime]);

  const restoreAutomaticBackup = useCallback(() => {
    if (automaticBackupRecoveryInFlight.current || inspectionInFlight.current) return;
    automaticBackupRecoveryInFlight.current = true;
    setAutomaticBackupRecoveryBusy(true);
    setAutomaticBackupRecoveryError(null);
    if (pollTimer.current !== null) window.clearTimeout(pollTimer.current);
    void requestAutomaticBackupRecovery()
      .then((result) => {
        if (!mounted.current) return;
        if (result?.result === "accepted" || result?.result === "busy") {
          automaticBackupRecoveryGeneration.current = result.generation;
          setAutomaticBackupRecoveryError(null);
        } else if (result?.result === "cancelled") {
          automaticBackupRecoveryGeneration.current = undefined;
          setAutomaticBackupRecoveryBusy(false);
        } else {
          automaticBackupRecoveryGeneration.current = undefined;
          setAutomaticBackupRecoveryBusy(false);
          setAutomaticBackupRecoveryError(
            result?.result === "unavailable"
              ? "Automatic recovery is no longer available. Reopen Schedule or restore a backup manually."
              : "Automatic recovery could not start. Reopen Schedule or restore a backup manually.",
          );
        }
        void inspectRuntime();
      })
      .finally(() => {
        automaticBackupRecoveryInFlight.current = false;
      });
  }, [inspectRuntime]);

  return state.phase === "ready" ? (
    <App
      desktopActions={{
        exportArchive: requestPortableExport,
        selectImportArchive: requestPortableImportSelection,
        confirmImportArchive: confirmPortableImport,
      }}
    />
  ) : (
    <StartupGate
      state={state}
      onRetry={retry}
      automaticBackupRecoveryAvailable={automaticBackupRecoveryAvailable}
      automaticBackupRecoveryBusy={automaticBackupRecoveryBusy}
      automaticBackupRecoveryError={automaticBackupRecoveryError}
      onRestoreAutomaticBackup={restoreAutomaticBackup}
    />
  );
}
