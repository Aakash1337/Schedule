import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HostedApp } from "./HostedApp";
import { browserTimeZone, localDateTimeToIso, todayKey } from "./date";
import {
  HostedApiError,
  type HostedDailyPlanFitEffectiveness,
  type HostedWorkItemSnapshot,
  type HostedWorkItemSyncChange,
} from "./hosted-api";

const apiMocks = vi.hoisted(() => ({
  session: vi.fn(),
  startSignIn: vi.fn(),
  listWorkspaces: vi.fn(),
  createWorkspace: vi.fn(),
  bootstrapWorkItemSync: vi.fn(),
  listWorkItemSyncChanges: vi.fn(),
  getToday: vi.fn(),
  getDailyPlanFitInsight: vi.fn(),
  getDailyPlanFitEffectiveness: vi.fn(),
  dismissDailyPlanFitInsight: vi.fn(),
  resetDailyPlanFitInsightDismissal: vi.fn(),
  generateToday: vi.fn(),
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
function snapshotItem(
  item: Pick<HostedWorkItemSnapshot, "id" | "title"> & Partial<HostedWorkItemSnapshot>,
): HostedWorkItemSnapshot {
  return {
    parentWorkItemId: null,
    description: null,
    status: "backlog",
    version: 1,
    priority: "none",
    dueOn: null,
    planningDurationMinutes: null,
    createdAt: "2026-07-16T12:00:00.000Z",
    updatedAt: "2026-07-16T12:00:00.000Z",
    ...item,
  };
}

function bootstrapPage(
  items: readonly HostedWorkItemSnapshot[],
  checkpoint = "checkpoint-1",
  nextCursor: string | null = null,
) {
  return { protocolVersion: 1 as const, items, checkpoint, nextCursor };
}

function deltaPage(
  changes: readonly HostedWorkItemSyncChange[],
  checkpoint = "checkpoint-2",
  nextCursor: string | null = null,
) {
  return { protocolVersion: 1 as const, changes, checkpoint, nextCursor };
}

function titleCaseForTest(value: string): string {
  const label = value.replaceAll("_", " ");
  return `${label.charAt(0).toUpperCase()}${label.slice(1)}`;
}

const emptyPlanFitEffectiveness: HostedDailyPlanFitEffectiveness = {
  usesConsidered: 0,
  eligibleResolvedUseCount: 0,
  minimumComparableUses: 3,
  pendingUseCount: 0,
  revisedUseCount: 0,
  notEvaluableUseCount: 0,
  exactSuggestionUseCount: 0,
  editedSuggestionUseCount: 0,
  scheduledMinutesRateBasisPoints: null,
  scheduledTasksRateBasisPoints: null,
  completionMinutesRateBasisPoints: null,
  completionTasksRateBasisPoints: null,
};

beforeEach(() => {
  vi.resetAllMocks();
  localStorage.clear();
  apiMocks.bootstrapWorkItemSync.mockResolvedValue(bootstrapPage([]));
  apiMocks.listWorkItemSyncChanges.mockImplementation((_workspaceId: string, cursor: string) =>
    Promise.resolve(deltaPage([], cursor)),
  );
  apiMocks.getToday.mockResolvedValue({
    date: todayKey(),
    planId: null,
    headVersion: null,
    items: [],
    totalMinutes: 0,
  });
  apiMocks.getDailyPlanFitInsight.mockResolvedValue({
    forDate: todayKey(),
    status: "insufficient_history",
    disposition: "available",
    sampleCount: 0,
    minimumSamples: 3,
    suggestedTargetMinutes: null,
    suggestedTargetTaskCount: null,
    insightKey: null,
  });
  apiMocks.getDailyPlanFitEffectiveness.mockResolvedValue(emptyPlanFitEffectiveness);
  apiMocks.recordTodayActivity.mockResolvedValue(undefined);
  apiMocks.dismissDailyPlanFitInsight.mockResolvedValue(undefined);
  apiMocks.resetDailyPlanFitInsightDismissal.mockResolvedValue(undefined);
  apiMocks.generateToday.mockResolvedValue(undefined);
  apiMocks.createWorkspace.mockResolvedValue(studio);
  apiMocks.updateWorkItemStatus.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe("hosted capture shell", () => {
  it("offers provider sign-in without exposing product controls", async () => {
    const user = userEvent.setup();
    apiMocks.session.mockResolvedValue({ authenticated: false });
    apiMocks.startSignIn.mockReturnValue(new Promise(() => undefined));

    render(<HostedApp />);

    expect(
      await screen.findByRole("heading", { name: "Capture work without losing your place." }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(apiMocks.startSignIn).toHaveBeenCalledOnce();
    expect(screen.queryByRole("textbox", { name: "Work item" })).not.toBeInTheDocument();
  });

  it("restores workspace choice, lists its work items, and refreshes after capture", async () => {
    const user = userEvent.setup();
    const existing = snapshotItem({
      id: "item-0",
      title: "Review outline",
    });
    const created = {
      id: "item-1",
      title: "Prepare release",
      version: 1,
      priority: "high" as const,
      dueOn: "2026-07-20",
      planningDurationMinutes: 75,
    };
    const createdSnapshot = snapshotItem(created);
    let finishCreate: (value: typeof created) => void = () => undefined;
    const pendingCreate = new Promise<typeof created>((resolve) => {
      finishCreate = resolve;
    });
    localStorage.setItem("schedule.hostedWorkspace", studio.id);
    apiMocks.session.mockResolvedValue({ authenticated: true });
    apiMocks.listWorkspaces.mockResolvedValue({ items: [personal, studio] });
    apiMocks.bootstrapWorkItemSync.mockResolvedValueOnce(bootstrapPage([existing], "checkpoint-1"));
    apiMocks.listWorkItemSyncChanges
      .mockResolvedValueOnce(deltaPage([], "checkpoint-1"))
      .mockResolvedValueOnce(
        deltaPage([{ type: "upsert", item: createdSnapshot }], "checkpoint-2"),
      );
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
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Work item" })).toHaveFocus());
    expect(screen.getByRole("combobox", { name: "Priority" })).toHaveValue("none");
    expect(screen.getByLabelText("Due date")).toHaveValue("");
    expect(screen.getByRole("spinbutton", { name: /^Planning time \(minutes\)/u })).toHaveValue(
      null,
    );
    expect(
      await screen.findByText(created.title, { selector: ".hosted-backlog-title" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Backlog · High priority · Due 2026-07-20 · 1h 15m planned"),
    ).toBeInTheDocument();
    expect(apiMocks.bootstrapWorkItemSync).toHaveBeenCalledWith(studio.id, undefined);
    expect(apiMocks.listWorkItemSyncChanges.mock.calls).toEqual([
      [studio.id, "checkpoint-1"],
      [studio.id, "checkpoint-1"],
    ]);
  });

  it("keeps capture usable while a failed work-item read is explicitly retried", async () => {
    const user = userEvent.setup();
    apiMocks.session.mockResolvedValue({ authenticated: true });
    apiMocks.listWorkspaces.mockResolvedValue({ items: [personal] });
    apiMocks.bootstrapWorkItemSync
      .mockRejectedValueOnce(new Error("private network detail"))
      .mockResolvedValueOnce(bootstrapPage([]));

    render(<HostedApp />);

    expect(await screen.findByRole("alert")).toHaveTextContent("Schedule could not be reached.");
    expect(screen.getByRole("textbox", { name: "Work item" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Retry work items" }));
    expect(await screen.findByText("No work items yet.")).toBeInTheDocument();
    expect(apiMocks.bootstrapWorkItemSync).toHaveBeenCalledTimes(2);
  });

  it("returns to sign-in when the work-item read discovers an expired session", async () => {
    apiMocks.session.mockResolvedValue({ authenticated: true });
    apiMocks.listWorkspaces.mockResolvedValue({ items: [personal] });
    apiMocks.bootstrapWorkItemSync.mockRejectedValue(
      new HostedApiError(401, "hosted.authentication_failed", "Authentication failed."),
    );

    render(<HostedApp />);

    expect(
      await screen.findByRole("heading", { name: "Capture work without losing your place." }),
    ).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("Your session ended. Sign in again.");
  });

  it("pages through all work-item statuses with backlog-only actions", async () => {
    const user = userEvent.setup();
    const statusItems = (
      ["backlog", "planned", "in_progress", "blocked", "done", "cancelled"] as const
    ).map((status, index) =>
      snapshotItem({
        id: `item-${String(index)}`,
        title: `${titleCaseForTest(status)} item`,
        description: status === "planned" ? "Visible context for the planned item." : null,
        status,
        createdAt: `2026-07-16T12:00:${String(index).padStart(2, "0")}.000Z`,
      }),
    );
    const firstPage = [
      ...statusItems,
      ...Array.from({ length: 15 }, (_, index) =>
        snapshotItem({
          id: `done-${String(index)}`,
          title: `Completed item ${String(index + 1)}`,
          status: "done",
          createdAt: `2026-07-16T12:00:${String(index + 6).padStart(2, "0")}.000Z`,
        }),
      ),
    ];
    const pageTwoItem = snapshotItem({
      id: "item-page-two",
      title: "Later completed item",
      status: "done",
      createdAt: "2026-07-16T12:00:21.000Z",
    });
    apiMocks.session.mockResolvedValue({ authenticated: true });
    apiMocks.listWorkspaces.mockResolvedValue({ items: [personal] });
    apiMocks.bootstrapWorkItemSync.mockResolvedValue(bootstrapPage([...firstPage, pageTwoItem]));

    render(<HostedApp />);

    expect(await screen.findByText("Planned item")).toBeInTheDocument();
    expect(screen.getByText("Visible context for the planned item.")).toBeInTheDocument();
    expect(
      screen.getByText("In progress", { selector: ".hosted-backlog-meta" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start Backlog item" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Complete Backlog item" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Start Planned item" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Complete Done item" })).not.toBeInTheDocument();
    expect(screen.queryByText("Completed item 15")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByText(pageTwoItem.title)).toBeInTheDocument();
    expect(apiMocks.bootstrapWorkItemSync).toHaveBeenCalledOnce();
    expect(apiMocks.listWorkItemSyncChanges).toHaveBeenCalledWith(personal.id, "checkpoint-1");
    expect(screen.getByRole("button", { name: "Previous" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Next" })).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: `Complete ${pageTwoItem.title}` }),
    ).not.toBeInTheDocument();
  });

  it("resets in-memory work-item paging when the workspace changes", async () => {
    const user = userEvent.setup();
    const firstPage = Array.from({ length: 21 }, (_, index) =>
      snapshotItem({
        id: `personal-${String(index)}`,
        title: `Personal ${String(index + 1)}`,
        createdAt: `2026-07-16T12:00:${String(index).padStart(2, "0")}.000Z`,
      }),
    );
    apiMocks.session.mockResolvedValue({ authenticated: true });
    apiMocks.listWorkspaces.mockResolvedValue({ items: [personal, studio] });
    apiMocks.bootstrapWorkItemSync.mockImplementation((workspaceId: string) =>
      Promise.resolve(
        workspaceId === personal.id
          ? bootstrapPage(firstPage, "personal-checkpoint")
          : bootstrapPage(
              [snapshotItem({ id: "studio-1", title: "Studio item", status: "planned" })],
              "studio-checkpoint",
            ),
      ),
    );

    render(<HostedApp />);

    await user.click(await screen.findByRole("button", { name: "Next" }));
    expect(await screen.findByText("Personal 21")).toBeInTheDocument();
    await user.selectOptions(screen.getByRole("combobox", { name: "Workspace" }), studio.id);
    expect(await screen.findByText("Studio item")).toBeInTheDocument();
    expect(apiMocks.bootstrapWorkItemSync).toHaveBeenCalledWith(studio.id, undefined);
    expect(screen.getAllByText("Page 1").length).toBeGreaterThan(0);
  });

  it("commits a bootstrap atomically and ignores a late prior workspace", async () => {
    const user = userEvent.setup();
    let finishPersonal: () => void = () => undefined;
    const pendingPersonal = new Promise<ReturnType<typeof bootstrapPage>>((resolve) => {
      finishPersonal = () =>
        resolve(
          bootstrapPage(
            [snapshotItem({ id: "personal-late", title: "Late personal item" })],
            "personal-checkpoint",
          ),
        );
    });
    apiMocks.session.mockResolvedValue({ authenticated: true });
    apiMocks.listWorkspaces.mockResolvedValue({ items: [personal, studio] });
    apiMocks.bootstrapWorkItemSync.mockImplementation((workspaceId: string, cursor?: string) => {
      if (workspaceId === studio.id) {
        return Promise.resolve(
          bootstrapPage([snapshotItem({ id: "studio-1", title: "Studio item" })]),
        );
      }
      return cursor === undefined
        ? Promise.resolve(
            bootstrapPage(
              [snapshotItem({ id: "personal-partial", title: "Partial personal item" })],
              "personal-checkpoint",
              "personal-next",
            ),
          )
        : pendingPersonal;
    });

    render(<HostedApp />);

    await waitFor(() =>
      expect(apiMocks.bootstrapWorkItemSync).toHaveBeenCalledWith(personal.id, "personal-next"),
    );
    expect(screen.queryByText("Partial personal item")).not.toBeInTheDocument();
    await user.selectOptions(screen.getByRole("combobox", { name: "Workspace" }), studio.id);
    expect(await screen.findByText("Studio item")).toBeInTheDocument();
    finishPersonal();
    await act(async () => Promise.resolve());
    expect(screen.queryByText("Partial personal item")).not.toBeInTheDocument();
    expect(screen.queryByText("Late personal item")).not.toBeInTheDocument();
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
    expect(await screen.findByRole("heading", { name: "Build today’s plan" })).toBeInTheDocument();
    expect(apiMocks.getToday).toHaveBeenNthCalledWith(2, studio.id, todayKey());
    expect(screen.queryByText("Focused review")).not.toBeInTheDocument();
  });

  it("builds the first Today plan from one window plus time and task limits", async () => {
    const user = userEvent.setup();
    const date = todayKey();
    apiMocks.session.mockResolvedValue({ authenticated: true });
    apiMocks.listWorkspaces.mockResolvedValue({ items: [personal] });
    apiMocks.getToday
      .mockResolvedValueOnce({
        date,
        planId: null,
        headVersion: null,
        items: [],
        totalMinutes: 0,
      })
      .mockResolvedValueOnce({
        date,
        planId: "plan-1",
        headVersion: 1,
        items: [
          {
            id: "plan-item-1",
            title: "Prepare release",
            scheduledMinutes: 75,
            activityState: "pending",
          },
        ],
        totalMinutes: 75,
      });

    render(<HostedApp />);

    expect(await screen.findByRole("heading", { name: "Build today’s plan" })).toBeInTheDocument();
    expect(screen.getByText(browserTimeZone())).toBeInTheDocument();
    expect(
      await screen.findByText("Plan Fit needs 3 resolved plans; 0 available.", {
        selector: ".hosted-plan-fit-state",
      }),
    ).toBeInTheDocument();
    await user.clear(screen.getByLabelText("Work window starts"));
    await user.type(screen.getByLabelText("Work window starts"), "10:00");
    await user.clear(screen.getByLabelText("Work window ends"));
    await user.type(screen.getByLabelText("Work window ends"), "16:30");
    await user.clear(screen.getByRole("spinbutton", { name: "Time budget (minutes)" }));
    await user.type(screen.getByRole("spinbutton", { name: "Time budget (minutes)" }), "240");
    await user.clear(screen.getByRole("spinbutton", { name: "Task limit" }));
    await user.type(screen.getByRole("spinbutton", { name: "Task limit" }), "5");
    await user.click(screen.getByRole("button", { name: "Build plan" }));

    expect(apiMocks.generateToday).toHaveBeenCalledWith(personal.id, date, {
      timeZone: browserTimeZone(),
      window: {
        startsAt: localDateTimeToIso(date, "10:00"),
        endsAt: localDateTimeToIso(date, "16:30"),
      },
      targetMinutes: 240,
      targetTaskCount: 5,
      planFitInsightKey: null,
      idempotencyKey: expect.any(String),
    });
    expect(await screen.findByText("Built today’s plan.")).toBeInTheDocument();
    expect(await screen.findByText("Prepare release")).toBeInTheDocument();
    expect(screen.getByText("1h 15m · Pending")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Today" })).toHaveFocus();
    expect(screen.queryByRole("heading", { name: "Build today’s plan" })).not.toBeInTheDocument();
  });

  it("prefills hosted Plan Fit targets only after explicit use and preserves its exact key", async () => {
    const user = userEvent.setup();
    const date = todayKey();
    const insightKey = "a".repeat(64);
    apiMocks.session.mockResolvedValue({ authenticated: true });
    apiMocks.listWorkspaces.mockResolvedValue({ items: [personal] });
    apiMocks.getDailyPlanFitInsight.mockResolvedValue({
      forDate: date,
      status: "suggested",
      disposition: "available",
      sampleCount: 3,
      minimumSamples: 3,
      suggestedTargetMinutes: 90,
      suggestedTargetTaskCount: 2,
      insightKey,
    });

    render(<HostedApp />);

    const useSuggestion = await screen.findByRole("button", { name: "Use 1h 30m and 2 tasks" });
    expect(screen.getByRole("spinbutton", { name: "Time budget (minutes)" })).toHaveValue(180);
    expect(screen.getByRole("spinbutton", { name: "Task limit" })).toHaveValue(4);
    expect(apiMocks.generateToday).not.toHaveBeenCalled();

    await user.click(useSuggestion);
    expect(screen.getByRole("spinbutton", { name: "Time budget (minutes)" })).toHaveValue(90);
    expect(screen.getByRole("spinbutton", { name: "Task limit" })).toHaveValue(2);
    expect(screen.getByRole("spinbutton", { name: "Time budget (minutes)" })).toHaveFocus();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Using 1h 30m and 2 tasks. You can still edit both limits.",
    );
    expect(screen.getByRole("button", { name: "Suggestion applied" })).toBeDisabled();
    expect(apiMocks.generateToday).not.toHaveBeenCalled();

    await user.clear(screen.getByRole("spinbutton", { name: "Time budget (minutes)" }));
    await user.type(screen.getByRole("spinbutton", { name: "Time budget (minutes)" }), "105");
    expect(screen.getByRole("button", { name: "Use 1h 30m and 2 tasks" })).toBeEnabled();
    expect(screen.getByRole("status")).toHaveTextContent("Plan Fit suggests 1h 30m and 2 tasks.");
    await user.click(screen.getByRole("button", { name: "Use 1h 30m and 2 tasks" }));
    expect(screen.getByRole("spinbutton", { name: "Time budget (minutes)" })).toHaveValue(90);
    expect(screen.getByRole("button", { name: "Suggestion applied" })).toBeDisabled();
    await user.clear(screen.getByRole("spinbutton", { name: "Time budget (minutes)" }));
    await user.type(screen.getByRole("spinbutton", { name: "Time budget (minutes)" }), "105");
    await user.click(screen.getByRole("button", { name: "Build plan" }));
    expect(apiMocks.generateToday).toHaveBeenCalledWith(
      personal.id,
      date,
      expect.objectContaining({
        targetMinutes: 105,
        targetTaskCount: 2,
        planFitInsightKey: insightKey,
      }),
    );
  });

  it("keeps manual planning usable while failed Plan Fit guidance is explicitly retried", async () => {
    const user = userEvent.setup();
    apiMocks.session.mockResolvedValue({ authenticated: true });
    apiMocks.listWorkspaces.mockResolvedValue({ items: [personal] });
    apiMocks.getDailyPlanFitInsight
      .mockRejectedValueOnce(new Error("private network detail"))
      .mockResolvedValueOnce({
        forDate: todayKey(),
        status: "suggested",
        disposition: "available",
        sampleCount: 3,
        minimumSamples: 3,
        suggestedTargetMinutes: 75,
        suggestedTargetTaskCount: 2,
        insightKey: "b".repeat(64),
      });

    render(<HostedApp />);

    expect(
      await screen.findByText("Plan Fit guidance is unavailable.", {
        selector: ".hosted-plan-fit-state > span",
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Plan Fit guidance is unavailable.");
    expect(screen.getByRole("button", { name: "Build plan" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Retry guidance" }));
    expect(await screen.findByRole("button", { name: "Use 1h 15m and 2 tasks" })).toBeEnabled();
    expect(apiMocks.generateToday).not.toHaveBeenCalled();
  });

  it("keeps the form visible and reloads guidance after a stale Plan Fit selection", async () => {
    const user = userEvent.setup();
    const date = todayKey();
    const firstKey = "c".repeat(64);
    apiMocks.session.mockResolvedValue({ authenticated: true });
    apiMocks.listWorkspaces.mockResolvedValue({ items: [personal] });
    apiMocks.getDailyPlanFitInsight
      .mockResolvedValueOnce({
        forDate: date,
        status: "suggested",
        disposition: "available",
        sampleCount: 3,
        minimumSamples: 3,
        suggestedTargetMinutes: 90,
        suggestedTargetTaskCount: 2,
        insightKey: firstKey,
      })
      .mockResolvedValue({
        forDate: date,
        status: "suggested",
        disposition: "available",
        sampleCount: 4,
        minimumSamples: 3,
        suggestedTargetMinutes: 105,
        suggestedTargetTaskCount: 3,
        insightKey: "d".repeat(64),
      });
    apiMocks.generateToday.mockRejectedValueOnce(
      new HostedApiError(
        409,
        "daily_plan_fit_insight.evidence_conflict",
        "private evidence detail",
      ),
    );

    render(<HostedApp />);

    await user.click(await screen.findByRole("button", { name: "Use 1h 30m and 2 tasks" }));
    await user.click(screen.getByRole("button", { name: "Build plan" }));
    expect(
      await screen.findByText(
        "Recent plan history changed. Review the refreshed Plan Fit guidance.",
        { selector: ".hosted-plan-fit-state" },
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Recent plan history changed. Review the refreshed Plan Fit guidance.",
    );
    expect(screen.getByRole("heading", { name: "Build today’s plan" })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Use 1h 45m and 3 tasks" })).toBeEnabled();
    expect(apiMocks.generateToday).toHaveBeenCalledWith(
      personal.id,
      date,
      expect.objectContaining({ planFitInsightKey: firstKey }),
    );
    expect(apiMocks.getDailyPlanFitInsight).toHaveBeenCalledTimes(2);
  });

  it("explains a non-actionable aligned hosted Plan Fit state", async () => {
    const message = "Recent completed plans are aligned; no lower targets are suggested.";
    apiMocks.session.mockResolvedValue({ authenticated: true });
    apiMocks.listWorkspaces.mockResolvedValue({ items: [personal] });
    apiMocks.getDailyPlanFitInsight.mockResolvedValue({
      forDate: todayKey(),
      sampleCount: 3,
      minimumSamples: 3,
      status: "aligned",
      disposition: "available",
      suggestedTargetMinutes: null,
      suggestedTargetTaskCount: null,
      insightKey: null,
    });

    render(<HostedApp />);

    expect(
      await screen.findByText(message, { selector: ".hosted-plan-fit-state" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(message);
    expect(apiMocks.generateToday).not.toHaveBeenCalled();
  });

  it("shows only bounded descriptive hosted Plan Fit outcome rates", async () => {
    apiMocks.session.mockResolvedValue({ authenticated: true });
    apiMocks.listWorkspaces.mockResolvedValue({ items: [personal] });
    apiMocks.getDailyPlanFitEffectiveness.mockResolvedValue({
      ...emptyPlanFitEffectiveness,
      usesConsidered: 4,
      eligibleResolvedUseCount: 3,
      pendingUseCount: 1,
      exactSuggestionUseCount: 2,
      editedSuggestionUseCount: 2,
      scheduledMinutesRateBasisPoints: 8_000,
      scheduledTasksRateBasisPoints: 7_500,
      completionMinutesRateBasisPoints: 7_500,
      completionTasksRateBasisPoints: 8_000,
    });

    render(<HostedApp />);

    const summary = (await screen.findByRole("heading", { name: "Plan Fit outcomes" }))
      .parentElement;
    expect(summary).toHaveTextContent(
      "Based on 3 comparable uses: target scheduled 80% time and 75% tasks; plan completed 75% time and 80% tasks. Exact suggestion 2; edited 2.",
    );
    expect(summary).toHaveTextContent("Descriptive only; this never changes planning.");
    expect(apiMocks.getDailyPlanFitEffectiveness).toHaveBeenCalledWith(personal.id);
  });

  it("withholds hosted Plan Fit outcome rates until three comparable uses settle", async () => {
    apiMocks.session.mockResolvedValue({ authenticated: true });
    apiMocks.listWorkspaces.mockResolvedValue({ items: [personal] });
    apiMocks.getDailyPlanFitEffectiveness.mockResolvedValue({
      ...emptyPlanFitEffectiveness,
      usesConsidered: 2,
      eligibleResolvedUseCount: 2,
      scheduledMinutesRateBasisPoints: null,
      scheduledTasksRateBasisPoints: null,
      completionMinutesRateBasisPoints: null,
      completionTasksRateBasisPoints: null,
    });

    render(<HostedApp />);

    expect(
      await screen.findByText(
        "2 of 3 settled, unrevised uses are available. Rates appear after 1 more comparable use.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/target scheduled/iu)).not.toBeInTheDocument();
  });

  it("keeps hosted planning usable while the outcome summary is retried", async () => {
    const user = userEvent.setup();
    apiMocks.session.mockResolvedValue({ authenticated: true });
    apiMocks.listWorkspaces.mockResolvedValue({ items: [personal] });
    apiMocks.getDailyPlanFitEffectiveness
      .mockRejectedValueOnce(new Error("private network detail"))
      .mockResolvedValueOnce(emptyPlanFitEffectiveness);

    render(<HostedApp />);

    expect(await screen.findByText("Plan Fit outcome summary is unavailable.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Build plan" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Retry summary" }));
    expect(
      await screen.findByText("No explicit Plan Fit use is available to summarize yet."),
    ).toBeInTheDocument();
    expect(apiMocks.getDailyPlanFitEffectiveness).toHaveBeenCalledTimes(2);
  });

  it("ignores a late Plan Fit outcome summary from the previous workspace", async () => {
    const user = userEvent.setup();
    let resolvePersonal: (value: HostedDailyPlanFitEffectiveness) => void = () => undefined;
    const pendingPersonal = new Promise<HostedDailyPlanFitEffectiveness>((resolve) => {
      resolvePersonal = resolve;
    });
    apiMocks.session.mockResolvedValue({ authenticated: true });
    apiMocks.listWorkspaces.mockResolvedValue({ items: [personal, studio] });
    apiMocks.getDailyPlanFitEffectiveness
      .mockReturnValueOnce(pendingPersonal)
      .mockResolvedValueOnce(emptyPlanFitEffectiveness);

    render(<HostedApp />);

    await waitFor(() =>
      expect(apiMocks.getDailyPlanFitEffectiveness).toHaveBeenCalledWith(personal.id),
    );
    await user.selectOptions(screen.getByRole("combobox", { name: "Workspace" }), studio.id);
    expect(
      await screen.findByText("No explicit Plan Fit use is available to summarize yet."),
    ).toBeInTheDocument();
    await act(async () => {
      resolvePersonal({
        ...emptyPlanFitEffectiveness,
        usesConsidered: 3,
        eligibleResolvedUseCount: 3,
        exactSuggestionUseCount: 3,
        scheduledMinutesRateBasisPoints: 9_900,
        scheduledTasksRateBasisPoints: 9_900,
        completionMinutesRateBasisPoints: 9_900,
        completionTasksRateBasisPoints: 9_900,
      });
      await pendingPersonal;
    });
    expect(screen.queryByText(/99%/u)).not.toBeInTheDocument();
    expect(apiMocks.getDailyPlanFitEffectiveness).toHaveBeenLastCalledWith(studio.id);
  });

  it("dismisses and restores an exact hosted Plan Fit suggestion without changing manual limits", async () => {
    const user = userEvent.setup();
    const date = todayKey();
    const insightKey = "e".repeat(64);
    const insight = {
      forDate: date,
      status: "suggested" as const,
      sampleCount: 3,
      minimumSamples: 3,
      suggestedTargetMinutes: 90,
      suggestedTargetTaskCount: 2,
      insightKey,
    };
    apiMocks.session.mockResolvedValue({ authenticated: true });
    apiMocks.listWorkspaces.mockResolvedValue({ items: [personal] });
    apiMocks.getDailyPlanFitInsight
      .mockResolvedValueOnce({ ...insight, disposition: "available" })
      .mockResolvedValueOnce({ ...insight, disposition: "dismissed" })
      .mockResolvedValueOnce({ ...insight, disposition: "available" });

    render(<HostedApp />);

    await screen.findByRole("button", { name: "Not now" });
    await user.clear(screen.getByRole("spinbutton", { name: "Time budget (minutes)" }));
    await user.type(screen.getByRole("spinbutton", { name: "Time budget (minutes)" }), "205");
    await user.click(screen.getByRole("button", { name: "Not now" }));
    expect(await screen.findByRole("button", { name: "Show again" })).toBeEnabled();
    expect(apiMocks.dismissDailyPlanFitInsight).toHaveBeenCalledWith(personal.id, {
      forDate: date,
      insightKey,
      idempotencyKey: expect.any(String),
    });
    expect(screen.getByRole("spinbutton", { name: "Time budget (minutes)" })).toHaveValue(205);
    expect(screen.getByRole("button", { name: "Build plan" })).toBeEnabled();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Suggestion hidden. New evidence may show a new suggestion.",
    );
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Recent Plan Fit" })).toHaveFocus(),
    );

    await user.click(screen.getByRole("button", { name: "Show again" }));
    expect(await screen.findByRole("button", { name: "Not now" })).toBeEnabled();
    expect(apiMocks.resetDailyPlanFitInsightDismissal).toHaveBeenCalledWith(personal.id, {
      forDate: date,
      insightKey,
      idempotencyKey: expect.any(String),
    });
    expect(screen.getByRole("status")).toHaveTextContent("Suggestion available again.");
    expect(apiMocks.generateToday).not.toHaveBeenCalled();
  });

  it("returns focus to planning when a post-feedback refresh fails", async () => {
    const user = userEvent.setup();
    const date = todayKey();
    apiMocks.session.mockResolvedValue({ authenticated: true });
    apiMocks.listWorkspaces.mockResolvedValue({ items: [personal] });
    apiMocks.getDailyPlanFitInsight
      .mockResolvedValueOnce({
        forDate: date,
        status: "suggested",
        disposition: "available",
        sampleCount: 3,
        minimumSamples: 3,
        suggestedTargetMinutes: 90,
        suggestedTargetTaskCount: 2,
        insightKey: "7".repeat(64),
      })
      .mockRejectedValueOnce(new Error("private refresh failure"));

    render(<HostedApp />);

    await user.click(await screen.findByRole("button", { name: "Not now" }));
    expect(
      await screen.findByText("Plan Fit guidance is unavailable.", {
        selector: ".hosted-plan-fit-state > span",
      }),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("spinbutton", { name: "Time budget (minutes)" })).toHaveFocus(),
    );
  });

  it("preserves reviewed Plan Fit provenance until a dismissal succeeds", async () => {
    const user = userEvent.setup();
    const date = todayKey();
    const insightKey = "6".repeat(64);
    let rejectDismissal: (reason: unknown) => void = () => undefined;
    const pendingDismissal = new Promise<void>((_resolve, reject) => {
      rejectDismissal = reject;
    });
    apiMocks.session.mockResolvedValue({ authenticated: true });
    apiMocks.listWorkspaces.mockResolvedValue({ items: [personal] });
    apiMocks.getDailyPlanFitInsight.mockResolvedValue({
      forDate: date,
      status: "suggested",
      disposition: "available",
      sampleCount: 3,
      minimumSamples: 3,
      suggestedTargetMinutes: 90,
      suggestedTargetTaskCount: 2,
      insightKey,
    });
    apiMocks.dismissDailyPlanFitInsight.mockReturnValue(pendingDismissal);

    render(<HostedApp />);

    await user.click(await screen.findByRole("button", { name: "Use 1h 30m and 2 tasks" }));
    await user.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.getByRole("button", { name: "Build plan" })).toBeDisabled();
    expect(apiMocks.generateToday).not.toHaveBeenCalled();

    await act(async () => {
      rejectDismissal(new HostedApiError(403, "hosted.workspace_not_found", "private"));
      await pendingDismissal.catch(() => undefined);
    });

    expect(screen.getByRole("button", { name: "Build plan" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Build plan" }));
    expect(apiMocks.generateToday).toHaveBeenCalledWith(
      personal.id,
      date,
      expect.objectContaining({ planFitInsightKey: insightKey }),
    );
  });

  it("retries ambiguous hosted Plan Fit feedback with the same idempotency key", async () => {
    const user = userEvent.setup();
    const date = todayKey();
    const insightKey = "f".repeat(64);
    apiMocks.session.mockResolvedValue({ authenticated: true });
    apiMocks.listWorkspaces.mockResolvedValue({ items: [personal] });
    apiMocks.getDailyPlanFitInsight
      .mockResolvedValueOnce({
        forDate: date,
        status: "suggested",
        disposition: "available",
        sampleCount: 3,
        minimumSamples: 3,
        suggestedTargetMinutes: 90,
        suggestedTargetTaskCount: 2,
        insightKey,
      })
      .mockResolvedValue({
        forDate: date,
        status: "suggested",
        disposition: "dismissed",
        sampleCount: 3,
        minimumSamples: 3,
        suggestedTargetMinutes: 90,
        suggestedTargetTaskCount: 2,
        insightKey,
      });
    apiMocks.dismissDailyPlanFitInsight
      .mockRejectedValueOnce(new HostedApiError(503, "request.failed", "private"))
      .mockResolvedValueOnce(undefined);

    render(<HostedApp />);

    await user.click(await screen.findByRole("button", { name: "Not now" }));
    expect(screen.getByRole("status")).toHaveTextContent(
      "Plan Fit update could not be confirmed. Try again.",
    );
    await user.click(screen.getByRole("button", { name: "Not now" }));
    expect(await screen.findByRole("button", { name: "Show again" })).toBeEnabled();
    expect(apiMocks.dismissDailyPlanFitInsight).toHaveBeenCalledTimes(2);
    expect(apiMocks.dismissDailyPlanFitInsight.mock.calls[1]).toEqual(
      apiMocks.dismissDailyPlanFitInsight.mock.calls[0],
    );
  });

  it("refreshes stale hosted Plan Fit feedback without changing manual targets", async () => {
    const user = userEvent.setup();
    const date = todayKey();
    apiMocks.session.mockResolvedValue({ authenticated: true });
    apiMocks.listWorkspaces.mockResolvedValue({ items: [personal] });
    apiMocks.getDailyPlanFitInsight
      .mockResolvedValueOnce({
        forDate: date,
        status: "suggested",
        disposition: "available",
        sampleCount: 3,
        minimumSamples: 3,
        suggestedTargetMinutes: 90,
        suggestedTargetTaskCount: 2,
        insightKey: "1".repeat(64),
      })
      .mockResolvedValue({
        forDate: date,
        status: "suggested",
        disposition: "available",
        sampleCount: 4,
        minimumSamples: 3,
        suggestedTargetMinutes: 105,
        suggestedTargetTaskCount: 3,
        insightKey: "2".repeat(64),
      });
    apiMocks.dismissDailyPlanFitInsight.mockRejectedValueOnce(
      new HostedApiError(409, "daily_plan_fit_insight.evidence_conflict", "private"),
    );

    render(<HostedApp />);

    await user.clear(await screen.findByRole("spinbutton", { name: "Time budget (minutes)" }));
    await user.type(screen.getByRole("spinbutton", { name: "Time budget (minutes)" }), "205");
    await user.click(screen.getByRole("button", { name: "Not now" }));
    expect(await screen.findByRole("button", { name: "Use 1h 45m and 3 tasks" })).toBeEnabled();
    expect(screen.getByRole("spinbutton", { name: "Time budget (minutes)" })).toHaveValue(205);
    expect(screen.getByRole("status")).toHaveTextContent(
      "Plan Fit changed. Review the refreshed suggestion; nothing was applied.",
    );
    expect(apiMocks.generateToday).not.toHaveBeenCalled();
  });

  it("retries an ambiguous first-plan request with the exact same intent", async () => {
    const user = userEvent.setup();
    const date = todayKey();
    let finishRetry: () => void = () => undefined;
    const pendingRetry = new Promise<void>((resolve) => {
      finishRetry = resolve;
    });
    apiMocks.session.mockResolvedValue({ authenticated: true });
    apiMocks.listWorkspaces.mockResolvedValue({ items: [personal] });
    apiMocks.getToday
      .mockResolvedValueOnce({
        date,
        planId: null,
        headVersion: null,
        items: [],
        totalMinutes: 0,
      })
      .mockResolvedValueOnce({
        date,
        planId: "plan-1",
        headVersion: 1,
        items: [],
        totalMinutes: 0,
      });
    apiMocks.generateToday
      .mockRejectedValueOnce(new HostedApiError(408, "request.timeout", "Timed out after commit."))
      .mockReturnValueOnce(pendingRetry);

    render(<HostedApp />);

    await user.click(await screen.findByRole("button", { name: "Build plan" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Schedule could not be reached.");
    const firstCall = apiMocks.generateToday.mock.calls[0];
    const retry = screen.getByRole("button", { name: "Retry plan" });
    await user.click(retry);
    await waitFor(() => expect(retry).toHaveAttribute("aria-busy", "true"));
    expect(retry).toHaveFocus();
    expect(apiMocks.generateToday).toHaveBeenCalledTimes(2);
    expect(apiMocks.generateToday.mock.calls[1]).toEqual(firstCall);
    finishRetry();
    expect(await screen.findByText("Built today’s plan.")).toBeInTheDocument();
    expect(await screen.findByText("No eligible work fit this plan.")).toBeInTheDocument();
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

  it("completes one Today item and refreshes Today plus its source work item", async () => {
    const user = userEvent.setup();
    const item = {
      id: "plan-item-1",
      title: "Focused review",
      scheduledMinutes: 45,
      activityState: "pending" as const,
    };
    const sourceItem = snapshotItem({ id: "work-item-1", title: item.title });
    let finishSyncRefresh: () => void = () => undefined;
    const pendingSyncRefresh = new Promise<ReturnType<typeof deltaPage>>((resolve) => {
      finishSyncRefresh = () =>
        resolve(
          deltaPage([
            {
              type: "upsert",
              item: { ...sourceItem, status: "done", version: 2 },
            },
          ]),
        );
    });
    apiMocks.session.mockResolvedValue({ authenticated: true });
    apiMocks.listWorkspaces.mockResolvedValue({ items: [personal] });
    apiMocks.bootstrapWorkItemSync.mockResolvedValueOnce(
      bootstrapPage([sourceItem], "checkpoint-1"),
    );
    apiMocks.listWorkItemSyncChanges
      .mockResolvedValueOnce(deltaPage([], "checkpoint-1"))
      .mockReturnValueOnce(pendingSyncRefresh);
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
    await waitFor(() => {
      expect(screen.getByRole("button", { name: `Start ${item.title}` })).toBeDisabled();
      expect(screen.getByRole("button", { name: `Complete ${item.title}` })).toBeDisabled();
    });
    await act(async () => finishSyncRefresh());
    expect(
      await screen.findByText("Done", { selector: ".hosted-backlog-meta" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: `Complete ${item.title}` }),
    ).not.toBeInTheDocument();
  });

  it("retries an ambiguous Today action with the exact same intent", async () => {
    const user = userEvent.setup();
    let finishRetry: () => void = () => undefined;
    const pendingRetry = new Promise<void>((resolve) => {
      finishRetry = resolve;
    });
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
      .mockReturnValueOnce(pendingRetry);

    render(<HostedApp />);

    await user.click(await screen.findByRole("button", { name: `Skip ${item.title} in Today` }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Schedule could not be reached.");
    const firstCall = apiMocks.recordTodayActivity.mock.calls[0];
    const retry = screen.getByRole("button", { name: "Retry action" });
    await user.click(retry);
    await waitFor(() => expect(retry).toHaveAttribute("aria-busy", "true"));
    expect(retry).toBeDisabled();
    expect(retry).toHaveFocus();
    expect(apiMocks.recordTodayActivity).toHaveBeenCalledTimes(2);
    expect(apiMocks.recordTodayActivity.mock.calls[1]).toEqual(firstCall);
    finishRetry();
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
    expect(await screen.findByText("No eligible work fit this plan.")).toBeInTheDocument();
    expect(apiMocks.recordTodayActivity).toHaveBeenCalledOnce();
    expect(apiMocks.getToday).toHaveBeenCalledTimes(2);
  });

  it("keeps a transitioned work item visible after a backlog status update", async () => {
    const user = userEvent.setup();
    const item = snapshotItem({
      id: "item-1",
      title: "Review outline",
      version: 3,
    });
    const updatedItem = { ...item, status: "in_progress" as const, version: 4 };
    let finishUpdate: () => void = () => undefined;
    let finishRefresh: () => void = () => undefined;
    const pendingRefresh = new Promise<ReturnType<typeof deltaPage>>((resolve) => {
      finishRefresh = () =>
        resolve(deltaPage([{ type: "upsert", item: updatedItem }], "checkpoint-2"));
    });
    apiMocks.session.mockResolvedValue({ authenticated: true });
    apiMocks.listWorkspaces.mockResolvedValue({ items: [personal] });
    apiMocks.bootstrapWorkItemSync.mockResolvedValueOnce(bootstrapPage([item], "checkpoint-1"));
    apiMocks.listWorkItemSyncChanges
      .mockResolvedValueOnce(deltaPage([], "checkpoint-1"))
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
    expect(
      await screen.findByText("In progress", { selector: ".hosted-backlog-meta" }),
    ).toBeInTheDocument();
    await act(async () => {
      finishRefresh();
      await pendingRefresh;
    });
    expect(screen.getByText(item.title, { selector: ".hosted-backlog-title" })).toBeInTheDocument();
  });

  it("keeps a stale status update explicit and retryable", async () => {
    const user = userEvent.setup();
    const item = snapshotItem({
      id: "item-1",
      title: "Review outline",
      version: 3,
    });
    apiMocks.session.mockResolvedValue({ authenticated: true });
    apiMocks.listWorkspaces.mockResolvedValue({ items: [personal] });
    apiMocks.bootstrapWorkItemSync.mockResolvedValue(bootstrapPage([item], "checkpoint-1"));
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
      "This item changed. Refresh the work items and try again.",
    );
    expect(screen.getByRole("button", { name: "Retry work items" })).toBeEnabled();
    expect(apiMocks.bootstrapWorkItemSync).toHaveBeenCalledOnce();
    expect(apiMocks.listWorkItemSyncChanges).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Retry work items" }));
    await waitFor(() => expect(apiMocks.listWorkItemSyncChanges).toHaveBeenCalledTimes(2));
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
    await waitFor(() =>
      expect(apiMocks.bootstrapWorkItemSync).toHaveBeenCalledWith(studio.id, undefined),
    );
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
