import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
      routineId: "routine-1",
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
  request: null,
  headVersion: 2,
};

beforeEach(() => {
  vi.resetAllMocks();
  apiMocks.getCurrentPlan.mockResolvedValue(plan);
});

afterEach(cleanup);

describe("Today commands", () => {
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
