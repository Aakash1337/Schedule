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

function publicError(error: unknown): string {
  if (error instanceof HostedApiError) {
    if (error.status === 401) return "Your session ended. Sign in again.";
    if (error.status === 403) return "Request verification expired. Reload and try again.";
    if (error.status === 404) return "Workspace access changed. Reload before capturing more work.";
    if (error.status === 429) return "Too many requests. Wait a moment and try again.";
    if (error.status === 503) return "Schedule is temporarily unavailable.";
  }
  return "Schedule could not be reached.";
}

function activityLabel(state: HostedTodayActivityState): string {
  return `${state.charAt(0).toUpperCase()}${state.slice(1)}`;
}

export function HostedApp() {
  const [mode, setMode] = useState<"loading" | "signed-out" | "ready" | "unavailable">("loading");
  const [workspaces, setWorkspaces] = useState<readonly HostedWorkspace[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
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
      return;
    }
    let active = true;
    setToday(null);
    setTodayLoading(true);
    setTodayError(null);
    void hostedApi
      .getToday(selectedWorkspaceId, todayDate)
      .then((result) => {
        if (active) setToday(result);
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
        <Button type="button" variant="quiet" busy={busy} onClick={() => void logout()}>
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
            <h2 id="hosted-empty-title">No active workspace</h2>
            <p>Ask a workspace owner to restore access, then reload this page.</p>
            <Button type="button" onClick={() => void load()}>
              Reload
            </Button>
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
                  disabled={busy}
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

            <form className="hosted-capture-form" onSubmit={(event) => void capture(event)}>
              <Field label="Work item">
                <input
                  autoFocus
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                  maxLength={240}
                  placeholder="Prepare next week’s plan"
                  required
                />
              </Field>
              <Button type="submit" variant="primary" busy={busy} disabled={title.trim() === ""}>
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
                      onClick={() => setTodayRefresh((value) => value + 1)}
                    >
                      Retry today
                    </Button>
                  }
                />
              ) : today === null || today.items.length === 0 ? (
                <p className="hosted-today-state">Nothing planned for today.</p>
              ) : (
                <ul className="hosted-today-list">
                  {today.items.map((item, index) => (
                    <li key={`${item.title}:${index}`}>
                      <span>{item.title}</span>
                      <span className="hosted-today-meta">
                        {formatMinutes(item.scheduledMinutes)} · {activityLabel(item.activityState)}
                      </span>
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
                    <li key={item.id}>{item.title}</li>
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
