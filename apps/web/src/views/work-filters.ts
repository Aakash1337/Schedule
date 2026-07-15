import { addDays, localDateKey } from "../date";
import type { WorkItem, WorkItemStatus } from "../types";

export const ACTIVE_WORK_STATUSES: readonly WorkItemStatus[] = [
  "backlog",
  "planned",
  "in_progress",
  "blocked",
];

export type WorkStatusFilter = "active" | "all" | WorkItemStatus;
export type WorkDueDateFilter = "all" | "overdue" | "today" | "next_seven_days" | "later" | "none";

export interface WorkDiscoveryFilters {
  readonly query: string;
  readonly status: WorkStatusFilter;
  readonly dueDate: WorkDueDateFilter;
  readonly today: string;
}

function normalizedTerms(query: string): readonly string[] {
  return query.normalize("NFKC").trim().toLowerCase().split(/\s+/u).filter(Boolean);
}

function matchesQuery(item: WorkItem, query: string): boolean {
  const terms = normalizedTerms(query);
  if (terms.length === 0) return true;
  const searchableText = `${item.title}\n${item.description ?? ""}`.normalize("NFKC").toLowerCase();
  return terms.every((term) => searchableText.includes(term));
}

function localDateAfter(dateKey: string, days: number): string {
  const [year, month, day] = dateKey.split("-").map(Number);
  return localDateKey(addDays(new Date(year ?? 0, (month ?? 1) - 1, day ?? 1, 12), days));
}

function matchesDueDate(item: WorkItem, filter: WorkDueDateFilter, today: string): boolean {
  if (filter === "all") return true;
  if (filter === "none") return item.dueOn === null;
  if (item.dueOn === null) return false;
  if (filter === "overdue") return item.dueOn < today;
  if (filter === "today") return item.dueOn === today;
  const endOfNextSevenDays = localDateAfter(today, 7);
  if (filter === "next_seven_days") {
    return item.dueOn > today && item.dueOn <= endOfNextSevenDays;
  }
  return item.dueOn > endOfNextSevenDays;
}

function matchesStatus(status: WorkItemStatus, filter: WorkStatusFilter): boolean {
  if (filter === "all") return true;
  if (filter === "active") return ACTIVE_WORK_STATUSES.includes(status);
  return status === filter;
}

export function statusesForWorkFilter(filter: WorkStatusFilter): readonly WorkItemStatus[] {
  if (filter === "all") {
    return [...ACTIVE_WORK_STATUSES, "done", "cancelled"];
  }
  if (filter === "active") return ACTIVE_WORK_STATUSES;
  return [filter];
}

export function filterWorkItems(
  items: readonly WorkItem[],
  filters: WorkDiscoveryFilters,
): readonly WorkItem[] {
  return items.filter(
    (item) =>
      matchesStatus(item.status, filters.status) &&
      matchesDueDate(item, filters.dueDate, filters.today) &&
      matchesQuery(item, filters.query),
  );
}
