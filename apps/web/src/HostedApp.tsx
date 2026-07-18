import { CheckCircle2, CircleDotDashed, LogOut, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import { Button, ErrorNotice, Field, PageSkeleton } from "./components/ui";
import { browserTimeZone, formatMinutes, localDateTimeToIso, todayKey } from "./date";
import {
  hostedApi,
  HostedApiError,
  type HostedGenerateToday,
  type HostedToday,
  type HostedTodayActivityState,
  type HostedTodayActivityType,
  type HostedWorkItem,
  type HostedWorkItemPriority,
  type HostedWorkspace,
} from "./hosted-api";

const selectedWorkspaceKey = "schedule.hostedWorkspace";

interface TodayActionIntent {
  readonly workspaceId: string;
  readonly date: string;
  readonly itemId: string;
  readonly title: string;
  readonly expectedPlanId: string;
  readonly expectedHeadVersion: number;
  readonly type: HostedTodayActivityType;
  readonly occurredAt: string;
  readonly idempotencyKey: string;
}

interface TodayGenerationIntent extends HostedGenerateToday {
  readonly workspaceId: string;
  readonly date: string;
}

function publicError(error: unknown): string {
  if (error instanceof HostedApiError) {
    if (error.status === 401) return "Your session ended. Sign in again.";
    if (error.status === 403) return "Request verification expired. Reload and try again.";
    if (error.status === 404) return "Workspace access changed. Reload before capturing more work.";
    if (error.status === 409) return "This item changed. Refresh the backlog and try again.";
    if (error.status === 429) return "Too many requests. Wait a moment and try again.";
    if (error.status === 503) return "Schedule is temporarily unavailable.";
  }
  return "Schedule could not be reached.";
}

function titleCase(value: HostedTodayActivityState | HostedWorkItemPriority): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

function backlogMeta(item: HostedWorkItem): string | null {
  const parts = [
    ...(item.priority === "none" ? [] : [`${titleCase(item.priority)} priority`]),
    ...(item.dueOn === null ? [] : [`Due ${item.dueOn}`]),
    ...(item.planningDurationMinutes === null
      ? []
      : [`${formatMinutes(item.planningDurationMinutes)} planned`]),
  ];
  return parts.length === 0 ? null : parts.join(" · ");
}

interface WorkspaceCreateFormProps {
  readonly name: string;
  readonly busy: boolean;
  readonly autoFocus?: boolean;
  readonly onNameChange: (name: string) => void;
  readonly onSubmit: (event: FormEvent<HTMLFormElement>) => void;
}

function WorkspaceCreateForm({
  name,
  busy,
  autoFocus = false,
  onNameChange,
  onSubmit,
}: WorkspaceCreateFormProps) {
  return (
    <form className="hosted-capture-form" onSubmit={onSubmit}>
      <Field label="Workspace name">
        <input
          autoFocus={autoFocus}
          value={name}
          maxLength={160}
          disabled={busy}
          required
          onChange={(event) => onNameChange(event.target.value)}
        />
      </Field>
      <Button type="submit" variant="primary" busy={busy} disabled={name.trim() === ""}>
        <Plus size={17} aria-hidden="true" />
        Create workspace
      </Button>
    </form>
  );
}

export function HostedApp() {
  const [mode, setMode] = useState<"loading" | "signed-out" | "ready" | "unavailable">("loading");
  const [workspaces, setWorkspaces] = useState<readonly HostedWorkspace[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [workspaceName, setWorkspaceName] = useState("");
  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState<HostedWorkItemPriority>("none");
  const [dueOn, setDueOn] = useState("");
  const [planningDuration, setPlanningDuration] = useState("");
  const titleInput = useRef<HTMLInputElement>(null);
  const refocusTitleAfterCapture = useRef(false);
  const todayHeading = useRef<HTMLHeadingElement>(null);
  const refocusTodayAfterGeneration = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);
  const [backlogItems, setBacklogItems] = useState<readonly HostedWorkItem[]>([]);
  const [backlogLoading, setBacklogLoading] = useState(true);
  const [backlogError, setBacklogError] = useState<string | null>(null);
  const [backlogRefresh, setBacklogRefresh] = useState(0);
  const [today, setToday] = useState<HostedToday | null>(null);
  const [todayLoading, setTodayLoading] = useState(true);
  const [todayError, setTodayError] = useState<string | null>(null);
  const [todayRefresh, setTodayRefresh] = useState(0);
  const [todayDate, setTodayDate] = useState(() => todayKey());
  const [todayRetry, setTodayRetry] = useState<TodayActionIntent | null>(null);
  const [todayGenerationRetry, setTodayGenerationRetry] = useState<TodayGenerationIntent | null>(
    null,
  );
  const [planningStartsAt, setPlanningStartsAt] = useState("09:00");
  const [planningEndsAt, setPlanningEndsAt] = useState("17:00");
  const [planningTargetMinutes, setPlanningTargetMinutes] = useState("180");
  const [planningTargetTaskCount, setPlanningTargetTaskCount] = useState("4");
  const [generatingToday, setGeneratingToday] = useState(false);
  const [updatingTodayItem, setUpdatingTodayItem] = useState<{
    readonly id: string;
    readonly type: HostedTodayActivityType;
  } | null>(null);
  const [updatingItem, setUpdatingItem] = useState<{
    readonly id: string;
    readonly status: "in_progress" | "done";
  } | null>(null);
  const timeZone = useMemo(() => browserTimeZone(), []);

  useEffect(() => {
    if (busy || !refocusTitleAfterCapture.current) return;
    refocusTitleAfterCapture.current = false;
    titleInput.current?.focus();
  }, [busy]);

  useEffect(() => {
    if (todayLoading || today?.planId == null || !refocusTodayAfterGeneration.current) return;
    refocusTodayAfterGeneration.current = false;
    todayHeading.current?.focus();
  }, [today?.planId, todayLoading]);

  const load = useCallback(async () => {
    setMode("loading");
    setError(null);
    setConfirmation(null);
    try {
      const session = await hostedApi.session();
      if (!session.authenticated) {
        setMode("signed-out");
        return;
      }
      const page = await hostedApi.listWorkspaces();
      const stored = localStorage.getItem(selectedWorkspaceKey);
      const selected = page.items.find((workspace) => workspace.id === stored) ?? page.items[0];
      setWorkspaces(page.items);
      setSelectedWorkspaceId(selected?.id ?? null);
      setMode("ready");
    } catch (loadError) {
      if (loadError instanceof HostedApiError && loadError.status === 401) {
        setMode("signed-out");
      } else {
        setMode("unavailable");
      }
      setError(publicError(loadError));
    }
  }, []);

  useEffect(() => {
    const now = new Date();
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const timeout = window.setTimeout(
      () => setTodayDate(todayKey()),
      tomorrow.getTime() - now.getTime() + 1_000,
    );
    return () => window.clearTimeout(timeout);
  }, [todayDate]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (mode !== "ready" || selectedWorkspaceId === null) {
      setBacklogItems([]);
      setBacklogLoading(false);
      setBacklogError(null);
      return;
    }
    let active = true;
    setBacklogItems([]);
    setBacklogLoading(true);
    setBacklogError(null);
    void hostedApi
      .listWorkItems(selectedWorkspaceId)
      .then((page) => {
        if (active) setBacklogItems(page.items);
      })
      .catch((listError: unknown) => {
        if (!active) return;
        if (listError instanceof HostedApiError && listError.status === 401) {
          setMode("signed-out");
          setError(publicError(listError));
          return;
        }
        setBacklogError(publicError(listError));
      })
      .finally(() => {
        if (active) setBacklogLoading(false);
      });
    return () => {
      active = false;
    };
  }, [backlogRefresh, mode, selectedWorkspaceId]);

  useEffect(() => {
    if (mode !== "ready" || selectedWorkspaceId === null) {
      setToday(null);
      setTodayLoading(false);
      setTodayError(null);
      setTodayRetry(null);
      setTodayGenerationRetry(null);
      return;
    }
    let active = true;
    setToday(null);
    setTodayLoading(true);
    setTodayError(null);
    void hostedApi
      .getToday(selectedWorkspaceId, todayDate)
      .then((result) => {
        if (!active) return;
        setToday(result);
        setTodayRetry((retry) =>
          retry !== null &&
          retry.workspaceId === selectedWorkspaceId &&
          retry.date === todayDate &&
          retry.expectedPlanId === result.planId &&
          retry.expectedHeadVersion === result.headVersion
            ? retry
            : null,
        );
        setTodayGenerationRetry((retry) =>
          retry !== null &&
          retry.workspaceId === selectedWorkspaceId &&
          retry.date === todayDate &&
          result.planId === null
            ? retry
            : null,
        );
      })
      .catch((todayReadError: unknown) => {
        if (!active) return;
        if (todayReadError instanceof HostedApiError && todayReadError.status === 401) {
          setMode("signed-out");
          setError(publicError(todayReadError));
          return;
        }
        setTodayError(publicError(todayReadError));
      })
      .finally(() => {
        if (active) setTodayLoading(false);
      });
    return () => {
      active = false;
    };
  }, [mode, selectedWorkspaceId, todayDate, todayRefresh]);

  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? null,
    [selectedWorkspaceId, workspaces],
  );
  const mutationBusy =
    busy || generatingToday || updatingItem !== null || updatingTodayItem !== null;

  function selectWorkspace(id: string) {
    localStorage.setItem(selectedWorkspaceKey, id);
    setSelectedWorkspaceId(id);
    setConfirmation(null);
    setError(null);
    setBacklogItems([]);
    setBacklogLoading(true);
    setBacklogError(null);
    setToday(null);
    setTodayLoading(true);
    setTodayError(null);
    setTodayRetry(null);
    setTodayGenerationRetry(null);
    refocusTodayAfterGeneration.current = false;
  }

  async function capture(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const capturedTitle = title.trim();
    if (selectedWorkspace === null || capturedTitle.length === 0) return;
    const capturedPlanningDuration = planningDuration === "" ? null : Number(planningDuration);
    if (
      capturedPlanningDuration !== null &&
      (!Number.isInteger(capturedPlanningDuration) ||
        capturedPlanningDuration < 1 ||
        capturedPlanningDuration > 43_200)
    ) {
      setError("Planning time must be a whole number from 1 to 43,200 minutes.");
      return;
    }
    setBusy(true);
    setError(null);
    setConfirmation(null);
    try {
      await hostedApi.createWorkItem(selectedWorkspace.id, {
        title: capturedTitle,
        priority,
        dueOn: dueOn === "" ? null : dueOn,
        planningDurationMinutes: capturedPlanningDuration,
      });
      setTitle("");
      setPriority("none");
      setDueOn("");
      setPlanningDuration("");
      refocusTitleAfterCapture.current = true;
      setConfirmation(`Added “${capturedTitle}” to ${selectedWorkspace.name}.`);
      setBacklogRefresh((value) => value + 1);
    } catch (captureError) {
      if (captureError instanceof HostedApiError && captureError.status === 401) {
        setMode("signed-out");
      }
      setError(publicError(captureError));
    } finally {
      setBusy(false);
    }
  }

  async function createWorkspace(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = workspaceName.trim();
    if (name.length === 0) return;
    setBusy(true);
    setError(null);
    setConfirmation(null);
    try {
      const workspace = await hostedApi.createWorkspace(name);
      setWorkspaces((current) => [...current, workspace]);
      setWorkspaceName("");
      selectWorkspace(workspace.id);
      setConfirmation(`Created workspace “${workspace.name}”.`);
    } catch (createError) {
      if (createError instanceof HostedApiError && createError.status === 401) {
        setMode("signed-out");
      }
      setError(publicError(createError));
    } finally {
      setBusy(false);
    }
  }

  async function updateStatus(item: HostedWorkItem, status: "in_progress" | "done") {
    if (selectedWorkspace === null) return;
    setUpdatingItem({ id: item.id, status });
    setBacklogError(null);
    setConfirmation(null);
    try {
      await hostedApi.updateWorkItemStatus(selectedWorkspace.id, item, status);
      setConfirmation(
        status === "done" ? `Completed “${item.title}”.` : `Started “${item.title}”.`,
      );
      setBacklogItems((items) => items.filter((candidate) => candidate.id !== item.id));
      setBacklogRefresh((value) => value + 1);
    } catch (updateError) {
      if (updateError instanceof HostedApiError && updateError.status === 401) {
        setMode("signed-out");
        setError(publicError(updateError));
      } else {
        setBacklogError(publicError(updateError));
      }
    } finally {
      setUpdatingItem(null);
    }
  }

  async function submitTodayAction(intent: TodayActionIntent) {
    if (selectedWorkspaceId !== intent.workspaceId || todayDate !== intent.date) {
      setTodayRetry(null);
      return;
    }
    setUpdatingTodayItem({ id: intent.itemId, type: intent.type });
    setConfirmation(null);
    try {
      await hostedApi.recordTodayActivity(intent.workspaceId, intent.date, intent.itemId, {
        expectedPlanId: intent.expectedPlanId,
        expectedHeadVersion: intent.expectedHeadVersion,
        type: intent.type,
        occurredAt: intent.occurredAt,
        idempotencyKey: intent.idempotencyKey,
      });
      setTodayRetry(null);
      setConfirmation(`${titleCase(intent.type)} “${intent.title}”.`);
      setTodayRefresh((value) => value + 1);
      setBacklogRefresh((value) => value + 1);
    } catch (activityError) {
      const known = activityError instanceof HostedApiError;
      if (known && activityError.status === 401) {
        setTodayRetry(null);
        setMode("signed-out");
        setError(publicError(activityError));
      } else {
        const ambiguous =
          !known ||
          activityError.status === 408 ||
          activityError.status === 429 ||
          activityError.status >= 500;
        if (!ambiguous) setTodayRetry(null);
        setTodayError(
          known && activityError.status === 409
            ? "Today changed. Refresh it before trying again."
            : publicError(activityError),
        );
      }
    } finally {
      setUpdatingTodayItem(null);
    }
  }

  function beginTodayAction(item: HostedToday["items"][number], type: HostedTodayActivityType) {
    if (
      selectedWorkspace === null ||
      today === null ||
      today.planId === null ||
      today.headVersion === null
    )
      return;
    const intent: TodayActionIntent = {
      workspaceId: selectedWorkspace.id,
      date: today.date,
      itemId: item.id,
      title: item.title,
      expectedPlanId: today.planId,
      expectedHeadVersion: today.headVersion,
      type,
      occurredAt: new Date().toISOString(),
      idempotencyKey: crypto.randomUUID(),
    };
    setTodayRetry(intent);
    void submitTodayAction(intent);
  }

  async function submitTodayGeneration(intent: TodayGenerationIntent) {
    if (selectedWorkspaceId !== intent.workspaceId || todayDate !== intent.date) {
      setTodayGenerationRetry(null);
      return;
    }
    setGeneratingToday(true);
    setConfirmation(null);
    try {
      const { workspaceId, date, ...command } = intent;
      await hostedApi.generateToday(workspaceId, date, command);
      setTodayGenerationRetry(null);
      refocusTodayAfterGeneration.current = true;
      setConfirmation("Built today’s plan.");
      setTodayRefresh((value) => value + 1);
    } catch (generationError) {
      const known = generationError instanceof HostedApiError;
      if (known && generationError.status === 401) {
        setTodayGenerationRetry(null);
        setMode("signed-out");
        setError(publicError(generationError));
      } else {
        const ambiguous =
          !known ||
          generationError.status === 408 ||
          generationError.status === 429 ||
          generationError.status >= 500;
        if (!ambiguous) setTodayGenerationRetry(null);
        setTodayError(
          known && generationError.status === 409
            ? "Today already has a different plan. Refresh it before trying again."
            : publicError(generationError),
        );
      }
    } finally {
      setGeneratingToday(false);
    }
  }

  function beginTodayGeneration(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (selectedWorkspace === null || today?.planId !== null) return;
    const targetMinutes = Number(planningTargetMinutes);
    const targetTaskCount = Number(planningTargetTaskCount);
    if (!Number.isInteger(targetMinutes) || targetMinutes < 1 || targetMinutes > 1_440) {
      setTodayError("Time budget must be a whole number from 1 to 1,440 minutes.");
      return;
    }
    if (!Number.isInteger(targetTaskCount) || targetTaskCount < 1 || targetTaskCount > 64) {
      setTodayError("Task limit must be a whole number from 1 to 64.");
      return;
    }
    let startsAt: string;
    let endsAt: string;
    try {
      startsAt = localDateTimeToIso(todayDate, planningStartsAt);
      endsAt = localDateTimeToIso(todayDate, planningEndsAt);
    } catch {
      setTodayError("Choose valid local start and end times.");
      return;
    }
    if (new Date(endsAt) <= new Date(startsAt)) {
      setTodayError("The work window must end after it starts.");
      return;
    }
    const intent: TodayGenerationIntent = {
      workspaceId: selectedWorkspace.id,
      date: todayDate,
      timeZone,
      window: { startsAt, endsAt },
      targetMinutes,
      targetTaskCount,
      idempotencyKey: crypto.randomUUID(),
    };
    setTodayGenerationRetry(intent);
    void submitTodayGeneration(intent);
  }

  async function logout() {
    setBusy(true);
    setError(null);
    try {
      await hostedApi.logout();
      setWorkspaces([]);
      setSelectedWorkspaceId(null);
      setMode("signed-out");
    } catch (logoutError) {
      setError(publicError(logoutError));
    } finally {
      setBusy(false);
    }
  }

  if (mode === "loading") {
    return (
      <main className="hosted-state-shell" aria-label="Loading Schedule">
        <div className="brand-lockup">
          <CircleDotDashed aria-hidden="true" />
          <span>Schedule</span>
        </div>
        <PageSkeleton rows={2} />
      </main>
    );
  }

  if (mode === "signed-out") {
    return (
      <main className="hosted-state-shell hosted-sign-in">
        <div className="hosted-mark" aria-hidden="true">
          <CircleDotDashed size={32} strokeWidth={1.7} />
        </div>
        <p className="eyebrow">Schedule capture</p>
        <h1>Capture work without losing your place.</h1>
        <p className="hosted-state-copy">
          Sign in to add one item to your backlog. Your identity provider handles authentication.
        </p>
        {error === null ? null : <ErrorNotice message={error} />}
        <a className="button button-primary hosted-sign-in-button" href={hostedApi.signInPath}>
          Sign in
        </a>
      </main>
    );
  }

  if (mode === "unavailable") {
    return (
      <main className="hosted-state-shell">
        <p className="eyebrow">Schedule capture</p>
        <h1>Schedule is unavailable.</h1>
        {error === null ? null : <ErrorNotice message={error} />}
        <Button type="button" variant="primary" onClick={() => void load()}>
          Try again
        </Button>
      </main>
    );
  }

  return (
    <div className="hosted-shell">
      <header className="hosted-topbar">
        <div className="brand-lockup">
          <CircleDotDashed aria-hidden="true" />
          <span>Schedule</span>
        </div>
        <Button
          type="button"
          variant="quiet"
          busy={busy}
          disabled={generatingToday || updatingItem !== null || updatingTodayItem !== null}
          onClick={() => void logout()}
        >
          <LogOut size={16} aria-hidden="true" />
          Sign out
        </Button>
      </header>

      <main className="hosted-main">
        <p className="eyebrow">Quick capture</p>
        <h1>What needs doing?</h1>
        <p className="hosted-intro">Add one item now. Scheduling details stay optional.</p>

        {error === null ? null : (
          <ErrorNotice
            message={error}
            action={
              <Button type="button" variant="quiet" onClick={() => void load()}>
                Reload
              </Button>
            }
          />
        )}

        {selectedWorkspace === null ? (
          <section className="hosted-empty" aria-labelledby="hosted-empty-title">
            <h2 id="hosted-empty-title">Create a workspace</h2>
            <p>Name a workspace to start capturing work.</p>
            <WorkspaceCreateForm
              name={workspaceName}
              busy={busy}
              autoFocus
              onNameChange={setWorkspaceName}
              onSubmit={(event) => void createWorkspace(event)}
            />
          </section>
        ) : (
          <section className="hosted-capture" aria-labelledby="hosted-capture-title">
            <h2 id="hosted-capture-title" className="sr-only">
              Add backlog item
            </h2>
            {workspaces.length > 1 ? (
              <Field label="Workspace" className="hosted-workspace-field">
                <select
                  value={selectedWorkspace.id}
                  disabled={mutationBusy}
                  onChange={(event) => selectWorkspace(event.target.value)}
                >
                  {workspaces.map((workspace) => (
                    <option key={workspace.id} value={workspace.id}>
                      {workspace.name}
                    </option>
                  ))}
                </select>
              </Field>
            ) : (
              <p className="hosted-workspace-name">
                Backlog <span aria-hidden="true">·</span> {selectedWorkspace.name}
              </p>
            )}

            <details className="hosted-workspace-create">
              <summary>Create another workspace</summary>
              <WorkspaceCreateForm
                name={workspaceName}
                busy={mutationBusy}
                onNameChange={setWorkspaceName}
                onSubmit={(event) => void createWorkspace(event)}
              />
            </details>

            <form className="hosted-capture-form" onSubmit={(event) => void capture(event)}>
              <Field label="Work item" className="hosted-capture-title">
                <input
                  ref={titleInput}
                  autoFocus
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  maxLength={240}
                  placeholder="Prepare next week’s plan"
                  disabled={mutationBusy}
                  required
                />
              </Field>
              <details className="hosted-capture-details">
                <summary>Scheduling details (optional)</summary>
                <div className="hosted-capture-fields">
                  <Field label="Priority">
                    <select
                      value={priority}
                      disabled={mutationBusy}
                      onChange={(event) =>
                        setPriority(event.target.value as HostedWorkItemPriority)
                      }
                    >
                      <option value="none">No priority</option>
                      <option value="low">Low</option>
                      <option value="medium">Medium</option>
                      <option value="high">High</option>
                      <option value="urgent">Urgent</option>
                    </select>
                  </Field>
                  <Field label="Due date">
                    <input
                      type="date"
                      value={dueOn}
                      disabled={mutationBusy}
                      onChange={(event) => setDueOn(event.target.value)}
                    />
                  </Field>
                  <Field
                    label="Planning time (minutes)"
                    hint="Leave blank to keep this item out of daily planning."
                  >
                    <input
                      type="number"
                      inputMode="numeric"
                      min={1}
                      max={43_200}
                      step={1}
                      value={planningDuration}
                      disabled={mutationBusy}
                      onChange={(event) => setPlanningDuration(event.target.value)}
                    />
                  </Field>
                </div>
              </details>
              <Button
                type="submit"
                variant="primary"
                busy={busy}
                disabled={title.trim() === "" || mutationBusy}
              >
                <Plus size={17} aria-hidden="true" />
                Add to backlog
              </Button>
            </form>

            {confirmation === null ? null : (
              <p className="hosted-confirmation" role="status">
                <CheckCircle2 size={18} aria-hidden="true" />
                <span>{confirmation}</span>
              </p>
            )}
            <div className="hosted-today" aria-labelledby="hosted-today-title">
              <div className="hosted-today-heading">
                <h2 ref={todayHeading} id="hosted-today-title" tabIndex={-1}>
                  Today
                </h2>
                {today?.planId == null ? null : <span>{formatMinutes(today.totalMinutes)}</span>}
              </div>
              {todayLoading ? (
                <p className="hosted-today-state" role="status">
                  Loading today…
                </p>
              ) : todayError !== null ? (
                <ErrorNotice
                  message={todayError}
                  action={
                    <Button
                      type="button"
                      variant="quiet"
                      busy={
                        (todayGenerationRetry !== null && generatingToday) ||
                        (todayRetry !== null && updatingTodayItem !== null)
                      }
                      disabled={mutationBusy}
                      onClick={() => {
                        if (todayGenerationRetry !== null)
                          void submitTodayGeneration(todayGenerationRetry);
                        else if (todayRetry !== null) void submitTodayAction(todayRetry);
                        else setTodayRefresh((value) => value + 1);
                      }}
                    >
                      {todayGenerationRetry !== null
                        ? "Retry plan"
                        : todayRetry === null
                          ? "Retry today"
                          : "Retry action"}
                    </Button>
                  }
                />
              ) : today === null ? null : today.planId === null ? (
                <form
                  className="hosted-plan-form"
                  onSubmit={(event) => beginTodayGeneration(event)}
                >
                  <div className="hosted-plan-intro">
                    <h3>Build today’s plan</h3>
                    <p>Choose one work window and cap both time and task count.</p>
                    <span>{timeZone}</span>
                  </div>
                  <div className="hosted-plan-fields">
                    <Field label="Work window starts">
                      <input
                        type="time"
                        value={planningStartsAt}
                        disabled={mutationBusy}
                        required
                        onChange={(event) => setPlanningStartsAt(event.target.value)}
                      />
                    </Field>
                    <Field label="Work window ends">
                      <input
                        type="time"
                        value={planningEndsAt}
                        disabled={mutationBusy}
                        required
                        onChange={(event) => setPlanningEndsAt(event.target.value)}
                      />
                    </Field>
                    <Field label="Time budget (minutes)">
                      <input
                        type="number"
                        inputMode="numeric"
                        min={1}
                        max={1_440}
                        step={1}
                        value={planningTargetMinutes}
                        disabled={mutationBusy}
                        required
                        onChange={(event) => setPlanningTargetMinutes(event.target.value)}
                      />
                    </Field>
                    <Field label="Task limit">
                      <input
                        type="number"
                        inputMode="numeric"
                        min={1}
                        max={64}
                        step={1}
                        value={planningTargetTaskCount}
                        disabled={mutationBusy}
                        required
                        onChange={(event) => setPlanningTargetTaskCount(event.target.value)}
                      />
                    </Field>
                  </div>
                  <Button
                    type="submit"
                    variant="primary"
                    busy={generatingToday}
                    disabled={mutationBusy}
                  >
                    Build plan
                  </Button>
                </form>
              ) : today.items.length === 0 ? (
                <p className="hosted-today-state">No eligible work fit this plan.</p>
              ) : (
                <ul className="hosted-today-list">
                  {today.items.map((item) => (
                    <li key={item.id}>
                      <span className="hosted-today-copy">
                        <span>{item.title}</span>
                        <span className="hosted-today-meta">
                          {formatMinutes(item.scheduledMinutes)} · {titleCase(item.activityState)}
                        </span>
                      </span>
                      {today.planId === null ||
                      today.headVersion === null ||
                      (item.activityState !== "pending" &&
                        item.activityState !== "started") ? null : (
                        <span className="hosted-today-actions">
                          {item.activityState !== "pending" ? null : (
                            <Button
                              type="button"
                              variant="quiet"
                              aria-label={`Start ${item.title} in Today`}
                              busy={
                                updatingTodayItem?.id === item.id &&
                                updatingTodayItem.type === "started"
                              }
                              disabled={mutationBusy}
                              onClick={() => beginTodayAction(item, "started")}
                            >
                              Start
                            </Button>
                          )}
                          <Button
                            type="button"
                            variant="quiet"
                            aria-label={`Complete ${item.title} in Today`}
                            busy={
                              updatingTodayItem?.id === item.id &&
                              updatingTodayItem.type === "completed"
                            }
                            disabled={mutationBusy}
                            onClick={() => beginTodayAction(item, "completed")}
                          >
                            Done
                          </Button>
                          <Button
                            type="button"
                            variant="quiet"
                            aria-label={`Skip ${item.title} in Today`}
                            busy={
                              updatingTodayItem?.id === item.id &&
                              updatingTodayItem.type === "skipped"
                            }
                            disabled={mutationBusy}
                            onClick={() => beginTodayAction(item, "skipped")}
                          >
                            Skip
                          </Button>
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="hosted-backlog" aria-labelledby="hosted-backlog-title">
              <div className="hosted-backlog-heading">
                <h2 id="hosted-backlog-title">Backlog snapshot</h2>
                <span>First 20</span>
              </div>
              {backlogLoading ? (
                <p className="hosted-backlog-state" role="status">
                  Loading backlog…
                </p>
              ) : backlogError !== null ? (
                <ErrorNotice
                  message={backlogError}
                  action={
                    <Button
                      type="button"
                      variant="quiet"
                      onClick={() => setBacklogRefresh((value) => value + 1)}
                    >
                      Retry backlog
                    </Button>
                  }
                />
              ) : backlogItems.length === 0 ? (
                <p className="hosted-backlog-state">No backlog items yet.</p>
              ) : (
                <ul className="hosted-backlog-list">
                  {backlogItems.map((item) => {
                    const meta = backlogMeta(item);
                    return (
                      <li key={item.id}>
                        <span className="hosted-backlog-copy">
                          <span className="hosted-backlog-title">{item.title}</span>
                          {meta === null ? null : (
                            <span className="hosted-backlog-meta">{meta}</span>
                          )}
                        </span>
                        <span className="hosted-backlog-actions">
                          <Button
                            type="button"
                            variant="quiet"
                            aria-label={`Start ${item.title}`}
                            busy={
                              updatingItem?.id === item.id && updatingItem.status === "in_progress"
                            }
                            disabled={mutationBusy}
                            onClick={() => void updateStatus(item, "in_progress")}
                          >
                            Start
                          </Button>
                          <Button
                            type="button"
                            variant="quiet"
                            aria-label={`Complete ${item.title}`}
                            busy={updatingItem?.id === item.id && updatingItem.status === "done"}
                            disabled={mutationBusy}
                            onClick={() => void updateStatus(item, "done")}
                          >
                            Done
                          </Button>
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
