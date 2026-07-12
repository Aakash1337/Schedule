import type { DatabaseConnection } from "./database.js";

export interface ClaimedOutboxEvent {
  readonly id: string;
  readonly workspaceId: string | null;
  readonly topic: string;
  readonly payload: Record<string, unknown>;
  readonly attempts: number;
  /**
   * The lease timestamp also fences acknowledgements from stale workers. A
   * worker must present the exact value it received when completing or
   * failing an event.
   */
  // Kept as PostgreSQL text so JavaScript millisecond precision cannot
  // truncate the microseconds that make the fencing token unique.
  readonly lockedAt: string;
}

export const DEFAULT_OUTBOX_LEASE_DURATION_MS = 5 * 60_000;
export const DEFAULT_OUTBOX_DEAD_LETTER_RECOVERY_LIMIT = 100;

export interface ClaimNextOutboxEventOptions {
  readonly leaseDurationMs?: number;
  readonly maxAttempts: number;
  readonly deadLetterRecoveryLimit?: number;
}

export type OutboxClaimMutationResult = "applied" | "stale";
export type OutboxFailureResult = "retry_scheduled" | "dead_lettered" | "stale";

export interface DeadLetteredOutboxEvent {
  readonly id: string;
  readonly workspaceId: string | null;
  readonly topic: string;
  readonly attempts: number;
  readonly lastError: string;
}

export interface ClaimNextOutboxEventResult {
  readonly event: ClaimedOutboxEvent | null;
  readonly deadLettered: readonly DeadLetteredOutboxEvent[];
}

export type RenewOutboxLeaseResult =
  { readonly status: "renewed"; readonly event: ClaimedOutboxEvent } | { readonly status: "stale" };

interface OutboxRow {
  id: string;
  workspace_id: string | null;
  topic: string;
  payload: Record<string, unknown>;
  attempts: number;
  locked_at: string;
}

interface OutboxMutationRow {
  id: string;
}

interface OutboxFailureRow {
  status: "pending" | "dead_letter";
}

interface OutboxRenewalRow {
  locked_at: string;
}

interface DeadLetteredOutboxRow {
  id: string;
  workspace_id: string | null;
  topic: string;
  attempts: number;
  last_error: string;
}

const EXHAUSTED_CLAIM_ERROR =
  "Maximum delivery attempts exhausted after one or more worker claims expired";

const assertPositiveInteger = (name: string, value: number): void => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
};

/**
 * Claim at most one event immediately before dispatch. Delivery is at least
 * once: handlers must be idempotent because a process can stop after the
 * handler side effect but before its fenced acknowledgement commits.
 */
export async function claimNextOutboxEvent(
  connection: DatabaseConnection,
  options: ClaimNextOutboxEventOptions,
): Promise<ClaimNextOutboxEventResult> {
  const leaseDurationMs = options.leaseDurationMs ?? DEFAULT_OUTBOX_LEASE_DURATION_MS;
  const deadLetterRecoveryLimit =
    options.deadLetterRecoveryLimit ?? DEFAULT_OUTBOX_DEAD_LETTER_RECOVERY_LIMIT;
  assertPositiveInteger("leaseDurationMs", leaseDurationMs);
  assertPositiveInteger("maxAttempts", options.maxAttempts);
  assertPositiveInteger("deadLetterRecoveryLimit", deadLetterRecoveryLimit);

  const { deadLetteredRows, claimedRows } = await connection.sql.begin(async (transaction) => {
    const deadLetteredRows = await transaction<DeadLetteredOutboxRow[]>`
      with exhausted as (
        select id
        from outbox_events
        where
          attempts >= ${options.maxAttempts}
          and (
            (status = 'pending' and available_at <= clock_timestamp())
            or (
              status = 'processing'
              and (
                locked_at is null
                or locked_at <= clock_timestamp() - (${leaseDurationMs} * interval '1 millisecond')
              )
            )
          )
        order by
          case when status = 'processing' then locked_at else available_at end nulls first,
          created_at
        for update skip locked
        limit ${deadLetterRecoveryLimit}
      )
      update outbox_events as event
      set
        status = 'dead_letter',
        locked_at = null,
        last_error = ${EXHAUSTED_CLAIM_ERROR}
      from exhausted
      where event.id = exhausted.id
      returning
        event.id,
        event.workspace_id,
        event.topic,
        event.attempts,
        event.last_error
    `;

    const claimedRows = await transaction<OutboxRow[]>`
      with candidates as (
        select id
        from outbox_events
        where
          attempts < ${options.maxAttempts}
          and (
            (status = 'pending' and available_at <= clock_timestamp())
            or (
              status = 'processing'
              and (
                locked_at is null
                or locked_at <= clock_timestamp() - (${leaseDurationMs} * interval '1 millisecond')
              )
            )
          )
        order by
          case when status = 'processing' then locked_at else available_at end nulls first,
          created_at
        for update skip locked
        limit 1
      )
      update outbox_events as event
      set
        status = 'processing',
        locked_at = greatest(
          clock_timestamp(),
          coalesce(event.locked_at + interval '1 microsecond', '-infinity'::timestamptz)
        ),
        attempts = event.attempts + 1
      from candidates
      where event.id = candidates.id
      returning
        event.id,
        event.workspace_id,
        event.topic,
        event.payload,
        event.attempts,
        event.locked_at::text as locked_at
    `;

    return { deadLetteredRows, claimedRows };
  });

  const row = claimedRows[0];
  return {
    event: row
      ? {
          id: row.id,
          workspaceId: row.workspace_id,
          topic: row.topic,
          payload: row.payload,
          attempts: row.attempts,
          lockedAt: row.locked_at,
        }
      : null,
    deadLettered: deadLetteredRows.map((deadLettered) => ({
      id: deadLettered.id,
      workspaceId: deadLettered.workspace_id,
      topic: deadLettered.topic,
      attempts: deadLettered.attempts,
      lastError: deadLettered.last_error,
    })),
  };
}

export async function renewOutboxEventLease(
  connection: DatabaseConnection,
  event: ClaimedOutboxEvent,
): Promise<RenewOutboxLeaseResult> {
  const rows = await connection.sql<OutboxRenewalRow[]>`
    update outbox_events
    set locked_at = greatest(clock_timestamp(), locked_at + interval '1 microsecond')
    where
      id = ${event.id}
      and status = 'processing'
      and locked_at = ${event.lockedAt}::timestamptz
    returning locked_at::text as locked_at
  `;
  const row = rows[0];

  return row
    ? { status: "renewed", event: { ...event, lockedAt: row.locked_at } }
    : { status: "stale" };
}

export async function completeOutboxEvent(
  connection: DatabaseConnection,
  event: ClaimedOutboxEvent,
): Promise<OutboxClaimMutationResult> {
  const rows = await connection.sql<OutboxMutationRow[]>`
    update outbox_events
    set status = 'completed', completed_at = now(), locked_at = null, last_error = null
    where
      id = ${event.id}
      and status = 'processing'
      and locked_at = ${event.lockedAt}::timestamptz
    returning id
  `;

  return rows.length === 1 ? "applied" : "stale";
}

export async function failOutboxEvent(
  connection: DatabaseConnection,
  event: ClaimedOutboxEvent,
  error: string,
  maxAttempts: number,
): Promise<OutboxFailureResult> {
  assertPositiveInteger("maxAttempts", maxAttempts);
  const retryDelayMs = Math.min(60_000, 1_000 * 2 ** Math.min(event.attempts, 6));
  const rows = await connection.sql<OutboxFailureRow[]>`
    update outbox_events
    set
      status = case when attempts >= ${maxAttempts} then 'dead_letter'::outbox_status else 'pending'::outbox_status end,
      available_at = case
        when attempts >= ${maxAttempts} then available_at
        else now() + (${retryDelayMs} * interval '1 millisecond')
      end,
      locked_at = null,
      last_error = ${error.slice(0, 8_000)}
    where
      id = ${event.id}
      and status = 'processing'
      and locked_at = ${event.lockedAt}::timestamptz
    returning status::text as status
  `;

  const row = rows[0];
  if (!row) return "stale";
  return row.status === "dead_letter" ? "dead_lettered" : "retry_scheduled";
}

/** Return a claimed but unstarted event to the queue during graceful shutdown. */
export async function releaseOutboxEvent(
  connection: DatabaseConnection,
  event: ClaimedOutboxEvent,
): Promise<OutboxClaimMutationResult> {
  const rows = await connection.sql<OutboxMutationRow[]>`
    update outbox_events
    set status = 'pending', locked_at = null, attempts = greatest(attempts - 1, 0)
    where
      id = ${event.id}
      and status = 'processing'
      and locked_at = ${event.lockedAt}::timestamptz
    returning id
  `;

  return rows.length === 1 ? "applied" : "stale";
}
