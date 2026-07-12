import type { DatabaseConnection } from "./database.js";

export interface ClaimedOutboxEvent {
  readonly id: string;
  readonly workspaceId: string | null;
  readonly topic: string;
  readonly payload: Record<string, unknown>;
  readonly attempts: number;
}

interface OutboxRow {
  id: string;
  workspace_id: string | null;
  topic: string;
  payload: Record<string, unknown>;
  attempts: number;
}

export async function claimOutboxBatch(
  connection: DatabaseConnection,
  batchSize: number,
): Promise<ClaimedOutboxEvent[]> {
  const rows = await connection.sql.begin(
    async (transaction) =>
      transaction<OutboxRow[]>`
      with candidates as (
        select id
        from outbox_events
        where status = 'pending' and available_at <= now()
        order by available_at, created_at
        for update skip locked
        limit ${batchSize}
      )
      update outbox_events as event
      set status = 'processing', locked_at = now(), attempts = event.attempts + 1
      from candidates
      where event.id = candidates.id
      returning event.id, event.workspace_id, event.topic, event.payload, event.attempts
    `,
  );

  return rows.map((row) => ({
    id: row.id,
    workspaceId: row.workspace_id,
    topic: row.topic,
    payload: row.payload,
    attempts: row.attempts,
  }));
}

export async function completeOutboxEvent(
  connection: DatabaseConnection,
  id: string,
): Promise<void> {
  await connection.sql`
    update outbox_events
    set status = 'completed', completed_at = now(), locked_at = null, last_error = null
    where id = ${id}
  `;
}

export async function failOutboxEvent(
  connection: DatabaseConnection,
  event: ClaimedOutboxEvent,
  error: string,
  maxAttempts: number,
): Promise<void> {
  const retryDelayMs = Math.min(60_000, 1_000 * 2 ** Math.min(event.attempts, 6));
  await connection.sql`
    update outbox_events
    set
      status = case when attempts >= ${maxAttempts} then 'dead_letter'::outbox_status else 'pending'::outbox_status end,
      available_at = now() + (${retryDelayMs} * interval '1 millisecond'),
      locked_at = null,
      last_error = ${error.slice(0, 8_000)}
    where id = ${event.id}
  `;
}
