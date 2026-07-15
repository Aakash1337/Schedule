import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../api";
import { localDateTimeToIso, todayKey } from "../date";
import type {
  CurrentDailyPlan,
  DailyPlanFitInsight,
  ScheduleBlock,
  SchedulingAdviceResult,
  SchedulingAdviceUnavailableReason,
  Workspace,
} from "../types";
import { TodayView } from "./TodayView";

const apiMocks = vi.hoisted(() => ({
  applyRoutineFeedback: vi.fn(),
  dismissDailyPlanFitInsight: vi.fn(),
  generatePlan: vi.fn(),
  getCurrentPlan: vi.fn(),
  getDailyPlanFitInsight: vi.fn(),
  getSchedulingAdvice: vi.fn(),
  listScheduleBlocks: vi.fn(),
  previewDailyPlanAlternatives: vi.fn(),
  recordPlanItemActivity: vi.fn(),
  regeneratePlan: vi.fn(),
  replacePlanItem: vi.fn(),
  resetDailyPlanFitInsightDismissal: vi.fn(),
  resetRoutineFeedback: vi.fn(),
  selectDailyPlanAlternative: vi.fn(),
  setPlanItemLock: vi.fn(),
}));

vi.mock("../api", async (importOriginal) => {
  const original = await importOriginal<typeof import("../api")>();
  return { ...original, api: { ...original.api, ...apiMocks } };
});

const workspace: Workspace = {
  id: "workspace-1",
  name: "Personal",
  createdAt: "2026-07-12T09:00:00.000Z",
  updatedAt: "2026-07-12T09:00:00.000Z",
};

function scheduleBlock(id: string, startsAt: string, endsAt: string, version = 1): ScheduleBlock {
  return {
    id,
    workspaceId: workspace.id,
    workItemId: null,
    title: "Reserved",
    startsAt: localDateTimeToIso(todayKey(), startsAt),
    endsAt: localDateTimeToIso(todayKey(), endsAt),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    version,
    createdAt: "2026-07-12T09:00:00.000Z",
    updatedAt: "2026-07-12T09:00:00.000Z",
  };
}

const plan: CurrentDailyPlan = {
  id: "plan-1",
  workspaceId: workspace.id,
  date: todayKey(),
  timeZone: "America/La_Paz",
  items: [
    {
      id: "plan-item-1",
      sourceType: "routine",
      routineId: "routine-1",
      workItemId: null,
      title: "Practice Spanish",
      position: 0,
      windowIndex: 0,
      scheduledMinutes: 30,
      partialSession: false,
      score: 1,
      scoreComponents: {},
      reasons: ["Due this week"],
      locked: false,
      activityState: "pending",
      lastActivityEventId: null,
      activityUpdatedAt: null,
    },
  ],
  totalMinutes: 30,
  fitness: 1,
  algorithmVersion: "planner-v1",
  configVersion: "config-v1",
  prngVersion: "prng-v1",
  seed: "seed",
  requestRevision: 1,
  inputHash: "hash",
  exclusions: [],
  warnings: [],
  generatedAt: "2026-07-12T09:00:00.000Z",
  request: {
    workspaceId: workspace.id,
    date: todayKey(),
    timeZone: "America/La_Paz",
    availableWindows: [
      {
        startsAt: `${todayKey()}T09:00:00.000Z`,
        endsAt: `${todayKey()}T12:00:00.000Z`,
      },
    ],
    targetMinutes: 180,
    minimumMinutes: 120,
    maximumMinutes: 240,
    targetTaskCount: 4,
    minimumTaskCount: 3,
    maximumTaskCount: 5,
    fitPreference: "balanced",
    energy: null,
    availableContexts: [],
    seed: "seed",
    requestRevision: 1,
  },
  headVersion: 2,
};

function planFitInsight(overrides: Partial<DailyPlanFitInsight> = {}): DailyPlanFitInsight {
  return {
    status: "insufficient_history",
    insightKey: null,
    disposition: "available",
    dismissedAt: null,
    forDate: todayKey(),
    windowStartedOn: "2026-04-15",
    windowEndedOn: "2026-07-13",
    lookbackDays: 90,
    sampleCount: 1,
    minimumSamples: 3,
    maximumSamples: 28,
    evaluatedAt: "2026-07-14T12:00:00.000Z",
    typicalPlannedMinutes: null,
    typicalCompletedMinutes: null,
    materialThresholdMinutes: null,
    typicalPlannedTaskCount: null,
    typicalCompletedTaskCount: null,
    materialThresholdTaskCount: null,
    suggestedTargetMinutes: null,
    suggestedTargetTaskCount: null,
    ...overrides,
  };
}

function suggestedPlanFitInsight(
  overrides: Partial<DailyPlanFitInsight> = {},
): DailyPlanFitInsight {
  return planFitInsight({
    status: "suggested",
    insightKey: "a".repeat(64),
    sampleCount: 5,
    typicalPlannedMinutes: 180,
    typicalCompletedMinutes: 90,
    materialThresholdMinutes: 45,
    typicalPlannedTaskCount: 4,
    typicalCompletedTaskCount: 2,
    materialThresholdTaskCount: 1,
    suggestedTargetMinutes: 90,
    suggestedTargetTaskCount: 2,
    ...overrides,
  });
}

function availableAdvice(overrides: Partial<SchedulingAdviceResult> = {}): SchedulingAdviceResult {
  return {
    version: "schedule.advisor/v1",
    requestId: "84cf5854-f934-4a23-a4da-a961dd108f3b",
    status: "available",
    reason: null,
    snapshot: { date: plan.date, planId: plan.id, headVersion: plan.headVersion },
    provenance: {
      provider: "ollama",
      model: "gemma4:e4b",
      requestedAt: "2026-07-13T14:00:00.000Z",
      completedAt: "2026-07-13T14:00:02.000Z",
      latencyMs: 2_000,
    },
    summary: "Keep the first block focused and leave room for the backlog.",
    suggestions: [
      {
        id: "advice-1",
        kind: "focus",
        targetType: "plan_item",
        targetId: "plan-item-1",
        title: "Start with Spanish",
        rationale: "It is already selected and fits the first available window.",
        confidence: "medium",
      },
    ],
    input: {
      planItemCount: 1,
      backlogCount: 2,
      truncated: { planItems: false, backlog: false },
    },
    ...overrides,
  };
}

function unavailableAdvice(reason: SchedulingAdviceUnavailableReason): SchedulingAdviceResult {
  return availableAdvice({ status: "unavailable", reason, summary: null, suggestions: [] });
}

function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function planWithTemporaryFeedback(kind: "not_today" | "not_this_week"): CurrentDailyPlan {
  return {
    ...plan,
    id: `plan-${kind}`,
    headVersion: 3,
    requestRevision: 2,
    request:
      plan.request === null ? null : { ...plan.request, seed: `${kind}-seed`, requestRevision: 2 },
    items: [
      {
        ...plan.items[0]!,
        id: "plan-item-work-1",
        sourceType: "work_item",
        routineId: null,
        workItemId: "work-item-1",
        title: "Check the inbox",
      },
    ],
    exclusions: [
      {
        sourceType: "routine",
        routineId: "routine-1",
        workItemId: null,
        title: "Practice Spanish",
        codes: [kind === "not_today" ? "feedback_not_today" : "feedback_not_this_week"],
      },
    ],
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  apiMocks.getCurrentPlan.mockResolvedValue(plan);
  apiMocks.getDailyPlanFitInsight.mockResolvedValue(planFitInsight());
  apiMocks.listScheduleBlocks.mockResolvedValue({
    items: [],
    page: { limit: 200, offset: 0 },
  });
});

afterEach(cleanup);

describe("Today commands", () => {
  it("compares distinct plans and changes Today only after an explicit selection", async () => {
    const user = userEvent.setup();
    const candidateKey = "a".repeat(64);
    apiMocks.previewDailyPlanAlternatives.mockResolvedValue({
      sourcePlanId: plan.id,
      sourceHeadVersion: plan.headVersion,
      alternatives: [
        {
          candidateKey,
          items: [
            {
              sourceType: "routine",
              routineId: "routine-2",
              workItemId: null,
              title: "Write project notes",
              windowIndex: 0,
              scheduledMinutes: 45,
              partialSession: false,
              score: 2,
              reasons: ["Due this week"],
            },
          ],
          totalMinutes: 45,
          taskCount: 1,
          fitness: 2,
          warnings: [],
          deltaMinutes: 15,
          deltaTaskCount: 0,
          addedSourceKeys: ["routine:routine-2"],
          removedSourceKeys: ["routine:routine-1"],
          changedPlacements: [],
        },
      ],
    });
    apiMocks.selectDailyPlanAlternative.mockResolvedValue({
      ...plan,
      id: "plan-2",
      headVersion: 3,
      requestRevision: 2,
      totalMinutes: 45,
      items: [
        {
          ...plan.items[0]!,
          id: "plan-item-2",
          routineId: "routine-2",
          title: "Write project notes",
          scheduledMinutes: 45,
        },
      ],
    });

    render(<TodayView workspace={workspace} onNavigate={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "Compare alternatives" }));

    expect(
      await screen.findByRole("heading", { name: "Compare before changing Today" }),
    ).toBeVisible();
    expect(screen.getByText("Current plan")).toBeVisible();
    expect(screen.getByRole("heading", { name: /45m · 1 item/i })).toBeVisible();
    expect(screen.getByText(/Write project notes · 45m/i)).toBeVisible();
    expect(apiMocks.selectDailyPlanAlternative).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Use alternative 1 as today's plan" }));

    expect(await screen.findByRole("heading", { name: "Write project notes" })).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("Alternative 1 is now today's plan.");
    expect(screen.queryByRole("heading", { name: "Compare before changing Today" })).toBeNull();
    const previewRequest = apiMocks.previewDailyPlanAlternatives.mock.calls[0]?.[2].request;
    expect(previewRequest).toBeDefined();
    expect(apiMocks.selectDailyPlanAlternative).toHaveBeenCalledWith(
      workspace.id,
      plan.date,
      expect.objectContaining({
        expectedPlanId: plan.id,
        expectedHeadVersion: plan.headVersion,
        candidateKey,
        request: previewRequest,
      }),
      expect.any(String),
    );
  });

  it("discards stale alternatives and refreshes the authoritative plan", async () => {
    const user = userEvent.setup();
    const latest = {
      ...plan,
      items: [{ ...plan.items[0]!, title: "Authoritative current title" }],
    };
    apiMocks.getCurrentPlan.mockResolvedValueOnce(plan).mockResolvedValueOnce(latest);
    apiMocks.previewDailyPlanAlternatives.mockResolvedValue({
      sourcePlanId: plan.id,
      sourceHeadVersion: plan.headVersion,
      alternatives: [
        {
          candidateKey: "b".repeat(64),
          items: [
            {
              sourceType: "routine",
              routineId: "routine-2",
              workItemId: null,
              title: "Write project notes",
              windowIndex: 0,
              scheduledMinutes: 30,
              partialSession: false,
              score: 2,
              reasons: [],
            },
          ],
          totalMinutes: 30,
          taskCount: 1,
          fitness: 2,
          warnings: [],
          deltaMinutes: 0,
          deltaTaskCount: 0,
          addedSourceKeys: ["routine:routine-2"],
          removedSourceKeys: ["routine:routine-1"],
          changedPlacements: [],
        },
      ],
    });
    apiMocks.selectDailyPlanAlternative.mockRejectedValue(
      new ApiError(409, "planning.alternative_stale", "Alternative changed.", null),
    );

    render(<TodayView workspace={workspace} onNavigate={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "Compare alternatives" }));
    await user.click(
      await screen.findByRole("button", { name: "Use alternative 1 as today's plan" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This plan changed. The latest plan is shown; compare again.",
    );
    expect(screen.getByRole("heading", { name: "Authoritative current title" })).toBeVisible();
    expect(screen.queryByRole("heading", { name: "Compare before changing Today" })).toBeNull();
  });

  it("clears preview loading when a plan mutation wins the response race", async () => {
    const user = userEvent.setup();
    const pendingPreview = deferred<{
      sourcePlanId: string;
      sourceHeadVersion: number;
      alternatives: [];
    }>();
    apiMocks.previewDailyPlanAlternatives.mockReturnValue(pendingPreview.promise);
    apiMocks.setPlanItemLock.mockResolvedValue({
      planId: plan.id,
      itemId: plan.items[0]!.id,
      locked: true,
      headVersion: plan.headVersion + 1,
    });

    render(<TodayView workspace={workspace} onNavigate={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "Compare alternatives" }));
    expect(await screen.findByRole("heading", { name: "Finding distinct options…" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Lock" }));
    expect(await screen.findByRole("button", { name: "Unlock" })).toBeVisible();
    await act(async () => {
      pendingPreview.resolve({
        sourcePlanId: plan.id,
        sourceHeadVersion: plan.headVersion,
        alternatives: [],
      });
      await pendingPreview.promise;
    });

    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Finding distinct options…" })).toBeNull(),
    );
    expect(screen.queryByRole("heading", { name: "Compare before changing Today" })).toBeNull();
    expect(screen.getByRole("button", { name: "Compare alternatives" })).toBeEnabled();
  });

  it("identifies routine and one-time work sources in a mixed plan", async () => {
    const mixedPlan: CurrentDailyPlan = {
      ...plan,
      items: [
        ...plan.items,
        {
          ...plan.items[0]!,
          id: "plan-item-work-1",
          sourceType: "work_item",
          routineId: null,
          workItemId: "work-item-1",
          title: "Send the proposal",
          position: 1,
        },
      ],
    };
    apiMocks.getCurrentPlan.mockResolvedValue(mixedPlan);

    render(<TodayView workspace={workspace} onNavigate={vi.fn()} />);

    expect(await screen.findByText("Routine")).toBeInTheDocument();
    expect(screen.getByText("Work item")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Today's planned items" })).toBeInTheDocument();
  });

  it("uses distinct source keys for multiple excluded work items", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    apiMocks.getCurrentPlan.mockResolvedValue({
      ...plan,
      exclusions: [
        {
          sourceType: "work_item" as const,
          routineId: null,
          workItemId: "work-item-1",
          title: "Send the proposal",
          codes: ["work_item_not_plannable"],
        },
        {
          sourceType: "work_item" as const,
          routineId: null,
          workItemId: "work-item-2",
          title: "Review the contract",
          codes: ["work_item_not_plannable"],
        },
      ],
    });

    render(<TodayView workspace={workspace} onNavigate={vi.fn()} />);

    await screen.findByText("Send the proposal");
    expect(screen.getByText("Review the contract")).toBeInTheDocument();
    expect(consoleError).not.toHaveBeenCalledWith(
      expect.stringContaining('unique "key"'),
      expect.anything(),
    );
    consoleError.mockRestore();
  });
  it("ignores a late plan response from the previously selected workspace", async () => {
    const firstRequest = deferred<CurrentDailyPlan>();
    const secondRequest = deferred<CurrentDailyPlan>();
    const secondWorkspace = { ...workspace, id: "workspace-2", name: "Shared" };
    const secondPlan: CurrentDailyPlan = {
      ...plan,
      id: "plan-2",
      workspaceId: secondWorkspace.id,
      items: plan.items.map((item) => ({
        ...item,
        id: "plan-item-2",
        title: "Review the budget",
      })),
    };
    apiMocks.getCurrentPlan.mockImplementation((workspaceId: string) =>
      workspaceId === workspace.id ? firstRequest.promise : secondRequest.promise,
    );

    const { rerender } = render(<TodayView workspace={workspace} onNavigate={vi.fn()} />);
    await waitFor(() =>
      expect(apiMocks.getCurrentPlan).toHaveBeenCalledWith(
        workspace.id,
        plan.date,
        expect.any(AbortSignal),
      ),
    );

    rerender(<TodayView workspace={secondWorkspace} onNavigate={vi.fn()} />);
    await waitFor(() =>
      expect(apiMocks.getCurrentPlan).toHaveBeenCalledWith(
        secondWorkspace.id,
        secondPlan.date,
        expect.any(AbortSignal),
      ),
    );

    await act(async () => {
      secondRequest.resolve(secondPlan);
      await secondRequest.promise;
    });
    expect(await screen.findByText("Review the budget")).toBeInTheDocument();

    await act(async () => {
      firstRequest.resolve(plan);
      await firstRequest.promise;
    });
    expect(screen.getByText("Review the budget")).toBeInTheDocument();
    expect(screen.queryByText("Practice Spanish")).not.toBeInTheDocument();
  });

  it("reloads the current plan after a head-version conflict", async () => {
    const user = userEvent.setup();
    const latest = {
      ...plan,
      headVersion: 3,
      items: plan.items.map((item) => ({ ...item, locked: true })),
    };
    apiMocks.getCurrentPlan.mockResolvedValueOnce(plan).mockResolvedValueOnce(latest);
    apiMocks.setPlanItemLock.mockRejectedValue(
      new ApiError(409, "planning.head_conflict", "Changed elsewhere.", null),
    );

    render(<TodayView workspace={workspace} onNavigate={vi.fn()} />);

    await user.click(await screen.findByRole("button", { name: "Lock" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("latest version is now shown");
    expect(screen.getByRole("button", { name: "Unlock" })).toHaveAttribute("aria-pressed", "true");
  });

  it("generates a plan from both time and task-count targets", async () => {
    const user = userEvent.setup();
    apiMocks.getCurrentPlan
      .mockRejectedValueOnce(new ApiError(404, "daily_plan.not_found", "No plan exists yet.", null))
      .mockResolvedValueOnce(plan);
    apiMocks.generatePlan.mockResolvedValue(plan);

    render(<TodayView workspace={workspace} onNavigate={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: "Shape the time you have" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Generate today's plan" }));

    await waitFor(() =>
      expect(apiMocks.generatePlan).toHaveBeenCalledWith(
        workspace.id,
        expect.objectContaining({
          date: todayKey(),
          targetMinutes: 180,
          targetTaskCount: 4,
          fitPreference: "balanced",
          requestRevision: 1,
        }),
      ),
    );
    expect(await screen.findByText("Practice Spanish")).toBeInTheDocument();
  });

  it("announces Plan Fit loading without changing either target", async () => {
    const request = deferred<DailyPlanFitInsight>();
    apiMocks.getCurrentPlan.mockRejectedValue(
      new ApiError(404, "daily_plan.not_found", "No plan exists.", null),
    );
    apiMocks.getDailyPlanFitInsight.mockReturnValue(request.promise);

    render(<TodayView workspace={workspace} onNavigate={vi.fn()} />);

    const heading = await screen.findByRole("heading", {
      name: "Checking your resolved plans…",
    });
    expect(heading.closest('[role="status"]')).toHaveTextContent("Checking your resolved plans");
    expect(screen.getByRole("spinbutton", { name: /^Target minutes/ })).toHaveValue(180);
    expect(screen.getByRole("spinbutton", { name: /^Target tasks/ })).toHaveValue(4);

    await act(async () => {
      request.resolve(planFitInsight());
      await request.promise;
    });
    expect(await screen.findByRole("heading", { name: "Plan Fit is learning" })).toBeVisible();
  });

  it("recovers from an initial Plan Fit load failure only after explicit retry", async () => {
    const user = userEvent.setup();
    apiMocks.getCurrentPlan.mockRejectedValue(
      new ApiError(404, "daily_plan.not_found", "No plan exists.", null),
    );
    apiMocks.getDailyPlanFitInsight
      .mockRejectedValueOnce(new Error("initial load failed"))
      .mockResolvedValueOnce(planFitInsight());

    render(<TodayView workspace={workspace} onNavigate={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: "Plan Fit is unavailable" })).toBeVisible();
    expect(screen.getByRole("spinbutton", { name: /^Target minutes/ })).toHaveValue(180);
    expect(screen.getByRole("spinbutton", { name: /^Target tasks/ })).toHaveValue(4);

    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(await screen.findByRole("heading", { name: "Plan Fit is learning" })).toBeVisible();
    expect(apiMocks.getDailyPlanFitInsight).toHaveBeenCalledTimes(2);
  });

  it("aborts and ignores Plan Fit results from the previous workspace", async () => {
    const firstRequest = deferred<DailyPlanFitInsight>();
    const secondRequest = deferred<DailyPlanFitInsight>();
    const secondWorkspace = { ...workspace, id: "workspace-2", name: "Shared" };
    apiMocks.getCurrentPlan.mockRejectedValue(
      new ApiError(404, "daily_plan.not_found", "No plan exists.", null),
    );
    apiMocks.getDailyPlanFitInsight.mockImplementation((workspaceId: string) =>
      workspaceId === workspace.id ? firstRequest.promise : secondRequest.promise,
    );

    const { rerender } = render(<TodayView workspace={workspace} onNavigate={vi.fn()} />);
    await waitFor(() => expect(apiMocks.getDailyPlanFitInsight).toHaveBeenCalledTimes(1));
    const firstSignal = apiMocks.getDailyPlanFitInsight.mock.calls[0]?.[2] as AbortSignal;

    rerender(<TodayView workspace={secondWorkspace} onNavigate={vi.fn()} />);
    await waitFor(() => expect(apiMocks.getDailyPlanFitInsight).toHaveBeenCalledTimes(2));
    expect(firstSignal.aborted).toBe(true);

    await act(async () => {
      secondRequest.resolve(
        suggestedPlanFitInsight({
          suggestedTargetMinutes: 120,
          suggestedTargetTaskCount: 3,
        }),
      );
      await secondRequest.promise;
    });
    expect(
      await screen.findByRole("heading", { name: "Try 120 minutes and 3 tasks" }),
    ).toBeVisible();

    await act(async () => {
      firstRequest.resolve(suggestedPlanFitInsight());
      await firstRequest.promise;
    });
    expect(screen.getByRole("heading", { name: "Try 120 minutes and 3 tasks" })).toBeVisible();
    expect(
      screen.queryByRole("heading", { name: "Try 90 minutes and 2 tasks" }),
    ).not.toBeInTheDocument();
  });

  it("prefills both Plan Fit targets without generating until the user submits", async () => {
    const user = userEvent.setup();
    apiMocks.getCurrentPlan
      .mockRejectedValueOnce(new ApiError(404, "daily_plan.not_found", "No plan exists.", null))
      .mockResolvedValueOnce(plan);
    apiMocks.getDailyPlanFitInsight.mockResolvedValue(suggestedPlanFitInsight());
    apiMocks.generatePlan.mockResolvedValue(plan);

    render(<TodayView workspace={workspace} onNavigate={vi.fn()} />);

    await user.click(await screen.findByRole("button", { name: "Use 90 minutes and 2 tasks" }));

    const minutes = screen.getByRole("spinbutton", { name: /^Target minutes/ });
    const tasks = screen.getByRole("spinbutton", { name: /^Target tasks/ });
    expect(minutes).toHaveValue(90);
    expect(tasks).toHaveValue(2);
    expect(minutes).toHaveFocus();
    expect(apiMocks.generatePlan).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("Review both targets");

    await user.click(screen.getByRole("button", { name: "Generate today's plan" }));
    await waitFor(() =>
      expect(apiMocks.generatePlan).toHaveBeenCalledWith(
        workspace.id,
        expect.objectContaining({ targetMinutes: 90, targetTaskCount: 2 }),
      ),
    );
  });

  it("dismisses and restores only the exact Plan Fit evidence key", async () => {
    const user = userEvent.setup();
    const available = suggestedPlanFitInsight();
    const dismissed = suggestedPlanFitInsight({
      disposition: "dismissed",
      dismissedAt: "2026-07-14T12:15:00.000Z",
    });
    apiMocks.getCurrentPlan.mockRejectedValue(
      new ApiError(404, "daily_plan.not_found", "No plan exists.", null),
    );
    apiMocks.getDailyPlanFitInsight
      .mockResolvedValueOnce(available)
      .mockResolvedValueOnce(dismissed)
      .mockResolvedValueOnce(available);
    apiMocks.dismissDailyPlanFitInsight.mockResolvedValue({ id: "feedback-1" });
    apiMocks.resetDailyPlanFitInsightDismissal.mockResolvedValue({ id: "feedback-2" });

    render(<TodayView workspace={workspace} onNavigate={vi.fn()} />);

    await user.click(await screen.findByRole("button", { name: "Not now" }));
    await waitFor(() =>
      expect(apiMocks.dismissDailyPlanFitInsight).toHaveBeenCalledWith(
        workspace.id,
        { forDate: todayKey(), insightKey: "a".repeat(64) },
        expect.any(String),
        expect.any(AbortSignal),
      ),
    );
    expect(
      await screen.findByRole("heading", { name: "Plan Fit suggestion paused" }),
    ).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "Show again" }));
    await waitFor(() =>
      expect(apiMocks.resetDailyPlanFitInsightDismissal).toHaveBeenCalledWith(
        workspace.id,
        { forDate: todayKey(), insightKey: "a".repeat(64) },
        expect.any(String),
        expect.any(AbortSignal),
      ),
    );
    expect(
      await screen.findByRole("heading", { name: "Try 90 minutes and 2 tasks" }),
    ).toHaveFocus();
  });

  it("hides stale Plan Fit actions when a post-feedback refresh fails", async () => {
    const user = userEvent.setup();
    const available = suggestedPlanFitInsight();
    const dismissed = suggestedPlanFitInsight({
      disposition: "dismissed",
      dismissedAt: "2026-07-14T12:15:00.000Z",
    });
    apiMocks.getCurrentPlan.mockRejectedValue(
      new ApiError(404, "daily_plan.not_found", "No plan exists.", null),
    );
    apiMocks.getDailyPlanFitInsight
      .mockResolvedValueOnce(available)
      .mockRejectedValueOnce(new Error("refresh failed"))
      .mockResolvedValueOnce(dismissed);
    apiMocks.dismissDailyPlanFitInsight.mockResolvedValue({ id: "feedback-1" });

    render(<TodayView workspace={workspace} onNavigate={vi.fn()} />);

    await user.click(await screen.findByRole("button", { name: "Not now" }));

    expect(await screen.findByRole("heading", { name: "Plan Fit is unavailable" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Not now" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: "Try 90 minutes and 2 tasks" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(
      await screen.findByRole("heading", { name: "Plan Fit suggestion paused" }),
    ).toBeVisible();
  });

  it("refetches changed evidence after a stale Plan Fit feedback command", async () => {
    const user = userEvent.setup();
    apiMocks.getCurrentPlan.mockRejectedValue(
      new ApiError(404, "daily_plan.not_found", "No plan exists.", null),
    );
    apiMocks.getDailyPlanFitInsight
      .mockResolvedValueOnce(suggestedPlanFitInsight())
      .mockResolvedValueOnce(
        suggestedPlanFitInsight({
          insightKey: "b".repeat(64),
          suggestedTargetMinutes: 120,
          suggestedTargetTaskCount: 3,
        }),
      );
    apiMocks.dismissDailyPlanFitInsight.mockRejectedValue(
      new ApiError(409, "daily_plan_fit_insight.evidence_conflict", "The evidence changed.", null),
    );

    render(<TodayView workspace={workspace} onNavigate={vi.fn()} />);

    await user.click(await screen.findByRole("button", { name: "Not now" }));

    expect(
      await screen.findByRole("heading", { name: "Try 120 minutes and 3 tasks" }),
    ).toHaveFocus();
    expect(screen.getByRole("status")).toHaveTextContent("evidence changed");
    expect(screen.getByRole("spinbutton", { name: /^Target minutes/ })).toHaveValue(180);
    expect(screen.getByRole("spinbutton", { name: /^Target tasks/ })).toHaveValue(4);
  });

  it("subtracts calendar blocks into explicit free windows before generating", async () => {
    const user = userEvent.setup();
    const reserved = scheduleBlock("block-lunch", "11:00", "12:00");
    apiMocks.getCurrentPlan
      .mockRejectedValueOnce(new ApiError(404, "daily_plan.not_found", "No plan exists.", null))
      .mockResolvedValueOnce(plan);
    apiMocks.listScheduleBlocks.mockResolvedValue({
      items: [reserved],
      page: { limit: 200, offset: 0 },
    });
    apiMocks.generatePlan.mockResolvedValue(plan);

    render(<TodayView workspace={workspace} onNavigate={vi.fn()} />);

    await user.click(await screen.findByRole("checkbox", { name: "Exclude calendar blocks" }));
    expect(await screen.findByText(/7h free/)).toBeVisible();
    expect(screen.getByRole("list", { name: "Free planning windows" })).toBeVisible();
    expect(
      screen.getByRole("checkbox", { name: "Exclude calendar blocks" }),
    ).toHaveAccessibleDescription(
      "Treat reservations inside this range as unavailable planning time.",
    );

    await user.click(screen.getByRole("button", { name: "Generate today's plan" }));

    await waitFor(() => expect(apiMocks.generatePlan).toHaveBeenCalledOnce());
    expect(apiMocks.listScheduleBlocks).toHaveBeenCalledTimes(2);
    expect(apiMocks.generatePlan).toHaveBeenCalledWith(
      workspace.id,
      expect.objectContaining({
        availableWindows: [
          {
            startsAt: localDateTimeToIso(todayKey(), "09:00"),
            endsAt: localDateTimeToIso(todayKey(), "11:00"),
          },
          {
            startsAt: localDateTimeToIso(todayKey(), "12:00"),
            endsAt: localDateTimeToIso(todayKey(), "17:00"),
          },
        ],
        seed: expect.stringContaining("calendar-aware"),
      }),
    );
  });

  it("stops a stale calendar submission and succeeds after the user reviews the update", async () => {
    const user = userEvent.setup();
    const original = scheduleBlock("block-lunch", "11:00", "12:00");
    const changed = scheduleBlock("block-lunch", "10:00", "12:00", 2);
    const page = (items: readonly ScheduleBlock[]) => ({
      items,
      page: { limit: 200, offset: 0 },
    });
    apiMocks.getCurrentPlan
      .mockRejectedValueOnce(new ApiError(404, "daily_plan.not_found", "No plan exists.", null))
      .mockResolvedValueOnce(plan);
    apiMocks.listScheduleBlocks
      .mockResolvedValueOnce(page([original]))
      .mockResolvedValueOnce(page([changed]))
      .mockResolvedValueOnce(page([changed]));
    apiMocks.generatePlan.mockResolvedValue(plan);

    render(<TodayView workspace={workspace} onNavigate={vi.fn()} />);
    await user.click(await screen.findByRole("checkbox", { name: "Exclude calendar blocks" }));
    expect(await screen.findByText(/7h free/)).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Generate today's plan" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Your calendar changed. Review the updated free windows",
    );
    expect(apiMocks.generatePlan).not.toHaveBeenCalled();
    expect(await screen.findByText(/6h free/)).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Generate today's plan" }));
    await waitFor(() => expect(apiMocks.generatePlan).toHaveBeenCalledOnce());
    expect(apiMocks.generatePlan).toHaveBeenCalledWith(
      workspace.id,
      expect.objectContaining({
        availableWindows: [
          {
            startsAt: localDateTimeToIso(todayKey(), "09:00"),
            endsAt: localDateTimeToIso(todayKey(), "10:00"),
          },
          {
            startsAt: localDateTimeToIso(todayKey(), "12:00"),
            endsAt: localDateTimeToIso(todayKey(), "17:00"),
          },
        ],
      }),
    );
  });

  it("prevents generation when calendar blocks consume the selected range", async () => {
    const user = userEvent.setup();
    apiMocks.getCurrentPlan.mockRejectedValueOnce(
      new ApiError(404, "daily_plan.not_found", "No plan exists.", null),
    );
    apiMocks.listScheduleBlocks.mockResolvedValue({
      items: [scheduleBlock("block-all-day", "08:00", "18:00")],
      page: { limit: 200, offset: 0 },
    });

    render(<TodayView workspace={workspace} onNavigate={vi.fn()} />);
    await user.click(await screen.findByRole("checkbox", { name: "Exclude calendar blocks" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Calendar blocks fill this entire range",
    );
    expect(screen.getByRole("button", { name: "Generate today's plan" })).toBeDisabled();
    expect(apiMocks.generatePlan).not.toHaveBeenCalled();
  });

  it("fails closed on a calendar load error while preserving the manual range escape hatch", async () => {
    const user = userEvent.setup();
    apiMocks.getCurrentPlan
      .mockRejectedValueOnce(new ApiError(404, "daily_plan.not_found", "No plan exists.", null))
      .mockResolvedValueOnce(plan);
    apiMocks.listScheduleBlocks.mockRejectedValueOnce(new Error("Calendar is offline."));
    apiMocks.generatePlan.mockResolvedValue(plan);

    render(<TodayView workspace={workspace} onNavigate={vi.fn()} />);
    const toggle = await screen.findByRole("checkbox", { name: "Exclude calendar blocks" });
    await user.click(toggle);

    expect(await screen.findByRole("alert")).toHaveTextContent("Calendar is offline");
    expect(screen.getByRole("button", { name: "Generate today's plan" })).toBeDisabled();

    await user.click(toggle);
    expect(screen.getByRole("button", { name: "Generate today's plan" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Generate today's plan" }));

    await waitFor(() => expect(apiMocks.generatePlan).toHaveBeenCalledOnce());
    expect(apiMocks.generatePlan).toHaveBeenCalledWith(
      workspace.id,
      expect.objectContaining({
        availableWindows: [
          {
            startsAt: localDateTimeToIso(todayKey(), "09:00"),
            endsAt: localDateTimeToIso(todayKey(), "17:00"),
          },
        ],
        seed: expect.stringContaining("manual"),
      }),
    );
  });

  it("fails closed when a successful calendar response contains malformed block data", async () => {
    const user = userEvent.setup();
    apiMocks.getCurrentPlan.mockRejectedValueOnce(
      new ApiError(404, "daily_plan.not_found", "No plan exists.", null),
    );
    apiMocks.listScheduleBlocks.mockResolvedValue({
      items: [scheduleBlock("invalid-version", "11:00", "12:00", 0)],
      page: { limit: 200, offset: 0 },
    });

    render(<TodayView workspace={workspace} onNavigate={vi.fn()} />);
    const toggle = await screen.findByRole("checkbox", { name: "Exclude calendar blocks" });
    await user.click(toggle);

    expect(await screen.findByRole("alert")).toHaveTextContent("must have a positive version");
    expect(screen.getByRole("button", { name: "Generate today's plan" })).toBeDisabled();
    expect(apiMocks.generatePlan).not.toHaveBeenCalled();

    await user.click(toggle);
    expect(screen.getByRole("button", { name: "Generate today's plan" })).toBeEnabled();
  });

  it("aborts and ignores calendar availability returned for a previous workspace", async () => {
    const user = userEvent.setup();
    const firstRequest = deferred<{
      readonly items: readonly ScheduleBlock[];
      readonly page: { readonly limit: number; readonly offset: number };
    }>();
    const secondRequest = deferred<{
      readonly items: readonly ScheduleBlock[];
      readonly page: { readonly limit: number; readonly offset: number };
    }>();
    const secondWorkspace = { ...workspace, id: "workspace-2", name: "Shared" };
    apiMocks.getCurrentPlan.mockRejectedValue(
      new ApiError(404, "daily_plan.not_found", "No plan exists.", null),
    );
    apiMocks.listScheduleBlocks
      .mockReturnValueOnce(firstRequest.promise)
      .mockReturnValueOnce(secondRequest.promise);

    const { rerender } = render(<TodayView workspace={workspace} onNavigate={vi.fn()} />);
    await user.click(await screen.findByRole("checkbox", { name: "Exclude calendar blocks" }));
    await waitFor(() => expect(apiMocks.listScheduleBlocks).toHaveBeenCalledOnce());
    const firstSignal = apiMocks.listScheduleBlocks.mock.calls[0]?.[3] as AbortSignal;

    rerender(<TodayView workspace={secondWorkspace} onNavigate={vi.fn()} />);
    await waitFor(() => expect(apiMocks.listScheduleBlocks).toHaveBeenCalledTimes(2));
    expect(firstSignal.aborted).toBe(true);

    await act(async () => {
      secondRequest.resolve({
        items: [scheduleBlock("shared-reservation", "13:00", "14:00")],
        page: { limit: 200, offset: 0 },
      });
      await secondRequest.promise;
    });
    expect(await screen.findByText(/7h free/)).toBeVisible();

    await act(async () => {
      firstRequest.resolve({
        items: [scheduleBlock("old-all-day", "08:00", "18:00")],
        page: { limit: 200, offset: 0 },
      });
      await firstRequest.promise;
    });
    expect(screen.getByText(/7h free/)).toBeVisible();
    expect(screen.queryByText(/fill this entire range/)).not.toBeInTheDocument();
  });

  it("cancels an old submit-time calendar read across an A to B to A workspace switch", async () => {
    const user = userEvent.setup();
    const pendingFreshness = deferred<{
      readonly items: readonly ScheduleBlock[];
      readonly page: { readonly limit: number; readonly offset: number };
    }>();
    const emptyPage = { items: [], page: { limit: 200, offset: 0 } };
    const secondWorkspace = { ...workspace, id: "workspace-2", name: "Shared" };
    apiMocks.getCurrentPlan.mockRejectedValue(
      new ApiError(404, "daily_plan.not_found", "No plan exists.", null),
    );
    apiMocks.listScheduleBlocks
      .mockResolvedValueOnce(emptyPage)
      .mockReturnValueOnce(pendingFreshness.promise)
      .mockResolvedValueOnce(emptyPage)
      .mockResolvedValueOnce(emptyPage);

    const { rerender } = render(<TodayView workspace={workspace} onNavigate={vi.fn()} />);
    await user.click(await screen.findByRole("checkbox", { name: "Exclude calendar blocks" }));
    expect(await screen.findByText(/8h free/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Generate today's plan" }));
    await waitFor(() => expect(apiMocks.listScheduleBlocks).toHaveBeenCalledTimes(2));
    const freshnessSignal = apiMocks.listScheduleBlocks.mock.calls[1]?.[3] as AbortSignal;

    rerender(<TodayView workspace={secondWorkspace} onNavigate={vi.fn()} />);
    await waitFor(() => expect(apiMocks.listScheduleBlocks).toHaveBeenCalledTimes(3));
    expect(freshnessSignal.aborted).toBe(true);

    rerender(<TodayView workspace={workspace} onNavigate={vi.fn()} />);
    await waitFor(() => expect(apiMocks.listScheduleBlocks).toHaveBeenCalledTimes(4));

    await act(async () => {
      pendingFreshness.resolve(emptyPage);
      await pendingFreshness.promise;
    });
    await waitFor(() => expect(apiMocks.generatePlan).not.toHaveBeenCalled());
    expect(screen.queryByText("Today's plan is ready.")).not.toBeInTheDocument();
  });

  it("applies a lock mutation response without a second plan read", async () => {
    const user = userEvent.setup();
    apiMocks.setPlanItemLock.mockResolvedValue({
      planId: plan.id,
      itemId: plan.items[0]?.id,
      locked: true,
      headVersion: 3,
    });

    render(<TodayView workspace={workspace} onNavigate={vi.fn()} />);

    await user.click(await screen.findByRole("button", { name: "Lock" }));

    expect(await screen.findByRole("button", { name: "Unlock" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(apiMocks.setPlanItemLock).toHaveBeenCalledWith(
      workspace.id,
      plan.date,
      plan.items[0]?.id,
      {
        expectedPlanId: plan.id,
        expectedHeadVersion: plan.headVersion,
        locked: true,
      },
      expect.any(String),
    );
    expect(apiMocks.getCurrentPlan).toHaveBeenCalledTimes(1);
  });

  it("renders successful regenerate and replace responses with versioned idempotent commands", async () => {
    const user = userEvent.setup();
    const regenerated: CurrentDailyPlan = {
      ...plan,
      headVersion: 3,
      items: plan.items.map((item) => ({ ...item, title: "Review grammar" })),
    };
    const replaced: CurrentDailyPlan = {
      ...regenerated,
      headVersion: 4,
      items: regenerated.items.map((item) => ({ ...item, title: "Listen to a podcast" })),
    };
    apiMocks.regeneratePlan.mockResolvedValue(regenerated);
    apiMocks.replacePlanItem.mockResolvedValue(replaced);

    render(<TodayView workspace={workspace} onNavigate={vi.fn()} />);

    await user.click(await screen.findByRole("button", { name: "Regenerate unlocked" }));
    await waitFor(() => expect(apiMocks.regeneratePlan).toHaveBeenCalledOnce());
    const regenerateCall = apiMocks.regeneratePlan.mock.calls[0];
    expect(regenerateCall?.[0]).toBe(workspace.id);
    expect(regenerateCall?.[1]).toBe(plan.date);
    expect(regenerateCall?.[2]).toEqual(
      expect.objectContaining({
        expectedPlanId: plan.id,
        expectedHeadVersion: plan.headVersion,
        request: expect.objectContaining({
          seed: expect.stringMatching(
            new RegExp(`^today:${plan.date}:revision:${plan.requestRevision + 1}:`),
          ),
        }),
      }),
    );
    expect(regenerateCall?.[3]).toEqual(expect.any(String));
    expect(await screen.findByText("Review grammar")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("regenerated");

    await user.click(screen.getByRole("button", { name: "Replace" }));
    await waitFor(() => expect(apiMocks.replacePlanItem).toHaveBeenCalledOnce());
    const replaceCall = apiMocks.replacePlanItem.mock.calls[0];
    expect(replaceCall?.[0]).toBe(workspace.id);
    expect(replaceCall?.[1]).toBe(plan.date);
    expect(replaceCall?.[2]).toBe(plan.items[0]?.id);
    expect(replaceCall?.[3]).toEqual(
      expect.objectContaining({
        expectedPlanId: regenerated.id,
        expectedHeadVersion: regenerated.headVersion,
        request: expect.objectContaining({
          seed: expect.stringMatching(
            new RegExp(`^today:${plan.date}:revision:${regenerated.requestRevision + 1}:`),
          ),
        }),
      }),
    );
    expect(replaceCall?.[4]).toEqual(expect.any(String));
    expect(await screen.findByText("Listen to a podcast")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("replaced");
  });

  it("reuses the same idempotency key and timestamp after an ambiguous failure", async () => {
    const user = userEvent.setup();
    apiMocks.recordPlanItemActivity
      .mockRejectedValueOnce(new Error("Connection dropped before the response arrived."))
      .mockResolvedValueOnce({
        planId: plan.id,
        itemId: plan.items[0]?.id,
        activityState: "started",
        headVersion: 3,
      });

    render(<TodayView workspace={workspace} onNavigate={vi.fn()} />);

    await user.click(await screen.findByRole("button", { name: "Start" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Connection dropped");
    await user.click(screen.getByRole("button", { name: "Start" }));

    await waitFor(() => expect(apiMocks.recordPlanItemActivity).toHaveBeenCalledTimes(2));
    const first = apiMocks.recordPlanItemActivity.mock.calls[0];
    const second = apiMocks.recordPlanItemActivity.mock.calls[1];
    expect(first?.[4]).toBe(second?.[4]);
    expect(first?.[3].occurredAt).toBe(second?.[3].occurredAt);
    expect(await screen.findByLabelText("Status: Started")).toBeInTheDocument();
  });

  it("offers temporary feedback only for pending, unlocked routine items", async () => {
    const routine = plan.items[0]!;
    apiMocks.getCurrentPlan.mockResolvedValue({
      ...plan,
      items: [
        routine,
        {
          ...routine,
          id: "plan-item-work",
          sourceType: "work_item",
          routineId: null,
          workItemId: "work-item-1",
          title: "File the receipt",
          position: 1,
        },
        {
          ...routine,
          id: "plan-item-locked",
          routineId: "routine-locked",
          title: "Locked routine",
          position: 2,
          locked: true,
        },
        {
          ...routine,
          id: "plan-item-started",
          routineId: "routine-started",
          title: "Started routine",
          position: 3,
          activityState: "started",
        },
        {
          ...routine,
          id: "plan-item-completed",
          routineId: "routine-completed",
          title: "Completed routine",
          position: 4,
          activityState: "completed",
        },
      ],
    });

    render(<TodayView workspace={workspace} onNavigate={vi.fn()} />);

    const controls = await screen.findByRole("group", {
      name: "Planning feedback for Practice Spanish",
    });
    expect(controls).toHaveTextContent("Not today");
    expect(controls).toHaveTextContent("Not this week");
    expect(
      screen.queryByRole("group", { name: "Planning feedback for File the receipt" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("group", { name: "Planning feedback for Locked routine" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("group", { name: "Planning feedback for Started routine" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("group", { name: "Planning feedback for Completed routine" }),
    ).not.toBeInTheDocument();
  });

  it("keeps temporary feedback visible but unavailable when plan settings are missing", async () => {
    apiMocks.getCurrentPlan.mockResolvedValue({ ...plan, request: null });

    render(<TodayView workspace={workspace} onNavigate={vi.fn()} />);

    const controls = await screen.findByRole("group", {
      name: "Planning feedback for Practice Spanish",
    });
    expect(controls).toBeVisible();
    expect(screen.getByRole("button", { name: "Not today" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Not this week" })).toBeDisabled();
  });

  it.each([
    ["Not today", "not_today", "Hidden today"],
    ["Not this week", "not_this_week", "Hidden through the end of this week"],
  ] as const)(
    "applies %s as a versioned feedback mutation and renders the returned plan",
    async (buttonName, kind, timeframe) => {
      const user = userEvent.setup();
      const updated = planWithTemporaryFeedback(kind);
      apiMocks.applyRoutineFeedback.mockResolvedValue(updated);

      render(<TodayView workspace={workspace} onNavigate={vi.fn()} />);

      await user.click(await screen.findByRole("button", { name: buttonName }));

      await waitFor(() => expect(apiMocks.applyRoutineFeedback).toHaveBeenCalledOnce());
      const call = apiMocks.applyRoutineFeedback.mock.calls[0];
      expect(call?.[0]).toBe(workspace.id);
      expect(call?.[1]).toBe(plan.date);
      expect(call?.[2]).toBe(plan.items[0]?.id);
      expect(call?.[3]).toEqual(
        expect.objectContaining({
          expectedPlanId: plan.id,
          expectedHeadVersion: plan.headVersion,
          kind,
          request: expect.objectContaining({
            seed: expect.stringMatching(
              new RegExp(`^today:${plan.date}:revision:${plan.requestRevision + 1}:`),
            ),
          }),
        }),
      );
      expect(call?.[4]).toEqual(expect.any(String));
      expect(await screen.findByRole("heading", { name: "Check the inbox" })).toBeVisible();
      expect(screen.queryByRole("heading", { name: "Practice Spanish" })).not.toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Temporarily hidden" })).toBeVisible();
      expect(screen.getByText(timeframe)).toBeVisible();
      expect(screen.getByRole("status")).toHaveTextContent("plan was recalculated");
      const recentUndo = screen.getByRole("button", {
        name: "Undo recent feedback for Practice Spanish",
      });
      expect(recentUndo).toBeVisible();
      await waitFor(() => expect(recentUndo).toHaveFocus());
      expect(apiMocks.recordPlanItemActivity).not.toHaveBeenCalled();
    },
  );

  it("explains when newer cross-date feedback prevents changing an older plan", async () => {
    const user = userEvent.setup();
    apiMocks.getCurrentPlan.mockResolvedValueOnce(plan).mockResolvedValueOnce(plan);
    apiMocks.applyRoutineFeedback.mockRejectedValue(
      new ApiError(
        409,
        "planning.feedback_head_conflict",
        "Routine planning feedback changed.",
        null,
      ),
    );

    render(<TodayView workspace={workspace} onNavigate={vi.fn()} />);

    await user.click(await screen.findByRole("button", { name: "Not today" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Newer planning feedback exists for this routine on another plan date",
    );
    expect(apiMocks.getCurrentPlan).toHaveBeenCalledTimes(2);
    expect(screen.getByRole("heading", { name: "Practice Spanish" })).toBeVisible();
  });

  it("retries ambiguous routine feedback with the same idempotency key and seed", async () => {
    const user = userEvent.setup();
    apiMocks.applyRoutineFeedback
      .mockRejectedValueOnce(new Error("Connection dropped before the response arrived."))
      .mockResolvedValueOnce(planWithTemporaryFeedback("not_today"));

    render(<TodayView workspace={workspace} onNavigate={vi.fn()} />);

    const notToday = await screen.findByRole("button", { name: "Not today" });
    await user.click(notToday);
    expect(await screen.findByRole("alert")).toHaveTextContent("Connection dropped");
    expect(notToday).toHaveFocus();
    await user.click(notToday);

    await waitFor(() => expect(apiMocks.applyRoutineFeedback).toHaveBeenCalledTimes(2));
    const first = apiMocks.applyRoutineFeedback.mock.calls[0];
    const second = apiMocks.applyRoutineFeedback.mock.calls[1];
    expect(first?.[4]).toBe(second?.[4]);
    expect(first?.[3].request.seed).toBe(second?.[3].request.seed);
    expect(await screen.findByRole("heading", { name: "Check the inbox" })).toBeVisible();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Undo recent feedback for Practice Spanish" }),
      ).toHaveFocus(),
    );
    expect(apiMocks.recordPlanItemActivity).not.toHaveBeenCalled();
  });

  it("undoes just-applied feedback through a reset mutation and uses its returned plan", async () => {
    const user = userEvent.setup();
    const hidden = planWithTemporaryFeedback("not_today");
    const recalculated: CurrentDailyPlan = {
      ...plan,
      id: "plan-reset",
      headVersion: 4,
      requestRevision: 3,
      request:
        plan.request === null ? null : { ...plan.request, seed: "reset-seed", requestRevision: 3 },
      items: plan.items.map((item) => ({ ...item, id: "plan-item-reset", title: "Read Spanish" })),
    };
    apiMocks.applyRoutineFeedback.mockResolvedValue(hidden);
    apiMocks.resetRoutineFeedback.mockResolvedValue(recalculated);

    render(<TodayView workspace={workspace} onNavigate={vi.fn()} />);

    await user.click(await screen.findByRole("button", { name: "Not today" }));
    await user.click(
      await screen.findByRole("button", { name: "Undo recent feedback for Practice Spanish" }),
    );

    await waitFor(() => expect(apiMocks.resetRoutineFeedback).toHaveBeenCalledOnce());
    const call = apiMocks.resetRoutineFeedback.mock.calls[0];
    expect(call?.[0]).toBe(workspace.id);
    expect(call?.[1]).toBe(plan.date);
    expect(call?.[2]).toBe("routine-1");
    expect(call?.[3]).toEqual(
      expect.objectContaining({
        expectedPlanId: hidden.id,
        expectedHeadVersion: hidden.headVersion,
        request: expect.objectContaining({
          seed: expect.stringMatching(
            new RegExp(`^today:${plan.date}:revision:${hidden.requestRevision + 1}:`),
          ),
        }),
      }),
    );
    expect(call?.[4]).toEqual(expect.any(String));
    expect(await screen.findByRole("heading", { name: "Read Spanish" })).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent(
      "was cleared. Today's plan was recalculated.",
    );
    expect(screen.getByRole("button", { name: "Not today" })).not.toHaveFocus();
    expect(apiMocks.recordPlanItemActivity).not.toHaveBeenCalled();
  });

  it("keeps reloaded temporary feedback visible, reversible, and out of generic exclusions", async () => {
    const user = userEvent.setup();
    const hidden: CurrentDailyPlan = {
      ...planWithTemporaryFeedback("not_this_week"),
      exclusions: [
        ...planWithTemporaryFeedback("not_this_week").exclusions,
        {
          sourceType: "work_item",
          routineId: null,
          workItemId: "work-item-2",
          title: "Pay the invoice",
          codes: ["work_item_not_plannable"],
        },
      ],
    };
    const cleared = { ...hidden, id: "plan-cleared", headVersion: 4, exclusions: [] };
    apiMocks.getCurrentPlan.mockResolvedValue(hidden);
    apiMocks.resetRoutineFeedback.mockResolvedValue(cleared);

    render(<TodayView workspace={workspace} onNavigate={vi.fn()} />);

    expect(await screen.findByRole("heading", { name: "Temporarily hidden" })).toBeVisible();
    expect(screen.getByText("Hidden through the end of this week")).toBeVisible();
    expect(screen.getByText("Why 1 other item was excluded")).toBeVisible();
    expect(screen.queryByText("Feedback not this week")).not.toBeInTheDocument();

    const persistedUndo = screen.getByRole("button", {
      name: "Undo temporary feedback for Practice Spanish",
    });
    expect(persistedUndo).not.toHaveFocus();
    await user.click(persistedUndo);

    await waitFor(() => expect(apiMocks.resetRoutineFeedback).toHaveBeenCalledOnce());
    expect(await screen.findByRole("status")).toHaveTextContent("plan was recalculated");
    expect(screen.queryByRole("heading", { name: "Temporarily hidden" })).not.toBeInTheDocument();
    expect(apiMocks.recordPlanItemActivity).not.toHaveBeenCalled();
  });
});

describe("Today local advisor", () => {
  it("keeps the plan visible while loading and restores focus after rendering advice", async () => {
    const user = userEvent.setup();
    const pending = deferred<SchedulingAdviceResult>();
    apiMocks.getSchedulingAdvice.mockReturnValue(pending.promise);

    render(<TodayView workspace={workspace} onNavigate={vi.fn()} />);

    const trigger = await screen.findByRole("button", { name: "Ask local advisor" });
    expect(trigger).toHaveAttribute("aria-controls", "today-advisor");
    expect(trigger).toHaveAccessibleDescription("Advice only. It cannot change your schedule.");
    await user.click(trigger);

    expect(trigger).toBeDisabled();
    expect(trigger).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("status")).toHaveTextContent(
      "Reviewing this plan and its eligible backlog",
    );
    expect(screen.getByRole("heading", { name: "Practice Spanish" })).toBeVisible();
    expect(apiMocks.getSchedulingAdvice).toHaveBeenCalledWith(
      workspace.id,
      {
        date: plan.date,
        expectedPlanId: plan.id,
        expectedHeadVersion: plan.headVersion,
      },
      expect.any(AbortSignal),
    );

    await act(async () => {
      pending.resolve(availableAdvice());
      await pending.promise;
    });

    expect(
      await screen.findByText("Keep the first block focused and leave room for the backlog."),
    ).toBeVisible();
    expect(screen.getByRole("list", { name: "Local advisor suggestions" })).toBeVisible();
    expect(screen.getByText("Start with Spanish")).toBeVisible();
    expect(screen.getByText(/based on plan head 2/i)).toBeVisible();
    expect(screen.getByText("Advice only. It cannot change your schedule.")).toBeVisible();
    expect(await screen.findByRole("status")).toHaveTextContent("Local advisor review ready.");
    expect(
      screen.getByText("Start with Spanish").closest(".today-advisor-result"),
    ).not.toHaveAttribute("aria-live");
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(trigger).toHaveAttribute("aria-busy", "false");
    expect(screen.queryByRole("button", { name: /apply|accept/i })).not.toBeInTheDocument();
  });

  it.each([
    ["disabled", "turned off in the server configuration"],
    ["busy", "already reviewing another request"],
    ["timeout", "took too long to respond"],
    ["unreachable", "could not be reached"],
  ] as const)(
    "renders a deterministic %s state without changing the plan",
    async (reason, copy) => {
      const user = userEvent.setup();
      apiMocks.getSchedulingAdvice.mockResolvedValue(unavailableAdvice(reason));

      render(<TodayView workspace={workspace} onNavigate={vi.fn()} />);
      const trigger = await screen.findByRole("button", { name: "Ask local advisor" });
      await user.click(trigger);

      expect(await screen.findByRole("alert")).toHaveTextContent(copy);
      expect(screen.getByRole("heading", { name: "Practice Spanish" })).toBeVisible();
      expect(apiMocks.setPlanItemLock).not.toHaveBeenCalled();
      expect(apiMocks.regeneratePlan).not.toHaveBeenCalled();
      await waitFor(() => expect(trigger).toHaveFocus());
    },
  );

  it("renders hostile model text literally and never creates model-supplied elements", async () => {
    const user = userEvent.setup();
    const summary = '<img src="x" onerror="alert(1)">';
    const title = "<script>alert('title')</script>";
    const rationale = "<button>Apply this now</button>";
    apiMocks.getSchedulingAdvice.mockResolvedValue(
      availableAdvice({
        summary,
        suggestions: [
          {
            id: "advice-hostile",
            kind: "plan_observation",
            targetType: null,
            targetId: null,
            title,
            rationale,
            confidence: "low",
          },
        ],
      }),
    );

    const { container } = render(<TodayView workspace={workspace} onNavigate={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "Ask local advisor" }));

    expect(await screen.findByText(summary)).toBeVisible();
    expect(screen.getByText(title)).toBeVisible();
    expect(screen.getByText(rationale)).toBeVisible();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector(".today-advisor-suggestions button")).toBeNull();
  });

  it("refreshes the plan and discards advice after an advisor snapshot conflict", async () => {
    const user = userEvent.setup();
    const latest = { ...plan, headVersion: 3 };
    apiMocks.getCurrentPlan.mockResolvedValueOnce(plan).mockResolvedValueOnce(latest);
    apiMocks.getSchedulingAdvice.mockRejectedValue(
      new ApiError(409, "advisor.snapshot_conflict", "The scheduling context changed.", null),
    );

    render(<TodayView workspace={workspace} onNavigate={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "Ask local advisor" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The plan changed while the advisor was working. Review the current plan and ask again.",
    );
    expect(apiMocks.getCurrentPlan).toHaveBeenCalledTimes(2);
    expect(screen.getByText(/head 3$/i)).toBeVisible();
    expect(
      screen.queryByText("Keep the first block focused and leave room for the backlog."),
    ).not.toBeInTheDocument();
  });

  it("aborts and ignores late advice when a scheduling command changes the head", async () => {
    const user = userEvent.setup();
    const pending = deferred<SchedulingAdviceResult>();
    apiMocks.getSchedulingAdvice.mockReturnValue(pending.promise);
    apiMocks.setPlanItemLock.mockResolvedValue({
      planId: plan.id,
      itemId: "plan-item-1",
      locked: true,
      headVersion: 3,
    });

    render(<TodayView workspace={workspace} onNavigate={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "Ask local advisor" }));
    const advisorSignal = apiMocks.getSchedulingAdvice.mock.calls[0]?.[2] as AbortSignal;
    await user.click(screen.getByRole("button", { name: "Lock" }));

    await waitFor(() => expect(advisorSignal.aborted).toBe(true));
    expect(await screen.findByRole("button", { name: "Unlock" })).toBeVisible();
    await act(async () => {
      pending.resolve(availableAdvice({ requestId: "1c65bdc1-a495-4fe6-bcec-b40f0e417fdd" }));
      await pending.promise;
    });

    expect(
      screen.queryByText("Keep the first block focused and leave room for the backlog."),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText("Ask for a short, read-only review based on the current plan snapshot."),
    ).toBeVisible();
  });

  it("aborts and ignores advice returned for a previously selected workspace", async () => {
    const user = userEvent.setup();
    const pending = deferred<SchedulingAdviceResult>();
    const secondWorkspace = { ...workspace, id: "workspace-2", name: "Shared" };
    const secondPlan: CurrentDailyPlan = {
      ...plan,
      id: "plan-2",
      workspaceId: secondWorkspace.id,
      items: plan.items.map((item) => ({
        ...item,
        id: "plan-item-2",
        title: "Review the budget",
      })),
    };
    apiMocks.getCurrentPlan.mockImplementation(async (workspaceId: string) =>
      workspaceId === workspace.id ? plan : secondPlan,
    );
    apiMocks.getSchedulingAdvice.mockReturnValue(pending.promise);

    const { rerender } = render(<TodayView workspace={workspace} onNavigate={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "Ask local advisor" }));
    const advisorSignal = apiMocks.getSchedulingAdvice.mock.calls[0]?.[2] as AbortSignal;

    rerender(<TodayView workspace={secondWorkspace} onNavigate={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "Review the budget" })).toBeVisible();
    await waitFor(() => expect(advisorSignal.aborted).toBe(true));

    await act(async () => {
      pending.resolve(availableAdvice({ requestId: "404e0c7e-05ac-4c3c-88ef-c657b9dd1dad" }));
      await pending.promise;
    });
    expect(screen.getByRole("heading", { name: "Review the budget" })).toBeVisible();
    expect(
      screen.queryByText("Keep the first block focused and leave room for the backlog."),
    ).not.toBeInTheDocument();
  });

  it("clears advice when a manual refresh observes a different plan head", async () => {
    const user = userEvent.setup();
    const latest = { ...plan, headVersion: 5 };
    apiMocks.getCurrentPlan.mockResolvedValueOnce(plan).mockResolvedValueOnce(latest);
    apiMocks.getSchedulingAdvice.mockResolvedValue(availableAdvice());

    render(<TodayView workspace={workspace} onNavigate={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "Ask local advisor" }));
    expect(
      await screen.findByText("Keep the first block focused and leave room for the backlog."),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Refresh" }));

    expect(await screen.findByText(/Generated with planner-v1, head 5/i)).toBeVisible();
    expect(
      screen.queryByText("Keep the first block focused and leave room for the backlog."),
    ).not.toBeInTheDocument();
  });
});
