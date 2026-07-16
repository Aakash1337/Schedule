import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HostedApp } from "./HostedApp";
import { HostedApiError } from "./hosted-api";

const apiMocks = vi.hoisted(() => ({
  session: vi.fn(),
  listWorkspaces: vi.fn(),
  listWorkItems: vi.fn(),
  createWorkItem: vi.fn(),
  logout: vi.fn(),
}));

vi.mock("./hosted-api", async (importOriginal) => {
  const original = await importOriginal<typeof import("./hosted-api")>();
  return {
    ...original,
    hostedApi: { ...original.hostedApi, ...apiMocks },
  };
});

const personal = { id: "workspace-personal", name: "My Schedule" };
const studio = { id: "workspace-studio", name: "Studio" };

beforeEach(() => {
  vi.resetAllMocks();
  apiMocks.listWorkItems.mockResolvedValue({ items: [], limit: 20, offset: 0 });
});

afterEach(() => {
  cleanup();
});

describe("hosted capture shell", () => {
  it("offers provider sign-in without exposing product controls", async () => {
    apiMocks.session.mockResolvedValue({ authenticated: false });

    render(<HostedApp />);

    expect(
      await screen.findByRole("heading", { name: "Capture work without losing your place." }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/v1/auth/login");
    expect(screen.queryByRole("textbox", { name: "Work item" })).not.toBeInTheDocument();
  });

  it("restores workspace choice, lists its backlog, and refreshes after capture", async () => {
    const user = userEvent.setup();
    const existing = { id: "item-0", title: "Review outline" };
    const created = { id: "item-1", title: "Prepare release" };
    let finishCreate: (value: typeof created) => void = () => undefined;
    const pendingCreate = new Promise<typeof created>((resolve) => {
      finishCreate = resolve;
    });
    localStorage.setItem("schedule.hostedWorkspace", studio.id);
    apiMocks.session.mockResolvedValue({ authenticated: true });
    apiMocks.listWorkspaces.mockResolvedValue({ items: [personal, studio] });
    apiMocks.listWorkItems
      .mockResolvedValueOnce({ items: [existing], limit: 20, offset: 0 })
      .mockResolvedValueOnce({ items: [existing, created], limit: 20, offset: 0 });
    apiMocks.createWorkItem.mockReturnValue(pendingCreate);

    render(<HostedApp />);

    expect(await screen.findByRole("heading", { name: "What needs doing?" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Workspace" })).toHaveValue(studio.id);
    expect(await screen.findByText(existing.title)).toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "Work item" }), "Prepare release");
    await user.click(screen.getByRole("button", { name: "Add to backlog" }));

    expect(apiMocks.createWorkItem).toHaveBeenCalledWith(studio.id, "Prepare release");
    expect(screen.getByRole("combobox", { name: "Workspace" })).toBeDisabled();
    finishCreate(created);
    expect(await screen.findByText("Added “Prepare release” to Studio.")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Work item" })).toHaveValue("");
    expect(
      await screen.findByText(created.title, { selector: ".hosted-backlog-list li" }),
    ).toBeInTheDocument();
    expect(apiMocks.listWorkItems).toHaveBeenNthCalledWith(1, studio.id);
    expect(apiMocks.listWorkItems).toHaveBeenNthCalledWith(2, studio.id);
  });

  it("keeps capture usable while a failed backlog read is explicitly retried", async () => {
    const user = userEvent.setup();
    apiMocks.session.mockResolvedValue({ authenticated: true });
    apiMocks.listWorkspaces.mockResolvedValue({ items: [personal] });
    apiMocks.listWorkItems
      .mockRejectedValueOnce(new Error("private network detail"))
      .mockResolvedValueOnce({ items: [], limit: 20, offset: 0 });

    render(<HostedApp />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Schedule could not be reached.");
    expect(screen.getByRole("textbox", { name: "Work item" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Retry backlog" }));
    expect(await screen.findByText("No backlog items yet.")).toBeInTheDocument();
    expect(apiMocks.listWorkItems).toHaveBeenCalledTimes(2);
  });

  it("returns to sign-in when capture discovers an expired session", async () => {
    const user = userEvent.setup();
    apiMocks.session.mockResolvedValue({ authenticated: true });
    apiMocks.listWorkspaces.mockResolvedValue({ items: [personal] });
    apiMocks.createWorkItem.mockRejectedValue(
      new HostedApiError(401, "hosted.authentication_failed", "Authentication failed."),
    );

    render(<HostedApp />);
    await screen.findByRole("heading", { name: "What needs doing?" });
    await user.type(screen.getByRole("textbox", { name: "Work item" }), "Prepare release");
    await user.click(screen.getByRole("button", { name: "Add to backlog" }));

    expect(
      await screen.findByRole("heading", { name: "Capture work without losing your place." }),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Your session ended. Sign in again.");
  });

  it("keeps revoked users out of capture until an active workspace exists", async () => {
    apiMocks.session.mockResolvedValue({ authenticated: true });
    apiMocks.listWorkspaces.mockResolvedValue({ items: [] });

    render(<HostedApp />);

    expect(await screen.findByRole("heading", { name: "No active workspace" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Work item" })).not.toBeInTheDocument();
    await waitFor(() => expect(apiMocks.createWorkItem).not.toHaveBeenCalled());
    expect(apiMocks.listWorkItems).not.toHaveBeenCalled();
  });
});
