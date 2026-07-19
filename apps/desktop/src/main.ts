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
      <div class="startup-status" ${blocking ? 'role="alert"' : 'role="status" aria-live="polite"'} aria-busy="${String(busy)}">
        <p class="startup-message">${escapeHtml(state.message)}</p>
        ${state.detail === null ? "" : `<code>${escapeHtml(state.detail)}</code>`}
      </div>
      ${
        state.phase === "recoverable_failure"
          ? '<button class="startup-action" type="button" data-retry>Retry startup</button>'
          : ""
      }
    </section>
  `;
  root.querySelector<HTMLButtonElement>("[data-retry]")?.addEventListener("click", () => {
    render(reduceStartupState(state, { type: "retry" }));
    void loadRuntime();
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/gu, (character) => {
    const entities: Readonly<Record<string, string>> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "'": "&#39;",
      '"': "&quot;",
    };
    return entities[character] ?? character;
  });
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
