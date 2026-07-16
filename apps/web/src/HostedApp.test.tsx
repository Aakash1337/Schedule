import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HostedApp } from "./HostedApp";
import { HostedApiError } from "./hosted-api";

const apiMocks = vi.hoisted(() => ({
  session: vi.fn(),
  listWorkspaces: vi.fn(),
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

  it("restores workspace choice and captures one title", async () => {
    const user = userEvent.setup();
    localStorage.setItem("schedule.hostedWorkspace", studio.id);
    apiMocks.session.mockResolvedValue({ authenticated: true });
    apiMocks.listWorkspaces.mockResolvedValue({ items: [personal, studio] });
    apiMocks.createWorkItem.mockResolvedValue({ id: "item-1", title: "Prepare release" });

    render(<HostedApp />);

    expect(await screen.findByRole("heading", { name: "What needs doing?" })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Workspace" })).toHaveValue(studio.id);
    await user.type(screen.getByRole("textbox", { name: "Work item" }), "Prepare release");
    await user.click(screen.getByRole("button", { name: "Add to backlog" }));

    expect(apiMocks.createWorkItem).toHaveBeenCalledWith(studio.id, "Prepare release");
    expect(await screen.findByRole("status")).toHaveTextContent(
      "Added “Prepare release” to Studio.",
    );
    expect(screen.getByRole("textbox", { name: "Work item" })).toHaveValue("");
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
  });
});
