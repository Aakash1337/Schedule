import {
  CalendarPlus,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Link2,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import { api, ApiError } from "../api";
import {
  addDays,
  browserTimeZone,
  formatDay,
  formatTime,
  isoToLocalDate,
  isoToLocalTime,
  localDateKey,
  localDateTimeToIso,
  startOfWeek,
  todayKey,
} from "../date";
import { Button, EmptyState, ErrorNotice, Field, PageHeader, PageSkeleton } from "../components/ui";
import type { ScheduleBlock, WorkItem, WorkspaceViewProps } from "../types";

interface BlockDraft {
  readonly title: string;
  readonly date: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly timeZone: string;
  readonly workItemId: string;
}

type EditorState =
  | { readonly mode: "create"; readonly draft: BlockDraft }
  | {
      readonly mode: "edit";
      readonly blockId: string;
      readonly expectedVersion: number;
      readonly draft: BlockDraft;
    };

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return fallback;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function isIanaTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function editorForCreate(date: string): EditorState {
  return {
    mode: "create",
    draft: {
      title: "",
      date,
      startsAt: "09:00",
      endsAt: "09:30",
      timeZone: browserTimeZone(),
      workItemId: "",
    },
  };
}

function editorForBlock(block: ScheduleBlock): EditorState {
  return {
    mode: "edit",
    blockId: block.id,
    expectedVersion: block.version,
    draft: {
      title: block.title ?? "",
      date: isoToLocalDate(block.startsAt),
      startsAt: isoToLocalTime(block.startsAt),
      endsAt: isoToLocalTime(block.endsAt),
      timeZone: browserTimeZone(),
      workItemId: block.workItemId ?? "",
    },
  };
}

function weekTitle(firstDay: Date, lastDay: Date): string {
  const crossesYear = firstDay.getFullYear() !== lastDay.getFullYear();
  const first = formatDay(firstDay, {
    month: "short",
    day: "numeric",
    ...(crossesYear ? { year: "numeric" } : {}),
  });
  const last = formatDay(lastDay, { month: "short", day: "numeric", year: "numeric" });
  return `${first} to ${last}`;
}

function blockTimeLabel(block: ScheduleBlock): string {
  const startDate = isoToLocalDate(block.startsAt);
  const endDate = isoToLocalDate(block.endsAt);
  if (startDate === endDate) return `${formatTime(block.startsAt)} to ${formatTime(block.endsAt)}`;
  return `${formatTime(block.startsAt)} to ${formatDay(new Date(block.endsAt), {
    weekday: "short",
  })} ${formatTime(block.endsAt)}`;
}

export function CalendarView({ workspace }: WorkspaceViewProps) {
  const agendaRef = useRef<HTMLDivElement>(null);
  const editorOpenerRef = useRef<HTMLElement | null>(null);
  const [anchorDate, setAnchorDate] = useState(() => new Date());
  const [blocks, setBlocks] = useState<readonly ScheduleBlock[]>([]);
  const [workItems, setWorkItems] = useState<readonly WorkItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const weekStart = useMemo(() => startOfWeek(anchorDate), [anchorDate]);
  const weekDays = useMemo(
    () => Array.from({ length: 7 }, (_, index) => addDays(weekStart, index)),
    [weekStart],
  );
  const weekEnd = useMemo(() => addDays(weekStart, 7), [weekStart]);
  const rangeFrom = useMemo(() => weekStart.toISOString(), [weekStart]);
  const rangeTo = useMemo(() => weekEnd.toISOString(), [weekEnd]);
  const visibleDateKeys = useMemo(() => weekDays.map(localDateKey), [weekDays]);

  const loadWeek = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setLoadError(null);
      try {
        const [blockPage, workItemPage] = await Promise.all([
          api.listScheduleBlocks(workspace.id, rangeFrom, rangeTo, signal),
          api.listWorkItems(workspace.id, {}, signal),
        ]);
        if (signal?.aborted === true) return;
        setBlocks(blockPage.items);
        setWorkItems(workItemPage.items);
      } catch (error) {
        if (!isAbortError(error)) {
          setLoadError(errorMessage(error, "The calendar could not be loaded."));
        }
      } finally {
        if (signal?.aborted !== true) setLoading(false);
      }
    },
    [rangeFrom, rangeTo, workspace.id],
  );

  useEffect(() => {
    const controller = new AbortController();
    void loadWeek(controller.signal);
    return () => controller.abort();
  }, [loadWeek]);

  useEffect(() => {
    setEditor(null);
    setEditorError(null);
    setConfirmingDelete(false);
  }, [workspace.id]);

  useEffect(() => {
    if (loading || typeof window.matchMedia !== "function") return;
    if (!window.matchMedia("(max-width: 760px)").matches) return;
    const agenda = agendaRef.current;
    const today = agenda?.querySelector<HTMLElement>(`[data-calendar-date="${todayKey()}"]`);
    if (agenda === null || today === null || today === undefined) return;
    agenda.scrollLeft = Math.max(
      0,
      today.offsetLeft - (agenda.clientWidth - today.clientWidth) / 2,
    );
  }, [loading, weekStart]);

  const workItemsById = useMemo(
    () => new Map(workItems.map((workItem) => [workItem.id, workItem])),
    [workItems],
  );
  const selectableWorkItems = useMemo(
    () => [...workItems].sort((left, right) => left.title.localeCompare(right.title)),
    [workItems],
  );
  const blocksByDate = useMemo(() => {
    const grouped = new Map<string, ScheduleBlock[]>(
      visibleDateKeys.map((date) => [date, []] as const),
    );
    for (const block of blocks) {
      const visibleStart = new Date(
        Math.max(new Date(block.startsAt).getTime(), weekStart.getTime()),
      );
      grouped.get(localDateKey(visibleStart))?.push(block);
    }
    for (const dateBlocks of grouped.values()) {
      dateBlocks.sort((left, right) => {
        const byStart = new Date(left.startsAt).getTime() - new Date(right.startsAt).getTime();
        if (byStart !== 0) return byStart;
        const byEnd = new Date(left.endsAt).getTime() - new Date(right.endsAt).getTime();
        if (byEnd !== 0) return byEnd;
        return (left.title ?? "").localeCompare(right.title ?? "");
      });
    }
    return grouped;
  }, [blocks, visibleDateKeys, weekStart]);

  function openCreate(date: string) {
    editorOpenerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setEditor(editorForCreate(date));
    setEditorError(null);
    setConfirmingDelete(false);
  }

  function openEdit(block: ScheduleBlock) {
    editorOpenerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setEditor(editorForBlock(block));
    setEditorError(null);
    setConfirmingDelete(false);
  }

  function dismissEditor() {
    setEditor(null);
    setEditorError(null);
    setConfirmingDelete(false);
    window.setTimeout(() => {
      const opener = editorOpenerRef.current;
      const target = opener?.isConnected === true ? opener : agendaRef.current;
      target?.focus();
      editorOpenerRef.current = null;
    });
  }

  function closeEditor() {
    if (saving || deleting) return;
    dismissEditor();
  }

  function updateDraft<Key extends keyof BlockDraft>(key: Key, value: BlockDraft[Key]) {
    setEditor((current) =>
      current === null ? null : { ...current, draft: { ...current.draft, [key]: value } },
    );
    setEditorError(null);
    setConfirmingDelete(false);
  }

  function includeInVisibleWeek(block: ScheduleBlock): boolean {
    return (
      new Date(block.startsAt).getTime() < weekEnd.getTime() &&
      new Date(block.endsAt).getTime() > weekStart.getTime()
    );
  }

  function storeBlock(block: ScheduleBlock) {
    setBlocks((current) => {
      const remaining = current.filter((candidate) => candidate.id !== block.id);
      return includeInVisibleWeek(block) ? [...remaining, block] : remaining;
    });
  }

  async function reconcileConflict(submitted: Extract<EditorState, { mode: "edit" }>) {
    setConfirmingDelete(false);
    try {
      const latest = await api.getScheduleBlock(workspace.id, submitted.blockId);
      const latestLocalDate = isoToLocalDate(latest.startsAt);
      storeBlock(latest);
      if (!includeInVisibleWeek(latest)) setAnchorDate(new Date(latest.startsAt));
      setEditor(editorForBlock(latest));
      setEditorError(
        `This block changed elsewhere. The latest values from ${latestLocalDate} are loaded; your unsaved changes were not applied.`,
      );
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) {
        setBlocks((current) => current.filter((block) => block.id !== submitted.blockId));
        setEditor((current) => {
          if (current?.mode !== "edit" || current.blockId !== submitted.blockId) return current;
          return {
            mode: "create",
            draft: { ...current.draft, timeZone: browserTimeZone() },
          };
        });
        setEditorError(
          "This block was deleted elsewhere. Your unsaved values are now a new-block draft; review them before creating it.",
        );
        return;
      }
      setEditorError(
        `This block changed elsewhere, but its latest values could not be loaded: ${errorMessage(
          error,
          "Unknown error.",
        )}`,
      );
    }
  }

  async function saveBlock(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (editor === null) return;

    const submitted = editor;
    const title = submitted.draft.title.trim();
    const timeZone = submitted.draft.timeZone.trim();
    if (title.length === 0 && submitted.draft.workItemId.length === 0) {
      setEditorError("Add a title or link a work item so this block is easy to identify.");
      return;
    }
    if (!isIanaTimeZone(timeZone)) {
      setEditorError("Enter a valid IANA time zone, such as America/La_Paz.");
      return;
    }

    let startsAt: string;
    let endsAt: string;
    try {
      startsAt = localDateTimeToIso(submitted.draft.date, submitted.draft.startsAt);
      endsAt = localDateTimeToIso(submitted.draft.date, submitted.draft.endsAt);
    } catch {
      setEditorError(
        "That local time does not exist in your browser time zone. Choose another time.",
      );
      return;
    }
    if (new Date(endsAt).getTime() <= new Date(startsAt).getTime()) {
      setEditorError("End time must be later than start time on the selected date.");
      return;
    }

    setSaving(true);
    setEditorError(null);
    try {
      const input = {
        workItemId: submitted.draft.workItemId || null,
        title: title || null,
        startsAt,
        endsAt,
        timeZone,
      };
      const saved =
        submitted.mode === "create"
          ? await api.createScheduleBlock(workspace.id, input)
          : await api.updateScheduleBlock(workspace.id, submitted.blockId, {
              expectedVersion: submitted.expectedVersion,
              ...input,
            });
      storeBlock(saved);
      dismissEditor();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409 && submitted.mode === "edit") {
        await reconcileConflict(submitted);
      } else {
        setEditorError(errorMessage(error, "The block could not be saved."));
      }
    } finally {
      setSaving(false);
    }
  }

  async function deleteBlock() {
    if (editor?.mode !== "edit") return;
    const submitted = editor;
    setDeleting(true);
    setEditorError(null);
    try {
      await api.deleteScheduleBlock(workspace.id, submitted.blockId, submitted.expectedVersion);
      setBlocks((current) => current.filter((block) => block.id !== submitted.blockId));
      dismissEditor();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        await reconcileConflict(submitted);
      } else {
        setEditorError(errorMessage(error, "The block could not be deleted."));
      }
    } finally {
      setDeleting(false);
    }
  }

  const lastVisibleDay = weekDays[6] ?? weekStart;
  const currentDate = todayKey();
  const firstVisibleDate = visibleDateKeys[0] ?? localDateKey(weekStart);
  const lastVisibleDate = visibleDateKeys[6] ?? localDateKey(lastVisibleDay);

  return (
    <div className="calendar-view">
      <PageHeader
        eyebrow={weekTitle(weekStart, lastVisibleDay)}
        title="Calendar"
        description="Reserve focused time without hiding conflicts. Overlapping blocks stay visible for you to resolve."
        actions={
          <div className="calendar-toolbar" aria-label="Calendar navigation">
            <Button
              className="calendar-nav-button"
              type="button"
              variant="quiet"
              onClick={() => setAnchorDate((current) => addDays(current, -7))}
              aria-label="Previous week"
            >
              <ChevronLeft size={17} aria-hidden="true" />
              Previous
            </Button>
            <Button type="button" onClick={() => setAnchorDate(new Date())}>
              Today
            </Button>
            <Button
              className="calendar-nav-button"
              type="button"
              variant="quiet"
              onClick={() => setAnchorDate((current) => addDays(current, 7))}
              aria-label="Next week"
            >
              Next
              <ChevronRight size={17} aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="primary"
              onClick={() =>
                openCreate(
                  currentDate >= firstVisibleDate && currentDate <= lastVisibleDate
                    ? currentDate
                    : firstVisibleDate,
                )
              }
            >
              <CalendarPlus size={17} aria-hidden="true" />
              New block
            </Button>
          </div>
        }
      />

      {loadError === null ? null : (
        <ErrorNotice
          message={loadError}
          onDismiss={() => setLoadError(null)}
          action={
            <Button type="button" variant="quiet" onClick={() => void loadWeek()}>
              Retry
            </Button>
          }
        />
      )}

      {loading && blocks.length === 0 ? (
        <PageSkeleton rows={7} />
      ) : (
        <div className={`calendar-layout${editor === null ? "" : " calendar-layout-editing"}`}>
          {loading ? (
            <p className="calendar-refresh-status" role="status">
              Updating calendar week...
            </p>
          ) : null}
          <div className="calendar-agenda" aria-busy={loading} ref={agendaRef} tabIndex={-1}>
            {!loading && loadError === null && blocks.length === 0 ? (
              <div className="calendar-empty">
                <EmptyState
                  title="This week is open"
                  action={
                    <Button
                      type="button"
                      variant="primary"
                      onClick={() => openCreate(firstVisibleDate)}
                    >
                      <Plus size={16} aria-hidden="true" />
                      Add the first block
                    </Button>
                  }
                >
                  Add appointments or reserve time for a work item. Nothing repeats unless you
                  create another block.
                </EmptyState>
              </div>
            ) : null}

            <div className="calendar-week" aria-label={weekTitle(weekStart, lastVisibleDay)}>
              {weekDays.map((day) => {
                const date = localDateKey(day);
                const dayBlocks = blocksByDate.get(date) ?? [];
                const headingId = `calendar-day-${date}`;
                const isToday = date === currentDate;
                return (
                  <section
                    className={`calendar-day${isToday ? " calendar-day-today" : ""}`}
                    key={date}
                    aria-labelledby={headingId}
                    data-calendar-date={date}
                  >
                    <header className="calendar-day-header">
                      <h2 id={headingId} className="calendar-day-heading">
                        <span className="calendar-day-name">
                          {formatDay(day, { weekday: "short" })}
                        </span>
                        <time className="calendar-day-number" dateTime={date}>
                          {formatDay(day, { day: "numeric" })}
                        </time>
                        {isToday ? <span className="calendar-today-label">Today</span> : null}
                      </h2>
                      <button
                        className="icon-button calendar-day-add"
                        type="button"
                        onClick={() => openCreate(date)}
                        aria-label={`Add a block on ${formatDay(day, {
                          weekday: "long",
                          month: "long",
                          day: "numeric",
                        })}`}
                      >
                        <Plus size={16} aria-hidden="true" />
                      </button>
                    </header>

                    {dayBlocks.length === 0 ? (
                      <p className="calendar-day-empty">Open</p>
                    ) : (
                      <ol className="calendar-day-list">
                        {dayBlocks.map((block) => {
                          const linkedWorkItem =
                            block.workItemId === null
                              ? undefined
                              : workItemsById.get(block.workItemId);
                          const title = block.title ?? linkedWorkItem?.title ?? "Untitled block";
                          return (
                            <li key={block.id}>
                              <button
                                className="calendar-block"
                                type="button"
                                onClick={() => openEdit(block)}
                                aria-pressed={
                                  editor?.mode === "edit" && editor.blockId === block.id
                                }
                              >
                                <span className="calendar-block-time">
                                  <Clock3 size={13} aria-hidden="true" />
                                  {blockTimeLabel(block)}
                                </span>
                                <span className="calendar-block-title">{title}</span>
                                {linkedWorkItem === undefined ? null : (
                                  <span className="calendar-block-link">
                                    <Link2 size={12} aria-hidden="true" />
                                    {linkedWorkItem.title}
                                  </span>
                                )}
                              </button>
                            </li>
                          );
                        })}
                      </ol>
                    )}
                  </section>
                );
              })}
            </div>
          </div>

          {editor === null ? null : (
            <aside className="calendar-editor" aria-labelledby="calendar-editor-title">
              <header className="calendar-editor-header">
                <div>
                  <p className="eyebrow">{editor.mode === "create" ? "New block" : "Edit block"}</p>
                  <h2 id="calendar-editor-title">
                    {editor.mode === "create" ? "Reserve time" : "Adjust this block"}
                  </h2>
                </div>
                <button
                  className="icon-button"
                  type="button"
                  onClick={closeEditor}
                  disabled={saving || deleting}
                  aria-label="Close editor"
                >
                  <X size={18} aria-hidden="true" />
                </button>
              </header>

              {editorError === null ? null : (
                <ErrorNotice message={editorError} onDismiss={() => setEditorError(null)} />
              )}

              <form className="calendar-editor-form" onSubmit={(event) => void saveBlock(event)}>
                <Field label="Title" hint="Optional when a work item is linked.">
                  <input
                    autoFocus
                    value={editor.draft.title}
                    onChange={(event) => updateDraft("title", event.target.value)}
                    maxLength={240}
                    placeholder="Focus block"
                  />
                </Field>

                <Field label="Linked work item">
                  <select
                    value={editor.draft.workItemId}
                    onChange={(event) => updateDraft("workItemId", event.target.value)}
                  >
                    <option value="">No linked work item</option>
                    {selectableWorkItems.map((workItem) => (
                      <option key={workItem.id} value={workItem.id}>
                        {workItem.title} ({workItem.status.replaceAll("_", " ")})
                      </option>
                    ))}
                  </select>
                </Field>

                <div className="calendar-editor-grid">
                  <Field label="Date">
                    <input
                      type="date"
                      value={editor.draft.date}
                      min={firstVisibleDate}
                      max={lastVisibleDate}
                      onChange={(event) => updateDraft("date", event.target.value)}
                      required
                    />
                  </Field>
                  <Field label="Start">
                    <input
                      type="time"
                      value={editor.draft.startsAt}
                      onChange={(event) => updateDraft("startsAt", event.target.value)}
                      required
                    />
                  </Field>
                  <Field label="End">
                    <input
                      type="time"
                      value={editor.draft.endsAt}
                      onChange={(event) => updateDraft("endsAt", event.target.value)}
                      required
                    />
                  </Field>
                </div>

                <Field label="Time zone" hint="Calendar inputs use your browser time zone.">
                  <input
                    value={editor.draft.timeZone}
                    maxLength={80}
                    spellCheck={false}
                    readOnly
                    required
                  />
                </Field>

                <div className="calendar-editor-actions">
                  {editor.mode === "edit" ? (
                    <Button
                      type="button"
                      variant="danger"
                      onClick={() => setConfirmingDelete(true)}
                      disabled={saving || deleting || confirmingDelete}
                    >
                      <Trash2 size={16} aria-hidden="true" />
                      Delete
                    </Button>
                  ) : (
                    <span />
                  )}
                  <div className="calendar-editor-primary-actions">
                    <Button type="button" variant="quiet" onClick={closeEditor}>
                      Cancel
                    </Button>
                    <Button type="submit" variant="primary" busy={saving} disabled={deleting}>
                      {editor.mode === "create" ? "Create block" : "Save changes"}
                    </Button>
                  </div>
                </div>

                {editor.mode === "edit" && confirmingDelete ? (
                  <div className="calendar-delete-confirm" role="alert">
                    <p>
                      Delete this block? Its previous values will remain in the local audit history.
                    </p>
                    <div>
                      <Button
                        type="button"
                        variant="quiet"
                        onClick={() => setConfirmingDelete(false)}
                        disabled={deleting}
                      >
                        Keep block
                      </Button>
                      <Button
                        type="button"
                        variant="danger"
                        busy={deleting}
                        onClick={() => void deleteBlock()}
                      >
                        Delete permanently
                      </Button>
                    </div>
                  </div>
                ) : null}
              </form>
            </aside>
          )}
        </div>
      )}
    </div>
  );
}
