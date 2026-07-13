import type { DatabaseConnection } from "./database.js";

const DAY_MS = 24 * 60 * 60 * 1_000;

export const DEFAULT_INTEGRATION_MINIMUM_RETENTION_MS = 90 * DAY_MS;
export const MIN_INTEGRATION_MINIMUM_RETENTION_MS = 30 * DAY_MS;
export const MAX_INTEGRATION_MINIMUM_RETENTION_MS = 10 * 365 * DAY_MS;
export const DEFAULT_INTEGRATION_PURGE_BATCH_SIZE = 250;
export const MAX_INTEGRATION_PURGE_BATCH_SIZE = 1_000;

export interface PurgeIntegrationHistoryOptions {
  /** The trusted maintenance clock used to derive the retention cutoff. */
  readonly now: Date;
  /** Rows newer than this duration are always retained. Defaults to 90 days. */
  readonly minimumRetentionMs?: number;
  /** Maximum rows deleted from each table in this transaction. Defaults to 250. */
  readonly batchSize?: number;
}

export interface PurgeIntegrationHistoryResult {
  readonly cutoff: Date;
  readonly deletedRequests: number;
  readonly deletedConfirmations: number;
  readonly totalDeleted: number;
}

interface DeletedRow {
  readonly id: string;
}

function validNow(now: Date): number {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new RangeError("now must be a valid Date");
  }
  return now.getTime();
}

function boundedSafeInteger(name: string, value: number, minimum: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
}

/**
 * Deletes a bounded amount of expired integration history without touching
 * active work, fresh history, audit events, or confirmations still referenced
 * by a request receipt.
 *
 * Request receipts are removed first so confirmations that become unreferenced
 * may be removed in the same transaction. Call repeatedly until totalDeleted
 * is zero to drain a backlog without creating a large delete transaction.
 */
export async function purgeIntegrationHistory(
  connection: DatabaseConnection,
  options: PurgeIntegrationHistoryOptions,
): Promise<PurgeIntegrationHistoryResult> {
  const nowMilliseconds = validNow(options.now);
  const minimumRetentionMs = options.minimumRetentionMs ?? DEFAULT_INTEGRATION_MINIMUM_RETENTION_MS;
  const batchSize = options.batchSize ?? DEFAULT_INTEGRATION_PURGE_BATCH_SIZE;
  boundedSafeInteger(
    "minimumRetentionMs",
    minimumRetentionMs,
    MIN_INTEGRATION_MINIMUM_RETENTION_MS,
    MAX_INTEGRATION_MINIMUM_RETENTION_MS,
  );
  boundedSafeInteger("batchSize", batchSize, 1, MAX_INTEGRATION_PURGE_BATCH_SIZE);
  const cutoffMilliseconds = nowMilliseconds - minimumRetentionMs;
  if (!Number.isFinite(cutoffMilliseconds)) {
    throw new RangeError("now and minimumRetentionMs produce an invalid cutoff");
  }
  const cutoff = new Date(cutoffMilliseconds);
  if (!Number.isFinite(cutoff.getTime())) {
    throw new RangeError("now and minimumRetentionMs produce an invalid cutoff");
  }
  const cutoffIso = cutoff.toISOString();

  const { deletedRequests, deletedConfirmations } = await connection.sql.begin(
    async (transaction) => {
      const deletedRequests = await transaction<DeletedRow[]>`
        with candidates as (
          select id
          from integration_requests
          where status = 'succeeded' and completed_at < ${cutoffIso}::timestamptz
          order by completed_at, id
          for update skip locked
          limit ${batchSize}
        )
        delete from integration_requests as request
        using candidates
        where request.id = candidates.id and request.status = 'succeeded'
        returning request.id
      `;

      const deletedConfirmations = await transaction<DeletedRow[]>`
        with candidates as (
          select confirmation.id
          from integration_confirmations as confirmation
          where
            confirmation.expires_at < ${cutoffIso}::timestamptz
            and not exists (
              select 1
              from integration_requests as request
              where request.confirmation_id = confirmation.id
            )
          order by confirmation.expires_at, confirmation.id
          for update of confirmation skip locked
          limit ${batchSize}
        )
        delete from integration_confirmations as confirmation
        using candidates
        where
          confirmation.id = candidates.id
          and confirmation.expires_at < ${cutoffIso}::timestamptz
          and not exists (
            select 1
            from integration_requests as request
            where request.confirmation_id = confirmation.id
          )
        returning confirmation.id
      `;

      return { deletedRequests, deletedConfirmations };
    },
  );

  return {
    cutoff,
    deletedRequests: deletedRequests.length,
    deletedConfirmations: deletedConfirmations.length,
    totalDeleted: deletedRequests.length + deletedConfirmations.length,
  };
}
