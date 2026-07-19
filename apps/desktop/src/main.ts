import { invoke } from "@tauri-apps/api/core";

import "./styles.css";
import {
  initialStartupState,
  isBusyStartupPhase,
  reduceStartupState,
  type StartupState,
} from "./startup-state.js";

interface RuntimeStatus {
  readonly phase: "foundation" | "ready";
  readonly message: string;
}

const rootElement = document.querySelector<HTMLElement>("#app");
if (rootElement === null) throw new Error("The desktop application root is missing.");
const root = rootElement;

let state = initialStartupState;

function render(next: StartupState): void {
  state = next;
  const busy = isBusyStartupPhase(state.phase);
  const blocking = state.phase === "recoverable_failure" || state.phase === "incompatible_data";
  root.innerHTML = `
    <section class="startup-shell" aria-labelledby="startup-title">
      <div class="startup-mark" aria-hidden="true">
        <span></span>
      </div>
      <p class="startup-kicker">Local-first planning</p>
      <h1 id="startup-title">Schedule</h1>
      <div class="startup-status">
        <p class="startup-message"></p>
      </div>
    </section>
  `;

  const status = root.querySelector<HTMLElement>(".startup-status");
  const message = root.querySelector<HTMLElement>(".startup-message");
  if (status === null || message === null) throw new Error("The startup view is incomplete.");

  status.setAttribute("aria-busy", String(busy));
  status.setAttribute("role", blocking ? "alert" : "status");
  if (!blocking) status.setAttribute("aria-live", "polite");
  message.textContent = state.message;

  if (state.detail !== null) {
    const detail = document.createElement("code");
    detail.textContent = state.detail;
    status.append(detail);
  }

  if (state.phase === "recoverable_failure") {
    const retry = document.createElement("button");
    retry.className = "startup-action";
    retry.type = "button";
    retry.dataset.retry = "";
    retry.textContent = "Retry startup";
    retry.addEventListener("click", () => {
      render(reduceStartupState(state, { type: "retry" }));
      void loadRuntime();
    });
    root.querySelector(".startup-shell")?.append(retry);
  }
}

async function loadRuntime(): Promise<void> {
  try {
    const status = await invoke<RuntimeStatus>("runtime_status");
    if (status.phase === "ready") {
      render(
        reduceStartupState(state, {
          type: "phase_changed",
          phase: "ready",
          message: status.message,
        }),
      );
      return;
    }
    render(
      reduceStartupState(state, {
        type: "failed",
        message: status.message,
        detail: "desktop.runtime_not_installed",
      }),
    );
  } catch {
    render(
      reduceStartupState(state, {
        type: "failed",
        message: "Schedule could not inspect its local runtime",
        detail: "desktop.runtime_unavailable",
      }),
    );
  }
}

render(state);
void loadRuntime();
