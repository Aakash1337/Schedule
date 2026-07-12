import { invariant } from "./errors.js";
import { workItemId, type WorkItemId, type WorkspaceId } from "./ids.js";

export const workItemStatuses = [
  "backlog",
  "planned",
  "in_progress",
  "blocked",
  "done",
  "cancelled",
] as const;
export type WorkItemStatus = (typeof workItemStatuses)[number];

export const workItemPriorities = ["none", "low", "medium", "high", "urgent"] as const;
export type WorkItemPriority = (typeof workItemPriorities)[number];

export interface WorkItem {
  readonly id: WorkItemId;
  readonly workspaceId: WorkspaceId;
  readonly title: string;
  readonly description: string | null;
  readonly status: WorkItemStatus;
  readonly priority: WorkItemPriority;
  readonly version: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateWorkItemInput {
  readonly id?: WorkItemId;
  readonly workspaceId: WorkspaceId;
  readonly title: string;
  readonly description?: string | null;
  readonly status?: WorkItemStatus;
  readonly priority?: WorkItemPriority;
  readonly now?: Date;
}

export function createWorkItem(input: CreateWorkItemInput): WorkItem {
  const title = input.title.trim();
  invariant(title.length > 0, "work_item.title_required", "A work item title is required.");
  invariant(
    title.length <= 240,
    "work_item.title_too_long",
    "A work item title cannot exceed 240 characters.",
  );
  const now = input.now ?? new Date();

  return {
    id: input.id ?? workItemId(),
    workspaceId: input.workspaceId,
    title,
    description: input.description?.trim() || null,
    status: input.status ?? "backlog",
    priority: input.priority ?? "none",
    version: 1,
    createdAt: new Date(now),
    updatedAt: new Date(now),
  };
}

export function changeWorkItemStatus(
  item: WorkItem,
  status: WorkItemStatus,
  now: Date = new Date(),
): WorkItem {
  if (item.status === status) return item;
  return { ...item, status, version: item.version + 1, updatedAt: new Date(now) };
}
