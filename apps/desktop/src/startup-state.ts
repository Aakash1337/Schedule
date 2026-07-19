export type StartupPhase =
  | "preparing_database"
  | "migrating"
  | "starting_services"
  | "ready"
  | "recoverable_failure"
  | "incompatible_data"
  | "fatal_failure";

export interface StartupState {
  readonly phase: StartupPhase;
  readonly message: string;
  readonly detail: string | null;
  readonly attempt: number;
}

export type StartupAction =
  | {
      readonly type: "phase_changed";
      readonly phase: Exclude<StartupPhase, "recoverable_failure" | "incompatible_data" | "fatal_failure">;
      readonly message: string;
    }
  | { readonly type: "failed"; readonly message: string; readonly detail?: string }
  | { readonly type: "incompatible"; readonly message: string; readonly detail?: string }
  | { readonly type: "fatal"; readonly message: string; readonly detail?: string }
  | { readonly type: "retry" };

export const initialStartupState: StartupState = Object.freeze({
  phase: "starting_services",
  message: "Starting Schedule",
  detail: null,
  attempt: 1,
});

export function reduceStartupState(state: StartupState, action: StartupAction): StartupState {
  switch (action.type) {
    case "phase_changed":
      return {
        phase: action.phase,
        message: action.message,
        detail: null,
        attempt: state.attempt,
      };
    case "failed":
      return {
        phase: "recoverable_failure",
        message: action.message,
        detail: action.detail ?? null,
        attempt: state.attempt,
      };
    case "incompatible":
      return {
        phase: "incompatible_data",
        message: action.message,
        detail: action.detail ?? null,
        attempt: state.attempt,
      };
    case "fatal":
      return {
        phase: "fatal_failure",
        message: action.message,
        detail: action.detail ?? null,
        attempt: state.attempt,
      };
    case "retry":
      if (state.phase !== "recoverable_failure") return state;
      return {
        phase: "starting_services",
        message: "Checking the local runtime again",
        detail: null,
        attempt: state.attempt + 1,
      };
  }
}

export function isBusyStartupPhase(phase: StartupPhase): boolean {
  return phase === "preparing_database" || phase === "migrating" || phase === "starting_services";
}
