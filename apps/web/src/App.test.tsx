import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "./api";
import { App } from "./App";
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
});
