import { Pencil, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import { api, ApiError } from "../api";
import { Button, EmptyState, ErrorNotice, Field, PageHeader, PageSkeleton } from "../components/ui";
import type { WorkItem, WorkItemPriority, WorkItemStatus, WorkspaceViewProps } from "../types";

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

interface BoardData {
  readonly queryKey: string;
  readonly items: readonly WorkItem[];
}

interface WorkEditDraft {
  readonly id: string;
  readonly title: string;
  readonly description: string;
}

function queryKey(workspaceId: string, priority: PriorityFilter): string {
  return `${workspaceId}:${priority || "all"}`;
}

function messageFor(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "The work board could not be updated.";
}

function priorityLabel(priority: WorkItemPriority): string {
  return priorities.find((option) => option.value === priority)?.label ?? priority;
}

export function WorkView({ workspace }: WorkspaceViewProps) {
  const [priorityFilter, setPriorityFilter] = useState<PriorityFilter>("");
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
  const titleInputRef = useRef<HTMLInputElement>(null);
  const editOpenerRef = useRef<HTMLElement | null>(null);
  const [editDraft, setEditDraft] = useState<WorkEditDraft | null>(null);

  const activeQueryKey = queryKey(workspace.id, priorityFilter);
  const activeQueryKeyRef = useRef(activeQueryKey);
  activeQueryKeyRef.current = activeQueryKey;

  const loadBoard = useCallback(
    async (signal?: AbortSignal) => {
      const requestKey = queryKey(workspace.id, priorityFilter);
      setLoading(true);
      setLoadError(null);
      try {
        const result = await api.listWorkItems(
          workspace.id,
          priorityFilter === "" ? {} : { priority: priorityFilter },
          signal,
        );
        if (!signal?.aborted && activeQueryKeyRef.current === requestKey) {
          setBoard({ queryKey: requestKey, items: result.items });
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
    const controller = new AbortController();
    setActionError(null);
    setCreateError(null);
    setEditDraft(null);
    void loadBoard(controller.signal);
    return () => controller.abort();
  }, [loadBoard]);

  const items = board?.queryKey === activeQueryKey ? board.items : null;
  const itemsByStatus = useMemo(() => {
    const grouped = new Map<WorkItemStatus, readonly WorkItem[]>();
    for (const status of statuses) {
      grouped.set(
        status.value,
        (items ?? []).filter((item) => item.status === status.value),
      );
    }
    return grouped;
  }, [items]);

  async function createItem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedTitle = title.trim();
    if (normalizedTitle.length === 0 || creating) return;

    const requestWorkspaceId = workspace.id;
    const requestKey = activeQueryKey;
    setCreating(true);
    setCreateError(null);
    try {
      const created = await api.createWorkItem(requestWorkspaceId, {
        title: normalizedTitle,
        description: description.trim().length === 0 ? null : description.trim(),
        status: newStatus,
        priority: newPriority,
      });
      if (activeQueryKeyRef.current === requestKey) {
        setBoard((current) => {
          if (current?.queryKey !== requestKey) return current;
          if (priorityFilter !== "" && created.priority !== priorityFilter) return current;
          return { ...current, items: [...current.items, created] };
        });
      }
      setTitle("");
      setDescription("");
      setNewStatus("backlog");
      setNewPriority("none");
      titleInputRef.current?.focus();
    } catch (error) {
      if (activeQueryKeyRef.current === requestKey) setCreateError(messageFor(error));
    } finally {
      setCreating(false);
    }
  }

  function openEdit(item: WorkItem) {
    editOpenerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setEditDraft({ id: item.id, title: item.title, description: item.description ?? "" });
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
      const result = await api.listWorkItems(
        requestWorkspaceId,
        priorityFilter === "" ? {} : { priority: priorityFilter },
      );
      if (activeQueryKeyRef.current !== requestKey) return;
      setBoard({ queryKey: requestKey, items: result.items });
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
      readonly description?: string | null;
      readonly status?: WorkItemStatus;
      readonly priority?: WorkItemPriority;
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

      setBoard((current) => {
        if (current?.queryKey !== requestKey) return current;
        const updatedItems = current.items.map((candidate) =>
          candidate.id === updated.id ? updated : candidate,
        );
        return {
          ...current,
          items:
            priorityFilter === "" || updated.priority === priorityFilter
              ? updatedItems
              : updatedItems.filter((candidate) => candidate.id !== updated.id),
        };
      });
      return true;
    } catch (error) {
      if (activeQueryKeyRef.current !== requestKey) return false;
      if (error instanceof ApiError && error.status === 409) {
        await refreshAfterConflict(requestKey, requestWorkspaceId, item.id);
      } else {
        setActionError(messageFor(error));
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
    if (normalizedTitle.length === 0) return;
    const saved = await updateItem(item, {
      title: normalizedTitle,
      description: editDraft.description.trim() || null,
    });
    if (saved) closeEdit();
  }

  return (
    <div className="work-view">
      <PageHeader
        eyebrow={workspace.name}
        title="Work board"
        description="Capture work, set its priority, and move it through a clear six-step flow."
        actions={
          <Field label="Filter by priority" className="work-priority-filter">
            <select
              value={priorityFilter}
              onChange={(event) => setPriorityFilter(event.currentTarget.value as PriorityFilter)}
              disabled={creating || pendingItemIds.size > 0}
            >
              <option value="">All priorities</option>
              {priorities.map((priority) => (
                <option value={priority.value} key={priority.value}>
                  {priority.label}
                </option>
              ))}
            </select>
          </Field>
        }
      />

      <section className="work-composer" aria-labelledby="work-composer-title">
        <div className="work-composer-heading">
          <div>
            <p className="eyebrow">Quick capture</p>
            <h2 id="work-composer-title">Add a work item</h2>
          </div>
          <p>Start it in any status. You can adjust status and priority from its card.</p>
        </div>

        {createError === null ? null : (
          <ErrorNotice message={createError} onDismiss={() => setCreateError(null)} />
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
          <Button
            className="work-composer-submit"
            type="submit"
            variant="primary"
            busy={creating}
            disabled={title.trim().length === 0}
          >
            <Plus size={16} aria-hidden="true" />
            Add item
          </Button>
        </form>
      </section>

      {loadError === null ? null : (
        <ErrorNotice
          message={loadError}
          action={
            <Button type="button" variant="quiet" onClick={() => void loadBoard()}>
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

          {items.length === 0 ? (
            <EmptyState
              title={priorityFilter === "" ? "No work items yet" : "No matching work items"}
              action={
                priorityFilter === "" ? (
                  <Button
                    type="button"
                    variant="primary"
                    onClick={() => titleInputRef.current?.focus()}
                  >
                    Add your first item
                  </Button>
                ) : (
                  <Button type="button" variant="quiet" onClick={() => setPriorityFilter("")}>
                    Clear priority filter
                  </Button>
                )
              }
            >
              {priorityFilter === ""
                ? "Use quick capture above to give the board its first item."
                : "Try another priority or clear the filter to see the whole board."}
            </EmptyState>
          ) : null}

          <div className="work-board" aria-label="Work items by status">
            {statuses.map((status) => {
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
                      return (
                        <article className="work-card" aria-busy={pending} key={item.id}>
                          <header className="work-card-header">
                            <h3>{item.title}</h3>
                            <span className="work-card-header-actions">
                              <span
                                className={`work-priority-badge work-priority-${item.priority}`}
                              >
                                {priorityLabel(item.priority)}
                              </span>
                              <button
                                type="button"
                                className="icon-button work-card-edit-button"
                                onClick={() => openEdit(item)}
                                disabled={pending}
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
                                  disabled={pending}
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
                                  disabled={pending}
                                />
                              </Field>
                              <div className="work-card-editor-actions">
                                <Button type="button" variant="quiet" onClick={closeEdit}>
                                  Cancel
                                </Button>
                                <Button
                                  type="submit"
                                  variant="primary"
                                  busy={pending}
                                  disabled={editDraft.title.trim().length === 0}
                                >
                                  Save details
                                </Button>
                              </div>
                            </form>
                          ) : item.description === null ? null : (
                            <p className="work-card-description">{item.description}</p>
                          )}
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
                                disabled={pending}
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
                                disabled={pending}
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
