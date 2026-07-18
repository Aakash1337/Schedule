import {
  Archive,
  CalendarClock,
  History,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  Tag,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";

import { api, ApiError, newIdempotencyKey } from "../api";
import { Button, EmptyState, ErrorNotice, PageHeader, PageSkeleton } from "../components/ui";
import { browserTimeZone, formatDay, formatMinutes, formatTime } from "../date";
import {
  createRoutineDraft,
  parseRoutineDraft,
  RoutineFields,
  routineDraftFromRoutine,
  type RoutineDraft,
} from "./RoutineEditor";
import type {
  ActivityEvent,
  Routine,
  RoutineDurationInsight,
  RoutineSelectionPreferenceKind,
  RoutineSelectionPreferenceState,
  RoutineStatus,
  WorkspaceViewProps,
} from "../types";

const routineTabs: readonly { readonly id: RoutineStatus; readonly label: string }[] = [
  { id: "active", label: "Active" },
  { id: "paused", label: "Paused" },
  { id: "archived", label: "Archived" },
];

function titleCase(value: string): string {
  return value
    .split("_")
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function requestError(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return fallback;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function cadenceSummary(routine: Routine): string {
  if (routine.cadence.period === "rolling_days") {
    return `${routine.cadence.targetCompletions} in every ${routine.cadence.rollingIntervalDays ?? 1}-day window`;
  }
  return `${routine.cadence.targetCompletions} per ${routine.cadence.period}`;
}

function eventTimestamp(event: ActivityEvent): string {
  const date = new Date(event.occurredAt);
  return `${formatDay(date, { month: "short", day: "numeric", year: "numeric" })}, ${formatTime(event.occurredAt)}`;
}

function routinesQueryKey(workspaceId: string, status: RoutineStatus): string {
  return JSON.stringify([workspaceId, status]);
}

export function RoutinesView({ workspace }: WorkspaceViewProps) {
  const [activeStatus, setActiveStatus] = useState<RoutineStatus>("active");
  const [routines, setRoutines] = useState<readonly Routine[]>([]);
  const [selectedRoutineId, setSelectedRoutineId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [conflictMessage, setConflictMessage] = useState<string | null>(null);
  const [busyRoutineId, setBusyRoutineId] = useState<string | null>(null);

  const [draft, setDraft] = useState<RoutineDraft | null>(null);
  const [editingRoutine, setEditingRoutine] = useState<Routine | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [formBusy, setFormBusy] = useState(false);
  const editorOpenerRef = useRef<HTMLElement | null>(null);

  const [activityItems, setActivityItems] = useState<readonly ActivityEvent[]>([]);
  const [activityCursor, setActivityCursor] = useState<string | null>(null);
  const [activityLoaded, setActivityLoaded] = useState(false);
  const [activityLoading, setActivityLoading] = useState(false);
  const [activityError, setActivityError] = useState<string | null>(null);
  const activityRequest = useRef(0);
  const [durationInsight, setDurationInsight] = useState<RoutineDurationInsight | null>(null);
  const [durationInsightLoading, setDurationInsightLoading] = useState(false);
  const [durationInsightError, setDurationInsightError] = useState<string | null>(null);
  const [durationInsightReload, setDurationInsightReload] = useState(0);
  const [durationInsightFeedbackAction, setDurationInsightFeedbackAction] = useState<
    "dismiss" | "restore" | null
  >(null);
  const [durationInsightFeedbackError, setDurationInsightFeedbackError] = useState<string | null>(
    null,
  );
  const [durationInsightAnnouncement, setDurationInsightAnnouncement] = useState<string | null>(
    null,
  );
  const [durationInsightFocusPending, setDurationInsightFocusPending] = useState(false);
  const durationInsightRequest = useRef(0);
  const durationInsightFeedbackRequest = useRef(0);
  const durationInsightHeadingRef = useRef<HTMLHeadingElement>(null);
  const [selectionPreference, setSelectionPreference] =
    useState<RoutineSelectionPreferenceState | null>(null);
  const [selectionPreferenceLoading, setSelectionPreferenceLoading] = useState(false);
  const [selectionPreferenceError, setSelectionPreferenceError] = useState<string | null>(null);
  const [selectionPreferenceAction, setSelectionPreferenceAction] =
    useState<RoutineSelectionPreferenceKind | null>(null);
  const [selectionPreferenceRetryKind, setSelectionPreferenceRetryKind] =
    useState<RoutineSelectionPreferenceKind | null>(null);
  const [selectionPreferenceAnnouncement, setSelectionPreferenceAnnouncement] = useState<
    string | null
  >(null);
  const [selectionPreferenceReload, setSelectionPreferenceReload] = useState(0);
  const selectionPreferenceRequest = useRef(0);
  const selectionPreferenceMutationRequest = useRef(0);
  const pendingSelectionPreferenceCommand = useRef<{
    readonly identity: string;
    readonly idempotencyKey: string;
  } | null>(null);
  const selectionPreferenceHeadingRef = useRef<HTMLHeadingElement>(null);
  const timeZone = useMemo(() => browserTimeZone(), []);
  const activeQueryKey = routinesQueryKey(workspace.id, activeStatus);
  const activeQueryKeyRef = useRef(activeQueryKey);
  activeQueryKeyRef.current = activeQueryKey;

  const selectedRoutine = useMemo(
    () => routines.find((routine) => routine.id === selectedRoutineId) ?? null,
    [routines, selectedRoutineId],
  );
  const selectedRoutineInsightId = selectedRoutine?.id ?? null;
  const selectedRoutineInsightVersion = selectedRoutine?.version ?? null;
  const durationInsightQueryKey =
    selectedRoutineInsightId === null
      ? null
      : JSON.stringify([
          workspace.id,
          selectedRoutineInsightId,
          selectedRoutineInsightVersion,
          durationInsightReload,
        ]);
  const durationInsightQueryKeyRef = useRef(durationInsightQueryKey);
  durationInsightQueryKeyRef.current = durationInsightQueryKey;
  const selectionPreferenceQueryKey =
    selectedRoutineInsightId === null
      ? null
      : JSON.stringify([
          workspace.id,
          selectedRoutineInsightId,
          timeZone,
          selectionPreferenceReload,
        ]);
  const selectionPreferenceQueryKeyRef = useRef(selectionPreferenceQueryKey);
  selectionPreferenceQueryKeyRef.current = selectionPreferenceQueryKey;

  useEffect(() => {
    const requestId = durationInsightRequest.current + 1;
    durationInsightRequest.current = requestId;
    if (
      selectedRoutineInsightId === null ||
      selectedRoutineInsightVersion === null ||
      durationInsightQueryKey === null
    ) {
      setDurationInsight(null);
      setDurationInsightLoading(false);
      setDurationInsightError(null);
      return;
    }

    const controller = new AbortController();
    const requestKey = durationInsightQueryKey;
    const requestActiveQueryKey = activeQueryKeyRef.current;
    const requestIsActive = () =>
      !controller.signal.aborted &&
      durationInsightRequest.current === requestId &&
      durationInsightQueryKeyRef.current === requestKey &&
      activeQueryKeyRef.current === requestActiveQueryKey;
    setDurationInsight(null);
    setDurationInsightLoading(true);
    setDurationInsightError(null);
    void (async () => {
      try {
        const result = await api.getRoutineDurationInsight(
          workspace.id,
          selectedRoutineInsightId,
          controller.signal,
        );
        if (!requestIsActive()) return;
        if (
          result.routineId !== selectedRoutineInsightId ||
          result.routineVersion !== selectedRoutineInsightVersion
        ) {
          throw new Error("The duration estimate was out of date. Retry to load current evidence.");
        }
        setDurationInsight(result);
      } catch (error) {
        if (requestIsActive() && !isAbortError(error)) {
          setDurationInsightError(
            requestError(error, "The duration estimate could not be loaded."),
          );
        }
      } finally {
        if (requestIsActive()) setDurationInsightLoading(false);
      }
    })();

    return () => controller.abort();
  }, [
    durationInsightQueryKey,
    selectedRoutineInsightId,
    selectedRoutineInsightVersion,
    workspace.id,
  ]);

  useEffect(() => {
    const requestId = selectionPreferenceRequest.current + 1;
    selectionPreferenceRequest.current = requestId;
    if (selectedRoutineInsightId === null || selectionPreferenceQueryKey === null) {
      setSelectionPreference(null);
      setSelectionPreferenceLoading(false);
      setSelectionPreferenceError(null);
      return;
    }

    const controller = new AbortController();
    const requestKey = selectionPreferenceQueryKey;
    const requestActiveQueryKey = activeQueryKeyRef.current;
    const requestIsActive = () =>
      !controller.signal.aborted &&
      selectionPreferenceRequest.current === requestId &&
      selectionPreferenceQueryKeyRef.current === requestKey &&
      activeQueryKeyRef.current === requestActiveQueryKey;

    setSelectionPreference(null);
    setSelectionPreferenceLoading(true);
    setSelectionPreferenceError(null);
    void (async () => {
      try {
        const result = await api.getRoutineSelectionPreference(
          workspace.id,
          selectedRoutineInsightId,
          timeZone,
          controller.signal,
        );
        if (!requestIsActive()) return;
        if (result.routineId !== selectedRoutineInsightId) {
          throw new Error("The future-plan preference response did not match this routine.");
        }
        setSelectionPreference(result);
      } catch (error) {
        if (requestIsActive() && !isAbortError(error)) {
          setSelectionPreferenceError(
            requestError(error, "The future-plan preference could not be loaded."),
          );
        }
      } finally {
        if (requestIsActive()) setSelectionPreferenceLoading(false);
      }
    })();

    return () => controller.abort();
  }, [selectionPreferenceQueryKey, selectedRoutineInsightId, timeZone, workspace.id]);

  useEffect(() => {
    if (durationInsightFocusPending && !durationInsightLoading && durationInsight !== null) {
      durationInsightHeadingRef.current?.focus();
      setDurationInsightFocusPending(false);
    }
  }, [durationInsight, durationInsightFocusPending, durationInsightLoading]);

  const loadRoutines = useCallback(
    async (signal?: AbortSignal) => {
      const requestKey = routinesQueryKey(workspace.id, activeStatus);
      const requestIsActive = () =>
        signal?.aborted !== true && activeQueryKeyRef.current === requestKey;
      setLoading(true);
      setLoadError(null);
      try {
        const result = await api.listRoutines(workspace.id, activeStatus, signal);
        if (!requestIsActive()) return;
        setRoutines(result.items);
        setSelectedRoutineId((current) =>
          result.items.some((routine) => routine.id === current) ? current : null,
        );
      } catch (error) {
        if (requestIsActive() && !isAbortError(error)) {
          setLoadError(requestError(error, "The routine pool could not be loaded."));
        }
      } finally {
        if (requestIsActive()) setLoading(false);
      }
    },
    [activeStatus, workspace.id],
  );

  useEffect(() => {
    const controller = new AbortController();
    setRoutines([]);
    setSelectedRoutineId(null);
    durationInsightRequest.current += 1;
    durationInsightFeedbackRequest.current += 1;
    setDurationInsight(null);
    setDurationInsightLoading(false);
    setDurationInsightError(null);
    setDurationInsightFeedbackAction(null);
    setDurationInsightFeedbackError(null);
    setDurationInsightAnnouncement(null);
    setDurationInsightFocusPending(false);
    selectionPreferenceRequest.current += 1;
    selectionPreferenceMutationRequest.current += 1;
    pendingSelectionPreferenceCommand.current = null;
    setSelectionPreference(null);
    setSelectionPreferenceLoading(false);
    setSelectionPreferenceError(null);
    setSelectionPreferenceAction(null);
    setSelectionPreferenceRetryKind(null);
    setSelectionPreferenceAnnouncement(null);
    activityRequest.current += 1;
    setActivityItems([]);
    setActivityCursor(null);
    setActivityLoaded(false);
    setActivityLoading(false);
    setActivityError(null);
    setFormBusy(false);
    setBusyRoutineId(null);
    void loadRoutines(controller.signal);
    return () => controller.abort();
  }, [loadRoutines]);

  useEffect(() => {
    setDraft(null);
    setEditingRoutine(null);
    setFormBusy(false);
    setBusyRoutineId(null);
    setFormError(null);
    setConflictMessage(null);
    setMutationError(null);
  }, [workspace.id]);

  function resetActivity() {
    activityRequest.current += 1;
    setActivityItems([]);
    setActivityCursor(null);
    setActivityLoaded(false);
    setActivityLoading(false);
    setActivityError(null);
  }

  function resetDurationInsight() {
    durationInsightRequest.current += 1;
    durationInsightFeedbackRequest.current += 1;
    setDurationInsight(null);
    setDurationInsightLoading(false);
    setDurationInsightError(null);
    setDurationInsightFeedbackAction(null);
    setDurationInsightFeedbackError(null);
    setDurationInsightAnnouncement(null);
    setDurationInsightFocusPending(false);
  }

  function resetSelectionPreference() {
    selectionPreferenceRequest.current += 1;
    selectionPreferenceMutationRequest.current += 1;
    pendingSelectionPreferenceCommand.current = null;
    setSelectionPreference(null);
    setSelectionPreferenceLoading(false);
    setSelectionPreferenceError(null);
    setSelectionPreferenceAction(null);
    setSelectionPreferenceRetryKind(null);
    setSelectionPreferenceAnnouncement(null);
  }

  function selectRoutine(routineId: string) {
    if (routineId !== selectedRoutineId) {
      resetActivity();
      resetDurationInsight();
      resetSelectionPreference();
    }
    setSelectedRoutineId(routineId);
  }

  function openCreate() {
    editorOpenerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setEditingRoutine(null);
    setDraft(createRoutineDraft());
    setFormError(null);
    setConflictMessage(null);
  }

  function openEdit(routine: Routine) {
    editorOpenerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    selectRoutine(routine.id);
    setEditingRoutine(routine);
    setDraft(routineDraftFromRoutine(routine));
    setFormError(null);
    setConflictMessage(null);
  }

  function closeEditor() {
    setDraft(null);
    setEditingRoutine(null);
    setFormError(null);
    setConflictMessage(null);
    window.setTimeout(() => {
      const opener = editorOpenerRef.current;
      if (opener?.isConnected === true) opener.focus();
      editorOpenerRef.current = null;
    });
  }

  function patchDraft(changes: Partial<RoutineDraft>) {
    setDraft((current) => (current === null ? null : { ...current, ...changes }));
  }

  async function refreshAfterConflict(routineId: string, requestKey: string): Promise<void> {
    if (activeQueryKeyRef.current !== requestKey) return;
    try {
      const [currentPage, latest] = await Promise.all([
        api.listRoutines(workspace.id, activeStatus),
        api.getRoutine(workspace.id, routineId),
      ]);
      if (activeQueryKeyRef.current !== requestKey) return;
      const authoritativeItems = currentPage.items.map((routine) =>
        routine.id === latest.id ? latest : routine,
      );
      setRoutines(authoritativeItems);
      if (editingRoutine?.id === routineId) {
        setEditingRoutine(latest);
        setDraft(routineDraftFromRoutine(latest));
      }
      setSelectedRoutineId((current) =>
        authoritativeItems.some((routine) => routine.id === current) ? current : null,
      );
    } catch (error) {
      if (activeQueryKeyRef.current !== requestKey) return;
      setMutationError(
        requestError(error, "The latest routine could not be loaded after the conflict."),
      );
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (draft === null) return;
    const requestKey = activeQueryKey;
    const result = parseRoutineDraft(draft, editingRoutine?.status ?? "active");
    if (result.payload === null) {
      setFormError(result.error);
      return;
    }

    setFormBusy(true);
    setFormError(null);
    setMutationError(null);
    setConflictMessage(null);
    try {
      const saved =
        editingRoutine === null
          ? await api.createRoutine(workspace.id, result.payload)
          : await api.updateRoutine(workspace.id, editingRoutine.id, {
              expectedVersion: editingRoutine.version,
              title: result.payload.title,
              description: result.payload.description,
              status: result.payload.status,
              tags: result.payload.tags,
              duration: result.payload.duration,
              cadence: result.payload.cadence,
            });
      if (activeQueryKeyRef.current !== requestKey) return;

      closeEditor();
      if (saved.status !== activeStatus) {
        setActiveStatus(saved.status);
      } else {
        setRoutines((current) => {
          const exists = current.some((routine) => routine.id === saved.id);
          return exists
            ? current.map((routine) => (routine.id === saved.id ? saved : routine))
            : [saved, ...current];
        });
      }
      setSelectedRoutineId(saved.id);
      resetActivity();
      resetDurationInsight();
    } catch (error) {
      if (activeQueryKeyRef.current !== requestKey) return;
      if (error instanceof ApiError && error.status === 409 && editingRoutine !== null) {
        setConflictMessage(
          "This routine changed elsewhere. The latest values are loaded; your unsaved edits were not applied.",
        );
        await refreshAfterConflict(editingRoutine.id, requestKey);
      } else {
        setFormError(requestError(error, "The routine could not be saved."));
      }
    } finally {
      if (activeQueryKeyRef.current === requestKey) setFormBusy(false);
    }
  }

  function handleStatusTabKey(event: ReactKeyboardEvent<HTMLButtonElement>, status: RoutineStatus) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const currentIndex = routineTabs.findIndex((tab) => tab.id === status);
    const nextIndex =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? routineTabs.length - 1
          : (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + routineTabs.length) %
            routineTabs.length;
    const next = routineTabs[nextIndex];
    if (next === undefined) return;
    setActiveStatus(next.id);
    document.getElementById(`routine-tab-${next.id}`)?.focus();
  }

  async function changeStatus(routine: Routine, status: RoutineStatus) {
    const requestKey = activeQueryKey;
    setBusyRoutineId(routine.id);
    setMutationError(null);
    setConflictMessage(null);
    try {
      const updated = await api.updateRoutine(workspace.id, routine.id, {
        expectedVersion: routine.version,
        status,
      });
      if (activeQueryKeyRef.current !== requestKey) return;
      setRoutines((current) => current.filter((item) => item.id !== routine.id));
      if (selectedRoutineId === routine.id) {
        setSelectedRoutineId(null);
        resetActivity();
        resetDurationInsight();
      }
      if (editingRoutine?.id === routine.id) {
        setEditingRoutine(updated);
      }
    } catch (error) {
      if (activeQueryKeyRef.current !== requestKey) return;
      if (error instanceof ApiError && error.status === 409) {
        setConflictMessage(
          "This routine changed elsewhere. The latest version was reloaded, so you can try the action again.",
        );
        await refreshAfterConflict(routine.id, requestKey);
      } else {
        setMutationError(requestError(error, "The routine status could not be changed."));
      }
    } finally {
      if (activeQueryKeyRef.current === requestKey) setBusyRoutineId(null);
    }
  }

  async function applyDurationInsight(): Promise<void> {
    if (
      selectedRoutine === null ||
      durationInsight?.status !== "suggested" ||
      durationInsight.disposition !== "available" ||
      durationInsight.suggestedExpectedMinutes === null ||
      durationInsight.routineId !== selectedRoutine.id ||
      durationInsight.routineVersion !== selectedRoutine.version ||
      durationInsightFeedbackAction !== null
    ) {
      return;
    }

    const routine = selectedRoutine;
    const suggestedExpectedMinutes = durationInsight.suggestedExpectedMinutes;
    const requestKey = activeQueryKey;
    setBusyRoutineId(routine.id);
    setMutationError(null);
    setConflictMessage(null);
    setDurationInsightFeedbackError(null);
    setDurationInsightAnnouncement(null);
    try {
      const updated = await api.approveRoutineDurationInsight(workspace.id, routine.id, {
        expectedVersion: routine.version,
        duration: { ...routine.duration, expectedMinutes: suggestedExpectedMinutes },
      });
      if (activeQueryKeyRef.current !== requestKey) return;
      setRoutines((current) =>
        current.map((candidate) => (candidate.id === updated.id ? updated : candidate)),
      );
      if (editingRoutine?.id === updated.id) {
        setEditingRoutine(updated);
        setDraft(routineDraftFromRoutine(updated));
      }
      setDurationInsightReload((current) => current + 1);
      durationInsightHeadingRef.current?.focus();
    } catch (error) {
      if (activeQueryKeyRef.current !== requestKey) return;
      if (error instanceof ApiError && error.status === 409) {
        setConflictMessage(
          "This routine or its duration evidence changed, so the estimate was not applied. Review the refreshed evidence and approve it again.",
        );
        await refreshAfterConflict(routine.id, requestKey);
        if (activeQueryKeyRef.current === requestKey) {
          setDurationInsightReload((current) => current + 1);
        }
      } else {
        setMutationError(requestError(error, "The duration estimate could not be applied."));
      }
    } finally {
      if (activeQueryKeyRef.current === requestKey) setBusyRoutineId(null);
    }
  }

  async function changeDurationInsightDisposition(action: "dismiss" | "restore"): Promise<void> {
    const insight = durationInsight;
    const routine = selectedRoutine;
    if (
      routine === null ||
      insight === null ||
      insight.insightKey === null ||
      !["suggested", "review_range"].includes(insight.status) ||
      insight.routineId !== routine.id ||
      insight.routineVersion !== routine.version ||
      durationInsightFeedbackAction !== null ||
      (action === "dismiss" && insight.disposition !== "available") ||
      (action === "restore" && insight.disposition !== "dismissed")
    ) {
      return;
    }

    const requestKey = activeQueryKey;
    const requestId = durationInsightFeedbackRequest.current + 1;
    durationInsightFeedbackRequest.current = requestId;
    const idempotencyKey = newIdempotencyKey();
    const input = { expectedVersion: routine.version, insightKey: insight.insightKey };
    const requestIsActive = () =>
      durationInsightFeedbackRequest.current === requestId &&
      activeQueryKeyRef.current === requestKey;

    setDurationInsightFeedbackAction(action);
    setDurationInsightFeedbackError(null);
    setDurationInsightAnnouncement(null);
    try {
      if (action === "dismiss") {
        await api.dismissRoutineDurationInsight(workspace.id, routine.id, input, idempotencyKey);
      } else {
        await api.resetRoutineDurationInsightDismissal(
          workspace.id,
          routine.id,
          input,
          idempotencyKey,
        );
      }
      if (!requestIsActive()) return;
      setDurationInsightFeedbackAction(null);
      setDurationInsightAnnouncement(
        action === "dismiss"
          ? "Duration suggestion hidden. The evidence remains available here."
          : "Duration suggestion is available again.",
      );
      setDurationInsightFocusPending(true);
      setDurationInsight(null);
      setDurationInsightLoading(true);
      setDurationInsightReload((current) => current + 1);
    } catch (error) {
      if (!requestIsActive()) return;
      if (error instanceof ApiError && error.status === 409) {
        setDurationInsightFeedbackError(
          "The routine or duration evidence changed, so your choice was not applied. The latest evidence was refreshed.",
        );
        setDurationInsightFocusPending(true);
        await refreshAfterConflict(routine.id, requestKey);
        if (requestIsActive()) {
          setDurationInsight(null);
          setDurationInsightLoading(true);
          setDurationInsightReload((current) => current + 1);
        }
      } else {
        setDurationInsightFeedbackError(
          requestError(error, "Your duration suggestion preference could not be saved."),
        );
      }
    } finally {
      if (requestIsActive()) setDurationInsightFeedbackAction(null);
    }
  }

  async function refreshSelectionPreferenceAfterConflict(
    routineId: string,
    requestQueryKey: string,
  ): Promise<void> {
    const requestId = selectionPreferenceRequest.current + 1;
    selectionPreferenceRequest.current = requestId;
    setSelectionPreferenceLoading(true);
    try {
      const latest = await api.getRoutineSelectionPreference(workspace.id, routineId, timeZone);
      if (
        selectionPreferenceRequest.current !== requestId ||
        selectionPreferenceQueryKeyRef.current !== requestQueryKey ||
        latest.routineId !== routineId
      ) {
        return;
      }
      setSelectionPreference(latest);
    } catch (error) {
      if (
        selectionPreferenceRequest.current === requestId &&
        selectionPreferenceQueryKeyRef.current === requestQueryKey
      ) {
        setSelectionPreferenceError(
          requestError(error, "The latest future-plan preference could not be loaded."),
        );
      }
    } finally {
      if (
        selectionPreferenceRequest.current === requestId &&
        selectionPreferenceQueryKeyRef.current === requestQueryKey
      ) {
        setSelectionPreferenceLoading(false);
      }
    }
  }

  async function changeSelectionPreference(kind: RoutineSelectionPreferenceKind): Promise<void> {
    const routine = selectedRoutine;
    const current = selectionPreference;
    const requestQueryKey = selectionPreferenceQueryKey;
    if (
      routine === null ||
      current === null ||
      current.routineId !== routine.id ||
      requestQueryKey === null ||
      selectionPreferenceAction !== null
    ) {
      return;
    }

    const identity = JSON.stringify([
      workspace.id,
      routine.id,
      kind,
      current.feedbackVersion,
      timeZone,
    ]);
    const pending = pendingSelectionPreferenceCommand.current;
    const idempotencyKey =
      pending?.identity === identity ? pending.idempotencyKey : newIdempotencyKey();
    pendingSelectionPreferenceCommand.current = { identity, idempotencyKey };
    const requestId = selectionPreferenceMutationRequest.current + 1;
    selectionPreferenceMutationRequest.current = requestId;
    const requestActiveQueryKey = activeQueryKeyRef.current;
    const requestIsActive = () =>
      selectionPreferenceMutationRequest.current === requestId &&
      activeQueryKeyRef.current === requestActiveQueryKey &&
      selectionPreferenceQueryKeyRef.current === requestQueryKey;

    setSelectionPreferenceAction(kind);
    setSelectionPreferenceRetryKind(null);
    setSelectionPreferenceError(null);
    setSelectionPreferenceAnnouncement(null);
    try {
      const result = await api.recordRoutineSelectionPreference(
        workspace.id,
        routine.id,
        {
          kind,
          expectedFeedbackVersion: current.feedbackVersion,
          timeZone,
        },
        idempotencyKey,
      );
      if (!requestIsActive()) return;
      if (result.routineId !== routine.id) {
        throw new Error("The saved future-plan preference did not match this routine.");
      }
      pendingSelectionPreferenceCommand.current = null;
      setSelectionPreference(result);
      setSelectionPreferenceAnnouncement("Saved for future plans. Today’s plan was not changed.");
      if (kind === "reset") selectionPreferenceHeadingRef.current?.focus();
    } catch (error) {
      if (!requestIsActive()) return;
      if (error instanceof ApiError && error.status === 409) {
        pendingSelectionPreferenceCommand.current = null;
        setSelectionPreferenceError(
          "This preference changed elsewhere. The latest setting is shown; choose again if needed.",
        );
        await refreshSelectionPreferenceAfterConflict(routine.id, requestQueryKey);
        if (requestIsActive()) selectionPreferenceHeadingRef.current?.focus();
      } else {
        setSelectionPreferenceRetryKind(kind);
        setSelectionPreferenceError(
          `${requestError(error, "The future-plan preference could not be saved.")} Retry to reuse the same request safely.`,
        );
      }
    } finally {
      if (requestIsActive()) setSelectionPreferenceAction(null);
    }
  }

  async function loadActivity(reset: boolean) {
    if (selectedRoutine === null || (activityLoaded && !reset && activityCursor === null)) return;
    const requestKey = activeQueryKey;
    const requestId = activityRequest.current + 1;
    activityRequest.current = requestId;
    setActivityLoading(true);
    setActivityError(null);
    try {
      const result = await api.listRoutineActivity(
        workspace.id,
        selectedRoutine.id,
        reset ? undefined : (activityCursor ?? undefined),
      );
      if (activityRequest.current !== requestId || activeQueryKeyRef.current !== requestKey) return;
      setActivityLoaded(true);
      setActivityCursor(result.page.nextCursor);
      setActivityItems((current) => {
        if (reset) return result.items;
        const existingIds = new Set(current.map((event) => event.id));
        return [...current, ...result.items.filter((event) => !existingIds.has(event.id))];
      });
    } catch (error) {
      if (activityRequest.current === requestId && activeQueryKeyRef.current === requestKey) {
        setActivityError(requestError(error, "Activity history could not be loaded."));
      }
    } finally {
      if (activityRequest.current === requestId && activeQueryKeyRef.current === requestKey) {
        setActivityLoading(false);
      }
    }
  }

  function statusActions(routine: Routine, compact: boolean) {
    const busy = busyRoutineId === routine.id;
    return (
      <div className={compact ? "routines-item-actions" : "routines-detail-actions"}>
        {routine.status === "active" ? (
          <Button
            type="button"
            variant="quiet"
            busy={busy}
            onClick={() => void changeStatus(routine, "paused")}
            aria-label={`Pause ${routine.title}`}
            title="Pause routine"
          >
            <Pause size={15} aria-hidden="true" />
            {compact ? null : "Pause"}
          </Button>
        ) : (
          <Button
            type="button"
            variant="quiet"
            busy={busy}
            onClick={() => void changeStatus(routine, "active")}
            aria-label={`Resume ${routine.title}`}
            title="Resume routine"
          >
            <Play size={15} aria-hidden="true" />
            {compact ? null : "Resume"}
          </Button>
        )}
        {routine.status !== "archived" ? (
          <Button
            type="button"
            variant="quiet"
            busy={busy}
            onClick={() => void changeStatus(routine, "archived")}
            aria-label={`Archive ${routine.title}`}
            title="Archive routine"
          >
            <Archive size={15} aria-hidden="true" />
            {compact ? null : "Archive"}
          </Button>
        ) : null}
      </div>
    );
  }

  function selectionPreferenceSection(routine: Routine) {
    const currentPreference =
      selectionPreference?.routineId === routine.id ? selectionPreference : null;
    const busy = selectionPreferenceAction !== null;
    const loading =
      selectionPreferenceLoading || (currentPreference === null && !selectionPreferenceError);
    const directionalLabel =
      currentPreference === null ||
      (currentPreference.score === 0 && currentPreference.activeEventCount === 0)
        ? null
        : currentPreference.score > 0
          ? "More often"
          : currentPreference.score < 0
            ? "Less often"
            : "Neutral";
    const scoreLabel =
      currentPreference === null
        ? null
        : `${currentPreference.score > 0 ? "+" : ""}${currentPreference.score}`;

    return (
      <section
        className="routines-selection-preference"
        aria-labelledby="routine-selection-preference-heading"
        aria-busy={loading || busy}
      >
        <div className="routines-selection-preference-heading">
          <div>
            <h3
              id="routine-selection-preference-heading"
              ref={selectionPreferenceHeadingRef}
              tabIndex={-1}
            >
              Future selection
            </h3>
            <p>Set an explicit weight for this routine in future plans.</p>
          </div>
          {directionalLabel === null || scoreLabel === null ? null : (
            <span aria-label={`${directionalLabel}, preference score ${scoreLabel}`}>
              {directionalLabel} · {scoreLabel}
            </span>
          )}
        </div>

        {loading ? (
          <p className="routines-selection-preference-loading" role="status" aria-live="polite">
            Loading future-plan preference…
          </p>
        ) : null}

        {currentPreference === null ||
        currentPreference.score === 0 ||
        currentPreference.reason === null ? null : (
          <p className="routines-selection-preference-reason">{currentPreference.reason}</p>
        )}

        {selectionPreferenceError === null ? null : (
          <ErrorNotice
            message={selectionPreferenceError}
            action={
              selectionPreferenceRetryKind === null ? (
                <Button
                  type="button"
                  variant="quiet"
                  onClick={() => setSelectionPreferenceReload((current) => current + 1)}
                >
                  Refresh
                </Button>
              ) : (
                <Button
                  type="button"
                  variant="quiet"
                  onClick={() => void changeSelectionPreference(selectionPreferenceRetryKind)}
                >
                  Retry
                </Button>
              )
            }
          />
        )}

        {selectionPreferenceAnnouncement === null ? null : (
          <p
            className="routines-selection-preference-status"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {selectionPreferenceAnnouncement}
          </p>
        )}

        <div
          className="routines-selection-preference-actions"
          role="group"
          aria-label={`Future plan preference for ${routine.title}`}
        >
          <Button
            type="button"
            variant="quiet"
            busy={selectionPreferenceAction === "more_often"}
            disabled={loading || busy || currentPreference === null}
            onClick={() => void changeSelectionPreference("more_often")}
            aria-label={`Choose ${routine.title} more often in future plans`}
          >
            More often
          </Button>
          <Button
            type="button"
            variant="quiet"
            busy={selectionPreferenceAction === "less_often"}
            disabled={loading || busy || currentPreference === null}
            onClick={() => void changeSelectionPreference("less_often")}
            aria-label={`Choose ${routine.title} less often in future plans`}
          >
            Less often
          </Button>
          {currentPreference === null || currentPreference.activeEventCount === 0 ? null : (
            <Button
              type="button"
              variant="quiet"
              busy={selectionPreferenceAction === "reset"}
              disabled={loading || busy}
              onClick={() => void changeSelectionPreference("reset")}
              aria-label={`Clear the future plan preference for ${routine.title}`}
            >
              Clear preference
            </Button>
          )}
        </div>
      </section>
    );
  }

  function durationInsightSection(routine: Routine) {
    const currentInsight =
      durationInsight?.routineId === routine.id &&
      durationInsight.routineVersion === routine.version
        ? durationInsight
        : null;
    const loading =
      durationInsightLoading || (currentInsight === null && durationInsightError === null);

    return (
      <section
        className={`routines-duration-insight${currentInsight?.status === "review_range" ? " routines-duration-insight-review" : ""}`}
        aria-labelledby="routine-duration-insight-heading"
        aria-busy={loading}
      >
        <div className="routines-duration-insight-heading">
          <h3 id="routine-duration-insight-heading" ref={durationInsightHeadingRef} tabIndex={-1}>
            Duration estimate
          </h3>
          {currentInsight === null ? null : (
            <span>
              {currentInsight.sampleCount} session{currentInsight.sampleCount === 1 ? "" : "s"} ·{" "}
              {currentInsight.lookbackDays} days
            </span>
          )}
        </div>

        {loading ? (
          <p className="routines-duration-insight-copy" role="status" aria-live="polite">
            Checking recent completed sessions…
          </p>
        ) : null}

        {durationInsightError === null ? null : (
          <ErrorNotice
            message={durationInsightError}
            action={
              <Button
                type="button"
                variant="quiet"
                onClick={() => setDurationInsightReload((current) => current + 1)}
              >
                Retry
              </Button>
            }
          />
        )}

        {durationInsightFeedbackError === null ? null : (
          <ErrorNotice
            message={durationInsightFeedbackError}
            onDismiss={() => setDurationInsightFeedbackError(null)}
          />
        )}

        {durationInsightAnnouncement === null ? null : (
          <p
            className="routines-duration-insight-feedback-status"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            {durationInsightAnnouncement}
          </p>
        )}

        {currentInsight === null ? null : (
          <div className="routines-duration-insight-body">
            {currentInsight.status === "insufficient_history" ? (
              <p
                className="routines-duration-insight-copy"
                role="status"
                aria-live="polite"
                aria-atomic="true"
              >
                Duration learning needs {currentInsight.minimumSamples} completed sessions in the
                last {currentInsight.lookbackDays} days. {currentInsight.sampleCount} of{" "}
                {currentInsight.minimumSamples} recorded.
              </p>
            ) : null}

            {currentInsight.status === "aligned" ? (
              <>
                <p
                  className="routines-duration-insight-copy"
                  role="status"
                  aria-live="polite"
                  aria-atomic="true"
                >
                  Recent sessions support your current{" "}
                  {formatMinutes(currentInsight.currentExpectedMinutes)} estimate.
                </p>
                {currentInsight.observedMedianMinutes === null ? null : (
                  <p className="routines-duration-insight-note">
                    A typical session was {formatMinutes(currentInsight.observedMedianMinutes)}.
                  </p>
                )}
              </>
            ) : null}

            {currentInsight.status === "suggested" &&
            currentInsight.suggestedExpectedMinutes !== null ? (
              <>
                <p
                  className="routines-duration-insight-copy"
                  role="status"
                  aria-live="polite"
                  aria-atomic="true"
                >
                  Recent sessions suggest {formatMinutes(currentInsight.suggestedExpectedMinutes)}{" "}
                  is a more typical estimate.
                </p>
                <dl className="routines-duration-insight-facts">
                  <div>
                    <dt>Current</dt>
                    <dd>{formatMinutes(currentInsight.currentExpectedMinutes)}</dd>
                  </div>
                  <div>
                    <dt>Typical</dt>
                    <dd>{formatMinutes(currentInsight.suggestedExpectedMinutes)}</dd>
                  </div>
                </dl>
                <div className="routines-duration-insight-actions">
                  {currentInsight.disposition === "available" ? (
                    <>
                      <Button
                        type="button"
                        variant="primary"
                        busy={busyRoutineId === routine.id}
                        disabled={busyRoutineId !== null || durationInsightFeedbackAction !== null}
                        onClick={() => void applyDurationInsight()}
                      >
                        Apply {formatMinutes(currentInsight.suggestedExpectedMinutes)} estimate
                      </Button>
                      <Button
                        type="button"
                        variant="quiet"
                        disabled={busyRoutineId !== null || durationInsightFeedbackAction !== null}
                        onClick={() => openEdit(routine)}
                      >
                        Edit duration
                      </Button>
                      {currentInsight.insightKey === null ? null : (
                        <Button
                          type="button"
                          variant="quiet"
                          busy={durationInsightFeedbackAction === "dismiss"}
                          disabled={
                            busyRoutineId !== null || durationInsightFeedbackAction !== null
                          }
                          onClick={() => void changeDurationInsightDisposition("dismiss")}
                        >
                          Not now
                        </Button>
                      )}
                    </>
                  ) : currentInsight.insightKey === null ? null : (
                    <Button
                      type="button"
                      variant="quiet"
                      busy={durationInsightFeedbackAction === "restore"}
                      disabled={busyRoutineId !== null || durationInsightFeedbackAction !== null}
                      onClick={() => void changeDurationInsightDisposition("restore")}
                    >
                      Show again
                    </Button>
                  )}
                </div>
                {currentInsight.disposition === "available" ? (
                  <p className="routines-duration-insight-note">
                    This changes the routine only. Your current daily plan will not be regenerated.
                  </p>
                ) : (
                  <p className="routines-duration-insight-note">
                    You chose not to act on this estimate for now. Its evidence remains visible and
                    can be restored at any time.
                  </p>
                )}
              </>
            ) : null}

            {currentInsight.status === "review_range" &&
            currentInsight.observedMedianMinutes !== null ? (
              <>
                <p
                  className="routines-duration-insight-copy"
                  role="status"
                  aria-live="polite"
                  aria-atomic="true"
                >
                  Recent sessions typically take{" "}
                  {formatMinutes(currentInsight.observedMedianMinutes)}, outside your{" "}
                  {formatMinutes(currentInsight.minimumMinutes)} to{" "}
                  {formatMinutes(currentInsight.maximumMinutes)} range. Review the range before
                  changing the estimate.
                </p>
                <dl className="routines-duration-insight-facts">
                  <div>
                    <dt>Current range</dt>
                    <dd>
                      {formatMinutes(currentInsight.minimumMinutes)} to{" "}
                      {formatMinutes(currentInsight.maximumMinutes)}
                    </dd>
                  </div>
                  <div>
                    <dt>Typical</dt>
                    <dd>{formatMinutes(currentInsight.observedMedianMinutes)}</dd>
                  </div>
                </dl>
                <div className="routines-duration-insight-actions">
                  {currentInsight.disposition === "available" ? (
                    <>
                      <Button
                        type="button"
                        variant="quiet"
                        disabled={busyRoutineId !== null || durationInsightFeedbackAction !== null}
                        onClick={() => openEdit(routine)}
                      >
                        Review duration range
                      </Button>
                      {currentInsight.insightKey === null ? null : (
                        <Button
                          type="button"
                          variant="quiet"
                          busy={durationInsightFeedbackAction === "dismiss"}
                          disabled={
                            busyRoutineId !== null || durationInsightFeedbackAction !== null
                          }
                          onClick={() => void changeDurationInsightDisposition("dismiss")}
                        >
                          Not now
                        </Button>
                      )}
                    </>
                  ) : currentInsight.insightKey === null ? null : (
                    <Button
                      type="button"
                      variant="quiet"
                      busy={durationInsightFeedbackAction === "restore"}
                      disabled={busyRoutineId !== null || durationInsightFeedbackAction !== null}
                      onClick={() => void changeDurationInsightDisposition("restore")}
                    >
                      Show again
                    </Button>
                  )}
                </div>
                {currentInsight.disposition === "dismissed" ? (
                  <p className="routines-duration-insight-note">
                    You chose not to review this range for now. Its evidence remains visible and can
                    be restored at any time.
                  </p>
                ) : null}
              </>
            ) : null}
          </div>
        )}
      </section>
    );
  }

  return (
    <div className="routines-view">
      <PageHeader
        eyebrow={workspace.name}
        title="Routine pool"
        description="Shape repeatable activities with realistic duration and cadence rules. The daily planner uses this pool without treating every routine as a fixed appointment."
        actions={
          draft === null ? (
            <Button type="button" variant="primary" onClick={openCreate}>
              <Plus size={16} aria-hidden="true" />
              New routine
            </Button>
          ) : (
            <Button type="button" variant="quiet" onClick={closeEditor}>
              <X size={16} aria-hidden="true" />
              Close form
            </Button>
          )
        }
      />

      {loadError === null ? null : (
        <ErrorNotice
          message={loadError}
          action={
            <Button type="button" variant="quiet" onClick={() => void loadRoutines()}>
              <RefreshCw size={15} aria-hidden="true" />
              Retry
            </Button>
          }
        />
      )}
      {mutationError === null ? null : (
        <ErrorNotice message={mutationError} onDismiss={() => setMutationError(null)} />
      )}
      {conflictMessage === null ? null : (
        <div className="routines-conflict" role="status">
          <RefreshCw size={17} aria-hidden="true" />
          <span>{conflictMessage}</span>
          <button
            className="icon-button"
            type="button"
            onClick={() => setConflictMessage(null)}
            aria-label="Dismiss conflict notice"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      )}

      {draft === null ? null : (
        <form className="routines-editor" onSubmit={(event) => void handleSubmit(event)}>
          <div className="routines-editor-heading">
            <div>
              <p className="eyebrow">{editingRoutine === null ? "New routine" : "Editing"}</p>
              <h2>{editingRoutine === null ? "Add to the pool" : editingRoutine.title}</h2>
              <p>
                {editingRoutine === null
                  ? "Start with useful estimates. You can refine them as the planner gathers history."
                  : `Saving against version ${editingRoutine.version}. All tags, duration values, and cadence values are replaced together.`}
              </p>
            </div>
            <Button type="button" variant="quiet" onClick={closeEditor} aria-label="Close editor">
              <X size={16} aria-hidden="true" />
            </Button>
          </div>

          {formError === null ? null : (
            <ErrorNotice message={formError} onDismiss={() => setFormError(null)} />
          )}

          <RoutineFields
            draft={draft}
            disabled={formBusy}
            autoFocus
            onChange={(changes) => patchDraft(changes)}
          />

          <div className="routines-editor-footer">
            <Button type="button" variant="quiet" onClick={closeEditor} disabled={formBusy}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" busy={formBusy}>
              {editingRoutine === null ? "Create routine" : "Save changes"}
            </Button>
          </div>
        </form>
      )}

      <div className="routines-tabs" role="tablist" aria-label="Routine status">
        {routineTabs.map((tab) => (
          <button
            key={tab.id}
            id={`routine-tab-${tab.id}`}
            type="button"
            role="tab"
            aria-selected={activeStatus === tab.id}
            aria-controls="routine-pool-panel"
            tabIndex={activeStatus === tab.id ? 0 : -1}
            disabled={formBusy || busyRoutineId !== null}
            onClick={() => setActiveStatus(tab.id)}
            onKeyDown={(event) => handleStatusTabKey(event, tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <div
        className="routines-workspace"
        id="routine-pool-panel"
        role="tabpanel"
        aria-labelledby={`routine-tab-${activeStatus}`}
      >
        <section className="routines-pool" aria-label={`${titleCase(activeStatus)} routines`}>
          {loading ? <PageSkeleton rows={4} /> : null}
          {!loading && routines.length === 0 && loadError === null ? (
            <EmptyState
              title={
                activeStatus === "active"
                  ? "Build your routine pool"
                  : `No ${activeStatus} routines`
              }
              action={
                activeStatus === "active" ? (
                  <Button type="button" variant="primary" onClick={openCreate}>
                    <Plus size={16} aria-hidden="true" />
                    Add the first routine
                  </Button>
                ) : null
              }
            >
              {activeStatus === "active"
                ? "Add repeatable activities with cadence and duration rules. They become candidates for the daily plan."
                : `Routines moved to ${activeStatus} will appear here.`}
            </EmptyState>
          ) : null}
          {!loading && routines.length > 0 ? (
            <div className="routines-list">
              {routines.map((routine) => (
                <article
                  className={`routines-item${selectedRoutineId === routine.id ? " routines-item-selected" : ""}`}
                  key={routine.id}
                >
                  <button
                    type="button"
                    className="routines-item-select"
                    onClick={() => selectRoutine(routine.id)}
                    aria-pressed={selectedRoutineId === routine.id}
                  >
                    <span className="routines-item-heading">
                      <strong>{routine.title}</strong>
                      <span
                        className={`routines-priority routines-priority-${routine.tags.priority}`}
                      >
                        {titleCase(routine.tags.priority)}
                      </span>
                    </span>
                    <span className="routines-item-summary">
                      <span>
                        <CalendarClock size={14} aria-hidden="true" />
                        {cadenceSummary(routine)}
                      </span>
                      <span>{formatMinutes(routine.duration.expectedMinutes)} expected</span>
                    </span>
                    {routine.tags.categories.length === 0 ? null : (
                      <span className="routines-item-tags">
                        {routine.tags.categories.slice(0, 3).map((category) => (
                          <span key={category}>{category}</span>
                        ))}
                      </span>
                    )}
                  </button>
                  {statusActions(routine, true)}
                </article>
              ))}
            </div>
          ) : null}
        </section>

        <aside className="routines-detail" aria-label="Routine details">
          {selectedRoutine === null ? (
            <div className="routines-detail-empty">
              <Tag size={22} aria-hidden="true" />
              <h2>Select a routine</h2>
              <p>Review its planning signals, cadence policy, and recent activity.</p>
            </div>
          ) : (
            <div className="routines-detail-content">
              <div className="routines-detail-heading">
                <div>
                  <span className={`routines-status routines-status-${selectedRoutine.status}`}>
                    {titleCase(selectedRoutine.status)}
                  </span>
                  <h2>{selectedRoutine.title}</h2>
                </div>
                <Button type="button" variant="quiet" onClick={() => openEdit(selectedRoutine)}>
                  <Pencil size={15} aria-hidden="true" />
                  Edit
                </Button>
              </div>
              {selectedRoutine.description === null ? null : (
                <p className="routines-detail-description">{selectedRoutine.description}</p>
              )}

              {statusActions(selectedRoutine, false)}

              <dl className="routines-facts">
                <div>
                  <dt>Cadence</dt>
                  <dd>{cadenceSummary(selectedRoutine)}</dd>
                </div>
                <div>
                  <dt>Duration</dt>
                  <dd>
                    {formatMinutes(selectedRoutine.duration.minimumMinutes)} to{" "}
                    {formatMinutes(selectedRoutine.duration.maximumMinutes)},{" "}
                    {formatMinutes(selectedRoutine.duration.expectedMinutes)} expected
                  </dd>
                </div>
                <div>
                  <dt>Spacing</dt>
                  <dd>
                    {selectedRoutine.cadence.minimumSpacingDays === 0
                      ? "No minimum"
                      : `${selectedRoutine.cadence.minimumSpacingDays} day minimum`}
                  </dd>
                </div>
                <div>
                  <dt>Consecutive days</dt>
                  <dd>
                    {selectedRoutine.cadence.prohibitConsecutiveDays
                      ? "Prohibited"
                      : selectedRoutine.cadence.discourageConsecutiveDays
                        ? "Discouraged"
                        : "Allowed"}
                  </dd>
                </div>
              </dl>

              {selectionPreferenceSection(selectedRoutine)}

              {durationInsightSection(selectedRoutine)}

              <div className="routines-tag-groups">
                <div>
                  <h3>Planning signals</h3>
                  <div className="routines-chips">
                    <span>{titleCase(selectedRoutine.tags.priority)} priority</span>
                    <span>{titleCase(selectedRoutine.tags.effort)} effort</span>
                    <span>{titleCase(selectedRoutine.tags.energy)} energy</span>
                    <span>{titleCase(selectedRoutine.tags.preference)}</span>
                  </div>
                </div>
                {selectedRoutine.tags.contexts.length === 0 &&
                selectedRoutine.tags.categories.length === 0 &&
                selectedRoutine.tags.freeForm.length === 0 ? null : (
                  <div>
                    <h3>Tags</h3>
                    <div className="routines-chips routines-chips-neutral">
                      {[
                        ...selectedRoutine.tags.contexts,
                        ...selectedRoutine.tags.categories,
                        ...selectedRoutine.tags.freeForm,
                      ].map((tag, index) => (
                        <span key={`${tag}-${index}`}>{tag}</span>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <section className="routines-activity" aria-labelledby="routine-activity-heading">
                <div className="routines-activity-heading">
                  <div>
                    <h3 id="routine-activity-heading">Activity</h3>
                    <p>Completion and planning history stays immutable.</p>
                  </div>
                  {!activityLoaded ? (
                    <Button
                      type="button"
                      variant="quiet"
                      busy={activityLoading}
                      onClick={() => void loadActivity(true)}
                    >
                      <History size={15} aria-hidden="true" />
                      Show history
                    </Button>
                  ) : null}
                </div>
                {activityError === null ? null : (
                  <ErrorNotice
                    message={activityError}
                    action={
                      <Button type="button" variant="quiet" onClick={() => void loadActivity(true)}>
                        Retry
                      </Button>
                    }
                  />
                )}
                {activityLoaded && activityItems.length === 0 ? (
                  <p className="routines-activity-empty">No activity has been recorded yet.</p>
                ) : null}
                {activityItems.length > 0 ? (
                  <ol className="routines-activity-list">
                    {activityItems.map((event) => (
                      <li key={event.id}>
                        <span className="routines-activity-marker" aria-hidden="true" />
                        <div>
                          <strong>{titleCase(event.type)}</strong>
                          <time dateTime={event.occurredAt}>{eventTimestamp(event)}</time>
                          {event.durationMinutes === null ? null : (
                            <span>{formatMinutes(event.durationMinutes)}</span>
                          )}
                          {event.reason === null ? null : <p>{event.reason}</p>}
                        </div>
                      </li>
                    ))}
                  </ol>
                ) : null}
                {activityLoaded && activityCursor !== null ? (
                  <Button
                    type="button"
                    variant="quiet"
                    busy={activityLoading}
                    onClick={() => void loadActivity(false)}
                  >
                    Load older activity
                  </Button>
                ) : null}
              </section>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
