import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HostedApp } from "./HostedApp";
import { todayKey } from "./date";
import { HostedApiError } from "./hosted-api";

const apiMocks = vi.hoisted(() => ({
  session: vi.fn(),
  listWorkspaces: vi.fn(),
  createWorkspace: vi.fn(),
  listWorkItems: vi.fn(),
  getToday: vi.fn(),
  recordTodayActivity: vi.fn(),
  createWorkItem: vi.fn(),
  updateWorkItemStatus: vi.fn(),
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
  apiMocks.getToday.mockResolvedValue({
    date: todayKey(),
    planId: null,
    headVersion: null,
    items: [],
    totalMinutes: 0,
  });
  apiMocks.recordTodayActivity.mockResolvedValue(undefined);
  apiMocks.createWorkspace.mockResolvedValue(studio);
  apiMocks.updateWorkItemStatus.mockResolvedValue(undefined);
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
    const existing = {
      id: "item-0",
      title: "Review outline",
      version: 1,
      priority: "none" as const,
      dueOn: null,
      planningDurationMinutes: null,
    };
    const created = {
      id: "item-1",
      title: "Prepare release",
      version: 1,
      priority: "high" as const,
      dueOn: "2026-07-20",
      planningDurationMinutes: 75,
    };
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
    await user.click(screen.getByText("Scheduling details (optional)"));
    await user.selectOptions(screen.getByRole("combobox", { name: "Priority" }), "high");
    await user.type(screen.getByLabelText("Due date"), "2026-07-20");
    await user.type(screen.getByRole("spinbutton", { name: /^Planning time \(minutes\)/u }), "75");
    await user.click(screen.getByRole("button", { name: "Add to backlog" }));

    expect(apiMocks.createWorkItem).toHaveBeenCalledWith(studio.id, {
      title: "Prepare release",
      priority: "high",
      dueOn: "2026-07-20",
      planningDurationMinutes: 75,
    });
    expect(screen.getByRole("combobox", { name: "Workspace" })).toBeDisabled();
    finishCreate(created);
    expect(await screen.findByText("Added “Prepare release” to Studio.")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Work item" })).toHaveValue("");
    expect(screen.getByRole("textbox", { name: "Work item" })).toHaveFocus();
    expect(screen.getByRole("combobox", { name: "Priority" })).toHaveValue("none");
    expect(screen.getByLabelText("Due date")).toHaveValue("");
    expect(screen.getByRole("spinbutton", { name: /^Planning time \(minutes\)/u })).toHaveValue(
      null,
    );
    expect(
      await screen.findByText(created.title, { selector: ".hosted-backlog-title" }),
    ).toBeInTheDocument();
    expect(screen.getByText("High priority · Due 2026-07-20 · 1h 15m planned")).toBeInTheDocument();
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
        planId: "plan-1",
        headVersion: 4,
        items: [
          {
            id: "plan-item-1",
            title: "Focused review",
            scheduledMinutes: 45,
            activityState: "started",
          },
        ],
        totalMinutes: 45,
      })
      .mockResolvedValueOnce({
        date: todayKey(),
        planId: null,
        headVersion: null,
        items: [],
        totalMinutes: 0,
      });

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
        planId: "plan-1",
        headVersion: 2,
        items: [
          {
            id: "plan-item-1",
            title: "Recovered plan",
            scheduledMinutes: 30,
            activityState: "pending",
          },
        ],
        totalMinutes: 30,
      });

    render(<HostedApp />);

    expect(await screen.findByRole("button", { name: "Retry today" })).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Work item" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Retry today" }));
    expect(await screen.findByText("Recovered plan")).toBeInTheDocument();
    expect(apiMocks.getToday).toHaveBeenCalledTimes(2);
  });

  it("completes one Today item and refreshes Today plus its source backlog", async () => {
    const user = userEvent.setup();
    const item = {
      id: "plan-item-1",
      title: "Focused review",
      scheduledMinutes: 45,
      activityState: "pending" as const,
    };
    apiMocks.session.mockResolvedValue({ authenticated: true });
    apiMocks.listWorkspaces.mockResolvedValue({ items: [personal] });
    apiMocks.listWorkItems
      .mockResolvedValueOnce({
        items: [
          {
            id: "work-item-1",
            title: item.title,
            version: 1,
            priority: "none",
            dueOn: null,
            planningDurationMinutes: null,
          },
        ],
        limit: 20,
        offset: 0,
      })
      .mockResolvedValueOnce({ items: [], limit: 20, offset: 0 });
    apiMocks.getToday
      .mockResolvedValueOnce({
        date: todayKey(),
        planId: "plan-1",
        headVersion: 7,
        items: [item],
        totalMinutes: 45,
      })
      .mockResolvedValueOnce({
        date: todayKey(),
        planId: "plan-1",
        headVersion: 8,
        items: [{ ...item, activityState: "completed" }],
        totalMinutes: 45,
      });

    render(<HostedApp />);

    await user.click(
      await screen.findByRole("button", { name: `Complete ${item.title} in Today` }),
    );
    expect(apiMocks.recordTodayActivity).toHaveBeenCalledWith(
      personal.id,
      todayKey(),
      item.id,
      expect.objectContaining({
        expectedPlanId: "plan-1",
        expectedHeadVersion: 7,
        type: "completed",
        occurredAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u),
        idempotencyKey: expect.any(String),
      }),
    );
    expect(await screen.findByText(`Completed “${item.title}”.`)).toBeInTheDocument();
    expect(await screen.findByText("45m · Completed")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: `Complete ${item.title} in Today` }),
    ).not.toBeInTheDocument();
    expect(await screen.findByText("No backlog items yet.")).toBeInTheDocument();
  });

  it("retries an ambiguous Today action with the exact same intent", async () => {
    const user = userEvent.setup();
    const item = {
      id: "plan-item-1",
      title: "Focused review",
      scheduledMinutes: 45,
      activityState: "pending" as const,
    };
    apiMocks.session.mockResolvedValue({ authenticated: true });
    apiMocks.listWorkspaces.mockResolvedValue({ items: [personal] });
    apiMocks.getToday
      .mockResolvedValueOnce({
        date: todayKey(),
        planId: "plan-1",
        headVersion: 7,
        items: [item],
        totalMinutes: 45,
      })
      .mockResolvedValueOnce({
        date: todayKey(),
        planId: "plan-1",
        headVersion: 8,
        items: [{ ...item, activityState: "skipped" }],
        totalMinutes: 45,
      });
    apiMocks.recordTodayActivity
      .mockRejectedValueOnce(new HostedApiError(408, "request.timeout", "Timed out after commit."))
      .mockResolvedValueOnce(undefined);

    render(<HostedApp />);

    await user.click(await screen.findByRole("button", { name: `Skip ${item.title} in Today` }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Schedule could not be reached.");
    const firstCall = apiMocks.recordTodayActivity.mock.calls[0];
    await user.click(screen.getByRole("button", { name: "Retry action" }));
    expect(apiMocks.recordTodayActivity).toHaveBeenCalledTimes(2);
    expect(apiMocks.recordTodayActivity.mock.calls[1]).toEqual(firstCall);
    expect(await screen.findByText(`Skipped “${item.title}”.`)).toBeInTheDocument();
    expect(await screen.findByText("45m · Skipped")).toBeInTheDocument();
  });

  it("refreshes instead of replaying a stale Today action", async () => {
    const user = userEvent.setup();
    const item = {
      id: "plan-item-1",
      title: "Focused review",
      scheduledMinutes: 45,
      activityState: "pending" as const,
    };
    apiMocks.session.mockResolvedValue({ authenticated: true });
    apiMocks.listWorkspaces.mockResolvedValue({ items: [personal] });
    apiMocks.getToday
      .mockResolvedValueOnce({
        date: todayKey(),
        planId: "plan-1",
        headVersion: 7,
        items: [item],
        totalMinutes: 45,
      })
      .mockResolvedValueOnce({
        date: todayKey(),
        planId: "plan-2",
        headVersion: 1,
        items: [],
        totalMinutes: 0,
      });
    apiMocks.recordTodayActivity.mockRejectedValueOnce(
      new HostedApiError(409, "planning.head_conflict", "Changed elsewhere."),
    );

    render(<HostedApp />);

    await user.click(
      await screen.findByRole("button", { name: `Complete ${item.title} in Today` }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Today changed. Refresh it before trying again.",
    );
    await user.click(screen.getByRole("button", { name: "Retry today" }));
    expect(await screen.findByText("Nothing planned for today.")).toBeInTheDocument();
    expect(apiMocks.recordTodayActivity).toHaveBeenCalledOnce();
    expect(apiMocks.getToday).toHaveBeenCalledTimes(2);
  });

  it("starts one backlog item with its optimistic version and refreshes the snapshot", async () => {
    const user = userEvent.setup();
    const item = {
      id: "item-1",
      title: "Review outline",
      version: 3,
      priority: "none" as const,
      dueOn: null,
      planningDurationMinutes: null,
    };
    let finishUpdate: () => void = () => undefined;
    let finishRefresh: () => void = () => undefined;
    const pendingRefresh = new Promise<{ items: never[]; limit: number; offset: number }>(
      (resolve) => {
        finishRefresh = () => resolve({ items: [], limit: 20, offset: 0 });
      },
    );
    apiMocks.session.mockResolvedValue({ authenticated: true });
    apiMocks.listWorkspaces.mockResolvedValue({ items: [personal] });
    apiMocks.listWorkItems
      .mockResolvedValueOnce({ items: [item], limit: 20, offset: 0 })
      .mockReturnValueOnce(pendingRefresh);
    apiMocks.updateWorkItemStatus.mockReturnValue(
      new Promise<void>((resolve) => {
        finishUpdate = resolve;
      }),
    );

    render(<HostedApp />);

    await user.click(await screen.findByRole("button", { name: `Start ${item.title}` }));
    expect(apiMocks.updateWorkItemStatus).toHaveBeenCalledWith(personal.id, item, "in_progress");
    expect(screen.getByRole("textbox", { name: "Work item" })).toBeDisabled();
    finishUpdate();
    expect(await screen.findByText(`Started “${item.title}”.`)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: `Start ${item.title}` })).not.toBeInTheDocument();
    finishRefresh();
    expect(await screen.findByText("No backlog items yet.")).toBeInTheDocument();
  });

  it("keeps a stale status update explicit and retryable", async () => {
    const user = userEvent.setup();
    const item = {
      id: "item-1",
      title: "Review outline",
      version: 3,
      priority: "none" as const,
      dueOn: null,
      planningDurationMinutes: null,
    };
    apiMocks.session.mockResolvedValue({ authenticated: true });
    apiMocks.listWorkspaces.mockResolvedValue({ items: [personal] });
    apiMocks.listWorkItems.mockResolvedValue({ items: [item], limit: 20, offset: 0 });
    apiMocks.updateWorkItemStatus.mockRejectedValue(
      new HostedApiError(
        409,
        "work_item.version_conflict",
        "The work item changed before this update could be applied.",
      ),
    );

    render(<HostedApp />);

    await user.click(await screen.findByRole("button", { name: `Complete ${item.title}` }));
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This item changed. Refresh the backlog and try again.",
    );
    expect(screen.getByRole("button", { name: "Retry backlog" })).toBeEnabled();
    expect(apiMocks.listWorkItems).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Retry backlog" }));
    await waitFor(() => expect(apiMocks.listWorkItems).toHaveBeenCalledTimes(2));
  });

  it("refreshes Today after the browser crosses local midnight", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 16, 23, 59, 59, 500));
    apiMocks.session.mockResolvedValue({ authenticated: true });
    apiMocks.listWorkspaces.mockResolvedValue({ items: [personal] });
    apiMocks.getToday
      .mockResolvedValueOnce({
        date: "2026-07-16",
        planId: null,
        headVersion: null,
        items: [],
        totalMinutes: 0,
      })
      .mockResolvedValueOnce({
        date: "2026-07-17",
        planId: null,
        headVersion: null,
        items: [],
        totalMinutes: 0,
      });

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

  it("creates the first workspace before enabling capture", async () => {
    const user = userEvent.setup();
    let finishCreate: (workspace: typeof studio) => void = () => undefined;
    apiMocks.createWorkspace.mockReturnValue(
      new Promise((resolve) => {
        finishCreate = resolve;
      }),
    );
    apiMocks.session.mockResolvedValue({ authenticated: true });
    apiMocks.listWorkspaces.mockResolvedValue({ items: [] });

    render(<HostedApp />);

    expect(await screen.findByRole("heading", { name: "Create a workspace" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Work item" })).not.toBeInTheDocument();
    await user.type(screen.getByRole("textbox", { name: "Workspace name" }), "  Studio  ");
    await user.click(screen.getByRole("button", { name: "Create workspace" }));
    expect(apiMocks.createWorkspace).toHaveBeenCalledWith("Studio");
    expect(screen.getByRole("textbox", { name: "Workspace name" })).toBeDisabled();

    finishCreate(studio);
    expect(await screen.findByRole("textbox", { name: "Work item" })).toBeEnabled();
    expect(screen.getByText("Created workspace “Studio”.")).toBeInTheDocument();
    expect(localStorage.getItem("schedule.hostedWorkspace")).toBe(studio.id);
    await waitFor(() => expect(apiMocks.listWorkItems).toHaveBeenCalledWith(studio.id));
    await waitFor(() => expect(apiMocks.getToday).toHaveBeenCalledWith(studio.id, todayKey()));
  });

  it("creates and selects another workspace without exposing broader administration", async () => {
    const user = userEvent.setup();
    apiMocks.session.mockResolvedValue({ authenticated: true });
    apiMocks.listWorkspaces.mockResolvedValue({ items: [personal] });

    render(<HostedApp />);

    await user.click(await screen.findByText("Create another workspace"));
    await user.type(screen.getByRole("textbox", { name: "Workspace name" }), "Studio");
    await user.click(screen.getByRole("button", { name: "Create workspace" }));

    expect(apiMocks.createWorkspace).toHaveBeenCalledWith("Studio");
    expect(await screen.findByRole("combobox", { name: "Workspace" })).toHaveValue(studio.id);
    expect(screen.getByRole("combobox", { name: "Workspace" })).toHaveTextContent("My Schedule");
    expect(screen.getByRole("combobox", { name: "Workspace" })).toHaveTextContent("Studio");
  });
});
