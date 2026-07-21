import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "./api";
import {
  App,
  type PortableExportResult,
  type PortableImportPreview,
  type PortableImportResult,
  type PortableImportSelectionResult,
} from "./App";
import type { Workspace } from "./types";

const apiMocks = vi.hoisted(() => ({
  createWorkspace: vi.fn(),
  getCurrentPlan: vi.fn(),
  getNotificationProfile: vi.fn(),
  listNotificationDeliveries: vi.fn(),
  listNotificationIntents: vi.fn(),
  listNotificationRules: vi.fn(),
  listOneOffReminders: vi.fn(),
  listWorkItems: vi.fn(),
  listWorkspaces: vi.fn(),
}));

vi.mock("./api", async (importOriginal) => {
  const original = await importOriginal<typeof import("./api")>();
  return {
    ...original,
    api: { ...original.api, ...apiMocks },
  };
});

const personalWorkspace: Workspace = {
  id: "workspace-personal",
  name: "Personal",
  createdAt: "2026-07-12T09:00:00.000Z",
  updatedAt: "2026-07-12T09:00:00.000Z",
};

const studioWorkspace: Workspace = {
  id: "workspace-studio",
  name: "Studio",
  createdAt: "2026-07-12T10:00:00.000Z",
  updatedAt: "2026-07-12T10:00:00.000Z",
};

const page = <Item,>(items: readonly Item[]) => ({ items, page: { limit: 20, offset: 0 } });

async function exportArchiveButton(): Promise<HTMLButtonElement> {
  return (await screen.findAllByRole<HTMLButtonElement>("button", { name: "Export archive" }))[0]!;
}

async function exportMessage(message: string): Promise<HTMLElement> {
  return (await screen.findAllByText(message, { exact: true }))[0]!;
}

async function importArchiveButton(): Promise<HTMLButtonElement> {
  return (await screen.findAllByRole<HTMLButtonElement>("button", { name: "Import archive" }))[0]!;
}

const importPreview: PortableImportPreview = {
  archiveId: "archive-2026-07-20",
  exportedAt: "2026-07-20T09:30:00Z",
  applicationVersion: "0.1.0",
  schemaVersion: 7,
  sizeBytes: 1_572_864,
};

function importActions(
  selection: PortableImportSelectionResult = {
    result: "selected",
    token: "opaque-import-token",
    preview: importPreview,
  },
  confirmation: PortableImportResult = { result: "imported" },
) {
  return {
    exportArchive: vi.fn().mockResolvedValue({ result: "cancelled" }),
    selectImportArchive: vi.fn().mockResolvedValue(selection),
    confirmImportArchive: vi.fn().mockResolvedValue(confirmation),
  };
}

const originalScrollIntoView = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "scrollIntoView",
);
const scrollIntoView = vi.fn();

beforeEach(() => {
  vi.resetAllMocks();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: scrollIntoView,
  });
  apiMocks.getCurrentPlan.mockRejectedValue(
    new ApiError(404, "daily_plan.not_found", "No plan exists yet.", null),
  );
  apiMocks.listWorkItems.mockResolvedValue(page([]));
  apiMocks.getNotificationProfile.mockRejectedValue(
    new ApiError(
      404,
      "notification_profile.not_found",
      "The workspace has no notification profile.",
      null,
    ),
  );
  apiMocks.listNotificationDeliveries.mockResolvedValue(page([]));
  apiMocks.listNotificationIntents.mockResolvedValue(page([]));
  apiMocks.listNotificationRules.mockResolvedValue({ items: [] });
  apiMocks.listOneOffReminders.mockResolvedValue({ items: [] });
});

afterEach(() => {
  cleanup();
  if (originalScrollIntoView === undefined) {
    delete (HTMLElement.prototype as Partial<HTMLElement>).scrollIntoView;
  } else {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScrollIntoView);
  }
});

describe("local application shell", () => {
  it("onboards an empty installation and enters the created workspace", async () => {
    const user = userEvent.setup();
    apiMocks.listWorkspaces.mockResolvedValue(page([]));
    apiMocks.createWorkspace.mockResolvedValue(personalWorkspace);

    render(<App />);

    expect(
      await screen.findByRole("heading", { name: "Give your days a shape." }),
    ).toBeInTheDocument();

    const name = screen.getByRole("textbox", { name: "Workspace name" });
    await user.clear(name);
    await user.type(name, "Personal");
    await user.click(screen.getByRole("button", { name: "Create workspace" }));

    expect(apiMocks.createWorkspace).toHaveBeenCalledWith("Personal");
    expect(await screen.findByRole("heading", { name: "Today" })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("main", { name: "Today view" })).toHaveFocus());
    expect(localStorage.getItem("schedule.selectedWorkspace")).toBe(personalWorkspace.id);
  });

  it("restores the selected workspace and navigates to Work", async () => {
    const user = userEvent.setup();
    localStorage.setItem("schedule.selectedWorkspace", studioWorkspace.id);
    apiMocks.listWorkspaces.mockResolvedValue(page([personalWorkspace, studioWorkspace]));

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Today" })).toBeInTheDocument();
    for (const selector of screen.getAllByRole("combobox", { name: "Workspace" })) {
      expect(selector).toHaveValue(studioWorkspace.id);
    }

    const desktopNavigation = screen.getAllByRole("navigation", {
      name: "Primary navigation",
    })[0];
    if (desktopNavigation === undefined) throw new Error("Desktop navigation was not rendered.");
    await user.click(within(desktopNavigation).getByRole("button", { name: "Work" }));

    expect(await screen.findByRole("heading", { name: "Work board" })).toBeInTheDocument();
    expect(window.location.hash).toBe("#work");
    await waitFor(() => expect(screen.getByRole("main", { name: "Work view" })).toHaveFocus());
    expect(scrollIntoView).toHaveBeenLastCalledWith({ block: "start", inline: "nearest" });
    expect(apiMocks.listWorkItems).toHaveBeenCalledWith(
      studioWorkspace.id,
      {},
      expect.any(AbortSignal),
    );
  });

  it("moves focus to the current view after switching workspaces", async () => {
    const user = userEvent.setup();
    localStorage.setItem("schedule.selectedWorkspace", studioWorkspace.id);
    apiMocks.listWorkspaces.mockResolvedValue(page([personalWorkspace, studioWorkspace]));

    render(<App />);

    await screen.findByRole("heading", { name: "Today" });
    const desktopWorkspace = screen.getAllByRole("combobox", { name: "Workspace" })[0];
    if (desktopWorkspace === undefined) throw new Error("Workspace selector was not rendered.");
    desktopWorkspace.focus();
    await user.selectOptions(desktopWorkspace, personalWorkspace.id);

    await waitFor(() => expect(screen.getByRole("main", { name: "Today view" })).toHaveFocus());
    expect(localStorage.getItem("schedule.selectedWorkspace")).toBe(personalWorkspace.id);
  });

  it("exposes the reminder policy and history surface in desktop and mobile navigation", async () => {
    const user = userEvent.setup();
    apiMocks.listWorkspaces.mockResolvedValue(page([personalWorkspace]));

    render(<App />);

    await screen.findByRole("heading", { name: "Today" });
    const navigation = screen.getAllByRole("navigation", { name: "Primary navigation" })[0];
    if (navigation === undefined) throw new Error("Desktop navigation was not rendered.");
    await user.click(within(navigation).getByRole("button", { name: "Reminders" }));

    expect(await screen.findByRole("heading", { name: "Reminders" })).toBeInTheDocument();
    expect(window.location.hash).toBe("#reminders");
    await waitFor(() => expect(screen.getByRole("main", { name: "Reminders view" })).toHaveFocus());
    expect(screen.getAllByRole("button", { name: "Reminders" })).toHaveLength(2);
  });

  it("offers a retry when the workspace API cannot be loaded", async () => {
    const user = userEvent.setup();
    apiMocks.listWorkspaces
      .mockRejectedValueOnce(new Error("The local database is unavailable."))
      .mockResolvedValueOnce(page([]));

    render(<App />);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The local database is unavailable.",
    );
    await user.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(apiMocks.listWorkspaces).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(screen.queryByText("The local database is unavailable.")).not.toBeInTheDocument(),
    );
    expect(screen.getByRole("button", { name: "Create workspace" })).toBeEnabled();
  });

  it("leaves the web shell unchanged when no desktop actions are provided", async () => {
    apiMocks.listWorkspaces.mockResolvedValue(page([personalWorkspace]));

    render(<App />);

    await screen.findByRole("heading", { name: "Today" });
    expect(screen.queryByRole("button", { name: "Export archive" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Import archive" })).toBeNull();
  });

  it("exports a portable archive and announces its size", async () => {
    const user = userEvent.setup();
    const exportArchive = vi.fn().mockResolvedValue({ result: "created", sizeBytes: 1_572_864 });
    apiMocks.listWorkspaces.mockResolvedValue(page([personalWorkspace]));

    render(<App desktopActions={{ exportArchive }} />);

    await user.click(await exportArchiveButton());

    expect(exportArchive).toHaveBeenCalledTimes(1);
    expect(await exportMessage("Archive exported (1.5 MB).")).toHaveAttribute("role", "status");
  });

  it("announces a cancelled portable export", async () => {
    const user = userEvent.setup();
    const exportArchive = vi.fn().mockResolvedValue({ result: "cancelled" });
    apiMocks.listWorkspaces.mockResolvedValue(page([personalWorkspace]));

    render(<App desktopActions={{ exportArchive }} />);

    await user.click(await exportArchiveButton());

    expect(await exportMessage("Export cancelled.")).toHaveAttribute("role", "status");
  });

  it.each([
    {
      name: "busy export",
      exportArchive: () => Promise.resolve<PortableExportResult>({ result: "busy" }),
      role: "status" as const,
      message: "An export is already in progress.",
    },
    {
      name: "unavailable export",
      exportArchive: () => Promise.resolve<PortableExportResult>({ result: "unavailable" }),
      role: "alert" as const,
      message: "Portable export is unavailable in this version of Schedule.",
    },
    {
      name: "generic failed export",
      exportArchive: () =>
        Promise.resolve<PortableExportResult>({ result: "failed", code: "desktop.export_failed" }),
      role: "alert" as const,
      message: "Schedule could not export the archive. Try again.",
    },
    {
      name: "rejected export command",
      exportArchive: () => Promise.reject(new Error("native bridge unavailable")),
      role: "alert" as const,
      message: "Schedule could not export the archive. Try again.",
    },
  ])(
    "announces a $name without exposing native details",
    async ({ exportArchive, role, message }) => {
      const user = userEvent.setup();
      apiMocks.listWorkspaces.mockResolvedValue(page([personalWorkspace]));

      render(<App desktopActions={{ exportArchive }} />);

      await user.click(await exportArchiveButton());

      expect(await exportMessage(message)).toHaveAttribute("role", role);
      expect(screen.queryByText("desktop.export_failed")).toBeNull();
      expect(screen.queryByText("native bridge unavailable")).toBeNull();
    },
  );

  it("does not start a second export while the first is running", async () => {
    const user = userEvent.setup();
    let finishExport!: (result: { result: "cancelled" }) => void;
    const exportArchive = vi.fn(
      () =>
        new Promise<{ result: "cancelled" }>((resolve) => {
          finishExport = resolve;
        }),
    );
    apiMocks.listWorkspaces.mockResolvedValue(page([personalWorkspace]));

    render(<App desktopActions={{ exportArchive }} />);

    const action = await exportArchiveButton();
    await user.click(action);
    expect(action).toBeDisabled();
    await user.click(action);
    expect(exportArchive).toHaveBeenCalledTimes(1);

    finishExport({ result: "cancelled" });
    expect(await exportMessage("Export cancelled.")).toHaveAttribute("role", "status");
  });

  it("explains when an archive destination already exists without exposing the native error code", async () => {
    const user = userEvent.setup();
    const exportArchive = vi
      .fn()
      .mockResolvedValue({ result: "failed", code: "destination_exists" });
    apiMocks.listWorkspaces.mockResolvedValue(page([personalWorkspace]));

    render(<App desktopActions={{ exportArchive }} />);

    await user.click(await exportArchiveButton());

    expect(
      await exportMessage(
        "An archive with that name already exists. Choose another name, then try again.",
      ),
    ).toHaveAttribute("role", "alert");
    expect(screen.queryByText("destination_exists")).toBeNull();
  });

  it("offers portable import during desktop workspace onboarding", async () => {
    const user = userEvent.setup();
    const actions = importActions();
    apiMocks.listWorkspaces.mockResolvedValue(page([]));

    render(<App desktopActions={actions} />);

    expect(await screen.findByRole("heading", { name: "Give your days a shape." })).toBeVisible();
    await user.click(await importArchiveButton());

    expect(actions.selectImportArchive).toHaveBeenCalledTimes(1);
    expect(await screen.findByRole("region", { name: "Confirm archive import" })).toBeVisible();
    expect(screen.getByText(importPreview.archiveId)).toBeVisible();
    expect(screen.queryByText("opaque-import-token")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Replace local data and restart" }));

    expect(actions.confirmImportArchive).toHaveBeenCalledWith("opaque-import-token");
    expect(await exportMessage("Archive imported. Local services restarted.")).toHaveAttribute(
      "role",
      "status",
    );
  });

  it("requires a redacted preview and explicit confirmation before importing", async () => {
    const user = userEvent.setup();
    const actions = importActions();
    const importedWorkspace = { ...studioWorkspace, name: "Imported workspace" };
    apiMocks.listWorkspaces
      .mockResolvedValueOnce(page([personalWorkspace]))
      .mockResolvedValueOnce(page([importedWorkspace]));

    render(<App desktopActions={actions} />);

    await user.click(await importArchiveButton());

    expect(actions.selectImportArchive).toHaveBeenCalledTimes(1);
    expect(await screen.findAllByRole("region", { name: "Confirm archive import" })).toHaveLength(
      2,
    );
    expect(screen.getAllByText(importPreview.archiveId)).toHaveLength(2);
    expect(screen.getAllByText("1.5 MB")).toHaveLength(2);
    expect(screen.queryByText("opaque-import-token")).toBeNull();
    expect(actions.confirmImportArchive).not.toHaveBeenCalled();

    const confirmation = (
      await screen.findAllByRole("button", {
        name: "Replace local data and restart",
      })
    )[0]!;
    await user.click(confirmation);

    expect(actions.confirmImportArchive).toHaveBeenCalledWith("opaque-import-token");
    expect(await exportMessage("Archive imported. Local services restarted.")).toHaveAttribute(
      "role",
      "status",
    );
    expect(await screen.findAllByText("Imported workspace")).toHaveLength(2);
    expect(localStorage.getItem("schedule.selectedWorkspace")).toBe(importedWorkspace.id);
    expect(apiMocks.listWorkspaces).toHaveBeenCalledTimes(2);
  });

  it("cancels a selected archive without invoking the destructive native action", async () => {
    const user = userEvent.setup();
    const actions = importActions();
    apiMocks.listWorkspaces.mockResolvedValue(page([personalWorkspace]));

    render(<App desktopActions={actions} />);

    await user.click(await importArchiveButton());
    const cancel = (await screen.findAllByRole("button", { name: "Cancel import" }))[0]!;
    await user.click(cancel);

    expect(actions.confirmImportArchive).not.toHaveBeenCalled();
    expect(await exportMessage("Import cancelled.")).toHaveAttribute("role", "status");
    expect(await importArchiveButton()).toBeEnabled();
  });

  it.each([
    {
      name: "busy selection",
      selection: { result: "busy" } as PortableImportSelectionResult,
      message: "Another portable operation is already in progress.",
      role: "status" as const,
    },
    {
      name: "unavailable selection",
      selection: { result: "unavailable" } as PortableImportSelectionResult,
      message: "Portable import is unavailable in this version of Schedule.",
      role: "alert" as const,
    },
    {
      name: "failed selection",
      selection: { result: "failed", code: "archive.invalid" } as PortableImportSelectionResult,
      message: "Schedule could not inspect the archive. Try again.",
      role: "alert" as const,
    },
  ])("announces $name without exposing native details", async ({ selection, message, role }) => {
    const user = userEvent.setup();
    const actions = importActions(selection);
    apiMocks.listWorkspaces.mockResolvedValue(page([personalWorkspace]));

    render(<App desktopActions={actions} />);
    await user.click(await importArchiveButton());

    expect(await exportMessage(message)).toHaveAttribute("role", role);
    expect(screen.queryByText("archive.invalid")).toBeNull();
  });

  it("keeps the import selection while a confirmation is busy", async () => {
    const user = userEvent.setup();
    const actions = importActions(undefined, { result: "busy" });
    apiMocks.listWorkspaces.mockResolvedValue(page([personalWorkspace]));

    render(<App desktopActions={actions} />);
    await user.click(await importArchiveButton());
    await user.click(
      (await screen.findAllByRole("button", { name: "Replace local data and restart" }))[0]!,
    );

    expect(
      await exportMessage("Another portable operation is already in progress."),
    ).toHaveAttribute("role", "status");
    expect(screen.getAllByRole("button", { name: "Replace local data and restart" })).toHaveLength(
      2,
    );
  });

  it.each([
    {
      result: "imported_restart_required" as const,
      message:
        "Archive imported. Restart Schedule to finish starting local services. Do not import it again.",
    },
    {
      result: "recovery_required" as const,
      message:
        "Import was interrupted. Restart Schedule to recover local data safely. Do not import again.",
    },
  ])("does not invite a destructive retry for $result", async ({ result, message }) => {
    const user = userEvent.setup();
    const actions = importActions(undefined, { result });
    apiMocks.listWorkspaces.mockResolvedValue(page([personalWorkspace]));

    render(<App desktopActions={actions} />);
    await user.click(await importArchiveButton());
    await user.click(
      (await screen.findAllByRole("button", { name: "Replace local data and restart" }))[0]!,
    );

    expect(await exportMessage(message)).toHaveAttribute("role", "alert");
    expect(screen.queryByRole("button", { name: "Replace local data and restart" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Import archive" })).toBeNull();
    expect(screen.getAllByText("Portable import is locked until Schedule restarts.")).toHaveLength(
      2,
    );
  });
});
