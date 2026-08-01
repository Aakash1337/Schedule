import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../api";
import { browserTimeZone, localDateTimeToIso, todayKey } from "../date";
import type {
  CurrentDailyPlan,
  Routine,
  RoutineDurationInsight,
  RoutineGroup,
  RoutineSelectionPreferenceState,
  Workspace,
} from "../types";
import { RoutinesView } from "./RoutinesView";

const apiMocks = vi.hoisted(() => ({
  approveRoutineDurationInsight: vi.fn(),
  addRoutineToPlan: vi.fn(),
  createRoutineGroup: vi.fn(),
  createRoutine: vi.fn(),
  deleteRoutineGroup: vi.fn(),
  dismissRoutineDurationInsight: vi.fn(),
  getRoutine: vi.fn(),
  getRoutineDurationInsight: vi.fn(),
  getRoutineSelectionPreference: vi.fn(),
  getCurrentPlan: vi.fn(),
  listRoutineGroupMemberships: vi.fn(),
  listRoutineGroups: vi.fn(),
  listRoutineActivity: vi.fn(),
  listRoutines: vi.fn(),
  recordRoutineSelectionPreference: vi.fn(),
  resetRoutineDurationInsightDismissal: vi.fn(),
  replaceRoutineGroups: vi.fn(),
  updateRoutineGroup: vi.fn(),
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

const languagesGroup: RoutineGroup = {
  id: "group-languages",
  workspaceId: workspace.id,
  name: "Languages",
  description: "Languages I am learning",
  version: 1,
  createdAt: "2026-07-12T09:00:00.000Z",
  updatedAt: "2026-07-12T09:00:00.000Z",
};

const projectsGroup: RoutineGroup = {
  ...languagesGroup,
  id: "group-projects",
  name: "Projects",
  description: "Active projects",
};

function currentPlan(items: CurrentDailyPlan["items"] = []): CurrentDailyPlan {
  const date = todayKey();
  return {
    id: "plan-today",
    workspaceId: workspace.id,
    date,
    timeZone: browserTimeZone(),
    items,
    totalMinutes: items.reduce((total, item) => total + item.scheduledMinutes, 0),
    fitness: 0,
    algorithmVersion: "planner-v1",
    configVersion: "weights-v4",
    prngVersion: "xorshift32-v1",
    seed: "today-original",
    requestRevision: 1,
    inputHash: "input-hash",
    exclusions: [],
    warnings: [],
    generatedAt: "2026-07-27T12:00:00.000Z",
    headVersion: 2,
    request: {
      workspaceId: workspace.id,
      date,
      timeZone: browserTimeZone(),
      availableWindows: [
        {
          startsAt: localDateTimeToIso(date, "08:00"),
          endsAt: localDateTimeToIso(date, "10:00"),
        },
      ],
      targetMinutes: 60,
      minimumMinutes: 0,
      maximumMinutes: 120,
      targetTaskCount: 2,
      minimumTaskCount: 0,
      maximumTaskCount: 4,
      fitPreference: "balanced",
      energy: null,
      availableContexts: ["home"],
      seed: "today-original",
      requestRevision: 1,
    },
  };
}

function routineDurationInsight(
  overrides: Partial<RoutineDurationInsight> = {},
): RoutineDurationInsight {
  return {
    routineId: routine.id,
    routineVersion: routine.version,
    insightKey: "a".repeat(64),
    disposition: "available",
    dismissedAt: null,
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

function routineSelectionPreference(
  overrides: Partial<RoutineSelectionPreferenceState> = {},
): RoutineSelectionPreferenceState {
  return {
    routineId: routine.id,
    feedbackVersion: 0,
    activeEventCount: 0,
    score: 0,
    reason: null,
    updatedAt: null,
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
  apiMocks.listRoutineGroups.mockResolvedValue({
    items: [],
    page: { limit: 200, offset: 0 },
  });
  apiMocks.listRoutineGroupMemberships.mockResolvedValue({
    items: [],
    page: { limit: 200, offset: 0 },
  });
  apiMocks.replaceRoutineGroups.mockResolvedValue({ groupIds: [] });
  apiMocks.getRoutineDurationInsight.mockResolvedValue(routineDurationInsight());
  apiMocks.getRoutineSelectionPreference.mockResolvedValue(routineSelectionPreference());
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
    expect(screen.getByRole("button", { name: "Not now" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Apply / })).not.toBeInTheDocument();
  });

  it("keeps dismissed range evidence visible without exposing review actions", async () => {
    const user = userEvent.setup();
    apiMocks.getRoutineDurationInsight.mockResolvedValue(
      routineDurationInsight({
        status: "review_range",
        disposition: "dismissed",
        dismissedAt: "2026-07-13T10:00:00.000Z",
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
    ).toBeVisible();
    expect(screen.getByText("Current range")).toBeVisible();
    expect(screen.getByText(/Its evidence remains visible/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Review duration range" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Not now" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show again" })).toBeInTheDocument();
  });

  it("dismisses a suggestion, keeps its evidence visible, and refetches its disposition", async () => {
    const user = userEvent.setup();
    const feedback = deferred<unknown>();
    const available = routineDurationInsight({
      status: "suggested",
      sampleCount: 5,
      observedMedianMinutes: 40,
      suggestedExpectedMinutes: 40,
    });
    const dismissed = routineDurationInsight({
      ...available,
      disposition: "dismissed",
      dismissedAt: "2026-07-13T10:00:00.000Z",
    });
    apiMocks.getRoutineDurationInsight
      .mockResolvedValueOnce(available)
      .mockResolvedValue(dismissed);
    apiMocks.dismissRoutineDurationInsight.mockReturnValue(feedback.promise);

    render(<RoutinesView workspace={workspace} onNavigate={vi.fn()} />);
    const routineButton = (await screen.findByText(routine.title)).closest("button");
    if (routineButton === null) throw new Error("Routine selection button was not rendered.");
    await user.click(routineButton);
    const notNow = await screen.findByRole("button", { name: "Not now" });
    await user.click(notNow);

    expect(notNow).toBeDisabled();
    expect(notNow).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "Apply 40m estimate" })).toBeDisabled();
    expect(apiMocks.dismissRoutineDurationInsight).toHaveBeenCalledWith(
      workspace.id,
      routine.id,
      { expectedVersion: routine.version, insightKey: available.insightKey },
      expect.any(String),
    );

    await act(async () => {
      feedback.resolve({ kind: "dismissed" });
      await feedback.promise;
    });

    expect(await screen.findByRole("button", { name: "Show again" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Apply / })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Edit duration" })).not.toBeInTheDocument();
    expect(
      screen.getByText(/Recent sessions suggest 40m is a more typical estimate/),
    ).toBeVisible();
    expect(screen.getByText(/Its evidence remains visible/)).toBeVisible();
    expect(screen.getByText(/Duration suggestion hidden/)).toHaveAttribute("role", "status");
    expect(screen.getByRole("heading", { name: "Duration estimate" })).toHaveFocus();
    expect(apiMocks.getRoutineDurationInsight).toHaveBeenCalledTimes(2);
  });

  it("restores a dismissed suggestion and exposes its actions after the refetch", async () => {
    const user = userEvent.setup();
    const dismissed = routineDurationInsight({
      status: "suggested",
      disposition: "dismissed",
      dismissedAt: "2026-07-13T10:00:00.000Z",
      sampleCount: 5,
      observedMedianMinutes: 40,
      suggestedExpectedMinutes: 40,
    });
    const available = routineDurationInsight({
      ...dismissed,
      disposition: "available",
      dismissedAt: null,
    });
    apiMocks.getRoutineDurationInsight
      .mockResolvedValueOnce(dismissed)
      .mockResolvedValue(available);
    apiMocks.resetRoutineDurationInsightDismissal.mockResolvedValue({ kind: "reset" });

    render(<RoutinesView workspace={workspace} onNavigate={vi.fn()} />);
    const routineButton = (await screen.findByText(routine.title)).closest("button");
    if (routineButton === null) throw new Error("Routine selection button was not rendered.");
    await user.click(routineButton);
    expect(screen.queryByRole("button", { name: /^Apply / })).not.toBeInTheDocument();
    await user.click(await screen.findByRole("button", { name: "Show again" }));

    expect(apiMocks.resetRoutineDurationInsightDismissal).toHaveBeenCalledWith(
      workspace.id,
      routine.id,
      { expectedVersion: routine.version, insightKey: dismissed.insightKey },
      expect.any(String),
    );
    expect(await screen.findByRole("button", { name: "Apply 40m estimate" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Edit duration" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Not now" })).toBeInTheDocument();
    expect(screen.getByText(/Duration suggestion is available again/)).toHaveAttribute(
      "role",
      "status",
    );
  });

  it("keeps evidence actionable after a failed dismissal and uses a new key for a retry", async () => {
    const user = userEvent.setup();
    const available = routineDurationInsight({
      status: "suggested",
      sampleCount: 5,
      observedMedianMinutes: 40,
      suggestedExpectedMinutes: 40,
    });
    const dismissed = routineDurationInsight({
      ...available,
      disposition: "dismissed",
      dismissedAt: "2026-07-13T10:00:00.000Z",
    });
    apiMocks.getRoutineDurationInsight
      .mockResolvedValueOnce(available)
      .mockResolvedValue(dismissed);
    apiMocks.dismissRoutineDurationInsight
      .mockRejectedValueOnce(new Error("Feedback service is unavailable."))
      .mockResolvedValue({ kind: "dismissed" });

    render(<RoutinesView workspace={workspace} onNavigate={vi.fn()} />);
    const routineButton = (await screen.findByText(routine.title)).closest("button");
    if (routineButton === null) throw new Error("Routine selection button was not rendered.");
    await user.click(routineButton);
    await user.click(await screen.findByRole("button", { name: "Not now" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Feedback service is unavailable.");
    expect(screen.getByRole("button", { name: "Apply 40m estimate" })).toBeEnabled();
    expect(
      screen.getByText(/Recent sessions suggest 40m is a more typical estimate/),
    ).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Not now" }));
    expect(await screen.findByRole("button", { name: "Show again" })).toBeInTheDocument();
    const firstKey = apiMocks.dismissRoutineDurationInsight.mock.calls[0]?.[3];
    const secondKey = apiMocks.dismissRoutineDurationInsight.mock.calls[1]?.[3];
    expect(firstKey).toEqual(expect.any(String));
    expect(secondKey).toEqual(expect.any(String));
    expect(secondKey).not.toBe(firstKey);
  });

  it("refreshes stale routine and evidence state without replaying conflicted feedback", async () => {
    const user = userEvent.setup();
    const latest: Routine = { ...routine, version: 3 };
    const staleInsight = routineDurationInsight({
      status: "suggested",
      sampleCount: 4,
      observedMedianMinutes: 40,
      suggestedExpectedMinutes: 40,
    });
    const refreshedInsight = routineDurationInsight({
      routineVersion: latest.version,
      insightKey: "c".repeat(64),
      status: "suggested",
      sampleCount: 5,
      observedMedianMinutes: 42,
      suggestedExpectedMinutes: 42,
    });
    apiMocks.listRoutines
      .mockResolvedValueOnce({ items: [routine], page: { limit: 200, offset: 0 } })
      .mockResolvedValue({ items: [latest], page: { limit: 200, offset: 0 } });
    apiMocks.getRoutine.mockResolvedValue(latest);
    apiMocks.getRoutineDurationInsight
      .mockResolvedValueOnce(staleInsight)
      .mockResolvedValue(refreshedInsight);
    apiMocks.dismissRoutineDurationInsight.mockRejectedValue(
      new ApiError(
        409,
        "routine_duration_insight.feedback_conflict",
        "Duration evidence changed.",
        null,
      ),
    );

    render(<RoutinesView workspace={workspace} onNavigate={vi.fn()} />);
    const routineButton = (await screen.findByText(routine.title)).closest("button");
    if (routineButton === null) throw new Error("Routine selection button was not rendered.");
    await user.click(routineButton);
    await user.click(await screen.findByRole("button", { name: "Not now" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The routine or duration evidence changed",
    );
    expect(await screen.findByRole("button", { name: "Apply 42m estimate" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Not now" })).toBeEnabled();
    expect(apiMocks.getRoutine).toHaveBeenCalledWith(workspace.id, routine.id);
    expect(apiMocks.getRoutineDurationInsight.mock.calls.length).toBeGreaterThan(1);
    expect(apiMocks.dismissRoutineDurationInsight).toHaveBeenCalledOnce();
    expect(screen.getByRole("heading", { name: "Duration estimate" })).toHaveFocus();
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

  it("loads a quiet initial future-plan preference with accessible routine-specific controls", async () => {
    const user = userEvent.setup();
    render(<RoutinesView workspace={workspace} onNavigate={vi.fn()} />);

    const routineButton = (await screen.findByText(routine.title)).closest("button");
    if (routineButton === null) throw new Error("Routine selection button was not rendered.");
    await user.click(routineButton);

    expect(
      await screen.findByRole("group", { name: `Future plan preference for ${routine.title}` }),
    ).toBeInTheDocument();
    expect(apiMocks.getRoutineSelectionPreference).toHaveBeenCalledWith(
      workspace.id,
      routine.id,
      browserTimeZone(),
      expect.any(AbortSignal),
    );
    expect(
      screen.getByRole("button", {
        name: `Choose ${routine.title} more often in future plans`,
      }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", {
        name: `Choose ${routine.title} less often in future plans`,
      }),
    ).toBeEnabled();
    expect(
      screen.queryByRole("button", {
        name: `Clear the future plan preference for ${routine.title}`,
      }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/preference score/i)).not.toBeInTheDocument();
  });

  it("progresses optimistic preference versions through more, less, and reset commands", async () => {
    const user = userEvent.setup();
    apiMocks.recordRoutineSelectionPreference
      .mockResolvedValueOnce(
        routineSelectionPreference({
          feedbackVersion: 1,
          activeEventCount: 1,
          score: 100,
          reason: "You asked to see this routine more often (+100).",
          updatedAt: "2026-07-14T10:00:00.000Z",
        }),
      )
      .mockResolvedValueOnce(
        routineSelectionPreference({
          feedbackVersion: 2,
          activeEventCount: 2,
          score: 0,
          updatedAt: "2026-07-14T10:01:00.000Z",
        }),
      )
      .mockResolvedValueOnce(
        routineSelectionPreference({
          feedbackVersion: 3,
          activeEventCount: 0,
          score: 0,
          updatedAt: "2026-07-14T10:02:00.000Z",
        }),
      );
    render(<RoutinesView workspace={workspace} onNavigate={vi.fn()} />);
    const routineButton = (await screen.findByText(routine.title)).closest("button");
    if (routineButton === null) throw new Error("Routine selection button was not rendered.");
    await user.click(routineButton);

    const more = await screen.findByRole("button", {
      name: `Choose ${routine.title} more often in future plans`,
    });
    await user.click(more);
    expect(await screen.findByText("More often · +100")).toBeInTheDocument();
    expect(
      screen.getByText("You asked to see this routine more often (+100)."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Saved for future plans. Today’s plan was not changed."),
    ).toHaveAttribute("role", "status");

    await user.click(
      screen.getByRole("button", {
        name: `Choose ${routine.title} less often in future plans`,
      }),
    );
    await waitFor(() => expect(screen.queryByText("More often · +100")).not.toBeInTheDocument());
    expect(screen.getByText("Neutral · 0")).toBeInTheDocument();
    const clear = await screen.findByRole("button", {
      name: `Clear the future plan preference for ${routine.title}`,
    });
    await user.click(clear);
    await waitFor(() => expect(clear).not.toBeInTheDocument());
    expect(screen.getByRole("heading", { name: "Future selection" })).toHaveFocus();

    expect(apiMocks.recordRoutineSelectionPreference.mock.calls.map((call) => call[2])).toEqual([
      {
        kind: "more_often",
        expectedFeedbackVersion: 0,
        timeZone: browserTimeZone(),
      },
      {
        kind: "less_often",
        expectedFeedbackVersion: 1,
        timeZone: browserTimeZone(),
      },
      { kind: "reset", expectedFeedbackVersion: 2, timeZone: browserTimeZone() },
    ]);
  });

  it("refreshes authoritative preference state after a version conflict without replaying", async () => {
    const user = userEvent.setup();
    const initial = routineSelectionPreference({
      feedbackVersion: 2,
      activeEventCount: 1,
      score: 100,
      reason: "You asked to see this routine more often (+100).",
    });
    const latest = routineSelectionPreference({
      feedbackVersion: 3,
      activeEventCount: 1,
      score: -100,
      reason: "You asked to see this routine less often (-100).",
      updatedAt: "2026-07-14T11:00:00.000Z",
    });
    apiMocks.getRoutineSelectionPreference.mockResolvedValueOnce(initial).mockResolvedValue(latest);
    apiMocks.recordRoutineSelectionPreference.mockRejectedValue(
      new ApiError(409, "routine_selection_preference.version_conflict", "Changed.", null),
    );
    render(<RoutinesView workspace={workspace} onNavigate={vi.fn()} />);
    const routineButton = (await screen.findByText(routine.title)).closest("button");
    if (routineButton === null) throw new Error("Routine selection button was not rendered.");
    await user.click(routineButton);
    await screen.findByText("More often · +100");

    await user.click(
      screen.getByRole("button", {
        name: `Choose ${routine.title} less often in future plans`,
      }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("changed elsewhere");
    expect(await screen.findByText("Less often · -100")).toBeInTheDocument();
    expect(apiMocks.getRoutineSelectionPreference).toHaveBeenCalledTimes(2);
    expect(apiMocks.recordRoutineSelectionPreference).toHaveBeenCalledOnce();
    expect(screen.getByRole("heading", { name: "Future selection" })).toHaveFocus();
  });

  it("retries an ambiguous preference failure with the exact same idempotency key", async () => {
    const user = userEvent.setup();
    apiMocks.recordRoutineSelectionPreference
      .mockRejectedValueOnce(new Error("Connection closed before the response arrived."))
      .mockResolvedValue(
        routineSelectionPreference({
          feedbackVersion: 1,
          activeEventCount: 1,
          score: 100,
          reason: "You asked to see this routine more often (+100).",
        }),
      );
    render(<RoutinesView workspace={workspace} onNavigate={vi.fn()} />);
    const routineButton = (await screen.findByText(routine.title)).closest("button");
    if (routineButton === null) throw new Error("Routine selection button was not rendered.");
    await user.click(routineButton);
    await user.click(
      await screen.findByRole("button", {
        name: `Choose ${routine.title} more often in future plans`,
      }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Retry to reuse the same request safely.",
    );
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByText("More often · +100")).toBeInTheDocument();

    const first = apiMocks.recordRoutineSelectionPreference.mock.calls[0];
    const retry = apiMocks.recordRoutineSelectionPreference.mock.calls[1];
    expect(retry?.[2]).toEqual(first?.[2]);
    expect(retry?.[3]).toBe(first?.[3]);
  });

  it("ignores a late preference response after the workspace changes", async () => {
    const user = userEvent.setup();
    const oldPreference = deferred<RoutineSelectionPreferenceState>();
    const secondWorkspace: Workspace = { ...workspace, id: "workspace-2", name: "Shared" };
    const secondRoutine: Routine = {
      ...routine,
      id: "routine-2",
      workspaceId: secondWorkspace.id,
      title: "Morning walk",
    };
    apiMocks.listRoutines.mockImplementation((workspaceId: string) =>
      Promise.resolve({
        items: workspaceId === workspace.id ? [routine] : [secondRoutine],
        page: { limit: 200, offset: 0 },
      }),
    );
    apiMocks.getRoutineDurationInsight.mockImplementation(
      (_workspaceId: string, routineId: string) =>
        Promise.resolve(routineDurationInsight({ routineId })),
    );
    apiMocks.getRoutineSelectionPreference.mockImplementation((workspaceId: string) =>
      workspaceId === workspace.id
        ? oldPreference.promise
        : Promise.resolve(
            routineSelectionPreference({
              routineId: secondRoutine.id,
              feedbackVersion: 1,
              activeEventCount: 1,
              score: -100,
              reason: "Current workspace preference.",
            }),
          ),
    );
    const view = render(<RoutinesView workspace={workspace} onNavigate={vi.fn()} />);
    const firstButton = (await screen.findByText(routine.title)).closest("button");
    if (firstButton === null) throw new Error("Routine selection button was not rendered.");
    await user.click(firstButton);

    view.rerender(<RoutinesView workspace={secondWorkspace} onNavigate={vi.fn()} />);
    const secondButton = (await screen.findByText(secondRoutine.title)).closest("button");
    if (secondButton === null) throw new Error("Second routine selection button was not rendered.");
    await user.click(secondButton);
    expect(await screen.findByText("Current workspace preference.")).toBeInTheDocument();

    await act(async () => {
      oldPreference.resolve(
        routineSelectionPreference({
          score: 400,
          reason: "Stale preference from the old workspace.",
        }),
      );
      await oldPreference.promise;
    });
    expect(screen.queryByText("Stale preference from the old workspace.")).not.toBeInTheDocument();
    expect(screen.getByText("Current workspace preference.")).toBeInTheDocument();
  });

  it("renders hostile routine and reason strings literally while keeping labels accessible", async () => {
    const user = userEvent.setup();
    const hostileTitle = '<img src=x onerror="alert(1)">';
    const hostileReason = "<script>window.compromised = true</script>";
    const hostileRoutine: Routine = { ...routine, title: hostileTitle };
    apiMocks.listRoutines.mockResolvedValue({
      items: [hostileRoutine],
      page: { limit: 200, offset: 0 },
    });
    apiMocks.getRoutineSelectionPreference.mockResolvedValue(
      routineSelectionPreference({ activeEventCount: 1, score: 100, reason: hostileReason }),
    );
    const view = render(<RoutinesView workspace={workspace} onNavigate={vi.fn()} />);
    const routineButton = (await screen.findByText(hostileTitle)).closest("button");
    if (routineButton === null) throw new Error("Routine selection button was not rendered.");
    await user.click(routineButton);

    expect(await screen.findByText(hostileReason)).toBeInTheDocument();
    expect(view.container.querySelector("script")).toBeNull();
    expect(view.container.querySelector("img")).toBeNull();
    expect(
      screen.getByRole("button", {
        name: `Choose ${hostileTitle} more often in future plans`,
      }),
    ).toBeInTheDocument();
  });

  it("filters the routine pool by overarching group and saves multi-group membership", async () => {
    const user = userEvent.setup();
    apiMocks.listRoutineGroups.mockResolvedValue({
      items: [languagesGroup, projectsGroup],
      page: { limit: 200, offset: 0 },
    });
    apiMocks.listRoutineGroupMemberships.mockResolvedValue({
      items: [
        {
          workspaceId: workspace.id,
          groupId: languagesGroup.id,
          routineId: routine.id,
          createdAt: "2026-07-12T09:00:00.000Z",
        },
      ],
      page: { limit: 200, offset: 0 },
    });
    apiMocks.updateRoutine.mockResolvedValue({ ...routine, version: 3 });
    apiMocks.replaceRoutineGroups.mockResolvedValue({
      groupIds: [languagesGroup.id, projectsGroup.id],
    });

    render(<RoutinesView workspace={workspace} onNavigate={vi.fn()} />);

    const groupFilter = await screen.findByRole("combobox", { name: "Group" });
    await waitFor(() => expect(groupFilter).toBeEnabled());
    await user.selectOptions(groupFilter, projectsGroup.id);
    expect(await screen.findByText("No active routines in Projects")).toBeInTheDocument();
    expect(screen.queryByText(routine.title)).not.toBeInTheDocument();

    await user.selectOptions(groupFilter, languagesGroup.id);
    const routineButton = (await screen.findByText(routine.title)).closest("button");
    if (routineButton === null) throw new Error("Routine selection button was not rendered.");
    await user.click(routineButton);
    await user.click(screen.getByRole("button", { name: "Edit" }));

    expect(screen.getByRole("checkbox", { name: languagesGroup.name })).toBeChecked();
    const projects = screen.getByRole("checkbox", { name: projectsGroup.name });
    expect(projects).not.toBeChecked();
    await user.click(projects);
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(apiMocks.replaceRoutineGroups).toHaveBeenCalledWith(
        workspace.id,
        routine.id,
        [languagesGroup.id],
        [languagesGroup.id, projectsGroup.id],
      ),
    );
  });

  it("creates, renames, and deliberately deletes an overarching group", async () => {
    const user = userEvent.setup();
    const renamed = { ...languagesGroup, name: "Language learning", version: 2 };
    apiMocks.createRoutineGroup.mockResolvedValue(languagesGroup);
    apiMocks.updateRoutineGroup.mockResolvedValue(renamed);
    apiMocks.deleteRoutineGroup.mockResolvedValue(undefined);

    render(<RoutinesView workspace={workspace} onNavigate={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "Manage groups" }));
    await user.type(screen.getByRole("textbox", { name: "New group name" }), "Languages");
    await user.type(
      screen.getByRole("textbox", { name: /Description/ }),
      "Languages I am learning",
    );
    await user.click(screen.getByRole("button", { name: "Create group" }));

    expect((await screen.findAllByText("Languages")).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "Edit" }));
    const name = screen.getByRole("textbox", { name: "Group name" });
    await user.clear(name);
    await user.type(name, "Language learning");
    await user.click(screen.getByRole("button", { name: "Save group" }));

    expect((await screen.findAllByText("Language learning")).length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "Delete Language learning" }));
    expect(screen.getByText("Delete this group?")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete group" }));

    await waitFor(() =>
      expect(apiMocks.deleteRoutineGroup).toHaveBeenCalledWith(workspace.id, languagesGroup.id, 2),
    );
    expect(screen.queryAllByText("Language learning")).toHaveLength(0);
  });

  it("does not let a late group load overwrite a newly created group", async () => {
    const user = userEvent.setup();
    const groupRequest = deferred<{
      items: readonly RoutineGroup[];
      page: { limit: number; offset: number };
    }>();
    const membershipRequest = deferred<{
      items: readonly [];
      page: { limit: number; offset: number };
    }>();
    apiMocks.listRoutineGroups.mockReturnValue(groupRequest.promise);
    apiMocks.listRoutineGroupMemberships.mockReturnValue(membershipRequest.promise);
    apiMocks.createRoutineGroup.mockResolvedValue(languagesGroup);

    render(<RoutinesView workspace={workspace} onNavigate={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "Manage groups" }));
    await user.type(screen.getByRole("textbox", { name: "New group name" }), "Languages");
    await user.click(screen.getByRole("button", { name: "Create group" }));
    expect((await screen.findAllByText(languagesGroup.name)).length).toBeGreaterThan(0);

    await act(async () => {
      groupRequest.resolve({ items: [], page: { limit: 200, offset: 0 } });
      membershipRequest.resolve({ items: [], page: { limit: 200, offset: 0 } });
      await Promise.all([groupRequest.promise, membershipRequest.promise]);
    });

    expect(screen.getAllByText(languagesGroup.name).length).toBeGreaterThan(0);
  });

  it("ignores a group save that completes after the workspace changes", async () => {
    const user = userEvent.setup();
    const saveRequest = deferred<RoutineGroup>();
    const secondWorkspace: Workspace = { ...workspace, id: "workspace-2", name: "Work" };
    apiMocks.createRoutineGroup.mockReturnValue(saveRequest.promise);

    const view = render(<RoutinesView workspace={workspace} onNavigate={vi.fn()} />);
    await user.click(await screen.findByRole("button", { name: "Manage groups" }));
    await user.type(screen.getByRole("textbox", { name: "New group name" }), "Languages");
    await user.click(screen.getByRole("button", { name: "Create group" }));
    await waitFor(() =>
      expect(apiMocks.createRoutineGroup).toHaveBeenCalledWith(
        workspace.id,
        expect.objectContaining({ name: "Languages" }),
      ),
    );

    view.rerender(<RoutinesView workspace={secondWorkspace} onNavigate={vi.fn()} />);
    await act(async () => {
      saveRequest.resolve(languagesGroup);
      await saveRequest.promise;
    });

    expect(screen.queryByText(languagesGroup.name)).not.toBeInTheDocument();
  });

  it("reloads a stale membership selection before allowing a retry", async () => {
    const user = userEvent.setup();
    const languagesMembership = {
      workspaceId: workspace.id,
      groupId: languagesGroup.id,
      routineId: routine.id,
      createdAt: "2026-07-12T09:00:00.000Z",
    };
    const projectsMembership = { ...languagesMembership, groupId: projectsGroup.id };
    apiMocks.listRoutineGroups.mockResolvedValue({
      items: [languagesGroup, projectsGroup],
      page: { limit: 200, offset: 0 },
    });
    apiMocks.listRoutineGroupMemberships
      .mockResolvedValueOnce({
        items: [languagesMembership],
        page: { limit: 200, offset: 0 },
      })
      .mockResolvedValue({
        items: [projectsMembership],
        page: { limit: 200, offset: 0 },
      });
    apiMocks.updateRoutine.mockResolvedValue({ ...routine, version: 3 });
    apiMocks.replaceRoutineGroups
      .mockRejectedValueOnce(
        new ApiError(409, "routine_group.membership_conflict", "Changed elsewhere.", null),
      )
      .mockResolvedValueOnce({ groupIds: [projectsGroup.id, languagesGroup.id] });

    render(<RoutinesView workspace={workspace} onNavigate={vi.fn()} />);
    const routineButton = (await screen.findByText(routine.title)).closest("button");
    if (routineButton === null) throw new Error("Routine selection button was not rendered.");
    await user.click(routineButton);
    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.click(screen.getByRole("checkbox", { name: projectsGroup.name }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(
      await screen.findByText(
        /its groups changed elsewhere\. Current group selections were reloaded/,
      ),
    ).toBeInTheDocument();
    const languages = screen.getByRole("checkbox", { name: languagesGroup.name });
    expect(languages).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: projectsGroup.name })).toBeChecked();

    await user.click(languages);
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(apiMocks.replaceRoutineGroups).toHaveBeenCalledTimes(2));
    expect(apiMocks.replaceRoutineGroups).toHaveBeenNthCalledWith(
      2,
      workspace.id,
      routine.id,
      [projectsGroup.id],
      [projectsGroup.id, languagesGroup.id],
    );
  });

  it("keeps pending group choices when a conflict reload fails", async () => {
    const user = userEvent.setup();
    const languagesMembership = {
      workspaceId: workspace.id,
      groupId: languagesGroup.id,
      routineId: routine.id,
      createdAt: "2026-07-12T09:00:00.000Z",
    };
    apiMocks.listRoutineGroups
      .mockResolvedValueOnce({
        items: [languagesGroup, projectsGroup],
        page: { limit: 200, offset: 0 },
      })
      .mockRejectedValueOnce(new Error("offline"));
    apiMocks.listRoutineGroupMemberships.mockResolvedValue({
      items: [languagesMembership],
      page: { limit: 200, offset: 0 },
    });
    apiMocks.updateRoutine.mockResolvedValue({ ...routine, version: 3 });
    apiMocks.replaceRoutineGroups.mockRejectedValueOnce(
      new ApiError(409, "routine_group.membership_conflict", "Changed elsewhere.", null),
    );

    render(<RoutinesView workspace={workspace} onNavigate={vi.fn()} />);
    const routineButton = (await screen.findByText(routine.title)).closest("button");
    if (routineButton === null) throw new Error("Routine selection button was not rendered.");
    await user.click(routineButton);
    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.click(screen.getByRole("checkbox", { name: projectsGroup.name }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(
      await screen.findByText(/current groups could not be reloaded\. Close and reopen the editor/),
    ).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: languagesGroup.name })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: projectsGroup.name })).toBeChecked();
  });

  it("adds a selected group routine to Today using the current plan settings", async () => {
    const user = userEvent.setup();
    const plan = currentPlan();
    const addedPlan = currentPlan([
      {
        id: "plan-item-spanish",
        sourceType: "routine",
        routineId: routine.id,
        workItemId: null,
        title: routine.title,
        position: 0,
        windowIndex: 0,
        scheduledMinutes: 30,
        partialSession: false,
        score: 100,
        scoreComponents: {},
        reasons: ["explicitly selected"],
        locked: false,
        activityState: "pending",
        lastActivityEventId: null,
        activityUpdatedAt: null,
      },
    ]);
    apiMocks.listRoutineGroups.mockResolvedValue({
      items: [languagesGroup],
      page: { limit: 200, offset: 0 },
    });
    apiMocks.listRoutineGroupMemberships.mockResolvedValue({
      items: [
        {
          workspaceId: workspace.id,
          groupId: languagesGroup.id,
          routineId: routine.id,
          createdAt: "2026-07-12T09:00:00.000Z",
        },
      ],
      page: { limit: 200, offset: 0 },
    });
    apiMocks.getCurrentPlan.mockResolvedValue(plan);
    apiMocks.addRoutineToPlan.mockResolvedValue({ ...addedPlan, headVersion: 3 });

    render(<RoutinesView workspace={workspace} onNavigate={vi.fn()} />);
    const groupFilter = await screen.findByRole("combobox", { name: "Group" });
    await waitFor(() => expect(groupFilter).toBeEnabled());
    await user.selectOptions(groupFilter, languagesGroup.id);
    await user.click(await screen.findByRole("button", { name: `Add ${routine.title} to Today` }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      `${routine.title} was added to Today.`,
    );
    expect(apiMocks.getCurrentPlan).toHaveBeenCalledWith(workspace.id, plan.date);
    expect(apiMocks.addRoutineToPlan).toHaveBeenCalledWith(
      workspace.id,
      plan.date,
      routine.id,
      expect.objectContaining({
        expectedPlanId: plan.id,
        expectedHeadVersion: plan.headVersion,
        request: expect.objectContaining({
          timeZone: plan.timeZone,
          targetMinutes: plan.request?.targetMinutes,
          targetTaskCount: plan.request?.targetTaskCount,
          seed: expect.stringContaining(`today:${plan.date}:revision:2:`),
        }),
      }),
      expect.any(String),
    );
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
