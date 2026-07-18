import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HostedApp } from "./HostedApp";
import { todayKey } from "./date";
import { HostedApiError } from "./hosted-api";

const apiMocks = vi.hoisted(() => ({
  session: vi.fn(),
  listWorkspaces: vi.fn(),
  listWorkItems: vi.fn(),
  getToday: vi.fn(),
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
  localStorage.clear();
  apiMocks.listWorkItems.mockResolvedValue({ items: [], limit: 20, offset: 0 });
  apiMocks.getToday.mockResolvedValue({ date: todayKey(), items: [], totalMinutes: 0 });
});

afterEach(() => {
  vi.useRealTimers();
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

  it("shows the current local day and refreshes it when the workspace changes", async () => {
    const user = userEvent.setup();
    apiMocks.session.mockResolvedValue({ authenticated: true });
    apiMocks.listWorkspaces.mockResolvedValue({ items: [personal, studio] });
    apiMocks.getToday
      .mockResolvedValueOnce({
        date: todayKey(),
        items: [{ title: "Focused review", scheduledMinutes: 45, activityState: "started" }],
        totalMinutes: 45,
      })
      .mockResolvedValueOnce({ date: todayKey(), items: [], totalMinutes: 0 });

    render(<HostedApp />);

    expect(await screen.findByText("Focused review")).toBeInTheDocument();
    expect(screen.getByText("45m · Started")).toBeInTheDocument();
    expect(apiMocks.getToday).toHaveBeenNthCalledWith(1, personal.id, todayKey());
    await user.selectOptions(screen.getByRole("combobox", { name: "Workspace" }), studio.id);
    expect(await screen.findByText("Nothing planned for today.")).toBeInTheDocument();
    expect(apiMocks.getToday).toHaveBeenNthCalledWith(2, studio.id, todayKey());
    expect(screen.queryByText("Focused review")).not.toBeInTheDocument();
  });

  it("keeps capture usable while a failed Today read is explicitly retried", async () => {
    const user = userEvent.setup();
    apiMocks.session.mockResolvedValue({ authenticated: true });
    apiMocks.listWorkspaces.mockResolvedValue({ items: [personal] });
    apiMocks.getToday
      .mockRejectedValueOnce(new Error("private network detail"))
      .mockResolvedValueOnce({
        date: todayKey(),
        items: [{ title: "Recovered plan", scheduledMinutes: 30, activityState: "pending" }],
        totalMinutes: 30,
      });

    render(<HostedApp />);

    expect(await screen.findByRole("button", { name: "Retry today" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Work item" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Retry today" }));
    expect(await screen.findByText("Recovered plan")).toBeInTheDocument();
    expect(apiMocks.getToday).toHaveBeenCalledTimes(2);
  });

  it("refreshes Today after the browser crosses local midnight", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 16, 23, 59, 59, 500));
    apiMocks.session.mockResolvedValue({ authenticated: true });
    apiMocks.listWorkspaces.mockResolvedValue({ items: [personal] });
    apiMocks.getToday
      .mockResolvedValueOnce({ date: "2026-07-16", items: [], totalMinutes: 0 })
      .mockResolvedValueOnce({ date: "2026-07-17", items: [], totalMinutes: 0 });

    render(<HostedApp />);
    await act(async () => Promise.resolve());
    expect(apiMocks.getToday).toHaveBeenNthCalledWith(1, personal.id, "2026-07-16");

    await act(async () => vi.advanceTimersByTimeAsync(1_500));
    expect(apiMocks.getToday).toHaveBeenNthCalledWith(2, personal.id, "2026-07-17");
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
