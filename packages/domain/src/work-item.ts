import { invariant } from "./errors.js";
import { isValidLocalDate, type LocalDate } from "./calendar.js";
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
export const maximumWorkItemVersion = 2_147_483_647;

export interface WorkItem {
  readonly id: WorkItemId;
  readonly workspaceId: WorkspaceId;
  readonly title: string;
  readonly description: string | null;
  readonly status: WorkItemStatus;
  readonly priority: WorkItemPriority;
  readonly dueOn: LocalDate | null;
  /** Null keeps conventional work out of the daily planner. */
  readonly planningDurationMinutes: number | null;
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
  readonly dueOn?: LocalDate | null;
  readonly planningDurationMinutes?: number | null;
  readonly now?: Date;
}

export interface UpdateWorkItemInput {
  readonly title?: string;
  readonly description?: string | null;
  readonly status?: WorkItemStatus;
  readonly priority?: WorkItemPriority;
  readonly dueOn?: LocalDate | null;
  readonly planningDurationMinutes?: number | null;
  readonly now: Date;
}

function normalizeTitle(value: unknown): string {
  invariant(
    typeof value === "string",
    "work_item.title_invalid",
    "A work item title must be text.",
  );
  const title = value.trim();
  invariant(title.length > 0, "work_item.title_required", "A work item title is required.");
  invariant(
    title.length <= 240,
    "work_item.title_too_long",
    "A work item title cannot exceed 240 characters.",
  );
  return title;
}

function normalizeDescription(value: unknown): string | null {
  invariant(
    value === null || typeof value === "string",
    "work_item.description_invalid",
    "A work item description must be text or null.",
  );
  const description = value?.trim() || null;
  invariant(
    description === null || description.length <= 4_000,
    "work_item.description_too_long",
    "A work item description cannot exceed 4,000 characters.",
  );
  return description;
}

function validateStatus(value: unknown): asserts value is WorkItemStatus {
  invariant(
    workItemStatuses.some((candidate) => candidate === value),
    "work_item.status_invalid",
    "A valid work item status is required.",
  );
}

function validatePriority(value: unknown): asserts value is WorkItemPriority {
  invariant(
    workItemPriorities.some((candidate) => candidate === value),
    "work_item.priority_invalid",
    "A valid work item priority is required.",
  );
}

function validatePlanningDuration(value: unknown): asserts value is number | null {
  invariant(
    value === null || (typeof value === "number" && Number.isInteger(value) && value > 0),
    "work_item.planning_duration_invalid",
    "A planning duration must be a positive whole number of minutes or null.",
  );
}

function validateDueOn(value: unknown): asserts value is LocalDate | null {
  invariant(
    value === null || (typeof value === "string" && isValidLocalDate(value)),
    "work_item.due_on_invalid",
    "A due date must be a valid Gregorian local date in YYYY-MM-DD format or null.",
  );
}

function validateTimestamp(value: unknown): asserts value is Date {
  invariant(
    value instanceof Date && Number.isFinite(value.getTime()),
    "work_item.timestamp_invalid",
    "A valid timestamp is required.",
  );
}

function validateExistingWorkItem(item: WorkItem): void {
  validateStatus(item.status);
  validatePriority(item.priority);
  validateDueOn(item.dueOn);
  validatePlanningDuration(item.planningDurationMinutes);
  invariant(
    Number.isInteger(item.version) && item.version >= 1 && item.version <= maximumWorkItemVersion,
    "work_item.version_invalid",
    "The work item has an invalid version.",
  );
}

export function createWorkItem(input: CreateWorkItemInput): WorkItem {
  const title = normalizeTitle(input.title);
  const description = normalizeDescription(input.description ?? null);
  const status = input.status === undefined ? "backlog" : input.status;
  validateStatus(status);
  const priority = input.priority === undefined ? "none" : input.priority;
  validatePriority(priority);
  const dueOn = input.dueOn ?? null;
  validateDueOn(dueOn);
  const planningDurationMinutes = input.planningDurationMinutes ?? null;
  validatePlanningDuration(planningDurationMinutes);
  const now = input.now ?? new Date();
  validateTimestamp(now);

  return {
    id: input.id ?? workItemId(),
    workspaceId: input.workspaceId,
    title,
    description,
    status,
    priority,
    dueOn,
    planningDurationMinutes,
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
  return updateWorkItem(item, { status, now });
}

export function updateWorkItem(item: WorkItem, input: UpdateWorkItemInput): WorkItem {
  validateExistingWorkItem(item);
  validateTimestamp(input.now);

  const title = input.title === undefined ? item.title : normalizeTitle(input.title);
  const description =
    input.description === undefined ? item.description : normalizeDescription(input.description);
  const status = input.status === undefined ? item.status : input.status;
  validateStatus(status);
  const priority = input.priority === undefined ? item.priority : input.priority;
  validatePriority(priority);
  const dueOn = input.dueOn === undefined ? item.dueOn : input.dueOn;
  validateDueOn(dueOn);
  const planningDurationMinutes =
    input.planningDurationMinutes === undefined
      ? item.planningDurationMinutes
      : input.planningDurationMinutes;
  validatePlanningDuration(planningDurationMinutes);

  if (
    title === item.title &&
    description === item.description &&
    status === item.status &&
    priority === item.priority &&
    dueOn === item.dueOn &&
    planningDurationMinutes === item.planningDurationMinutes
  ) {
    return item;
  }

  invariant(
    item.version < maximumWorkItemVersion,
    "work_item.version_exhausted",
    "The work item has reached its maximum supported version.",
  );

  return {
    ...item,
    title,
    description,
    status,
    priority,
    dueOn,
    planningDurationMinutes,
    version: item.version + 1,
    updatedAt: new Date(input.now),
  };
}
