import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../api";
import { todayKey } from "../date";
import type { CurrentDailyPlan, Workspace } from "../types";
import { TodayView } from "./TodayView";

const apiMocks = vi.hoisted(() => ({
  generatePlan: vi.fn(),
  getCurrentPlan: vi.fn(),
  recordPlanItemActivity: vi.fn(),
  regeneratePlan: vi.fn(),
  replacePlanItem: vi.fn(),
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

function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetAllMocks();
  apiMocks.getCurrentPlan.mockResolvedValue(plan);
});

afterEach(cleanup);

describe("Today commands", () => {
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
});
