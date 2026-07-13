import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../api";
import type { Routine, RoutineDurationInsight, Workspace } from "../types";
import { RoutinesView } from "./RoutinesView";

const apiMocks = vi.hoisted(() => ({
  approveRoutineDurationInsight: vi.fn(),
  createRoutine: vi.fn(),
  getRoutine: vi.fn(),
  getRoutineDurationInsight: vi.fn(),
  listRoutineActivity: vi.fn(),
  listRoutines: vi.fn(),
  updateRoutine: vi.fn(),
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

const routine: Routine = {
  id: "routine-1",
  workspaceId: workspace.id,
  title: "Practice Spanish",
  description: "Conversation drills",
  status: "active",
  tags: {
    priority: "medium",
    effort: "medium",
    energy: "normal",
    preference: "enjoyable",
    contexts: ["home"],
    categories: ["learning"],
    freeForm: [],
  },
  duration: {
    minimumMinutes: 15,
    expectedMinutes: 30,
    maximumMinutes: 45,
    splittable: false,
    minimumSessionMinutes: 15,
    overheadMinutes: 0,
  },
  cadence: {
    period: "week",
    rollingIntervalDays: null,
    targetCompletions: 3,
    minimumCompletions: null,
    maximumCompletions: null,
    minimumSpacingDays: 1,
    preferredWeekdays: [],
    excludedWeekdays: [],
    discourageConsecutiveDays: true,
    prohibitConsecutiveDays: false,
    weekStartsOn: 1,
    startsOn: null,
    pausedUntil: null,
    endsOn: null,
  },
  version: 2,
  createdAt: "2026-07-12T09:00:00.000Z",
  updatedAt: "2026-07-12T09:00:00.000Z",
};

function routineDurationInsight(
  overrides: Partial<RoutineDurationInsight> = {},
): RoutineDurationInsight {
  return {
    routineId: routine.id,
    routineVersion: routine.version,
    status: "insufficient_history",
    sampleCount: 0,
    minimumSamples: 3,
    lookbackDays: 90,
    evaluatedAt: "2026-07-13T09:00:00.000Z",
    windowStartedAt: "2026-04-14T09:00:00.000Z",
    currentExpectedMinutes: routine.duration.expectedMinutes,
    minimumMinutes: routine.duration.minimumMinutes,
    maximumMinutes: routine.duration.maximumMinutes,
    observedMedianMinutes: null,
    materialThresholdMinutes: 5,
    suggestedExpectedMinutes: null,
    ...overrides,
  };
}

function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void;
  const promise = new Promise<Value>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetAllMocks();
  apiMocks.listRoutines.mockResolvedValue({
    items: [routine],
    page: { limit: 200, offset: 0 },
  });
  apiMocks.getRoutineDurationInsight.mockResolvedValue(routineDurationInsight());
});

afterEach(cleanup);

describe("routine pool", () => {
  it("ignores a late routine response from the previously selected status", async () => {
    const user = userEvent.setup();
    const activeRequest = deferred<{
      items: readonly Routine[];
      page: { limit: number; offset: number };
    }>();
    const pausedRequest = deferred<{
      items: readonly Routine[];
      page: { limit: number; offset: number };
    }>();
    const pausedRoutine: Routine = {
      ...routine,
      id: "routine-paused",
      title: "Evening walk",
      status: "paused",
    };
    apiMocks.listRoutines.mockImplementation((_workspaceId: string, status: Routine["status"]) =>
      status === "paused" ? pausedRequest.promise : activeRequest.promise,
    );

    render(<RoutinesView workspace={workspace} onNavigate={vi.fn()} />);
    await waitFor(() =>
      expect(apiMocks.listRoutines).toHaveBeenCalledWith(
        workspace.id,
        "active",
        expect.any(AbortSignal),
      ),
    );
    await user.click(screen.getByRole("tab", { name: "Paused" }));
    await waitFor(() =>
      expect(apiMocks.listRoutines).toHaveBeenCalledWith(
        workspace.id,
        "paused",
        expect.any(AbortSignal),
      ),
    );

    await act(async () => {
      pausedRequest.resolve({ items: [pausedRoutine], page: { limit: 200, offset: 0 } });
      await pausedRequest.promise;
    });
    expect(await screen.findByText(pausedRoutine.title)).toBeInTheDocument();

    await act(async () => {
      activeRequest.resolve({ items: [routine], page: { limit: 200, offset: 0 } });
      await activeRequest.promise;
    });
    expect(screen.getByText(pausedRoutine.title)).toBeInTheDocument();
    expect(screen.queryByText(routine.title)).not.toBeInTheDocument();
  });

  it("creates a routine from the default duration and cadence policy", async () => {
    const user = userEvent.setup();
    const created = { ...routine, id: "routine-created", title: "Strength training", version: 1 };
    apiMocks.createRoutine.mockResolvedValue(created);

    render(<RoutinesView workspace={workspace} onNavigate={vi.fn()} />);

    await user.click(await screen.findByRole("button", { name: "New routine" }));
    await user.type(screen.getByRole("textbox", { name: "Title" }), created.title);
    await user.click(screen.getByRole("button", { name: "Create routine" }));

    await waitFor(() =>
      expect(apiMocks.createRoutine).toHaveBeenCalledWith(
        workspace.id,
        expect.objectContaining({
          title: created.title,
          duration: expect.objectContaining({ expectedMinutes: 30 }),
          cadence: expect.objectContaining({ period: "week", targetCompletions: 3 }),
        }),
      ),
    );
    expect(await screen.findByRole("heading", { name: created.title })).toBeInTheDocument();
  });

  it("loads immutable activity history for the selected routine", async () => {
    const user = userEvent.setup();
    apiMocks.listRoutineActivity.mockResolvedValue({
      items: [
        {
          id: "activity-1",
          routineId: routine.id,
          type: "completed",
          occurredAt: "2026-07-12T14:00:00.000Z",
          localDate: "2026-07-12",
          durationMinutes: 30,
          reason: null,
        },
      ],
      page: { limit: 20, nextCursor: null },
    });

    render(<RoutinesView workspace={workspace} onNavigate={vi.fn()} />);

    const routineTitle = await screen.findByText(routine.title);
    const routineButton = routineTitle.closest("button");
    if (routineButton === null) throw new Error("Routine selection button was not rendered.");
    await user.click(routineButton);
    await user.click(screen.getByRole("button", { name: "Show history" }));

    expect(await screen.findByText("Completed")).toBeInTheDocument();
    expect(screen.getByText("30m")).toBeInTheDocument();
  });

  it("suppresses duplicate activity pages and ignores a stale response for a previously selected routine", async () => {
    const user = userEvent.setup();
    const firstRoutineHistory = deferred<{
      items: readonly {
        id: string;
        routineId: string;
        type: string;
        occurredAt: string;
        localDate: string;
        durationMinutes: number | null;
        reason: string | null;
      }[];
      page: { limit: number; nextCursor: string | null };
    }>();
    const secondRoutine: Routine = { ...routine, id: "routine-2", title: "Morning walk" };
    const firstEvent = {
      id: "activity-shared",
      routineId: secondRoutine.id,
      type: "completed",
      occurredAt: "2026-07-12T14:00:00.000Z",
      localDate: "2026-07-12",
      durationMinutes: 30,
      reason: "Most recent walk",
    };
    const olderEvent = {
      ...firstEvent,
      id: "activity-older",
      occurredAt: "2026-07-10T14:00:00.000Z",
      reason: "Older walk",
    };
    apiMocks.listRoutines.mockResolvedValue({
      items: [routine, secondRoutine],
      page: { limit: 200, offset: 0 },
    });
    apiMocks.listRoutineActivity.mockImplementation(
      (_workspaceId: string, routineId: string, cursor?: string) => {
        if (routineId === routine.id) return firstRoutineHistory.promise;
        if (cursor === undefined) {
          return Promise.resolve({ items: [firstEvent], page: { limit: 20, nextCursor: "older" } });
        }
        return Promise.resolve({
          items: [firstEvent, olderEvent],
          page: { limit: 20, nextCursor: null },
        });
      },
    );

    render(<RoutinesView workspace={workspace} onNavigate={vi.fn()} />);

    const firstButton = (await screen.findByText(routine.title)).closest("button");
    if (firstButton === null) throw new Error("First routine selection button was not rendered.");
    await user.click(firstButton);
    await user.click(screen.getByRole("button", { name: "Show history" }));

    const secondButton = screen.getByText(secondRoutine.title).closest("button");
    if (secondButton === null) throw new Error("Second routine selection button was not rendered.");
    await user.click(secondButton);
    await user.click(screen.getByRole("button", { name: "Show history" }));
    expect(await screen.findByText("Most recent walk")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Load older activity" }));
    expect(await screen.findByText("Older walk")).toBeInTheDocument();
    expect(screen.getAllByText("Most recent walk")).toHaveLength(1);

    await act(async () => {
      firstRoutineHistory.resolve({
        items: [
          {
            ...firstEvent,
            id: "activity-stale",
            routineId: routine.id,
            reason: "Stale Spanish history",
          },
        ],
        page: { limit: 20, nextCursor: null },
      });
      await firstRoutineHistory.promise;
    });
    expect(screen.queryByText("Stale Spanish history")).not.toBeInTheDocument();
    expect(screen.getByText("Most recent walk")).toBeInTheDocument();
  });

  it("reloads authoritative values instead of advancing a stale full draft", async () => {
    const user = userEvent.setup();
    const latest = { ...routine, title: "Spanish conversation", version: 3 };
    apiMocks.updateRoutine.mockRejectedValue(
      new ApiError(409, "routine.version_conflict", "Changed elsewhere.", null),
    );
    apiMocks.getRoutine.mockResolvedValue(latest);

    render(<RoutinesView workspace={workspace} onNavigate={vi.fn()} />);

    const routineTitle = await screen.findByText("Practice Spanish");
    const routineButton = routineTitle.closest("button");
    if (routineButton === null) throw new Error("Routine selection button was not rendered.");
    await user.click(routineButton);
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const title = screen.getByRole("textbox", { name: "Title" });
    await user.clear(title);
    await user.type(title, "Unsaved local title");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(apiMocks.getRoutine).toHaveBeenCalledWith(workspace.id, routine.id));
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue(latest.title);
    expect(screen.getByRole("status")).toHaveTextContent(
      "The latest values are loaded; your unsaved edits were not applied.",
    );
  });

  it("prevents status changes while a routine save is pending", async () => {
    const user = userEvent.setup();
    const save = deferred<Routine>();
    const created = { ...routine, id: "routine-created", title: "Strength training", version: 1 };
    apiMocks.createRoutine.mockReturnValue(save.promise);

    render(<RoutinesView workspace={workspace} onNavigate={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "New routine" }));
    await user.type(screen.getByRole("textbox", { name: "Title" }), created.title);
    await user.click(screen.getByRole("button", { name: "Create routine" }));

    await waitFor(() => expect(apiMocks.createRoutine).toHaveBeenCalledOnce());
    expect(screen.getByRole("tab", { name: "Paused" })).toBeDisabled();

    await act(async () => {
      save.resolve(created);
      await save.promise;
    });
    await waitFor(() => expect(screen.getByRole("tab", { name: "Paused" })).toBeEnabled());
  });

  it("explains when more completed sessions are needed for duration learning", async () => {
    const user = userEvent.setup();
    apiMocks.getRoutineDurationInsight.mockResolvedValue(
      routineDurationInsight({ sampleCount: 2 }),
    );

    render(<RoutinesView workspace={workspace} onNavigate={vi.fn()} />);
    const routineButton = (await screen.findByText(routine.title)).closest("button");
    if (routineButton === null) throw new Error("Routine selection button was not rendered.");
    await user.click(routineButton);

    expect(
      await screen.findByText(/Duration learning needs 3 completed sessions in the last 90 days/),
    ).toHaveTextContent("2 of 3 recorded");
    expect(screen.getByText("2 sessions · 90 days")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Apply / })).not.toBeInTheDocument();
  });

  it("shows when recent duration evidence supports the current estimate", async () => {
    const user = userEvent.setup();
    apiMocks.getRoutineDurationInsight.mockResolvedValue(
      routineDurationInsight({
        status: "aligned",
        sampleCount: 5,
        observedMedianMinutes: 32,
      }),
    );

    render(<RoutinesView workspace={workspace} onNavigate={vi.fn()} />);
    const routineButton = (await screen.findByText(routine.title)).closest("button");
    if (routineButton === null) throw new Error("Routine selection button was not rendered.");
    await user.click(routineButton);

    expect(
      await screen.findByText(/Recent sessions support your current 30m estimate/),
    ).toBeInTheDocument();
    expect(screen.getByText("A typical session was 32m.")).toBeInTheDocument();
  });

  it("atomically approves a suggested estimate with the full duration", async () => {
    const user = userEvent.setup();
    const suggestion = routineDurationInsight({
      status: "suggested",
      sampleCount: 5,
      observedMedianMinutes: 40,
      suggestedExpectedMinutes: 40,
    });
    const updated: Routine = {
      ...routine,
      duration: { ...routine.duration, expectedMinutes: 40 },
      version: 3,
    };
    apiMocks.getRoutineDurationInsight.mockResolvedValueOnce(suggestion).mockResolvedValue(
      routineDurationInsight({
        routineVersion: updated.version,
        status: "aligned",
        sampleCount: 5,
        currentExpectedMinutes: 40,
        observedMedianMinutes: 40,
      }),
    );
    apiMocks.approveRoutineDurationInsight.mockResolvedValue(updated);

    render(<RoutinesView workspace={workspace} onNavigate={vi.fn()} />);
    const routineButton = (await screen.findByText(routine.title)).closest("button");
    if (routineButton === null) throw new Error("Routine selection button was not rendered.");
    await user.click(routineButton);
    const applyButton = await screen.findByRole("button", { name: "Apply 40m estimate" });
    expect(screen.getByText(/current daily plan will not be regenerated/i)).toBeInTheDocument();
    await user.click(applyButton);

    await waitFor(() =>
      expect(apiMocks.approveRoutineDurationInsight).toHaveBeenCalledWith(
        workspace.id,
        routine.id,
        {
          expectedVersion: routine.version,
          duration: { ...routine.duration, expectedMinutes: 40 },
        },
      ),
    );
    expect(apiMocks.approveRoutineDurationInsight).toHaveBeenCalledOnce();
    expect(apiMocks.updateRoutine).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Duration estimate" })).toHaveFocus();
    expect(
      await screen.findByText(/Recent sessions support your current 40m estimate/),
    ).toBeInTheDocument();
  });

  it("requires range review instead of offering an out-of-range estimate", async () => {
    const user = userEvent.setup();
    apiMocks.getRoutineDurationInsight.mockResolvedValue(
      routineDurationInsight({
        status: "review_range",
        sampleCount: 4,
        observedMedianMinutes: 60,
      }),
    );

    render(<RoutinesView workspace={workspace} onNavigate={vi.fn()} />);
    const routineButton = (await screen.findByText(routine.title)).closest("button");
    if (routineButton === null) throw new Error("Routine selection button was not rendered.");
    await user.click(routineButton);

    expect(
      await screen.findByText(/Recent sessions typically take 1h, outside your 15m to 45m range/),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review duration range" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Apply / })).not.toBeInTheDocument();
  });

  it("does not auto-retry a stale suggestion after an optimistic conflict", async () => {
    const user = userEvent.setup();
    const latest: Routine = { ...routine, version: 3 };
    const initialSuggestion = routineDurationInsight({
      status: "suggested",
      sampleCount: 4,
      observedMedianMinutes: 40,
      suggestedExpectedMinutes: 40,
    });
    const refreshedSuggestion = routineDurationInsight({
      routineVersion: latest.version,
      status: "suggested",
      sampleCount: 5,
      observedMedianMinutes: 40,
      suggestedExpectedMinutes: 40,
    });
    apiMocks.listRoutines
      .mockResolvedValueOnce({ items: [routine], page: { limit: 200, offset: 0 } })
      .mockResolvedValue({ items: [latest], page: { limit: 200, offset: 0 } });
    apiMocks.getRoutine.mockResolvedValue(latest);
    apiMocks.getRoutineDurationInsight
      .mockResolvedValueOnce(initialSuggestion)
      .mockResolvedValue(refreshedSuggestion);
    apiMocks.approveRoutineDurationInsight.mockRejectedValue(
      new ApiError(
        409,
        "routine_duration_insight.evidence_conflict",
        "Duration evidence changed.",
        null,
      ),
    );

    render(<RoutinesView workspace={workspace} onNavigate={vi.fn()} />);
    const routineButton = (await screen.findByText(routine.title)).closest("button");
    if (routineButton === null) throw new Error("Routine selection button was not rendered.");
    await user.click(routineButton);
    await user.click(await screen.findByRole("button", { name: "Apply 40m estimate" }));

    expect(
      await screen.findByText(/Review the refreshed evidence and approve it again/),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(apiMocks.getRoutineDurationInsight.mock.calls.length).toBeGreaterThan(1),
    );
    expect(await screen.findByRole("button", { name: "Apply 40m estimate" })).toBeInTheDocument();
    expect(apiMocks.approveRoutineDurationInsight).toHaveBeenCalledOnce();
    expect(apiMocks.updateRoutine).not.toHaveBeenCalled();
  });

  it("ignores a late insight response from a previously selected routine", async () => {
    const user = userEvent.setup();
    const firstInsight = deferred<RoutineDurationInsight>();
    const secondRoutine: Routine = {
      ...routine,
      id: "routine-2",
      title: "Morning walk",
      duration: { ...routine.duration, expectedMinutes: 35 },
    };
    apiMocks.listRoutines.mockResolvedValue({
      items: [routine, secondRoutine],
      page: { limit: 200, offset: 0 },
    });
    apiMocks.getRoutineDurationInsight.mockImplementation(
      (_workspaceId: string, routineId: string) =>
        routineId === routine.id
          ? firstInsight.promise
          : Promise.resolve(
              routineDurationInsight({
                routineId: secondRoutine.id,
                status: "aligned",
                currentExpectedMinutes: 35,
                sampleCount: 5,
                observedMedianMinutes: 36,
              }),
            ),
    );

    render(<RoutinesView workspace={workspace} onNavigate={vi.fn()} />);
    const firstButton = (await screen.findByText(routine.title)).closest("button");
    if (firstButton === null) throw new Error("First routine selection button was not rendered.");
    await user.click(firstButton);
    const secondButton = screen.getByText(secondRoutine.title).closest("button");
    if (secondButton === null) throw new Error("Second routine selection button was not rendered.");
    await user.click(secondButton);

    expect(
      await screen.findByText(/Recent sessions support your current 35m estimate/),
    ).toBeInTheDocument();
    await act(async () => {
      firstInsight.resolve(
        routineDurationInsight({
          status: "suggested",
          sampleCount: 4,
          observedMedianMinutes: 40,
          suggestedExpectedMinutes: 40,
        }),
      );
      await firstInsight.promise;
    });
    expect(screen.queryByRole("button", { name: "Apply 40m estimate" })).not.toBeInTheDocument();
    expect(
      screen.getByText(/Recent sessions support your current 35m estimate/),
    ).toBeInTheDocument();
  });

  it("retries a failed insight without blocking routine details", async () => {
    const user = userEvent.setup();
    apiMocks.getRoutineDurationInsight
      .mockRejectedValueOnce(new Error("Duration evidence is temporarily unavailable."))
      .mockResolvedValue(routineDurationInsight({ sampleCount: 1 }));

    render(<RoutinesView workspace={workspace} onNavigate={vi.fn()} />);
    const routineButton = (await screen.findByText(routine.title)).closest("button");
    if (routineButton === null) throw new Error("Routine selection button was not rendered.");
    await user.click(routineButton);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Duration evidence is temporarily unavailable.",
    );
    expect(screen.getByRole("heading", { name: routine.title })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(
      await screen.findByText(/Duration learning needs 3 completed sessions in the last 90 days/),
    ).toHaveTextContent("1 of 3 recorded");
    expect(apiMocks.getRoutineDurationInsight).toHaveBeenCalledTimes(2);
  });

  it("supports arrow-key navigation across status tabs", async () => {
    const user = userEvent.setup();
    render(<RoutinesView workspace={workspace} onNavigate={vi.fn()} />);

    const active = await screen.findByRole("tab", { name: "Active" });
    active.focus();
    await user.keyboard("{ArrowRight}");

    const paused = screen.getByRole("tab", { name: "Paused" });
    expect(paused).toHaveFocus();
    expect(paused).toHaveAttribute("aria-selected", "true");
  });
});
