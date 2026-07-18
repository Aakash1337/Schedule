import {
  HostedApiError,
  type HostedWorkItemSnapshot,
  type HostedWorkItemSyncBootstrapPage,
  type HostedWorkItemSyncDeltaPage,
} from "./hosted-api";

export interface HostedWorkItemSyncApi {
  bootstrapWorkItemSync(
    workspaceId: string,
    cursor?: string,
  ): Promise<HostedWorkItemSyncBootstrapPage>;
  listWorkItemSyncChanges(
    workspaceId: string,
    cursor: string,
  ): Promise<HostedWorkItemSyncDeltaPage>;
}

export interface HostedWorkItemSyncState {
  readonly workspaceId: string;
  readonly checkpoint: string;
  readonly items: readonly HostedWorkItemSnapshot[];
}

function isGone(error: unknown): boolean {
  return error instanceof HostedApiError && error.status === 410;
}

function sortedItems(items: ReadonlyMap<string, HostedWorkItemSnapshot>) {
  return [...items.values()].sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );
}

function assertCheckpoint(current: string | undefined, received: string): string {
  if (current !== undefined && current !== received) {
    throw new Error("Hosted work-item sync checkpoint changed during pagination.");
  }
  return received;
}

function advanceCursor(seen: Set<string>, next: string): string {
  if (seen.has(next)) throw new Error("Hosted work-item sync cursor cycle detected.");
  seen.add(next);
  return next;
}

async function bootstrap(
  api: HostedWorkItemSyncApi,
  workspaceId: string,
): Promise<HostedWorkItemSyncState> {
  const items = new Map<string, HostedWorkItemSnapshot>();
  const seen = new Set<string>();
  let cursor: string | undefined;
  let checkpoint: string | undefined;

  for (;;) {
    const page = await api.bootstrapWorkItemSync(workspaceId, cursor);
    checkpoint = assertCheckpoint(checkpoint, page.checkpoint);
    for (const item of page.items) items.set(item.id, { ...item });
    if (page.nextCursor === null) {
      return { workspaceId, checkpoint, items: sortedItems(items) };
    }
    cursor = advanceCursor(seen, page.nextCursor);
  }
}

async function delta(
  api: HostedWorkItemSyncApi,
  workspaceId: string,
  previous: HostedWorkItemSyncState,
): Promise<HostedWorkItemSyncState> {
  const items = new Map(previous.items.map((item) => [item.id, { ...item }]));
  const seen = new Set([previous.checkpoint]);
  let cursor = previous.checkpoint;
  let checkpoint: string | undefined;

  for (;;) {
    const page = await api.listWorkItemSyncChanges(workspaceId, cursor);
    checkpoint = assertCheckpoint(checkpoint, page.checkpoint);
    for (const change of page.changes) {
      if (change.type === "delete") items.delete(change.workItemId);
      else items.set(change.item.id, { ...change.item });
    }
    if (page.nextCursor === null) {
      return { workspaceId, checkpoint, items: sortedItems(items) };
    }
    cursor = advanceCursor(seen, page.nextCursor);
  }
}

async function bootstrapAndCatchUp(
  api: HostedWorkItemSyncApi,
  workspaceId: string,
  retryExpired: boolean,
): Promise<HostedWorkItemSyncState> {
  const attempts = retryExpired ? 2 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await delta(api, workspaceId, await bootstrap(api, workspaceId));
    } catch (error) {
      if (!isGone(error) || attempt + 1 === attempts) throw error;
    }
  }
  throw new Error("Hosted work-item sync bootstrap restart limit exceeded.");
}

export async function reconcileHostedWorkItems(
  api: HostedWorkItemSyncApi,
  workspaceId: string,
  previous: HostedWorkItemSyncState | null,
): Promise<HostedWorkItemSyncState> {
  if (previous === null || previous.workspaceId !== workspaceId) {
    return bootstrapAndCatchUp(api, workspaceId, true);
  }
  try {
    return await delta(api, workspaceId, previous);
  } catch (error) {
    if (isGone(error)) return bootstrapAndCatchUp(api, workspaceId, false);
    throw error;
  }
}
