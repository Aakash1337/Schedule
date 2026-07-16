import { CheckCircle2, CircleDotDashed, LogOut, Plus } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";

import { Button, ErrorNotice, Field, PageSkeleton } from "./components/ui";
import { hostedApi, HostedApiError, type HostedWorkspace } from "./hosted-api";

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

export function HostedApp() {
  const [mode, setMode] = useState<"loading" | "signed-out" | "ready" | "unavailable">("loading");
  const [workspaces, setWorkspaces] = useState<readonly HostedWorkspace[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<string | null>(null);

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
    void load();
  }, [load]);

  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? null,
    [selectedWorkspaceId, workspaces],
  );

  function selectWorkspace(id: string) {
    localStorage.setItem(selectedWorkspaceKey, id);
    setSelectedWorkspaceId(id);
    setConfirmation(null);
    setError(null);
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
          </section>
        )}
      </main>
    </div>
  );
}
