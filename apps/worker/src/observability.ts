import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import {
  healthCheckDatabase,
  withDatabaseOperationDeadline,
  type DatabaseConnection,
} from "@schedule/database";

import type { NotificationMaterializationCycleSummary } from "./notification-materializer.js";
import type { HostedSyncCleanupCycleSummary } from "./hosted-sync-cleanup.js";

const LOOPBACK_HOST = "127.0.0.1";
const PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";
const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const DEFAULT_DATABASE_OPERATION_TIMEOUT_MS = 5_000;

type TelemetryClock = () => Date;

export interface OutboxWorkerTelemetry {
  recordOutboxClaimed(): void;
  recordOutboxCompleted(): void;
  recordOutboxRetried(): void;
  recordOutboxDeadLettered(): void;
  recordOutboxStaleClaim(): void;
  recordOutboxLeaseRenewalFailure(): void;
  recordOutboxShutdownDeadline(): void;
}

export interface NotificationMaterializationTelemetry {
  recordNotificationMaterializationCycle(summary: NotificationMaterializationCycleSummary): void;
}

export interface HostedSyncCleanupTelemetry {
  recordHostedSyncCleanupCycle(summary: HostedSyncCleanupCycleSummary): void;
}

export interface WorkerTelemetrySnapshot {
  readonly uptimeSeconds: number;
  readonly databaseCollectionFailures: number;
  readonly outboxClaimed: number;
  readonly outboxCompleted: number;
  readonly outboxRetried: number;
  readonly outboxDeadLettered: number;
  readonly outboxStaleClaims: number;
  readonly outboxLeaseRenewalFailures: number;
  readonly outboxShutdownDeadlines: number;
  readonly materializationCycles: number;
  readonly materializationWorkspaceFailures: number;
  readonly materializationWorkspaceSkips: number;
  readonly materializationListFailures: number;
  readonly materializationLimitExceeded: number;
  readonly materializationAborted: number;
  readonly materializationCreatedIntents: number;
  readonly materializationExistingIntents: number;
  readonly materializationSuppressedCandidates: number;
  readonly materializationLastCompletedTimestampSeconds: number;
  readonly materializationLastSuccessfulTimestampSeconds: number;
  readonly hostedSyncCleanupCycles: number;
  readonly hostedSyncCleanupFailures: number;
  readonly hostedSyncCleanupContention: number;
  readonly hostedSyncCleanupBatches: number;
  readonly hostedSyncCleanupDeletedChanges: number;
  readonly hostedSyncCleanupLimitReached: number;
  readonly hostedSyncCleanupAborted: number;
  readonly hostedSyncCleanupLastCompletedTimestampSeconds: number;
  readonly hostedSyncCleanupLastSuccessfulTimestampSeconds: number;
}

type MutableTelemetryState = {
  -readonly [
    Key in Exclude<keyof WorkerTelemetrySnapshot, "uptimeSeconds">
  ]: WorkerTelemetrySnapshot[Key];
};

function validClockInstant(clock: TelemetryClock): Date {
  const instant = new Date(clock().getTime());
  if (!Number.isFinite(instant.getTime())) {
    throw new RangeError("The worker telemetry clock returned an invalid instant.");
  }
  return instant;
}

function addSaturated(current: number, increment = 1): number {
  if (!Number.isSafeInteger(increment) || increment < 0) return current;
  return Math.min(Number.MAX_SAFE_INTEGER, current + increment);
}

export class WorkerTelemetry
  implements OutboxWorkerTelemetry, NotificationMaterializationTelemetry, HostedSyncCleanupTelemetry
{
  readonly #clock: TelemetryClock;
  readonly #startedAtMs: number;
  readonly #state: MutableTelemetryState = {
    databaseCollectionFailures: 0,
    outboxClaimed: 0,
    outboxCompleted: 0,
    outboxRetried: 0,
    outboxDeadLettered: 0,
    outboxStaleClaims: 0,
    outboxLeaseRenewalFailures: 0,
    outboxShutdownDeadlines: 0,
    materializationCycles: 0,
    materializationWorkspaceFailures: 0,
    materializationWorkspaceSkips: 0,
    materializationListFailures: 0,
    materializationLimitExceeded: 0,
    materializationAborted: 0,
    materializationCreatedIntents: 0,
    materializationExistingIntents: 0,
    materializationSuppressedCandidates: 0,
    materializationLastCompletedTimestampSeconds: 0,
    materializationLastSuccessfulTimestampSeconds: 0,
    hostedSyncCleanupCycles: 0,
    hostedSyncCleanupFailures: 0,
    hostedSyncCleanupContention: 0,
    hostedSyncCleanupBatches: 0,
    hostedSyncCleanupDeletedChanges: 0,
    hostedSyncCleanupLimitReached: 0,
    hostedSyncCleanupAborted: 0,
    hostedSyncCleanupLastCompletedTimestampSeconds: 0,
    hostedSyncCleanupLastSuccessfulTimestampSeconds: 0,
  };

  constructor(clock: TelemetryClock = () => new Date()) {
    this.#clock = clock;
    this.#startedAtMs = validClockInstant(clock).getTime();
  }

  recordOutboxClaimed(): void {
    this.#state.outboxClaimed = addSaturated(this.#state.outboxClaimed);
  }

  recordOutboxCompleted(): void {
    this.#state.outboxCompleted = addSaturated(this.#state.outboxCompleted);
  }

  recordOutboxRetried(): void {
    this.#state.outboxRetried = addSaturated(this.#state.outboxRetried);
  }

  recordOutboxDeadLettered(): void {
    this.#state.outboxDeadLettered = addSaturated(this.#state.outboxDeadLettered);
  }

  recordOutboxStaleClaim(): void {
    this.#state.outboxStaleClaims = addSaturated(this.#state.outboxStaleClaims);
  }

  recordOutboxLeaseRenewalFailure(): void {
    this.#state.outboxLeaseRenewalFailures = addSaturated(this.#state.outboxLeaseRenewalFailures);
  }

  recordOutboxShutdownDeadline(): void {
    this.#state.outboxShutdownDeadlines = addSaturated(this.#state.outboxShutdownDeadlines);
  }

  recordDatabaseCollectionFailure(): void {
    this.#state.databaseCollectionFailures = addSaturated(this.#state.databaseCollectionFailures);
  }

  recordNotificationMaterializationCycle(summary: NotificationMaterializationCycleSummary): void {
    const completedAtSeconds = Math.floor(validClockInstant(this.#clock).getTime() / 1_000);
    this.#state.materializationCycles = addSaturated(this.#state.materializationCycles);
    this.#state.materializationWorkspaceFailures = addSaturated(
      this.#state.materializationWorkspaceFailures,
      summary.failedWorkspaces,
    );
    this.#state.materializationWorkspaceSkips = addSaturated(
      this.#state.materializationWorkspaceSkips,
      summary.skippedWorkspaces,
    );
    this.#state.materializationCreatedIntents = addSaturated(
      this.#state.materializationCreatedIntents,
      summary.createdIntents,
    );
    this.#state.materializationExistingIntents = addSaturated(
      this.#state.materializationExistingIntents,
      summary.existingIntents,
    );
    this.#state.materializationSuppressedCandidates = addSaturated(
      this.#state.materializationSuppressedCandidates,
      summary.suppressedCandidates,
    );
    if (summary.workspaceListFailed) {
      this.#state.materializationListFailures = addSaturated(
        this.#state.materializationListFailures,
      );
    }
    if (summary.workspaceLimitExceeded) {
      this.#state.materializationLimitExceeded = addSaturated(
        this.#state.materializationLimitExceeded,
      );
    }
    if (summary.aborted) {
      this.#state.materializationAborted = addSaturated(this.#state.materializationAborted);
    }
    this.#state.materializationLastCompletedTimestampSeconds = completedAtSeconds;
    if (
      !summary.workspaceListFailed &&
      !summary.workspaceLimitExceeded &&
      !summary.aborted &&
      summary.failedWorkspaces === 0
    ) {
      this.#state.materializationLastSuccessfulTimestampSeconds = completedAtSeconds;
    }
  }

  recordHostedSyncCleanupCycle(summary: HostedSyncCleanupCycleSummary): void {
    const completedAtSeconds = Math.floor(validClockInstant(this.#clock).getTime() / 1_000);
    this.#state.hostedSyncCleanupCycles = addSaturated(this.#state.hostedSyncCleanupCycles);
    this.#state.hostedSyncCleanupBatches = addSaturated(
      this.#state.hostedSyncCleanupBatches,
      summary.batches,
    );
    this.#state.hostedSyncCleanupDeletedChanges = addSaturated(
      this.#state.hostedSyncCleanupDeletedChanges,
      summary.deletedChanges,
    );
    if (summary.failed) {
      this.#state.hostedSyncCleanupFailures = addSaturated(this.#state.hostedSyncCleanupFailures);
    }
    if (summary.contended) {
      this.#state.hostedSyncCleanupContention = addSaturated(
        this.#state.hostedSyncCleanupContention,
      );
    }
    if (summary.limitReached) {
      this.#state.hostedSyncCleanupLimitReached = addSaturated(
        this.#state.hostedSyncCleanupLimitReached,
      );
    }
    if (summary.aborted) {
      this.#state.hostedSyncCleanupAborted = addSaturated(this.#state.hostedSyncCleanupAborted);
    }
    this.#state.hostedSyncCleanupLastCompletedTimestampSeconds = completedAtSeconds;
    if (!summary.failed && !summary.contended && !summary.limitReached && !summary.aborted) {
      this.#state.hostedSyncCleanupLastSuccessfulTimestampSeconds = completedAtSeconds;
    }
  }

  snapshot(): WorkerTelemetrySnapshot {
    const nowMs = validClockInstant(this.#clock).getTime();
    return Object.freeze({
      uptimeSeconds: Math.max(0, (nowMs - this.#startedAtMs) / 1_000),
      ...this.#state,
    });
  }
}

export interface OperationalDatabaseSnapshot {
  readonly outboxReady: number;
  readonly outboxProcessing: number;
  readonly outboxDeadLetter: number;
  readonly outboxOldestReadyAgeSeconds: number;
  readonly notificationIntentsReady: number;
  readonly notificationIntentsOldestReadyAgeSeconds: number;
  readonly notificationDeliveryReady: number;
  readonly notificationDeliveryProcessing: number;
  readonly notificationDeliveryDeadLetter: number;
  readonly notificationDeliveryOldestReadyAgeSeconds: number;
  readonly notificationDeliveryAttempts: number;
  readonly notificationDeliveryDelivered: number;
  readonly notificationDeliveryRetryableFailures: number;
  readonly notificationDeliveryPermanentFailures: number;
  readonly notificationDeliveryLeaseExpired: number;
}

type OperationalDatabaseRow = Readonly<Record<keyof OperationalDatabaseSnapshot, unknown>>;

function operationalNumber(value: unknown, field: keyof OperationalDatabaseSnapshot): number {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`Operational database metric ${field} is invalid.`);
  }
  return parsed;
}

export async function collectOperationalDatabaseSnapshot(
  connection: DatabaseConnection,
  timeoutMs = DEFAULT_DATABASE_OPERATION_TIMEOUT_MS,
  excludedOutboxTopics: readonly string[] = [],
): Promise<OperationalDatabaseSnapshot> {
  const excludedTopics = [...excludedOutboxTopics];
  const rows = await withDatabaseOperationDeadline(
    connection.sql<OperationalDatabaseRow[]>`
      with observation_clock as (
      select clock_timestamp() as observed_at
    ), outbox as (
      select
        count(*) filter (
          where status = 'pending'
            and topic <> all(${excludedTopics}::text[])
            and available_at <= (select observed_at from observation_clock)
        )::double precision as "outboxReady",
        count(*) filter (where status = 'processing')::double precision as "outboxProcessing",
        count(*) filter (where status = 'dead_letter')::double precision as "outboxDeadLetter",
        coalesce(extract(epoch from (select observed_at from observation_clock) - min(available_at) filter (
          where status = 'pending'
            and topic <> all(${excludedTopics}::text[])
            and available_at <= (select observed_at from observation_clock)
        )), 0)::double precision as "outboxOldestReadyAgeSeconds"
      from outbox_events
    ), intents as (
      select
        count(*) filter (
          where intent.scheduled_for <= (select observed_at from observation_clock)
            and not exists (
              select 1
              from notification_delivery_commands as command
              where command.workspace_id = intent.workspace_id
                and command.occurrence_key = intent.occurrence_key
            )
        )::double precision as "notificationIntentsReady",
        coalesce(extract(epoch from (select observed_at from observation_clock) - min(intent.scheduled_for) filter (
          where intent.scheduled_for <= (select observed_at from observation_clock)
            and not exists (
              select 1
              from notification_delivery_commands as command
              where command.workspace_id = intent.workspace_id
                and command.occurrence_key = intent.occurrence_key
            )
        )), 0)::double precision as "notificationIntentsOldestReadyAgeSeconds"
      from notification_intents as intent
    ), deliveries as (
      select
        count(*) filter (
          where status = 'pending'
            and available_at <= (select observed_at from observation_clock)
            and scheduled_for <= (select observed_at from observation_clock)
        )::double precision as "notificationDeliveryReady",
        count(*) filter (where status = 'processing')::double precision as "notificationDeliveryProcessing",
        count(*) filter (where status = 'dead_letter')::double precision as "notificationDeliveryDeadLetter",
        coalesce(extract(epoch from (select observed_at from observation_clock) - min(greatest(available_at, scheduled_for)) filter (
          where status = 'pending'
            and available_at <= (select observed_at from observation_clock)
            and scheduled_for <= (select observed_at from observation_clock)
        )), 0)::double precision as "notificationDeliveryOldestReadyAgeSeconds"
      from notification_delivery_commands
    ), attempts as (
      select
        count(*)::double precision as "notificationDeliveryAttempts",
        count(*) filter (where outcome = 'delivered')::double precision as "notificationDeliveryDelivered",
        count(*) filter (where outcome = 'retryable_failure')::double precision as "notificationDeliveryRetryableFailures",
        count(*) filter (where outcome = 'permanent_failure')::double precision as "notificationDeliveryPermanentFailures",
        count(*) filter (where outcome = 'lease_expired')::double precision as "notificationDeliveryLeaseExpired"
      from notification_delivery_attempts
    )
      select * from outbox cross join intents cross join deliveries cross join attempts
    `,
    timeoutMs,
  );
  const row = rows[0];
  if (rows.length !== 1 || row === undefined) {
    throw new Error("Operational database metrics returned an unexpected result.");
  }

  const keys: readonly (keyof OperationalDatabaseSnapshot)[] = [
    "outboxReady",
    "outboxProcessing",
    "outboxDeadLetter",
    "outboxOldestReadyAgeSeconds",
    "notificationIntentsReady",
    "notificationIntentsOldestReadyAgeSeconds",
    "notificationDeliveryReady",
    "notificationDeliveryProcessing",
    "notificationDeliveryDeadLetter",
    "notificationDeliveryOldestReadyAgeSeconds",
    "notificationDeliveryAttempts",
    "notificationDeliveryDelivered",
    "notificationDeliveryRetryableFailures",
    "notificationDeliveryPermanentFailures",
    "notificationDeliveryLeaseExpired",
  ];
  return Object.freeze(
    Object.fromEntries(keys.map((key) => [key, operationalNumber(row[key], key)])),
  ) as unknown as OperationalDatabaseSnapshot;
}

type MetricKind = "counter" | "gauge";

function metric(name: string, help: string, kind: MetricKind, value: number | "NaN"): string {
  return `# HELP ${name} ${help}\n# TYPE ${name} ${kind}\n${name} ${value}`;
}

export function renderWorkerMetrics(
  telemetry: WorkerTelemetrySnapshot,
  database: OperationalDatabaseSnapshot | null,
): string {
  const databaseValue = (key: keyof OperationalDatabaseSnapshot): number | "NaN" =>
    database === null ? "NaN" : database[key];
  const entries = [
    metric(
      "schedule_worker_uptime_seconds",
      "Worker process uptime.",
      "gauge",
      telemetry.uptimeSeconds,
    ),
    metric(
      "schedule_worker_database_up",
      "Whether the operational database snapshot succeeded.",
      "gauge",
      database === null ? 0 : 1,
    ),
    metric(
      "schedule_worker_database_collection_failures_total",
      "Failed operational database collections.",
      "counter",
      telemetry.databaseCollectionFailures,
    ),
    metric(
      "schedule_outbox_claimed_total",
      "Outbox events claimed by this worker process.",
      "counter",
      telemetry.outboxClaimed,
    ),
    metric(
      "schedule_outbox_completed_total",
      "Outbox events completed by this worker process.",
      "counter",
      telemetry.outboxCompleted,
    ),
    metric(
      "schedule_outbox_retried_total",
      "Outbox events scheduled for retry by this worker process.",
      "counter",
      telemetry.outboxRetried,
    ),
    metric(
      "schedule_outbox_dead_lettered_total",
      "Outbox events dead-lettered by this worker process.",
      "counter",
      telemetry.outboxDeadLettered,
    ),
    metric(
      "schedule_outbox_stale_claims_total",
      "Superseded outbox claim mutations observed by this worker process.",
      "counter",
      telemetry.outboxStaleClaims,
    ),
    metric(
      "schedule_outbox_lease_renewal_failures_total",
      "Outbox lease renewal database failures.",
      "counter",
      telemetry.outboxLeaseRenewalFailures,
    ),
    metric(
      "schedule_outbox_shutdown_deadlines_total",
      "Outbox handlers that exceeded the shutdown grace period.",
      "counter",
      telemetry.outboxShutdownDeadlines,
    ),
    metric(
      "schedule_notification_materialization_cycles_total",
      "Automatic notification materialization cycles.",
      "counter",
      telemetry.materializationCycles,
    ),
    metric(
      "schedule_notification_materialization_workspace_failures_total",
      "Unexpected workspace materialization failures.",
      "counter",
      telemetry.materializationWorkspaceFailures,
    ),
    metric(
      "schedule_notification_materialization_workspace_skips_total",
      "Expected unconfigured workspace skips.",
      "counter",
      telemetry.materializationWorkspaceSkips,
    ),
    metric(
      "schedule_notification_materialization_list_failures_total",
      "Workspace-list failures that skipped a materialization cycle.",
      "counter",
      telemetry.materializationListFailures,
    ),
    metric(
      "schedule_notification_materialization_limit_exceeded_total",
      "Materialization cycles rejected by the local workspace cap.",
      "counter",
      telemetry.materializationLimitExceeded,
    ),
    metric(
      "schedule_notification_materialization_aborted_total",
      "Materialization cycles interrupted by shutdown.",
      "counter",
      telemetry.materializationAborted,
    ),
    metric(
      "schedule_notification_materialization_created_intents_total",
      "Notification intents created by automatic materialization.",
      "counter",
      telemetry.materializationCreatedIntents,
    ),
    metric(
      "schedule_notification_materialization_existing_intents_total",
      "Existing notification intents found during automatic materialization.",
      "counter",
      telemetry.materializationExistingIntents,
    ),
    metric(
      "schedule_notification_materialization_suppressed_candidates_total",
      "Notification candidates suppressed during automatic materialization.",
      "counter",
      telemetry.materializationSuppressedCandidates,
    ),
    metric(
      "schedule_notification_materialization_last_completed_timestamp_seconds",
      "Unix timestamp of the last completed materialization cycle.",
      "gauge",
      telemetry.materializationLastCompletedTimestampSeconds,
    ),
    metric(
      "schedule_notification_materialization_last_successful_timestamp_seconds",
      "Unix timestamp of the last failure-free materialization cycle.",
      "gauge",
      telemetry.materializationLastSuccessfulTimestampSeconds,
    ),
    metric(
      "schedule_hosted_sync_cleanup_cycles_total",
      "Hosted work-item sync retention cycles.",
      "counter",
      telemetry.hostedSyncCleanupCycles,
    ),
    metric(
      "schedule_hosted_sync_cleanup_failures_total",
      "Failed hosted work-item sync retention cycles.",
      "counter",
      telemetry.hostedSyncCleanupFailures,
    ),
    metric(
      "schedule_hosted_sync_cleanup_contention_total",
      "Hosted work-item sync retention cycles deferred behind another database transaction.",
      "counter",
      telemetry.hostedSyncCleanupContention,
    ),
    metric(
      "schedule_hosted_sync_cleanup_batches_total",
      "Hosted work-item sync retention batches that deleted changes.",
      "counter",
      telemetry.hostedSyncCleanupBatches,
    ),
    metric(
      "schedule_hosted_sync_cleanup_deleted_changes_total",
      "Hosted work-item sync changes deleted by retention.",
      "counter",
      telemetry.hostedSyncCleanupDeletedChanges,
    ),
    metric(
      "schedule_hosted_sync_cleanup_limit_reached_total",
      "Hosted work-item sync retention cycles that exhausted their batch cap.",
      "counter",
      telemetry.hostedSyncCleanupLimitReached,
    ),
    metric(
      "schedule_hosted_sync_cleanup_aborted_total",
      "Hosted work-item sync retention cycles interrupted by shutdown.",
      "counter",
      telemetry.hostedSyncCleanupAborted,
    ),
    metric(
      "schedule_hosted_sync_cleanup_last_completed_timestamp_seconds",
      "Unix timestamp of the last completed hosted sync retention cycle.",
      "gauge",
      telemetry.hostedSyncCleanupLastCompletedTimestampSeconds,
    ),
    metric(
      "schedule_hosted_sync_cleanup_last_successful_timestamp_seconds",
      "Unix timestamp of the last complete hosted sync retention cycle.",
      "gauge",
      telemetry.hostedSyncCleanupLastSuccessfulTimestampSeconds,
    ),
    metric(
      "schedule_outbox_ready",
      "Outbox events currently ready for a claim.",
      "gauge",
      databaseValue("outboxReady"),
    ),
    metric(
      "schedule_outbox_processing",
      "Outbox events currently processing.",
      "gauge",
      databaseValue("outboxProcessing"),
    ),
    metric(
      "schedule_outbox_dead_letter",
      "Outbox events currently dead-lettered.",
      "gauge",
      databaseValue("outboxDeadLetter"),
    ),
    metric(
      "schedule_outbox_oldest_ready_age_seconds",
      "Age of the oldest ready outbox event.",
      "gauge",
      databaseValue("outboxOldestReadyAgeSeconds"),
    ),
    metric(
      "schedule_notification_intents_ready",
      "Due notification intents without a delivery command.",
      "gauge",
      databaseValue("notificationIntentsReady"),
    ),
    metric(
      "schedule_notification_intents_oldest_ready_age_seconds",
      "Age of the oldest due notification intent without a delivery command.",
      "gauge",
      databaseValue("notificationIntentsOldestReadyAgeSeconds"),
    ),
    metric(
      "schedule_notification_delivery_ready",
      "Notification delivery commands ready to claim.",
      "gauge",
      databaseValue("notificationDeliveryReady"),
    ),
    metric(
      "schedule_notification_delivery_processing",
      "Notification delivery commands currently leased.",
      "gauge",
      databaseValue("notificationDeliveryProcessing"),
    ),
    metric(
      "schedule_notification_delivery_dead_letter",
      "Notification delivery commands currently dead-lettered.",
      "gauge",
      databaseValue("notificationDeliveryDeadLetter"),
    ),
    metric(
      "schedule_notification_delivery_oldest_ready_age_seconds",
      "Age of the oldest ready notification delivery command.",
      "gauge",
      databaseValue("notificationDeliveryOldestReadyAgeSeconds"),
    ),
    metric(
      "schedule_notification_delivery_attempt_records",
      "Retained notification delivery claim-attempt records.",
      "gauge",
      databaseValue("notificationDeliveryAttempts"),
    ),
    metric(
      "schedule_notification_delivery_delivered_attempt_records",
      "Retained notification delivery attempts reported delivered.",
      "gauge",
      databaseValue("notificationDeliveryDelivered"),
    ),
    metric(
      "schedule_notification_delivery_retryable_failure_attempt_records",
      "Retained retryable notification delivery failure attempts.",
      "gauge",
      databaseValue("notificationDeliveryRetryableFailures"),
    ),
    metric(
      "schedule_notification_delivery_permanent_failure_attempt_records",
      "Retained permanent notification delivery failure attempts.",
      "gauge",
      databaseValue("notificationDeliveryPermanentFailures"),
    ),
    metric(
      "schedule_notification_delivery_lease_expired_attempt_records",
      "Retained notification delivery attempts recovered after lease expiry.",
      "gauge",
      databaseValue("notificationDeliveryLeaseExpired"),
    ),
  ];
  return `${entries.join("\n")}\n`;
}

interface WorkerHealthDependencies {
  readonly readinessCheck: () => Promise<void>;
}

export interface WorkerObservabilityDependencies extends WorkerHealthDependencies {
  readonly telemetry: WorkerTelemetry;
  readonly collectDatabaseSnapshot: () => Promise<OperationalDatabaseSnapshot>;
}

function commonHeaders(contentType: string): Record<string, string> {
  return {
    "cache-control": "no-store",
    "content-type": contentType,
    "x-content-type-options": "nosniff",
  };
}

function sendJson(response: ServerResponse, statusCode: number, body: object): void {
  response.writeHead(statusCode, commonHeaders(JSON_CONTENT_TYPE));
  response.end(JSON.stringify(body));
}

function createWorkerHttpHandler(
  health: WorkerHealthDependencies,
  metrics?: Pick<WorkerObservabilityDependencies, "telemetry" | "collectDatabaseSnapshot">,
): (request: IncomingMessage, response: ServerResponse) => void {
  let readinessInFlight: Promise<void> | null = null;
  let databaseCollectionInFlight: Promise<OperationalDatabaseSnapshot | null> | null = null;
  const checkReadinessOnce = (): Promise<void> => {
    if (readinessInFlight !== null) return readinessInFlight;
    const check = Promise.resolve().then(async () => await health.readinessCheck());
    readinessInFlight = check.finally(() => {
      readinessInFlight = null;
    });
    return readinessInFlight;
  };
  const collectDatabaseOnce = (): Promise<OperationalDatabaseSnapshot | null> => {
    if (metrics === undefined) return Promise.resolve(null);
    if (databaseCollectionInFlight !== null) return databaseCollectionInFlight;
    const collection = metrics.collectDatabaseSnapshot().then(
      (snapshot) => snapshot,
      () => {
        metrics.telemetry.recordDatabaseCollectionFailure();
        return null;
      },
    );
    databaseCollectionInFlight = collection.finally(() => {
      databaseCollectionInFlight = null;
    });
    return databaseCollectionInFlight;
  };

  return (request, response) => {
    void (async (): Promise<void> => {
      if (request.method !== "GET") {
        response.setHeader("allow", "GET");
        sendJson(response, 405, { status: "method_not_allowed" });
        return;
      }
      let pathname: string;
      try {
        pathname = new URL(request.url ?? "/", `http://${LOOPBACK_HOST}`).pathname;
      } catch {
        sendJson(response, 400, { status: "bad_request" });
        return;
      }
      if (pathname === "/health/live") {
        sendJson(response, 200, { status: "alive" });
        return;
      }
      if (pathname === "/health/ready") {
        try {
          await checkReadinessOnce();
          sendJson(response, 200, { status: "ready" });
        } catch {
          sendJson(response, 503, { status: "not_ready" });
        }
        return;
      }
      if (pathname === "/metrics" && metrics !== undefined) {
        const database = await collectDatabaseOnce();
        response.writeHead(200, commonHeaders(PROMETHEUS_CONTENT_TYPE));
        response.end(renderWorkerMetrics(metrics.telemetry.snapshot(), database));
        return;
      }
      sendJson(response, 404, { status: "not_found" });
    })().catch(() => {
      if (!response.headersSent) sendJson(response, 500, { status: "internal_error" });
      else response.end();
    });
  };
}

export function createWorkerObservabilityHandler(
  dependencies: WorkerObservabilityDependencies,
): (request: IncomingMessage, response: ServerResponse) => void {
  return createWorkerHttpHandler(dependencies, dependencies);
}

function createWorkerDeploymentHealthHandler(
  dependencies: WorkerHealthDependencies,
): (request: IncomingMessage, response: ServerResponse) => void {
  return createWorkerHttpHandler(dependencies);
}

export interface RunWorkerObservabilityServerOptions {
  readonly port: number;
  readonly database: DatabaseConnection;
  readonly telemetry: WorkerTelemetry;
  readonly databaseOperationTimeoutMs?: number;
  readonly excludedOutboxTopics?: readonly string[];
  readonly onListening?: (address: AddressInfo, server: Server) => void;
}

export interface RunWorkerDeploymentHealthServerOptions {
  readonly port: number;
  readonly database: DatabaseConnection;
  readonly databaseOperationTimeoutMs?: number;
  readonly onListening?: (address: AddressInfo, server: Server) => void;
}

interface RunWorkerHttpServerOptions {
  readonly port: number;
  readonly host: string;
  readonly name: string;
  readonly handler: (request: IncomingMessage, response: ServerResponse) => void;
  readonly onListening?: (address: AddressInfo, server: Server) => void;
}

async function runWorkerHttpServer(
  options: RunWorkerHttpServerOptions,
  signal: AbortSignal,
): Promise<void> {
  if (!Number.isSafeInteger(options.port) || options.port < 0 || options.port > 65_535) {
    throw new RangeError("Worker HTTP port must be between 0 and 65535.");
  }
  if (signal.aborted) return;

  const server = createServer(options.handler);

  await new Promise<void>((resolve, reject) => {
    let closing = false;
    let settled = false;
    let firstFailure: Error | undefined;
    const listenerError = (error: unknown): Error =>
      error instanceof Error ? error : new Error(`${options.name} listener failed.`);
    const finish = (failure?: Error): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      server.removeListener("error", fail);
      if (failure === undefined) resolve();
      else reject(failure);
    };
    const fail = (error: Error): void => {
      close(error);
    };
    const close = (failure?: Error): void => {
      if (failure !== undefined && firstFailure === undefined) firstFailure = failure;
      if (closing) return;
      closing = true;
      signal.removeEventListener("abort", onAbort);
      try {
        server.close((error) => {
          finish(firstFailure ?? error);
        });
      } catch (error) {
        firstFailure ??= listenerError(error);
        try {
          server.closeAllConnections();
        } catch {
          // The first fixed or listener failure remains authoritative.
        }
        finish(firstFailure);
        return;
      }
    };
    const onAbort = (): void => close();
    server.on("error", fail);
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      server.listen(options.port, options.host, () => {
        const address = server.address();
        if (address === null || typeof address === "string") {
          close(new Error(`${options.name} did not bind to a TCP address.`));
          return;
        }
        try {
          options.onListening?.(address, server);
        } catch (error) {
          close(listenerError(error));
          return;
        }
        if (signal.aborted) close();
      });
    } catch (error) {
      close(listenerError(error));
    }
    if (signal.aborted) close();
  });
}

export function runWorkerObservabilityServer(
  options: RunWorkerObservabilityServerOptions,
  signal: AbortSignal,
): Promise<void> {
  const databaseOperationTimeoutMs =
    options.databaseOperationTimeoutMs ?? DEFAULT_DATABASE_OPERATION_TIMEOUT_MS;
  return runWorkerHttpServer(
    {
      port: options.port,
      host: LOOPBACK_HOST,
      name: "Worker observability server",
      handler: createWorkerObservabilityHandler({
        telemetry: options.telemetry,
        readinessCheck: async () =>
          await healthCheckDatabase(options.database, databaseOperationTimeoutMs),
        collectDatabaseSnapshot: async () =>
          await collectOperationalDatabaseSnapshot(
            options.database,
            databaseOperationTimeoutMs,
            options.excludedOutboxTopics,
          ),
      }),
      ...(options.onListening === undefined ? {} : { onListening: options.onListening }),
    },
    signal,
  );
}

export function runWorkerDeploymentHealthServer(
  options: RunWorkerDeploymentHealthServerOptions,
  signal: AbortSignal,
): Promise<void> {
  const databaseOperationTimeoutMs =
    options.databaseOperationTimeoutMs ?? DEFAULT_DATABASE_OPERATION_TIMEOUT_MS;
  return runWorkerHttpServer(
    {
      port: options.port,
      host: "0.0.0.0",
      name: "Worker deployment health server",
      handler: createWorkerDeploymentHealthHandler({
        readinessCheck: async () =>
          await healthCheckDatabase(options.database, databaseOperationTimeoutMs),
      }),
      ...(options.onListening === undefined ? {} : { onListening: options.onListening }),
    },
    signal,
  );
}
