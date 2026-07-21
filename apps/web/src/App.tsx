import {
  CalendarDays,
  BellRing,
  CheckCircle2,
  ChevronDown,
  CircleDotDashed,
  Columns3,
  Plus,
  Repeat2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import { api, ApiError } from "./api";
import { Button, ErrorNotice, PageSkeleton } from "./components/ui";
import type { AppSection, Workspace } from "./types";
import { CalendarView } from "./views/CalendarView";
import { RoutinesView } from "./views/RoutinesView";
import { RemindersView } from "./views/RemindersView";
import { TodayView } from "./views/TodayView";
import { WorkView } from "./views/WorkView";

const SELECTED_WORKSPACE_KEY = "schedule.selectedWorkspace";

export type PortableExportResult =
  | { readonly result: "created"; readonly sizeBytes: number }
  | { readonly result: "cancelled" | "busy" | "unavailable" }
  | { readonly result: "failed"; readonly code: string };

export interface DesktopActions {
  readonly exportArchive: () => Promise<PortableExportResult>;
}

const navigation = [
  { id: "today", label: "Today", icon: CheckCircle2 },
  { id: "work", label: "Work", icon: Columns3 },
  { id: "routines", label: "Routines", icon: Repeat2 },
  { id: "calendar", label: "Calendar", icon: CalendarDays },
  { id: "reminders", label: "Reminders", icon: BellRing },
] as const;

function sectionFromHash(): AppSection {
  const value = window.location.hash.replace(/^#\/?/, "");
  return navigation.some((item) => item.id === value) ? (value as AppSection) : "today";
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError && error.status === 404) {
    return "The local API is running, but this workspace is no longer available.";
  }
  if (error instanceof Error) return error.message;
  return "The local API could not be reached.";
}

function WorkspaceSetup({
  busy,
  error,
  onCreate,
  onRetry,
}: {
  readonly busy: boolean;
  readonly error: string | null;
  readonly onCreate: (name: string) => Promise<void>;
  readonly onRetry: () => void;
}) {
  const [name, setName] = useState("Personal");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (name.trim().length === 0) return;
    await onCreate(name.trim());
  }

  return (
    <main className="onboarding-shell">
      <div className="onboarding-mark" aria-hidden="true">
        <CircleDotDashed size={32} strokeWidth={1.7} />
      </div>
      <p className="eyebrow">Local-first planning</p>
      <h1>Give your days a shape.</h1>
      <p className="onboarding-copy">
        Start with one private workspace. Your routines, plans, work, and calendar stay in the local
        database.
      </p>
      {error === null ? null : (
        <ErrorNotice
          message={error}
          action={
            <Button type="button" variant="quiet" onClick={onRetry}>
              Retry
            </Button>
          }
        />
      )}
      <form className="onboarding-form" onSubmit={(event) => void submit(event)}>
        <label className="field">
          <span className="field-label">Workspace name</span>
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={160}
            placeholder="Personal"
          />
        </label>
        <Button variant="primary" type="submit" busy={busy}>
          Create workspace
        </Button>
      </form>
      <p className="onboarding-footnote">No account, cloud service, or AI model is required.</p>
    </main>
  );
}

function exportFailureMessage(code: string): string {
  if (code === "destination_exists" || code.endsWith("destination_exists")) {
    return "An archive with that name already exists. Choose another name, then try again.";
  }
  return "Schedule could not export the archive. Try again.";
}

function archiveSize(sizeBytes: number): string {
  if (sizeBytes < 1_024) return `${sizeBytes} bytes`;
  if (sizeBytes < 1_024 * 1_024) return `${(sizeBytes / 1_024).toFixed(1)} KB`;
  return `${(sizeBytes / (1_024 * 1_024)).toFixed(1)} MB`;
}

function PortableExportControl({
  exporting,
  message,
  onExport,
}: {
  readonly exporting: boolean;
  readonly message: { readonly tone: "status" | "error"; readonly text: string } | null;
  readonly onExport: () => void;
}) {
  return (
    <section className="portable-export" aria-label="Portable archive export">
      <Button type="button" variant="quiet" busy={exporting} onClick={onExport}>
        Export archive
      </Button>
      <p className="portable-export-note">
        Archives contain private data and are not encrypted or signed.
      </p>
      {message === null ? null : (
        <p
          className={`portable-export-message portable-export-message--${message.tone}`}
          role={message.tone === "error" ? "alert" : "status"}
          aria-live="polite"
        >
          {message.text}
        </p>
      )}
    </section>
  );
}

export function App({ desktopActions }: { readonly desktopActions?: DesktopActions }) {
  const contentRef = useRef<HTMLElement>(null);
  const previousSectionRef = useRef<AppSection | null>(null);
  const previousWorkspaceIdRef = useRef<string | null>(null);
  const [section, setSection] = useState<AppSection>(sectionFromHash);
  const [workspaces, setWorkspaces] = useState<readonly Workspace[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string | null>(() =>
    localStorage.getItem(SELECTED_WORKSPACE_KEY),
  );
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showWorkspaceCreator, setShowWorkspaceCreator] = useState(false);
  const [newWorkspaceName, setNewWorkspaceName] = useState("");
  const [exporting, setExporting] = useState(false);
  const [exportMessage, setExportMessage] = useState<{
    readonly tone: "status" | "error";
    readonly text: string;
  } | null>(null);

  const loadWorkspaces = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const result = await api.listWorkspaces();
      setWorkspaces(result.items);
      const stored = localStorage.getItem(SELECTED_WORKSPACE_KEY);
      const selected = result.items.find((workspace) => workspace.id === stored) ?? result.items[0];
      setSelectedWorkspaceId(selected?.id ?? null);
    } catch (error) {
      setLoadError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadWorkspaces();
  }, [loadWorkspaces]);

  useEffect(() => {
    const onHashChange = () => setSection(sectionFromHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === selectedWorkspaceId) ?? null,
    [selectedWorkspaceId, workspaces],
  );

  useEffect(() => {
    if (selectedWorkspace === null) {
      previousSectionRef.current = null;
      previousWorkspaceIdRef.current = null;
      return;
    }
    const workspaceChanged = previousWorkspaceIdRef.current !== selectedWorkspace.id;
    const sectionChanged = previousSectionRef.current !== section;
    previousSectionRef.current = section;
    previousWorkspaceIdRef.current = selectedWorkspace.id;
    if (!workspaceChanged && !sectionChanged) return;
    window.requestAnimationFrame(() => {
      const content = contentRef.current;
      if (content === null) return;
      content.focus({ preventScroll: true });
      content.scrollIntoView?.({ block: "start", inline: "nearest" });
    });
  }, [section, selectedWorkspace]);

  function selectWorkspace(id: string) {
    localStorage.setItem(SELECTED_WORKSPACE_KEY, id);
    setSelectedWorkspaceId(id);
  }

  function navigate(next: AppSection) {
    if (window.location.hash !== `#${next}`) window.location.hash = next;
    setSection(next);
  }

  async function createWorkspace(name: string) {
    setCreating(true);
    setLoadError(null);
    try {
      const workspace = await api.createWorkspace(name);
      setWorkspaces((current) => [...current, workspace]);
      selectWorkspace(workspace.id);
      setNewWorkspaceName("");
      setShowWorkspaceCreator(false);
      navigate("today");
    } catch (error) {
      setLoadError(errorMessage(error));
    } finally {
      setCreating(false);
    }
  }

  async function exportArchive() {
    if (desktopActions === undefined || exporting) return;
    setExporting(true);
    setExportMessage(null);
    try {
      const result = await desktopActions.exportArchive();
      switch (result.result) {
        case "created":
          setExportMessage({
            tone: "status",
            text: `Archive exported (${archiveSize(result.sizeBytes)}).`,
          });
          break;
        case "cancelled":
          setExportMessage({ tone: "status", text: "Export cancelled." });
          break;
        case "busy":
          setExportMessage({ tone: "status", text: "An export is already in progress." });
          break;
        case "unavailable":
          setExportMessage({
            tone: "error",
            text: "Portable export is unavailable in this version of Schedule.",
          });
          break;
        case "failed":
          setExportMessage({ tone: "error", text: exportFailureMessage(result.code) });
          break;
      }
    } catch {
      setExportMessage({
        tone: "error",
        text: "Schedule could not export the archive. Try again.",
      });
    } finally {
      setExporting(false);
    }
  }

  if (loading) {
    return (
      <main className="loading-shell">
        <div className="brand-lockup">
          <CircleDotDashed aria-hidden="true" />
          <span>Schedule</span>
        </div>
        <PageSkeleton rows={3} />
      </main>
    );
  }

  if (selectedWorkspace === null) {
    return (
      <WorkspaceSetup
        busy={creating}
        error={loadError}
        onCreate={createWorkspace}
        onRetry={() => void loadWorkspaces()}
      />
    );
  }

  const viewProps = { workspace: selectedWorkspace, onNavigate: navigate };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand-lockup">
          <CircleDotDashed aria-hidden="true" />
          <span>Schedule</span>
        </div>

        <nav className="primary-nav" aria-label="Primary navigation">
          {navigation.map((item) => {
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                className="nav-item"
                aria-current={section === item.id ? "page" : undefined}
                onClick={() => navigate(item.id)}
              >
                <Icon size={18} aria-hidden="true" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="workspace-control">
          <label>
            <span>Workspace</span>
            <span className="select-wrap">
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
              <ChevronDown size={14} aria-hidden="true" />
            </span>
          </label>

          {showWorkspaceCreator ? (
            <form
              className="workspace-create-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (newWorkspaceName.trim().length > 0) {
                  void createWorkspace(newWorkspaceName.trim());
                }
              }}
            >
              <input
                value={newWorkspaceName}
                onChange={(event) => setNewWorkspaceName(event.target.value)}
                placeholder="Workspace name"
                maxLength={160}
                aria-label="New workspace name"
              />
              <Button type="submit" variant="primary" busy={creating}>
                Add
              </Button>
            </form>
          ) : (
            <button
              className="workspace-add-button"
              type="button"
              onClick={() => setShowWorkspaceCreator(true)}
            >
              <Plus size={15} aria-hidden="true" />
              New workspace
            </button>
          )}
        </div>

        <div className="local-status">
          <span aria-hidden="true" />
          Local workspace
        </div>
        {desktopActions === undefined ? null : (
          <PortableExportControl
            exporting={exporting}
            message={exportMessage}
            onExport={() => void exportArchive()}
          />
        )}
      </aside>

      <header className="mobile-header">
        <div className="brand-lockup">
          <CircleDotDashed aria-hidden="true" />
          <span>Schedule</span>
        </div>
        <select
          aria-label="Workspace"
          value={selectedWorkspace.id}
          onChange={(event) => selectWorkspace(event.target.value)}
        >
          {workspaces.map((workspace) => (
            <option key={workspace.id} value={workspace.id}>
              {workspace.name}
            </option>
          ))}
        </select>
      </header>

      <main
        className="content-shell"
        ref={contentRef}
        tabIndex={-1}
        aria-label={`${navigation.find((item) => item.id === section)?.label ?? section} view`}
      >
        {desktopActions === undefined ? null : (
          <div className="portable-export-mobile">
            <PortableExportControl
              exporting={exporting}
              message={exportMessage}
              onExport={() => void exportArchive()}
            />
          </div>
        )}
        {loadError === null ? null : (
          <ErrorNotice message={loadError} onDismiss={() => setLoadError(null)} />
        )}
        {section === "today" ? (
          <TodayView key={`today-${selectedWorkspace.id}`} {...viewProps} />
        ) : null}
        {section === "work" ? (
          <WorkView key={`work-${selectedWorkspace.id}`} {...viewProps} />
        ) : null}
        {section === "routines" ? (
          <RoutinesView key={`routines-${selectedWorkspace.id}`} {...viewProps} />
        ) : null}
        {section === "calendar" ? (
          <CalendarView key={`calendar-${selectedWorkspace.id}`} {...viewProps} />
        ) : null}
        {section === "reminders" ? (
          <RemindersView key={`reminders-${selectedWorkspace.id}`} {...viewProps} />
        ) : null}
      </main>

      <nav className="mobile-nav" aria-label="Primary navigation">
        {navigation.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              aria-current={section === item.id ? "page" : undefined}
              onClick={() => navigate(item.id)}
            >
              <Icon size={19} aria-hidden="true" />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}
