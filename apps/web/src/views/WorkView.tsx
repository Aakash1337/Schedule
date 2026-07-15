import { ChevronDown, Pencil, Plus, RefreshCw, ShieldCheck, Sparkles, X } from "lucide-react";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";

import { api, ApiError } from "../api";
import { Button, EmptyState, ErrorNotice, Field, PageHeader, PageSkeleton } from "../components/ui";
import { todayKey } from "../date";
import type {
  WorkItem,
  WorkItemDependency,
  NaturalLanguageProposal,
  WorkItemPriority,
  WorkItemStatus,
  WorkspaceViewProps,
} from "../types";
import {
  filterWorkItems,
  statusesForWorkFilter,
  type WorkDueDateFilter,
  type WorkStatusFilter,
} from "./work-filters";

const statuses: readonly { readonly value: WorkItemStatus; readonly label: string }[] = [
  { value: "backlog", label: "Backlog" },
  { value: "planned", label: "Planned" },
  { value: "in_progress", label: "In progress" },
  { value: "blocked", label: "Blocked" },
  { value: "done", label: "Done" },
  { value: "cancelled", label: "Cancelled" },
];

const priorities: readonly { readonly value: WorkItemPriority; readonly label: string }[] = [
  { value: "none", label: "No priority" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
  { value: "urgent", label: "Urgent" },
];

type PriorityFilter = WorkItemPriority | "";

const workStatusFilters: readonly { readonly value: WorkStatusFilter; readonly label: string }[] = [
  { value: "active", label: "Active work" },
  { value: "all", label: "All statuses" },
  ...statuses,
];

const workDueDateFilters: readonly {
  readonly value: WorkDueDateFilter;
  readonly label: string;
}[] = [
  { value: "all", label: "All due dates" },
  { value: "overdue", label: "Overdue" },
  { value: "today", label: "Due today" },
  { value: "next_seven_days", label: "Next 7 days" },
  { value: "later", label: "Later" },
  { value: "none", label: "No due date" },
];

function useLocalToday(): string {
  const [localToday, setLocalToday] = useState(() => todayKey());

  useEffect(() => {
    let timeoutId: number | undefined;

    function refreshToday(): void {
      const now = new Date();
      const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      setLocalToday(todayKey(now));
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      timeoutId = window.setTimeout(
        refreshToday,
        Math.max(1, nextMidnight.getTime() - now.getTime() + 1_000),
      );
    }

    function refreshVisibleToday(): void {
      if (!document.hidden) refreshToday();
    }

    refreshToday();
    window.addEventListener("focus", refreshToday);
    document.addEventListener("visibilitychange", refreshVisibleToday);
    return () => {
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      window.removeEventListener("focus", refreshToday);
      document.removeEventListener("visibilitychange", refreshVisibleToday);
    };
  }, []);

  return localToday;
}

interface BoardData {
  readonly queryKey: string;
  readonly items: readonly WorkItem[];
  readonly allItems: readonly WorkItem[];
  readonly dependencies: readonly WorkItemDependency[];
}

interface WorkspaceDependencyData {
  readonly workspaceId: string;
  readonly allItems: readonly WorkItem[];
  readonly dependencies: readonly WorkItemDependency[];
}

interface WorkEditDraft {
  readonly id: string;
  readonly parentWorkItemId: string;
  readonly title: string;
  readonly description: string;
  readonly dueOn: string;
  readonly includeInDailyPlan: boolean;
  readonly planningDurationMinutes: string;
}

function queryKey(workspaceId: string, priority: PriorityFilter): string {
  return `${workspaceId}:${priority || "all"}`;
}

function mergeWorkItems(
  current: readonly WorkItem[],
  fresh: readonly WorkItem[],
): readonly WorkItem[] {
  const mergedById = new Map(current.map((item) => [item.id, item] as const));
  const currentIds = new Set(current.map((item) => item.id));
  for (const item of fresh) {
    const existing = mergedById.get(item.id);
    if (existing === undefined || item.version >= existing.version) mergedById.set(item.id, item);
  }
  return [
    ...current.map((item) => mergedById.get(item.id) ?? item),
    ...fresh
      .filter((item) => !currentIds.has(item.id))
      .map((item) => mergedById.get(item.id) ?? item),
  ];
}

function descendantWorkItemIds(
  rootId: string,
  childrenByParentId: ReadonlyMap<string, readonly WorkItem[]>,
): ReadonlySet<string> {
  const descendants = new Set<string>();
  const pending = [...(childrenByParentId.get(rootId) ?? [])];
  while (pending.length > 0) {
    const child = pending.pop();
    if (child === undefined || descendants.has(child.id)) continue;
    descendants.add(child.id);
    pending.push(...(childrenByParentId.get(child.id) ?? []));
  }
  return descendants;
}

const emptyDescendantWorkItemIds: ReadonlySet<string> = new Set();

function messageFor(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "The work board could not be updated.";
}

function proposalUnavailableMessage(reason: string | null): string {
  if (reason === "disabled") {
    return "Local work drafting is off. Enable the local proposal model to use this capture path.";
  }
  if (reason === "busy")
    return "The local model is busy. Your text is safe here; try again shortly.";
  if (reason === "timeout")
    return "The local model took too long. Your text is still here to retry.";
  if (reason === "no_proposal") {
    return "Describe one concrete work item. No work item was created.";
  }
  return "The local model could not prepare a safe proposal. No work item was created.";
}

function priorityLabel(priority: WorkItemPriority): string {
  return priorities.find((option) => option.value === priority)?.label ?? priority;
}

function statusLabel(status: WorkItemStatus): string {
  return statuses.find((option) => option.value === status)?.label ?? status;
}

function dependencyMessageFor(error: unknown): string {
  if (error instanceof ApiError && error.code === "work_item_dependency.cycle_conflict") {
    return "That prerequisite would create a cycle. Choose a different work item.";
  }
  return messageFor(error);
}

function workItemMessageFor(error: unknown): string {
  if (error instanceof ApiError && error.code === "work_item_hierarchy.cycle_conflict") {
    return "That parent would create a cycle. Choose an item outside this subtask branch.";
  }
  if (error instanceof ApiError && error.code === "work_item_hierarchy.self_reference_invalid") {
    return "A work item cannot be its own parent.";
  }
  if (error instanceof ApiError && error.code === "work_item.not_found") {
    return "That parent is no longer available. Refresh the board and choose another item.";
  }
  return messageFor(error);
}

function isPlanningDurationValid(value: string, included: boolean): boolean {
  if (!included) return true;
  const duration = Number(value);
  return Number.isInteger(duration) && duration > 0 && duration <= 43_200;
}

function formatDueOn(dueOn: string): string {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(`${dueOn}T12:00:00`));
}

export function WorkView({ workspace }: WorkspaceViewProps) {
  const [priorityFilter, setPriorityFilter] = useState<PriorityFilter>("");
  const [statusFilter, setStatusFilter] = useState<WorkStatusFilter>("active");
  const [dueDateFilter, setDueDateFilter] = useState<WorkDueDateFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const statusFilterRef = useRef<HTMLSelectElement>(null);
  const [board, setBoard] = useState<BoardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [pendingItemIds, setPendingItemIds] = useState<ReadonlySet<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [newStatus, setNewStatus] = useState<WorkItemStatus>("backlog");
  const [newPriority, setNewPriority] = useState<WorkItemPriority>("none");
  const [newDueOn, setNewDueOn] = useState("");
  const [newParentWorkItemId, setNewParentWorkItemId] = useState<string | null>(null);
  const [includeInDailyPlan, setIncludeInDailyPlan] = useState(false);
  const [planningDurationMinutes, setPlanningDurationMinutes] = useState("30");
  const titleInputRef = useRef<HTMLInputElement>(null);
  const [proposalOpen, setProposalOpen] = useState(false);
  const [proposalPrompt, setProposalPrompt] = useState("");
  const [proposal, setProposal] = useState<NaturalLanguageProposal | null>(null);
  const [proposalTitle, setProposalTitle] = useState("");
  const [proposalPriority, setProposalPriority] = useState<WorkItemPriority>("none");
  const [proposalDueOn, setProposalDueOn] = useState("");
  const [proposalIncludeInDailyPlan, setProposalIncludeInDailyPlan] = useState(false);
  const [proposalPlanningDurationMinutes, setProposalPlanningDurationMinutes] = useState("30");
  const [proposalSummary, setProposalSummary] = useState<string | null>(null);
  const [proposalWarnings, setProposalWarnings] = useState<readonly string[]>([]);
  const [proposalBusy, setProposalBusy] = useState<
    "proposing" | "confirming" | "cancelling" | null
  >(null);
  const [proposalError, setProposalError] = useState<string | null>(null);
  const [proposalAnnouncement, setProposalAnnouncement] = useState<string | null>(null);
  const [recentlyCreatedItemId, setRecentlyCreatedItemId] = useState<string | null>(null);
  const proposalPromptRef = useRef<HTMLTextAreaElement>(null);
  const proposalOpenerRef = useRef<HTMLElement | null>(null);
  const proposalAbortRef = useRef<AbortController | null>(null);
  const proposalOperationRef = useRef(0);
  const proposalWorkspaceRef = useRef(workspace.id);
  const confirmationKeyRef = useRef<string | null>(null);
  const editOpenerRef = useRef<HTMLElement | null>(null);
  const [editDraft, setEditDraft] = useState<WorkEditDraft | null>(null);
  const [prerequisiteSelections, setPrerequisiteSelections] = useState<
    Readonly<Record<string, string>>
  >({});
  const [dependencyPendingTokens, setDependencyPendingTokens] = useState<
    ReadonlyMap<string, string>
  >(new Map());
  const [dependencyErrors, setDependencyErrors] = useState<
    Readonly<Record<string, string | undefined>>
  >({});
  const [dependencyAnnouncements, setDependencyAnnouncements] = useState<
    Readonly<Record<string, string | undefined>>
  >({});
  const [openDependencyEditorId, setOpenDependencyEditorId] = useState<string | null>(null);
  const dependencyRequestSequence = useRef(0);
  const workspaceDependencyDataRef = useRef<WorkspaceDependencyData | null>(null);
  const prerequisiteSelectRefs = useRef(new Map<string, HTMLSelectElement>());
  const prerequisiteSummaryRefs = useRef(new Map<string, HTMLElement>());

  const activeQueryKey = queryKey(workspace.id, priorityFilter);
  const activeQueryKeyRef = useRef(activeQueryKey);
  activeQueryKeyRef.current = activeQueryKey;
  proposalWorkspaceRef.current = workspace.id;

  const loadBoard = useCallback(
    async (signal?: AbortSignal, revalidateWorkspaceData = false) => {
      const requestKey = queryKey(workspace.id, priorityFilter);
      setLoading(true);
      setLoadError(null);
      try {
        const cachedWorkspaceData =
          workspaceDependencyDataRef.current?.workspaceId === workspace.id
            ? workspaceDependencyDataRef.current
            : null;
        const filteredItemsRequest = api.listWorkItems(
          workspace.id,
          priorityFilter === "" ? {} : { priority: priorityFilter },
          signal,
        );
        const workspaceDataRequest =
          cachedWorkspaceData === null || revalidateWorkspaceData
            ? Promise.all([
                priorityFilter === ""
                  ? filteredItemsRequest
                  : api.listWorkItems(workspace.id, {}, signal),
                api.listWorkItemDependencies(workspace.id, signal),
              ]).then(([allItems, dependencies]): WorkspaceDependencyData => ({
                workspaceId: workspace.id,
                allItems: allItems.items,
                dependencies: dependencies.items,
              }))
            : Promise.resolve(cachedWorkspaceData);
        const [result, workspaceData] = await Promise.all([
          filteredItemsRequest,
          workspaceDataRequest,
        ]);
        if (!signal?.aborted && activeQueryKeyRef.current === requestKey) {
          const mergedWorkspaceData = {
            ...workspaceData,
            allItems: mergeWorkItems(workspaceData.allItems, result.items),
          };
          const mergedItemsById = new Map(
            mergedWorkspaceData.allItems.map((item) => [item.id, item] as const),
          );
          const resultItems = (
            revalidateWorkspaceData ? mergedWorkspaceData.allItems : result.items
          )
            .map((item) => mergedItemsById.get(item.id) ?? item)
            .filter((item) => priorityFilter === "" || item.priority === priorityFilter);
          workspaceDependencyDataRef.current = mergedWorkspaceData;
          setBoard({
            queryKey: requestKey,
            items: resultItems,
            allItems: mergedWorkspaceData.allItems,
            dependencies: mergedWorkspaceData.dependencies,
          });
        }
      } catch (error) {
        if (!signal?.aborted && activeQueryKeyRef.current === requestKey) {
          setLoadError(messageFor(error));
        }
      } finally {
        if (!signal?.aborted && activeQueryKeyRef.current === requestKey) setLoading(false);
      }
    },
    [priorityFilter, workspace.id],
  );

  useEffect(() => {
    if (workspaceDependencyDataRef.current?.workspaceId !== workspace.id) {
      workspaceDependencyDataRef.current = null;
    }
  }, [workspace.id]);

  useEffect(() => {
    proposalAbortRef.current?.abort();
    proposalAbortRef.current = null;
    proposalOperationRef.current += 1;
    confirmationKeyRef.current = null;
    setProposalOpen(false);
    setProposalPrompt("");
    setProposal(null);
    setProposalTitle("");
    setProposalPriority("none");
    setProposalDueOn("");
    setProposalIncludeInDailyPlan(false);
    setProposalPlanningDurationMinutes("30");
    setProposalSummary(null);
    setProposalWarnings([]);
    setProposalBusy(null);
    setProposalError(null);
    setProposalAnnouncement(null);
    setRecentlyCreatedItemId(null);
    setNewParentWorkItemId(null);
    return () => {
      proposalAbortRef.current?.abort();
      proposalOperationRef.current += 1;
    };
  }, [workspace.id]);

  useEffect(() => {
    if (!proposalOpen) return;
    window.setTimeout(() => proposalPromptRef.current?.focus());
  }, [proposalOpen]);

  useEffect(() => {
    const controller = new AbortController();
    setActionError(null);
    setCreateError(null);
    setEditDraft(null);
    setPrerequisiteSelections({});
    setDependencyPendingTokens(new Map());
    setDependencyErrors({});
    setDependencyAnnouncements({});
    setOpenDependencyEditorId(null);
    void loadBoard(controller.signal);
    return () => controller.abort();
  }, [loadBoard]);

  const items = board?.queryKey === activeQueryKey ? board.items : null;
  const allItems = board?.queryKey === activeQueryKey ? board.allItems : null;
  const dependencies = board?.queryKey === activeQueryKey ? board.dependencies : null;
  const allItemsById = useMemo(
    () => new Map((allItems ?? []).map((item) => [item.id, item] as const)),
    [allItems],
  );
  const childrenByParentId = useMemo(() => {
    const grouped = new Map<string, WorkItem[]>();
    for (const candidate of allItems ?? []) {
      if (candidate.parentWorkItemId === null) continue;
      const current = grouped.get(candidate.parentWorkItemId) ?? [];
      current.push(candidate);
      grouped.set(candidate.parentWorkItemId, current);
    }
    for (const children of grouped.values()) {
      children.sort((left, right) => left.title.localeCompare(right.title));
    }
    return grouped;
  }, [allItems]);
  const editedWorkItemId = editDraft?.id ?? null;
  const editedDescendantWorkItemIds = useMemo(
    () =>
      editedWorkItemId === null
        ? emptyDescendantWorkItemIds
        : descendantWorkItemIds(editedWorkItemId, childrenByParentId),
    [childrenByParentId, editedWorkItemId],
  );
  const dependenciesByDependentId = useMemo(() => {
    const grouped = new Map<string, WorkItemDependency[]>();
    for (const dependency of dependencies ?? []) {
      const current = grouped.get(dependency.dependentWorkItemId) ?? [];
      current.push(dependency);
      grouped.set(dependency.dependentWorkItemId, current);
    }
    return grouped;
  }, [dependencies]);
  const localToday = useLocalToday();
  const visibleItems = useMemo(
    () =>
      filterWorkItems(items ?? [], {
        query: deferredSearchQuery,
        status: statusFilter,
        dueDate: dueDateFilter,
        today: localToday,
      }),
    [deferredSearchQuery, dueDateFilter, items, localToday, statusFilter],
  );
  useEffect(() => {
    if (
      recentlyCreatedItemId === null ||
      visibleItems.some((item) => item.id === recentlyCreatedItemId) !== true
    ) {
      return;
    }
    const timeoutId = window.setTimeout(() => {
      const card = document.getElementById(`work-item-${recentlyCreatedItemId}`);
      if (card === null) return;
      card.focus();
      setRecentlyCreatedItemId(null);
    });
    return () => window.clearTimeout(timeoutId);
  }, [recentlyCreatedItemId, visibleItems]);
  const visibleStatuses = useMemo(() => statusesForWorkFilter(statusFilter), [statusFilter]);
  const itemsByStatus = useMemo(() => {
    const grouped = new Map<WorkItemStatus, readonly WorkItem[]>();
    for (const status of visibleStatuses) {
      grouped.set(
        status,
        visibleItems.filter((item) => item.status === status),
      );
    }
    return grouped;
  }, [visibleItems, visibleStatuses]);
  const filtersAreDefault =
    searchQuery.trim() === "" &&
    statusFilter === "active" &&
    dueDateFilter === "all" &&
    priorityFilter === "";
  const totalWorkItemCount = allItems?.length ?? 0;
  const newPlanningDurationIsValid = isPlanningDurationValid(
    planningDurationMinutes,
    includeInDailyPlan,
  );
  const selectedComposerParent =
    newParentWorkItemId === null ? null : (allItemsById.get(newParentWorkItemId) ?? null);

  function resetFilters(focusSearch = false): void {
    setSearchQuery("");
    setStatusFilter("active");
    setDueDateFilter("all");
    setPriorityFilter("");
    if (focusSearch) window.setTimeout(() => searchInputRef.current?.focus());
  }

  function showTerminalWork(): void {
    setStatusFilter("all");
    window.setTimeout(() => statusFilterRef.current?.focus());
  }

  function updateWorkspaceDependencyData(
    workspaceId: string,
    update: (current: WorkspaceDependencyData) => WorkspaceDependencyData,
  ): void {
    const current = workspaceDependencyDataRef.current;
    if (current?.workspaceId !== workspaceId) return;
    workspaceDependencyDataRef.current = update(current);
  }

  async function createItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedTitle = title.trim();
    const parsedPlanningDuration = includeInDailyPlan ? Number(planningDurationMinutes) : null;
    const planningDurationIsValid = isPlanningDurationValid(
      planningDurationMinutes,
      includeInDailyPlan,
    );
    if (normalizedTitle.length === 0 || creating || !planningDurationIsValid) return;

    const requestWorkspaceId = workspace.id;
    const requestKey = activeQueryKey;
    setCreating(true);
    setCreateError(null);
    try {
      const input = {
        title: normalizedTitle,
        description: description.trim().length === 0 ? null : description.trim(),
        status: newStatus,
        priority: newPriority,
        dueOn: newDueOn || null,
        planningDurationMinutes: parsedPlanningDuration,
      };
      const requestedParentWorkItemId = newParentWorkItemId;
      const created =
        requestedParentWorkItemId === null
          ? await api.createWorkItem(requestWorkspaceId, input)
          : await api.createSubtask(requestWorkspaceId, requestedParentWorkItemId, input);
      if (activeQueryKeyRef.current === requestKey) {
        updateWorkspaceDependencyData(requestWorkspaceId, (current) => ({
          ...current,
          allItems: current.allItems.some((item) => item.id === created.id)
            ? current.allItems.map((item) => (item.id === created.id ? created : item))
            : [...current.allItems, created],
        }));
        setBoard((current) => {
          if (current?.queryKey !== requestKey) return current;
          const allItems = current.allItems.some((item) => item.id === created.id)
            ? current.allItems.map((item) => (item.id === created.id ? created : item))
            : [...current.allItems, created];
          const items =
            priorityFilter !== "" && created.priority !== priorityFilter
              ? current.items
              : [...current.items, created];
          return { ...current, items, allItems };
        });
      }
      setTitle("");
      setDescription("");
      setNewStatus("backlog");
      setNewPriority("none");
      setNewDueOn("");
      setNewParentWorkItemId(null);
      setIncludeInDailyPlan(false);
      setPlanningDurationMinutes("30");
      if (requestedParentWorkItemId === null) {
        titleInputRef.current?.focus();
      } else if (priorityFilter === "" || created.priority === priorityFilter) {
        setRecentlyCreatedItemId(created.id);
      }
    } catch (error) {
      if (activeQueryKeyRef.current === requestKey) setCreateError(messageFor(error));
    } finally {
      setCreating(false);
    }
  }

  function openEdit(item: WorkItem) {
    editOpenerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setEditDraft({
      id: item.id,
      parentWorkItemId: item.parentWorkItemId ?? "",
      title: item.title,
      description: item.description ?? "",
      dueOn: item.dueOn ?? "",
      includeInDailyPlan: item.planningDurationMinutes !== null,
      planningDurationMinutes:
        item.planningDurationMinutes === null ? "30" : String(item.planningDurationMinutes),
    });
  }

  function closeEdit() {
    setEditDraft(null);
    window.setTimeout(() => {
      const opener = editOpenerRef.current;
      if (opener?.isConnected === true) opener.focus();
      editOpenerRef.current = null;
    });
  }

  async function refreshAfterConflict(
    requestKey: string,
    requestWorkspaceId: string,
    itemId: string,
  ) {
    setActionError("This work item changed elsewhere. Refreshing the board now.");
    try {
      const filteredItemsRequest = api.listWorkItems(
        requestWorkspaceId,
        priorityFilter === "" ? {} : { priority: priorityFilter },
      );
      const allItemsRequest =
        priorityFilter === "" ? filteredItemsRequest : api.listWorkItems(requestWorkspaceId, {});
      const [result, allItems, dependencies] = await Promise.all([
        filteredItemsRequest,
        allItemsRequest,
        api.listWorkItemDependencies(requestWorkspaceId),
      ]);
      if (activeQueryKeyRef.current !== requestKey) return;
      workspaceDependencyDataRef.current = {
        workspaceId: requestWorkspaceId,
        allItems: allItems.items,
        dependencies: dependencies.items,
      };
      setBoard({
        queryKey: requestKey,
        items: result.items,
        allItems: allItems.items,
        dependencies: dependencies.items,
      });
      if (editDraft?.id === itemId) closeEdit();
      setActionError(
        "This work item changed elsewhere. The board has been refreshed and unsaved detail edits were not applied.",
      );
    } catch (error) {
      if (activeQueryKeyRef.current === requestKey) {
        setActionError(
          `This work item changed elsewhere, and the board could not be refreshed. ${messageFor(error)}`,
        );
      }
    }
  }

  async function updateItem(
    item: WorkItem,
    changes: {
      readonly title?: string;
      readonly parentWorkItemId?: string | null;
      readonly description?: string | null;
      readonly status?: WorkItemStatus;
      readonly priority?: WorkItemPriority;
      readonly dueOn?: string | null;
      readonly planningDurationMinutes?: number | null;
    },
  ): Promise<boolean> {
    if (pendingItemIds.has(item.id)) return false;

    const requestWorkspaceId = workspace.id;
    const requestKey = activeQueryKey;
    setPendingItemIds((current) => new Set(current).add(item.id));
    setActionError(null);
    try {
      const updated = await api.updateWorkItem(requestWorkspaceId, item.id, {
        expectedVersion: item.version,
        ...changes,
      });
      if (activeQueryKeyRef.current !== requestKey) return false;

      updateWorkspaceDependencyData(requestWorkspaceId, (current) => ({
        ...current,
        allItems: current.allItems.map((candidate) =>
          candidate.id === updated.id ? updated : candidate,
        ),
      }));

      setBoard((current) => {
        if (current?.queryKey !== requestKey) return current;
        const updatedItems = current.items.map((candidate) =>
          candidate.id === updated.id ? updated : candidate,
        );
        const updatedAllItems = current.allItems.map((candidate) =>
          candidate.id === updated.id ? updated : candidate,
        );
        return {
          ...current,
          allItems: updatedAllItems,
          items:
            priorityFilter === "" || updated.priority === priorityFilter
              ? updatedItems
              : updatedItems.filter((candidate) => candidate.id !== updated.id),
        };
      });
      return true;
    } catch (error) {
      if (activeQueryKeyRef.current !== requestKey) return false;
      if (error instanceof ApiError && error.code === "work_item.version_conflict") {
        await refreshAfterConflict(requestKey, requestWorkspaceId, item.id);
      } else {
        setActionError(workItemMessageFor(error));
      }
      return false;
    } finally {
      setPendingItemIds((current) => {
        const next = new Set(current);
        next.delete(item.id);
        return next;
      });
    }
  }

  async function saveDetails(event: FormEvent<HTMLFormElement>, item: WorkItem) {
    event.preventDefault();
    if (editDraft?.id !== item.id) return;
    const normalizedTitle = editDraft.title.trim();
    const parsedPlanningDuration = editDraft.includeInDailyPlan
      ? Number(editDraft.planningDurationMinutes)
      : null;
    const planningDurationIsValid = isPlanningDurationValid(
      editDraft.planningDurationMinutes,
      editDraft.includeInDailyPlan,
    );
    if (normalizedTitle.length === 0 || !planningDurationIsValid) return;
    const saved = await updateItem(item, {
      parentWorkItemId: editDraft.parentWorkItemId || null,
      title: normalizedTitle,
      description: editDraft.description.trim() || null,
      dueOn: editDraft.dueOn || null,
      planningDurationMinutes: parsedPlanningDuration,
    });
    if (saved) closeEdit();
  }

  function beginSubtask(parent: WorkItem): void {
    setNewParentWorkItemId(parent.id);
    setCreateError(null);
    window.setTimeout(() => {
      titleInputRef.current?.scrollIntoView?.({ block: "center", behavior: "smooth" });
      titleInputRef.current?.focus();
    });
  }

  function revealWorkItem(itemId: string): void {
    const card = document.getElementById(`work-item-${itemId}`);
    if (card !== null) {
      card?.scrollIntoView?.({ block: "nearest", behavior: "smooth" });
      card?.focus();
      return;
    }
    const target = allItemsById.get(itemId);
    if (target === undefined) return;
    setSearchQuery("");
    setDueDateFilter("all");
    setStatusFilter(target.status);
    if (priorityFilter !== "" && priorityFilter !== target.priority) setPriorityFilter("");
    setRecentlyCreatedItemId(itemId);
  }

  function beginDependencyMutation(itemId: string, requestKey: string): string | null {
    if (dependencyPendingTokens.has(itemId)) return null;
    const token = `${requestKey}:${dependencyRequestSequence.current + 1}`;
    dependencyRequestSequence.current += 1;
    setDependencyPendingTokens((current) => {
      const next = new Map(current);
      next.set(itemId, token);
      return next;
    });
    setDependencyErrors((current) => ({ ...current, [itemId]: undefined }));
    setDependencyAnnouncements((current) => ({ ...current, [itemId]: undefined }));
    return token;
  }

  function finishDependencyMutation(itemId: string, token: string): void {
    setDependencyPendingTokens((current) => {
      if (current.get(itemId) !== token) return current;
      const next = new Map(current);
      next.delete(itemId);
      return next;
    });
  }

  function focusDependencyEditor(
    itemId: string,
    requestKey: string,
    target: "select" | "summary",
  ): void {
    window.setTimeout(() => {
      if (activeQueryKeyRef.current !== requestKey) return;
      const element =
        target === "select"
          ? prerequisiteSelectRefs.current.get(itemId)
          : prerequisiteSummaryRefs.current.get(itemId);
      element?.focus();
    });
  }

  async function addPrerequisite(event: FormEvent<HTMLFormElement>, item: WorkItem): Promise<void> {
    event.preventDefault();
    const prerequisiteWorkItemId = prerequisiteSelections[item.id] ?? "";
    const prerequisite = allItemsById.get(prerequisiteWorkItemId);
    const currentDependencies = dependenciesByDependentId.get(item.id) ?? [];
    if (
      prerequisiteWorkItemId.length === 0 ||
      prerequisite === undefined ||
      prerequisite.workspaceId !== workspace.id ||
      prerequisiteWorkItemId === item.id ||
      currentDependencies.some(
        (dependency) => dependency.prerequisiteWorkItemId === prerequisiteWorkItemId,
      )
    ) {
      return;
    }

    const requestWorkspaceId = workspace.id;
    const requestKey = activeQueryKey;
    const token = beginDependencyMutation(item.id, requestKey);
    if (token === null) return;
    const candidateCount = (allItems ?? []).filter(
      (candidate) =>
        candidate.id !== item.id &&
        !currentDependencies.some(
          (dependency) => dependency.prerequisiteWorkItemId === candidate.id,
        ),
    ).length;

    try {
      const dependency = await api.addWorkItemPrerequisite(
        requestWorkspaceId,
        item.id,
        prerequisiteWorkItemId,
      );
      if (activeQueryKeyRef.current !== requestKey) return;
      if (
        dependency.workspaceId !== requestWorkspaceId ||
        dependency.dependentWorkItemId !== item.id ||
        dependency.prerequisiteWorkItemId !== prerequisiteWorkItemId
      ) {
        throw new Error("The prerequisite response did not match the requested work items.");
      }
      setBoard((current) => {
        if (current?.queryKey !== requestKey) return current;
        const exists = current.dependencies.some(
          (candidate) =>
            candidate.dependentWorkItemId === dependency.dependentWorkItemId &&
            candidate.prerequisiteWorkItemId === dependency.prerequisiteWorkItemId,
        );
        return exists
          ? current
          : { ...current, dependencies: [...current.dependencies, dependency] };
      });
      updateWorkspaceDependencyData(requestWorkspaceId, (current) => {
        const exists = current.dependencies.some(
          (candidate) =>
            candidate.dependentWorkItemId === dependency.dependentWorkItemId &&
            candidate.prerequisiteWorkItemId === dependency.prerequisiteWorkItemId,
        );
        return exists
          ? current
          : { ...current, dependencies: [...current.dependencies, dependency] };
      });
      setPrerequisiteSelections((current) => ({ ...current, [item.id]: "" }));
      setDependencyAnnouncements((current) => ({
        ...current,
        [item.id]: `${prerequisite.title} is now a prerequisite. The work item status was not changed.`,
      }));
      focusDependencyEditor(item.id, requestKey, candidateCount > 1 ? "select" : "summary");
    } catch (error) {
      if (activeQueryKeyRef.current === requestKey) {
        setDependencyErrors((current) => ({
          ...current,
          [item.id]: dependencyMessageFor(error),
        }));
      }
    } finally {
      finishDependencyMutation(item.id, token);
    }
  }

  async function removePrerequisite(item: WorkItem, prerequisiteWorkItemId: string): Promise<void> {
    const requestWorkspaceId = workspace.id;
    const requestKey = activeQueryKey;
    const token = beginDependencyMutation(item.id, requestKey);
    if (token === null) return;
    const prerequisiteTitle = allItemsById.get(prerequisiteWorkItemId)?.title ?? "The prerequisite";

    try {
      await api.removeWorkItemPrerequisite(requestWorkspaceId, item.id, prerequisiteWorkItemId);
      if (activeQueryKeyRef.current !== requestKey) return;
      setBoard((current) =>
        current?.queryKey !== requestKey
          ? current
          : {
              ...current,
              dependencies: current.dependencies.filter(
                (dependency) =>
                  dependency.dependentWorkItemId !== item.id ||
                  dependency.prerequisiteWorkItemId !== prerequisiteWorkItemId,
              ),
            },
      );
      updateWorkspaceDependencyData(requestWorkspaceId, (current) => ({
        ...current,
        dependencies: current.dependencies.filter(
          (dependency) =>
            dependency.dependentWorkItemId !== item.id ||
            dependency.prerequisiteWorkItemId !== prerequisiteWorkItemId,
        ),
      }));
      setDependencyAnnouncements((current) => ({
        ...current,
        [item.id]: `${prerequisiteTitle} is no longer a prerequisite. The work item status was not changed.`,
      }));
      focusDependencyEditor(item.id, requestKey, "summary");
    } catch (error) {
      if (activeQueryKeyRef.current === requestKey) {
        setDependencyErrors((current) => ({
          ...current,
          [item.id]: dependencyMessageFor(error),
        }));
      }
    } finally {
      finishDependencyMutation(item.id, token);
    }
  }

  function beginProposalOperation(): {
    readonly controller: AbortController;
    readonly operation: number;
    readonly workspaceId: string;
  } {
    proposalAbortRef.current?.abort();
    const controller = new AbortController();
    proposalAbortRef.current = controller;
    proposalOperationRef.current += 1;
    return {
      controller,
      operation: proposalOperationRef.current,
      workspaceId: workspace.id,
    };
  }

  function proposalOperationIsCurrent(operation: number, requestWorkspaceId: string): boolean {
    return (
      proposalOperationRef.current === operation &&
      proposalWorkspaceRef.current === requestWorkspaceId
    );
  }

  function openProposalPanel(): void {
    proposalOpenerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setProposalOpen(true);
    setProposalError(null);
  }

  function closeProposalPanel(): void {
    if (proposalBusy === "confirming" || proposalBusy === "cancelling") return;
    if (proposalBusy === "proposing") {
      proposalAbortRef.current?.abort();
      proposalOperationRef.current += 1;
      setProposalBusy(null);
    }
    setProposalOpen(false);
    window.setTimeout(() => {
      const opener = proposalOpenerRef.current;
      if (opener?.isConnected === true) opener.focus();
    });
  }

  async function prepareProposal(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const prompt = proposalPrompt.trim();
    if (prompt.length === 0 || proposalBusy !== null) return;
    const request = beginProposalOperation();
    const requestId = globalThis.crypto.randomUUID();
    confirmationKeyRef.current = null;
    setProposal(null);
    setProposalTitle("");
    setProposalPriority("none");
    setProposalDueOn("");
    setProposalIncludeInDailyPlan(false);
    setProposalPlanningDurationMinutes("30");
    setProposalSummary(null);
    setProposalWarnings([]);
    setProposalError(null);
    setProposalAnnouncement(null);
    setProposalBusy("proposing");
    try {
      const result = await api.generateNaturalLanguageProposal(
        request.workspaceId,
        {
          version: "schedule.natural-language/v1",
          requestId,
          prompt,
        },
        request.controller.signal,
      );
      if (!proposalOperationIsCurrent(request.operation, request.workspaceId)) return;
      if (result.status !== "proposal" || result.proposal === null) {
        setProposalSummary(result.summary);
        setProposalWarnings(result.warnings);
        setProposalError(result.summary ?? proposalUnavailableMessage(result.reason));
        setProposalAnnouncement("No work item was created.");
        return;
      }
      setProposal(result.proposal);
      setProposalTitle(result.proposal.command.title);
      setProposalPriority(result.proposal.userSelection.priority);
      setProposalDueOn(result.proposal.userSelection.dueOn ?? "");
      setProposalIncludeInDailyPlan(result.proposal.userSelection.planningDurationMinutes !== null);
      setProposalPlanningDurationMinutes(
        String(result.proposal.userSelection.planningDurationMinutes ?? 30),
      );
      setProposalSummary(result.summary);
      setProposalWarnings(result.warnings);
      setProposalAnnouncement("Proposal ready for review. Nothing has been created yet.");
      confirmationKeyRef.current = globalThis.crypto.randomUUID();
    } catch (error) {
      if (
        !request.controller.signal.aborted &&
        proposalOperationIsCurrent(request.operation, request.workspaceId)
      ) {
        setProposalError(messageFor(error));
        setProposalAnnouncement("No work item was created.");
      }
    } finally {
      if (proposalOperationIsCurrent(request.operation, request.workspaceId)) {
        setProposalBusy(null);
        if (proposalAbortRef.current === request.controller) proposalAbortRef.current = null;
      }
    }
  }

  async function cancelProposal(): Promise<void> {
    if (proposal === null || proposalBusy !== null) return;
    const request = beginProposalOperation();
    setProposalBusy("cancelling");
    setProposalError(null);
    try {
      await api.cancelNaturalLanguageProposal(
        request.workspaceId,
        proposal.id,
        proposal.version,
        request.controller.signal,
      );
      if (!proposalOperationIsCurrent(request.operation, request.workspaceId)) return;
      setProposal(null);
      setProposalTitle("");
      setProposalPriority("none");
      setProposalDueOn("");
      setProposalIncludeInDailyPlan(false);
      setProposalPlanningDurationMinutes("30");
      setProposalSummary(null);
      setProposalWarnings([]);
      confirmationKeyRef.current = null;
      setProposalAnnouncement("Proposal cancelled. No work item was created.");
      window.setTimeout(() => proposalPromptRef.current?.focus());
    } catch (error) {
      if (
        !request.controller.signal.aborted &&
        proposalOperationIsCurrent(request.operation, request.workspaceId)
      ) {
        if (error instanceof ApiError && error.status === 410) {
          setProposal(null);
          confirmationKeyRef.current = null;
          setProposalError("This proposal is no longer available. Review your text and try again.");
        } else {
          setProposalError(messageFor(error));
        }
      }
    } finally {
      if (proposalOperationIsCurrent(request.operation, request.workspaceId)) {
        setProposalBusy(null);
        if (proposalAbortRef.current === request.controller) proposalAbortRef.current = null;
      }
    }
  }

  async function confirmProposal(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (proposal === null || proposalBusy !== null) return;
    const normalizedTitle = proposalTitle.trim();
    const durationIsValid = isPlanningDurationValid(
      proposalPlanningDurationMinutes,
      proposalIncludeInDailyPlan,
    );
    if (normalizedTitle.length === 0 || !durationIsValid) return;
    const userSelection = {
      priority: proposalPriority,
      dueOn: proposalDueOn === "" ? null : proposalDueOn,
      planningDurationMinutes: proposalIncludeInDailyPlan
        ? Number(proposalPlanningDurationMinutes)
        : null,
    } as const;
    const request = beginProposalOperation();
    const requestQueryKey = activeQueryKey;
    const confirmationKey = confirmationKeyRef.current ?? globalThis.crypto.randomUUID();
    confirmationKeyRef.current = confirmationKey;
    setProposalBusy("confirming");
    setProposalError(null);
    let currentProposal = proposal;
    try {
      if (
        normalizedTitle !== currentProposal.command.title ||
        userSelection.priority !== currentProposal.userSelection.priority ||
        userSelection.dueOn !== currentProposal.userSelection.dueOn ||
        userSelection.planningDurationMinutes !==
          currentProposal.userSelection.planningDurationMinutes
      ) {
        currentProposal = await api.updateNaturalLanguageProposal(
          request.workspaceId,
          currentProposal.id,
          {
            expectedVersion: currentProposal.version,
            title: normalizedTitle,
            userSelection,
          },
          request.controller.signal,
        );
        if (!proposalOperationIsCurrent(request.operation, request.workspaceId)) return;
        setProposal(currentProposal);
        setProposalTitle(currentProposal.command.title);
        setProposalPriority(currentProposal.userSelection.priority);
        setProposalDueOn(currentProposal.userSelection.dueOn ?? "");
        setProposalIncludeInDailyPlan(
          currentProposal.userSelection.planningDurationMinutes !== null,
        );
        setProposalPlanningDurationMinutes(
          String(currentProposal.userSelection.planningDurationMinutes ?? 30),
        );
      }
      const result = await api.confirmNaturalLanguageProposal(
        request.workspaceId,
        currentProposal.id,
        currentProposal.version,
        confirmationKey,
        request.controller.signal,
      );
      if (!proposalOperationIsCurrent(request.operation, request.workspaceId)) return;
      const created = result.workItem;
      updateWorkspaceDependencyData(request.workspaceId, (current) => ({
        ...current,
        allItems: current.allItems.some((item) => item.id === created.id)
          ? current.allItems.map((item) => (item.id === created.id ? created : item))
          : [...current.allItems, created],
      }));
      setBoard((current) => {
        if (
          activeQueryKeyRef.current !== requestQueryKey ||
          current?.queryKey !== requestQueryKey
        ) {
          return current;
        }
        const allItems = current.allItems.some((item) => item.id === created.id)
          ? current.allItems.map((item) => (item.id === created.id ? created : item))
          : [...current.allItems, created];
        const visible = priorityFilter === "" || created.priority === priorityFilter;
        const items = current.items.some((item) => item.id === created.id)
          ? current.items.map((item) => (item.id === created.id ? created : item))
          : visible
            ? [...current.items, created]
            : current.items;
        return { ...current, allItems, items };
      });
      if (activeQueryKeyRef.current === requestQueryKey) {
        if (priorityFilter !== "" && created.priority !== priorityFilter) setPriorityFilter("");
        setRecentlyCreatedItemId(created.id);
      }
      setProposal(null);
      setProposalPrompt("");
      setProposalTitle("");
      setProposalPriority("none");
      setProposalDueOn("");
      setProposalIncludeInDailyPlan(false);
      setProposalPlanningDurationMinutes("30");
      setProposalSummary(null);
      setProposalWarnings([]);
      setProposalOpen(false);
      confirmationKeyRef.current = null;
      setProposalAnnouncement(
        result.replayed
          ? `${created.title} was already created; the existing work item is shown.`
          : `${created.title} was created in Backlog.`,
      );
    } catch (error) {
      if (
        !request.controller.signal.aborted &&
        proposalOperationIsCurrent(request.operation, request.workspaceId)
      ) {
        if (error instanceof ApiError && error.status === 410) {
          setProposal(null);
          confirmationKeyRef.current = null;
          setProposalError("This proposal expired or was closed. Review your text and try again.");
        } else if (error instanceof ApiError && error.status === 409) {
          setProposalError(
            "This proposal changed or was confirmed elsewhere. No second work item was created.",
          );
        } else {
          setProposalError(
            `${messageFor(error)} You can retry; the same confirmation key will be reused.`,
          );
        }
      }
    } finally {
      if (proposalOperationIsCurrent(request.operation, request.workspaceId)) {
        setProposalBusy(null);
        if (proposalAbortRef.current === request.controller) proposalAbortRef.current = null;
      }
    }
  }

  return (
    <div className="work-view">
      <PageHeader
        eyebrow={workspace.name}
        title="Work board"
        description="Capture work, choose what can enter Today, and move it through a clear six-step flow."
        actions={
          <Button
            type="button"
            variant="quiet"
            className="work-board-refresh"
            busy={loading}
            onClick={() => void loadBoard(undefined, true)}
          >
            {loading ? null : <RefreshCw size={15} aria-hidden="true" />}
            Refresh board
          </Button>
        }
      />

      <section className="work-filter-bar" aria-label="Filter work">
        <div className="work-filter-controls">
          <Field label="Search work" className="work-search-filter">
            <input
              ref={searchInputRef}
              type="search"
              value={searchQuery}
              placeholder="Title or description"
              autoComplete="off"
              onChange={(event) => setSearchQuery(event.currentTarget.value)}
            />
          </Field>
          <Field label="Filter by status">
            <select
              ref={statusFilterRef}
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.currentTarget.value as WorkStatusFilter)}
            >
              {workStatusFilters.map((option) => (
                <option value={option.value} key={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Filter by due date">
            <select
              value={dueDateFilter}
              onChange={(event) => setDueDateFilter(event.currentTarget.value as WorkDueDateFilter)}
            >
              {workDueDateFilters.map((option) => (
                <option value={option.value} key={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Filter by priority">
            <select
              value={priorityFilter}
              onChange={(event) => setPriorityFilter(event.currentTarget.value as PriorityFilter)}
            >
              <option value="">All priorities</option>
              {priorities.map((priority) => (
                <option value={priority.value} key={priority.value}>
                  {priority.label}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="work-filter-meta">
          <p
            className="work-filter-summary"
            role="status"
            aria-label="Work filter results"
            aria-live="polite"
            aria-atomic="true"
          >
            {items === null
              ? "Loading work items."
              : `${visibleItems.length} of ${totalWorkItemCount} ${totalWorkItemCount === 1 ? "work item" : "work items"} shown.`}
          </p>
          <Button
            type="button"
            variant="quiet"
            disabled={filtersAreDefault}
            onClick={() => resetFilters()}
          >
            Reset filters
          </Button>
        </div>
      </section>

      <section className="work-composer" aria-labelledby="work-composer-title">
        <div className="work-composer-heading">
          <div>
            <p className="eyebrow">Quick capture</p>
            <h2 id="work-composer-title">
              {newParentWorkItemId === null ? "Add a work item" : "Add a subtask"}
            </h2>
          </div>
          <div className="work-composer-heading-actions">
            <p>
              {newParentWorkItemId === null
                ? "Start it in any status. Opt in only the one-time work that belongs in Today."
                : `This item will sit under ${selectedComposerParent?.title ?? "the selected parent"} and keep its own status.`}
            </p>
            {!proposalOpen ? (
              <Button
                type="button"
                variant="quiet"
                aria-expanded="false"
                aria-controls="work-natural-language-panel"
                onClick={openProposalPanel}
              >
                <Sparkles size={16} aria-hidden="true" />
                Describe work
              </Button>
            ) : null}
          </div>
        </div>

        {proposalOpen ? (
          <section
            id="work-natural-language-panel"
            className="work-natural-language-panel"
            aria-labelledby="work-natural-language-title"
          >
            <header className="work-natural-language-header">
              <div>
                <p className="eyebrow">Local proposal</p>
                <h3 id="work-natural-language-title">Describe work in your own words</h3>
              </div>
              <Button
                type="button"
                variant="quiet"
                className="icon-button"
                aria-label="Close work proposal"
                disabled={proposalBusy === "confirming" || proposalBusy === "cancelling"}
                onClick={closeProposalPanel}
              >
                <X size={17} aria-hidden="true" />
              </Button>
            </header>
            <p className="work-natural-language-trust">
              <ShieldCheck size={17} aria-hidden="true" />
              The local model can only suggest one backlog title. It cannot create or change work.
            </p>
            {proposalError === null ? null : (
              <ErrorNotice message={proposalError} onDismiss={() => setProposalError(null)} />
            )}

            {proposal === null ? (
              <form
                className="work-natural-language-prompt"
                onSubmit={(event) => void prepareProposal(event)}
              >
                <Field
                  label="Describe one work item"
                  hint="Keep this to one concrete outcome. You will review the exact title next."
                >
                  <textarea
                    ref={proposalPromptRef}
                    value={proposalPrompt}
                    maxLength={2_000}
                    required
                    disabled={proposalBusy !== null}
                    placeholder="For example: remind me to prepare the quarterly report"
                    onChange={(event) => {
                      setProposalPrompt(event.currentTarget.value);
                      setProposalError(null);
                    }}
                  />
                </Field>
                <div className="work-natural-language-prompt-footer">
                  <p>Nothing is created when you ask for a proposal.</p>
                  <Button
                    type="submit"
                    variant="primary"
                    busy={proposalBusy === "proposing"}
                    disabled={proposalPrompt.trim().length === 0 || proposalBusy !== null}
                  >
                    <Sparkles size={16} aria-hidden="true" />
                    Review proposal
                  </Button>
                </div>
              </form>
            ) : (
              <form
                className="work-natural-language-review"
                onSubmit={(event) => void confirmProposal(event)}
              >
                <div className="work-natural-language-summary">
                  <p className="eyebrow">Proposed command</p>
                  <h4>Create one backlog work item</h4>
                  {proposalSummary === null ? null : <p>{proposalSummary}</p>}
                  {proposalWarnings.length === 0 ? null : (
                    <ul>
                      {proposalWarnings.map((warning) => (
                        <li key={warning}>{warning}</li>
                      ))}
                    </ul>
                  )}
                </div>
                <Field
                  label="Work item title"
                  hint="Editing this changes only the stored proposal. It still creates nothing."
                >
                  <input
                    value={proposalTitle}
                    maxLength={240}
                    required
                    disabled={proposalBusy !== null}
                    onChange={(event) => {
                      setProposalTitle(event.currentTarget.value);
                      setProposalError(null);
                    }}
                  />
                </Field>
                <section
                  className="work-natural-language-user-fields"
                  aria-labelledby="work-natural-language-user-fields-title"
                >
                  <div className="work-natural-language-user-fields-heading">
                    <p className="eyebrow" id="work-natural-language-user-fields-title">
                      Your choices — not suggested by the model
                    </p>
                    <p>These fields are stored only when you review them.</p>
                  </div>
                  <Field label="Priority">
                    <select
                      value={proposalPriority}
                      disabled={proposalBusy !== null}
                      onChange={(event) => {
                        setProposalPriority(event.currentTarget.value as WorkItemPriority);
                        setProposalError(null);
                      }}
                    >
                      {priorities.map((priority) => (
                        <option value={priority.value} key={priority.value}>
                          {priority.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Due date (optional)" hint="Leave blank when there is no deadline.">
                    <input
                      type="date"
                      value={proposalDueOn}
                      disabled={proposalBusy !== null}
                      onChange={(event) => {
                        setProposalDueOn(event.currentTarget.value);
                        setProposalError(null);
                      }}
                    />
                  </Field>
                  <fieldset className="work-natural-language-planning-fieldset">
                    <legend>Daily plan</legend>
                    <label className="work-planning-toggle">
                      <input
                        type="checkbox"
                        checked={proposalIncludeInDailyPlan}
                        disabled={proposalBusy !== null}
                        aria-describedby="work-natural-language-planning-hint"
                        onChange={(event) => {
                          setProposalIncludeInDailyPlan(event.currentTarget.checked);
                          setProposalError(null);
                        }}
                      />
                      <span>Include in Today</span>
                    </label>
                    {proposalIncludeInDailyPlan ? (
                      <Field label="Plan duration (minutes)">
                        <input
                          type="number"
                          min={1}
                          max={43_200}
                          step={1}
                          inputMode="numeric"
                          value={proposalPlanningDurationMinutes}
                          disabled={proposalBusy !== null}
                          aria-invalid={
                            !isPlanningDurationValid(proposalPlanningDurationMinutes, true)
                          }
                          aria-describedby="work-natural-language-planning-hint"
                          onChange={(event) => {
                            setProposalPlanningDurationMinutes(event.currentTarget.value);
                            setProposalError(null);
                          }}
                        />
                      </Field>
                    ) : null}
                    <p id="work-natural-language-planning-hint" className="work-planning-hint">
                      {proposalIncludeInDailyPlan
                        ? "The planner will reserve this many minutes."
                        : "Keep this off when the item should stay out of automatic plans."}
                    </p>
                  </fieldset>
                </section>
                <p className="work-natural-language-no-mutation">
                  <ShieldCheck size={17} aria-hidden="true" />
                  Nothing has been created yet. Confirming will atomically create this reviewed root
                  item in Backlog.
                </p>
                <p className="work-natural-language-provenance">
                  Prepared by {proposal.model ?? proposal.provider}; expires at{" "}
                  {new Date(proposal.expiresAt).toLocaleTimeString([], {
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                  .
                </p>
                <div className="work-natural-language-actions">
                  <Button
                    type="button"
                    variant="quiet"
                    busy={proposalBusy === "cancelling"}
                    disabled={proposalBusy !== null}
                    onClick={() => void cancelProposal()}
                  >
                    Cancel proposal
                  </Button>
                  <Button
                    type="submit"
                    variant="primary"
                    busy={proposalBusy === "confirming"}
                    disabled={
                      proposalBusy !== null ||
                      proposalTitle.trim().length === 0 ||
                      !isPlanningDurationValid(
                        proposalPlanningDurationMinutes,
                        proposalIncludeInDailyPlan,
                      )
                    }
                  >
                    Create this work item
                  </Button>
                </div>
              </form>
            )}
          </section>
        ) : null}

        {proposalAnnouncement === null ? null : (
          <p
            className="work-natural-language-announcement"
            role="status"
            aria-label="Work proposal status"
            aria-live="polite"
          >
            {proposalAnnouncement}
          </p>
        )}

        {createError === null ? null : (
          <ErrorNotice message={createError} onDismiss={() => setCreateError(null)} />
        )}
        {newParentWorkItemId === null ? null : (
          <div
            className="work-subtask-context"
            role="status"
            aria-label="Subtask capture status"
            aria-live="polite"
          >
            <span>
              <strong>Subtask of</strong> {selectedComposerParent?.title ?? "Unavailable item"}
            </span>
            <Button
              type="button"
              variant="quiet"
              disabled={creating}
              onClick={() => setNewParentWorkItemId(null)}
            >
              Clear parent
            </Button>
          </div>
        )}
        <form className="work-composer-form" onSubmit={(event) => void createItem(event)}>
          <Field label="Title" className="work-composer-title-field">
            <input
              ref={titleInputRef}
              value={title}
              onChange={(event) => setTitle(event.currentTarget.value)}
              placeholder="What needs to happen?"
              maxLength={240}
              required
              disabled={creating}
            />
          </Field>
          <Field label="Description (optional)" className="work-composer-description-field">
            <textarea
              value={description}
              onChange={(event) => setDescription(event.currentTarget.value)}
              placeholder="Add useful context"
              maxLength={4000}
              disabled={creating}
            />
          </Field>
          <Field label="Starting status" className="work-composer-status-field">
            <select
              value={newStatus}
              onChange={(event) => setNewStatus(event.currentTarget.value as WorkItemStatus)}
              disabled={creating}
            >
              {statuses.map((status) => (
                <option value={status.value} key={status.value}>
                  {status.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Priority" className="work-composer-priority-field">
            <select
              value={newPriority}
              onChange={(event) => setNewPriority(event.currentTarget.value as WorkItemPriority)}
              disabled={creating}
            >
              {priorities.map((priority) => (
                <option value={priority.value} key={priority.value}>
                  {priority.label}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="Due date (optional)"
            hint="Leave blank when this work has no deadline."
            className="work-composer-due-field"
          >
            <input
              type="date"
              value={newDueOn}
              onChange={(event) => setNewDueOn(event.currentTarget.value)}
              disabled={creating}
            />
          </Field>
          <fieldset className="work-planning-fieldset">
            <legend>Daily plan</legend>
            <label className="work-planning-toggle">
              <input
                type="checkbox"
                checked={includeInDailyPlan}
                disabled={creating}
                onChange={(event) => setIncludeInDailyPlan(event.currentTarget.checked)}
              />
              <span>Include in Today</span>
            </label>
            {includeInDailyPlan ? (
              <Field label="Plan duration (minutes)">
                <input
                  type="number"
                  min={1}
                  max={43_200}
                  step={1}
                  inputMode="numeric"
                  value={planningDurationMinutes}
                  disabled={creating}
                  aria-invalid={!newPlanningDurationIsValid}
                  aria-describedby="work-planning-duration-hint"
                  onChange={(event) => setPlanningDurationMinutes(event.currentTarget.value)}
                />
              </Field>
            ) : null}
            <p id="work-planning-duration-hint" className="work-planning-hint">
              {includeInDailyPlan
                ? "The planner reserves this many minutes. Work items remain one-time candidates."
                : "Keep this off for work that should stay off the automatic plan."}
            </p>
          </fieldset>
          <Button
            className="work-composer-submit"
            type="submit"
            variant="primary"
            busy={creating}
            disabled={title.trim().length === 0 || !newPlanningDurationIsValid}
          >
            <Plus size={16} aria-hidden="true" />
            {newParentWorkItemId === null ? "Add item" : "Add subtask"}
          </Button>
        </form>
      </section>

      {loadError === null ? null : (
        <ErrorNotice
          message={loadError}
          action={
            <Button type="button" variant="quiet" onClick={() => void loadBoard(undefined, true)}>
              Retry
            </Button>
          }
          {...(items === null ? {} : { onDismiss: () => setLoadError(null) })}
        />
      )}
      {actionError === null ? null : (
        <ErrorNotice message={actionError} onDismiss={() => setActionError(null)} />
      )}

      {items === null && (loading || loadError === null) ? <PageSkeleton rows={6} /> : null}

      {items !== null ? (
        <>
          {loading ? (
            <p className="work-refresh-status" role="status">
              Refreshing work items...
            </p>
          ) : null}

          {visibleItems.length === 0 ? (
            <EmptyState
              title={
                totalWorkItemCount === 0
                  ? "No work items yet"
                  : filtersAreDefault
                    ? "No active work"
                    : "No matching work items"
              }
              action={
                totalWorkItemCount === 0 ? (
                  <Button
                    type="button"
                    variant="primary"
                    onClick={() => titleInputRef.current?.focus()}
                  >
                    Add your first item
                  </Button>
                ) : filtersAreDefault ? (
                  <Button type="button" variant="quiet" onClick={showTerminalWork}>
                    Show done and cancelled
                  </Button>
                ) : (
                  <Button type="button" variant="quiet" onClick={() => resetFilters(true)}>
                    Reset filters
                  </Button>
                )
              }
            >
              {totalWorkItemCount === 0
                ? "Use quick capture above to give the board its first item."
                : filtersAreDefault
                  ? "Done and cancelled items are hidden from the active view."
                  : "Try a broader search or reset the filters to return to active work."}
            </EmptyState>
          ) : null}

          <div
            className="work-board"
            aria-label="Work items by status"
            hidden={visibleItems.length === 0}
          >
            {visibleStatuses.map((statusValue) => {
              const status = statuses.find((option) => option.value === statusValue);
              if (status === undefined) return null;
              const columnItems = itemsByStatus.get(status.value) ?? [];
              const headingId = `work-column-${status.value}`;
              return (
                <section
                  className={`work-column work-column-${status.value}`}
                  aria-labelledby={headingId}
                  key={status.value}
                >
                  <header className="work-column-header">
                    <h2 id={headingId}>{status.label}</h2>
                    <span
                      className="work-column-count"
                      aria-label={`${columnItems.length} ${columnItems.length === 1 ? "item" : "items"}`}
                    >
                      {columnItems.length}
                    </span>
                  </header>

                  <div className="work-column-items">
                    {columnItems.length === 0 ? (
                      <p className="work-column-empty">Nothing here.</p>
                    ) : null}
                    {columnItems.map((item) => {
                      const pending = pendingItemIds.has(item.id);
                      const dependencyPending = dependencyPendingTokens.has(item.id);
                      const cardPending = pending || dependencyPending;
                      const itemDependencies = [
                        ...(dependenciesByDependentId.get(item.id) ?? []),
                      ].sort((left, right) => {
                        const leftTitle =
                          allItemsById.get(left.prerequisiteWorkItemId)?.title ?? "";
                        const rightTitle =
                          allItemsById.get(right.prerequisiteWorkItemId)?.title ?? "";
                        return leftTitle.localeCompare(rightTitle);
                      });
                      const linkedPrerequisiteIds = new Set(
                        itemDependencies.map((dependency) => dependency.prerequisiteWorkItemId),
                      );
                      const dependencyEditorOpen = openDependencyEditorId === item.id;
                      const prerequisiteCandidates = dependencyEditorOpen
                        ? [...(allItems ?? [])]
                            .filter(
                              (candidate) =>
                                candidate.id !== item.id &&
                                !linkedPrerequisiteIds.has(candidate.id),
                            )
                            .sort((left, right) => left.title.localeCompare(right.title))
                        : [];
                      const completedPrerequisites = itemDependencies.filter(
                        (dependency) =>
                          allItemsById.get(dependency.prerequisiteWorkItemId)?.status === "done",
                      ).length;
                      const dependencyHeadingId = `work-dependencies-${item.id}`;
                      const dependencyError = dependencyErrors[item.id] ?? null;
                      const dependencyAnnouncement = dependencyAnnouncements[item.id] ?? null;
                      const parentItem =
                        item.parentWorkItemId === null
                          ? null
                          : (allItemsById.get(item.parentWorkItemId) ?? null);
                      const childItems = childrenByParentId.get(item.id) ?? [];
                      const completedChildren = childItems.filter(
                        (child) => child.status === "done",
                      ).length;
                      return (
                        <article
                          id={`work-item-${item.id}`}
                          className="work-card"
                          aria-busy={pending}
                          tabIndex={-1}
                          key={item.id}
                        >
                          <header className="work-card-header">
                            <h3>{item.title}</h3>
                            <span className="work-card-header-actions">
                              {childItems.length > 0 ? (
                                <span
                                  className="work-plan-badge work-plan-badge-container"
                                  aria-label="Parent container; leaf subtasks are considered for Today"
                                >
                                  Parent · not in Today
                                </span>
                              ) : item.planningDurationMinutes === null ? null : (
                                <span
                                  className="work-plan-badge"
                                  aria-label="Included in daily plan"
                                >
                                  Today · {item.planningDurationMinutes} min
                                </span>
                              )}
                              {item.dueOn === null ? null : (
                                <span aria-label={`Due ${item.dueOn}`}>
                                  Due {formatDueOn(item.dueOn)}
                                </span>
                              )}
                              <span
                                className={`work-priority-badge work-priority-${item.priority}`}
                              >
                                {priorityLabel(item.priority)}
                              </span>
                              <button
                                type="button"
                                className="icon-button work-card-edit-button"
                                onClick={() => openEdit(item)}
                                disabled={cardPending}
                                aria-label={`Edit details for ${item.title}`}
                              >
                                <Pencil size={14} aria-hidden="true" />
                              </button>
                            </span>
                          </header>
                          {editDraft?.id === item.id ? (
                            <form
                              className="work-card-editor"
                              onSubmit={(event) => void saveDetails(event, item)}
                            >
                              <Field label="Title">
                                <input
                                  autoFocus
                                  value={editDraft.title}
                                  onChange={(event) => {
                                    const value = event.currentTarget.value;
                                    setEditDraft((current) =>
                                      current === null ? null : { ...current, title: value },
                                    );
                                  }}
                                  maxLength={240}
                                  required
                                  disabled={cardPending}
                                />
                              </Field>
                              <Field label="Description (optional)">
                                <textarea
                                  value={editDraft.description}
                                  onChange={(event) => {
                                    const value = event.currentTarget.value;
                                    setEditDraft((current) =>
                                      current === null ? null : { ...current, description: value },
                                    );
                                  }}
                                  maxLength={4000}
                                  disabled={cardPending}
                                />
                              </Field>
                              <Field
                                label="Parent item (optional)"
                                hint="Choose No parent to make this a top-level item. Cycles are rejected."
                              >
                                <select
                                  value={editDraft.parentWorkItemId}
                                  disabled={cardPending}
                                  onChange={(event) => {
                                    const value = event.currentTarget.value;
                                    setEditDraft((current) =>
                                      current === null
                                        ? null
                                        : { ...current, parentWorkItemId: value },
                                    );
                                  }}
                                >
                                  <option value="">No parent</option>
                                  {[...(allItems ?? [])]
                                    .filter(
                                      (candidate) =>
                                        candidate.id !== item.id &&
                                        !editedDescendantWorkItemIds.has(candidate.id),
                                    )
                                    .sort((left, right) => left.title.localeCompare(right.title))
                                    .map((candidate) => (
                                      <option value={candidate.id} key={candidate.id}>
                                        {candidate.title} ({statusLabel(candidate.status)})
                                      </option>
                                    ))}
                                </select>
                              </Field>
                              <Field
                                label="Due date (optional)"
                                hint="Leave blank when this work has no deadline."
                              >
                                <input
                                  type="date"
                                  value={editDraft.dueOn}
                                  onChange={(event) => {
                                    const value = event.currentTarget.value;
                                    setEditDraft((current) =>
                                      current === null ? null : { ...current, dueOn: value },
                                    );
                                  }}
                                  disabled={cardPending}
                                />
                              </Field>
                              <fieldset className="work-card-planning-fieldset">
                                <legend>Daily plan</legend>
                                <label className="work-planning-toggle">
                                  <input
                                    type="checkbox"
                                    checked={editDraft.includeInDailyPlan}
                                    disabled={cardPending || childItems.length > 0}
                                    aria-describedby={`work-card-planning-duration-${item.id}-hint`}
                                    onChange={(event) => {
                                      const checked = event.currentTarget.checked;
                                      setEditDraft((current) =>
                                        current === null
                                          ? null
                                          : { ...current, includeInDailyPlan: checked },
                                      );
                                    }}
                                  />
                                  <span>
                                    {childItems.length > 0
                                      ? "Eligible for Today when leaf"
                                      : "Include in Today"}
                                  </span>
                                </label>
                                {editDraft.includeInDailyPlan ? (
                                  <Field label="Plan duration (minutes)">
                                    <input
                                      type="number"
                                      min={1}
                                      max={43_200}
                                      step={1}
                                      inputMode="numeric"
                                      value={editDraft.planningDurationMinutes}
                                      disabled={cardPending || childItems.length > 0}
                                      aria-invalid={
                                        !isPlanningDurationValid(
                                          editDraft.planningDurationMinutes,
                                          editDraft.includeInDailyPlan,
                                        )
                                      }
                                      aria-describedby={`work-card-planning-duration-${item.id}-hint`}
                                      onChange={(event) => {
                                        const value = event.currentTarget.value;
                                        setEditDraft((current) =>
                                          current === null
                                            ? null
                                            : { ...current, planningDurationMinutes: value },
                                        );
                                      }}
                                    />
                                  </Field>
                                ) : null}
                                <p
                                  id={`work-card-planning-duration-${item.id}-hint`}
                                  className="work-planning-hint"
                                >
                                  {childItems.length > 0
                                    ? editDraft.includeInDailyPlan
                                      ? `Saved at ${editDraft.planningDurationMinutes} minutes, but dormant while this item has subtasks. Detach every child to make it eligible again.`
                                      : "Parents stay out of Today. Detach every child before opting this item into the plan."
                                    : editDraft.includeInDailyPlan
                                      ? "The planner reserves this many minutes. Work items remain one-time candidates."
                                      : "This item will not be selected for Today."}
                                </p>
                              </fieldset>
                              <div className="work-card-editor-actions">
                                <Button type="button" variant="quiet" onClick={closeEdit}>
                                  Cancel
                                </Button>
                                <Button
                                  type="submit"
                                  variant="primary"
                                  busy={pending}
                                  disabled={
                                    cardPending ||
                                    editDraft.title.trim().length === 0 ||
                                    !isPlanningDurationValid(
                                      editDraft.planningDurationMinutes,
                                      editDraft.includeInDailyPlan,
                                    )
                                  }
                                >
                                  Save details
                                </Button>
                              </div>
                            </form>
                          ) : item.description === null ? null : (
                            <p className="work-card-description">{item.description}</p>
                          )}
                          <section
                            className="work-hierarchy"
                            aria-label={`Subtask relationships for ${item.title}`}
                          >
                            <div className="work-hierarchy-summary">
                              {parentItem === null ? (
                                <span className="work-hierarchy-level">Top-level item</span>
                              ) : (
                                <span className="work-hierarchy-parent">
                                  Subtask of{" "}
                                  <button
                                    type="button"
                                    disabled={cardPending}
                                    onClick={() => revealWorkItem(parentItem.id)}
                                  >
                                    {parentItem.title}
                                  </button>
                                </span>
                              )}
                              {childItems.length === 0 ? null : (
                                <span className="work-hierarchy-progress">
                                  {completedChildren}/{childItems.length} subtasks done
                                </span>
                              )}
                              <Button
                                type="button"
                                variant="quiet"
                                className="work-add-subtask"
                                disabled={cardPending}
                                aria-label={`Add subtask to ${item.title}`}
                                onClick={() => beginSubtask(item)}
                              >
                                <Plus size={13} aria-hidden="true" />
                                Add subtask
                              </Button>
                            </div>
                            {childItems.length === 0 ? null : (
                              <ul className="work-subtask-list">
                                {childItems.slice(0, 3).map((child) => (
                                  <li key={child.id}>
                                    <button
                                      type="button"
                                      disabled={cardPending}
                                      onClick={() => revealWorkItem(child.id)}
                                    >
                                      <span>{child.title}</span>
                                      <small>{statusLabel(child.status)}</small>
                                    </button>
                                  </li>
                                ))}
                                {childItems.length <= 3 ? null : (
                                  <li className="work-subtask-overflow">
                                    <details>
                                      <summary>
                                        Show {childItems.length - 3} more{" "}
                                        {childItems.length - 3 === 1 ? "subtask" : "subtasks"}
                                      </summary>
                                      <ul>
                                        {childItems.slice(3).map((child) => (
                                          <li key={child.id}>
                                            <button
                                              type="button"
                                              disabled={cardPending}
                                              onClick={() => revealWorkItem(child.id)}
                                            >
                                              <span>{child.title}</span>
                                              <small>{statusLabel(child.status)}</small>
                                            </button>
                                          </li>
                                        ))}
                                      </ul>
                                    </details>
                                  </li>
                                )}
                              </ul>
                            )}
                            <p>
                              Parent and subtask statuses stay independent. Only leaf items can
                              enter Today.
                            </p>
                          </section>
                          <section
                            className="work-dependencies"
                            aria-labelledby={dependencyHeadingId}
                          >
                            <div className="work-dependencies-heading">
                              <h4 id={dependencyHeadingId}>Prerequisites</h4>
                              <span>
                                {itemDependencies.length === 0
                                  ? "None"
                                  : `${completedPrerequisites}/${itemDependencies.length} done`}
                              </span>
                            </div>

                            {itemDependencies.length === 0 ? (
                              <p className="work-dependencies-empty">No prerequisites linked.</p>
                            ) : (
                              <ul className="work-dependency-list">
                                {itemDependencies.map((dependency) => {
                                  const prerequisite = allItemsById.get(
                                    dependency.prerequisiteWorkItemId,
                                  );
                                  const prerequisiteTitle =
                                    prerequisite?.title ?? "Unavailable work item";
                                  return (
                                    <li key={dependency.prerequisiteWorkItemId}>
                                      <span className="work-dependency-summary">
                                        <strong>{prerequisiteTitle}</strong>
                                        <span
                                          className={`work-dependency-status${
                                            prerequisite === undefined
                                              ? ""
                                              : ` work-dependency-status-${prerequisite.status}`
                                          }`}
                                          aria-label={`${prerequisiteTitle} status: ${
                                            prerequisite === undefined
                                              ? "Unavailable"
                                              : statusLabel(prerequisite.status)
                                          }`}
                                        >
                                          {prerequisite === undefined
                                            ? "Unavailable"
                                            : statusLabel(prerequisite.status)}
                                        </span>
                                      </span>
                                      <Button
                                        type="button"
                                        variant="quiet"
                                        className="work-dependency-remove"
                                        disabled={cardPending}
                                        aria-label={`Remove ${prerequisiteTitle} as a prerequisite for ${item.title}`}
                                        onClick={() =>
                                          void removePrerequisite(
                                            item,
                                            dependency.prerequisiteWorkItemId,
                                          )
                                        }
                                      >
                                        Remove
                                      </Button>
                                    </li>
                                  );
                                })}
                              </ul>
                            )}

                            <p className="work-dependencies-hint">
                              Today waits until every prerequisite is Done. Adding or removing a
                              link never changes a work item status.
                            </p>

                            {dependencyError === null ? null : (
                              <ErrorNotice
                                message={dependencyError}
                                onDismiss={() =>
                                  setDependencyErrors((current) => ({
                                    ...current,
                                    [item.id]: undefined,
                                  }))
                                }
                              />
                            )}
                            {dependencyAnnouncement === null ? null : (
                              <p
                                className="work-dependency-announcement"
                                role="status"
                                aria-live="polite"
                                aria-atomic="true"
                              >
                                {dependencyAnnouncement}
                              </p>
                            )}
                            {dependencyPending ? (
                              <p
                                className="work-dependency-pending"
                                role="status"
                                aria-live="polite"
                                aria-atomic="true"
                              >
                                Saving prerequisite change...
                              </p>
                            ) : null}

                            <details
                              className="work-dependency-editor"
                              open={dependencyEditorOpen}
                              onToggle={(event) => {
                                const open = event.currentTarget.open;
                                setOpenDependencyEditorId((current) =>
                                  open ? item.id : current === item.id ? null : current,
                                );
                              }}
                            >
                              <summary
                                ref={(element) => {
                                  if (element === null) {
                                    prerequisiteSummaryRefs.current.delete(item.id);
                                  } else {
                                    prerequisiteSummaryRefs.current.set(item.id, element);
                                  }
                                }}
                                aria-label={`Manage prerequisites for ${item.title}`}
                                aria-expanded={dependencyEditorOpen}
                              >
                                <ChevronDown
                                  className="work-dependency-chevron"
                                  data-state={dependencyEditorOpen ? "open" : "closed"}
                                  size={15}
                                  aria-hidden="true"
                                />
                                <span>Manage prerequisites</span>
                              </summary>
                              {dependencyEditorOpen ? (
                                <form onSubmit={(event) => void addPrerequisite(event, item)}>
                                  <label>
                                    <span>Add a prerequisite</span>
                                    <select
                                      ref={(element) => {
                                        if (element === null) {
                                          prerequisiteSelectRefs.current.delete(item.id);
                                        } else {
                                          prerequisiteSelectRefs.current.set(item.id, element);
                                        }
                                      }}
                                      value={prerequisiteSelections[item.id] ?? ""}
                                      aria-label={`Add prerequisite to ${item.title}`}
                                      disabled={cardPending || prerequisiteCandidates.length === 0}
                                      onChange={(event) => {
                                        const value = event.currentTarget.value;
                                        setPrerequisiteSelections((current) => ({
                                          ...current,
                                          [item.id]: value,
                                        }));
                                      }}
                                    >
                                      <option value="">
                                        {prerequisiteCandidates.length === 0
                                          ? "No available work items"
                                          : "Choose a work item"}
                                      </option>
                                      {prerequisiteCandidates.map((candidate) => (
                                        <option value={candidate.id} key={candidate.id}>
                                          {candidate.title} ({statusLabel(candidate.status)})
                                        </option>
                                      ))}
                                    </select>
                                  </label>
                                  <Button
                                    type="submit"
                                    variant="quiet"
                                    disabled={
                                      cardPending ||
                                      prerequisiteCandidates.length === 0 ||
                                      (prerequisiteSelections[item.id] ?? "").length === 0
                                    }
                                    aria-label={`Add selected prerequisite to ${item.title}`}
                                  >
                                    Add
                                  </Button>
                                </form>
                              ) : null}
                            </details>
                          </section>
                          <div className="work-card-controls">
                            <label className="work-card-control">
                              <span>Status</span>
                              <select
                                value={item.status}
                                onChange={(event) =>
                                  void updateItem(item, {
                                    status: event.currentTarget.value as WorkItemStatus,
                                  })
                                }
                                disabled={cardPending}
                                aria-label={`Status for ${item.title}`}
                              >
                                {statuses.map((option) => (
                                  <option value={option.value} key={option.value}>
                                    {option.label}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <label className="work-card-control">
                              <span>Priority</span>
                              <select
                                value={item.priority}
                                onChange={(event) =>
                                  void updateItem(item, {
                                    priority: event.currentTarget.value as WorkItemPriority,
                                  })
                                }
                                disabled={cardPending}
                                aria-label={`Priority for ${item.title}`}
                              >
                                {priorities.map((option) => (
                                  <option value={option.value} key={option.value}>
                                    {option.label}
                                  </option>
                                ))}
                              </select>
                            </label>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                </section>
              );
            })}
          </div>
        </>
      ) : null}
    </div>
  );
}
