import { CheckCircle2, CircleDotDashed, LogOut, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";

import { Button, ErrorNotice, Field, PageSkeleton } from "./components/ui";
import { formatMinutes, todayKey } from "./date";
import {
  hostedApi,
  HostedApiError,
  type HostedToday,
  type HostedTodayActivityState,
  type HostedWorkItem,
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
  readonly type: "started" | "completed";
  readonly occurredAt: string;
  readonly idempotencyKey: string;
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

function activityLabel(state: HostedTodayActivityState): string {
  return `${state.charAt(0).toUpperCase()}${state.slice(1)}`;
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
  const [updatingTodayItem, setUpdatingTodayItem] = useState<{
    readonly id: string;
    readonly type: "started" | "completed";
  } | null>(null);
  const [updatingItem, setUpdatingItem] = useState<{
    readonly id: string;
    readonly status: "in_progress" | "done";
  } | null>(null);

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
  const mutationBusy = busy || updatingItem !== null || updatingTodayItem !== null;

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
  }

  async function capture(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const capturedTitle = title.trim();
    if (selectedWorkspace === null || capturedTitle.length === 0) return;
    setBusy(true);
    setError(null);
    setConfirmation(null);
    try {
      await hostedApi.createWorkItem(selectedWorkspace.id, capturedTitle);
      setTitle("");
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
    setTodayError(null);
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
      setConfirmation(
        intent.type === "completed" ? `Completed “${intent.title}”.` : `Started “${intent.title}”.`,
      );
      setTodayRefresh((value) => value + 1);
      setBacklogRefresh((value) => value + 1);
    } catch (activityError) {
      const known = activityError instanceof HostedApiError;
      if (known && activityError.status === 401) {
        setTodayRetry(null);
        setMode("signed-out");
        setError(publicError(activityError));
      } else {
        const ambiguous = !known || activityError.status === 429 || activityError.status >= 500;
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

  function beginTodayAction(item: HostedToday["items"][number], type: "started" | "completed") {
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
          disabled={updatingItem !== null || updatingTodayItem !== null}
          onClick={() => void logout()}
        >
          <LogOut size={16} aria-hidden="true" />
          Sign out
        </Button>
      </header>

      <main className="hosted-main">
        <p className="eyebrow">Quick capture</p>
        <h1>What needs doing?</h1>
        <p className="hosted-intro">Add one item now. Priority, timing, and planning can wait.</p>

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
              <Field label="Work item">
                <input
                  autoFocus
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  maxLength={240}
                  placeholder="Prepare next week’s plan"
                  disabled={mutationBusy}
                  required
                />
              </Field>
              <Button
                type="submit"
                variant="primary"
                busy={busy}
                disabled={
                  title.trim() === "" || updatingItem !== null || updatingTodayItem !== null
                }
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
                <h2 id="hosted-today-title">Today</h2>
                {today === null ? null : <span>{formatMinutes(today.totalMinutes)}</span>}
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
                      onClick={() => {
                        if (todayRetry === null) setTodayRefresh((value) => value + 1);
                        else void submitTodayAction(todayRetry);
                      }}
                    >
                      {todayRetry === null ? "Retry today" : "Retry action"}
                    </Button>
                  }
                />
              ) : today === null || today.items.length === 0 ? (
                <p className="hosted-today-state">Nothing planned for today.</p>
              ) : (
                <ul className="hosted-today-list">
                  {today.items.map((item) => (
                    <li key={item.id}>
                      <span className="hosted-today-copy">
                        <span>{item.title}</span>
                        <span className="hosted-today-meta">
                          {formatMinutes(item.scheduledMinutes)} ·{" "}
                          {activityLabel(item.activityState)}
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
                  {backlogItems.map((item) => (
                    <li key={item.id}>
                      <span className="hosted-backlog-title">{item.title}</span>
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
                  ))}
                </ul>
              )}
            </div>
          </section>
        )}
      </main>
    </div>
  );
}
