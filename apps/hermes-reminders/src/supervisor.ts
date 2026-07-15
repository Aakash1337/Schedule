import type { HermesReminderRunResult, HermesReminderRunner } from "./delivery-runner.js";
import { PostgresDeliveryDedupeStoreError } from "./postgres-dedupe-store.js";
import { ScheduleDeliveryGatewayError } from "./schedule-client.js";

const DEFAULT_POLL_INTERVAL_MILLISECONDS = 5_000;
const DEFAULT_RETRY_BASE_MILLISECONDS = 1_000;
const DEFAULT_RETRY_CAP_MILLISECONDS = 64_000;
const DEFAULT_MAXIMUM_CONSECUTIVE_FAILURES = 6;

export type HermesReminderSupervisorState =
  "starting" | "running" | "backing_off" | "disabled" | "stopping" | "stopped" | "fatal";

export type HermesReminderSupervisorFailureClass =
  | "schedule_authentication"
  | "schedule_conflict"
  | "schedule_rate_limited"
  | "schedule_unavailable"
  | "schedule_invalid_response"
  | "dedupe_timeout"
  | "dedupe_fenced"
  | "dedupe_invalid"
  | "dedupe_inconsistent"
  | "dedupe_schema"
  | "unexpected";

export interface HermesReminderSupervisorFailureDisposition {
  readonly failureClass: HermesReminderSupervisorFailureClass;
  readonly retryable: boolean;
}

export interface HermesReminderSupervisorHealth {
  readonly live: true;
  readonly ready: boolean;
  readonly state: HermesReminderSupervisorState;
  readonly consecutiveFailures: number;
  readonly lastCycleStatus: HermesReminderRunResult["status"] | null;
  readonly lastFailureClass: HermesReminderSupervisorFailureClass | null;
  readonly lastFailureAt: string | null;
  readonly lastSuccessfulPollAt: string | null;
}

export interface HermesReminderSupervisorOptions {
  readonly pollIntervalMilliseconds?: number;
  readonly retryBaseMilliseconds?: number;
  readonly retryCapMilliseconds?: number;
  readonly maximumConsecutiveFailures?: number;
  /** Evaluated before every claim. When omitted, polling stays disabled. */
  readonly enabled?: () => boolean;
  readonly random?: () => number;
  readonly now?: () => Date;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly classifyFailure?: (error: unknown) => HermesReminderSupervisorFailureDisposition;
}

export type HermesReminderSupervisorErrorCode =
  | "already_running"
  | "control_failure"
  | "fatal_dependency"
  | "failure_budget_exhausted"
  | "sleep_failure";

/** A fixed, safe process-level failure. Raw dependency errors are deliberately not retained. */
export class HermesReminderSupervisorError extends Error {
  override readonly name = "HermesReminderSupervisorError";

  constructor(
    readonly code: HermesReminderSupervisorErrorCode,
    readonly failureClass: HermesReminderSupervisorFailureClass | null,
  ) {
    super(
      (
        {
          already_running: "The Hermes reminder supervisor is already running.",
          control_failure: "The Hermes reminder supervisor control failed.",
          fatal_dependency: "A Hermes reminder supervisor dependency failed permanently.",
          failure_budget_exhausted:
            "The Hermes reminder supervisor exhausted its consecutive failure budget.",
          sleep_failure: "The Hermes reminder supervisor timer failed.",
        } satisfies Record<HermesReminderSupervisorErrorCode, string>
      )[code],
    );
  }
}

function boundedInteger(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `${label} must be an integer from ${String(minimum)} to ${String(maximum)}.`,
    );
  }
  return value;
}

const abortableSleep = (milliseconds: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });

export function classifyHermesReminderSupervisorFailure(
  error: unknown,
): HermesReminderSupervisorFailureDisposition {
  if (error instanceof ScheduleDeliveryGatewayError) {
    const failureClass = (
      {
        authentication_failed: "schedule_authentication",
        request_conflict: "schedule_conflict",
        rate_limited: "schedule_rate_limited",
        server_unavailable: "schedule_unavailable",
        network_unavailable: "schedule_unavailable",
        invalid_response: "schedule_invalid_response",
      } satisfies Record<
        ScheduleDeliveryGatewayError["reason"],
        HermesReminderSupervisorFailureClass
      >
    )[error.reason];
    return { failureClass, retryable: error.retryable };
  }
  if (error instanceof PostgresDeliveryDedupeStoreError) {
    return (
      {
        operation_timeout: { failureClass: "dedupe_timeout", retryable: true },
        reservation_fenced: { failureClass: "dedupe_fenced", retryable: true },
        invalid_input: { failureClass: "dedupe_invalid", retryable: false },
        store_inconsistent: { failureClass: "dedupe_inconsistent", retryable: false },
        unsupported_schema: { failureClass: "dedupe_schema", retryable: false },
      } satisfies Record<
        PostgresDeliveryDedupeStoreError["code"],
        HermesReminderSupervisorFailureDisposition
      >
    )[error.code];
  }
  return { failureClass: "unexpected", retryable: true };
}

export function hermesReminderRetryDelayMilliseconds(
  consecutiveFailures: number,
  baseMilliseconds: number,
  capMilliseconds: number,
  random: () => number,
): number {
  boundedInteger(consecutiveFailures, "consecutiveFailures", 1, 100);
  boundedInteger(baseMilliseconds, "baseMilliseconds", 100, 300_000);
  boundedInteger(capMilliseconds, "capMilliseconds", baseMilliseconds, 300_000);
  const sample = random();
  const unit = Number.isFinite(sample) ? Math.min(1, Math.max(0, sample)) : 0;
  const ceiling = Math.min(
    capMilliseconds,
    baseMilliseconds * 2 ** Math.min(consecutiveFailures - 1, 20),
  );
  return Math.max(1, Math.floor(unit * ceiling));
}

/** Sequential, single-flight polling around the one-command Hermes reminder runner. */
export class HermesReminderSupervisor {
  private readonly pollIntervalMilliseconds: number;
  private readonly retryBaseMilliseconds: number;
  private readonly retryCapMilliseconds: number;
  private readonly maximumConsecutiveFailures: number;
  private readonly enabled: () => boolean;
  private readonly random: () => number;
  private readonly now: () => Date;
  private readonly sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  private readonly classifyFailure: (error: unknown) => HermesReminderSupervisorFailureDisposition;

  private active = false;
  private successfulPollObserved = false;
  private state: HermesReminderSupervisorState = "starting";
  private consecutiveFailures = 0;
  private lastCycleStatus: HermesReminderRunResult["status"] | null = null;
  private lastFailureClass: HermesReminderSupervisorFailureClass | null = null;
  private lastFailureAt: string | null = null;
  private lastSuccessfulPollAt: string | null = null;

  constructor(
    private readonly runner: Pick<HermesReminderRunner, "runOnce">,
    options: HermesReminderSupervisorOptions = {},
  ) {
    this.pollIntervalMilliseconds = boundedInteger(
      options.pollIntervalMilliseconds ?? DEFAULT_POLL_INTERVAL_MILLISECONDS,
      "pollIntervalMilliseconds",
      100,
      300_000,
    );
    this.retryBaseMilliseconds = boundedInteger(
      options.retryBaseMilliseconds ?? DEFAULT_RETRY_BASE_MILLISECONDS,
      "retryBaseMilliseconds",
      100,
      300_000,
    );
    this.retryCapMilliseconds = boundedInteger(
      options.retryCapMilliseconds ?? DEFAULT_RETRY_CAP_MILLISECONDS,
      "retryCapMilliseconds",
      this.retryBaseMilliseconds,
      300_000,
    );
    this.maximumConsecutiveFailures = boundedInteger(
      options.maximumConsecutiveFailures ?? DEFAULT_MAXIMUM_CONSECUTIVE_FAILURES,
      "maximumConsecutiveFailures",
      1,
      100,
    );
    this.enabled = options.enabled ?? (() => false);
    this.random = options.random ?? Math.random;
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? abortableSleep;
    this.classifyFailure = options.classifyFailure ?? classifyHermesReminderSupervisorFailure;
  }

  health(): HermesReminderSupervisorHealth {
    return {
      live: true,
      ready: this.state === "running" && this.successfulPollObserved,
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      lastCycleStatus: this.lastCycleStatus,
      lastFailureClass: this.lastFailureClass,
      lastFailureAt: this.lastFailureAt,
      lastSuccessfulPollAt: this.lastSuccessfulPollAt,
    };
  }

  private timestamp(): string | null {
    try {
      const value = this.now();
      return value instanceof Date && Number.isFinite(value.getTime()) ? value.toISOString() : null;
    } catch {
      return null;
    }
  }

  private fatal(
    code: Extract<
      HermesReminderSupervisorErrorCode,
      "control_failure" | "fatal_dependency" | "failure_budget_exhausted" | "sleep_failure"
    >,
    failureClass: HermesReminderSupervisorFailureClass,
  ): never {
    this.state = "fatal";
    this.lastFailureClass = failureClass;
    this.lastFailureAt = this.timestamp();
    throw new HermesReminderSupervisorError(code, failureClass);
  }

  private async wait(milliseconds: number, signal: AbortSignal): Promise<void> {
    try {
      await this.sleep(milliseconds, signal);
    } catch {
      if (signal.aborted) return;
      this.fatal("sleep_failure", "unexpected");
    }
  }

  private retryDelay(): number {
    try {
      return hermesReminderRetryDelayMilliseconds(
        this.consecutiveFailures,
        this.retryBaseMilliseconds,
        this.retryCapMilliseconds,
        this.random,
      );
    } catch {
      this.fatal("fatal_dependency", "unexpected");
    }
  }

  private finishRun(): void {
    this.active = false;
    if (this.state !== "fatal") this.state = "stopped";
  }

  async run(signal: AbortSignal): Promise<void> {
    if (this.active) throw new HermesReminderSupervisorError("already_running", null);
    this.active = true;
    this.successfulPollObserved = false;
    this.consecutiveFailures = 0;
    this.lastCycleStatus = null;
    this.lastFailureClass = null;
    this.lastFailureAt = null;
    this.lastSuccessfulPollAt = null;
    this.state = signal.aborted ? "stopped" : "starting";
    const beginStopping = (): void => {
      if (this.state !== "fatal" && this.state !== "stopped") this.state = "stopping";
    };
    signal.addEventListener("abort", beginStopping, { once: true });

    try {
      while (!signal.aborted) {
        let enabled: boolean;
        try {
          enabled = this.enabled();
        } catch {
          this.fatal("control_failure", "unexpected");
        }
        if (typeof enabled !== "boolean") this.fatal("control_failure", "unexpected");
        if (signal.aborted) break;
        if (!enabled) {
          this.successfulPollObserved = false;
          this.state = "disabled";
          await this.wait(this.pollIntervalMilliseconds, signal);
          continue;
        }

        this.state = "running";
        try {
          const result = await this.runner.runOnce();
          this.consecutiveFailures = 0;
          this.successfulPollObserved = true;
          this.lastCycleStatus = result.status;
          this.lastFailureClass = null;
          this.lastSuccessfulPollAt = this.timestamp();
          if (signal.aborted) break;
          this.state = "running";
          await this.wait(this.pollIntervalMilliseconds, signal);
        } catch (error) {
          if (error instanceof HermesReminderSupervisorError) throw error;
          if (signal.aborted) break;
          this.successfulPollObserved = false;
          let candidate: unknown;
          try {
            candidate = this.classifyFailure(error);
          } catch {
            this.fatal("fatal_dependency", "unexpected");
          }
          if (
            typeof candidate !== "object" ||
            candidate === null ||
            !("retryable" in candidate) ||
            typeof candidate.retryable !== "boolean" ||
            !("failureClass" in candidate) ||
            typeof candidate.failureClass !== "string" ||
            !(
              [
                "schedule_authentication",
                "schedule_conflict",
                "schedule_rate_limited",
                "schedule_unavailable",
                "schedule_invalid_response",
                "dedupe_timeout",
                "dedupe_fenced",
                "dedupe_invalid",
                "dedupe_inconsistent",
                "dedupe_schema",
                "unexpected",
              ] as const
            ).includes(candidate.failureClass as HermesReminderSupervisorFailureClass)
          ) {
            this.fatal("fatal_dependency", "unexpected");
          }
          const disposition = candidate as HermesReminderSupervisorFailureDisposition;
          this.consecutiveFailures += 1;
          this.lastFailureClass = disposition.failureClass;
          this.lastFailureAt = this.timestamp();
          if (!disposition.retryable) {
            this.fatal("fatal_dependency", disposition.failureClass);
          }
          if (this.consecutiveFailures >= this.maximumConsecutiveFailures) {
            this.fatal("failure_budget_exhausted", disposition.failureClass);
          }
          this.state = "backing_off";
          await this.wait(this.retryDelay(), signal);
        }
      }
    } finally {
      signal.removeEventListener("abort", beginStopping);
      this.finishRun();
    }
  }
}
